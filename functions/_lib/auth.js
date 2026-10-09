// 双重安全控制：
//   1) 全站访问密码 SITE_PASSWORD —— 由 functions/_middleware.js 强制
//   2) 独立管理员密码 ADMIN_PASSWORD —— 所有写操作（上传/删除/修改）需要
// 会话为 HMAC-SHA256 签名的 HttpOnly Cookie，无需额外存储。

import { safeEqual, sha256 } from './util.js';
import { getStore } from './store.js';

export const COOKIE_NAME = 'ahub_session';
const SESSION_CACHE_TTL = 30 * 1000; // 密钥缓存 30s，避免每个请求都查一次 D1/KV

let secretCache = { t: 0, value: null };

function b64uEncode(bytes) {
  const s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 读取全站密码 / 管理员密码（环境变量优先，其次存储中的设置项） */
export async function getPasswords(env) {
  const now = Date.now();
  if (secretCache.value && now - secretCache.t < SESSION_CACHE_TTL) return secretCache.value.value;

  let stored = {};
  try {
    stored = await getStore(env).getSettings();
  } catch (e) {
    stored = {};
  }
  const value = {
    site: env.SITE_PASSWORD || stored.SITE_PASSWORD || '',
    admin: env.ADMIN_PASSWORD || stored.ADMIN_PASSWORD || '',
  };
  secretCache = { t: now, value: { value } };
  return value;
}

export function invalidatePasswordCache() {
  secretCache = { t: 0, value: null };
}

async function signingKey(env) {
  const pw = await getPasswords(env);
  const material = env.SESSION_SECRET || `axurehub|${await sha256(pw.site)}|${await sha256(pw.admin)}`;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(material), {
    name: 'HMAC',
    hash: 'SHA-256',
  }, false, ['sign', 'verify']);
}

async function sign(payload, env) {
  const body = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(body));
  return `${body}.${b64uEncode(sig)}`;
}

export async function createSession(env, role, ttlSeconds = 0) {
  const ttl = Number(ttlSeconds) || Number(env.SESSION_TTL) || 604800;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return { token: await sign({ r: role, e: exp }, env), exp, ttl };
}

export function sessionCookie(token, exp, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(
    60,
    exp - Math.floor(Date.now() / 1000),
  )}${secure}`;
}

export function clearCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get('cookie');
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 解析并校验会话，返回 { role, exp } 或 null */
export async function readSession(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
  } catch {
    return null;
  }
  const key = await signingKey(env);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', key, b64uDecode(sig), new TextEncoder().encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;
  if (!payload.e || payload.e * 1000 < Date.now()) return null;
  return { role: payload.r === 'admin' ? 'admin' : 'visitor', exp: payload.e };
}

/** 登录：密码既可能是全站密码，也可能是管理员密码（管理员密码自动包含全站权限） */
export async function tryLogin(env, password) {
  const pw = await getPasswords(env);
  const input = String(password || '');
  const isAdmin = pw.admin && safeEqual(input, pw.admin);
  const isSite = pw.site && safeEqual(input, pw.site);
  if (!isAdmin && !isSite) return null;
  return isAdmin ? 'admin' : 'visitor';
}

/** 该用户能否执行写操作 */
export function canWrite(user, passwords) {
  if (!passwords.admin) return true; // 未设置管理员密码 => 开放管理（本地/私有部署）
  return !!user && user.role === 'admin';
}
