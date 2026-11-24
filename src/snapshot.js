import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestFromScan, materialize, scanAssets } from './assets.js';
import { ensureDir, localTime, machineName, pathExists, remove, timestampForPath } from './util.js';

/** Snapshot everything this tool manages, before a restore overwrites anything. */
export async function createLocalSnapshot(ctx, options = {}) {
  const scan = await scanAssets({
    dshHome: ctx.dshHome,
    profileDir: ctx.profileDir,
    skillsDir: ctx.skillsDir,
  });
  if (scan.totals.files === 0) return null;

  const dir = join(ctx.snapshotsDir, `${timestampForPath()}-${options.reason ?? 'manual'}`);
  await ensureDir(dir);
  await materialize(scan.entries, dir);
  const manifest = manifestFromScan(scan, {
    profile: ctx.profile,
    machine: machineName(),
    kind: options.reason ?? 'pre-restore',
    createdAtLocal: localTime(),
  });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await pruneSnapshots(ctx.snapshotsDir, options.keep ?? 10);
  return { dir, manifest, scan };
}

export async function pruneSnapshots(snapshotsDir, keep) {
  if (!(await pathExists(snapshotsDir))) return [];
  const dirs = (await readdir(snapshotsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of drop) await remove(join(snapshotsDir, name));
  return drop;
}
