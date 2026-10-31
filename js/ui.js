/* ===== ui.js — DOM 助手 / 图标 / 弹窗 / 灯箱 / 缩略图 ===== */
window.App = window.App || {};
App.ui = (function () {
  // —— 元素创建 ——
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    kids.flat().forEach((c) => {
      if (c == null || c === false) return;
      if (typeof c === 'string' || typeof c === 'number') n.appendChild(document.createTextNode(String(c)));
      else n.appendChild(c);
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function mount(view, node) { clear(view); view.appendChild(node); return node; }

  // —— 图标 ——
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/>',
    records: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    more: '<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
    images: '<rect x="8" y="3" width="13" height="13" rx="2.2"/><path d="M16 21H5a2 2 0 0 1-2-2V8"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    star: '<path d="M12 2l3 6.5 7 .9-5 4.8 1.3 7L12 17.8 5.4 21l1.3-7-5-4.8 7-.9z"/>',
    starFill: '<path d="M12 2l3 6.5 7 .9-5 4.8 1.3 7L12 17.8 5.4 21l1.3-7-5-4.8 7-.9z" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 11.8V5a2 2 0 0 1 2-2h6.8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M16 12h.01M3 10h18"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    sort: '<path d="M3 6h12M3 12h9M3 18h6M17 8l3-3 3 3M20 5v14M17 16l3 3 3-3"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    single: '<rect x="4" y="3" width="16" height="18" rx="2.6"/><path d="M4 13.5l3.6-3.2 3.4 3 2.8-2.4 5.2 4.6"/><circle cx="9" cy="8" r="1.5"/>',
  };
  function icon(name, size) {
    const s = size || 24;
    const inner = ICONS[name] || '';
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function iconEl(name, size, cls) { const s = el('span', { class: cls || '', html: icon(name, size) }); s.style.display = 'inline-flex'; return s; }

  // —— Toast ——
  function toast(msg, type) {
    const root = document.getElementById('toast-root');
    const t = el('div', { class: 'toast' + (type ? ' ' + type : ''), text: msg });
    root.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, 2200);
  }

  // —— 弹窗 ——
  // 所有弹窗的 close 都进一个栈：物理返回键要「先关最上面那层」，而不是直接退页面。
  const modalStack = [];
  function modal({ title, body, actions, wide, onClose, center }) {
    const root = document.getElementById('modal-root');
    const backdrop = el('div', { class: 'modal-backdrop' + (center ? ' center' : '') });
    const closeBtn = el('button', { class: 'icon-btn close-x', html: icon('x', 22) });
    const head = el('div', { class: 'modal-head' }, el('h3', { text: title || '' }), closeBtn);
    const m = el('div', { class: 'modal' + (wide ? ' wide' : '') + (center ? ' center' : '') }, head);
    function close() {
      const i = modalStack.indexOf(close);
      if (i > -1) modalStack.splice(i, 1);
      backdrop.remove();
      if (onClose) onClose();
    }
    modalStack.push(close);
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    // 内容区域单独可滚动，使底部按钮固定在弹窗最底部（不被顶出屏幕）
    const bodyWrap = el('div', { class: 'modal-body' });
    if (typeof body === 'string') { const b = el('div', { html: body }); bodyWrap.appendChild(b); }
    else if (body) bodyWrap.appendChild(body);
    m.appendChild(bodyWrap);
    const footer = el('div', { class: 'modal-foot' });
    (actions || []).forEach((a) => {
      const b = el('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), text: a.label });
      b.addEventListener('click', () => { if (a.onClick) a.onClick(close); else close(); });
      footer.appendChild(b);
    });
    if (actions && actions.length) m.appendChild(footer);
    backdrop.appendChild(m);
    root.appendChild(backdrop);
    return { close, el: m, body: m };
  }

  // —— 统一的「+n 数值」居中弹窗（仪表盘 / 目标页共用，UI 完全一致）——
  function promptNumber({ title, tip, placeholder, okLabel, onConfirm }) {
    const numI = el('input', { class: 'input', type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: placeholder || '输入要增加的数值' });
    const body = el('div', { class: 'goal-dialog' },
      tip ? el('div', { class: 'goal-dialog-tip', text: tip }) : null,
      numI);
    function submit(closeFn) {
      const v = Number(numI.value) || 0;
      if (v <= 0) { toast('请输入大于 0 的数值', 'err'); return; }
      closeFn();
      if (onConfirm) onConfirm(v);
    }
    const dlg = modal({
      title: title || '添加数值',
      body,
      center: true,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: okLabel || '确定', primary: true, onClick: (c) => submit(c) },
      ],
    });
    numI.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(dlg.close); } });
    setTimeout(() => numI.focus(), 60);
    return dlg;
  }

  function confirmDialog(msg, { okLabel, danger } = {}) {
    return new Promise((resolve) => {
      modal({
        title: '请确认', body: el('p', { text: msg, style: { color: 'var(--text-dim)' } }),
        actions: [
          { label: '取消', onClick: (c) => { c(); resolve(false); } },
          { label: okLabel || '确定', primary: !danger, danger, onClick: (c) => { c(); resolve(true); } },
        ],
      });
    });
  }

  // —— 缩略图生成（同时产出压缩原图 + 3:4 竖版封面缩略图）——
  function canvasToBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob((b) => res(b), type, q)); }

  /* 画质要点（旧实现“马赛克”的两个根因）：
     ① canvas 2d 的 imageSmoothingQuality 默认是 low，把一张 4000px 的手机照片
        一步 drawImage 到 400px，采样不足 → 出现锯齿 + 摩尔纹，看起来就是马赛克；
     ② 缩略图长边只有 400px，而卡片封面在 3x 屏上要 500~1000 物理像素，
        于是又被二次放大 → 糊成一片。
     解决：ctx 一律 high 质量 + 渐进式减半缩放（每次 ≤1/2，避免一次跨度过大失真），
     缩略图直接按卡片比例（3:4）居中裁切并生成 720×960，卡片里 1:1 呈现不再缩放。 */
  const COVER_W = 900, COVER_H = 1200;
  function ctx2d(c) { const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return x; }
  function resample(src, sx, sy, sw, sh, tw, th) {
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    while (cw >= tw * 2 && ch >= th * 2) {
      const half = document.createElement('canvas');
      half.width = Math.round(cw / 2); half.height = Math.round(ch / 2);
      ctx2d(half).drawImage(cur, cx, cy, cw, ch, 0, 0, half.width, half.height);
      cur = half; cx = 0; cy = 0; cw = half.width; ch = half.height;
    }
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    ctx2d(out).drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
    return out;
  }
  // 按 3:4 居中裁切（object-fit: cover 的效果，但在压缩阶段就裁好，画质损失最小）
  function coverCanvas(img, tw, th) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const ir = iw / ih, tr = tw / th;
    let sw, sh, sx, sy;
    if (ir > tr) { sh = ih; sw = Math.round(sh * tr); sx = Math.round((iw - sw) / 2); sy = 0; }
    else { sw = iw; sh = Math.round(sw / tr); sx = 0; sy = Math.round((ih - sh) / 2); }
    return resample(img, sx, sy, sw, sh, tw, th);
  }
  // 由 Blob 生成封面缩略图（旧数据后台补清晰时复用）
  function makeCoverBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try { canvasToBlob(coverCanvas(img, COVER_W, COVER_H), 'image/jpeg', 0.84).then(resolve).catch(reject); }
        catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }
  function makeThumb(file, maxFull) {
    maxFull = maxFull || 2048;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          function dims(max) { const m = Math.max(w, h); if (m <= max) return { w: w, h: h }; const s = max / m; return { w: Math.round(w * s), h: Math.round(h * s) }; }
          const fd = dims(maxFull);
          const isPng = file.type === 'image/png';
          const fullType = isPng ? 'image/png' : 'image/jpeg';
          Promise.all([
            canvasToBlob(resample(img, 0, 0, w, h, fd.w, fd.h), fullType, isPng ? 0.95 : 0.84),
            canvasToBlob(coverCanvas(img, COVER_W, COVER_H), 'image/jpeg', 0.84),
          ]).then(([full, thumb]) => {
            resolve({ blob: full, thumbBlob: thumb, thumbW: COVER_W, thumbH: COVER_H, name: file.name, type: fullType, size: full.size });
          }).catch(reject);
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  // —— 格式化 ——
  function fmtMoney(n) { n = Number(n) || 0; return '¥' + n.toFixed(n % 1 ? 2 : 0); }
  function fmtDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fmtDateTime(ts) { const d = new Date(ts); return fmtDate(ts) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function monthKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1); }

  // —— 快捷新建分类 / 标签（供列表与编辑器复用）——
  function quickAddCategory(domain, onAdded) {
    const nameI = el('input', { class: 'input', placeholder: '分类名称' });
    const colorI = el('input', { type: 'color', value: App.domains.colorFor(domain.categories.length) });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', { text: '名称' }), nameI),
      el('div', { class: 'field' }, el('label', { text: '颜色' }), colorI));
    modal({
      title: '新建分类', body,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: '添加', primary: true, onClick: (c) => {
            const n = nameI.value.trim(); if (!n) { toast('请填写名称', 'err'); return; }
            const item = App.domains.makeCat(n, domain.categories.length); item.color = colorI.value;
            domain.categories.push(item); c(); onAdded(item);
          } },
      ],
    });
    setTimeout(() => nameI.focus(), 50);
  }
  function quickAddTag(domain, onAdded) {
    const nameI = el('input', { class: 'input', placeholder: '标签名称' });
    const colorI = el('input', { type: 'color', value: App.domains.colorFor(domain.tags.length + 4) });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', { text: '名称' }), nameI),
      el('div', { class: 'field' }, el('label', { text: '颜色' }), colorI));
    modal({
      title: '新建标签', body,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: '添加', primary: true, onClick: (c) => {
            const n = nameI.value.trim(); if (!n) { toast('请填写名称', 'err'); return; }
            const item = App.domains.makeTag(n, domain.tags.length); item.color = colorI.value;
            domain.tags.push(item); c(); onAdded(item);
          } },
      ],
    });
    setTimeout(() => nameI.focus(), 50);
  }

  // —— 自定义下拉：替换原生 select 的白底菜单，配色跟随主题（全局复用）——
  let selMenuState = null;
  function closeSelMenu() { if (selMenuState) { const st = selMenuState; selMenuState = null; st.close(); } }
  function openSelMenu(anchor, options, current, onPick) {
    const menu = el('div', { class: 'cf-sel-menu' });
    menu.style.left = '-9999px';
    menu.style.top = '0px';
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      menu.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('scroll', close, true);
      anchor.classList.remove('open');
      if (selMenuState && selMenuState.close === close) selMenuState = null;
    }
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
    options.forEach(([v, t]) => {
      const item = el('button', { class: 'cf-sel-opt' + (v === current ? ' active' : ''), text: t });
      item.addEventListener('click', () => { close(); onPick(v, t); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = Math.max(62, Math.round(r.width));
    menu.style.width = w + 'px';
    const h = menu.offsetHeight;
    let left = Math.round(r.left);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (left < 8) left = 8;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    anchor.classList.add('open');
    selMenuState = { close, anchor };
    setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
    window.addEventListener('scroll', close, true);
  }
  function makeSelect(options, initial, onChange, placeholder) {
    let cur = initial;
    const label = el('span', { class: 'cf-sel-label' });
    const btn = el('button', { class: 'cf-sel', type: 'button' });
    function paint() {
      const o = (options || []).find((x) => x[0] === cur);
      label.textContent = o ? o[1] : (cur ? String(cur) : (placeholder || ''));
      btn.classList.toggle('empty', !cur);
    }
    paint();
    btn.appendChild(label);
    btn.appendChild(el('span', { class: 'cf-sel-chev', html: icon('chevron', 14) }));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selMenuState && selMenuState.anchor === btn) { closeSelMenu(); return; }
      closeSelMenu();
      openSelMenu(btn, options, cur, (v) => { cur = v; paint(); if (onChange) onChange(v); });
    });
    btn.getValue = () => cur;
    btn.setValue = (v) => { cur = v; paint(); if (onChange) onChange(v); };
    btn.setOptions = (opts, v) => { options = opts; if (v !== undefined) cur = v; paint(); };
    return btn;
  }

  // —— 深色自定义日历（替换原生白底蓝字 date 选择器）——
  function openCalendar({ value, min, max, onSelect }) {
    const init = value ? new Date(value + 'T00:00:00') : new Date();
    let sy = init.getFullYear(), sm = init.getMonth(), sel = value || '';
    const pad2 = (n) => (String(n).length < 2 ? '0' + n : String(n));
    const keyOf = (y, m, d) => y + '-' + pad2(m + 1) + '-' + pad2(d);
    const grid = el('div', { class: 'cal-grid' });
    const titleEl = el('div', { class: 'cal-title' });
    function buildGrid() {
      clear(grid);
      titleEl.textContent = sy + ' 年 ' + (sm + 1) + ' 月';
      const first = new Date(sy, sm, 1).getDay();
      const days = new Date(sy, sm + 1, 0).getDate();
      ['日', '一', '二', '三', '四', '五', '六'].forEach((w) => grid.appendChild(el('div', { class: 'cal-wk', text: w })));
      for (let i = 0; i < first; i++) grid.appendChild(el('div', { class: 'cal-cell empty' }));
      for (let d = 1; d <= days; d++) {
        const k = keyOf(sy, sm, d);
        const cell = el('button', { class: 'cal-cell' + (k === sel ? ' sel' : ''), text: String(d) });
        if ((min && k < min) || (max && k > max)) cell.disabled = true;
        cell.addEventListener('click', () => { sel = k; buildGrid(); });
        grid.appendChild(cell);
      }
    }
    function shift(delta) { sm += delta; if (sm < 0) { sm = 11; sy--; } else if (sm > 11) { sm = 0; sy++; } buildGrid(); }
    const prev = el('button', { class: 'cal-nav', html: icon('arrowLeft', 20), title: '上个月' });
    const next = el('button', { class: 'cal-nav', html: icon('arrowRight', 20), title: '下个月' });
    prev.addEventListener('click', () => shift(-1));
    next.addEventListener('click', () => shift(1));
    buildGrid();
    modal({
      title: '选择日期',
      body: el('div', {}, el('div', { class: 'cal-head' }, prev, titleEl, next), grid),
      center: true,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: '确定', primary: true, onClick: (c) => { c(); if (sel && onSelect) onSelect(sel); } },
      ],
    });
  }

  // —— 自定义取色器：紧贴按钮弹出的小浮层（非全屏），拖动即时变色，再次打开定位到上次颜色 ——
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    const n = m ? parseInt(m[1], 16) : 0x8b9cff;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    const f = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
    return '#' + f(r) + f(g) + f(b);
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }

  let colorPopState = null;
  function closeColorPicker() { if (colorPopState) { const st = colorPopState; colorPopState = null; st.close(); } }

  function openColorPicker({ anchor, value, onInput, onChange, onClose }) {
    closeColorPicker();
    closeSelMenu();
    const start = hexToRgb(value);
    let hsv = rgbToHsv(start.r, start.g, start.b);
    let closed = false;

    const svBg = el('div', { class: 'cp-sv' });
    const svHandle = el('div', { class: 'cp-sv-handle' });
    svBg.appendChild(svHandle);
    const hue = el('div', { class: 'cp-hue' });
    const hueThumb = el('div', { class: 'cp-hue-thumb' });
    hue.appendChild(hueThumb);
    const preview = el('div', { class: 'cp-preview' });
    const hexText = el('div', { class: 'cp-hex' });
    const pop = el('div', { class: 'color-pop' },
      svBg, hue,
      el('div', { class: 'cp-foot' }, preview, hexText));

    function currentHex() { const c = hsvToRgb(hsv.h, hsv.s, hsv.v); return rgbToHex(c.r, c.g, c.b); }

    // 对外通知：input（拖动过程中持续触发）+ change（一次拖动结束提交一次）。
    // 去重：颜色没变就不重复回调，避免拖动时每帧都刷一遍全局样式。
    let lastEmitted = currentHex();
    function emit(force) {
      const hex = currentHex();
      if (!force && hex === lastEmitted) return;
      lastEmitted = hex;
      if (onInput) onInput(hex);
    }

    function paint(shouldEmit) {
      const base = hsvToRgb(hsv.h, 1, 1);
      svBg.style.background =
        'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ' + rgbToHex(base.r, base.g, base.b) + ')';
      svHandle.style.left = (hsv.s * 100) + '%';
      svHandle.style.top = ((1 - hsv.v) * 100) + '%';
      hueThumb.style.left = (hsv.h / 360 * 100) + '%';
      const hex = currentHex();
      preview.style.background = hex;
      hexText.textContent = hex.toUpperCase();
      if (shouldEmit) emit(false);
    }

    // —— 拖动绑定：Pointer 为主，touch / mouse 兜底 ——
    // 安卓 WebView（尤其 5+App 内嵌的旧内核）对 pointermove 支持不完整：
    // 典型症状是「按下能变色，滑动过程中收不到 move，只有松手才更新」。
    // 所以三套事件都绑，并把 move/up 挂到 document 上，手指滑出小色条也照样跟手。
    let drag = null;        // { applyPoint, lastPt }
    let pollTimer = null;   // 兜底轮询：某个内核整段吞事件时，用最近坐标持续重算

    function pointOf(e) {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (t) return { x: t.clientX, y: t.clientY };
      if (e.clientX != null) return { x: e.clientX, y: e.clientY };
      return null;
    }

    function onMove(e) {
      if (!drag) return;
      const p = pointOf(e);
      if (!p) return;
      if (e.cancelable) e.preventDefault(); // 拖色期间禁止页面滚动 / 下拉刷新
      drag.lastPt = p;
      drag.applyPoint(p.x, p.y);
      paint(true);
    }

    function onUp() { stopDrag(true); }

    function stopDrag(commit) {
      if (!drag) return;
      drag = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('touchmove', onMove, { passive: false });
      document.removeEventListener('touchend', onUp, true);
      document.removeEventListener('touchcancel', onUp, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      if (commit && onChange) onChange(currentHex()); // change 语义：松手后再兜一次，确保终值已应用
    }

    function startDrag(applyPoint, e) {
      if (drag) return;
      if (e.cancelable) e.preventDefault();
      const p = pointOf(e);
      drag = { applyPoint: applyPoint, lastPt: p || { x: 0, y: 0 } };
      if (p) applyPoint(p.x, p.y);
      paint(true);
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp, true);
      document.addEventListener('touchcancel', onUp, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (!drag) { clearInterval(pollTimer); pollTimer = null; return; }
        if (!drag.lastPt) return;
        drag.applyPoint(drag.lastPt.x, drag.lastPt.y);
        paint(true);
      }, 40);
    }

    function bindArea(area, applyPoint) {
      if (window.PointerEvent) area.addEventListener('pointerdown', (e) => startDrag(applyPoint, e));
      area.addEventListener('touchstart', (e) => startDrag(applyPoint, e), { passive: false });
      area.addEventListener('mousedown', (e) => startDrag(applyPoint, e));
    }
    bindArea(svBg, (x, y) => {
      const r = svBg.getBoundingClientRect();
      hsv.s = Math.max(0, Math.min(1, (x - r.left) / r.width));
      hsv.v = Math.max(0, Math.min(1, 1 - (y - r.top) / r.height));
    });
    bindArea(hue, (x, y) => {
      const r = hue.getBoundingClientRect();
      hsv.h = Math.max(0, Math.min(1, (x - r.left) / r.width)) * 360;
    });

    document.body.appendChild(pop);
    // 定位：默认贴按钮下沿，空间不够翻到上方；上下左右都夹在视口内，绝不飞出屏幕
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    let left = Math.max(8, Math.min(Math.round(r.left), vw - pw - 8));
    if (vw - pw - 8 < 8) left = 8;
    let top = Math.round(r.bottom + 8);
    if (top + ph > vh - 8) top = Math.round(r.top - ph - 8);
    top = Math.max(8, Math.min(top, Math.max(8, vh - ph - 8)));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    paint(false);

    function close() {
      if (closed) return; closed = true;
      stopDrag(false); // 关闭时务必停掉拖动跟踪与兜底轮询，避免定时器/监听器泄漏
      pop.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      if (colorPopState && colorPopState.close === close) colorPopState = null;
      if (onClose) onClose();
    }
    const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onScroll = () => close();
    setTimeout(() => {
      if (closed) return;
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    colorPopState = { close, anchor, pop };
    return { close, el: pop, getValue: currentHex };
  }

  // ===== 全屏看图：双击缩放 / 双指缩放 / 拖拽平移 / 单击关闭 / 保存 =====
  // opts: { src, name, blob?, getBlob?() => Promise<Blob> }
  // 交互约定：
  //   ① 物理返回键 → 关闭（由 closeTopLayer 统一调度，页面路由不动）
  //   ② 单击图片 → 关闭；双击 → 放大 / 复原。单击要等 280ms 确认不是双击，
  //      这段时间里来了第二击就把待执行的关闭取消掉，所以不会「双击时先关掉再缩放」。
  //   ③ 右上角不再放关闭按钮（会挡图）；只保留右下角一个小尺寸的下载按钮。
  let activeViewer = null;
  function closeImageViewer() {
    if (!activeViewer) return false;
    const v = activeViewer; activeViewer = null; v.close();
    return true;
  }
  function isImageViewerOpen() { return !!activeViewer; }

  // 两种入参：
  //   单图 { src, name, blob?, getBlob?() }
  //   多图 { srcs: [..], index, nameAt(i), getBlobAt(i) } —— 左右滑动切换同一条记录的图片
  function openImageViewer(opts) {
    opts = opts || {};
    const srcs = (opts.srcs && opts.srcs.length) ? opts.srcs.slice() : (opts.src ? [opts.src] : []);
    if (!srcs.length) return null;
    if (document.querySelector('.iv-mask')) return null; // 已经开着就不再叠一层

    const startIdx = Math.max(0, Math.min(srcs.length - 1, opts.index || 0));
    let idx = startIdx;
    const multi = srcs.length > 1;
    const nameAt = (k) => String((opts.nameAt ? opts.nameAt(k) : opts.name) || 'image.jpg');

    const img = el('img', { class: 'iv-img' });
    img.src = srcs[idx]; img.draggable = false;
    const stage = el('div', { class: 'iv-stage' }, img);
    const saveBtn = el('button', { class: 'iv-save', type: 'button', html: icon('download', 18), 'aria-label': '保存图片' });
    const countEl = multi ? el('div', { class: 'iv-count', text: (idx + 1) + ' / ' + srcs.length }) : null;
    const mask = el('div', { class: 'iv-mask' }, stage, countEl, saveBtn);

    let s = 1, tx = 0, ty = 0;
    const pts = new Map();
    let drag = null, pinch = null, lastTap = 0, tapTimer = null, closed = false;

    // 图片按 contain 铺进屏幕后的真实展示尺寸（缩放/边界都按它算）
    function fitBox() {
      const r = stage.getBoundingClientRect();
      const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
      const k = Math.min(r.width / nw, r.height / nh);
      return { w: nw * k, h: nh * k, sw: r.width, sh: r.height };
    }
    function clampXY() {
      const f = fitBox();
      const mx = Math.max(0, (f.w * s - f.sw) / 2);
      const my = Math.max(0, (f.h * s - f.sh) / 2);
      tx = Math.max(-mx, Math.min(mx, tx));
      ty = Math.max(-my, Math.min(my, ty));
    }
    function apply(anim) {
      img.style.transition = anim ? 'transform .24s cubic-bezier(.22,.7,.28,1)' : 'none';
      img.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + s + ')';
    }
    function reset(anim) { s = 1; tx = 0; ty = 0; apply(anim !== false); }
    // 以某点（屏幕坐标）为锚点缩放，锚点下的像素保持不动
    function zoomAt(ns, cx, cy) {
      ns = Math.max(1, Math.min(5, ns));
      const r = stage.getBoundingClientRect();
      const px = (cx == null ? r.width / 2 : cx - r.left) - r.width / 2;
      const py = (cy == null ? r.height / 2 : cy - r.top) - r.height / 2;
      const k = ns / s;
      tx = px - k * (px - tx);
      ty = py - k * (py - ty);
      s = ns;
      if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
      clampXY(); apply(true);
    }
    function dist() { const a = Array.from(pts.values()); return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
    function mid() { const a = Array.from(pts.values()); return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; }

    stage.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty, moved: false, dy: 0, hx: null };
      } else if (pts.size === 2) {
        const m = mid();
        pinch = { d: dist(), s: s, tx: tx, ty: ty, mx: m.x, my: m.y };
        drag = null;
      }
    });

    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        const d = dist();
        if (!pinch.d) return;
        const ns = Math.max(1, Math.min(5, pinch.s * (d / pinch.d)));
        const r = stage.getBoundingClientRect();
        const m = mid();
        const ax = pinch.mx - r.left - r.width / 2;
        const ay = pinch.my - r.top - r.height / 2;
        const cx = (ax - pinch.tx) / pinch.s, cy = (ay - pinch.ty) / pinch.s;
        tx = (m.x - r.left - r.width / 2) - cx * ns;
        ty = (m.y - r.top - r.height / 2) - cy * ns;
        s = ns;
        clampXY(); apply(false);
        return;
      }
      if (pts.size === 1 && drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        if (s > 1.001) {
          tx = drag.tx + dx; ty = drag.ty + dy;
          clampXY(); apply(false);
        } else if (multi && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
          // 未放大时横向拖：图片跟手平移，到头了阻尼减半（提示没有更多图）
          drag.hx = dx;
          img.style.transition = 'none';
          const edge = (dx > 0 && idx === 0) || (dx < 0 && idx === srcs.length - 1);
          img.style.transform = 'translate3d(' + (edge ? dx * 0.28 : dx) + 'px,0,0) scale(1)';
        } else if (dy > 0 && Math.abs(dy) > Math.abs(dx)) {
          // 未放大时向下拖：图片跟手下沉，松手够远就关闭
          drag.dy = dy;
          img.style.transition = 'none';
          img.style.transform = 'translate3d(0,' + dy + 'px,0) scale(' + Math.max(.86, 1 - dy / 1200) + ')';
          mask.style.opacity = String(Math.max(.25, 1 - dy / 700));
        }
      }
    });

    // —— 左右滑动切换同一条记录的多张图 ——
    // 动画分三步：当前图推出屏幕 → 换 src 并放到反方向屏外 → 过渡滑回正中。
    // sliding 标记防止连续滑动时动画打架。
    let sliding = false;
    function setImg(at) {
      idx = at;
      s = 1; tx = 0; ty = 0;
      img.style.transition = 'none';
      img.style.transform = 'translate3d(0,0,0)';
      img.src = srcs[idx];
      if (countEl) countEl.textContent = (idx + 1) + ' / ' + srcs.length;
    }
    function slideTo(delta) {
      if (sliding || srcs.length < 2) return;
      const next = idx + delta;
      const w = stage.getBoundingClientRect().width || window.innerWidth || 320;
      if (next < 0 || next >= srcs.length) {   // 到头了：弹回去，不换图
        img.style.transition = 'transform .2s ease';
        img.style.transform = 'translate3d(0,0,0)';
        return;
      }
      sliding = true;
      const out = delta > 0 ? -w : w;
      img.style.transition = 'transform .2s ease-out';
      img.style.transform = 'translate3d(' + out + 'px,0,0)';
      setTimeout(() => {
        if (closed) { sliding = false; return; }
        setImg(next);
        img.style.transform = 'translate3d(' + (-out) + 'px,0,0)';
        void img.offsetWidth;               // 强制回流，下一帧的过渡才会生效
        img.style.transition = 'transform .2s ease-out';
        img.style.transform = 'translate3d(0,0,0)';
        setTimeout(() => { sliding = false; }, 210);
      }, 200);
    }

    function endPointer(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      if (pts.size === 1) {
        const a = Array.from(pts.values())[0];
        drag = { x: a.x, y: a.y, tx: tx, ty: ty, moved: true, dy: 0, hx: null };
        pinch = null;
        return;
      }
      if (pts.size > 0) return;
      const d = drag; drag = null; pinch = null;
      if (!d) return;
      mask.style.opacity = '1';
      // ① 未放大时的横向滑动 = 切图（阈值取屏宽的 16%，最多 72px）
      if (s <= 1.001 && d.hx != null) {
        const w = stage.getBoundingClientRect().width || window.innerWidth || 320;
        const need = Math.min(72, w * 0.16);
        if (Math.abs(d.hx) > need) { slideTo(d.hx < 0 ? 1 : -1); return; }
        img.style.transition = 'transform .2s ease';
        img.style.transform = 'translate3d(0,0,0)';
        return;
      }
      if (s <= 1.001 && d.dy > 90) { close(); return; }
      if (s <= 1.001 && d.dy > 0) { apply(true); return; }
      if (d.moved) return;   // 拖过就别当点击

      // 轻点：单击 = 关闭；两击之内再来一下 = 双击缩放
      const now = Date.now();
      if (now - lastTap < 300) {
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        lastTap = 0;
        if (s > 1.001) reset(true); else zoomAt(2.6, e.clientX, e.clientY);
        return;
      }
      lastTap = now;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapTimer = null; close(); }, 280);
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    async function doSave() {
      saveBtn.disabled = true;
      try {
        let blob = null;
        if (opts.getBlobAt) blob = await opts.getBlobAt(idx);
        else if (idx === startIdx) { blob = opts.blob || null; if (!blob && opts.getBlob) blob = await opts.getBlob(); }
        if (!blob) throw new Error('no blob');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = nameAt(idx);
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
        toast('已保存图片', 'ok');
      } catch (err) {
        toast('保存失败，可长按图片另存');
      } finally { saveBtn.disabled = false; }
    }
    saveBtn.addEventListener('click', (e) => { e.stopPropagation(); doSave(); });
    saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

    function close() {
      if (closed) return; closed = true;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
      if (activeViewer && activeViewer.close === close) activeViewer = null;
      document.removeEventListener('keydown', onKey, true);
      mask.style.transition = 'opacity .16s ease';
      mask.style.opacity = '0';
      setTimeout(() => { if (mask.parentNode) mask.remove(); }, 170);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(mask);
    activeViewer = { close: close, el: mask };
    return { close, el: mask };
  }

  // 物理返回键优先消费：从最上层浮层开始关，全都关完了才轮到页面
  function closeTopLayer() {
    if (closeImageViewer()) return true;
    if (colorPopState) { closeColorPicker(); return true; }
    if (selMenuState) { closeSelMenu(); return true; }
    if (modalStack.length) { modalStack[modalStack.length - 1](); return true; }
    return false;
  }

  return {
    el, clear, mount, icon, iconEl, toast, modal, confirmDialog, promptNumber, makeThumb, makeCoverBlob,
    COVER_W, COVER_H,
    makeSelect, closeSelMenu, openCalendar, openColorPicker, closeColorPicker, openImageViewer,
    closeImageViewer, isImageViewerOpen, closeTopLayer,
    fmtMoney, fmtDate, fmtDateTime, monthKey, quickAddCategory, quickAddTag,
  };
})();
