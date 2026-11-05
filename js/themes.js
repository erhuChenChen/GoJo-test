/* ===== themes.js — 主题与换肤（含日间/夜间/跟随系统、预设改色） ===== */
window.App = window.App || {};
App.themes = (function () {
  const PRESETS = [
    { key: 'dark', name: '深色极简', bg: '#15171c', surface: 'rgba(255,255,255,0.07)', text: '#eef0f4', dim: '#98a0ad', accent: '#8b9cff' },
    { key: 'light', name: '浅色清新', bg: '#eef1f7', surface: 'rgba(255,255,255,0.66)', text: '#1f2533', dim: '#6b7280', accent: '#4f8cff' },
    { key: 'warm', name: '暖色复古', bg: '#221b16', surface: 'rgba(255,238,220,0.08)', text: '#f5ead9', dim: '#c2a98f', accent: '#e0915a' },
  ];

  // 所有由 JS 覆盖到 :root 上的变量（切回未改色的预设时要逐个清掉）
  const VAR_KEYS = ['--bg', '--bg-alpha', '--bg-2', '--surface', '--surface-2', '--card-bg', '--glass',
    '--text', '--text-dim', '--border', '--accent', '--accent-soft', '--on-accent', '--shadow', '--amb-1', '--amb-2'];

  function rgbList(hex) {
    let c = String(hex || '#000').replace('#', '').trim();
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length < 6) return [0, 0, 0];
    return [parseInt(c.substr(0, 2), 16) || 0, parseInt(c.substr(2, 2), 16) || 0, parseInt(c.substr(4, 2), 16) || 0];
  }
  function luminance(hex) {
    const c = (String(hex || '#000').replace('#', ''));
    if (c.length < 6 && c.length !== 3) return 0.5;
    const [r, g, b] = rgbList(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  function toSoft(hex, a) {
    const [r, g, b] = rgbList(hex || '#8b9cff');
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a == null ? 0.16 : a) + ')';
  }
  // 在背景色基础上提亮，得到“卡片/次级面板”实色
  function elevate(hex, amt) {
    const [r, g, b] = rgbList(hex || '#15171c');
    const m = (x) => Math.round(x + (255 - x) * amt);
    return '#' + [m(r), m(g), m(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  // 根据背景深浅自动选文字色（主题卡片标签用它，避免白底白字）
  function textOn(bg) { return luminance(bg) < 0.55 ? '#f2f3f7' : '#1b2027'; }

  // 相对亮度（WCAG，线性化后加权）：比上面的“感知亮度”更准，专门用来判断
  // “这块底色到底算浅还是算深”，从而决定叠在上面的文字/图标该用黑还是白。
  function relLum(hex) {
    const [r, g, b] = rgbList(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  // 强调色当底色时，叠在上面的墨色：浅底→近黑，深底→纯白。
  // 阈值 0.55 是实测折中：饱和的蓝紫/橙（相对亮度 0.27~0.37）仍用白字，
  // 白、浅灰、淡黄、淡粉等（>0.6）一律转黑，保证白底不会白字。
  function onColor(bg) { return relLum(bg) > 0.55 ? '#14171c' : '#ffffff'; }
  function isDarkBg(bg) { return luminance(bg) < 0.5; }

  // 阴影：取当前主题的强调色 → 大幅加深 → 低透明度大模糊。
  // 这样浅色主题得到冷灰蓝阴影、暖色主题得到暖棕阴影，不再是统一的死黑。
  function shadowFor(bg, accent) {
    const dark = isDarkBg(bg);
    const [r0, g0, b0] = rgbList(accent || '#8b9cff');
    const f = dark ? 0.52 : 0.58;
    const r = Math.round(r0 * f), g = Math.round(g0 * f), b = Math.round(b0 * f);
    return dark
      ? '0 1px 3px rgba(' + r + ',' + g + ',' + b + ',0.22), 0 12px 30px rgba(' + r + ',' + g + ',' + b + ',0.32)'
      : '0 1px 3px rgba(' + r + ',' + g + ',' + b + ',0.10), 0 12px 28px rgba(' + r + ',' + g + ',' + b + ',0.18)';
  }

  // 由「背景色 + 强调色」推导整套配色（自定义主题、以及被改色的预设都用它）
  function palette(bg, accent) {
    const b = bg || '#15171c';
    const a = accent || '#8b9cff';
    const dark = isDarkBg(b);
    return {
      '--bg': b,
      // 顶栏/底栏底色：背景色的半透明版，配 backdrop-filter 与页面完全融合
      '--bg-alpha': toSoft(b, 0.88),
      '--bg-2': elevate(b, dark ? 0.05 : 0.88),
      '--surface': dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.66)',
      '--surface-2': dark ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.94)',
      '--card-bg': dark ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.74)',
      '--glass': dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)',
      '--text': dark ? '#f2f3f7' : '#1c2026',
      '--text-dim': dark ? 'rgba(255,255,255,0.58)' : 'rgba(28,32,38,0.58)',
      '--border': dark ? 'rgba(255,255,255,0.10)' : 'rgba(20,28,45,0.10)',
      '--accent': a,
      // 强调色作底时，叠在上面的文字/图标颜色（白或近黑，由亮度算出）
      '--on-accent': onColor(a),
      '--accent-soft': toSoft(a, dark ? 0.18 : 0.14),
      '--shadow': shadowFor(b, a),
      // 环境光：跟着强调色走，改色后卡片透出的底色也会跟着变
      '--amb-1': toSoft(a, dark ? 0.22 : 0.18),
      '--amb-2': toSoft(a, dark ? 0.16 : 0.16),
    };
  }

  function presetOf(key) { return PRESETS.find((p) => p.key === key) || null; }

  // ===== 系统深浅色探测（真机关键）=====
  // 安卓 14 实机结论（HBuilderX 云打包的 5+ App）：
  //   · plus.navigator.getUIStyle() 返回的是「App 自己的 UI 样式」。云打包默认把 App 原生
  //     主题固定成日间，于是它恒为 'light'，系统切深色也不变；
  //   · WebView 的 prefers-color-scheme 跟随宿主 App 的主题（同上），同样恒为 light；
  //   · 两条链一起“谎报浅色”，这就是「选了跟随系统却纹丝不动」的根因 —— 轮询再勤也没用。
  // 唯一说真话的是直接问 Android 框架要设备当前的 uiMode：
  //   Resources.getSystem().getConfiguration().uiMode & UI_MODE_NIGHT_MASK
  // getSystem() 拿的是全局资源，反映系统真实深浅（含“日落自动切换”），不受 App 主题固定影响。
  // 探测顺序：① 设备 uiMode → ② UiModeManager 用户设置 → ③ 媒体查询 → ④ getUIStyle → 默认浅色。
  const NIGHT_MASK = 0x30;      // Configuration.UI_MODE_NIGHT_MASK
  const NIGHT_YES = 0x20;       // Configuration.UI_MODE_NIGHT_YES
  const NIGHT_NO = 0x10;        // Configuration.UI_MODE_NIGHT_NO
  const PROBE_TTL = 350;        // 同一帧里多处调用（设置页 + 800ms 轮询）只过一次桥
  const NUDGE_KEY = 'gojo.uiStyleAuto';

  let probeCache = { v: null, t: 0 };
  let probeFails = 0;           // 原生两条连续抛错的次数，满 3 次就熔断（异常机型不再空转）
  let lastLogKey = '';
  let nudged = false;           // 是否已尝试 setUIStyle('auto')
  const probeLast = { uiMode: null, nightMode: null, mq: null, plus: null };

  function androidBridge() {
    try { const p = window.plus; return (p && p.android) ? p.android : null; } catch (e) { return null; }
  }

  // uiMode 的三个状态位：深色 0x20、浅色 0x10、未定义 0x00（后者不可信，继续往下问）
  function nightFromUiMode(raw) {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!isFinite(n) || n <= 0) return null;
    const m = n & NIGHT_MASK;
    if (m === NIGHT_YES) return true;
    if (m === NIGHT_NO) return false;
    return null;
  }

  // ① 设备真实 uiMode。静态方法 getSystem() 用类名字符串调最稳（实例调用过桥常返回 null），
  //    这与 storage.js 里 plus.android.invoke('java.lang.System', ...) 的写法一致。
  function probeUiMode() {
    const A = androidBridge();
    if (!A) return null;
    let res = null;
    try { res = A.invoke('android.content.res.Resources', 'getSystem'); } catch (e) {}
    if (!res) {
      try {
        const R = A.importClass('android.content.res.Resources');
        if (R && typeof R.getSystem === 'function') res = R.getSystem();
      } catch (e) {}
    }
    if (!res) return null;
    let cfg = null;
    try { cfg = A.invoke(res, 'getConfiguration'); } catch (e) {}
    if (!cfg) {
      try { A.importClass(res); if (typeof res.getConfiguration === 'function') cfg = res.getConfiguration(); } catch (e) {}
    }
    if (!cfg) return null;
    let raw = null;
    try { raw = A.getAttribute(cfg, 'uiMode'); } catch (e) {}
    if (raw === null || raw === undefined) {
      // 字段没映射上来时，再试「先 importClass 实例、再直接读字段」
      try { A.importClass(cfg); if (typeof cfg.uiMode !== 'undefined') raw = cfg.uiMode; } catch (e) {}
    }
    probeLast.uiMode = raw;
    return nightFromUiMode(raw);
  }

  // ② 用户设置项：getNightMode() 2=深色 1=浅色 0=自动/未指定（自动时还得靠 ①）
  function probeNightMode() {
    const A = androidBridge();
    if (!A) return null;
    let mgr = null;
    try {
      const act = A.runtimeMainActivity();
      if (act) mgr = A.invoke(act, 'getSystemService', 'uimode');
    } catch (e) {}
    if (!mgr) {
      try {
        const M = A.importClass('android.app.UiModeManager');
        if (M && typeof M.getDefault === 'function') mgr = M.getDefault();
      } catch (e) {}
    }
    if (!mgr) return null;
    let v = null;
    try { v = A.invoke(mgr, 'getNightMode'); } catch (e) {}
    if (v === null || v === undefined) {
      try { A.importClass(mgr); if (typeof mgr.getNightMode === 'function') v = mgr.getNightMode(); } catch (e) {}
    }
    probeLast.nightMode = v;
    if (Number(v) === 2) return true;
    if (Number(v) === 1) return false;
    return null;
  }

  // ③ 浏览器 / 未被固定主题的 WebView 上，媒体查询是准的
  function probeMediaQuery() {
    let m = null;
    try { m = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { m = null; }
    probeLast.mq = m;
    return m;
  }

  // ④ 末位兜底：App 自己的 UI 样式（固定日间时恒为 light，只在别处都拿不到时用）
  function probePlusStyle() {
    let r = null;
    try {
      const p = window.plus;
      if (p && p.navigator && typeof p.navigator.getUIStyle === 'function') {
        const u = p.navigator.getUIStyle();
        probeLast.plus = u;
        if (u === 'dark') r = true;
        else if (u === 'light') r = false;
      }
    } catch (e) { r = null; }
    return r;
  }

  // 原生两条全灭时的最后兜底：官方文档明确「App 上要先调用 plus.nativeUI.setUIStyle('auto')
  // 才会跟随系统主题」。只在当前外观模式确实是「跟随系统」时才敢调用 —— 固定日间/夜间时调它
  // 会把用户强行拉去跟随系统（原生弹窗、状态栏图标一起变），那是新 bug。
  function ensureNativeUiFollow() {
    if (nudged) return;
    if (!androidBridge()) { nudged = true; return; }     // 非安卓（iOS / 浏览器）永久跳过
    let s = null;
    try { s = window.App && App.state && App.state.data && App.state.data.settings; } catch (e) {}
    if (!s || (s.appearance || 'auto') !== 'auto') return;   // 固定日夜模式：绝不动原生样式
    try { if (sessionStorage.getItem(NUDGE_KEY) === '1') { nudged = true; return; } } catch (e) {}
    nudged = true;
    try {
      const p = window.plus;
      if (p && p.nativeUI && typeof p.nativeUI.setUIStyle === 'function') p.nativeUI.setUIStyle('auto');
    } catch (e) {}
    try { sessionStorage.setItem(NUDGE_KEY, '1'); } catch (e) {}   // Activity 重建后不再重复调用
  }

  // 真机排查用：值/来源变化时打一行，字符串比较零成本。src=uiMode 即修复生效；
  // 一直是 src=mq 说明这台机器的 plus.android 反射不通，走了兜底。
  function logProbe(dark, src) {
    const key = src + ':' + dark;
    if (key === lastLogKey) return;
    lastLogKey = key;
    try {
      console.log('[主题] 系统深色 ' + dark + ' src=' + src +
        ' uiMode=' + probeLast.uiMode + ' nightMode=' + probeLast.nightMode +
        ' mq=' + probeLast.mq + ' plus=' + probeLast.plus + ' nativeFails=' + probeFails);
    } catch (e) {}
  }

  // 「系统当前是不是深色」的唯一判据。fresh=true 绕过 TTL 缓存（plusready 首次校准用）
  function systemIsDark(fresh) {
    const now = Date.now();
    if (!fresh && probeCache.v !== null && now - probeCache.t < PROBE_TTL) return probeCache.v;

    let dark = null, src = '';
    if (probeFails < 3) {
      let a = null;
      try { a = probeUiMode(); } catch (e) {}
      if (a !== null) { dark = a; src = 'uiMode'; }
      else {
        let b = null;
        try { b = probeNightMode(); } catch (e) {}
        if (b !== null) { dark = b; src = 'nightMode'; }
        // 原生两条都给不出结论：这台机器的 plus.android 反射多半不通。连记 3 次就熔断，
        // 别再每 800ms 空转一次。plus 还没注入时 androidBridge() 为 null，不会误记。
        else if (androidBridge()) probeFails += 1;
      }
    }
    if (dark === null) {
      const mq = probeMediaQuery();
      if (mq !== null) { dark = mq; src = 'mq'; }
    }
    if (dark === null) {
      const ps = probePlusStyle();
      if (ps !== null) { dark = ps; src = 'uiStyle'; }
    }
    if (dark === null) { dark = false; src = 'default'; }

    if (probeFails >= 3) ensureNativeUiFollow();
    probeCache = { v: dark, t: now };
    logProbe(dark, src);
    return dark;
  }

  let liveVars = [];
  function clearVars(root) {
    liveVars.forEach((k) => root.style.removeProperty(k));
    liveVars = [];
  }
  function setVars(root, obj) {
    const keys = Object.keys(obj);
    keys.forEach((k) => root.style.setProperty(k, obj[k]));
    liveVars = keys;
  }

  // 老版安卓 WebView 在 JS 改写 CSS 自定义属性后不一定立刻重绘（真机表现：变量值已变、画面不动）。
  // 读一次布局属性强制走一遍样式/布局刷新，把它拽回当前帧；限频，避免拖动调色盘时每帧强制重排。
  let lastNudge = 0;
  function nudgeRepaint() {
    const now = Date.now();
    if (now - lastNudge < 60) return;
    lastNudge = now;
    if (typeof document !== 'undefined' && document.documentElement) void document.documentElement.offsetHeight;
  }

  // theme: 预设 key / 'custom'；bg+accent 有值时用它们覆盖整套配色（预设改色也走这里）
  function apply(theme, bg, accent) {
    const root = document.documentElement;
    const key = theme || 'dark';
    root.setAttribute('data-theme', key);
    const p = presetOf(key);
    // 让原生控件（勾选框、滚动条、日期选择）跟随主题深浅，避免深色页面上冒出白色方块
    root.style.colorScheme = isDarkBg(bg || (p && p.bg) || '#15171c') ? 'dark' : 'light';
    if (bg) {
      setVars(root, palette(bg, accent || (p && p.accent) || '#8b9cff'));
      nudgeRepaint();
      notifyApplied(key);
      return;
    }
    clearVars(root);
    // 未改色的预设：配色交给 CSS，只把阴影按主题色算出来（比写死的死黑更贴合），
    // 顺带把「强调色上的墨色」算准（预设若被改成极浅色，按钮文字要自动转黑）
    if (p) {
      root.style.setProperty('--shadow', shadowFor(p.bg, p.accent));
      root.style.setProperty('--on-accent', onColor(p.accent));
      liveVars = ['--shadow', '--on-accent'];
    }
    // 深浅色切换是整页 CSS 变量大改，正是老 WebView「变量变了画面不动」的典型场景
    nudgeRepaint();
    notifyApplied(key);
  }

  // 主题落地后的统一通知：
  // ① 原生状态栏要跟着顶栏换色；② 广播 app:theme，让设置页那行「当前系统为深/浅色」等
  // 依赖当前主题的文案就地刷新 —— 系统切深浅色时设置页不会重渲染，只能靠这个信号。
  // 不直接依赖 app.js 的加载顺序（themes.js 先加载，boot 前 App.app 可能还不存在）。
  function notifyApplied(key) {
    try {
      if (window.App && App.app && typeof App.app.syncStatusBar === 'function') App.app.syncStatusBar();
    } catch (e) {}
    try {
      if (typeof window.CustomEvent === 'function' && typeof document !== 'undefined' && document.dispatchEvent) {
        document.dispatchEvent(new window.CustomEvent('app:theme', { detail: { theme: key } }));
      }
    } catch (e) {}
  }

  // 外观模式说明文案：跟随系统时反映「当前系统深浅」。
  // fresh=true 绕开 350ms 缓存（事件驱动时用，保证文案与刚落地的主体一致）。
  function appearanceNote(s, fresh) {
    s = s || {};
    const ap = s.appearance || 'auto';
    if (ap === 'day') return '固定日间模式';
    if (ap === 'night') return '固定夜间模式';
    return '跟随系统 · 当前系统为' + (systemIsDark(fresh) ? '深色（使用夜间主题）' : '浅色（使用日间主题）');
  }

  // 解析最终生效主题：日间/夜间/跟随系统 → 预设 / 我的主题 / 自定义 / 被改色的预设
  // darkOverride 传布尔值时直接当作系统深浅，不再探测（媒体查询 change 事件已有新值，
  // 此刻重新探测可能仍返回被 App 主题固定的旧值，会把事件值覆盖掉）
  function resolveEffective(s, darkOverride) {
    s = s || {};
    const ap = s.appearance || 'auto';
    let key;
    if (ap === 'day') key = s.dayTheme || 'light';
    else if (ap === 'night') key = s.nightTheme || 'dark';
    else {
      const dark = (typeof darkOverride === 'boolean') ? darkOverride : systemIsDark();
      key = dark ? (s.nightTheme || 'dark') : (s.dayTheme || 'light');
    }
    if (key === 'custom') return { theme: 'custom', bg: s.customBg, accent: s.customAccent };
    const ct = (s.customThemes || []).find((t) => t.key === key);
    if (ct) return { theme: 'custom', bg: ct.bg, accent: ct.accent };
    const ov = (s.themeOverrides || {})[key];
    if (ov) return { theme: key, bg: ov.bg, accent: ov.accent };
    return { theme: key, bg: null, accent: null };
  }

  function applyFromSettings(s, darkOverride) {
    const r = resolveEffective(s, darkOverride);
    apply(r.theme, r.bg, r.accent);
    return r;
  }

  // 列出可选主题（内置预设 + 已保存的自定义主题 + 自定义项），文字色按背景自动适配
  function themeOptions(s) {
    s = s || {};
    const ov = s.themeOverrides || {};
    const list = PRESETS.map((p) => {
      const o = ov[p.key];
      const bg = (o && o.bg) || p.bg;
      const accent = (o && o.accent) || p.accent;
      return { key: p.key, name: p.name, bg: bg, accent: accent, text: textOn(bg), customized: !!o, preset: true };
    });
    (s.customThemes || []).forEach((ct) => list.push({ key: ct.key, name: ct.name, bg: ct.bg, accent: ct.accent, text: textOn(ct.bg), customized: false, preset: false }));
    const cb = s.customBg || '#15171c';
    list.push({ key: 'custom', name: '自定义', bg: cb, accent: s.customAccent || '#8b9cff', text: textOn(cb), customized: true, preset: false });
    return list;
  }

  return { PRESETS, apply, toSoft, palette, shadowFor, textOn, onColor, relLum, luminance, systemIsDark, resolveEffective, applyFromSettings, themeOptions, rgbList, appearanceNote };
})();
