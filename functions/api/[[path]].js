// AxureHub REST API
//
// 路由采用单一 catch-all（functions/api/[[path]].js）内部派发，
// 便于集中做权限校验，同时减少 Functions 文件数量。

import { json, ok, fail, newId, slugify, normalizePath, pickEntry, mimeFor } from '../_lib/util.js';
import {
  getPasswords,
  canWrite,
  tryLogin,
  createSession,
  sessionCookie,
  clearCookie,
  invalidatePasswordCache,
} from '../_lib/auth.js';
import { getStore } from '../_lib/store.js';
import {
  fileKey,
  partKey,
  tmpKey,
  putObject,
  getObject,
  listPrefix,
  deletePrefix,
} from '../_lib/r2.js';
import { parseShard, shardLimit } from '../_lib/shard.js';

const MAX_FILES = 5000;

/* ------------------------------ 工具 ------------------------------ */

function match(segs, pattern) {
  const p = pattern.split('/');
  if (p.length !== segs.length) return null;
  const out = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = segs[i];
    else if (p[i] !== segs[i]) return null;
  }
  return out;
}

function publicVersion(v) {
  return {
    version: v.version,
    note: v.note,
    size: v.size,
    fileCount: v.fileCount,
    entry: v.entry,
    pageCount: (v.pages || []).length,
    createdAt: v.createdAt,
  };
}

function publicProto(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    emoji: p.emoji,
    description: p.description,
    tags: p.tags,
    entry: p.entry,
    activeVersion: p.activeVersion,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    versions: (p.versions || []).map(publicVersion),
  };
}

function sanitizeFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('文件列表为空');
  const seen = new Set();
  const out = [];
  for (const f of files.slice(0, MAX_FILES)) {
    const p = normalizePath(f && f.path);
    if (!p) throw new Error('存在非法文件路径');
    const lower = p.toLowerCase();
    if (lower === '.parts' || lower.startsWith('.parts/')) throw new Error('保留路径 .parts 不可用');
    if (seen.has(p)) throw new Error(`重复文件路径：${p}`);
    seen.add(p);
    out.push({ path: p, size: Math.max(0, Number(f.size) || 0) });
  }
  return out;
}

function sanitizePages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.slice(0, 500).map((x) => ({
    name: String((x && x.name) || '').slice(0, 120),
    url: normalizePath((x && x.url) || '') || 'index.html',
  }));
}

async function getMeta(env, uploadId) {
  if (!uploadId) throw new Error('缺少 uploadId');
  const obj = await getObject(env, tmpKey(uploadId, 'meta.json'));
  if (!obj) throw new Error('上传任务不存在或已过期');
  return obj.json();
}

/* --------------------------- 处理器：认证 --------------------------- */

async function login(ctx) {
  const { password } = await ctx.request.json().catch(() => ({}));
  const role = await tryLogin(ctx.env, password);
  if (!role) return fail('密码错误', 401);
  const { token, exp } = await createSession(ctx.env, role);
  return json(
    { ok: true, role },
    200,
    { 'set-cookie': sessionCookie(token, exp, ctx.request) },
  );
}

async function logout(ctx) {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(ctx.request) });
}

async function me(ctx) {
  const pw = await getPasswords(ctx.env);
  const user = ctx.data.user;
  return ok({
    authed: !!user,
    role: user ? user.role : null,
    isAdmin: canWrite(user, pw),
    needSitePassword: !!pw.site,
    needAdminPassword: !!pw.admin,
    backend: ctx.data.backend,
  });
}

/* --------------------------- 处理器：原型 --------------------------- */

async function listPrototypes(ctx) {
  const all = await getStore(ctx.env).listPrototypes();
  return ok({ items: all.map(publicProto) });
}

async function getPrototype(ctx, m) {
  const p = await getStore(ctx.env).getPrototype(m.id);
  if (!p) return fail('原型不存在', 404);
  return ok({ prototype: p });
}

