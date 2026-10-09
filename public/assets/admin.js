// 管理端：上传（文件夹 / 单文件）、原型与版本管理、链接管理、安全设置

import { api, state, $, $$, toast, escapeHtml, fmtDate, fmtSize, emojiPicker } from './common.js';
import {
  collectFromInput,
  collectFromDataTransfer,
  stripOptions,
  applyStrip,
  pickEntry,
  extractPages,
  upload,
} from './uploader.js';

let mode = 'folder';
let collected = [];
let stripPrefix = '';
let prepared = [];
let singleFile = null;
let protos = [];
let links = [];
let protoEmoji = '🧩';
let linkEmoji = '🔗';

/* --------------------------- 数据加载 --------------------------- */

export async function loadAdminData() {
  const [p, l] = await Promise.all([api('prototypes'), api('links')]);
  protos = p.items || [];
  links = l.items || [];
  renderProtos();
  renderLinks();
  fillProtoSelect();
}

async function refreshAll() {
  await loadAdminData();
  if (window.__refreshHome) await window.__refreshHome();
}

/* --------------------------- 原型与版本 --------------------------- */

function renderProtos() {
  const box = $('#protos-table');
  if (!protos.length) {
    box.innerHTML = `<div class="empty">还没有原型</div>`;
    return;
  }
  box.innerHTML = `<table><thead><tr>
      <th style="width:48px">图标</th><th>名称</th><th>标识</th><th style="width:150px">当前版本</th>
      <th style="width:130px">体积</th><th style="width:130px">更新</th><th style="width:230px">操作</th>
    </tr></thead><tbody>
    ${protos
      .map((p) => {
        const cur = (p.versions || []).find((v) => v.version === p.activeVersion) || (p.versions || [])[0];
        return `<tr data-id="${escapeHtml(p.id)}">
          <td style="font-size:20px">${escapeHtml(p.emoji || '🧩')}</td>
          <td>
            <div style="font-weight:600">${escapeHtml(p.name)}</div>
            <div class="small muted">${escapeHtml(p.description || '')}</div>
          </td>
          <td class="mono small">${escapeHtml(p.kind === 'single' ? '/s/' : '/p/')}${escapeHtml(p.slug)}</td>
          <td>
            <select class="ver-sel">
              ${(p.versions || [])
                .map(
                  (v) =>
                    `<option value="${v.version}" ${v.version === p.activeVersion ? 'selected' : ''}>v${v.version}${v.note ? ' · ' + escapeHtml(v.note) : ''}</option>`,
                )
                .join('')}
            </select>
          </td>
          <td class="small">${fmtSize(cur ? cur.size : 0)}<div class="muted">${cur ? cur.fileCount : 0} 个文件</div></td>
          <td class="small">${fmtDate(p.updatedAt)}</td>
          <td>
            <div class="ops">
              <a class="btn sm" href="${escapeHtml(p.kind === 'single' ? '/s/' + p.slug : '/p/' + p.slug + '/')}" target="_blank" rel="noopener">打开</a>
              <button class="btn sm" data-act="edit">编辑</button>
              <button class="btn sm" data-act="newver">传新版</button>
              <button class="btn sm danger" data-act="delver">删此版</button>
              <button class="btn sm danger" data-act="del">删除</button>
            </div>
          </td>
        </tr>`;
      })
      .join('')}
  </tbody></table>`;
}

