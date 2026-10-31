/* ===== dashboard.js — 可自定义仪表盘（按领域隔离） ===== */
window.App = window.App || {};
App.dashboard = (function () {
  const U = () => App.ui;

  function sumTime(r) { return r.reduce((a, x) => a + (x.timeSpentMin || 0), 0); }
  function sumInc(r) { return r.reduce((a, x) => a + (Number(x.income) || 0), 0); }
  function sumExp(r) { return r.reduce((a, x) => a + (Number(x.expense) || 0), 0); }

  // 可用组件目录
  const CATALOG = [
    { key: 'totalTime', label: '累计投入时长', icon: 'clock', kind: 'stat', compute: (d, r) => { const m = sumTime(r); return { value: m >= 60 ? (m / 60).toFixed(1) + ' h' : m + ' 分', sub: (d.timeLabel || '投入') + ' · ' + r.length + ' 条' }; } },
    { key: 'goalProgress', label: '目标完成进度', icon: 'target', kind: 'goals', compute: (d, r) => {
        const goals = (d.goals || []).map((g) => {
          let cur = 0;
          if (g.mode === 'manual' || g.valueManual) cur = Number(g.value) || 0;
          else if (g.metric === 'records') cur = r.length;
          else if (g.metric === 'hours') cur = sumTime(r) / 60;
          else if (g.metric === 'income') cur = sumInc(r);
          else if (g.metric === 'expense') cur = sumExp(r);
          const p = g.target ? Math.min(1, cur / g.target) : 0;
          // colorTarget 必须一并带出来：仪表盘要跟设置页保持同一套「上色对象」配置
          return { id: g.id, name: g.name, current: cur, target: g.target, progress: p, color: g.color, mode: g.mode, metric: g.metric, style: g.style || 'bar', colorTarget: g.colorTarget === 'card' ? 'card' : 'bar' };
        });
        return { goals };
      } },
    { key: 'totalRecords', label: '记录总条数', icon: 'records', kind: 'stat', compute: (d, r) => ({ value: String(r.length), unit: '条', sub: '全部记录' }) },
    { key: 'income', label: '收入汇总', icon: 'wallet', kind: 'stat', compute: (d, r) => ({ value: U().fmtMoney(sumInc(r)), sub: '累计收入' }) },
    { key: 'expense', label: '支出汇总', icon: 'wallet', kind: 'stat', compute: (d, r) => ({ value: U().fmtMoney(sumExp(r)), sub: '累计支出' }) },
    { key: 'net', label: '净收益', icon: 'wallet', kind: 'stat', compute: (d, r) => ({ value: U().fmtMoney(sumInc(r) - sumExp(r)), sub: '收入 − 支出' }) },
    { key: 'monthRecords', label: '本月记录', icon: 'calendar', kind: 'stat', compute: (d, r) => { const mk = U().monthKey(Date.now()); const c = r.filter((x) => U().monthKey(x.date || x.createdAt) === mk).length; return { value: String(c), unit: '条', sub: '本月新增' }; } },
    { key: 'categoryDist', label: '分类分布', icon: 'tag', kind: 'dist', compute: (d, r) => { const map = {}; r.forEach((x) => { const c = d.categories.find((cc) => cc.id === x.categoryId); const name = c ? c.name : '未分类'; map[name] = (map[name] || 0) + 1; }); const dist = Object.keys(map).map((k) => ({ name: k, count: map[k] })).sort((a, b) => b.count - a.count); const max = dist.length ? dist[0].count : 1; return { dist, max }; } },
  ];

  // —— 时间段筛选：统一成 YYYY-MM-DD 再做字符串比较（无循环）——
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function dayKey(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function rangeOf(cfg) {
    const t = cfg && cfg.timeRange;
    if (!t || t === 'all') return { start: '', end: '' };
    if (t === 'custom') return { start: cfg.startDate || '', end: cfg.endDate || '' };
    const now = new Date();
    const today = dayKey(now);
    if (t === 'month') return { start: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-01', end: today };
    if (t === 'year') return { start: now.getFullYear() + '-01-01', end: today };
    if (t === '30d') { const s = new Date(now.getTime() - 29 * 86400000); return { start: dayKey(s), end: today }; }
    return { start: '', end: '' };
  }

  function makeCustomCompute(cfg) {
    return (d, recs) => {
      let vals = recs.slice();
      if (cfg.catFilter) vals = vals.filter((r) => r.categoryId === cfg.catFilter);
      if (cfg.tagFilter) vals = vals.filter((r) => (r.tagIds || []).includes(cfg.tagFilter));
      if (cfg.cfFilter) { const opt = cfg.cfValue || null; vals = vals.filter((r) => { const v = ((r.customValues) || {})[cfg.cfFilter]; return opt ? v === opt : !!v; }); }
      const rg = rangeOf(cfg);
      if (rg.start || rg.end) {
        vals = vals.filter((r) => {
          const k = dayKey(r.date || r.createdAt);
          if (!k) return false;
          if (rg.start && k < rg.start) return false;
          if (rg.end && k > rg.end) return false;
          return true;
        });
      }
      if (cfg.field === 'records') return { value: String(vals.length), unit: '条', sub: cfg.label };
      if (cfg.field === 'time') { const m = sumTime(vals); return { value: m >= 60 ? (m / 60).toFixed(1) + ' h' : m + ' 分', sub: cfg.label }; }
      if (cfg.field === 'income') return { value: U().fmtMoney(sumInc(vals)), sub: cfg.label };
      if (cfg.field === 'expense') return { value: U().fmtMoney(sumExp(vals)), sub: cfg.label };
      return { value: '—', sub: cfg.label };
    };
  }

  function defForWidget(w) {
    if (w.custom) return { key: w.key, label: w.label, icon: 'star', kind: 'stat', compute: makeCustomCompute(w.custom) };
    return CATALOG.find((c) => c.key === w.key);
  }

  function goalValueText(g) {
    if (g.metric === 'income' || g.metric === 'expense') return U().fmtMoney(g.current) + ' / ' + U().fmtMoney(g.target);
    if (g.metric === 'hours') return g.current.toFixed(1) + ' h / ' + g.target + ' h';
    return Math.round(g.current) + ' / ' + g.target + ' 条';
  }

  // 真正的中空甜甜圈圆环（SVG 细线条，强调色来自 g.color）
  function buildDonut(progress, color) {
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    const wrap = U().el('div', { class: 'goal-donut' });
    wrap.innerHTML = '<svg viewBox="0 0 36 36"><circle class="gd-track" cx="18" cy="18" r="15.9155"/><circle class="gd-prog" cx="18" cy="18" r="15.9155" stroke="' + color + '" stroke-dasharray="' + pct + ' ' + (100 - pct) + '"/></svg><div class="gd-label">' + pct + '%</div>';
    return wrap;
  }

  // 目标配色：背景上色时，文字/进度/圆环统一改成与底色对比的墨色
  function inkOf(bg) { return App.themes.textOn(bg); }
  function isInkDark(ink) { return App.themes.luminance(ink) < 0.5; }
  function inkSoft(ink, a) { return isInkDark(ink) ? 'rgba(20,24,32,' + a + ')' : 'rgba(255,255,255,' + a + ')'; }

  // 单个目标独立卡片（支持 bar / ring 进度样式，强调色来自 g.color）
  // colorTarget === 'card' 时整卡铺纯色实底，进度条/圆环/文字改用对比墨色，与设置页保持一致
  function buildGoalCard(g, domain) {
    const color = g.color || '#8b9cff';
    const tintCard = g.colorTarget === 'card';
    const card = U().el('div', { class: 'widget goal-card' + (tintCard ? ' goal-solid' : '') });
    let ink = color;          // 进度条 / 圆环填充色：默认就是目标色
    let trackColor = '';      // 进度条轨道 / 圆环底环
    if (tintCard) {
      ink = inkOf(color);
      trackColor = inkSoft(ink, 0.28);
      card.style.background = color;          // 不透明实色（同时清掉 .widget 自带的高光渐变）
      card.style.borderColor = 'transparent';
      card.style.color = ink;
      card.style.boxShadow = App.themes.shadowFor(color, color) + ', inset 0 1px 0 ' + inkSoft(ink, 0.14);
      card.style.setProperty('--text', ink);
      card.style.setProperty('--text-dim', inkSoft(ink, 0.72));
      card.style.setProperty('--surface-2', inkSoft(ink, 0.16));
      card.style.setProperty('--border', inkSoft(ink, 0.24));
      card.style.setProperty('--tint-ink', ink);
      card.style.setProperty('--tint-soft', inkSoft(ink, 0.16));
      card.style.setProperty('--tint-line', inkSoft(ink, 0.3));
      card.style.setProperty('--tint-bg', color);
    }
    card.appendChild(U().el('div', { class: 'w-label' }, U().iconEl('target', 18), U().el('span', { text: g.name })));
    card.appendChild(U().el('div', { class: 'w-sub', text: goalValueText(g) }));
    if (g.style === 'ring') {
      const donut = buildDonut(g.progress, ink);
      if (tintCard) {
        const track = donut.querySelector('.gd-track');
        if (track) track.style.stroke = trackColor; // CSS 的 stroke 会盖掉属性，必须写内联 style
      }
      card.appendChild(donut);
    } else {
      card.appendChild(U().el('div', { class: 'progress', style: tintCard ? { background: trackColor } : null },
        U().el('span', { style: { width: (100 * g.progress) + '%', background: ink } })));
    }
    if (g.mode === 'manual') {
      const actions = U().el('div', { class: 'gr-actions' });
      const plus1 = U().el('button', { class: 'btn tiny', text: '+1' });
      plus1.addEventListener('click', () => nudgeGoal(g.id, 1));
      const addN = U().el('button', { class: 'btn tiny primary', text: '+n' });
      // +n 的颜色跟随目标配色：上色到进度条时用目标色底 + 对比字；上色到卡片时用墨色底 + 反相字
      addN.style.background = ink;
      addN.style.borderColor = ink;
      addN.style.color = inkOf(ink);
      addN.style.fontWeight = '800';
      addN.addEventListener('click', () => promptAddValue(g.id));
      actions.appendChild(plus1); actions.appendChild(addN);
      card.appendChild(actions);
    }
    return card;
  }

  // 返回卡片数组（目标组件会返回多张独立卡片）
  function widgetCard(def, domain, records) {
    const r = def.compute(domain, records);
    if (def.kind === 'goals') {
      if (!r.goals.length) return [U().el('div', { class: 'widget span-2' }, U().el('div', { class: 'w-label' }, U().iconEl(def.icon, 18), U().el('span', { text: def.label })), U().el('div', { class: 'muted', text: '暂无目标，去设置里添加' }))];
      return r.goals.map((g) => buildGoalCard(g, domain));
    }
    const card = U().el('div', { class: 'widget' + (def.kind === 'dist' ? ' span-2' : '') });
    card.appendChild(U().el('div', { class: 'w-label' }, U().iconEl(def.icon, 18), U().el('span', { text: def.label })));
    if (def.kind === 'dist') {
      if (!r.dist || !r.dist.length) card.appendChild(U().el('div', { class: 'muted', text: '暂无数据' }));
      else r.dist.forEach((d) => {
        card.appendChild(U().el('div', { class: 'dist-row' },
          U().el('div', { class: 'dr-name', text: d.name }),
          U().el('div', { class: 'dr-bar' }, U().el('span', { style: { width: (100 * d.count / r.max) + '%' } })),
          U().el('div', { class: 'dr-val', text: String(d.count) })));
      });
    } else {
      card.appendChild(U().el('div', { class: 'w-value', html: r.value + (r.unit ? '<small>' + r.unit + '</small>' : '') }));
      if (r.sub) card.appendChild(U().el('div', { class: 'w-sub', text: r.sub }));
    }
    return [card];
  }

  // 手动目标：添加数值（与目标页共用同一个居中弹窗）
  function promptAddValue(goalId) {
    const d = App.state.currentDomain();
    const g = d ? (d.goals || []).find((x) => x.id === goalId) : null;
    U().promptNumber({
      title: '添加数值',
      tip: g ? '当前进度：' + (Number(g.value) || 0) + ' / ' + (Number(g.target) || 0) : '',
      onConfirm: (v) => nudgeGoal(goalId, v),
    });
  }

  // 推进手动目标
  async function nudgeGoal(goalId, delta) {
    const d = App.state.currentDomain(); if (!d) return;
    const g = (d.goals || []).find((x) => x.id === goalId); if (!g) return;
    g.value = (Number(g.value) || 0) + delta;
    await App.db.saveDomain(d); await App.state.reloadDomains();
    const view = App.app.view; if (view) render(view);
  }

  // —— 标星强调：★ 卡片铺主题强调色实色，文字/进度改高对比墨色 ——
  function currentAccent() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      return v || '#8b9cff';
    } catch (e) { return '#8b9cff'; }
  }
  function applyStar(card) {
    const accent = currentAccent();
    const ink = App.themes.textOn(accent);
    const darkInk = App.themes.luminance(ink) < 0.5;
    const soft = darkInk ? 'rgba(18,22,30,0.16)' : 'rgba(255,255,255,0.22)';
    const dim = darkInk ? 'rgba(18,22,30,0.72)' : 'rgba(255,255,255,0.86)';
    card.classList.add('w-starred');
    card.style.background = accent;
    card.style.borderColor = 'transparent';
    card.style.color = ink;
    card.style.boxShadow = App.themes.shadowFor(accent, accent) + ', inset 0 1px 0 ' + (darkInk ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.40)');
    card.style.setProperty('--text', ink);
    card.style.setProperty('--text-dim', dim);
    card.style.setProperty('--surface-2', soft);
    card.style.setProperty('--border', soft);
    card.style.setProperty('--accent', ink);
    card.style.setProperty('--accent-soft', soft);
    // 卡片里所有「用颜色画」的元素一并换成对比墨色，避免同色糊在一起
    // 注意：圆环要用 style 而不是 setAttribute('stroke')，CSS 里的 stroke 会盖掉属性
    card.querySelectorAll('.gd-prog').forEach((el) => { el.style.stroke = ink; });
    card.querySelectorAll('.gd-track').forEach((el) => { el.style.stroke = soft; });
    card.querySelectorAll('.progress').forEach((el) => { el.style.background = soft; });
    card.querySelectorAll('.progress > span').forEach((el) => { el.style.background = ink; });
    card.querySelectorAll('.dr-bar').forEach((el) => { el.style.background = soft; });
    card.querySelectorAll('.dr-bar > span').forEach((el) => { el.style.background = ink; });
    card.querySelectorAll('.btn.tiny').forEach((el) => { el.style.background = soft; el.style.borderColor = soft; el.style.color = ink; });
    card.querySelectorAll('.btn.tiny.primary').forEach((el) => { el.style.background = ink; el.style.borderColor = ink; el.style.color = accent; });
    return card;
  }

  async function render(container) {
    const domain = App.state.currentDomain();
    const records = App.state.data.records;
    U().clear(container);
    if (!domain) { container.appendChild(U().el('div', { class: 'empty-state', text: '请先在设置中添加领域' })); return; }

    const grid = U().el('div', { class: 'dash-grid' });
    const widgets = (domain.dashboardWidgets || []).filter((w) => w.enabled);
    if (!widgets.length) {
      container.appendChild(U().el('div', { class: 'card', style: { textAlign: 'center' } },
        U().el('p', { class: 'muted', text: '还没有启用任何统计组件。' }),
        (() => { const b = U().el('button', { class: 'btn primary', text: '去设置里配置' }); b.addEventListener('click', () => App.app.go('settings')); return b; })()));
      return;
    }
    widgets.forEach((w) => {
      const def = defForWidget(w);
      if (!def) return;
      widgetCard(def, domain, records).forEach((n) => { if (w.starred) applyStar(n); grid.appendChild(n); });
    });
    container.appendChild(grid);
  }

  return { CATALOG, render, defForWidget, makeCustomCompute, nudgeGoal };
})();
