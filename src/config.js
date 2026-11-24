import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProfile, ensureDir, expandHome, homeDir, validateProfile } from './util.js';

export const DEFAULT_SELECTION = {
  version: 1,
  modules: { skills: true, plugins: true, config: true },
  exclude: { skills: [], plugins: [], config: [] },
};

export function appDir(env = process.env) {
  return join(homeDir(env), '.dsh-backup');
}

export function configPath(env = process.env) {
  return env.DSH_BACKUP_CONFIG || join(appDir(env), 'config.json');
}

export function selectionPath(env = process.env) {
  return join(appDir(env), 'selection.json');
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) throw new Error(`JSON 解析失败: ${path}: ${err.message}`);
    throw err;
  }
}

async function writeJson(path, value) {
  await ensureDir(join(path, '..'));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function loadConfig(env = process.env) {
  return await readJson(configPath(env), {});
}

export async function saveConfig(config, env = process.env) {
  await writeJson(configPath(env), config);
}

export async function loadSelection(env = process.env) {
  const selection = await readJson(selectionPath(env), null);
  return normalizeSelection(selection ?? DEFAULT_SELECTION);
}

export async function saveSelection(selection, env = process.env) {
  const normalized = normalizeSelection(selection);
  await writeJson(selectionPath(env), normalized);
  return normalized;
}

export function normalizeSelection(selection) {
  const source = selection ?? {};
  const modules = { ...DEFAULT_SELECTION.modules, ...(source.modules ?? {}) };
  const exclude = { ...DEFAULT_SELECTION.exclude };
  for (const id of Object.keys(exclude)) {
    const list = source.exclude?.[id];
    exclude[id] = Array.isArray(list) ? [...new Set(list.map(String))].sort() : [];
  }
  return { version: 1, modules, exclude };
}

export async function resolveContext(options = {}, env = process.env) {
  const config = await loadConfig(env);
  const dshHome = expandHome(options.dshHome || config.dshHome || env.DSH_HOME || join(homeDir(env), '.dsh'), env);
  const profile = validateProfile(
    options.profile || config.profile || env.DSH_PROFILE || (await detectProfile(join(dshHome, 'profiles'))),
  );
  const skillsDir = expandHome(
    options.skillsDir || config.skillsDir || env.DSH_AGENTS_SKILLS || join(homeDir(env), '.agents', 'skills'),
    env,
  );
  const workdir = expandHome(options.workdir || config.workdir || join(appDir(env), 'repo'), env);
  const repo = options.repo || config.repo || '';
  const branch = options.branch || config.branch || 'main';
  const stateDir = env.DSH_BACKUP_HOME || appDir(env);
  const selection = options.all
    ? normalizeSelection({ modules: { skills: true, plugins: true, config: true }, exclude: { skills: [], plugins: [], config: [] } })
    : await loadSelection(env);

  return {
    config,
    dshHome,
    profile,
    profileDir: join(dshHome, 'profiles', profile),
    skillsDir,
    workdir,
    repo,
    branch,
    stateDir,
    snapshotsDir: join(stateDir, 'snapshots'),
    selection,
  };
}

export async function updateState(patch, env = process.env) {
  const path = join(appDir(env), 'state.json');
  const state = await readJson(path, {});
  const next = { ...state, ...patch };
  await writeJson(path, next);
  return next;
}

export async function readState(env = process.env) {
  return await readJson(join(appDir(env), 'state.json'), {});
}
