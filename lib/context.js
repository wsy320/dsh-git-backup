import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeSelection, resolveContext } from '../src/config.js';

export const MODULES = ['skills', 'plugins', 'config'];

export function readLaunchEnv(ctx, key) {
  try {
    const snapshot = typeof ctx?.get === 'function' ? ctx.get('launchEnvironment', false) : undefined;
    if (snapshot !== undefined && snapshot !== null && typeof snapshot.get === 'function') {
      const entry = snapshot.get(key);
      if (entry !== undefined && entry !== null && typeof entry.value === 'string' && entry.value.trim() !== '') {
        return entry.value.trim();
      }
    }
  } catch {
    // fall through to process.env
  }
  const value = process.env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function resolveHome(ctx) {
  const configured = readLaunchEnv(ctx, 'DSH_HOME');
  if (configured !== undefined) return configured;
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext', false) : undefined;
  const dir = typeof profileContext?.dir === 'string' ? profileContext.dir.trim() : '';
  if (dir !== '') return dirname(dirname(dir));
  return join(homedir(), '.dsh');
}

export function resolveProfile(ctx) {
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext', false) : undefined;
  const fromContext = typeof profileContext?.name === 'string' ? profileContext.name.trim() : '';
  if (fromContext !== '') return fromContext;
  return readLaunchEnv(ctx, 'DSH_PROFILE') ?? 'desktop';
}

export function resolveSkillsDir(ctx) {
  return readLaunchEnv(ctx, 'DSH_AGENTS_SKILLS') ?? join(homedir(), '.agents', 'skills');
}

export async function makeCoreContext(hostCtx) {
  return await resolveContext({
    dshHome: resolveHome(hostCtx),
    profile: resolveProfile(hostCtx),
    skillsDir: resolveSkillsDir(hostCtx),
  });
}

export function selectionFromArgs(args, base) {
  const selection = normalizeSelection(base);
  if (Array.isArray(args?.modules)) {
    const wanted = new Set(args.modules.filter((id) => MODULES.includes(id)));
    for (const id of MODULES) selection.modules[id] = wanted.has(id);
  }
  const add = (module, list) => {
    if (!Array.isArray(list)) return;
    for (const value of list) {
      if (typeof value === 'string' && value.trim() !== '') selection.exclude[module].push(value.trim());
    }
    selection.exclude[module] = [...new Set(selection.exclude[module])].sort();
  };
  add('skills', args?.excludeSkills);
  add('plugins', args?.excludePlugins);
  add('config', args?.excludeConfig);
  return selection;
}

export function lossless(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function errorResult(error) {
  return { ok: false, error: { message: error?.message ?? String(error) } };
}

export function requireRepo(core) {
  if (!core.repo) {
    throw new Error('未配置 Git 仓库地址。先运行 dsh-backup init --repo <url>，或在设置页填写仓库地址。');
  }
}
