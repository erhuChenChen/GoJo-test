/* ===== 专注计时页（FocusTimer）=====
   入口：计时小窗上的「放大」按钮（.tmwin-btn.is-focus）。
   形态：全屏接管，中间一个圆环套着超大时钟，下面是待办名与备注，底部一颗「暂停 / 继续计时」。

   为什么挂在 body 上而不是 #view 里：
     #view 在路由入场时会被写 transform（见 app.js applyRouteEnter），
     transform 会让它成为 fixed 后代的包含块 —— 全屏层会跟着入场动画一起漂。

   为什么 z-index 53：
     要压住 .bottom-nav/.app-header(30) 与 .fab-layer(40)/.batch-bar(45)，还要压住
     整个编辑页 .page-sheet(50) —— 小窗的「放大」在编辑页里也能点，层级低于 50 就等于
     「点了什么也没发生」。但仍低于 .tmwin(55)、弹窗(56)、.popmenu(70)、.toast(80)：
     toast 与确认框要能盖在专注页上面。

   为什么进页要隐藏小窗：
     专注页本身就是全屏计时，再飘一颗小窗既重复又挡视线。由 App.records.setFocusMode 收口，
     关闭时复位，表还在跑的话小窗自己回来（不用在这里管 DOM）。

   圆环语义：本段已用秒数 / 3600 —— 一小时一圈，满圈归零继续走。
     从 0 起步，不预置任何进度（预置过的 3% 是假的，用户第一眼就看出不对）。
     只改 stroke-dashoffset 一个属性，不重建节点（每秒一次 DOM 重建在中低端机上会掉帧）。
*/
(function () {
  'use strict';
  const App = (window.App = window.App || {});

  const RING_R = 104;                    // 圆环半径（viewBox 240 内，两侧各留 16px 描边余量）
  const RING_C = 2 * Math.PI * RING_R;   // 周长
  const CYCLE_SEC = 3600;                // 一圈 = 一小时

  let page = null;        // 页面 DOM 缓存
  let off = null;         // App.timer.on 的退订函数
  let lastRun = null;     // 最后一次「运行中」的 { recId, stepId } —— 暂停后要靠它继续
  let lastSeg = null;     // 最后一次「运行中」的 { recId, stepId, segId } —— 暂停后备注还认得出是哪一段
  let closing = false;

  function records() {
    return (App.state && App.state.data && App.state.data.records) || [];
  }
  function findRec(id) {
    const list = records();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function build() {
    const U = App.ui;
    const el = U.el('div', { class: 'focus-page' });

    const closeBtn = U.el('button', { class: 'icon-btn fp-close', type: 'button', html: U.icon('x', 22), title: '退出专注' });
    closeBtn.setAttribute('aria-label', '退出专注');

    // 圆环：-90° 起点在 12 点（旋转写在 CSS 里，svg 本身不动）
    const ring = U.el('div', {
      class: 'fp-ring',
      html:
        '<svg viewBox="0 0 240 240" aria-hidden="true">' +
        '<circle class="fp-arc-bg" cx="120" cy="120" r="' + RING_R + '" fill="none" stroke-width="6"/>' +
        '<circle class="fp-arc" cx="120" cy="120" r="' + RING_R + '" fill="none" stroke-width="6" ' +
        'stroke-linecap="round" stroke-dasharray="' + RING_C.toFixed(2) + '" ' +
        'stroke-dashoffset="' + RING_C.toFixed(2) + '"/>' +
        '</svg>',
    });
    const clock = U.el('div', { class: 'fp-clock', text: '00:00' });
    ring.appendChild(clock);

    const name = U.el('div', { class: 'fp-name', text: '计时中' });
    const note = U.el('button', { class: 'fp-note', type: 'button', text: '加个备注' });
    const center = U.el('div', { class: 'fp-center' }, ring, name, note);

    const btn = U.el('button', { class: 'fp-btn', type: 'button' });
    const stateEl = U.el('div', { class: 'fp-state', text: '计时中' });
    const foot = U.el('div', { class: 'fp-foot' }, btn, stateEl);

    el.appendChild(closeBtn);
    el.appendChild(center);
    el.appendChild(foot);

    page = {
      el: el, clock: clock, ring: ring,
      arc: ring.querySelector('.fp-arc'),
      name: name, note: note, btn: btn, stateEl: stateEl,
    };

    closeBtn.addEventListener('click', () => api.close());

    // 备注就地改：专注页不该因为「想补一句备注」就把你踢回详情页。
    // 弹的是详情页/编辑页共用的那个输入弹窗（App.records.promptText），
    // 弹窗挂 #modal-root（层级 50）盖得住专注页（46），保存后留在本页、备注 chip 立刻变。
    note.addEventListener('click', () => {
      const c = lastSeg;
      if (!c || !c.segId) { App.ui.toast('这一段还没有备注', 'err'); return; }
      const rec = findRec(c.recId);
      const stp = rec && (rec.steps || []).find((s) => s.id === c.stepId);
      const seg = stp && (stp.segs || []).find((g) => g.id === c.segId);
      const cur = (seg && seg.note) || '';
      App.records.promptText('这一段在做什么', cur, '保存', async (v) => {
        try { await App.records.patchSegNote(c.recId, c.segId, v); }
        catch (_) { App.ui.toast('保存失败，请重试', 'err'); return; }
        if (!page) return;
        page.note.textContent = v || '加个备注';
        page.note.classList.toggle('is-empty', !v);
      });
    });

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        if (lastRun && App.timer.isRunning && App.timer.isRunning()) {
          await App.timer.stop();
        } else if (lastRun) {
          await App.timer.start(lastRun.recId, lastRun.stepId);
        }
      } catch (e) {
        U.toast('操作失败，请重试', 'err');
      }
      btn.disabled = false;
      paint(App.timer.state());
    });

    return page;
  }

  // 每秒调用；只写文本与一个 stroke 属性
  function paint(st) {
    if (!page) return;
    const s = st || { running: false, recId: null, stepId: null, segId: null, elapsedSec: 0 };
    if (s.running && s.recId) lastRun = { recId: s.recId, stepId: s.stepId };
    // 暂停后 state() 的 recId/segId 都会变 null，备注就「认不出是哪一段」了 —— 记下最后跑的这一段
    if (s.running && s.segId) lastSeg = { recId: s.recId, stepId: s.stepId, segId: s.segId };

    page.clock.textContent = App.ui.fmtClock(s.elapsedSec);

    // 圆环 = 本段（或本小时）已用时间 / 3600。不预置任何进度：
    // 曾经为了「前十几秒弧不到 1px 像空圈」硬留 3%，那是造假进度 —— 刚开始就该是空的。
    const frac = (Math.max(0, s.elapsedSec) % CYCLE_SEC) / CYCLE_SEC;
    page.arc.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(2);

    const rec = findRec(s.recId || (lastRun && lastRun.recId));
    const stepId = s.stepId || (lastRun && lastRun.stepId);
    const step = rec && (rec.steps || []).find((x) => x.id === stepId);
    const nameTxt = step ? (step.text || '未命名待办') : '计时中';
    if (page.name.textContent !== nameTxt) page.name.textContent = nameTxt;

    const segId = s.segId || (lastSeg && lastSeg.segId) || '';
    const seg = step && (step.segs || []).find((g) => g.id === segId);
    const noteTxt = (seg && seg.note) || '加个备注';
    if (page.note.textContent !== noteTxt) page.note.textContent = noteTxt;
    page.note.classList.toggle('is-empty', !(seg && seg.note));

    page.el.classList.toggle('is-paused', !s.running);
    page.stateEl.textContent = s.running ? '计时中' : '已暂停';

    // 主按钮：只在「暂停 ⇄ 继续」之间换，用 dataset 做 diff，别每秒重建
    const want = s.running ? 'pause' : 'play';
    if (page.btn.dataset.k !== want) {
      page.btn.dataset.k = want;
      App.ui.clear(page.btn);
      page.btn.appendChild(App.ui.el('span', { class: 'fp-btn-ic', html: App.ui.icon(want, 16) }));
      page.btn.appendChild(App.ui.el('span', { text: s.running ? '暂停' : '继续计时' }));
    }
  }

  const api = {
    isOpen: function () { return !!page; },

    open: function () {
      if (page || closing) return;
      if (!App.timer) return;
      const st = App.timer.state();
      if (!st || !st.running) { App.ui.toast('先在详情页开始计时', 'err'); return; }
      lastRun = { recId: st.recId, stepId: st.stepId };

      if (App.records && App.records.setFocusMode) {
        try { App.records.setFocusMode(true); } catch (_) {}
      }
      build();
      document.body.appendChild(page.el);
      off = App.timer.on(paint);
      paint(st);
      // 先挂上再亮，避免第一帧闪在默认态
      setTimeout(function () { if (page) page.el.classList.add('on'); }, 0);
    },

    close: function () {
      if (!page || closing) return;
      closing = true;
      if (off) { try { off(); } catch (_) {} off = null; }
      const el = page.el;
      const recId = lastRun && lastRun.recId;
      page = null;
      el.classList.remove('on');

      // 等淡出走完再恢复小窗：小窗 z-index 55 比专注页 46 高，
      // 立刻恢复会在淡出的这一帧里浮在专注页上面。
      setTimeout(function () {
        try { el.remove(); } catch (_) {}
        if (App.records && App.records.setFocusMode) {
          try { App.records.setFocusMode(false); } catch (_) {}
        }
        closing = false;
        // 脚底下还压着一份编辑页时，关专注页必须原样回到那份编辑状态：
        // 新建笔记时 hash 还是 #/record/new（甚至没进过详情页），go() 会把整页抽走、草稿丢失。
        const sheetOpen = !!document.querySelector('.page-sheet');
        if (!sheetOpen && recId && (location.hash || '') !== '#/record/' + recId) {
          try { App.app.go('record/' + recId); } catch (_) {}
        }
      }, 190);
    },
  };

  App.focus = api;
})();
