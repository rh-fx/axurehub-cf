// AxureHub —— Cloudflare Worker 入口（Workers + Static Assets）
//
// 原 Pages Functions 代码（functions/ 目录）保持 `onRequest(context)` 签名不变，
// 这里只做一层适配：
//   1. 先跑 functions/_middleware.js（全站访问密码 / 会话解析）
//   2. 再按前缀分发到 api / p / s 三个 handler
//   3. 其余请求交给静态资源绑定 ASSETS（public/ 目录）
//
// 之所以用 run_worker_first = true（见 wrangler.toml）：首页与全部 API 都要过
// 访问密码校验，因此不能让静态资源先命中就短路返回。

import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequest as apiHandler } from '../functions/api/[[path]].js';
import { onRequest as prototypeHandler } from '../functions/p/[[path]].js';
import { onRequest as singleHandler } from '../functions/s/[[path]].js';

/** 构造 Pages Functions 风格的 context（env / data / next 都在其中） */
function makeContext(request, env, ctx, data, extra = {}) {
  return {
    request,
    env,
    ctx,
    data,
    params: {},
    waitUntil: ctx.waitUntil.bind(ctx),
    ...extra,
  };
}

/** 路由分发：/api/* → REST API，/p/* → 原型静态文件，/s/* → 单文件原型，其余 → 静态资源 */
function dispatch(request, env, ctx, data) {
  const { pathname } = new URL(request.url);

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const segs = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    return apiHandler(makeContext(request, env, ctx, data, { params: { path: segs } }));
  }

  if (pathname === '/p' || pathname.startsWith('/p/')) {
    return prototypeHandler(makeContext(request, env, ctx, data));
  }

  if (pathname === '/s' || pathname.startsWith('/s/')) {
    return singleHandler(makeContext(request, env, ctx, data));
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    // data 由中间件写入（backend / passwords / user），后续 handler 直接读取
    const data = {};
    return middleware(makeContext(request, env, ctx, data, { next: () => dispatch(request, env, ctx, data) }));
  },
};