async function patchPrototype(ctx, m, preset) {
  const b = preset || (await ctx.request.json());
  const store = getStore(ctx.env);
  const p = await store.getPrototype(m.id);
  if (!p) return fail('原型不存在', 404);

  const patch = { updatedAt: Date.now() };
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 200);
  if (b.emoji !== undefined) patch.emoji = String(b.emoji).slice(0, 8) || '🧩';
  if (b.description !== undefined) patch.description = String(b.description).slice(0, 2000);
  if (b.tags !== undefined) patch.tags = String(b.tags).slice(0, 500);
  if (b.sortOrder !== undefined) patch.sortOrder = Number(b.sortOrder) || 0;
  if (b.entry !== undefined) patch.entry = normalizePath(b.entry) || p.entry;
  if (b.slug !== undefined) {
    const slug = slugify(b.slug || b.name || p.name);
    const exist = await store.getPrototypeBySlug(slug);
    if (exist && exist.id !== p.id) return fail(`标识 ${slug} 已被占用`, 409);
    patch.slug = slug;
  }
  if (b.activeVersion !== undefined) {
    const v = Number(b.activeVersion);
    if (!(p.versions || []).some((x) => x.version === v)) return fail('版本不存在', 404);
    patch.activeVersion = v;
    const ver = p.versions.find((x) => x.version === v);
    patch.entry = ver.entry || 'index.html';
  }
  await store.updatePrototype(m.id, patch);
  return ok({ prototype: publicProto({ ...p, ...patch }) });
}

async function deletePrototype(ctx, m) {
  const store = getStore(ctx.env);
  const p = await store.getPrototype(m.id);
  if (!p) return fail('原型不存在', 404);
  for (const v of p.versions || []) await deletePrefix(ctx.env, `p/${p.id}/v${v.version}/`);
  await deletePrefix(ctx.env, `p/${p.id}/`);
  await store.deletePrototype(m.id);
  return ok();
}

async function deleteVersion(ctx, m) {
  const store = getStore(ctx.env);
  const p = await store.getPrototype(m.id);
  if (!p) return fail('原型不存在', 404);
  const v = Number(m.v);
  if (!(p.versions || []).some((x) => x.version === v)) return fail('版本不存在', 404);
  if ((p.versions || []).length <= 1) return fail('至少保留一个版本');
  await deletePrefix(ctx.env, `p/${p.id}/v${v}/`);
  await store.deleteVersion(p.id, v);
  const rest = (p.versions || []).filter((x) => x.version !== v);
  if (p.activeVersion === v) {
    const nv = rest[0].version;
    await store.updatePrototype(p.id, { activeVersion: nv, entry: rest[0].entry, updatedAt: Date.now() });
  }
  return ok({ activeVersion: p.activeVersion === v ? rest[0].version : p.activeVersion });
}

async function listFiles(ctx, m) {
  const p = await getStore(ctx.env).getPrototype(m.id);
  if (!p) return fail('原型不存在', 404);
  const v = Number(new URL(ctx.request.url).searchParams.get('version')) || p.activeVersion;
  const ver = (p.versions || []).find((x) => x.version === v);
  if (!ver) return fail('版本不存在', 404);
  return ok({
    version: v,
    entry: ver.entry,
    files: (ver.files || []).map((f) => ({ path: f.p, size: f.s })),
  });
}

/* --------------------------- 处理器：上传 --------------------------- */

