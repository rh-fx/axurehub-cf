// 前端公共工具：API 封装、会话状态、DOM 与格式化辅助

export const state = {
  me: null,        // { authed, role, isAdmin, needSitePassword, needAdminPassword, backend }
  index: null,     // 搜索索引 { prototypes: [], links: [] }
  ready: false,
};

export async function api(path, { method = 'GET', body, headers, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(`/api/${path.replace(/^\//, '')}`, init);
  if (res.status === 401) {
    const back = location.pathname + location.search + location.hash;
    location.href = `/login.html?next=${encodeURIComponent(back)}`;
    throw new Error('未登录');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || `HTTP ${res.status}` };
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return raw ? res : data;
}

export async function loadSession() {
  state.me = await api('auth/me');
  return state.me;
}

export async function loadIndex(force = false) {
  if (state.index && !force) return state.index;
  state.index = await api('index');
  return state.index;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 高亮片段（已转义的文本中插入 <mark>） */
export function highlight(text, tokens) {
  let out = escapeHtml(text || '');
  if (!tokens || !tokens.length) return out;
  const esc = tokens.map((t) => escapeHtml(t)).filter(Boolean);
  if (!esc.length) return out;
  const re = new RegExp(`(${esc.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return out.replace(re, '<mark>$1</mark>');
}

export function toast(message, kind = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = `toast-item ${kind}`;
  item.textContent = message;
  box.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    setTimeout(() => item.remove(), 220);
  }, kind === 'err' ? 4200 : 2400);
}

export function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function on(el, ev, fn) {
  el && el.addEventListener(ev, fn);
  return el;
}

export const EMOJIS = [
  '🧩', '🚀', '📱', '💻', '🖥️', '🎨', '📊', '📈', '🛒', '🔐',
  '📝', '🎯', '🧪', '🌐', '📦', '🔗', '⭐', '🏠', '📄', '🔧',
  '🎬', '🧭', '💡', '🏷️', '⚙️', '📚', '🧰', '🗂️', '🛠️', '✅',
];

export function emojiPicker(current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'emoji-picker';
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    if (e === current) b.className = 'sel';
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      onPick(e);
    });
    wrap.appendChild(b);
  });
  return wrap;
}
