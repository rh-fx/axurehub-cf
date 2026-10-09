// 存储抽象层：
//   - 绑定了 D1 (SQLite) 时使用 D1（自动建表）
//   - 否则回退到 KV（单键 JSON 文档），保证「零配置也能跑」
// 两者对外暴露完全一致的接口。

import { newId } from './util.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS prototypes (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'folder', emoji TEXT NOT NULL DEFAULT '🧩',
    description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
    entry TEXT NOT NULL DEFAULT 'index.html', active_version INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS versions (
    proto_id TEXT NOT NULL, version INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
    entry TEXT NOT NULL DEFAULT 'index.html', pages_json TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
    PRIMARY KEY (proto_id, version))`,
  `CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🔗', description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

let d1Ready = null;
async function ensureD1(env) {
  if (!d1Ready) {
    d1Ready = (async () => {
      for (const sql of DDL) await env.DB.prepare(sql).run();
      return true;
    })().catch((e) => {
      d1Ready = null;
      throw e;
    });
  }
  return d1Ready;
}

const parseJson = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

/* ---------------------------------- D1 ---------------------------------- */

class D1Store {
  constructor(env) {
    this.env = env;
  }

  async ready() {
    return ensureD1(this.env);
  }

  async listPrototypes() {
    await ensureD1(this.env);
    const [ps, vs] = await Promise.all([
      this.env.DB.prepare(
        `SELECT * FROM prototypes ORDER BY sort_order ASC, updated_at DESC`,
      ).all(),
      this.env.DB.prepare(`SELECT * FROM versions ORDER BY proto_id, version DESC`).all(),
    ]);
    const byProto = new Map();
    for (const v of vs.results || []) {
      if (!byProto.has(v.proto_id)) byProto.set(v.proto_id, []);
      byProto.get(v.proto_id).push(rowToVersion(v));
    }
    return (ps.results || []).map((r) => ({ ...rowToProto(r), versions: byProto.get(r.id) || [] }));
  }

  async getPrototype(id) {
    await ensureD1(this.env);
    const p = await this.env.DB.prepare(`SELECT * FROM prototypes WHERE id = ?`).bind(id).first();
    if (!p) return null;
    const vs = await this.env.DB.prepare(
      `SELECT * FROM versions WHERE proto_id = ? ORDER BY version DESC`,
    ).bind(id).all();
    return { ...rowToProto(p), versions: (vs.results || []).map(rowToVersion) };
  }

  async getPrototypeBySlug(slug) {
    await ensureD1(this.env);
    const p = await this.env.DB.prepare(`SELECT * FROM prototypes WHERE slug = ?`).bind(slug).first();
    if (!p) return null;
    return this.getPrototype(p.id);
  }

