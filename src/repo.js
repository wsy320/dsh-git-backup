import { spawnSync } from 'node:child_process';
import { cp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, pathExists, remove } from './util.js';

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    this.name = 'GitError';
    this.args = args;
    this.result = result;
  }
}

export function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 10 * 60 * 1000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new GitError(args, result);
  return result;
}

export function redactRepoUrl(url) {
  return String(url ?? '').replace(/\/\/[^/@\s]+@/, '//<credentials>@');
}

async function isEmptyDir(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/** Move the tool-owned worktree aside instead of deleting a stale or foreign snapshot. */
export async function archiveWorktree(workdir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${workdir}.bak-${stamp}`;
  let index = 1;
  while (await pathExists(target)) target = `${workdir}.bak-${stamp}-${index++}`;
  await rename(workdir, target);
  return target;
}

/**
 * Create or reuse a dedicated worktree. The repo is tool-owned; unrelated
 * files are never deleted, only `payload/` and `manifest.json` are managed.
 */
export async function ensureWorktree({ repo, branch, workdir }) {
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('未配置 Git 仓库地址，请先运行 dsh-backup init --repo <url>');
  }
  let hasGit = await pathExists(join(workdir, '.git'));
  if (hasGit) {
    const current = git(['remote', 'get-url', 'origin'], { cwd: workdir, allowFailure: true });
    if (current.status !== 0 || current.stdout.trim() === '') {
      git(['remote', 'add', 'origin', repo], { cwd: workdir });
    } else if (current.stdout.trim() !== repo) {
      await archiveWorktree(workdir);
      hasGit = false;
    }
  }
  if (!hasGit) {
    if ((await pathExists(workdir)) && !(await isEmptyDir(workdir))) {
      throw new Error(`工作目录非空且不是 Git 仓库: ${workdir}`);
    }
    await ensureDir(workdir);
    const init = git(['init', '-b', branch], { cwd: workdir, allowFailure: true });
    if (init.status !== 0) {
      git(['init'], { cwd: workdir });
      git(['checkout', '-b', branch], { cwd: workdir, allowFailure: true });
    }
    git(['remote', 'add', 'origin', repo], { cwd: workdir });
  }

  if (git(['config', 'user.email'], { cwd: workdir, allowFailure: true }).stdout.trim() === '') {
    git(['config', 'user.email', 'dsh-backup@localhost'], { cwd: workdir });
  }
  if (git(['config', 'user.name'], { cwd: workdir, allowFailure: true }).stdout.trim() === '') {
    git(['config', 'user.name', 'dsh-backup'], { cwd: workdir });
  }
  // Byte-for-byte restore: never let Git rewrite LF/CRLF while checking out.
  git(['config', 'core.autocrlf', 'false'], { cwd: workdir });
  // Some Gitea/HTTP reverse proxies reject chunked receive-pack bodies with
  // HTTP 411. A buffer larger than the pack makes Git send Content-Length.
  git(['config', 'http.postBuffer', '268435456'], { cwd: workdir });
  // Make sure we are on the configured branch (an aborted restore may have left
  // the worktree detached).
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: workdir, allowFailure: true });
  if (head.status !== 0 || head.stdout.trim() !== branch) {
    const branchExists = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: workdir,
      allowFailure: true,
    });
    if (branchExists.status === 0) git(['checkout', branch], { cwd: workdir });
    else git(['checkout', '-b', branch], { cwd: workdir, allowFailure: true });
  }
  return workdir;
}

export async function fetchRemoteHead({ branch, workdir }) {
  const heads = git(['ls-remote', '--heads', 'origin', branch], { cwd: workdir, allowFailure: true });
  if (heads.status !== 0) {
    throw new GitError(['ls-remote', '--heads', 'origin', branch], heads);
  }
  const line = heads.stdout.trim().split(/\r?\n/).find(Boolean);
  if (line === undefined) return null;
  const remoteHead = line.split(/\s+/)[0];
  const fetched = git(['fetch', '--no-tags', 'origin', branch], { cwd: workdir, allowFailure: true });
  if (fetched.status !== 0) throw new GitError(['fetch', '--no-tags', 'origin', branch], fetched);
  return remoteHead;
}

export function localHead(workdir) {
  const result = git(['rev-parse', '--verify', 'HEAD'], { cwd: workdir, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isAncestor(a, b, workdir) {
  if (a === null || b === null) return false;
  const result = git(['merge-base', '--is-ancestor', a, b], { cwd: workdir, allowFailure: true });
  return result.status === 0;
}

/** Bring the worktree to the newest remote commit, unless local has unique commits. */
export async function syncWorktree({ branch, workdir, force = false }) {
  const remoteHead = await fetchRemoteHead({ branch, workdir });
  if (remoteHead === null) return { remoteHead: null, localHead: localHead(workdir) };
  const local = localHead(workdir);
  if (local === null || (local !== remoteHead && isAncestor(local, remoteHead, workdir))) {
    git(['reset', '--hard', remoteHead], { cwd: workdir });
    return { remoteHead, localHead: remoteHead, rewound: true };
  }
  if (local === remoteHead || isAncestor(remoteHead, local, workdir)) {
    // Local has commits the remote does not (e.g. a previous --no-push backup).
    return { remoteHead, localHead: local, ahead: local !== remoteHead };
  }
  if (force) {
    git(['reset', '--hard', remoteHead], { cwd: workdir });
    return { remoteHead, localHead: remoteHead, rewound: true, forced: true };
  }
  throw new Error(
    '本地与远端都有独立提交，无法安全覆盖。先运行 dsh-backup restore，或加 --force 用本次备份覆盖远端。',
  );
}

/** Check out a commit (or newest remote commit) for reading. */
export async function checkoutTarget({ branch, workdir, commit, force = false }) {
  git(['reset', '--hard'], { cwd: workdir, allowFailure: true });
  if (commit) {
    const exists = git(['cat-file', '-e', `${commit}^{commit}`], { cwd: workdir, allowFailure: true });
    if (exists.status !== 0) throw new Error(`提交不存在: ${commit}`);
    git(['checkout', '--detach', commit], { cwd: workdir });
    return commit;
  }
  const remoteHead = await fetchRemoteHead({ branch, workdir });
  if (remoteHead !== null) {
    const local = localHead(workdir);
    if (local !== null && local !== remoteHead && !isAncestor(local, remoteHead, workdir) && !force) {
      throw new Error(
        '本地工作副本里有未推送的备份提交，直接还原会丢弃它们。先 dsh-backup backup 推送，或加 --force 忽略本地提交。',
      );
    }
    git(['reset', '--hard', remoteHead], { cwd: workdir });
    return remoteHead;
  }
  const head = localHead(workdir);
  if (head === null) throw new Error('仓库里还没有备份。先运行 dsh-backup backup。');
  return head;
}

export async function readManifestFromWorktree(workdir) {
  const path = join(workdir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('仓库中没有 manifest.json，这不是本工具生成的备份仓库。');
      error.code = 'NO_MANIFEST';
      throw error;
    }
    if (err instanceof SyntaxError) throw new Error(`manifest.json 解析失败: ${err.message}`);
    throw err;
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.format !== 'dsh-git-backup/v1' ||
    !Array.isArray(manifest.files) ||
    manifest.totals === undefined
  ) {
    const error = new Error(
      '仓库中的 manifest.json 不是 dsh-git-backup 快照格式（可能由其他插件生成）。' +
        '请换一个空仓库，或先把该仓库内容迁走。',
    );
    error.code = 'FOREIGN_MANIFEST';
    throw error;
  }
  return manifest;
}

/** Replace the managed snapshot in the worktree. Other repo files stay untouched. */
export async function mirrorSnapshot(stageDir, workdir, manifest) {
  await remove(join(workdir, 'payload'));
  if (await pathExists(join(stageDir, 'payload'))) {
    await cp(join(stageDir, 'payload'), join(workdir, 'payload'), { recursive: true, preserveTimestamps: true });
  }
  await writeFile(join(workdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function commitAll(workdir, message) {
  git(['add', '-A', '-f', '--', 'payload', 'manifest.json'], { cwd: workdir });
  const diff = git(['diff', '--cached', '--quiet', '--', 'payload', 'manifest.json'], { cwd: workdir, allowFailure: true });
  if (diff.status === 0) return null;
  git(['commit', '-m', message, '--', 'payload', 'manifest.json'], { cwd: workdir });
  return localHead(workdir);
}

export function pushBranch({ branch, workdir }) {
  const result = git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workdir, allowFailure: true });
  if (result.status !== 0) {
    throw new GitError(['push', 'origin', `HEAD:refs/heads/${branch}`], result);
  }
  return result;
}

export function gitLog({ workdir, limit = 10 }) {
  const result = git(
    ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s', '--', 'manifest.json'],
    { cwd: workdir, allowFailure: true },
  );
  if (result.status !== 0 || result.stdout.trim() === '') return [];
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [hash, date, ...rest] = line.split('\t');
      return { hash, date, subject: rest.join('\t') };
    });
}

export function headShort(workdir) {
  const head = localHead(workdir);
  return head === null ? '(empty)' : head.slice(0, 8);
}
