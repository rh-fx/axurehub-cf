// 浏览器端上传引擎
//
// 1) 路径剥离：webkitRelativePath 形如 "我的原型/index.html"，需要去掉最外层目录
// 2) 分包打包：小文件合并进同一片、大文件按 SEG 切片，使每个请求体远小于
//    Cloudflare Worker 的请求体上限，从而支持整个 Axure 文件夹一次性上传
// 3) 并发上传：默认 4 路并发，失败自动重试

import { api } from './common.js';

const DEFAULT_SEG = 4 * 1024 * 1024; // 与服务端 SHARD_SIZE 默认值保持一致

/* --------------------------- 文件收集 --------------------------- */

/** <input webkitdirectory> 选择结果 */
export function collectFromInput(fileList) {
  const out = [];
  for (const file of Array.from(fileList || [])) {
    const raw = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    out.push({ raw, file });
  }
  return out;
}

/** 拖拽目录/文件 */
export async function collectFromDataTransfer(dt) {
  const items = Array.from(dt.items || []);
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) {
    return Array.from(dt.files || []).map((file) => ({ raw: file.name, file }));
  }
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ raw: prefix + file.name, file });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const childPrefix = `${prefix}${entry.name}/`;
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await walk(e, childPrefix);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/* --------------------------- 路径剥离 --------------------------- */

/** 找出所有「含有 index.html 的目录」作为候选根 */
export function detectRoots(collected) {
  const set = new Set();
  for (const f of collected) {
    const segs = f.raw.split('/');
    for (let i = 0; i < segs.length; i++) {
      if (/^index\.html?$/i.test(segs[i])) set.add(segs.slice(0, i).join('/'));
    }
  }
  return [...set].sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length);
}

/** 生成剥离选项（供下拉框） */
export function stripOptions(collected) {
  const opts = [];
  const first = collected[0];
  const top = first ? first.raw.split('/')[0] : '';
  if (collected.some((f) => f.raw.includes('/'))) {
    opts.push({ label: `自动：去掉最外层目录「${top}」`, prefix: top });
  }
  for (const r of detectRoots(collected)) {
    if (r && r !== top) opts.push({ label: `剥离到「${r}」`, prefix: r });
  }
  opts.push({ label: '不剥离（保留原始相对路径）', prefix: '' });
  const seen = new Set();
  return opts.filter((o) => !seen.has(o.prefix) && seen.add(o.prefix));
}

export function applyStrip(collected, prefix) {
  const p = prefix ? `${prefix}/` : '';
  const out = [];
  for (const f of collected) {
    if (p && !f.raw.startsWith(p)) continue;
    const path = p ? f.raw.slice(p.length) : f.raw;
    if (!path || path.endsWith('/')) continue;
    if (/(^|\/)\.(DS_Store|gitkeep)$/i.test(path)) continue;
    out.push({ path, size: f.file.size, file: f.file });
  }
  return out;
}

export function pickEntry(files) {
  const names = files.map((f) => f.path.toLowerCase());
  for (const c of ['index.html', 'index.htm', 'start.html', 'start_c_1.html']) {
    const i = names.indexOf(c);
    if (i >= 0) return files[i].path;
  }
  const html = files.find((f) => /^[^/]+\.html?$/i.test(f.path) && !/^(resources|data|files|plugins)/i.test(f.path));
  return html ? html.path : files[0] ? files[0].path : null;
}

/* --------------------- Axure 页面名提取（尽力而为） --------------------- */

async function readText(file, maxBytes) {
  if (file.size > maxBytes) return '';
  return await file.text();
}