  async createPrototype(p) {
    await ensureD1(this.env);
    await this.env.DB.prepare(
      `INSERT INTO prototypes (id, slug, name, kind, emoji, description, tags, entry, active_version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        p.id,
        p.slug,
        p.name,
        p.kind,
        p.emoji || '🧩',
        p.description || '',
        p.tags || '',
        p.entry || 'index.html',
        p.activeVersion || 1,
        p.sortOrder || 0,
        p.createdAt,
        p.updatedAt,
      )
      .run();
    return p;
  }

  async updatePrototype(id, patch) {
    await ensureD1(this.env);
    const cols = {
      slug: 'slug',
      name: 'name',
      emoji: 'emoji',
      description: 'description',
      tags: 'tags',
      entry: 'entry',
      activeVersion: 'active_version',
      sortOrder: 'sort_order',
      updatedAt: 'updated_at',
    };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(cols)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(patch[k]);
    }
    if (!sets.length) return;
    args.push(id);
    await this.env.DB.prepare(`UPDATE prototypes SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  }

  async deletePrototype(id) {
    await ensureD1(this.env);
    await this.env.DB.prepare(`DELETE FROM versions WHERE proto_id = ?`).bind(id).run();
    await this.env.DB.prepare(`DELETE FROM prototypes WHERE id = ?`).bind(id).run();
  }

  async putVersion(protoId, v) {
    await ensureD1(this.env);
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO versions (proto_id, version, note, size, file_count, entry, pages_json, files_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        protoId,
        v.version,
        v.note || '',
        v.size || 0,
        v.fileCount || 0,
        v.entry || 'index.html',
        JSON.stringify(v.pages || []),
        JSON.stringify(v.files || []),
        v.createdAt,
      )
      .run();
  }

  async deleteVersion(protoId, version) {
    await ensureD1(this.env);
    await this.env.DB.prepare(`DELETE FROM versions WHERE proto_id = ? AND version = ?`).bind(protoId, version).run();
  }

  async listLinks() {
    await ensureD1(this.env);
    const r = await this.env.DB.prepare(`SELECT * FROM links ORDER BY sort_order ASC, created_at DESC`).all();
    return (r.results || []).map(rowToLink);
  }

  async createLink(l) {
    await ensureD1(this.env);
    await this.env.DB.prepare(
      `INSERT INTO links (id, name, url, emoji, description, tags, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(l.id, l.name, l.url, l.emoji || '🔗', l.description || '', l.tags || '', l.sortOrder || 0, l.createdAt, l.updatedAt)
      .run();
    return l;
  }

  async updateLink(id, patch) {
    await ensureD1(this.env);
    const cols = { name: 'name', url: 'url', emoji: 'emoji', description: 'description', tags: 'tags', sortOrder: 'sort_order', updatedAt: 'updated_at' };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(cols)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(patch[k]);
    }
    if (!sets.length) return;
    args.push(id);
    await this.env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  }

  async deleteLink(id) {
    await ensureD1(this.env);
    await this.env.DB.prepare(`DELETE FROM links WHERE id = ?`).bind(id).run();
  }

  async getSettings() {
    await ensureD1(this.env);
    const r = await this.env.DB.prepare(`SELECT key, value FROM settings`).all();
    const out = {};
    for (const row of r.results || []) out[row.key] = row.value;
    return out;
  }

  async setSettings(patch) {
    await ensureD1(this.env);
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const stmts = keys.map((k) =>
      this.env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, String(patch[k])),
    );
    await this.env.DB.batch(stmts);
  }
}

function rowToProto(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    emoji: r.emoji,
    description: r.description,
    tags: r.tags,
    entry: r.entry,
    activeVersion: r.active_version,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    versions: [],
  };
}

function rowToVersion(r) {
  return {
    version: r.version,
    note: r.note,
    size: r.size,
    fileCount: r.file_count,
    entry: r.entry,
    pages: parseJson(r.pages_json, []),
    files: parseJson(r.files_json, []),
    createdAt: r.created_at,
  };
}

function rowToLink(r) {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    emoji: r.emoji,
    description: r.description,
    tags: r.tags,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ---------------------------------- KV ---------------------------------- */

const K_PROTO = 'proto:';
const K_LINKS = 'links';
const K_SETTINGS = 'settings';

class KVStore {
  constructor(env) {
    this.env = env;
    if (!env.KV) throw new Error('缺少 KV 绑定：请在 Pages 项目中绑定 KV namespace（binding 名称必须为 KV）');
  }

  async listPrototypes() {
    const list = await this.env.KV.list({ prefix: K_PROTO });
    const items = await Promise.all(list.keys.map((k) => this.env.KV.get(k.name, 'json')));
    return items.filter(Boolean);
  }

  async getPrototype(id) {
    return this.env.KV.get(K_PROTO + id, 'json');
  }

  async getPrototypeBySlug(slug) {
    const all = await this.listPrototypes();
    return all.find((p) => p.slug === slug) || null;
  }

  async createPrototype(p) {
    await this.env.KV.put(K_PROTO + p.id, JSON.stringify({ ...p, versions: p.versions || [] }));
    return p;
  }

  async updatePrototype(id, patch) {
    const p = await this.getPrototype(id);
    if (!p) return;
    Object.assign(p, patch);
    await this.env.KV.put(K_PROTO + id, JSON.stringify(p));
  }

  async deletePrototype(id) {
    await this.env.KV.delete(K_PROTO + id);
  }

  async putVersion(protoId, v) {
    const p = await this.getPrototype(protoId);
    if (!p) return;
    p.versions = p.versions || [];
    const i = p.versions.findIndex((x) => x.version === v.version);
    if (i >= 0) p.versions[i] = v;
    else p.versions.push(v);
    p.versions.sort((a, b) => b.version - a.version);
    await this.env.KV.put(K_PROTO + protoId, JSON.stringify(p));
  }

  async deleteVersion(protoId, version) {
    const p = await this.getPrototype(protoId);
    if (!p) return;
    p.versions = (p.versions || []).filter((v) => v.version !== Number(version));
    await this.env.KV.put(K_PROTO + protoId, JSON.stringify(p));
  }

  async listLinks() {
    return (await this.env.KV.get(K_LINKS, 'json')) || [];
  }

  async createLink(l) {
    const all = await this.listLinks();
    all.push(l);
    await this.env.KV.put(K_LINKS, JSON.stringify(all));
    return l;
  }

  async updateLink(id, patch) {
    const all = await this.listLinks();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return;
    Object.assign(all[i], patch);
    await this.env.KV.put(K_LINKS, JSON.stringify(all));
  }

  async deleteLink(id) {
    const all = await this.listLinks();
    await this.env.KV.put(K_LINKS, JSON.stringify(all.filter((x) => x.id !== id)));
  }

  async getSettings() {
    return (await this.env.KV.get(K_SETTINGS, 'json')) || {};
  }

  async setSettings(patch) {
    const cur = await this.getSettings();
    await this.env.KV.put(K_SETTINGS, JSON.stringify({ ...cur, ...patch }));
  }
}

/* -------------------------------- 工厂 -------------------------------- */

export function getStore(env) {
  if (env.DB) return new D1Store(env);
  return new KVStore(env);
}

export function backendName(env) {
  return env.DB ? 'd1-sqlite' : 'kv';
}

export { newId };
