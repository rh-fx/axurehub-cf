// 应用入口：会话引导 + 路由（#/home, #/admin）

import { loadSession, loadIndex, state, api, $, escapeHtml } from './common.js';
import { initHome, renderHome, buildSearchIndex, refreshIndex } from './home.js';
import { initAdmin, loadAdminData, initSettings } from './admin.js';

function showView(name) {
  $('#view-home').classList.toggle('hidden', name !== 'home');
  $('#view-admin').classList.toggle('hidden', name !== 'admin');
  $('#search-input').disabled = name !== 'home';
}

async function go() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash === 'admin') {
    showView('admin');
    try {
      await loadAdminData();
    } catch (e) {
      /* 非管理员 */
    }
  } else {
    showView('home');
  }
}

function renderBanner() {
  const me = state.me || {};
  const warns = [];
  if (!me.needSitePassword) warns.push('未启用全站访问密码，任何人都可以浏览该站点');
  if (!me.needAdminPassword) warns.push('未启用管理员密码，所有访客都拥有管理权限');
  const el = $('#banner');
  if (!warns.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `⚠️ ${warns.map(escapeHtml).join('；')}。可在「管理 → 设置」中配置，或设置环境变量 SITE_PASSWORD / ADMIN_PASSWORD。`;
}

async function boot() {
  const me = await loadSession();
  if (!me.authed && me.needSitePassword) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    return;
  }

  await loadIndex();
  buildSearchIndex();
  renderHome();
  initHome();
  initAdmin();
  initSettings();
  window.__refreshHome = refreshIndex;

  $('#btn-admin').classList.toggle('hidden', !me.isAdmin);
  renderBanner();

  $('#btn-admin').addEventListener('click', () => {
    location.hash = location.hash === '#/admin' ? '#/home' : '#/admin';
  });
  $('#btn-logout').addEventListener('click', async () => {
    await api('auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  window.addEventListener('hashchange', go);
  await go();
}

boot().catch((e) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="banner">初始化失败：${escapeHtml(e.message || String(e))}</div>`,
  );
});