async function initUpload(ctx) {
  const b = await ctx.request.json();
  const store = getStore(ctx.env);
  const name = String(b.name || '').trim();
  if (!name) return fail('请填写原型名称');

  const kind = b.kind === 'single' ? 'single' : 'folder';
  const files = sanitizeFiles(b.files);
  const paths = files.map((f) => f.path);
  const entry = normalizePath(b.entry) || pickEntry(paths) || (kind === 'single' ? 'index.html' : paths[0]);
  if (!paths.includes(entry)) return fail(`入口文件不存在：${entry}`);

  const slugBase = slugify(b.slug || name, 'proto');
  let proto = b.protoId ? await store.getPrototype(b.protoId) : await store.getPrototypeBySlug(slugBase);
  let create = null;
  let slug = slugBase;

  if (!proto) {
    let n = 2;
    while (await store.getPrototypeBySlug(slug)) slug = `${slugBase}-${n++}`;
    create = {
      id: newId('p'),
      slug,
      name,
      kind,
      emoji: String(b.emoji || '🧩').slice(0, 8),
      description: String(b.description || '').slice(0, 2000),
      tags: String(b.tags || '').slice(0, 500),
      entry,
      activeVersion: 1,
      sortOrder: Number(b.sortOrder) || 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: [],
    };
  }

  const protoId = proto ? proto.id : create.id;
  const existing = proto ? proto.versions || [] : [];
  const maxV = existing.reduce((a, x) => Math.max(a, x.version), 0);
  const replace = b.replaceVersion ? Number(b.replaceVersion) : 0;
  const version = replace && existing.some((x) => x.version === replace) ? replace : maxV + 1;

  if (replace) await deletePrefix(ctx.env, `p/${protoId}/v${replace}/`);

  const uploadId = crypto.randomUUID();
  const meta = {
    uploadId,
    protoId,
    version,
    replace,
    kind,
    create,
    entry,
    pages: sanitizePages(b.pages),
    note: String(b.note || '').slice(0, 500),
    files,
    totalShards: Number(b.totalShards) || 0,
    autoActivate: b.autoActivate !== false,
    createdAt: Date.now(),
  };
  await putObject(ctx.env, tmpKey(uploadId, 'meta.json'), JSON.stringify(meta), {
    contentType: 'application/json',
  });

  return ok({ uploadId, protoId, version, shardSize: shardLimit(ctx.env), replace });
}

async function receiveShard(ctx) {
  const url = new URL(ctx.request.url);
  const uploadId = url.searchParams.get('uploadId') || url.searchParams.get('u');
  const index = Number(url.searchParams.get('index') ?? url.searchParams.get('i'));
  if (!Number.isFinite(index)) return fail('缺少分片序号');

  const meta = await getMeta(ctx.env, uploadId);
  const limit = shardLimit(ctx.env);
  const buf = await ctx.request.arrayBuffer();
  const { files } = await parseShard(buf, limit);

  const written = [];
  for (const { entry, bytes } of files) {
    const path = normalizePath(entry.p);
    const key =
      entry.t > 1 ? partKey(meta.protoId, meta.version, entry.i, entry.s) : fileKey(meta.protoId, meta.version, path);
    await putObject(ctx.env, key, bytes, { contentType: mimeFor(path) });
    written.push({ p: path, k: key, i: entry.i, s: entry.s, t: entry.t, size: entry.l });
  }

  await putObject(ctx.env, tmpKey(uploadId, `s/${index}.json`), JSON.stringify({ index, files: written }), {
    contentType: 'application/json',
  });
  return ok({ index, count: written.length });
}

async function completeUpload(ctx) {
  const b = await ctx.request.json().catch(() => ({}));
  const meta = await getMeta(ctx.env, b.uploadId || new URL(ctx.request.url).searchParams.get('uploadId'));
  const store = getStore(ctx.env);

  const shardKeys = await listPrefix(ctx.env, tmpKey(meta.uploadId, 's/'));
  if (meta.totalShards && shardKeys.length < meta.totalShards) {
    return fail(`分片缺失：已收到 ${shardKeys.length}/${meta.totalShards}`, 409);
  }

  const partsMap = new Map();
  for (const k of shardKeys) {
    const obj = await getObject(ctx.env, k);
    if (!obj) continue;
    const rec = await obj.json();
    for (const f of rec.files || []) {
      const cur = partsMap.get(f.p) || { size: 0, parts: [] };
      cur.parts.push({ seq: f.s || 0, key: f.k });
      cur.size += f.size || 0;
      partsMap.set(f.p, cur);
    }
  }

  const files = [];
  for (const f of meta.files) {
    const got = partsMap.get(f.path);
    if (!got) return fail(`文件未完整上传：${f.path}`, 409);
    files.push({
      p: f.path,
      s: got.size,
      k: got.parts.sort((a, b) => a.seq - b.seq).map((x) => x.key),
    });
  }

  const size = files.reduce((a, f) => a + f.s, 0);
  const version = {
    version: meta.version,
    note: meta.note,
    size,
    fileCount: files.length,
    entry: meta.entry,
    pages: meta.pages,
    files,
    createdAt: Date.now(),
  };

  if (meta.create) {
    meta.create.activeVersion = meta.version;
    meta.create.updatedAt = Date.now();
    await store.createPrototype(meta.create);
  }
  await store.putVersion(meta.protoId, version);

  const patch = { updatedAt: Date.now() };
  if (meta.autoActivate) {
    patch.activeVersion = meta.version;
    patch.entry = meta.entry;
  }
  await store.updatePrototype(meta.protoId, patch);

  await deletePrefix(ctx.env, tmpKey(meta.uploadId, ''));
  return ok({ prototype: publicProto(await store.getPrototype(meta.protoId)) });
}

