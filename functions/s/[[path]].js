// 单文件 HTML 原型托管：/s/<slug>[/]
// 单文件原型只有一个 index.html；也可用 ?p=xxx.html 指定同版本内的其它文件。

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

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/s\//, '');
  const slash = rest.indexOf('/');
  const slugRaw = slash < 0 ? rest : rest.slice(0, slash);
  if (!slugRaw) return new Response('Not Found', { status: 404 });
  const slug = safeDecode(slugRaw);

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

  const tail = slash < 0 ? '' : rest.slice(slash + 1).split('/').map(safeDecode).join('/');
  const want = normalizePath(tail || url.searchParams.get('p') || ver.entry || 'index.html');
  const file = (ver.files || []).find((f) => f.p === want) || (ver.files || [])[0];
  if (!file) return new Response('文件不存在', { status: 404 });

  const opened = await openStream(ctx.env, file.k, file.s);
  if (!opened) return new Response('文件数据缺失', { status: 500 });

  const headers = new Headers({
    'content-type': mimeFor(file.p),
    'cache-control': 'no-cache',
    'x-axurehub-version': String(ver.version),
  });
  if (opened.size) headers.set('content-length', String(opened.size));
  return new Response(opened.body, { status: 200, headers });
}
