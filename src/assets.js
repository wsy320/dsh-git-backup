import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { guardEntry } from './guard.js';
import { copyFilePreservingMode, pathExists, readTextIfSmall, sha256File, toPosix, walkFiles } from './util.js';

export const MODULE_IDS = ['skills', 'plugins', 'config'];

export const MODULE_META = {
  skills: { label: '技能', note: '~/.agents/skills（以及 ~/.dsh/skills，如果存在）' },
  plugins: { label: '插件', note: 'profile 的 package.json / pnpm-lock.yaml / pnpm-workspace.yaml' },
  config: { label: '配置', note: 'cordis.patch.yml / AGENTS.md / settings.yaml、settings.json 等' },
};

/** Files that make the installed plugin set reproducible. */
const PLUGIN_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

/** User-editable DSH configuration. Secrets are filtered by guard.js. */
const DSH_CONFIG_FILES = new Set([
  'AGENTS.md',
  'settings.yaml',
  'settings.yml',
  'settings.json',
  'config.yaml',
  'config.yml',
  'config.json',
]);

const PROFILE_CONFIG_FILES = new Set(['cordis.patch.yml']);

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.cache', '.pnpm-store', '.system', 'tmp', 'temp']);

export function targetRoots(roots) {
  const list = [
    { root: 'skills', base: roots.skillsDir },
    { root: 'profile', base: roots.profileDir },
    { root: 'dsh', base: roots.dshHome },
  ];
  // DSH installations differ: some keep deployed skills in ~/.dsh/skills.
  if (toPosix(join(roots.dshHome, 'skills')) !== toPosix(roots.skillsDir)) {
    list.push({ root: 'dshSkills', base: join(roots.dshHome, 'skills') });
  }
  return list;
}

/** @returns {{module: string, root: string, base: string, include: (rel: string) => boolean}[]} */
export function assetRoots(roots) {
  const list = [
    { module: 'skills', root: 'skills', base: roots.skillsDir, include: () => true },
    { module: 'plugins', root: 'profile', base: roots.profileDir, include: (p) => PLUGIN_FILES.has(p) },
    { module: 'config', root: 'profile', base: roots.profileDir, include: (p) => PROFILE_CONFIG_FILES.has(p) },
    { module: 'config', root: 'dsh', base: roots.dshHome, include: (p) => DSH_CONFIG_FILES.has(p) },
  ];
  if (toPosix(join(roots.dshHome, 'skills')) !== toPosix(roots.skillsDir)) {
    list.push({ module: 'skills', root: 'dshSkills', base: join(roots.dshHome, 'skills'), include: () => true });
  }
  return list;
}

/**
 * Scan selected modules. Read failures are warnings; a blocked credential is
 * recorded with its reason so the user can see what was left out.
 */
export async function scanAssets(roots, options = {}) {
  const wanted = new Set(options.modules ?? MODULE_IDS);
  const warnings = [];
  const credentials = [];
  const entries = [];
  const modules = {};

  for (const id of MODULE_IDS) {
    if (!wanted.has(id)) continue;
    modules[id] = { id, ...MODULE_META[id], files: 0, bytes: 0, count: 0, roots: [] };
  }

  const seen = new Set();
  for (const spec of assetRoots(roots)) {
    const mod = modules[spec.module];
    if (mod === undefined) continue;
    if (!(await pathExists(spec.base))) continue;
    const key = `${spec.module}\u0000${spec.root}\u0000${toPosix(spec.base)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const found = await walkFiles(spec.base, {
      skipDirNames: SKIP_DIR_NAMES,
      onWarning: (w) => warnings.push(w),
    });
    mod.roots.push({ root: spec.root, base: spec.base, exists: true });

    for (const file of found) {
      const relPath = toPosix(file.relPath);
      if (!spec.include(relPath)) continue;
      let st;
      try {
        st = await stat(file.absPath);
      } catch (err) {
        warnings.push({ path: file.absPath, reason: `stat: ${err.code || err.message}` });
        continue;
      }
      const verdict = await guardEntry(
        { relPath, size: st.size },
        () => readTextIfSmall(file.absPath, 1024 * 1024),
      );
      if (verdict.blocked) {
        credentials.push({ module: spec.module, root: spec.root, path: relPath, reason: verdict.reason });
        continue;
      }
      let sha256;
      try {
        sha256 = await sha256File(file.absPath);
      } catch (err) {
        warnings.push({ path: file.absPath, reason: `hash: ${err.code || err.message}` });
        continue;
      }
      entries.push({
        module: spec.module,
        root: spec.root,
        path: relPath,
        absPath: file.absPath,
        size: st.size,
        mode: st.mode,
        sha256,
      });
      mod.files += 1;
      mod.bytes += st.size;
      if (spec.module === 'skills' && relPath.includes('/')) {
        const skillName = relPath.slice(0, relPath.indexOf('/'));
        mod._dirs ??= new Set();
        mod._dirs.add(`${spec.root}/${skillName}`);
      }
    }
  }

  for (const mod of Object.values(modules)) {
    if (mod._dirs !== undefined) {
      mod.count = mod._dirs.size;
      delete mod._dirs;
    } else {
      mod.count = mod.files;
    }
  }

  entries.sort((a, b) => {
    const ka = `${a.root}/${a.path}`;
    const kb = `${b.root}/${b.path}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    scannedAt: new Date().toISOString(),
    roots,
    modules,
    entries,
    warnings,
    credentials,
    totals: {
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
    },
  };
}

/** Materialise a scan into `<dest>/payload/<root>/<path>`. */
export async function materialize(entries, dest) {
  for (const entry of entries) {
    const target = join(dest, 'payload', entry.root, entry.path);
    await copyFilePreservingMode(entry.absPath, target);
  }
}

export function manifestFromScan(scan, extra = {}) {
  return {
    format: 'dsh-git-backup/v1',
    createdAt: scan.scannedAt,
    ...extra,
    modules: Object.fromEntries(
      Object.values(scan.modules).map((m) => [m.id, { label: m.label, files: m.files, bytes: m.bytes, count: m.count }]),
    ),
    totals: scan.totals,
    files: scan.entries.map((e) => ({
      module: e.module,
      root: e.root,
      path: e.path,
      size: e.size,
      sha256: e.sha256,
    })),
  };
}