async function abortUpload(ctx) {
  const b = await ctx.request.json().catch(() => ({}));
  const uploadId = b.uploadId || new URL(ctx.request.url).searchParams.get('uploadId');
  if (!uploadId) return fail('缺少 uploadId');
  await deletePrefix(ctx.env, tmpKey(uploadId, ''));
  return ok();
}

/* --------------------------- 处理器：链接 --------------------------- */

async function listLinks(ctx) {
  return ok({ items: await getStore(ctx.env).listLinks() });
}

async function createLink(ctx) {
  const b = await ctx.request.json();
  if (!b.name || !b.url) return fail('名称与地址不能为空');
  let url = String(b.url).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const links = await getStore(ctx.env).listLinks();
  const now = Date.now();
  const link = {
    id: newId('l'),
    name: String(b.name).slice(0, 200),
    url,
    emoji: String(b.emoji || '🔗').slice(0, 8),
    description: String(b.description || '').slice(0, 1000),
    tags: String(b.tags || '').slice(0, 500),
    sortOrder: Number(b.sortOrder) || links.length,
    createdAt: now,
    updatedAt: now,
  };
  await getStore(ctx.env).createLink(link);
  return ok({ link });
}

async function patchLink(ctx, m) {
  const b = await ctx.request.json();
  const store = getStore(ctx.env);
  const all = await store.listLinks();
  if (!all.some((x) => x.id === m.id)) return fail('链接不存在', 404);
  const patch = { updatedAt: Date.now() };
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 200);
  if (b.emoji !== undefined) patch.emoji = String(b.emoji).slice(0, 8);
  if (b.description !== undefined) patch.description = String(b.description).slice(0, 1000);
  if (b.tags !== undefined) patch.tags = String(b.tags).slice(0, 500);
  if (b.sortOrder !== undefined) patch.sortOrder = Number(b.sortOrder) || 0;
  if (b.url !== undefined) {
    let url = String(b.url).trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    patch.url = url;
  }
  await store.updateLink(m.id, patch);
  return ok({ link: { ...all.find((x) => x.id === m.id), ...patch } });
}

async function deleteLink(ctx, m) {
  await getStore(ctx.env).deleteLink(m.id);
  return ok();
}

async function reorderLinks(ctx) {
  const b = await ctx.request.json();
  const store = getStore(ctx.env);
  if (!Array.isArray(b.order)) return fail('缺少 order');
  await Promise.all(b.order.map((id, i) => store.updateLink(String(id), { sortOrder: i })));
  return ok();
}

/* --------------------------- 处理器：设置 --------------------------- */

async function getSettings(ctx) {
  const pw = await getPasswords(ctx.env);
  return ok({
    backend: ctx.data.backend,
    hasSitePassword: !!pw.site,
    hasAdminPassword: !!pw.admin,
    siteFromEnv: !!ctx.env.SITE_PASSWORD,
    adminFromEnv: !!ctx.env.ADMIN_PASSWORD,
    shardSize: shardLimit(ctx.env),
  });
}

async function setSettings(ctx) {
  const b = await ctx.request.json();
  const patch = {};
  if (typeof b.SITE_PASSWORD === 'string') patch.SITE_PASSWORD = b.SITE_PASSWORD.trim();
  if (typeof b.ADMIN_PASSWORD === 'string') patch.ADMIN_PASSWORD = b.ADMIN_PASSWORD.trim();
  await getStore(ctx.env).setSettings(patch);
  invalidatePasswordCache();
  return ok({ saved: Object.keys(patch) });
}

/* --------------------------- 处理器：搜索索引 --------------------------- */

