// 通用工具函数

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function ok(data = {}) {
  return json({ ok: true, ...data });
}

export function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

export function redirect(to, status = 302) {
  return new Response(null, { status, headers: { location: to } });
}

export function noStore(res) {
  res.headers.set('cache-control', 'no-store');
  return res;
}

/** 生成短 id（时间前缀 + 随机，便于排序） */
export function newId(prefix = '') {
  const t = Date.now().toString(36);
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`;
}

/** slug 化：只保留小写字母/数字/中划线，中文会被保留（Axure 项目常含中文名） */
export function slugify(input, fallback = 'proto') {
  const s = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return s || fallback;
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间字符串比较，避免时序侧信道 */
export function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
    diff |= (ea[i] || 0) ^ (eb[i] || 0);
  }
  return diff === 0;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(path = '') {
  const i = String(path).lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME[String(path).slice(i).toLowerCase()] || 'application/octet-stream';
}

/** 规范化原型内部路径：去掉 ./、多余斜杠，阻止 ../ 越界 */
export function normalizePath(p = '') {
  const raw = String(p).replace(/\\/g, '/');
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/** 判断该文件是否可作为入口 */
const ENTRY_CANDIDATES = ['index.html', 'index.htm', 'start.html', 'start_c_1.html'];

export function pickEntry(paths = []) {
  const set = new Set(paths.map((p) => String(p).toLowerCase()));
  for (const c of ENTRY_CANDIDATES) if (set.has(c)) return c;
  const firstHtml = paths.find((p) => /\.html?$/i.test(p) && !/^(resources|data|files|plugins)\//i.test(p));
  return firstHtml || null;
}

export function formatBytes(n = 0) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
