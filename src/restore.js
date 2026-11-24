import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { targetRoots } from './assets.js';
import { checkoutTarget, ensureWorktree, readManifestFromWorktree } from './repo.js';
import { createLocalSnapshot } from './snapshot.js';
import {
  assertRelativeSafe,
  copyFilePreservingMode,
  isSubPath,
  pathExists,
  remove,
  sha256File,
  toPosix,
  walkFiles,
} from './util.js';

function rootsById(ctx) {
  const map = {
    dsh: ctx.dshHome,
    profile: ctx.profileDir,
    skills: ctx.skillsDir,
  };
  for (const { root, base } of targetRoots({ dshHome: ctx.dshHome, profileDir: ctx.profileDir, skillsDir: ctx.skillsDir })) {
    map[root] = base;
  }
  return map;
}

function uniqueFiles(manifest) {
  if (manifest?.format !== 'dsh-git-backup/v1' || !Array.isArray(manifest.files)) {
    throw new Error('manifest.json 不是 dsh-git-backup/v1 格式，拒绝还原。');
  }
  const seen = new Set();
  const files = [];
  for (const file of manifest.files) {
    const root = String(file.root ?? '');
    const rel = assertRelativeSafe(String(file.path ?? ''));
    const key = `${root}\u0000${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ ...file, root, path: rel });
  }
  return files;
}

export async function buildRestorePlan(ctx, manifest, workdir) {
  const roots = rootsById(ctx);
  const files = uniqueFiles(manifest);
  const actions = [];
  const expectedByRoot = new Map();

  for (const file of files) {
    const base = roots[file.root];
    if (base === undefined) throw new Error(`未知的还原目标根: ${file.root}`);
    const target = join(base, file.path);
    if (!isSubPath(base, target)) throw new Error(`还原路径越界: ${file.root}/${file.path}`);
    const source = join(workdir, 'payload', file.root, file.path);
    if (!(await pathExists(source))) {
      throw new Error(`仓库缺少文件: payload/${file.root}/${file.path}`);
    }
    let status = 'create';
    if (await pathExists(target)) {
      const current = await sha256File(target);
      status = current === file.sha256 ? 'same' : 'update';
    }
    if (!expectedByRoot.has(file.root)) expectedByRoot.set(file.root, new Set());
    expectedByRoot.get(file.root).add(file.path);
    actions.push({ ...file, source, target, status });
  }

  // Extra local skill files are reported, and only removed when --prune is set.
  const extras = [];
  for (const [root, base] of Object.entries(roots)) {
    if (root !== 'skills' && root !== 'dshSkills') continue;
    if (!(await pathExists(base))) continue;
    const expected = expectedByRoot.get(root) ?? new Set();
    const found = await walkFiles(base, { skipDirNames: new Set(['.git']) });
    for (const file of found) {
      if (!expected.has(toPosix(file.relPath))) extras.push({ root, path: file.relPath, absPath: file.absPath, base });
    }
  }

  return {
    actions,
    extras,
    counts: {
      create: actions.filter((a) => a.status === 'create').length,
      update: actions.filter((a) => a.status === 'update').length,
      same: actions.filter((a) => a.status === 'same').length,
      extra: extras.length,
    },
  };
}

async function removeEmptyDirs(dir, stopAt) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    await removeEmptyDirs(child, stopAt);
    const left = await readdir(child).catch(() => []);
    if (left.length === 0) await remove(child);
  }
  if (toPosix(dir) !== toPosix(stopAt)) {
    const left = await readdir(dir);
    if (left.length === 0) await remove(dir);
  }
}

function runPluginInstall(ctx) {
  const command = process.env.DSH_BIN || 'dsh';
  const args = ['plugin', '--profile', ctx.profile, 'install'];
  const result = spawnSync(command, args, {
    cwd: ctx.profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 15 * 60 * 1000,
    windowsHide: false,
  });
  return result.status === 0;
}

export async function runRestore(ctx, options = {}) {
  const workdir = await ensureWorktree({ repo: ctx.repo, branch: ctx.branch, workdir: ctx.workdir });
  const commit = await checkoutTarget({ branch: ctx.branch, workdir, commit: options.commit, force: Boolean(options.force) });
  const manifest = await readManifestFromWorktree(workdir);
  const plan = await buildRestorePlan(ctx, manifest, workdir);

  const keepLocal = new Set(
    (Array.isArray(options.keepLocal) ? options.keepLocal : []).filter((value) => typeof value === 'string' && value !== ''),
  );
  const keptLocal = [];
  if (keepLocal.size > 0) {
    for (const action of plan.actions) {
      if (action.status !== 'update') continue;
      if (!keepLocal.has(`${action.root}:${action.path}`)) continue;
      keptLocal.push({ root: action.root, path: action.path });
    }
    if (keptLocal.length > 0) {
      const keptKeys = new Set(keptLocal.map((item) => `${item.root}:${item.path}`));
      plan.actions = plan.actions.filter((action) => !keptKeys.has(`${action.root}:${action.path}`));
      plan.counts = { ...plan.counts, update: plan.counts.update - keptLocal.length };
    }
  }

  const summary = {
    commit,
    manifest,
    plan,
    keptLocal,
    dryRun: Boolean(options.dryRun),
    snapshot: null,
    installed: null,
  };
  if (options.dryRun) return summary;

  summary.snapshot = await createLocalSnapshot(ctx, { reason: 'pre-restore', keep: 10 });

  for (const action of plan.actions) {
    if (action.status === 'same') continue;
    await copyFilePreservingMode(action.source, action.target);
  }

  if (options.prune) {
    for (const extra of plan.extras) await remove(extra.absPath);
    for (const base of new Set(plan.extras.map((e) => e.base))) {
      await removeEmptyDirs(base, base);
    }
  }

  const pluginFiles = manifest.files.filter((f) => f.module === 'plugins').length;
  const pluginChanged = plan.actions.some((a) => a.module === 'plugins' && a.status !== 'same');
  if (pluginFiles > 0 && !options.noInstall && (pluginChanged || options.installAlways)) {
    summary.installed = runPluginInstall(ctx);
  }

  return summary;
}
