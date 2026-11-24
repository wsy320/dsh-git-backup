import { join } from 'node:path';
import { scanAssets } from './assets.js';
import { readManifestFromWorktree } from './repo.js';
import { applySelection } from './selection.js';
import { pathExists, summarizeChanges, toPosix } from './util.js';

export async function collectLocal(ctx, selection = ctx.selection) {
  const full = await scanAssets({
    dshHome: ctx.dshHome,
    profileDir: ctx.profileDir,
    skillsDir: ctx.skillsDir,
  });
  const { scan } = applySelection(full, selection);
  return { full, scan };
}

/**
 * Compare the local assets with the snapshot currently checked out in the
 * worktree. The snapshot's own selection is used when present, so a one-off
 * `backup --only ...` does not make status report every other module as added.
 * Does not touch the network.
 */
export async function runStatus(ctx) {
  const fullScan = await scanAssets({
    dshHome: ctx.dshHome,
    profileDir: ctx.profileDir,
    skillsDir: ctx.skillsDir,
  });

  let manifest = null;
  let manifestError = null;
  if (ctx.repo && (await pathExists(join(ctx.workdir, '.git')))) {
    try {
      manifest = await readManifestFromWorktree(ctx.workdir);
    } catch (err) {
      manifestError = err.code === 'NO_MANIFEST' ? null : err.message;
    }
  }

  const effectiveSelection = manifest?.selection ?? ctx.selection;
  const { scan } = applySelection(fullScan, effectiveSelection);
  const local = new Map(scan.entries.map((entry) => [`${entry.root}\u0000${toPosix(entry.path)}`, entry]));

  const changes = [];
  if (manifest !== null) {
    const remote = new Set();
    for (const file of manifest.files ?? []) {
      const key = `${file.root}\u0000${toPosix(file.path)}`;
      remote.add(key);
      const entry = local.get(key);
      if (entry === undefined) {
        changes.push({ status: 'missing', module: file.module, root: file.root, path: file.path });
      } else if (entry.sha256 !== file.sha256) {
        changes.push({ status: 'modified', module: file.module, root: file.root, path: file.path });
      } else {
        changes.push({ status: 'same', module: file.module, root: file.root, path: file.path });
      }
    }
    for (const [key, entry] of local) {
      if (!remote.has(key)) {
        changes.push({ status: 'added', module: entry.module, root: entry.root, path: entry.path });
      }
    }
  }

  return {
    repo: ctx.repo,
    branch: ctx.branch,
    workdir: ctx.workdir,
    profile: ctx.profile,
    dshHome: ctx.dshHome,
    skillsDir: ctx.skillsDir,
    local: {
      modules: Object.fromEntries(Object.values(scan.modules).map((m) => [m.id, { files: m.files, bytes: m.bytes, count: m.count }])),
      totals: scan.totals,
    },
    manifest: manifest === null ? null : { createdAt: manifest.createdAt, profile: manifest.profile, totals: manifest.totals },
    manifestError,
    changes,
    counts: summarizeChanges(changes),
    credentials: fullScan.credentials,
    warnings: fullScan.warnings,
  };
}
