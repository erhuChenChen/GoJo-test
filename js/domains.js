/* ===== domains.js — 领域预设与创建 ===== */
window.App = window.App || {};
App.domains = (function () {
  const PALETTE = ['#8b9cff', '#4ec98a', '#ffb86b', '#ff6b9d', '#5ad0e0', '#c08bff', '#f0d264', '#ff8f6b', '#7ed3a8', '#9aa7ff'];

  function colorFor(i) { return PALETTE[i % PALETTE.length]; }

  // 默认仪表盘组件（字段下放到领域，避免串台；此处为权威默认值）
  const DEFAULT_WIDGETS = [
    { key: 'totalTime', label: '累计投入时长', enabled: true },
    { key: 'goalProgress', label: '目标完成进度', enabled: true },
    { key: 'totalRecords', label: '记录总条数', enabled: true },
    { key: 'income', label: '收入汇总', enabled: true },
    { key: 'expense', label: '支出汇总', enabled: true },
    { key: 'net', label: '净收益', enabled: false },
    { key: 'monthRecords', label: '本月记录', enabled: false },
    { key: 'categoryDist', label: '分类分布', enabled: false },
  ];

  // 默认目标配色（与 PALETTE 错开，便于多目标区分）
  const GOAL_PALETTE = ['#8b9cff', '#4ec98a', '#ffb86b', '#ff6b9d', '#5ad0e0', '#c08bff', '#f0d264', '#ff8f6b'];

  function makeGoal(name, metric, target, i) {
    return { id: App.storage.uid(), name: name || '目标', metric: metric || 'records', target: target || 20, mode: 'auto', value: 0, color: GOAL_PALETTE[i % GOAL_PALETTE.length], style: 'bar', colorTarget: 'bar' };
  }
  function makeField(name, i) { return { id: App.storage.uid(), name: name || '属性', type: 'select', options: [] }; }

  const PRESETS = {
    drawing: {
      key: 'drawing', name: '画画', icon: '🎨', timeLabel: '绘画时长',
      categories: ['素描', '水彩', '油画', '数字绘画', '速写'],
      tags: ['练习', '临摹', '原创', '约稿', '商稿'],
      goals: [makeGoal('本月作品目标', 'records', 30, 0)],
    },
    fitness: {
      key: 'fitness', name: '健身', icon: '🏋️', timeLabel: '训练时长',
      categories: ['力量', '有氧', '瑜伽', '拉伸', '户外'],
      tags: ['增肌', '减脂', '打卡', '受伤恢复'],
      goals: [makeGoal('本月训练小时', 'hours', 20, 1)],
    },
    reading: {
      key: 'reading', name: '读书', icon: '📚', timeLabel: '阅读时长',
      categories: ['小说', '非虚构', '专业书', '漫画'],
      tags: ['精读', '速读', '写笔记', '推荐'],
      goals: [makeGoal('本月阅读小时', 'hours', 15, 2)],
    },
    custom: {
      key: 'custom', name: '自定义', icon: '✨', timeLabel: '投入时长',
      categories: [], tags: [], goals: [makeGoal('目标', 'records', 20, 0)],
    },
  };

  function makeCat(name, i) { return { id: App.storage.uid(), name, color: colorFor(i) }; }
  function makeTag(name, i) { return { id: App.storage.uid(), name, color: colorFor(i + 4) }; }

  // 从预设创建领域对象（分类/标签/目标重新生成 id）
  function createFromPreset(key, customName) {
    const p = PRESETS[key] || PRESETS.custom;
    return {
      id: App.storage.uid(),
      type: key === 'custom' ? 'custom' : 'preset',
      key,
      name: customName || p.name,
      icon: p.icon,
      timeLabel: p.timeLabel,
      categories: (p.categories || []).map(makeCat),
      tags: (p.tags || []).map(makeTag),
      goals: (p.goals || []).map((g, i) => makeGoal(g.name, g.metric, g.target, i)),
      customFields: [],
      cardFields: [],
      dashboardWidgets: DEFAULT_WIDGETS.map((w) => Object.assign({}, w)),
      createdAt: App.storage.now(),
    };
  }

  // 纯自定义：用户提供名称 + 分类字符串数组
  function createCustom(name, categoryNames) {
    const cats = (categoryNames || []).filter(Boolean).map(makeCat);
    return {
      id: App.storage.uid(),
      type: 'custom', key: 'custom', name: name || '我的领域', icon: '✨',
      timeLabel: '投入时长',
      categories: cats.length ? cats : [makeCat('未分类', 0)],
      tags: [],
      goals: [makeGoal('目标', 'records', 20, 0)],
      customFields: [],
      cardFields: [],
      dashboardWidgets: DEFAULT_WIDGETS.map((w) => Object.assign({}, w)),
      createdAt: App.storage.now(),
    };
  }

  return { PRESETS, createFromPreset, createCustom, colorFor, makeCat, makeTag, makeGoal, makeField, DEFAULT_WIDGETS, GOAL_PALETTE };
})();
