/* ===== timer.js — 单例计时内核（同一时刻全局只有一段在跑）=====
 *
 * 三条硬规则（都是踩过坑才定下来的）：
 *  ① 只存绝对时间戳 start / end，任何读数都用 Date.now() 现算 —— 切后台、锁屏、
 *    系统冻结定时器都不影响精度，也不存在「定时器累加漂移」。
 *  ② 运行期间【不写库】：开始写一次（段里 end:null），结束写一次；中间只写 60s 一次心跳。
 *    每秒写库会把 IndexedDB 打爆。
 *  ③ 显示刷新用 setTimeout 一秒一跳 —— requestAnimationFrame 在页面不可见 / WebView 被暂停时
 *    不回调，一旦那次没跑，读数就会永久停住（README 里已经记过这条）。
 *
 * 与编辑器的关系：编辑器只是「订阅读数 + 调 start/stop」的一层皮。
 * 数据一律走 App.db.patchRecord（只改 steps / timeSpentMin），
 * 绝不整条 saveRecord —— 那会把编辑器里尚未保存的标题、正文、图片写成旧值。
 * 编辑页关掉后计时继续跑（段已落库，end 仍为 null），下次打开同一篇笔记会自动接上。
 */
window.App = window.App || {};
App.timer = (function () {
  const TICK_MS = 1000;
  const BEAT_MS = 60 * 1000;
  const MAX_SEG_SEC = 8 * 3600;   // 单段硬上限：忘了停也不会凭空多出几十小时

  let running = null;             // { recId, stepId, segId, start }
  let tickTimer = 0, beatTimer = 0;
  const subs = [];

  function syncTime() {
    return (App.records && App.records.syncTimeFromSteps) ? App.records.syncTimeFromSteps : null;
  }

  function elapsedSec() {
    if (!running) return 0;
    return Math.max(0, Math.min(MAX_SEG_SEC, Math.floor((Date.now() - running.start) / 1000)));
  }

  function state() {
    if (!running) return { running: false, recId: null, stepId: null, segId: null, start: 0, elapsedSec: 0 };
    return {
      running: true,
      recId: running.recId, stepId: running.stepId, segId: running.segId,
      start: running.start, elapsedSec: elapsedSec(),
    };
  }

  function emit() {
    const st = state();
    subs.slice().forEach((fn) => { try { fn(st); } catch (e) {} });
  }

  // 订阅读数。返回一个取消函数 —— 编辑页关闭时必须调用，
  // 否则会一直往已经卸载的节点上写字（records.js 里 activeDescI 踩过同样的坑）。
  function on(fn) {
    subs.push(fn);
    return function off() { const i = subs.indexOf(fn); if (i > -1) subs.splice(i, 1); };
  }

  function startTick() {
    if (tickTimer) return;
    (function loop() {
      tickTimer = setTimeout(() => {
        tickTimer = 0;
        if (!running) return;
        emit();
        loop();
      }, TICK_MS);
    })();
  }
  function stopTick() { if (tickTimer) { clearTimeout(tickTimer); tickTimer = 0; } }

  function beat() {
    if (!running) return;
    try {
      App.db.setKV('timerHeartbeat', { segId: running.segId, recId: running.recId, at: Date.now() });
    } catch (e) {}
  }
  function startBeat() { if (beatTimer) return; beatTimer = setInterval(beat, BEAT_MS); }
  function stopBeat() { if (beatTimer) { clearInterval(beatTimer); beatTimer = 0; } }

  // 把 steps 里的总时长同步进 timeSpentMin（手填优先的规则在 records.js 里，只有一份实现）
  function withTime(rec) {
    const sync = syncTime();
    if (!sync) return { steps: rec.steps };
    const tmp = { steps: rec.steps, timeSpentMinManual: rec.timeSpentMinManual, timeSpentMin: rec.timeSpentMin };
    sync(tmp, rec.timeSpentMin == null ? null : rec.timeSpentMin);
    return { steps: rec.steps, timeSpentMin: tmp.timeSpentMin };
  }

  // 开始一段。recId 为空（还没保存过的新笔记）直接拒绝 —— 编辑器会先静默暂存一条再调这里。
  async function start(recId, stepId) {
    if (!recId) return { ok: false, reason: 'nosave' };
    const prev = running ? { recId: running.recId, stepId: running.stepId } : null;
    if (running) await stop();          // ★ 互斥：先结束上一段（不带 done，别把上一步误标完成）
    const seg = { id: App.storage.uid(), start: Date.now(), end: null, note: '' };
    let found = false;
    try {
      await App.db.patchRecord(recId, (rec) => {
        const step = (rec.steps || []).find((s) => s.id === stepId);
        if (!step) return null;
        if (!Array.isArray(step.segs)) step.segs = [];
        step.segs.push(seg);
        found = true;
        return withTime(rec);           // 开始即落库：进程被杀也能找回来
      });
    } catch (e) { return { ok: false, reason: 'error' }; }
    if (!found) return { ok: false, reason: 'nostep' };
    running = { recId: recId, stepId: stepId, segId: seg.id, start: seg.start };
    startTick(); startBeat(); emit();
    return { ok: true, prev: prev, segId: seg.id };
  }

  // 结束当前段。opts.done === true 时顺带把这条待办标记完成（⏹「结束并完成」）。
  // 暂停与完成在数据上是同一次写入：seg.end 与 step.done 必须在**同一个 patchRecord 回调**里，
  // 否则两次写库中间被杀就会留下「段结束了但没打勾」或反之。
  // 不依赖编辑器的局部数组：一律读库再改，所以就算编辑器已经关了也能正确收口。
  async function stop(opts) {
    if (!running) return null;
    const done = !!(opts && opts.done);
    const r = running;
    running = null;
    stopTick(); stopBeat();
    const sec = Math.round((Date.now() - r.start) / 1000);
    try {
      await App.db.patchRecord(r.recId, (rec) => {
        const step = (rec.steps || []).find((s) => s.id === r.stepId);
        const seg = step && (step.segs || []).find((s) => s.id === r.segId);
        if (!seg || seg.end != null) return null;
        const now = Date.now();
        seg.end = Math.min(now, seg.start + MAX_SEG_SEC * 1000);
        if (done && step) { step.done = true; step.doneAt = now; }
        return withTime(rec);
      });
    } catch (e) {}
    try { App.db.setKV('timerHeartbeat', null); } catch (e) {}
    emit();
    return { sec: sec, stepId: r.stepId, done: done };
  }

  // 启动时收口：扫一遍所有 end == null 的段。
  // 有心跳就用心跳时刻（误差 ≤ 60s）；没有心跳（升级前的遗留 / 心跳写失败）按 0 秒收口，
  // 宁可少算也不给用户凭空多出几个小时。
  async function init() {
    let all = [];
    try { all = (await App.db.getRecords()) || []; } catch (e) { return; }
    let hb = null;
    try { hb = await App.db.getKV('timerHeartbeat', null); } catch (e) {}
    const fixed = [];
    for (let i = 0; i < all.length; i++) {
      const rec = all[i];
      let touched = false;
      (rec.steps || []).forEach((step) => {
        (step.segs || []).forEach((seg) => {
          if (seg.end != null) return;
          let cut = (hb && hb.segId === seg.id && hb.at) ? hb.at : seg.start;
          cut = Math.max(seg.start, Math.min(cut, seg.start + MAX_SEG_SEC * 1000));
          seg.end = cut;
          touched = true;
          fixed.push(Math.round((cut - seg.start) / 1000));
        });
      });
      if (touched) {
        try {
          const next = Object.assign({}, rec, withTime(rec), { updatedAt: App.storage.now() });
          await App.db.saveRecord(next);
        } catch (e) {}
      }
    }
    if (hb) { try { await App.db.setKV('timerHeartbeat', null); } catch (e) {} }
    if (fixed.length) {
      const sec = fixed.reduce((a, x) => a + x, 0);
      try { App.ui.toast('上次计时未正常结束，已自动结束（' + App.ui.fmtClock(sec) + '）', 'err'); } catch (e) {}
    }
  }

  // 切后台 / 回前台：不用补偿（时间戳法天然正确），只需要「回来立刻重绘」——
  // 后台期间定时器可能被冻结，画面会停在旧数字上。
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { if (running) { startTick(); emit(); } }
      else beat();
    }, false);
  } catch (e) {}
  try {
    document.addEventListener('resume', () => {        // 5+ 真机从后台恢复
      if (running) { startTick(); beat(); emit(); }
    }, false);
  } catch (e) {}

  return { start: start, stop: stop, init: init, on: on, state: state, isRunning: function () { return !!running; } };
})();
