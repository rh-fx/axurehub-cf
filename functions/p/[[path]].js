// 原型静态文件托管：/p/<slug>/<相对路径>
// 文件全部存放于 R2，按版本目录隔离；跨片文件在此按 parts 顺序流式拼回。

import { getStore } from '../_lib/store.js';
import { openStream } from '../_lib/r2.js';
import { mimeFor, normalizePath } from '../_lib/util.js';

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function findFile(files, target) {
  const exact = files.find((f) => f.p === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  return files.find((f) => f.p.toLowerCase() === lower) || null;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // 直接从 pathname 解析，保留结尾斜杠语义（params 会丢掉尾随空段）
  const rest = url.pathname.replace(/^\/p\//, '');
  const slash = rest.indexOf('/');
  if (!rest || rest === 'p' || slash < 0) {
    const only = slash < 0 ? rest : rest.slice(0, slash);
    if (!only) return new Response('Not Found', { status: 404 });
    return new Response(null, { status: 302, headers: { location: `/p/${only}/` } });
  }

  const slug = safeDecode(rest.slice(0, slash));
  const rel = rest.slice(slash + 1).split('/').map(safeDecode).join('/');

  const store = getStore(env);
  const proto = await store.getPrototypeBySlug(slug);
  if (!proto) {
    return new Response('原型不存在：' + slug, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const wantV = Number(url.searchParams.get('v'));
  const versions = proto.versions || [];
  const ver =
    (wantV && versions.find((x) => x.version === wantV)) ||
    versions.find((x) => x.version === proto.activeVersion) ||
    versions[0];
  if (!ver) return new Response('该原型暂无可用版本', { status: 404 });

  const files = ver.files || [];
  const target = normalizePath(rel);
  let file = target ? findFile(files, target) : null;
  if (!file) {
    for (const cand of [`${target}/index.html`, `${target}.html`, `${target}/index.htm`]) {
      file = findFile(files, cand);
      if (file) break;
    }
  }
  if (!file) {
    // 目录型 / 无扩展名请求回退到入口页；带扩展名的静态资源缺失则直接 404，
    // 避免把 index.html 当成 js/css 返回给浏览器
    const last = target.split('/').pop() || '';
    if (last.includes('.')) return new Response('文件不存在：' + target, { status: 404 });
    file = findFile(files, ver.entry || 'index.html');
    if (!file) return new Response('文件不存在：' + target, { status: 404 });
  }

  const opened = await openStream(env, file.k, file.s);
  if (!opened) return new Response('文件数据缺失', { status: 500 });

  const headers = new Headers({
    'content-type': mimeFor(file.p),
    'cache-control': /\.html?$/i.test(file.p) ? 'no-cache' : 'public, max-age=300',
    'x-axurehub-version': String(ver.version),
  });
  if (opened.etag) headers.set('etag', opened.etag);
  if (opened.size) headers.set('content-length', String(opened.size));

  return new Response(opened.body, { status: 200, headers });
}
