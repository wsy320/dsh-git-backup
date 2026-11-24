import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestFromScan, materialize, scanAssets } from './assets.js';
import { saveSelection } from './config.js';
import {
  archiveWorktree,
  commitAll,
  ensureWorktree,
  localHead,
  mirrorSnapshot,
  pushBranch,
  readManifestFromWorktree,
  redactRepoUrl,
  syncWorktree,
} from './repo.js';
import { applySelection, pickSelection } from './selection.js';
import { localTime, machineName, remove } from './util.js';

export async function readDshVersion(profileDir) {
  try {
    const pkg = JSON.parse(await readFile(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Full scan → optional interactive checkboxes → saved selection filter.
 * Returns the filtered scan plus everything the caller needs to report.
 */
export async function resolveBackupScan(ctx, options = {}) {
  const full = await scanAssets(
    { dshHome: ctx.dshHome, profileDir: ctx.profileDir, skillsDir: ctx.skillsDir },
    { modules: options.modules },
  );

  let selection = ctx.selection;
  if (options.interactive) {
    const picked = await pickSelection(full, selection);
    if (picked === null) throw new Error('已取消选择');
    selection = await saveSelection(picked);
    ctx.selection = selection;
  }

  const { scan, excludedCount } = applySelection(full, selection);
  return { full, scan, selection, excludedCount };
}

export function sameSnapshotContent(a, b) {
  const pick = (m) =>
    JSON.stringify({
      profile: m.profile,
      selection: m.selection,
      files: (m.files ?? []).map((f) => ({ root: f.root, path: f.path, sha256: f.sha256 })),
    });
  return pick(a) === pick(b);
}

export async function runBackup(ctx, options = {}) {
  if (!ctx.repo) throw new Error('未配置 Git 仓库地址，请先运行 dsh-backup init --repo <url>');
  const { full, scan, selection, excludedCount } = await resolveBackupScan(ctx, options);
  if (scan.totals.files === 0) {
    throw new Error('选择的内容为空，没有可备份的文件');
  }

  const version = await readDshVersion(ctx.profileDir);
  const machine = machineName();
  const manifest = manifestFromScan(scan, {
    profile: ctx.profile,
    machine,
    dshVersion: version,
    selection,
    generatedBy: 'dsh-git-backup',
  });

  const stage = await mkdtemp(join(tmpdir(), 'dsh-backup-'));
  const workdir = ctx.workdir;
  try {
    await materialize(scan.entries, stage);

    await ensureWorktree({ repo: ctx.repo, branch: ctx.branch, workdir });
    const sync = await syncWorktree({ branch: ctx.branch, workdir, force: Boolean(options.force) });

    let existing = null;
    let foreignError = null;
    try {
      existing = await readManifestFromWorktree(workdir);
    } catch (err) {
      if (err.code === 'FOREIGN_MANIFEST') foreignError = err;
      existing = null;
    }
    let archivedWorkdir = null;
    if (foreignError !== null) {
      if (sync.remoteHead !== null) throw foreignError;
      archivedWorkdir = await archiveWorktree(workdir);
      await ensureWorktree({ repo: ctx.repo, branch: ctx.branch, workdir });
    }
    if (existing?.profile !== undefined && existing.profile !== ctx.profile && !options.force) {
      throw new Error(
        `仓库当前备份属于 profile「${existing.profile}」，与本次「${ctx.profile}」不一致。` +
          '加 --force 覆盖，或换一个仓库。',
      );
    }
    // Same files + same selection means the only diff would be createdAt; keep
    // the old timestamp so an unchanged backup produces no empty commit.
    if (existing !== null && sameSnapshotContent(existing, manifest)) {
      manifest.createdAt = existing.createdAt;
    }

    await mirrorSnapshot(stage, workdir, manifest);
    const message =
      options.message ||
      `dsh-backup: ${ctx.profile} @ ${machine} ${localTime()} · ${scan.totals.files} files`;
    let commit = commitAll(workdir, message);

    let pushed = false;
    if (!options.noPush) {
      try {
        pushBranch({ branch: ctx.branch, workdir });
        pushed = true;
      } catch (err) {
        const text = String(err?.message ?? err);
        if (/non-fast-forward|fetch first|rejected/i.test(text)) {
          throw new Error(
            '推送到远端被拒绝：远端在你备份期间有了新提交。请先运行 dsh-backup status/restore 查看，' +
              '确认后用 --force 重新备份（会覆盖远端快照）。',
          );
        }
        throw err;
      }
    }

    return {
      ok: true,
      commit,
      head: localHead(workdir),
      pushed,
      remote: redactRepoUrl(ctx.repo),
      branch: ctx.branch,
      workdir,
      manifest,
      selection,
      excludedCount,
      credentials: full.credentials,
      warnings: full.warnings,
      archivedWorkdir,
      sync,
    };
  } finally {
    await remove(stage);
  }
}
