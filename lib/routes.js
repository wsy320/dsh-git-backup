/**
 * HTTP routes for the dsh-git-backup settings page.
 *
 * Paths live under `/api/dsh-git-backup/...`; the host's connection service
 * adds authentication and origin checks. The browser half only calls relative
 * URLs, so it works both in Electron (`dsh-app://`) and the web profile.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { scanAssets, MODULE_META, manifestFromScan, targetRoots } from '../src/assets.js';
import { readDshVersion, runBackup, sameSnapshotContent } from '../src/backup.js';
import { loadConfig, normalizeSelection, saveConfig, saveSelection } from '../src/config.js';
import { inspectPath } from '../src/guard.js';
import { gitLog, readManifestFromWorktree } from '../src/repo.js';
import { runRestore } from '../src/restore.js';
import { applySelection, itemId, selectableItems } from '../src/selection.js';
import { isSubPath, machineName, pathExists, toPosix, walkFiles } from '../src/util.js';
import { MODULES, makeCoreContext, requireRepo, selectionFromArgs } from './context.js';

export const ROUTE_PREFIX = '/api/dsh-git-backup';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed;
}

function route(fn) {
  return async (request) => {
    try {
      const body = request.method === 'POST' ? await readJson(request) : {};
      return json({ ok: true, ...(await fn(body, request)) });
    } catch (error) {
      console.error('[dsh-git-backup] route failed:', error);
      return json({ ok: false, error: error?.message ?? String(error) });
    }
  };
}

function selectedIdSet(selection, module) {
  const excluded = new Set(selection.exclude[module] ?? []);
  return (id) => {
    if (!selection.modules[module]) return false;
    const bare = id.slice(id.indexOf(':') + 1);
    return !excluded.has(id) && !excluded.has(bare);
  };
}

function countItems(scan, selection) {
  const stats = new Map();
  for (const entry of scan.entries) {
    const id = itemId(entry);
    const row = stats.get(id) ?? { files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += entry.size;
    stats.set(id, row);
  }

  return MODULES.map((module) => {
    const checked = selectedIdSet(selection, module);
    const items = selectableItems(scan)
      .filter((item) => item.module === module)
      .map((item) => {
        const row = stats.get(item.id) ?? { files: 0, bytes: 0 };
        return {
          id: item.id,
          label: item.label,
          files: row.files,
          bytes: row.bytes,
          checked: checked(item.id),
        };
      });
    const checkedItems = items.filter((item) => item.checked);
    return {
      id: module,
      label: MODULE_META[module]?.label ?? module,
      enabled: Boolean(selection.modules[module]),
      checked: checkedItems.length,
      total: items.length,
      files: items.reduce((n, item) => n + item.files, 0),
      bytes: items.reduce((n, item) => n + item.bytes, 0),
      items,
    };
  });
}

function diffAgainst(scan, manifest) {
  if (manifest === null) return null;
  const local = new Map(scan.entries.map((entry) => [`${entry.root}\u0000${toPosix(entry.path)}`, entry]));
  const changes = [];
  const remote = new Set();
  for (const file of manifest.files ?? []) {
    const key = `${file.root}\u0000${toPosix(file.path)}`;
    remote.add(key);
    const entry = local.get(key);
    if (entry === undefined) changes.push({ status: 'missing', root: file.root, path: file.path });
    else if (entry.sha256 !== file.sha256) changes.push({ status: 'modified', root: file.root, path: file.path });
    else changes.push({ status: 'same', root: file.root, path: file.path });
  }
  for (const [key, entry] of local) {
    if (!remote.has(key)) changes.push({ status: 'added', root: entry.root, path: entry.path });
  }
  const counts = { added: 0, modified: 0, missing: 0, same: 0 };
  for (const change of changes) counts[change.status] += 1;
  return { counts, changes: changes.filter((c) => c.status !== 'same').slice(0, 200) };
}

function previewSelection(core, body) {
  return body.selection !== undefined
    ? normalizeSelection(body.selection)
    : selectionFromArgs(body, core.selection);
}

async function buildBackupPreview(hostCtx, body) {
  const core = await makeCoreContext(hostCtx);
  const selection = previewSelection(core, body);
  const full = await scanAssets({
    dshHome: core.dshHome,
    profileDir: core.profileDir,
    skillsDir: core.skillsDir,
  });
  const { scan, excludedCount } = applySelection(full, selection);
  if (scan.totals.files === 0) throw new Error('选择的内容为空，没有可备份的文件');

  const manifest = manifestFromScan(scan, {
    profile: core.profile,
    machine: machineName(),
    dshVersion: await readDshVersion(core.profileDir),
    selection,
    generatedBy: 'dsh-git-backup',
  });

  let existing = null;
  if (core.repo && (await pathExists(`${core.workdir}/.git`))) {
    try {
      existing = await readManifestFromWorktree(core.workdir);
    } catch {
      existing = null;
    }
  }

  const local = new Map(scan.entries.map((entry) => [`${entry.root}\u0000${toPosix(entry.path)}`, entry]));
  const previous = new Set((existing?.files ?? []).map((file) => `${file.root}\u0000${toPosix(file.path)}`));
  const changes = [];
  const counts = { add: 0, update: 0, remove: 0, same: 0 };
  for (const [key, entry] of local) {
    if (!previous.has(key)) {
      counts.add += 1;
      changes.push({ status: 'add', module: entry.module, root: entry.root, path: entry.path });
      continue;
    }
    const old = existing.files.find((file) => `${file.root}\u0000${toPosix(file.path)}` === key);
    if (old.sha256 === entry.sha256) {
      counts.same += 1;
    } else {
      counts.update += 1;
      changes.push({ status: 'update', module: entry.module, root: entry.root, path: entry.path });
    }
  }
  for (const file of existing?.files ?? []) {
    const key = `${file.root}\u0000${toPosix(file.path)}`;
    if (local.has(key)) continue;
    counts.remove += 1;
    changes.push({ status: 'remove', module: file.module, root: file.root, path: file.path });
  }

  const commitNeeded = existing === null || !sameSnapshotContent(existing, manifest);
  return {
    configured: core.repo !== '',
    branch: core.branch,
    workdir: core.workdir,
    profile: core.profile,
    totals: scan.totals,
    modules: Object.fromEntries(Object.values(scan.modules).map((m) => [m.id, { files: m.files, bytes: m.bytes, count: m.count }])),
    counts,
    changes: changes.slice(0, 300),
    commitNeeded,
    pushNeeded: core.repo !== '' && commitNeeded && body.noPush !== true,
    selectionChanged: Boolean(existing) && JSON.stringify(existing?.selection ?? null) !== JSON.stringify(selection),
    profileChanged: Boolean(existing && existing.profile !== core.profile),
    excludedCount,
    credentials: full.credentials,
    warnings: full.warnings,
    existing: existing === null ? null : { createdAt: existing.createdAt, profile: existing.profile, totals: existing.totals },
  };
}

function rootsForPreview(core) {
  const map = { dsh: core.dshHome, profile: core.profileDir, skills: core.skillsDir };
  for (const item of targetRoots({ dshHome: core.dshHome, profileDir: core.profileDir, skillsDir: core.skillsDir })) {
    map[item.root] = item.base;
  }
  return map;
}

async function readPreviewFile(filePath) {
  const info = await stat(filePath);
  if (info.size > 512 * 1024) {
    return { content: null, truncated: true, message: '文件超过 512 KB，未展开。' };
  }
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) return { content: null, binary: true, message: '二进制文件，不显示内容。' };
  const text = buffer.toString('utf8');
  let summary = null;
  if (basename(filePath) === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      summary = {
        dependencies: Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({ name, version })),
        devDependencies: Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => ({ name, version })),
        bundles: Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
      };
    } catch {
      summary = null;
    }
  }
  return { content: text, summary };
}

async function previewItem(hostCtx, body) {
  const core = await makeCoreContext(hostCtx);
  const raw = typeof body.itemId === 'string' ? body.itemId : '';
  const cut = raw.indexOf(':');
  if (cut <= 0) throw new Error('itemId 格式应为 <root>:<path>');
  const root = raw.slice(0, cut);
  const rel = raw.slice(cut + 1);
  const bases = rootsForPreview(core);
  const base = bases[root];
  if (base === undefined) throw new Error(`未知的预览根: ${root}`);
  if (inspectPath(rel) !== null) throw new Error('凭据类文件不提供预览');
  const target = join(base, rel);
  if (!isSubPath(base, target)) throw new Error('预览路径越界');

  const info = await stat(target);
  if (info.isFile()) {
    const preview = await readPreviewFile(target);
    return {
      kind: 'file',
      root,
      path: toPosix(rel),
      contentPath: toPosix(rel),
      files: [],
      ...preview,
    };
  }
  if (!info.isDirectory()) throw new Error('不是普通文件或目录');

  const found = await walkFiles(target, { skipDirNames: new Set(['node_modules', '.git', '.cache']) });
  const files = found
    .filter((file) => inspectPath(file.relPath) === null)
    .slice(0, 300)
    .map((file) => ({ path: toPosix(file.relPath), size: 0 }));
  for (const file of found) {
    const match = files.find((row) => row.path === toPosix(file.relPath));
    if (match !== undefined) {
      try {
        match.size = (await stat(file.absPath)).size;
      } catch {
        match.size = 0;
      }
    }
  }

  const requested = typeof body.file === 'string' ? body.file.replace(/\\/g, '/') : '';
  let contentPath = '';
  if (requested !== '') {
    const candidate = join(target, requested);
    if (!isSubPath(target, candidate) || inspectPath(requested) !== null) throw new Error('文件路径不合法');
    if (await pathExists(candidate)) contentPath = requested;
  }
  if (contentPath === '') {
    if (files.some((file) => file.path === 'SKILL.md')) contentPath = 'SKILL.md';
    else if (files.length > 0) contentPath = files[0].path;
  }

  let preview = { content: null, message: '目录为空。' };
  if (contentPath !== '') preview = await readPreviewFile(join(target, contentPath));
  return {
    kind: 'dir',
    root,
    path: toPosix(rel),
    contentPath,
    files,
    ...preview,
  };
}

async function buildState(hostCtx) {
  const core = await makeCoreContext(hostCtx);
  const full = await scanAssets({
    dshHome: core.dshHome,
    profileDir: core.profileDir,
    skillsDir: core.skillsDir,
  });
  const selection = normalizeSelection(core.selection);
  const { scan } = applySelection(full, selection);

  let manifest = null;
  let manifestError = null;
  if (core.repo && (await pathExists(`${core.workdir}/.git`))) {
    try {
      manifest = await readManifestFromWorktree(core.workdir);
    } catch (err) {
      manifestError = err.code === 'NO_MANIFEST' ? null : err.message;
      manifest = null;
    }
  }
  const diffSelection = normalizeSelection(manifest?.selection ?? selection);
  const { scan: diffScan } = applySelection(full, diffSelection);
  const diff = diffAgainst(diffScan, manifest);

  return {
    configured: core.repo !== '',
    config: {
      repo: core.repo,
      branch: core.branch,
      workdir: core.workdir,
      profile: core.profile,
      dshHome: core.dshHome,
      skillsDir: core.skillsDir,
    },
    selection,
    groups: countItems(full, selection),
    totals: scan.totals,
    allTotals: full.totals,
    manifest: manifest === null ? null : {
      createdAt: manifest.createdAt,
      profile: manifest.profile,
      totals: manifest.totals,
    },
    manifestError,
    counts: diff?.counts ?? null,
    changes: diff?.changes ?? [],
    credentials: full.credentials,
    warnings: full.warnings,
  };
}

export function buildRoutes(hostCtx) {
  return [
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(async () => await buildState(hostCtx)),
    },
    {
      path: `${ROUTE_PREFIX}/settings`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const core = await makeCoreContext(hostCtx);
        const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
        if (repo === '') throw new Error('请填写 Git 仓库地址');
        const branch = typeof body.branch === 'string' && body.branch.trim() !== '' ? body.branch.trim() : core.branch;
        const workdir = typeof body.workdir === 'string' && body.workdir.trim() !== '' ? body.workdir.trim() : core.workdir;
        const current = await loadConfig();
        await saveConfig({
          ...current,
          version: 1,
          repo,
          branch,
          workdir,
          profile: core.profile,
          dshHome: core.dshHome,
          skillsDir: core.skillsDir,
          updatedAt: new Date().toISOString(),
        });
        return await buildState(hostCtx);
      }),
    },
    {
      path: `${ROUTE_PREFIX}/selection`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const core = await makeCoreContext(hostCtx);
        const selection = body.selection !== undefined
          ? normalizeSelection(body.selection)
          : selectionFromArgs(body, core.selection);
        await saveSelection(selection);
        return await buildState(hostCtx);
      }),
    },
    {
      path: `${ROUTE_PREFIX}/file-preview`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => await previewItem(hostCtx, body)),
    },
    {
      path: `${ROUTE_PREFIX}/preview-backup`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => await buildBackupPreview(hostCtx, body)),
    },
    {
      path: `${ROUTE_PREFIX}/backup`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const core = await makeCoreContext(hostCtx);
        requireRepo(core);
        core.selection = body.selection !== undefined
          ? normalizeSelection(body.selection)
          : selectionFromArgs(body, core.selection);
        const result = await runBackup(core, {
          message: typeof body.message === 'string' && body.message.trim() !== '' ? body.message.trim() : undefined,
          noPush: body.noPush === true,
        });
        return {
          commit: result.commit,
          pushed: result.pushed,
          totals: result.manifest.totals,
          modules: result.manifest.modules,
          excludedCount: result.excludedCount,
          credentials: result.credentials,
          warnings: result.warnings,
          archivedWorkdir: result.archivedWorkdir ?? null,
        };
      }),
    },
    {
      path: `${ROUTE_PREFIX}/restore`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const core = await makeCoreContext(hostCtx);
        requireRepo(core);
        const result = await runRestore(core, {
          commit: typeof body.commit === 'string' && body.commit.trim() !== '' ? body.commit.trim() : undefined,
          dryRun: body.confirm !== true,
          prune: body.prune === true,
          force: body.force === true,
          keepLocal: Array.isArray(body.keepLocal) ? body.keepLocal.filter((value) => typeof value === 'string') : [],
          // The desktop app owns its profile; the CLI install command refuses to
          // run while it is open. The page asks the user to restart instead.
          noInstall: true,
        });
        const changedPlugins = result.plan.actions.some((a) => a.module === 'plugins' && a.status !== 'same');
        return {
          dryRun: result.dryRun,
          commit: result.commit,
          profile: result.manifest.profile,
          createdAt: result.manifest.createdAt,
          counts: result.plan.counts,
          actions: result.plan.actions.map((a) => ({
            status: a.status,
            module: a.module,
            root: a.root,
            path: a.path,
          })),
          extras: result.plan.extras.map((e) => ({ root: e.root, path: e.path })),
          keptLocal: result.keptLocal,
          snapshot: result.snapshot?.dir ?? null,
          needsRestart: !result.dryRun && (changedPlugins || result.plan.counts.create + result.plan.counts.update > 0),
        };
      }),
    },
    {
      path: `${ROUTE_PREFIX}/history`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        const core = await makeCoreContext(hostCtx);
        requireRepo(core);
        if (!(await pathExists(`${core.workdir}/.git`))) return { commits: [] };
        const limit = Number.isFinite(body.limit) ? Math.min(100, Math.max(1, Math.round(body.limit))) : 20;
        return { commits: gitLog({ workdir: core.workdir, limit }) };
      }),
    },
  ];
}

export function registerRoutes(hostCtx) {
  const connection = hostCtx.get('connection');
  const register = typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : null;
  if (register === null) {
    hostCtx.logger?.warn?.('[dsh-git-backup] connection.fetch.register unavailable; settings page API not mounted');
    return;
  }
  let registered = 0;
  for (const definition of buildRoutes(hostCtx)) {
    try {
      hostCtx.effect(() => register(definition), `dsh-git-backup: ${definition.path}`);
      registered += 1;
    } catch (error) {
      hostCtx.logger?.error?.(`[dsh-git-backup] route ${definition.path} failed: ${error?.message ?? error}`);
    }
  }
  hostCtx.logger?.info?.(`[dsh-git-backup] registered ${registered} API routes`);
}