async function searchIndex(ctx) {
  const store = getStore(ctx.env);
  const [protos, links] = await Promise.all([store.listPrototypes(), store.listLinks()]);
  return ok({
    updatedAt: Date.now(),
    prototypes: protos.map((p) => {
      const ver = (p.versions || []).find((x) => x.version === p.activeVersion) || (p.versions || [])[0];
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        kind: p.kind,
        emoji: p.emoji || '🧩',
        description: p.description || '',
        tags: p.tags || '',
        updatedAt: p.updatedAt,
        version: ver ? ver.version : 0,
        entry: ver ? ver.entry : 'index.html',
        pages: (ver && ver.pages) || [],
      };
    }),
    links: links.map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      emoji: l.emoji || '🔗',
      description: l.description || '',
      tags: l.tags || '',
      sortOrder: l.sortOrder || 0,
      updatedAt: l.updatedAt,
    })),
  });
}

/* ------------------------------ 路由 ------------------------------ */

export async function onRequest(ctx) {
  const { request, env, data } = ctx;
  const method = request.method.toUpperCase();
  const segs = (ctx.params.path || []).filter(Boolean);
  const url = new URL(request.url);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'GET,POST,PATCH,PUT,DELETE' } });
  }

  const route = `${method} ${segs.join('/')}`;

  // —— 公开接口（登录前可用）——
  if (route === 'POST auth/login') return login(ctx);
  if (route === 'POST auth/logout') return logout(ctx);
  if (route === 'GET auth/me') return me(ctx);
  if (route === 'GET bootstrap') {
    const pw = await getPasswords(env);
    return ok({
      backend: data.backend,
      authed: !!data.user,
      role: data.user ? data.user.role : null,
      needSitePassword: !!pw.site,
      needAdminPassword: !!pw.admin,
    });
  }

  // —— 以下均需通过全站密码 ——
  if (!data.user) return fail('未登录', 401, { needLogin: true });

  let m;
  // —— 读接口 ——
  if (route === 'GET index') return searchIndex(ctx);
  if (route === 'GET prototypes') return listPrototypes(ctx);
  if (route === 'GET links') return listLinks(ctx);
  if ((m = match(segs, 'prototypes/:id')) && method === 'GET') return getPrototype(ctx, m);
  if ((m = match(segs, 'prototypes/:id/files')) && method === 'GET') return listFiles(ctx, m);

  // —— 写接口：需要管理员密码 ——
  const pw = await getPasswords(env);
  if (!canWrite(data.user, pw)) return fail('需要管理员权限，请使用管理员密码登录', 403);
  if (!env.BUCKET) return fail('缺少 R2 绑定（BUCKET）', 500);

  try {
    if (route === 'POST upload/init') return initUpload(ctx);
    if (route === 'POST upload/shard') return receiveShard(ctx);
    if (route === 'PUT upload/shard') return receiveShard(ctx);
    if (route === 'POST upload/complete') return completeUpload(ctx);
    if (route === 'POST upload/abort') return abortUpload(ctx);
    if (route === 'DELETE upload') return abortUpload(ctx);

    if ((m = match(segs, 'prototypes/:id')) && method === 'PATCH') return patchPrototype(ctx, m);
    if ((m = match(segs, 'prototypes/:id')) && method === 'DELETE') return deletePrototype(ctx, m);
    if ((m = match(segs, 'prototypes/:id/versions/:v')) && method === 'DELETE') return deleteVersion(ctx, m);
    if ((m = match(segs, 'prototypes/:id/versions/:v/activate')) && method === 'POST')
      return patchPrototype(ctx, m, { activeVersion: Number(m.v) });

    if (route === 'POST links') return createLink(ctx);
    if (route === 'POST links/reorder') return reorderLinks(ctx);
    if ((m = match(segs, 'links/:id')) && method === 'PATCH') return patchLink(ctx, m);
    if ((m = match(segs, 'links/:id')) && method === 'DELETE') return deleteLink(ctx, m);

    if (route === 'GET settings') return getSettings(ctx);
    if (route === 'POST settings') return setSettings(ctx);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e), 400);
  }

  return fail(`接口不存在：${route}`, 404);
}
