/* ===== app.js — 启动 / 路由 / 框架 ===== */
window.App = window.App || {};
App.app = (function () {
  const U = () => App.ui;
  let appEl, view, headerDomainBtn, navItems, systemBound = false, systemPlusBound = false, systemVisibilityBound = false;
  let systemTimer = null, lastSystemDark = null;

  // ===== 跟随系统 =====
  // 系统深浅变了 → 只有外观模式为「跟随系统」时才重新解析并落地主题。
  // darkOverride：事件（媒体查询）已经拿到新值时直接传进来，省一次探测、也不会被旧值覆盖。
  function applySystemThemeIfAuto(darkOverride) {
    // 存储尚未就绪（首次启动、db 异常）时直接跳过，避免轮询把异常抛到控制台
    const s = (App.state && App.state.data && App.state.data.settings) || null;
    if (!s) return false;
    if ((s.appearance || 'auto') !== 'auto') return false;
    App.themes.applyFromSettings(s, darkOverride);
    syncStatusBar();
    return true;
  }

  function bindSystemTheme() {
    if (systemBound) return;
    systemBound = true;
    lastSystemDark = App.themes.systemIsDark(true);

    // 统一的一次「复查」：系统深浅变了才重新落地主题，没变立刻返回（轮询/事件共用）
    // force=true 同时意味着「绕过主题模块的探测缓存」，plusready 首次校准必须用它
    function checkNow(force, override) {
      const now = (typeof override === 'boolean') ? override : App.themes.systemIsDark(force);
      if (!force && now === lastSystemDark) return;
      lastSystemDark = now;
      applySystemThemeIfAuto(now);
    }

    // ① 标准做法：媒体查询 change 事件（桌面浏览器、较新的 WebView 都会派发）
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e) => { checkNow(true, e && typeof e.matches === 'boolean' ? e.matches : undefined); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
    // ② 兜底轮询：安卓 WebView 在系统切深浅色时经常既不更新取值也不派发 change，
    //    只靠事件会出现「选了跟随系统却纹丝不动」。每 0.8s 复查一次，没变化就立刻返回。
    if (systemTimer) clearInterval(systemTimer);
    systemTimer = setInterval(() => checkNow(false), 800);
    // ③ 回到前台立即复查：用户在系统设置里切完深浅色、直接切回 App 时，
    //    不必再等下一个轮询周期，观感上就是「立刻跟着变」。
    if (!systemVisibilityBound) {
      systemVisibilityBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkNow(false);
      }, false);
      // 5+ 从后台恢复（真机上页面可能并未触发 visibilitychange）
      document.addEventListener('resume', () => { checkNow(false); syncStatusBar(); }, false);
      // 窗口重新获得焦点（切回来 / 从系统设置返回）也立刻复查一次
      window.addEventListener('focus', () => checkNow(false), false);
      window.addEventListener('pageshow', () => checkNow(false), false);
    }
    // ④ 5+ 环境：plus 注入后才能拿到 getUIStyle / 设置状态栏，plusready 时校准一次
    if (!systemPlusBound) {
      systemPlusBound = true;
      const onPlus = () => {
        checkNow(true);          // 强制校准：注入前用媒体查询算出的值可能不准
        syncStatusBar();
      };
      if (window.plus) onPlus();
      else document.addEventListener('plusready', onPlus, false);
    }
  }

  // ===== 原生状态栏配色（直接改色，非沉浸式透明）=====
  // 要求：状态栏底色 = 顶部标题栏（GoJo 那栏）的底色，文字按深浅自动转黑/白。
  // 顶栏用的是 --bg-alpha（页面底色的半透明版）配磨砂，而状态栏必须是实色，
  // 所以把「顶栏色 × alpha」叠到「页面底色」上合成出等价的不透明色。
  function cssColorToRgba(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
      if (p.length >= 3 && !p.slice(0, 3).some(isNaN)) {
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && !isNaN(p[3]) ? p[3] : 1 };
      }
      return null;
    }
    if (s.charAt(0) === '#') {
      const c = s.slice(1);
      const h = c.length === 3 ? c.charAt(0) + c.charAt(0) + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2) : c.slice(0, 6);
      if (h.length === 6) {
        const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
        if (![r, g, b].some(isNaN)) return { r: r, g: g, b: b, a: 1 };
      }
    }
    return null;
  }
  function topbarSolidColor() {
    let base = { r: 21, g: 23, b: 28, a: 1 };
    let layer = null;
    try {
      const cs = getComputedStyle(document.documentElement);
      base = cssColorToRgba(cs.getPropertyValue('--bg')) || base;
      const header = document.querySelector('.app-header');
      if (header) layer = cssColorToRgba(getComputedStyle(header).backgroundColor);
      if (!layer) layer = cssColorToRgba(cs.getPropertyValue('--bg-alpha'));
    } catch (e) {}
    if (!layer) return base;
    const a = Math.max(0, Math.min(1, layer.a));
    return {
      r: layer.r * a + base.r * (1 - a),
      g: layer.g * a + base.g * (1 - a),
      b: layer.b * a + base.b * (1 - a),
      a: 1,
    };
  }
  function hex2(v) { const n = Math.max(0, Math.min(255, Math.round(v))); return (n < 16 ? '0' : '') + n.toString(16); }

  // plus 是异步注入的：boot 时通常还没就绪，早期一次 setStatusBarBackground 会被
  // 直接跳过 —— 真机表现就是「启动后状态栏还是系统原色，要等切一次主题才对」。
  // 这里把最近一次要下发的颜色暂存，plusready 后补发，保证首帧也对齐。
  let pendingBar = null;

  function pushStatusBar(hex, style) {
    const plus = window.plus;
    if (!plus || !plus.navigator) { pendingBar = { hex: hex, style: style }; return false; }
    pendingBar = null;
    // 先铺底色，再定文字明暗（部分机型顺序反过来会让文字色被系统覆盖）
    try { if (typeof plus.navigator.setStatusBarBackground === 'function') plus.navigator.setStatusBarBackground(hex); } catch (e) {}
    try { if (typeof plus.navigator.setStatusBarStyle === 'function') plus.navigator.setStatusBarStyle(style); } catch (e) {}
    // 个别安卓机型首次调用不生效（拿不到 Activity 装饰视图），隔一帧再补一次
    setTimeout(() => {
      try { if (typeof plus.navigator.setStatusBarBackground === 'function') plus.navigator.setStatusBarBackground(hex); } catch (e) {}
      try { if (typeof plus.navigator.setStatusBarStyle === 'function') plus.navigator.setStatusBarStyle(style); } catch (e) {}
    }, 80);
    return true;
  }

  function syncStatusBar() {
    let solid;
    try { solid = topbarSolidColor(); } catch (e) { return; }
    const hex = '#' + hex2(solid.r) + hex2(solid.g) + hex2(solid.b);
    // 部分壳子（含浏览器地址栏）用 theme-color 决定状态栏/工具栏颜色，一并同步
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', hex);
    } catch (e) {}
    // 亮度决定文字色：浅底用 dark（深色字），深底用 light（浅色字）
    const lum = (0.299 * solid.r + 0.587 * solid.g + 0.114 * solid.b) / 255;
    pushStatusBar(hex, lum < 0.55 ? 'light' : 'dark');
  }

  // plusready 补发：注册一次即可，早于 plus 注入的所有配色请求都会在这里落地
  document.addEventListener('plusready', () => {
    if (pendingBar) pushStatusBar(pendingBar.hex, pendingBar.style);
    else syncStatusBar();
    applySafeTop();   // 状态栏就绪后才能判断是不是沉浸式
  }, false);

  function applyFontScale() {
    const map = { small: 0.875, standard: 1, large: 1.15, xlarge: 1.3 };
    const k = (App.state.data.settings.fontScaleKey) || 'standard';
    const v = map[k] || 1;
    document.documentElement.style.setProperty('--font-scale', String(v));
  }

  // ===== 顶部安全区（修掉「GoJo 标题上方多出一大块空白」）=====
  // 顶栏原来的 padding-top 直接用了 env(safe-area-inset-top)。可很多安卓机（尤其
  // 非刘海屏 + 非沉浸式状态栏）里这个值仍然会给出状态栏高度，而 WebView 本身已经
  // 在状态栏下方了 —— 于是顶栏上方被顶出一整行空白。
  // 现在直接问原生：状态栏非沉浸式 → 就是 0；沉浸式 → 取状态栏真实高度。
  // 拿不到原生 API 时（浏览器预览）保持 CSS 的 env() 兜底，行为不变。
  function applySafeTop() {
    const root = document.documentElement;
    let px = -1;
    try {
      const plus = window.plus;
      if (plus && plus.navigator && typeof plus.navigator.isImmersedStatusbar === 'function') {
        let immersed = false;
        try { immersed = !!plus.navigator.isImmersedStatusbar(); } catch (e) { immersed = false; }
        if (immersed) {
          px = 0;
          try { if (typeof plus.navigator.getStatusbarHeight === 'function') px = Number(plus.navigator.getStatusbarHeight()) || 0; } catch (e) {}
        } else {
          px = 0;
        }
      }
    } catch (e) { px = -1; }
    if (px < 0) root.style.removeProperty('--safe-top');
    else root.style.setProperty('--safe-top', Math.max(0, Math.round(px)) + 'px');
  }

  // 启动兜底：任何异常、或本地数据库迟迟没有响应，都在启动画面上直接说明原因，
  // 绝不再无限停在「正在加载…」让人摸不着头脑（浏览器禁用 IndexedDB / 用 file:// 直接
  // 双击打开 index.html 时最容易出现）。
  let bootWatch = null;
  async function boot() {
    try {
      await bootInner();
    } catch (e) {
      showBootFail(e);
    }
    if (bootWatch) clearTimeout(bootWatch);
    bootWatch = setTimeout(() => {
      if (document.getElementById('boot')) showBootFail(new Error('本地数据库没有响应'));
    }, 6000);
  }

  function showBootFail(e) {
    const box = document.getElementById('boot');
    if (!box) return;
    const msg = (e && (e.message || e.reason || e)) ? String(e.message || e) : '未知错误';
    const isFile = String(location.protocol || '') === 'file:';
    const sub = box.querySelector('.boot-sub');
    if (sub) sub.textContent = '启动失败：' + msg;
    if (box.querySelector('.boot-fail')) return;
    const hint = U().el('div', {
      class: 'boot-fail',
      style: { marginTop: '10px', maxWidth: '300px', textAlign: 'center', fontSize: '12px', lineHeight: '1.7', color: '#9aa3af' },
      text: isFile
        ? '当前是用 file:// 直接打开的，浏览器会禁用本地数据库。请改用本地服务器地址打开（例如 http://localhost:5173/）。'
        : '本地存储不可用或响应超时。请确认浏览器没有禁用站点数据，然后重试。',
    });
    const retry = U().el('button', {
      class: 'btn primary',
      style: { marginTop: '12px' },
      text: '重试',
    });
    retry.addEventListener('click', () => location.reload());
    box.appendChild(hint);
    box.appendChild(retry);
  }

  async function bootInner() {
    appEl = document.getElementById('app');
    // 申请持久化存储权限（不 await，失败/不支持也不影响启动）
    if (App.storage && App.storage.ensurePersisted) App.storage.ensurePersisted();
    await App.state.init();
    const s = App.state.data.settings;
    App.themes.applyFromSettings(s);
    applyFontScale();
    applySafeTop();
    syncStatusBar();
    // 引导页也要跟随系统切深浅色，所以在分支之前先绑好监听
    bindSystemTheme();
    U().clear(appEl);
    if (!App.state.data.setupDone) { App.setup.render(appEl); return; }
    renderShell();
    applySafeTop();
    syncStatusBar();   // 顶栏此时才存在，重新取它的真实底色对齐状态栏
    renderRoute();
    initBackKey();
    initSwipe();
    // 老版本把图片存在 IndexedDB 里：进 App 3 秒后后台分批搬进相册 Pictures/GoJo，
    // 不阻塞界面、失败也不影响任何功能（原 Blob 保留）。
    try { setTimeout(() => { if (App.storage.migrateBlobsToAlbum) App.storage.migrateBlobsToAlbum(12).catch(() => {}); }, 3000); } catch (e) {}
    // 相册清道夫：老版本把封面小图也写进了 Pictures/GoJo，同一张照片会出现两遍。
    // 启动 6 秒后在后台扫一次，只删 GoJo 目录里宽度 < 400px 的图（记录还在引用的不删）。
    // 相册清道夫 + 反向对账 + 安全上限自动清理：启动 6 秒后一并后台跑（仅启动时，不阻塞首屏）。
    try { setTimeout(() => {
      if (App.storage.cleanAlbumJunk) App.storage.cleanAlbumJunk().catch(() => {});
      if (App.storage.reconcileAlbumMissing) App.storage.reconcileAlbumMissing().catch(() => {});
      if (App.storage.maybeAutoClean) App.storage.maybeAutoClean().catch(() => {});
    }, 6000); } catch (e) {}
  }

  function navItem(key, label, iconName) {
    const item = U().el('div', { class: 'nav-item', 'data-key': key }, U().iconEl(iconName, 23), U().el('span', { text: label }));
    item.addEventListener('click', () => go(key));
    navItems[key] = item; return item;
  }

  function renderShell() {
    const brand = U().el('div', { class: 'brand', text: 'GoJo' });
    headerDomainBtn = U().el('button', { class: 'domain-switch' });
    headerDomainBtn.addEventListener('click', openDomainMenu);
    const header = U().el('div', { class: 'app-header' }, brand, U().el('div', { class: 'spacer' }), headerDomainBtn);
    view = U().el('div', { class: 'view', id: 'view' });
    navItems = {};
    const nav = U().el('div', { class: 'bottom-nav' },
      U().el('div', { class: 'nav-inner' },
        navItem('dashboard', '仪表盘', 'dashboard'), navItem('records', '记录', 'records'), navItem('settings', '设置', 'settings')));
    const shell = U().el('div', { class: 'app-shell' }, header, view);
    appEl.appendChild(shell); appEl.appendChild(nav);
    refreshChrome();
  }

  function openDomainMenu() {
    const box = U().el('div', { class: 'col', style: { gap: '8px' } });
    App.state.data.domains.forEach((d) => {
      const b = U().el('button', { class: 'btn' + (d.id === App.state.data.currentDomainId ? ' primary' : ''), text: d.icon + '  ' + d.name });
      b.addEventListener('click', async () => {
        await App.state.setCurrentDomain(d.id); refreshChrome(); renderRoute();
        U().clear(document.getElementById('modal-root'));
      });
      box.appendChild(b);
    });
    U().modal({ title: '切换领域', body: box });
  }

  function refreshChrome() {
    if (headerDomainBtn) {
      const d = App.state.currentDomain();
      U().clear(headerDomainBtn);
      headerDomainBtn.appendChild(U().el('span', { class: 'ds-name', text: d ? d.name : '—' }));
      headerDomainBtn.appendChild(U().iconEl('chevron', 16));
    }
    if (navItems) { const base = currentBase(); Object.keys(navItems).forEach((k) => navItems[k].classList.toggle('active', k === base)); }
  }

  function currentBase() { const h = (location.hash || '').replace('#/', '').split('/')[0]; return h || 'dashboard'; }
  function go(route) { location.hash = '#/' + route; }
  function renderRoute() {
    const h = (location.hash || '').replace('#/', '');
    const parts = h.split('/');
    const base = parts[0] || 'dashboard';
    if (navItems) Object.keys(navItems).forEach((k) => navItems[k].classList.toggle('active', k === base));
    if (base === 'dashboard') App.dashboard.render(view);
    else if (base === 'records') App.records.renderList(view);
    else if (base === 'record') App.records.renderDetail(view, parts[1]);
    else if (base === 'settings') App.settings.render(view);
    else App.dashboard.render(view);
    window.scrollTo(0, 0);
    applyRouteEnter();  // 翻页入场 / 清理滑动残留
    ensureBackTrap();   // 路由换完立刻补哨兵，下一次返回才不会直接退到上一条路由
  }

  // ===== 全局左右滑动切页（H5 触摸手势 · 简单可靠）=====
  // 改用最通用的 touchstart / touchmove / touchend（不再依赖 Pointer Events）：
  // 真机上 Pointer Events 的 pointercancel 会被 WebView 的滚动判定提前触发，
  // 一次滑动常被系统「抢走」，表现就是要划好几下才偶尔成功。
  // touchmove 用 { passive:false }，一旦判定为横向就 preventDefault，立刻锁住手势不放手。
  // 视觉上只平移 #view（translate3d + 透明度），不做缩放，避免长列表重绘卡顿。
  // 逻辑：仪表盘 左→记录；记录 右→仪表盘、左→设置；设置 右→记录；两端越界完全无反应。
  const MAIN_TABS = ['dashboard', 'records', 'settings'];
  const SWIPE_START = 6;            // 判定方向的最小位移(px)
  const SWIPE_COMMIT_PX = 56;       // 提交所需最小位移(px)
  const SWIPE_COMMIT_RATIO = 0.15;  // 提交所需位移占屏宽比例
  const SWIPE_VEL = 0.35;           // 快速滑动速度阈值(px/ms)
  const SWIPE_FLICK_PX = 20;        // 快速滑动至少要滑这么远，避免误触

  let pendingEnter = null;   // { dir } 提交翻页后，供下一次 renderRoute 做「同侧滑入」
  let swipeGen = 0;          // 动画代次：防止旧的清理定时器打断新一次手势
  let swipingActive = false; // 当前是否有手势正在进行（清理定时器要避让）

  // dir: +1 = 左滑（去数组下一个），-1 = 右滑（去数组上一个）
  function swipeTarget(base, dir) {
    const i = MAIN_TABS.indexOf(base);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= MAIN_TABS.length) return null;   // 首尾边界
    return MAIN_TABS[j];
  }

  // 路由切换后的入场（对应详情页的 pendingEnter）：翻页时新页面从同侧滑入；
  // 普通跳转则清掉上一次滑动残留，避免 transform 影响 fixed 定位/滚动。
  function applyRouteEnter() {
    const v = view;
    if (!v) return;
    const gen = ++swipeGen;
    if (pendingEnter) {
      const dir = pendingEnter.dir || 1; pendingEnter = null;
      v.style.transition = 'none';
      v.style.transform = 'translate3d(' + (dir * 18) + '%,0,0)';
      v.style.opacity = '0.35';
      // 用 setTimeout 而非 rAF：后台/低帧率时 rAF 可能被挂起，页面会僵在偏移位置
      setTimeout(() => {
        if (gen !== swipeGen) return;
        v.style.transition = 'transform .28s cubic-bezier(.22,.7,.28,1), opacity .28s';
        v.style.transform = 'translate3d(0,0,0)';
        v.style.opacity = '1';
      }, 20);
      // 入场结束清空内联样式：避免 #view 常驻 transform 成为 fixed 后代的包含块
      setTimeout(() => {
        if (gen !== swipeGen || swipingActive) return;
        v.style.transition = ''; v.style.transform = ''; v.style.opacity = '';
      }, 380);
    } else {
      v.style.transition = '';
      v.style.transform = '';
      v.style.opacity = '';
    }
  }

  function initSwipe() {
    const root = document.getElementById('app');
    if (!root) return;
    let g = null;
    let lastTouchAt = 0;    // 触摸后短时间内忽略兼容鼠标事件，避免一次滑动被处理两遍
    let touchActive = false; // 本次触摸是否真的启动了手势

    function overlayOpen() {
      return !!document.querySelector('#modal-root .modal-backdrop, #modal-root .modal, #modal-root .page-sheet, .iv-mask, .color-pop, .cf-sel-menu, .dots-menu, .popmenu, .emoji-picker');
    }
    function ignoreTarget(t) {
      if (!t || !t.closest) return true;
      return !!t.closest('input,textarea,button,select,a,label,.bottom-nav,.app-header,.tabs,.list-chiprow,.no-swipe');
    }
    function clearViewStyle() {
      if (!view) return;
      view.style.transition = ''; view.style.transform = ''; view.style.opacity = '';
    }

    function start(x, y) {
      if (pendingEnter) return;                            // 上一次翻页动画还没落地，忽略
      if (overlayOpen()) return;
      if (!view) return;
      if (MAIN_TABS.indexOf(currentBase()) < 0) return;    // 详情页/未知路由：不接管
      swipingActive = true;
      g = { x0: x, y0: y, t0: Date.now(), base: currentBase(), dx: 0, mode: null, dir: 0, target: null };
    }

    // 返回 true = 这是横向手势，调用方必须 preventDefault 阻止原生滚动
    function move(x, y) {
      if (!g) return false;
      const dx = x - g.x0, dy = y - g.y0;

      if (!g.mode) {
        if (Math.abs(dx) < SWIPE_START && Math.abs(dy) < SWIPE_START) return false;
        // 只有竖向明显占优才判为滚动；其余一律按横向处理（真机手指很难滑得笔直）
        if (Math.abs(dy) > Math.abs(dx) * 1.1) { g = null; swipingActive = false; return false; }
        g.dir = dx < 0 ? 1 : -1;
        g.target = swipeTarget(g.base, g.dir);
        if (!g.target) { g = null; swipingActive = false; return false; }  // 边界：完全不接管
        g.mode = 'h';
        view.style.transition = 'none';
      }
      if (g.mode !== 'h') return false;

      g.dx = dx;
      view.style.transform = 'translate3d(' + (dx * 0.95) + 'px,0,0)';
      view.style.opacity = String(Math.max(.45, 1 - Math.abs(dx) / 1600));
      return true;
    }

    function springBack() {
      if (!view) return;
      const gen = ++swipeGen;
      view.style.transition = 'transform .26s cubic-bezier(.22,.7,.28,1), opacity .26s';
      view.style.transform = 'translate3d(0,0,0)';
      view.style.opacity = '1';
      setTimeout(() => {
        if (gen !== swipeGen || swipingActive) return;
        clearViewStyle();
      }, 280);
    }

    function end(cancelled) {
      const gg = g; g = null; swipingActive = false;
      // 没有发生横向翻页（轻点 / 竖滑 / 边界）：清掉可能残留的位移
      if (!gg || gg.mode !== 'h' || !gg.target) { clearViewStyle(); return; }

      const w = (view && view.clientWidth) || window.innerWidth || 320;
      const limit = Math.min(SWIPE_COMMIT_PX, w * SWIPE_COMMIT_RATIO);
      // 用整段手势的平均速度，而不是最后两帧：快速短滑也能被识别
      const dt = Math.max(1, Date.now() - gg.t0);
      const vAvg = gg.dx / dt;
      const far = Math.abs(gg.dx) > limit;
      const fast = Math.abs(vAvg) > SWIPE_VEL && Math.abs(gg.dx) > SWIPE_FLICK_PX;

      if (!cancelled && (far || fast)) {
        view.style.transition = 'transform .2s cubic-bezier(.4,0,.72,1), opacity .2s';
        // 离场方向 = 手指方向：左滑(dir=+1) 当前页继续往左飞出，右滑(dir=-1) 往右飞出。
        // 新页在 applyRouteEnter 里从 dir*18%（即手指来向的反侧）滑进来，两边衔接才顺。
        view.style.transform = 'translate3d(' + (-gg.dir * 100) + '%,0,0)';
        view.style.opacity = '0';
        pendingEnter = { dir: gg.dir };
        // setTimeout 兜底，不依赖 transitionend，绝不会卡在半截
        setTimeout(() => { go(gg.target); }, 170);
      } else {
        springBack();
      }
    }

    // —— 触摸（主路径）——
    root.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (ignoreTarget(e.target)) return;
      lastTouchAt = Date.now();
      start(e.touches[0].clientX, e.touches[0].clientY);
      touchActive = !!g;
    }, { passive: true });

    // passive:false 是关键：判定为横向后能立刻 preventDefault，锁住手势不被页面滚动抢走
    root.addEventListener('touchmove', (e) => {
      if (!g) return;
      if (e.touches.length !== 1) { g = null; swipingActive = false; return; }
      if (move(e.touches[0].clientX, e.touches[0].clientY)) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    root.addEventListener('touchend', () => {
      if (!touchActive) return;
      touchActive = false;
      end(false);
    }, { passive: true });

    root.addEventListener('touchcancel', () => {
      if (!touchActive) return;
      touchActive = false;
      end(true);
    }, { passive: true });

    // —— 鼠标（桌面预览用，真机走上面的触摸路径）——
    let mouseDown = false;
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (Date.now() - lastTouchAt < 800) return;
      if (ignoreTarget(e.target)) return;
      mouseDown = true;
      start(e.clientX, e.clientY);
    });
    root.addEventListener('mousemove', (e) => {
      if (!mouseDown) return;
      if (move(e.clientX, e.clientY) && e.cancelable) e.preventDefault();
    });
    root.addEventListener('mouseup', () => {
      if (!mouseDown) return;
      mouseDown = false; end(false);
    });
    root.addEventListener('mouseleave', () => {
      if (!mouseDown) return;
      mouseDown = false; end(true);
    });
  }

  // ===== 物理返回键 =====
  // 优先级：浮层（大图 / 弹窗 / 取色盘 / 下拉）→ 二级页面 → 主 Tab。
  // 主 Tab 上不再路由回退，改成「两秒内按两次退出」，第一次只提示。
  const EXIT_MS = 2000;
  let backHooked = false, plusBackBound = false, exitAt = 0;

  function initBackKey() {
    if (backHooked) return;
    backHooked = true;
    bindPlusBack();
    // plus 是异步注入的：还没注入就在 plusready 时补绑（5+ App 里这是主路径）
    if (!plusBackBound) document.addEventListener('plusready', bindPlusBack, false);
    window.addEventListener('popstate', onPopState);
    ensureBackTrap();
  }

  // 5+ App：直接监听硬件返回键。绑定之后系统的默认「后退 / 退出」就不再执行，
  // 所有返回都由我们自己决定，逻辑与浏览器分支共用 onBack()。
  function bindPlusBack() {
    if (plusBackBound) return;
    const plus = window.plus;
    if (!plus || !plus.key || typeof plus.key.addEventListener !== 'function') return;
    try { plus.key.addEventListener('backbutton', onBack); plusBackBound = true; } catch (e) {}
  }

  // 非 5+ 环境：压一条「哨兵」历史记录，返回键先命中它而不是退出页面。
  // 关键点：Chrome/WebView 里 location.hash 赋值（我们的路由跳转）同样会触发 popstate，
  // 必须把「路由跳转」和「真的按了返回」分开 —— 靠哈希是否变化判断：
  //   真返回 = 从哨兵退到它下面那条（URL 完全相同，哈希没变）
  //   路由跳转 = 哈希变了
  let trapHash = '';
  function ensureBackTrap() {
    if (!backHooked || plusBackBound) return;
    if (history.state && history.state.gojoTrap) { trapHash = location.hash || ''; return; }
    try { history.pushState({ gojoTrap: 1 }, '', location.href); trapHash = location.hash || ''; } catch (e) {}
  }
  function onPopState() {
    const sameRoute = (location.hash || '') === trapHash;
    ensureBackTrap();                 // 先补哨兵，保证下一次返回还拦得住
    if (!sameRoute) return;           // 哈希变了 → 是我们自己的路由跳转，不是返回键
    onBack();
  }

  function onBack() {
    if (consumeBack()) return;
    if (Date.now() - exitAt < EXIT_MS) { exitAt = 0; exitApp(); return; }
    exitAt = Date.now();
    U().toast('再按一次退出应用');
  }

  // 返回 true 表示这一下返回已经被消费掉，不要再退页面
  function consumeBack() {
    if (U() && U().closeTopLayer && U().closeTopLayer()) return true;         // 浮层优先
    if (App.settings && App.settings.backToParent && App.settings.backToParent()) return true; // 设置页的就地编辑
    const h = (location.hash || '').replace('#/', '');
    const base = h.split('/')[0] || 'dashboard';
    if (base === 'record') { go('records'); return true; }                    // 二级页面 → 回列表
    return false;                                                            // 主 Tab：交给双击退出
  }

  function exitApp() {
    const plus = window.plus;
    if (plus && plus.runtime && typeof plus.runtime.quit === 'function') { plus.runtime.quit(); return; }
    // 网页里没有「退出应用」：撤掉哨兵，退回到进入站点前的那一页
    backHooked = false;
    try { history.go(-1); } catch (e) {}
  }

  window.addEventListener('hashchange', renderRoute);
  return { boot, go, renderRoute, refreshChrome, applyFontScale, syncStatusBar, onBack, get view() { return view; } };
})();

// 启动
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.app.boot());
else App.app.boot();
