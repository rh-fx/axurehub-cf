// 首页：原型卡片墙 + 外部链接导航 + 毫秒级实时搜索

import { state, escapeHtml, highlight, fmtDate, fmtSize, $, $$, api, toast } from './common.js';

let sortProto = 'updated';
let sortLink = 'custom';
let searchItems = [];

/* ------------------------------ 渲染 ------------------------------ */

function protoUrl(p) {
  return p.kind === 'single' ? `/s/${p.slug}` : `/p/${p.slug}/`;
}

function sortProtos(list) {
  const arr = list.slice();
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  const arr2 = arr.sort((a, b) => {
    if (sortProto === 'name') return byName(a, b);
    if (sortProto === 'created') return b.createdAt - a.createdAt;
    if (sortProto === 'custom') return (a.sortOrder || 0) - (b.sortOrder || 0);
    return b.updatedAt - a.updatedAt;
  });
  return sortProto === 'custom' ? arr2.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || b.updatedAt - a.updatedAt) : arr2;
}

function sortLinks(list) {
  const arr = list.slice();
  if (sortLink === 'name') return arr.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  if (sortLink === 'created') return arr.sort((a, b) => b.createdAt - a.createdAt);
  return arr.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || b.createdAt - a.createdAt);
}

function protoCard(p) {
  const pages = p.pages || [];
  const pageBlock = pages.length
    ? `<details class="pages"><summary class="small muted">页面（${pages.length}）</summary>
        <div class="pagelist">${pages
          .slice(0, 200)
          .map(
            (pg) =>
              `<a href="${escapeHtml(protoUrl(p).replace(/\/?$/, '/') + (pg.url || 'index.html'))}" target="_blank" rel="noopener">📄 ${escapeHtml(pg.name)}</a>`,
          )
          .join('')}</div></details>`
    : '';
  return `<div class="card" data-id="${escapeHtml(p.id)}">
    <div class="card-top">
      <div class="emoji">${escapeHtml(p.emoji || '🧩')}</div>
      <div style="min-width:0">
        <div class="title">${escapeHtml(p.name)}</div>
        <div class="meta">v${p.version || 1} · ${escapeHtml(p.kind === 'single' ? '单文件' : '文件夹')} · 更新于 ${fmtDate(p.updatedAt)}</div>
      </div>
    </div>
    <div class="desc">${escapeHtml(p.description || '—')}</div>
    ${pageBlock}
    <div class="card-actions">
      <a class="btn primary sm" href="${escapeHtml(protoUrl(p))}" target="_blank" rel="noopener">打开原型</a>
      <span class="tag gray mono">${escapeHtml(protoUrl(p))}</span>
    </div>
  </div>`;
}

function linkItem(l) {
  const ops = state.me && state.me.isAdmin
    ? `<div class="li-ops">
         <button class="btn sm" data-link-up="${escapeHtml(l.id)}">↑</button>
         <button class="btn sm" data-link-down="${escapeHtml(l.id)}">↓</button>
         <button class="btn sm danger" data-link-del="${escapeHtml(l.id)}">删除</button>
       </div>`
    : '';
  return `<div class="link-item" data-id="${escapeHtml(l.id)}">
    <div class="emoji">${escapeHtml(l.emoji || '🔗')}</div>
    <div class="li-main">
      <div class="li-name">${escapeHtml(l.name)}</div>
      <div class="li-url">${escapeHtml(l.description ? `${l.description} · ${l.url}` : l.url)}</div>
    </div>
    ${ops}
  </div>`;
}

export function renderHome() {
  const index = state.index || { prototypes: [], links: [] };
  const protos = sortProtos(index.prototypes || []);
  const links = sortLinks(index.links || []);

  const grid = $('#proto-grid');
  grid.innerHTML = protos.length
    ? protos.map(protoCard).join('')
    : `<div class="empty" style="grid-column:1/-1">还没有原型，点击右上角「管理」上传第一个 Axure 原型</div>`;

  const list = $('#link-list');
  list.innerHTML = links.length
    ? links.map(linkItem).join('')
    : `<div class="empty" style="grid-column:1/-1">暂无外部链接</div>`;
}

/* ------------------------------ 搜索 ------------------------------ */

