import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function homeDir(env = process.env) {
  return env.USERPROFILE || env.HOME || homedir();
}

export function expandHome(p, env = process.env) {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~') return homeDir(env);
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homeDir(env), p.slice(2));
  return p;
}

export async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

export async function remove(p) {
  await rm(p, { recursive: true, force: true });
}

/** Copy a file and preserve its executable bit where the platform supports it. */
export async function copyFilePreservingMode(src, dest) {
  await ensureDir(dirname(dest));
  await copyFile(src, dest);
  try {
    const st = await stat(src);
    await chmod(dest, st.mode);
  } catch {
    // chmod is best-effort on Windows / FAT volumes.
  }
}

export async function sha256File(file) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function readTextIfSmall(file, maxBytes) {
  try {
    const st = await stat(file);
    if (st.size > maxBytes) return null;
    const buf = await readFile(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Recursively list regular files under `base` as POSIX relative paths. */
export async function walkFiles(base, { skipDirNames = new Set(), onWarning = () => {} } = {}) {
  const out = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      onWarning({ path: dir, reason: `readdir: ${err.code || err.message}` });
      return;
    }
    for (const d of dirents) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (skipDirNames.has(d.name)) continue;
        await walk(abs);
        continue;
      }
      // Only real files: symlinks and devices are not portable backup material.
      if (!d.isFile()) continue;
      out.push({ absPath: abs, relPath: toPosix(relative(base, abs)) });
    }
  }
  await walk(base);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

export function assertRelativeSafe(relPath) {
  const p = toPosix(relPath);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    throw new Error(`不安全的相对路径: ${relPath}`);
  }
  return p;
}

export function isSubPath(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function timestampForPath(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function localTime(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function machineName(env = process.env) {
  return env.DSH_BACKUP_MACHINE || hostname() || 'unknown';
}

export function validateProfile(profile) {
  const p = String(profile ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(p)) {
    throw new Error(`profile 名不合法: ${profile}`);
  }
  return p;
}

/** A profile is a directory name; detect a sensible default instead of guessing blindly. */
export async function detectProfile(profilesDir) {
  let entries = [];
  try {
    entries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return 'desktop';
  }
  const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name);
  if (dirs.includes('desktop')) return 'desktop';
  if (dirs.length === 1) return dirs[0];
  return 'desktop';
}

export function summarizeChanges(changes) {
  const counts = { added: 0, modified: 0, missing: 0, same: 0 };
  for (const c of changes) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return counts;
}
