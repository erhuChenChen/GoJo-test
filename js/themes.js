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

  // 「系统当前是不是深色」的唯一判据。
  // 真机要点：安卓 WebView 里的 prefers-color-scheme 并不可靠 —— 系统切深浅色时
  // 它经常既不更新取值、也不派发 change 事件（取决于 WebView 版本与 force-dark 配置）。
  // 所以 5+ 环境优先问原生 plus.navigator.getUIStyle()，拿不到才回退媒体查询。
  function systemIsDark() {
    try {
      const plus = window.plus;
      if (plus && plus.navigator && typeof plus.navigator.getUIStyle === 'function') {
        const u = plus.navigator.getUIStyle();
        if (u === 'dark') return true;
        if (u === 'light') return false;
      }
    } catch (e) {}
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
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
      notifyApplied();
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
    notifyApplied();
  }

  // 主题落地后的统一通知：原生状态栏要跟着顶栏换色。
  // 不直接依赖 app.js 的加载顺序（themes.js 先加载，boot 前 App.app 可能还不存在）。
  function notifyApplied() {
    try {
      if (window.App && App.app && typeof App.app.syncStatusBar === 'function') App.app.syncStatusBar();
    } catch (e) {}
  }

  // 解析最终生效主题：日间/夜间/跟随系统 → 预设 / 我的主题 / 自定义 / 被改色的预设
  function resolveEffective(s) {
    s = s || {};
    const ap = s.appearance || 'auto';
    let key;
    if (ap === 'day') key = s.dayTheme || 'light';
    else if (ap === 'night') key = s.nightTheme || 'dark';
    else {
      const dark = systemIsDark();
      key = dark ? (s.nightTheme || 'dark') : (s.dayTheme || 'light');
    }
    if (key === 'custom') return { theme: 'custom', bg: s.customBg, accent: s.customAccent };
    const ct = (s.customThemes || []).find((t) => t.key === key);
    if (ct) return { theme: 'custom', bg: ct.bg, accent: ct.accent };
    const ov = (s.themeOverrides || {})[key];
    if (ov) return { theme: key, bg: ov.bg, accent: ov.accent };
    return { theme: key, bg: null, accent: null };
  }

  function applyFromSettings(s) { const r = resolveEffective(s); apply(r.theme, r.bg, r.accent); return r; }

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

  return { PRESETS, apply, toSoft, palette, shadowFor, textOn, onColor, relLum, luminance, systemIsDark, resolveEffective, applyFromSettings, themeOptions, rgbList };
})();