export function buildSearchIndex() {
  const index = state.index || { prototypes: [], links: [] };
  const items = [];
  for (const p of index.prototypes || []) {
    const base = protoUrl(p).replace(/\/?$/, '/');
    items.push({
      kind: '原型',
      emoji: p.emoji || '🧩',
      title: p.name,
      sub: p.description || base,
      url: protoUrl(p),
      external: false,
      hay: `${p.name} ${p.slug} ${p.description} ${p.tags}`.toLowerCase(),
    });
    for (const pg of p.pages || []) {
      items.push({
        kind: '页面',
        emoji: '📄',
        title: pg.name,
        sub: `${p.name} · ${pg.url}`,
        url: base + (pg.url || 'index.html'),
        external: false,
        hay: `${pg.name} ${pg.url} ${p.name} ${p.tags}`.toLowerCase(),
      });
    }
  }
  for (const l of index.links || []) {
    items.push({
      kind: '链接',
      emoji: l.emoji || '🔗',
      title: l.name,
      sub: `${l.description ? l.description + ' · ' : ''}${l.url}`,
      url: l.url,
      external: true,
      hay: `${l.name} ${l.url} ${l.description} ${l.tags}`.toLowerCase(),
    });
  }
  searchItems = items;
  return items;
}

const KIND_ORDER = ['原型', '页面', '链接'];

export function runSearch(q) {
  const t0 = performance.now();
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const box = $('#search-results');
  const panel = $('#search-panel');
  const home = $('#home-panel');
  const stat = $('#search-stat');

  if (!tokens.length) {
    panel.classList.add('hidden');
    home.classList.remove('hidden');
    return;
  }

  const hits = searchItems.filter((it) => tokens.every((t) => it.hay.includes(t)));
  const limited = hits.slice(0, 120);
  const ms = performance.now() - t0;

  home.classList.add('hidden');
  panel.classList.remove('hidden');
  stat.textContent = `“${q}” 命中 ${hits.length} 条，耗时 ${ms.toFixed(2)} ms`;

  if (!hits.length) {
    box.innerHTML = `<div class="empty">没有匹配结果</div>`;
    return;
  }

  const groups = KIND_ORDER.map((k) => ({ k, list: limited.filter((x) => x.kind === k) })).filter((g) => g.list.length);
  const rows = groups.flatMap((g) => g.list);
  box.innerHTML = groups
    .map(
      (g) => `<div class="result-group">
        <h3>${g.k}（${g.list.length}）</h3>
        ${g.list
          .map(
            (it) => `<div class="result-item" data-idx="${rows.indexOf(it)}">
              <div class="emoji">${escapeHtml(it.emoji)}</div>
              <div class="ri-main">
                <div class="ri-title">${highlight(it.title, tokens)}</div>
                <div class="ri-sub">${highlight(it.sub, tokens)}</div>
              </div>
              <span class="tag gray">${it.kind}</span>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');

  $$('.result-item', box).forEach((el) => {
    const it = rows[Number(el.dataset.idx)];
    if (!it) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      window.open(it.url, '_blank', it.external ? 'noopener' : '');
    });
  });
}

/* ------------------------------ 绑定 ------------------------------ */

export function initHome() {
  const input = $('#search-input');

  let raf = 0;
  input.addEventListener('input', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => runSearch(input.value.trim()));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      runSearch('');
      input.blur();
    }
    if (e.key === 'Enter') {
      const first = $('.result-item');
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  $('#proto-sort').addEventListener('change', (e) => {
    sortProto = e.target.value;
    renderHome();
  });
  $('#link-sort').addEventListener('change', (e) => {
    sortLink = e.target.value;
    renderHome();
  });

  $('#link-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const links = sortLinks((state.index.links || []).slice());
    const idx = links.findIndex((l) => l.id === (btn.dataset.linkUp || btn.dataset.linkDown || btn.dataset.linkDel));
    if (idx < 0) return;
    if (btn.dataset.linkDel) {
      if (!confirm(`删除链接「${links[idx].name}」？`)) return;
      try {
        await api(`links/${links[idx].id}`, { method: 'DELETE' });
        await refreshIndex();
        toast('已删除', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    const dir = btn.dataset.linkUp ? -1 : 1;
    const to = idx + dir;
    if (to < 0 || to >= links.length) return;
    const order = links.map((l) => l.id);
    [order[idx], order[to]] = [order[to], order[idx]];
    try {
      await api('links/reorder', { method: 'POST', body: { order } });
      await refreshIndex();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

export async function refreshIndex() {
  const { loadIndex } = await import('./common.js');
  state.index = await loadIndex(true);
  buildSearchIndex();
  renderHome();
}