function uniqPages(list, validPaths) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || !p.name) continue;
    const url = validPaths.has(String(p.url).toLowerCase()) ? p.url : null;
    const key = `${p.name}|${url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url ? { name: p.name, url } : { name: p.name, url: 'index.html' });
  }
  return out.slice(0, 300);
}

/**
 * 提取 Axure 原型页面列表。
 * 策略 1：解析 data/document.js 中的 sitemap / pageNames（RP8/9/10 通用启发式）
 * 策略 2：读取根目录各 HTML 的 <title>
 */
export async function extractPages(files) {
  const valid = new Set(files.map((f) => f.path.toLowerCase()));
  const doc = files.find((f) => /^data\/document\.js$/i.test(f.path));

  if (doc) {
    const text = await readText(doc.file, 8 * 1024 * 1024);
    if (text) {
      // 1a. {"pageName":"home","name":"首页", ...} 形式的 sitemap 节点
      const found = [];
      const re = /\{[^{}]*"pageName"\s*:\s*"([^"]+)"[^{}]*\}/g;
      let m;
      while ((m = re.exec(text)) && found.length < 400) {
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.pageName) {
            found.push({ name: obj.name || obj.pageName, url: `${obj.pageName}.html` });
          }
        } catch {
          /* 忽略非严格 JSON 片段 */
        }
      }
      // 1b. "pageNames": {"home":"首页"} 映射表
      if (!found.length) {
        const pm = /"pageNames"\s*:\s*\{([\s\S]{0,20000}?)\}/.exec(text);
        if (pm) {
          const pairs = [...pm[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)];
          for (const [, url, name] of pairs) found.push({ name: name || url, url: `${url.replace(/\.html?$/i, '')}.html` });
        }
      }
      const pages = uniqPages(found, valid);
      if (pages.length) return pages;
    }
  }

  // 策略 2：根目录 HTML 的 <title>
  const found = [];
  const htmls = files
    .filter((f) => /^[^/]+\.html?$/i.test(f.path) && !/^(index|start)/i.test(f.path))
    .slice(0, 80);
  for (const f of htmls) {
    const text = await readText(f.file, 512 * 1024);
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text || '');
    found.push({ name: (t ? t[1] : f.path).trim().slice(0, 80) || f.path, url: f.path });
  }
  return uniqPages(found, valid);
}

/* --------------------------- 分包打包 --------------------------- */

export function packShards(files, limit = DEFAULT_SEG) {
  const shards = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.parts.length) shards.push(cur);
    cur = null;
  };
  files.forEach((f, i) => {
    if (f.size > limit) {
      flush();
      const total = Math.ceil(f.size / limit);
      let seq = 0;
      for (let off = 0; off < f.size; off += limit) {
        const size = Math.min(limit, f.size - off);
        shards.push({
          parts: [{ path: f.path, size, blob: f.file.slice(off, off + size), fileIndex: i, seq: seq++, total }],
          bytes: size,
        });
      }
      return;
    }
    if (!cur) cur = { parts: [], bytes: 0 };
    if (cur.parts.length && cur.bytes + f.size > limit) flush();
    if (!cur) cur = { parts: [], bytes: 0 };
    cur.parts.push({ path: f.path, size: f.size, blob: f.file, fileIndex: i, seq: 0, total: 1 });
    cur.bytes += f.size;
  });
  flush();
  shards.forEach((s, i) => (s.index = i));
  return shards;
}

function buildShardBlob(uploadId, shard) {
  const manifest = {
    u: uploadId,
    i: shard.index,
    f: shard.parts.map((p) => ({ p: p.path, l: p.size, i: p.fileIndex, s: p.seq, t: p.total })),
  };
  const mBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, mBytes.length);
  return new Blob([header, mBytes, ...shard.parts.map((p) => p.blob)]);
}

/* --------------------------- 上传流程 --------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function putShard(uploadId, shard, attempts = 3) {
  const blob = buildShardBlob(uploadId, shard);
  let lastErr;
  for (let n = 0; n < attempts; n++) {
    try {
      const res = await fetch(`/api/upload/shard?uploadId=${encodeURIComponent(uploadId)}&index=${shard.index}`, {
        method: 'POST',
        body: blob,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await res.json();
      return;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (n + 1));
    }
  }
  throw lastErr;
}

/**
 * 完整上传流程：init -> 并发分片 -> complete
 * @param {object} p
 * @param {Array}  p.files  [{path, size, file}]
 * @param {object} p.meta   {name, slug, emoji, description, tags, note, kind, entry, pages, protoId, replaceVersion}
 * @param {Function} p.onProgress ({phase, done, total, bytes, totalBytes})
 */
export async function upload({ files, meta, onProgress = () => {}, concurrency = 4 }) {
  if (!files.length) throw new Error('没有待上传文件');
  const emit = (o) => onProgress(o);

  let seg = DEFAULT_SEG;
  let shards = packShards(files, seg);

  const init = await api('upload/init', {
    method: 'POST',
    body: {
      ...meta,
      totalShards: shards.length,
      files: files.map((f) => ({ path: f.path, size: f.size })),
    },
  });

  if (init.shardSize && init.shardSize !== seg) {
    seg = init.shardSize;
    shards = packShards(files, seg);
    // 分片数变化不影响服务端校验（服务端只在已收片数不足时报错）
  }

  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  let done = 0;
  let bytes = 0;
  const queue = shards.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, shards.length || 1)) }, async () => {
    while (queue.length) {
      const shard = queue.shift();
      if (!shard) return;
      await putShard(init.uploadId, shard);
      done += 1;
      bytes += shard.bytes;
      emit({ phase: 'upload', done, total: shards.length, bytes, totalBytes });
    }
  });

  emit({ phase: 'upload', done: 0, total: shards.length, bytes: 0, totalBytes });
  await Promise.all(workers);
  emit({ phase: 'finish', done, total: shards.length, bytes, totalBytes });

  return api('upload/complete', { method: 'POST', body: { uploadId: init.uploadId } });
}
