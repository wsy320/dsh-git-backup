/**
 * Secret guard: credentials must never be committed to the backup repository.
 *
 * Two gates:
 *  1. filename/suffix gate — unconditional, does not read the file;
 *  2. content gate — high-signal token patterns, with real-token shapes so that
 *     placeholders such as `<token>` or `${TOKEN}` are not rejected.
 *
 * A blocked file is reported to the user, never silently skipped.
 */
import { basename } from 'node:path';

const SECRET_BASENAMES = new Set([
  '.credentials.yaml',
  '.credentials.yml',
  '.credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'credentials.json',
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  'auth.json',
  'github.token',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'cloud-credentials.json',
]);

const SECRET_SUFFIXES = ['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.ppk'];

const SECRET_PATTERNS = [
  { id: '私钥文件头', re: /-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----/ },
  { id: 'npm 认证令牌', re: /_auth(?:Token)?\s*=\s*[A-Za-z0-9_-]{16,}/ },
  { id: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { id: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.?/ },
  { id: '带令牌的 git 地址', re: /https?:\/\/x-access-token:[A-Za-z0-9_-]{20,}@/ },
  { id: '字面量 Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._-]{24,}/ },
];

const MAX_GUARD_BYTES = 1024 * 1024;

const REASON_BY_NAME = new Map([
  ['.credentials.yaml', '凭据文件本体（明文 API key / 会话密钥）'],
  ['.credentials.yml', '凭据文件本体（明文 API key / 会话密钥）'],
  ['.credentials.json', '凭据文件本体（明文 API key / 会话密钥）'],
  ['credentials.yaml', '凭据文件本体（明文 API key / 会话密钥）'],
  ['credentials.yml', '凭据文件本体（明文 API key / 会话密钥）'],
  ['credentials.json', '凭据文件本体（明文 API key / 会话密钥）'],
  ['secrets.yaml', '密钥文件本体'],
  ['secrets.yml', '密钥文件本体'],
  ['secrets.json', '密钥文件本体'],
  ['.env', '环境变量文件，常见放密钥的位置'],
  ['.env.local', '环境变量文件，常见放密钥的位置'],
  ['.env.production', '环境变量文件，常见放密钥的位置'],
  ['.env.development', '环境变量文件，常见放密钥的位置'],
  ['id_rsa', 'SSH 私钥'],
  ['id_dsa', 'SSH 私钥'],
  ['id_ecdsa', 'SSH 私钥'],
  ['id_ed25519', 'SSH 私钥'],
  ['auth.json', '登录凭据'],
  ['github.token', '登录凭据'],
  ['.netrc', '登录凭据'],
  ['_netrc', '登录凭据'],
  ['.git-credentials', 'Git 登录凭据'],
  ['.htpasswd', '密码文件'],
  ['.npmrc', '包管理器配置，可能含 _authToken，且常写死本机路径'],
  ['.yarnrc', '包管理器配置，可能含认证令牌'],
  ['.yarnrc.yml', '包管理器配置，可能含认证令牌'],
  ['cloud-credentials.json', '云备份密码'],
]);

export function secretBasenameReason(name) {
  const lower = String(name).toLowerCase();
  if (SECRET_BASENAMES.has(lower)) {
    return `凭据类 · ${REASON_BY_NAME.get(lower) ?? '文件名属于凭据类'}（${name}）`;
  }
  for (const suffix of SECRET_SUFFIXES) {
    if (lower.endsWith(suffix)) return `凭据类 · 后缀属于密钥容器（${suffix}）`;
  }
  return null;
}

export function inspectPath(relPath) {
  const parts = String(relPath).split(/[\\/]/).filter(Boolean);
  return secretBasenameReason(parts.length > 0 ? parts[parts.length - 1] : basename(String(relPath)));
}

function maskExcerpt(s) {
  const t = String(s);
  return t.length <= 10 ? `${t.slice(0, 2)}…` : `${t.slice(0, 6)}…${t.slice(-2)}`;
}

export function inspectContentMatch(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match !== null) return { id: pattern.id, excerpt: maskExcerpt(match[0]) };
  }
  return null;
}

/**
 * @param {{relPath: string, size?: number}} entry
 * @param {() => Promise<string|null>} [readText]
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
export async function guardEntry(entry, readText) {
  const byPath = inspectPath(entry.relPath);
  if (byPath !== null) return { blocked: true, reason: byPath };
  if (typeof entry.size === 'number' && entry.size > MAX_GUARD_BYTES) return { blocked: false };
  if (typeof readText !== 'function') return { blocked: false };
  let text;
  try {
    text = await readText();
  } catch {
    return { blocked: false };
  }
  if (text === null || text === undefined) return { blocked: false };
  const hit = inspectContentMatch(text);
  if (hit !== null) {
    return { blocked: true, reason: `内容命中「${hit.id}」（片段 ${hit.excerpt}）` };
  }
  return { blocked: false };
}