$('#protos-table') &&
  $('#protos-table').addEventListener('change', async (e) => {
    const sel = e.target.closest('.ver-sel');
    if (!sel) return;
    const id = sel.closest('tr').dataset.id;
    try {
      await api(`prototypes/${id}`, { method: 'PATCH', body: { activeVersion: Number(sel.value) } });
      toast('已切换版本', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

$('#protos-table') &&
  $('#protos-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const p = protos.find((x) => x.id === id);
    if (!p) return;
    const act = btn.dataset.act;

    if (act === 'newver') {
      switchTab('upload');
      $('#f-proto').value = id;
      $('#f-name').value = p.name;
      $('#f-slug').value = p.slug;
      protoEmoji = p.emoji || '🧩';
      $('#f-emoji').value = protoEmoji;
      $('#f-note').focus();
      return;
    }
    if (act === 'delver') {
      const v = Number(btn.closest('tr').querySelector('.ver-sel').value);
      if (!confirm(`删除 ${p.name} 的 v${v}？该版本文件将从 R2 中移除。`)) return;
      try {
        await api(`prototypes/${id}/versions/${v}`, { method: 'DELETE' });
        toast('版本已删除', 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (act === 'del') {
      if (!confirm(`删除原型「${p.name}」及其全部版本？此操作不可恢复。`)) return;
      try {
        await api(`prototypes/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (act === 'edit') {
      const name = prompt('名称', p.name);
      if (name === null) return;
      const emoji = prompt('Emoji 图标', p.emoji || '🧩');
      const desc = prompt('描述 / 标签（参与搜索）', p.description || '');
      try {
        await api(`prototypes/${id}`, {
          method: 'PATCH',
          body: {
            name: name || p.name,
            emoji: emoji || p.emoji || '🧩',
            description: desc === null ? p.description : desc,
          },
        });
        toast('已保存', 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

/* --------------------------- 链接管理 --------------------------- */

function renderLinks() {
  const box = $('#links-table');
  if (!links.length) {
    box.innerHTML = `<div class="empty">暂无链接</div>`;
    return;
  }
  box.innerHTML = `<table><thead><tr>
      <th style="width:48px">图标</th><th>名称</th><th>地址</th><th style="width:150px">操作</th>
    </tr></thead><tbody>
    ${links
      .map(
        (l) => `<tr data-id="${escapeHtml(l.id)}">
          <td style="font-size:20px">${escapeHtml(l.emoji || '🔗')}</td>
          <td><div style="font-weight:600">${escapeHtml(l.name)}</div><div class="small muted">${escapeHtml(l.description || '')}</div></td>
          <td class="small"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></td>
          <td><div class="ops">
            <button class="btn sm" data-act="up">↑</button>
            <button class="btn sm" data-act="down">↓</button>
            <button class="btn sm" data-act="edit">编辑</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div></td>
        </tr>`,
      )
      .join('')}
  </tbody></table>`;
}

async function moveLink(id, dir) {
  const i = links.findIndex((l) => l.id === id);
  const to = i + dir;
  if (i < 0 || to < 0 || to >= links.length) return;
  const order = links.map((l) => l.id);
  [order[i], order[to]] = [order[to], order[i]];
  try {
    await api('links/reorder', { method: 'POST', body: { order } });
    await refreshAll();
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#links-table') &&
  $('#links-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const l = links.find((x) => x.id === id);
    if (!l) return;
    if (btn.dataset.act === 'up') return moveLink(id, -1);
    if (btn.dataset.act === 'down') return moveLink(id, 1);
    if (btn.dataset.act === 'del') {
      if (!confirm(`删除链接「${l.name}」？`)) return;
      try {
        await api(`links/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (btn.dataset.act === 'edit') {
      const name = prompt('名称', l.name);
      if (name === null) return;
      const url = prompt('地址', l.url);
      const emoji = prompt('Emoji 图标', l.emoji || '🔗');
      const desc = prompt('描述 / 标签', l.description || '');
      try {
        await api(`links/${id}`, {
          method: 'PATCH',
          body: {
            name: name || l.name,
            url: url || l.url,
            emoji: emoji || l.emoji || '🔗',
            description: desc === null ? l.description : desc,
          },
        });
        toast('已保存', 'ok');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

/* --------------------------- 上传 --------------------------- */

function fillProtoSelect() {
  const sel = $('#f-proto');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML =
    `<option value="">（新建原型）</option>` +
    protos.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${escapeHtml(p.slug)}）</option>`).join('');
  if (cur) sel.value = cur;
}

function renderFolderSummary() {
  const box = $('#folder-summary');
  if (!collected.length) {
    box.innerHTML = '';
    return;
  }
  const opts = stripOptions(collected);
  const total = prepared.reduce((a, f) => a + f.size, 0);
  const entry = pickEntry(prepared);
  box.innerHTML = `
    <div class="field" style="max-width:520px">
      <label>路径剥离（去掉外层目录，使 index.html 位于根目录）</label>
      <select id="strip-sel">
        ${opts
          .map((o) => `<option value="${escapeHtml(o.prefix)}" ${o.prefix === stripPrefix ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
          .join('')}
      </select>
    </div>
    <div class="kv">
      <span>文件数：<b>${prepared.length}</b></span>
      <span>总大小：<b>${fmtSize(total)}</b></span>
      <span>入口：<b class="mono">${escapeHtml(entry || '未找到 index.html')}</b></span>
    </div>
    <div class="file-preview">${prepared.slice(0, 40).map((f) => `<div>${escapeHtml(f.path)}</div>`).join('')}${
      prepared.length > 40 ? `<div>… 其余 ${prepared.length - 40} 个文件</div>` : ''
    }</div>`;

  const sel = $('#strip-sel');
  sel.addEventListener('change', () => {
    stripPrefix = sel.value;
    recalc();
    renderFolderSummary();
  });
}

function recalc() {
  prepared = applyStrip(collected, stripPrefix);
}

function renderSingleSummary() {
  const box = $('#single-summary');
  box.innerHTML = singleFile
    ? `<div class="kv"><span>文件：<b>${escapeHtml(singleFile.name)}</b></span><span>大小：<b>${fmtSize(singleFile.size)}</b></span></div>`
    : '';
}

function setMode(m) {
  mode = m;
  $$('#mode-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m));
  $('#mode-folder').classList.toggle('hidden', m !== 'folder');
  $('#mode-single').classList.toggle('hidden', m !== 'single');
}

function switchTab(name) {
  $$('#admin-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['upload', 'protos', 'links', 'settings'].forEach((n) => $(`#tab-${n}`).classList.toggle('hidden', n !== name));
}

function guessName() {
  if (mode === 'single' && singleFile) return singleFile.name.replace(/\.html?$/i, '');
  if (stripPrefix) return stripPrefix.split('/').filter(Boolean).pop() || '';
  return collected[0] ? collected[0].raw.split('/')[0] : '';
}

async function doUpload() {
  const btn = $('#btn-upload');
  const files =
    mode === 'folder'
      ? prepared
      : singleFile
        ? [{ path: 'index.html', size: singleFile.size, file: singleFile }]
        : [];
  if (!files.length) return toast('请先选择要上传的文件', 'err');

  const entry = mode === 'single' ? 'index.html' : pickEntry(files);
  if (!entry) return toast('未找到入口 HTML 文件（index.html）', 'err');

  const name = $('#f-name').value.trim() || guessName() || '未命名原型';
  const meta = {
    name,
    slug: $('#f-slug').value.trim(),
    emoji: protoEmoji,
    description: $('#f-desc').value.trim(),
    tags: $('#f-desc').value.trim(),
    note: $('#f-note').value.trim(),
    kind: mode === 'single' ? 'single' : 'folder',
    entry,
    protoId: $('#f-proto').value || undefined,
  };

  btn.disabled = true;
  const prog = $('#up-progress');
  const text = $('#up-text');
  prog.classList.remove('hidden');
  text.classList.remove('hidden');

  try {
    let pages = [];
    if (mode === 'folder') {
      text.textContent = '正在解析页面结构…';
      pages = await extractPages(files);
    }
    await upload({
      files,
      meta: { ...meta, pages },
      onProgress: ({ phase, done, total, bytes, totalBytes }) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        prog.firstElementChild.style.width = `${pct}%`;
        text.textContent =
          phase === 'finish'
            ? '正在合并分片并写入索引…'
            : `上传分片 ${done}/${total}（${pct}%）· ${fmtSize(bytes)} / ${fmtSize(totalBytes)}`;
      },
    });
    prog.firstElementChild.style.width = '100%';
    text.textContent = `完成：${files.length} 个文件已发布`;
    toast('上传成功', 'ok');
    $('#f-note').value = '';
    await refreshAll();
  } catch (err) {
    toast(err.message || '上传失败', 'err');
    text.textContent = `失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/* --------------------------- 初始化 --------------------------- */

export function initAdmin() {
  // tabs
  $('#admin-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    switchTab(t.dataset.tab);
    if (t.dataset.tab !== 'upload') loadAdminData();
  });
  $('#mode-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) setMode(t.dataset.mode);
  });

  // emoji
  protoEmoji = '🧩';
  $('#f-emoji-picker').appendChild(
    emojiPicker('🧩', (e) => {
      protoEmoji = e;
      $('#f-emoji').value = e;
    }),
  );
  $('#f-emoji').addEventListener('input', (e) => {
    protoEmoji = e.target.value.trim() || '🧩';
  });
  $('#l-emoji-picker').appendChild(
    emojiPicker('🔗', (e) => {
      linkEmoji = e;
      $('#l-emoji').value = e;
    }),
  );
  $('#l-emoji').addEventListener('input', (e) => {
    linkEmoji = e.target.value.trim() || '🔗';
  });

  // 文件夹选择
  const folderDz = $('#folder-dz');
  const folderInput = $('#folder-input');
  folderDz.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    collected = collectFromInput(folderInput.files);
    const opts = stripOptions(collected);
    stripPrefix = opts.length ? opts[0].prefix : '';
    recalc();
    renderFolderSummary();
    if (!$('#f-name').value) $('#f-name').value = guessName();
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    folderDz.addEventListener(ev, (e) => {
      e.preventDefault();
      folderDz.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    folderDz.addEventListener(ev, () => folderDz.classList.remove('over')),
  );
  folderDz.addEventListener('drop', async (e) => {
    e.preventDefault();
    collected = await collectFromDataTransfer(e.dataTransfer);
    const opts = stripOptions(collected);
    stripPrefix = opts.length ? opts[0].prefix : '';
    recalc();
    renderFolderSummary();
    if (!$('#f-name').value) $('#f-name').value = guessName();
  });

  // 单文件选择
  const singleDz = $('#single-dz');
  const singleInput = $('#single-input');
  singleDz.addEventListener('click', () => singleInput.click());
  singleInput.addEventListener('change', () => {
    singleFile = singleInput.files[0] || null;
    renderSingleSummary();
    if (singleFile && !$('#f-name').value) $('#f-name').value = guessName();
  });
  singleDz.addEventListener('dragover', (e) => e.preventDefault());
  singleDz.addEventListener('drop', (e) => {
    e.preventDefault();
    singleFile = e.dataTransfer.files[0] || null;
    renderSingleSummary();
    if (singleFile && !$('#f-name').value) $('#f-name').value = guessName();
  });

  $('#btn-clear-files').addEventListener('click', () => {
    collected = [];
    prepared = [];
    singleFile = null;
    folderInput.value = '';
    singleInput.value = '';
    renderFolderSummary();
    renderSingleSummary();
  });

  $('#btn-upload').addEventListener('click', doUpload);

  // 链接
  $('#btn-add-link').addEventListener('click', async () => {
    const name = $('#l-name').value.trim();
    const url = $('#l-url').value.trim();
    if (!name || !url) return toast('名称与地址不能为空', 'err');
    try {
      await api('links', {
        method: 'POST',
        body: { name, url, emoji: linkEmoji, description: $('#l-desc').value.trim(), tags: $('#l-desc').value.trim() },
      });
      $('#l-name').value = '';
      $('#l-url').value = '';
      $('#l-desc').value = '';
      toast('已添加', 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // 设置
  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      const body = {};
      const s = $('#s-site').value;
      const a = $('#s-admin').value;
      if (s) body.SITE_PASSWORD = s;
      if (a) body.ADMIN_PASSWORD = a;
      if (!Object.keys(body).length && !confirm('留空表示不修改任何密码，继续？')) return;
      await api('settings', { method: 'POST', body });
      toast('已保存（若环境变量已设置则以环境变量为准）', 'ok');
      const info = await api('settings');
      renderRuntime(info);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function renderRuntime(info) {
  const el = $('#runtime-info');
  if (!el) return;
  el.innerHTML = `
    <div>存储后端：<b>${escapeHtml(info.backend === 'd1-sqlite' ? 'D1 (SQLite)' : 'KV')}</b></div>
    <div>全站密码：${info.hasSitePassword ? '已启用' : '<b style="color:#e2483d">未启用</b>'}${info.siteFromEnv ? '（来自环境变量）' : ''}</div>
    <div>管理员密码：${info.hasAdminPassword ? '已启用' : '<b style="color:#e2483d">未启用</b>'}${info.adminFromEnv ? '（来自环境变量）' : ''}</div>
    <div>分片大小：${fmtSize(info.shardSize)}</div>
    <div style="margin-top:8px">当前身份：${escapeHtml(state.me ? state.me.role : '-')}${state.me && state.me.isAdmin ? '（管理员）' : ''}</div>`;
}

export async function initSettings() {
  try {
    const info = await api('settings');
    renderRuntime(info);
  } catch {
    /* 非管理员时忽略 */
  }
}
