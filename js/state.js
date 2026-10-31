/* ===== state.js — 运行时状态 ===== */
window.App = window.App || {};
App.state = (function () {
  const DEFAULT_SETTINGS = {
    theme: 'dark', customBg: null, customAccent: null,
    appearance: 'auto', dayTheme: 'light', nightTheme: 'dark', customThemes: [],
    themeOverrides: {}, // 内置预设被改色后的覆盖值：{ light: {bg, accent}, dark: {...} }
    fontScaleKey: 'standard',
    recordView: 'double', // 列表页视图：double=双列网格（默认） / single=单列大卡片
    tabOrder: [], // 设置页顶部导航的自定义顺序（拖动排序后保存的 key 数组）
  };

  const s = {
    setupDone: false,
    domains: [],
    currentDomainId: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    records: [],
  };

  // 把旧领域对象补齐新字段（目标数组、仪表盘组件、自定义属性、卡片字段）
  function migrateDomain(d) {
    if (!d) return d;
    const def = App.domains.DEFAULT_WIDGETS;
    if (!d.goals || !d.goals.length) {
      if (d.goal) d.goals = [Object.assign({ id: App.storage.uid(), mode: 'auto', value: 0, color: App.domains.GOAL_PALETTE[0], style: 'bar' }, d.goal)];
      else d.goals = [App.domains.makeGoal('目标', 'records', 20, 0)];
    }
    (d.goals || []).forEach((g) => { if (!g.style) g.style = 'bar'; });
    delete d.goal;
    if (!d.dashboardWidgets || !d.dashboardWidgets.length) d.dashboardWidgets = def.map((w) => Object.assign({}, w));
    if (!d.customFields) d.customFields = [];
    // 列表卡片：记录名称 / 日期固定显示，不再属于可勾选字段（幂等清理旧值）
    if (!d.cardFields) d.cardFields = [];
    d.cardFields = d.cardFields.filter((k) => k !== 'title' && k !== 'date');
    return d;
  }

  async function init() {
    s.setupDone = await App.db.getKV('setupDone', false);
    s.domains = (await App.db.getDomains()).map(migrateDomain);
    // 写回迁移结果，固化字段
    for (const d of s.domains) await App.db.saveDomain(d);
    const savedSettings = await App.db.getKV('settings', null);
    s.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings || {});
    s.currentDomainId = await App.db.getKV('currentDomainId', null);
    if (!s.currentDomainId && s.domains.length) s.currentDomainId = s.domains[0].id;
    if (s.currentDomainId) await reloadRecords();
  }

  async function reloadDomains() { s.domains = await App.db.getDomains(); }
  function getDomain(id) { return s.domains.find((d) => d.id === (id || s.currentDomainId)); }
  function currentDomain() { return getDomain(s.currentDomainId); }

  async function setCurrentDomain(id) { s.currentDomainId = id; await App.db.setKV('currentDomainId', id); await reloadRecords(); }
  async function reloadRecords() { s.records = await App.db.getRecords(s.currentDomainId); return s.records; }

  async function saveSettings(partial) {
    s.settings = Object.assign({}, s.settings, partial);
    await App.db.setKV('settings', s.settings);
    return s.settings;
  }

  async function completeSetup() { s.setupDone = true; await App.db.setKV('setupDone', true); }

  return {
    data: s, init, reloadDomains, getDomain, currentDomain, setCurrentDomain,
    reloadRecords, saveSettings, completeSetup,
    get DEFAULT_WIDGETS() { return (App.domains && App.domains.DEFAULT_WIDGETS) || []; },
    get: () => s,
  };
})();
