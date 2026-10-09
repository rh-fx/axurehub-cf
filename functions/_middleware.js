// 全站访问密码中间件
//
// 除登录接口、登录页与其静态资源外，所有请求（页面 / API / 原型静态文件）
// 都必须携带有效会话 Cookie，否则 302 到 /login.html 或返回 401 JSON。

import { readSession, getPasswords } from './_lib/auth.js';
import { json } from './_lib/util.js';
import { backendName } from './_lib/store.js';

const PUBLIC_PATHS = ['/login.html', '/favicon.ico', '/favicon.svg', '/robots.txt'];
const PUBLIC_PREFIXES = ['/assets/', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/bootstrap'];

function isPublic(pathname) {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') return next();

  data.backend = backendName(env);
  const passwords = await getPasswords(env);
  data.passwords = passwords;
  data.user = await readSession(request, env);

  if (isPublic(pathname)) return next();

  // 未设置全站密码时：允许匿名浏览，管理员权限仍由独立管理员密码控制
  if (!passwords.site) {
    data.user = data.user || { role: 'visitor' };
    return next();
  }

  if (!data.user) {
    if (pathname.startsWith('/api/')) {
      return json({ ok: false, error: '未登录或会话已过期', needLogin: true }, 401);
    }
    const nextPath = pathname + (url.search || '');
    return Response.redirect(`${url.origin}/login.html?next=${encodeURIComponent(nextPath)}`, 302);
  }

  return next();
}
