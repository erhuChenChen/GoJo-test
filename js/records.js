/* ===== records.js — 记录管理（多图画廊 / 灯箱 / 评论 / 编辑 / 筛选 / 批量）===== */
window.App = window.App || {};
App.records = (function () {
  const U = () => App.ui;
  let filterCat = null, filterTag = null, searchText = '';
  let sortField = 'date', sortDir = 'desc'; // 默认：记录日期 ↓（新→旧）
  let sortPanelEl = null;
  let dateFrom = null, dateTo = null, cfFilters = {};
  let multiMode = false, selected = {};
  let batchBarEl = null, viewContainer = null, viewDomain = null;
  let selAllCbEl = null, selAllTxtEl = null;
  // 整页翻页后，新记录从哪一侧滑入（1=右侧，-1=左侧）。
  // 只用于「入场动画」，不做任何数据/页码状态，翻页失败也不影响页面本身。
  let pendingEnter = null;

  // 列表页悬浮按钮：容器常驻（「添加记录」一直可见），「回到顶部」按滚动位置显隐。
  // 阈值跟屏高走（约 40% 屏高，最少 180px），这样短列表不会误显示、长屏手机也不会太晚出现。
  const TOP_FAB_MIN = 180;
  let fabScrollBound = false;
  let fabTopEl = null;
  // 瀑布流：列表重建时把 relayout 挂到这里，resize 时按新列宽重新分配卡片
  let masonryRelayout = null;
  let masonryResizeBound = false;
  // 封面加载失败 → 卡片变矮 → 两列高度立刻失衡，稍等一拍再重排一次（同一批失败只排一次）
  let masonryDropT = 0;
  function scheduleRelayout() {
    if (masonryDropT) return;
    masonryDropT = setTimeout(() => {
      masonryDropT = 0;
      if (masonryRelayout) masonryRelayout(true);
    }, 200);
  }
  function topFabThreshold() {
    return Math.max(TOP_FAB_MIN, Math.round((window.innerHeight || 640) * 0.4));
  }
  function syncTopFab() {
    if (!fabTopEl || !fabTopEl.isConnected) return; // 已离开列表页（view 被清空）时忽略
    const y = window.scrollY || window.pageYOffset || 0;
    fabTopEl.classList.toggle('show', y > topFabThreshold());
  }
  function ensureFabScroll() {
    if (!fabScrollBound) {
      fabScrollBound = true;
      window.addEventListener('scroll', syncTopFab, { passive: true });
      window.addEventListener('resize', syncTopFab, { passive: true });
    }
    syncTopFab();
  }

  // 高级自定义排序：排序字段 + 方向（升/降）
  function sortValue(rec, field) {
    if (field === 'date') return rec.date || rec.createdAt;
    if (field === 'time') return rec.timeSpentMin || 0;
    if (field === 'income') return rec.income || 0;
    if (field === 'expense') return rec.expense || 0;
    if (field && field.indexOf('cf_') === 0) { const fid = field.slice(3); return Number((rec.customValues || {})[fid]) || 0; }
    return rec.date || rec.createdAt;
  }
  function sortCmp(a, b) {
    const av = sortValue(a, sortField), bv = sortValue(b, sortField);
    return sortDir === 'asc' ? av - bv : bv - av;
  }
  // 关闭排序浮层（如已打开）
  function closeSortPanel() { if (sortPanelEl) { if (sortPanelEl._cleanup) sortPanelEl._cleanup(); sortPanelEl.remove(); sortPanelEl = null; } }

  async function fillThumb(imgEl, id) {
    const u = await App.storage.getThumbURL(id);
    if (u) { imgEl.dataset.thumb = id; imgEl.src = u; } else imgEl.style.background = 'var(--surface-2)';
    if (App.storage.upgradeThumb) App.storage.upgradeThumb(id); // 后台把老的低清缩略图补成高清（静默、失败无感）
  }

  // 等图片真正解码出尺寸：有 src 不代表图片存在（导入/清理后可能只剩下失效的 URL）。
  // 用来判断「这条记录到底还有没有图」，没有就把封面/图片区整块摘掉，不留空灰框。
  function waitImage(im, ms) {
    if (im.complete && im.naturalWidth) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const fin = (ok) => {
        if (done) return; done = true;
        im.removeEventListener('load', onLoad); im.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onLoad = () => fin(!!im.naturalWidth);
      const onErr = () => fin(false);
      im.addEventListener('load', onLoad); im.addEventListener('error', onErr);
      setTimeout(() => fin(!!(im.complete && im.naturalWidth)), ms || 4000); // 兜底，不让 promise 一直挂着
    });
  }

  // 卡片底部展示字段（按 domain.cardFields）
  function cardMetaChips(rec, domain) {
    const box = U().el('div', { class: 'rc-meta2 row wrap', style: { gap: '6px', marginTop: '6px' } });
    const fields = domain.cardFields || [];
    fields.forEach((key) => {
      if (key === 'time') { if (rec.timeSpentMin) box.appendChild(U().el('span', { class: 'mini-chip', html: U().icon('clock', 13) + ' ' + (rec.timeSpentMin >= 60 ? (rec.timeSpentMin / 60).toFixed(1) + ' h' : rec.timeSpentMin + ' 分') })); }
      else if (key === 'income') { if (rec.income) box.appendChild(U().el('span', { class: 'mini-chip inc', html: U().icon('wallet', 13) + ' ' + U().fmtMoney(rec.income) })); }
      else if (key === 'expense') { if (rec.expense) box.appendChild(U().el('span', { class: 'mini-chip exp', html: U().icon('wallet', 13) + ' -' + U().fmtMoney(rec.expense) })); }
      else { const f = (domain.customFields || []).find((x) => x.id === key); if (!f) return; const v = (rec.customValues || {})[key]; if (v == null || v === '') return; let txt = String(v); if (f.type === 'select') { const o = (f.options || []).find((o) => o.id === v); txt = o ? o.name : txt; } box.appendChild(U().el('span', { class: 'mini-chip', title: f.name, text: txt })); }
    });
    return box;
  }

  function recordCard(rec, domain) {
    const card = U().el('div', { class: 'record-card' + (multiMode ? ' selectable-card' : '') });
    // 封面：无论几张图，只取第一张铺满卡片（绝不拼接 / 分屏）
    // 纯文字记录（无图）不渲染封面元素 —— 3:4 的空灰框既难看又白占一屏高度，
    // 直接让文字区当卡片主体，高度随内容自适应。
    const firstId = (rec.imageIds || [])[0];
    let cover = null;
    let body = null;
    // 纯文字记录：正文摘要也放进卡片（最多 6 行，超了才截断并显示省略号；
    // 内容短时卡片就矮，高度完全跟着内容走 —— 见 css .rc-desc）
    const descText = String(rec.description || '').trim();
    const titleEl = U().el('div', { class: 'rc-title', text: rec.title || '未命名记录' });
    const descEl = descText ? U().el('div', { class: 'rc-desc', text: descText }) : null;
    function putDesc() {
      if (!descEl || descEl.parentNode || !body) return;
      if (titleEl.parentNode === body) body.insertBefore(descEl, titleEl.nextSibling); else body.appendChild(descEl);
    }
    if (firstId) {
      cover = U().el('div', { class: 'thumb-cover' });
      const im = U().el('img');
      // 图片文件其实已经不在了（导入不完整、被清理过）→ 封面整块摘掉，卡片改走纯文字排版
      const dropCover = () => {
        if (cover && cover.parentNode) cover.remove();
        cover = null;
        card.classList.add('no-cover');
        putDesc();
        scheduleRelayout();   // 卡片变矮了，稍后按新高度重新平衡两列
      };
      im.addEventListener('error', dropCover);
      fillThumb(im, firstId).then(() => { if (!im.getAttribute('src')) dropCover(); }).catch(dropCover);
      cover.appendChild(im);
      if (rec.imageIds.length > 1) {
        cover.appendChild(U().el('div', { class: 'cover-badge', html: U().icon('images', 13) + '<span>' + rec.imageIds.length + '</span>' }));
      }
    } else {
      card.classList.add('no-cover');
    }
    const cat = domain.categories.find((c) => c.id === rec.categoryId);
    // 记录名称 / 日期：固定显示，不可取消；其余字段由 domain.cardFields 决定
    const fields = domain.cardFields || [];
    const has = (k) => fields.indexOf(k) !== -1;
    const metaRow = U().el('div', { class: 'rc-meta' });
    if (has('category')) metaRow.appendChild(cat ? U().el('span', { class: 'rc-tag', text: '#' + cat.name }) : U().el('span', { class: 'rc-tag muted', text: '未分类' }));
    if (has('tags')) (rec.tagIds || []).forEach((tid) => { const t = domain.tags.find((x) => x.id === tid); if (t) metaRow.appendChild(U().el('span', { class: 'rc-tag', text: '#' + t.name })); });
    const metaChips = cardMetaChips(rec, domain);
    // 排版说明（瀑布流）：
    // ① 分类/标签行固定只占一行（CSS 里 nowrap + 定高 + 裁切），换行不再撑高卡片；
    // ② 日期放在正文最后；卡片高度由内容决定，两列各自堆叠、互不拉伸（见 .gallery.masonry）。
    body = U().el('div', { class: 'rc-body' },
      titleEl,
      metaRow.childNodes.length ? metaRow : null,
      metaChips.childNodes.length ? metaChips : null,
      U().el('div', { class: 'rc-date', text: U().fmtDate(rec.date || rec.createdAt) }));
    if (card.classList.contains('no-cover')) putDesc();

    if (multiMode) {
      const cb = U().el('input', { type: 'checkbox', class: 'card-check' });
      cb.checked = !!selected[rec.id];
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { if (cb.checked) selected[rec.id] = true; else delete selected[rec.id]; card.classList.toggle('checked', cb.checked); updateBatchBar(); });
      card.appendChild(cb);
      card.addEventListener('click', () => { cb.checked = !cb.checked; if (cb.checked) selected[rec.id] = true; else delete selected[rec.id]; card.classList.toggle('checked', cb.checked); updateBatchBar(); });
    } else {
      card.addEventListener('click', () => App.app.go('record/' + rec.id));
    }
    if (cover) card.appendChild(cover);
    if (body.childNodes.length) card.appendChild(body);
    return card;
  }

  function getFilteredSorted(domain) {
    let list = App.state.data.records.slice();
    if (filterCat) list = list.filter((r) => r.categoryId === filterCat);
    if (filterTag) list = list.filter((r) => (r.tagIds || []).includes(filterTag));
    if (dateFrom) list = list.filter((r) => (r.date || r.createdAt) >= dateFrom);
    if (dateTo) list = list.filter((r) => (r.date || r.createdAt) <= dateTo + 86399999);
    Object.keys(cfFilters).forEach((fid) => { const opt = cfFilters[fid]; if (opt) list = list.filter((r) => ((r.customValues) || {})[fid] === opt); });
    if (searchText) {
      list = list.filter((r) => {
        if ((r.title || '').toLowerCase().includes(searchText)) return true;
        if ((r.description || '').toLowerCase().includes(searchText)) return true;
        if ((r.tagIds || []).some((tid) => { const tg = domain.tags.find((x) => x.id === tid); return tg && tg.name.toLowerCase().includes(searchText); })) return true;
        const cv = r.customValues || {};
        return Object.keys(cv).some((fid) => { const f = domain.customFields.find((x) => x.id === fid); const val = cv[fid]; if (!val) return false; if (f && f.type === 'select') { const o = (f.options || []).find((o) => o.id === val); return o && o.name.toLowerCase().includes(searchText); } return String(val).toLowerCase().includes(searchText); });
      });
    }
    list.sort(sortCmp);
    return list;
  }

  // 批量操作栏：提升到模块级，勾选即实时刷新；底部横向操作栏（已选X条 / 移动 / 取消）
  function updateBatchBar() {
    if (!batchBarEl) return;
    const keys = Object.keys(selected);
    U().clear(batchBarEl);
    if (!multiMode || !keys.length) { batchBarEl.classList.add('hidden'); }
    else {
      batchBarEl.classList.remove('hidden');
      const moveBtn = U().el('button', { class: 'btn primary', text: '移动' });
      moveBtn.addEventListener('click', () => {
        // 先立即隐藏底部栏，避免与“选择领域”弹窗重叠
        batchBarEl.classList.add('hidden');
        openMoveModal(keys, viewDomain, exitMulti);
      });
      const cancel = U().el('button', { class: 'btn', text: '取消' });
      cancel.addEventListener('click', exitMulti);
      batchBarEl.appendChild(U().el('span', { class: 'batch-count', text: '已选 ' + keys.length + ' 条' }));
      batchBarEl.appendChild(U().el('div', { class: 'batch-actions' }, moveBtn, cancel));
    }
    // 同步顶部全选框状态
    if (selAllCbEl && viewDomain) {
      const list = getFilteredSorted(viewDomain);
      const allSel = list.length > 0 && list.every((r) => selected[r.id]);
      selAllCbEl.checked = allSel;
      if (selAllTxtEl) selAllTxtEl.textContent = allSel ? '取消全选' : '全选';
    }
  }

  // 彻底退出多选模式并重绘列表
  function exitMulti() {
    selected = {}; multiMode = false;
    if (viewContainer) renderList(viewContainer);
  }

  // 全选 / 取消全选：作用于当前筛选结果
  function selectAllToggle() {
    if (!viewDomain) return;
    const list = getFilteredSorted(viewDomain);
    const allSelected = list.length > 0 && list.every((r) => selected[r.id]);
    if (allSelected) selected = {};
    else list.forEach((r) => { selected[r.id] = true; });
    renderList(viewContainer);
  }

  function renderList(container) {
    closeSortPanel();
    U().clear(container);
    const domain = App.state.currentDomain();
    if (!domain) { container.appendChild(U().el('div', { class: 'empty-state', text: '请先在设置中添加领域' })); return; }
    viewContainer = container; viewDomain = domain;
    // 始终保留底部安全距离，避免右下角「+ / ↑」悬浮按钮遮挡卡片底部的金额
    container.style.paddingBottom = (multiMode ? 130 : 96) + 'px';

    // 顶部工具条：选择 + 排序 + 筛选
    // （「添加记录」胶囊按钮已移除：新增记录统一走右下角悬浮「+」，避免两个入口并存）

    // 当前排序文案：属性名 + 方向箭头（↓ 降序 / ↑ 升序）
    function sortLabel() {
      const map = { date: '日期', time: '时长', income: '收入', expense: '支出' };
      let name;
      if (sortField && sortField.indexOf('cf_') === 0) { const f = (domain.customFields || []).find((x) => x.id === sortField.slice(3)); name = f ? f.name : '自定义'; }
      else name = map[sortField] || '日期';
      return name + (sortDir === 'desc' ? ' ↓' : ' ↑');
    }
    const sortBtn = U().el('button', { class: 'btn', html: U().icon('sort', 18) + '<span>' + sortLabel() + '</span>' });
    sortBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSortPanel(sortBtn); });
    function updateSortBtn() { const s = sortBtn.querySelector('span'); if (s) s.textContent = sortLabel(); }

    const filterBtn = U().el('button', { class: 'btn', html: U().icon('filter', 18) + '<span>筛选</span>' });
    filterBtn.addEventListener('click', () => openFilterModal(domain));
    const multiBtn = U().el('button', { class: 'btn' + (multiMode ? ' primary' : ''), html: U().icon('move', 18) + '<span>' + (multiMode ? '退出选择' : '选择') + '</span>' });
    multiBtn.addEventListener('click', () => { multiMode = !multiMode; if (!multiMode) { selected = {}; } renderList(container); });

    // —— 视图切换（双列网格 / 单列大卡片）——
    // 只切布局，不动任何数据；选择结果写入 settings.recordView，下次进入页面（甚至重启 App）保持。
    let listView = App.state.data.settings.recordView === 'single' ? 'single' : 'double';
    const viewBtn = U().el('button', { class: 'btn view-toggle', html: U().icon(listView === 'single' ? 'single' : 'grid', 18) });
    function paintViewBtn() {
      viewBtn.innerHTML = U().icon(listView === 'single' ? 'single' : 'grid', 18);
      viewBtn.title = listView === 'single' ? '切换为双列网格' : '切换为单列大图';
      viewBtn.setAttribute('aria-label', viewBtn.title);
    }
    paintViewBtn();
    viewBtn.addEventListener('click', () => {
      listView = listView === 'single' ? 'double' : 'single';
      paintViewBtn(); applyView(); relayout();
      App.state.saveSettings({ recordView: listView }).catch(() => {});
    });

    // 排序浮层：① 选择属性 ② 选择升/降序；点选即实时重排
    function toggleSortPanel(anchor) {
      if (sortPanelEl) { closeSortPanel(); return; }
      const panel = U().el('div', { class: 'sort-panel' });
      const attrs = [{ key: 'date', label: '记录日期' }, { key: 'time', label: '时长' }, { key: 'income', label: '收入' }, { key: 'expense', label: '支出' }];
      (domain.customFields || []).filter((f) => f.type === 'number').forEach((f) => attrs.push({ key: 'cf_' + f.id, label: f.name }));
      const attrWrap = U().el('div', { class: 'sort-attrs' });
      function renderAttrs() {
        U().clear(attrWrap);
        attrs.forEach((a) => {
          const chip = U().el('button', { class: 'chip selectable' + (sortField === a.key ? ' active' : ''), text: a.label });
          chip.addEventListener('click', () => { sortField = a.key; updateSortBtn(); renderAttrs(); drawGrid(); });
          attrWrap.appendChild(chip);
        });
      }
      renderAttrs();
      const dirWrap = U().el('div', { class: 'sort-dirs' });
      const ascB = U().el('button', { class: 'chip selectable' + (sortDir === 'asc' ? ' active' : ''), html: '↑ 升序' });
      const descB = U().el('button', { class: 'chip selectable' + (sortDir === 'desc' ? ' active' : ''), html: '↓ 降序' });
      ascB.addEventListener('click', () => { sortDir = 'asc'; updateSortBtn(); ascB.classList.add('active'); descB.classList.remove('active'); drawGrid(); });
      descB.addEventListener('click', () => { sortDir = 'desc'; updateSortBtn(); descB.classList.add('active'); ascB.classList.remove('active'); drawGrid(); });
      dirWrap.appendChild(ascB); dirWrap.appendChild(descB);
      panel.appendChild(U().el('div', { class: 'sp-title', text: '① 排序属性' }));
      panel.appendChild(attrWrap);
      panel.appendChild(U().el('div', { class: 'sp-title', text: '② 顺序（↑ 升序 / ↓ 降序）' }));
      panel.appendChild(dirWrap);
      document.body.appendChild(panel);
      const r = anchor.getBoundingClientRect();
      const pw = Math.min(248, window.innerWidth - 16);
      panel.style.width = pw + 'px';
      let left = r.right - pw; if (left < 8) left = 8;
      panel.style.left = left + 'px';
      panel.style.top = (r.bottom + 6) + 'px';
      const onDoc = (e) => { if (sortPanelEl && !sortPanelEl.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeSortPanel(); };
      const onScroll = () => closeSortPanel();
      setTimeout(() => document.addEventListener('click', onDoc), 0);
      window.addEventListener('scroll', onScroll, true);
      panel._cleanup = () => { document.removeEventListener('click', onDoc); window.removeEventListener('scroll', onScroll, true); };
      sortPanelEl = panel;
    }

    // 顶部工具栏：左侧 [选择]，右侧 [视图切换 / 排序 / 筛选]，两端对齐、中间留白
    const toolsLeft = U().el('div', { class: 'lt-group lt-left' }, multiBtn);
    const toolsRight = U().el('div', { class: 'lt-group lt-right' }, viewBtn, sortBtn, filterBtn);
    const tools = U().el('div', { class: 'list-tools' }, toolsLeft, toolsRight);

    const searchI = U().el('input', { class: 'input list-search', placeholder: '🔍 搜索标题 / 说明 / 标签 / 自定义属性', value: searchText });
    searchI.addEventListener('input', () => { searchText = searchI.value.trim().toLowerCase(); drawGrid(); });

    // 顶部全选 / 取消全选（仅多选模式显示）
    const selAllRow = U().el('label', { class: 'select-all-row' + (multiMode ? '' : ' hidden') });
    const selAllCb = U().el('input', { type: 'checkbox' });
    selAllCbEl = selAllCb;
    const selAllTxt = U().el('span', { text: '全选' });
    selAllTxtEl = selAllTxt;
    selAllCb.addEventListener('change', () => selectAllToggle());
    selAllRow.appendChild(selAllCb); selAllRow.appendChild(selAllTxt);

    // 分类行 / 标签行分离，各有独立垂直间距
    const catRow = U().el('div', { class: 'list-chiprow list-catrow' });
    const tagRow = U().el('div', { class: 'list-chiprow list-tagrow' });
    function rebuildChips() {
      U().clear(catRow); U().clear(tagRow);
      const mkChip = (label, key) => { const c = U().el('span', { class: 'chip selectable' + (filterCat === key ? ' active' : ''), text: label }); c.addEventListener('click', () => { filterCat = key; rebuildChips(); drawGrid(); }); return c; };
      catRow.appendChild(mkChip('全部', null));
      domain.categories.forEach((cat) => catRow.appendChild(mkChip(cat.name, cat.id)));
      const plusCat = U().el('span', { class: 'chip add-chip', html: U().icon('plus', 15), title: '新建分类' });
      plusCat.addEventListener('click', () => U().quickAddCategory(domain, () => { App.db.saveDomain(domain); rebuildChips(); App.app.refreshChrome && App.app.refreshChrome(); }));
      catRow.appendChild(plusCat);

      // 标签筛选（独立一行）— 用自定义深色下拉，去掉原生白底蓝字
      const tagSel = U().makeSelect([['', '全部']].concat(domain.tags.map((t) => [t.id, t.name])), filterTag || '', (v) => { filterTag = v || null; drawGrid(); });
      tagSel.classList.add('tag-select');
      tagRow.appendChild(U().el('span', { class: 'row-label', html: U().icon('tag', 14) + '<span>标签</span>' }));
      tagRow.appendChild(tagSel);
    }
    rebuildChips();

    const grid = U().el('div', { class: 'gallery masonry', style: { marginTop: '14px' } });
    // —— 瀑布流（Masonry）——
    // 两列 flex 容器，逐张放进「当前内容更矮的那一列」，卡片高度完全由自身内容决定。
    // 这条规则能成立有两个前提，上一版就是栽在这里（结果左边全是图、右边全是字）：
    //   ① 封面高度必须「同步可知」——CSS 用 padding-top:133.33% 撑出 3:4，不等图片解码；
    //   ② 卡片必须先插进 DOM 再量高度，量到的才是真实值，否则一律是 0。
    // 万一还是量不到（网格还没挂载 / 老内核拿不到 offsetHeight），退回「按序号左右交替」，
    // 至少保证不会出现「一列全满、一列空着」。
    let cols = [];
    let heights = [0, 0];
    let counts = [0, 0];
    let gapPx = 0;
    function gapNow() {
      if (gapPx) return gapPx;
      let g = NaN;
      try { g = parseFloat(window.getComputedStyle(grid).rowGap || ''); } catch (e) { g = NaN; }
      if (!(g >= 0)) g = 14;          // 量不到（未挂载 / 老内核）就按 --gap: 14px 兜底
      gapPx = g;
      return gapPx;
    }
    function buildCols() {
      U().clear(grid);
      cols = []; heights = [0, 0]; counts = [0, 0];
      const n = listView === 'single' ? 1 : 2;
      for (let i = 0; i < n; i++) { const c = U().el('div', { class: 'masonry-col' }); grid.appendChild(c); cols.push(c); }
    }
    function placeCard(card, i) {
      const n = cols.length;
      if (!n || !card) return null;
      if (n === 1) { cols[0].appendChild(card); return cols[0]; }
      let k;
      if (!heights[0] && !heights[1]) {
        k = ((i | 0) % n + n) % n;      // 还没量到高度：按序号左右交替（0→左、1→右…）
      } else if (counts[0] - counts[1] >= 2) {
        k = 1;                          // 左列已比右列多 2 张 → 硬性给右列
      } else if (counts[1] - counts[0] >= 2) {
        k = 0;                          // 反之硬性给左列
      } else {
        k = heights[0] <= heights[1] ? 0 : 1;   // 谁矮放谁，两列自然交错
      }
      cols[k].appendChild(card);
      counts[k]++;
      // 已经挂进 DOM，这里拿到的是真实高度（封面由 padding 撑开，不等图片加载）
      heights[k] += (card.offsetHeight || 0) + gapNow();
      return cols[k];
    }
    // 视图类名（.view-single / .view-double）只管列数与卡片宽度
    function applyView() {
      grid.classList.toggle('view-single', listView === 'single');
      grid.classList.toggle('view-double', listView === 'double');
    }
    // 纯文字卡片的最高高度 = 带图卡片的真实高度（3:4 封面 + 文字区）。
    // 取中位数，避免个别多行标题的长卡片把上限抬得太高；一张带图卡片都量不到时按列宽估算。
    function syncMaxH() {
      const col = cols[0];
      if (!col) return;
      const w = col.getBoundingClientRect().width || col.clientWidth || 0;
      if (!w) return;   // 还没排版好（未挂载），等下一帧再算
      const hs = [];
      const nodes = grid.querySelectorAll('.record-card:not(.no-cover)');
      for (let i = 0; i < nodes.length; i++) {
        const h = nodes[i].offsetHeight || 0;
        if (h > 40) hs.push(h);
      }
      let base = 0;
      if (hs.length) { hs.sort((a, b) => a - b); base = hs[Math.floor(hs.length / 2)]; }
      if (!base) base = Math.round(w * 4 / 3 + 78);   // 没有带图卡片可参照：按 3:4 封面 + 文字区估算
      grid.style.setProperty('--card-max-h', base + 'px');
      return base;
    }
    // 老内核（安卓 5/6 的 WebView）里，flex 子项上的 -webkit-line-clamp 经常不生效，
    // 长文会一路把卡片撑下去。这里补一次文本截断兜底：只在「内容真的比可视区高」时才动手，
    // clamp 正常的内核不会进这个分支（截断处补省略号，原文留在 _full 里，重排时可恢复）。
    function clampDescs() {
      const items = grid.querySelectorAll('.record-card.no-cover .rc-desc');
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        if (el._full == null) el._full = el.textContent;
        el.textContent = el._full;
        if (!el.clientHeight) continue;
        let t = el._full;
        // 每次砍掉约 12%，最多 12 次 —— 有上界的循环，不会挂住
        for (let k = 0; k < 12 && t.length > 1 && el.scrollHeight > el.clientHeight + 2; k++) {
          t = t.slice(0, Math.max(1, Math.floor(t.length * 0.88)));
          el.textContent = t + '…';
        }
      }
    }
    // 统一重排（不重建卡片 DOM）：
    //   ① 先分配一次 → ② 按带图卡片的真实高度算出纯文字卡上限、把超长文字截断
    //   → ③ 再分配一次（此时纯文字卡已被限高，两列高度才真正平衡）。
    // full=false 时只做 ①②（快速版，挂载后的第一次用它，避免一屏卡片来回搬两遍）；
    // full=true 才是完整的 ①②③（下一帧、旋转屏幕、切换单双列时用）。
    function layoutAll(cards, full) {
      if (!cards || !cards.length) return;
      buildCols();
      cards.forEach((c, i) => placeCard(c, i));
      syncMaxH();
      clampDescs();
      if (!full) return;
      buildCols();
      cards.forEach((c, i) => placeCard(c, i));
    }
    function relayout(full) {
      if (!grid.isConnected) return;
      const cards = Array.prototype.slice.call(grid.querySelectorAll('.record-card'));
      if (!cards.length) return;
      layoutAll(cards, full !== false);
    }
    applyView();
    function drawGrid() {
      const list = getFilteredSorted(domain);
      if (!list.length) {
        U().clear(grid); cols = []; heights = [0, 0]; counts = [0, 0];
        grid.appendChild(U().el('div', { class: 'empty-state', style: { width: '100%' } }, U().el('div', { class: 'es-icon', text: '📭' }), U().el('div', { text: App.state.data.records.length ? '没有匹配的记录' : '还没有记录，点击右下角 + 添加' })));
        return;
      }
      buildCols();
      list.forEach((r, i) => placeCard(recordCard(r, domain), i));
    }
    drawGrid();
    // 屏幕尺寸变化（旋转/分屏）后按新宽度重新分配，避免一列很长一列很短
    masonryRelayout = relayout;
    if (!masonryResizeBound) {
      masonryResizeBound = true;
      let t = 0;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (masonryRelayout) masonryRelayout(); }, 150); }, { passive: true });
    }

    container.appendChild(tools);
    container.appendChild(searchI);
    container.appendChild(selAllRow);
    container.appendChild(catRow);
    container.appendChild(tagRow);
    container.appendChild(grid);
    // 网格这时才挂进 DOM —— 之前拿不到真实列宽，也量不到卡片高度（全 0）。
    // 挂载后立刻量一次真实高度并给纯文字卡限高（快速版），下一帧再做完整重排。
    relayout(false);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (grid.isConnected) relayout(true); });
    }

    // 批量浮条（DOM 引用已提升到模块级 batchBarEl，勾选时实时刷新）
    batchBarEl = U().el('div', { class: 'batch-bar hidden' });
    container.appendChild(batchBarEl);
    updateBatchBar();

    // 列表页悬浮按钮（FAB）：「回到顶部」+「添加记录」，进入列表页即显示
    const fabLayer = U().el('div', { class: 'fab-layer', id: 'fab-layer' });
    const fabTop = U().el('button', { class: 'fab fab-top', html: U().icon('arrowUp', 22), title: '回到顶部' });
    fabTopEl = fabTop;
    fabTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const fabAdd = U().el('button', { class: 'fab fab-add', html: U().icon('plus', 24), title: '添加记录' });
    fabAdd.addEventListener('click', () => openEditor(null));
    fabLayer.appendChild(fabTop); fabLayer.appendChild(fabAdd);
    container.appendChild(fabLayer);
    fabLayer.classList.add('show'); // 容器常驻：保证「添加记录」一直可见
    ensureFabScroll();               // 首帧按当前滚动位置决定「回到顶部」显不显示
  }

  function openFilterModal(domain) {
    const fromBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
    const toBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
    function paintFrom() { fromBtn.textContent = dateFrom ? U().fmtDate(dateFrom) : '未选择起始日期'; fromBtn.classList.toggle('empty', !dateFrom); }
    function paintTo() { toBtn.textContent = dateTo ? U().fmtDate(dateTo) : '未选择结束日期'; toBtn.classList.toggle('empty', !dateTo); }
    paintFrom(); paintTo();
    fromBtn.addEventListener('click', () => U().openCalendar({ value: dateFrom ? U().fmtDate(dateFrom) : null, onSelect: (v) => { dateFrom = new Date(v + 'T00:00:00').getTime(); paintFrom(); } }));
    toBtn.addEventListener('click', () => U().openCalendar({ value: dateTo ? U().fmtDate(dateTo) : null, onSelect: (v) => { dateTo = new Date(v + 'T00:00:00').getTime(); paintTo(); } }));
    const cfWrap = U().el('div', { class: 'col', style: { gap: '8px' } });
    (domain.customFields || []).filter((f) => f.type === 'select').forEach((f) => {
      const sel = U().makeSelect([['', '不限']].concat((f.options || []).map((o) => [o.id, o.name])), cfFilters[f.id] || '', (v) => { if (v) cfFilters[f.id] = v; else delete cfFilters[f.id]; });
      sel.style.width = '100%';
      cfWrap.appendChild(U().el('div', { class: 'field' }, U().el('label', { text: f.name }), sel));
    });
    const reset = U().el('button', { class: 'btn', text: '重置筛选' });
    const apply = U().el('button', { class: 'btn primary', text: '应用' });
    const body = U().el('div', {},
      U().el('div', { class: 'field' }, U().el('label', { text: '起始日期' }), fromBtn),
      U().el('div', { class: 'field' }, U().el('label', { text: '结束日期' }), toBtn),
      cfWrap.childNodes.length ? U().el('div', { class: 'section-title', style: { marginTop: '8px' }, text: '按自定义属性' }) : null,
      cfWrap);
    const m = U().modal({
      title: '高级筛选', body, wide: true,
      actions: [
        { label: '重置', onClick: (c) => { dateFrom = null; dateTo = null; cfFilters = {}; paintFrom(); paintTo(); c(); renderListCurrent(); } },
        { label: '应用', primary: true, onClick: (c) => { c(); renderListCurrent(); } },
      ],
    });
    function renderListCurrent() { const v = App.app.view; if (v) App.records.renderList(v); }
  }

  function openMoveModal(ids, domain, after) {
    const others = App.state.data.domains.filter((d) => d.id !== domain.id);
    if (!others.length) { U().toast('没有其他领域可移动', 'err'); if (after) after(); return; }
    const box = U().el('div', { class: 'col', style: { gap: '8px' } });
    // 无论“移动成功 / 点取消 / 点关闭 / 点遮罩”，关闭后都彻底退出多选模式
    const m = U().modal({ title: '移动到其他领域（分类/标签按名称匹配）', body: box, onClose: () => { if (after) after(); } });
    others.forEach((d) => {
      const b = U().el('button', { class: 'btn', text: (d.icon || '') + '  ' + d.name });
      b.addEventListener('click', async () => {
        const r = await App.db.moveRecordsToDomain(ids, d.id);
        await App.state.reloadRecords(); await App.state.reloadDomains();
        U().toast('已移动 ' + r.moved + ' 条到「' + d.name + '」', 'ok');
        if (App.app.refreshChrome) App.app.refreshChrome();
        m.close();
      });
      box.appendChild(b);
    });
    const cancel = U().el('button', { class: 'btn block', text: '取消' });
    cancel.addEventListener('click', () => m.close());
    box.appendChild(cancel);
  }

  // —— 详情页右上「三个点」菜单：编辑 / 删除（标红）——
  function openDetailMenu(anchor, rec) {
    const panel = U().el('div', { class: 'popmenu' });
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      panel.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('scroll', close, true);
    }
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
    const editItem = U().el('button', { class: 'pm-item', html: U().icon('edit', 18) + '<span>编辑</span>' });
    editItem.addEventListener('click', () => { close(); openEditor(rec.id); });
    const delItem = U().el('button', { class: 'pm-item danger', html: U().icon('trash', 18) + '<span>删除</span>' });
    delItem.addEventListener('click', async () => {
      close();
      if (await U().confirmDialog('确定删除这条记录？图片也会一并删除。', { okLabel: '删除', danger: true })) {
        await App.db.deleteRecord(rec.id); await App.state.reloadRecords(); U().toast('已删除', 'ok'); App.app.go('records');
      }
    });
    panel.appendChild(editItem); panel.appendChild(delItem);
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + 'px';
    panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
    window.addEventListener('scroll', close, true);
  }

  function renderDetail(container, id) {
    U().clear(container);
    const domain = App.state.currentDomain();
    const rec = App.state.data.records.find((r) => r.id === id);
    if (!rec) { container.appendChild(U().el('div', { class: 'empty-state', text: '记录不存在' })); return; }
    const cat = domain.categories.find((c) => c.id === rec.categoryId);
    // —— 顶部栏：左上返回 + 右上「三个点」菜单 ——
    const back = U().el('button', { class: 'icon-btn', html: U().icon('arrowLeft', 22) });
    back.addEventListener('click', () => App.app.go('records'));
    const moreBtn = U().el('button', { class: 'icon-btn', html: U().icon('more', 22), title: '更多操作' });
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openDetailMenu(moreBtn, rec); });
    const topbar = U().el('div', { class: 'detail-topbar' }, back, U().el('div', { class: 'spacer' }), moreBtn);

    // —— 图片：传统单行横向轮播（只有图片滑动，正文不动）——
    // 回滚说明：之前那套「把上一条/下一条记录的图拼进序列」的跨记录无缝方案已整体删除，
    // 它会让每页只占 92% 宽、位移按百分比换算，最终在真机上表现为左右白边 + 图片割裂。
    // 现在回到最朴素可靠的实现：一页 = 容器 100% 宽，位移 = -index * 100%。
    const imgs = rec.imageIds || [];
    const total = imgs.length;
    const order = App.state.data.records.filter((r) => r.domainId === domain.id).slice().sort(sortCmp);
    const oi = order.findIndex((r) => r.id === rec.id);
    const prevId = oi > 0 ? order[oi - 1].id : null;
    const nextId = (oi >= 0 && oi < order.length - 1) ? order[oi + 1].id : null;

    let imgIdx = 0;
    let track = null, carousel = null, dotsEl = null;

    // 容器高度跟着「当前这张图」的原始比例走，图片用 cover 铺满 → 四边都没有白边。
    // 老内核 WebView（虚拟机常见）不支持 CSS aspect-ratio，光写比例会让容器高度塌成 0
    // 或退回默认 4:3 的灰底框，所以这里同时写一份显式像素高度兜底。
    function applyRatio() {
      if (!carousel || !track) return;
      const slide = track.children[imgIdx];
      const im = slide && slide.querySelector('img');
      if (!im || !im.naturalWidth || !im.naturalHeight) return;
      const w = carousel.clientWidth || carousel.offsetWidth || 0;
      if (!w) return;
      let h = Math.round(w * im.naturalHeight / im.naturalWidth);
      const cap = Math.round((window.innerHeight || 800) * 0.66);
      if (h > cap) h = cap;
      if (h < 1) return;
      carousel.style.height = h + 'px';
      carousel.style.aspectRatio = im.naturalWidth + ' / ' + im.naturalHeight;
    }
    function updateDots() {
      if (!dotsEl) return;
      const ds = dotsEl.children;
      for (let i = 0; i < ds.length; i++) ds[i].classList.toggle('active', i === imgIdx);
    }
    function paintTrack(offset, animate) {
      if (!track) return;
      track.style.transition = animate ? 'transform .3s cubic-bezier(.22,.7,.28,1)' : 'none';
      track.style.transform = 'translate3d(calc(' + (-imgIdx * 100) + '% + ' + (offset || 0) + 'px),0,0)';
    }
    function goImg(i) {
      if (!track) return;
      imgIdx = Math.max(0, Math.min(total - 1, i));
      paintTrack(0, true);
      updateDots();
      applyRatio();
    }
    if (total) {
      track = U().el('div', { class: 'dc-track' });
      // 每张图都记一个"到底有没有真图"的结果：全部落空时把图片区整块摘掉，
      // 不留给用户一个空灰框（图片被删/导入失败时会出现这种情况）。
      const loadFlags = imgs.map((imgId) => {
        const slide = U().el('div', { class: 'dc-slide' });
        const im = U().el('img');
        im.addEventListener('load', () => { if (slide === track.children[imgIdx]) applyRatio(); });
        const p = App.storage.getImageURL(imgId).then(async (u) => {
          if (u) im.src = u; else await fillThumb(im, imgId);
          return await waitImage(im);
        }).catch(async () => { await fillThumb(im, imgId); return await waitImage(im); });
        slide.appendChild(im); track.appendChild(slide);
        return p;
      });
      carousel = U().el('div', { class: 'detail-carousel' }, track);
      if (total > 1) {
        dotsEl = U().el('div', { class: 'dc-dots' });
        for (let i = 0; i < total; i++) dotsEl.appendChild(U().el('span', { class: 'dc-dot' + (i === 0 ? ' active' : '') }));
        carousel.appendChild(dotsEl);
      }
      paintTrack(0, false);
      Promise.all(loadFlags).then((flags) => {
        if (flags.some(Boolean)) return;
        if (carousel && carousel.parentNode) carousel.remove();
        carousel = null;   // 后面所有手势/比例逻辑都有 carousel 判空，摘掉即彻底不参与布局
      });
    }
    const hasImg = total > 0;

    // —— 全屏看图（缩放 / 拖拽 / 左右滑动切换 / 保存）——
    // 把同一条记录里所有「真的加载出来了」的图片一起交给灯箱，灯箱内可左右滑动切换；
    // 某个 id 的图已丢失（导入不完整/清过缓存）就跳过，避免滑到一张空白。
    function openViewer(i) {
      const list = [];
      (imgs || []).forEach((imgId, k) => {
        const node = track && track.children[k] ? track.children[k].querySelector('img') : null;
        if (node && node.src) list.push({ imgId: imgId, src: node.src });
      });
      if (!list.length) return;
      let at = list.findIndex((x) => x.imgId === imgs[i]);
      if (at < 0) at = 0;
      const baseName = (rec.title || '记录').replace(/[\\/:*?"<>|]/g, '_');
      U().openImageViewer({
        srcs: list.map((x) => x.src),
        index: at,
        nameAt: (k) => baseName + (list.length > 1 ? '-' + (k + 1) : '') + '.jpg',
        getBlobAt: (k) => App.storage.readImageForExport(list[k].imgId).then((ex) => (ex && ex.full) || null),
      });
    }

    // 标签：极简纯文本 #标签（与列表页一致，无边框/底色/彩点）
    const tagRow = U().el('div', { class: 'row wrap tag-line' });
    (rec.tagIds || []).forEach((tid) => { const t = domain.tags.find((x) => x.id === tid); if (t) tagRow.appendChild(U().el('span', { class: 'tag-text', text: '#' + t.name })); });

    const meta = U().el('div', { class: 'row wrap', style: { gap: '8px', margin: '4px 0' } });
    if (rec.timeSpentMin) meta.appendChild(U().el('span', { class: 'chip', html: U().icon('clock', 15) + (rec.timeSpentMin >= 60 ? ' ' + (rec.timeSpentMin / 60).toFixed(1) + ' 小时' : ' ' + rec.timeSpentMin + ' 分钟') }));
    if (rec.income) meta.appendChild(U().el('span', { class: 'chip inc', text: '收入 ' + U().fmtMoney(rec.income) }));
    if (rec.expense) meta.appendChild(U().el('span', { class: 'chip exp', text: '支出 ' + U().fmtMoney(rec.expense) }));

    // 自定义属性展示
    const cfRow = U().el('div', { class: 'row wrap', style: { gap: '6px', margin: '4px 0' } });
    (domain.customFields || []).forEach((f) => { const v = (rec.customValues || {})[f.id]; if (v == null || v === '') return; let txt = String(v); if (f.type === 'select') { const o = (f.options || []).find((o) => o.id === v); txt = o ? o.name : txt; } cfRow.appendChild(U().el('span', { class: 'chip', title: f.name, html: '<b>' + f.name + '：</b>' + txt })); });

    // —— 评论区：输入框置顶（小红书式）+ 时间排序（默认最新在上）——
    // 楼层号按「时间正序」固定计算（最早的 = 1 楼），与当前显示顺序无关：
    // 切到「最新在上」时看到的是 N楼…2楼…1楼，楼层不会跟着显示顺序短路。
    let commentDesc = true; // true = 最新在上（时间降序）
    const commentsBox = U().el('div', {});
    function floorMap() {
      const asc = (rec.comments || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const map = {};
      asc.forEach((c, i) => { map[c.id] = i + 1; });
      return map;
    }
    async function removeComment(id) {
      rec.comments = (rec.comments || []).filter((c) => c.id !== id);
      await App.db.saveRecord(rec);
      renderComments();
      commentCountEl.textContent = '评论 · ' + rec.comments.length;
      U().toast('已删除评论', 'ok');
    }
    // 删除入口：真机走系统原生底部操作菜单（plus.nativeUI.actionSheet），
    // 网页预览没有 plus，退化为浏览器原生 confirm —— 不使用网页自绘弹窗。
    function askDeleteComment(c) {
      const plus = window.plus;
      if (plus && plus.nativeUI && typeof plus.nativeUI.actionSheet === 'function') {
        plus.nativeUI.actionSheet({ title: '这条评论', cancel: '取消', buttons: [{ title: '删除' }] }, (e) => {
          if (e && e.index === 1) removeComment(c.id);
        });
        return;
      }
      if (typeof window.confirm === 'function' && window.confirm('删除这条评论？')) removeComment(c.id);
    }
    // 长按：触摸/鼠标按住 480ms 触发，移动超过 8px 视为滚动/滑动，取消长按。
    let lastLongAt = 0;
    function bindLongPress(node, fn) {
      let timer = null, sx = 0, sy = 0;
      const fire = () => {
        const now = Date.now();
        if (now - lastLongAt < 700) return;   // 手机会同时派发 contextmenu，去重
        lastLongAt = now;
        fn();
      };
      const start = (x, y) => {
        sx = x; sy = y;
        clearTimeout(timer);
        timer = setTimeout(fire, 480);
      };
      const move = (x, y) => {
        if (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8) { clearTimeout(timer); timer = null; }
      };
      const stop = () => { clearTimeout(timer); timer = null; };
      node.addEventListener('touchstart', (e) => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
      node.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
      node.addEventListener('touchend', stop, { passive: true });
      node.addEventListener('touchcancel', stop, { passive: true });
      node.addEventListener('mousedown', (e) => { if (e.button === 0) start(e.clientX, e.clientY); });
      node.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      node.addEventListener('mouseup', stop);
      node.addEventListener('mouseleave', stop);
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); stop(); fire(); });
    }
    function renderComments() {
      U().clear(commentsBox);
      const floors = floorMap();
      const list = (rec.comments || []).slice().sort((a, b) => commentDesc ? (b.createdAt - a.createdAt) : (a.createdAt - b.createdAt));
      if (!list.length) { commentsBox.appendChild(U().el('div', { class: 'muted', style: { fontSize: '0.85rem', padding: '4px 2px' }, text: '还没有评论' })); return; }
      list.forEach((c) => {
        const timeLine = U().el('div', { class: 'c-time' },
          U().el('span', { text: U().fmtDateTime(c.createdAt) }),
          U().el('span', { class: 'c-floor', text: ' · ' + (floors[c.id] || 1) + '楼' }));
        const item = U().el('div', { class: 'comment', 'data-cid': c.id },
          U().el('div', { class: 'c-text' }, U().el('div', { text: c.text }), timeLine));
        bindLongPress(item, () => askDeleteComment(c));
        commentsBox.appendChild(item);
      });
    }
    const commentCountEl = U().el('span', { text: '评论 · ' + (rec.comments || []).length });
    const sortToggle = U().el('button', { class: 'icon-btn comment-sort', html: U().icon(commentDesc ? 'arrowDown' : 'arrowUp', 15), title: '切换排序：最新 / 最早' });
    sortToggle.addEventListener('click', () => { commentDesc = !commentDesc; sortToggle.innerHTML = U().icon(commentDesc ? 'arrowDown' : 'arrowUp', 15); renderComments(); });
    const commentHeader = U().el('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' } },
      U().el('div', { class: 'section-title', style: { margin: '0' } }, commentCountEl), sortToggle);
    const commentI = U().el('input', { class: 'input', placeholder: '写条评论…' });
    const sendBtn = U().el('button', { class: 'btn primary', text: '发送' });
    sendBtn.addEventListener('click', async () => {
      const txt = commentI.value.trim(); if (!txt) return;
      rec.comments = rec.comments || []; rec.comments.push({ id: App.storage.uid(), text: txt, createdAt: App.storage.now() });
      await App.db.saveRecord(rec); commentDesc = true; renderComments(); commentI.value = '';
      commentCountEl.textContent = '评论 · ' + rec.comments.length;
      U().toast('已添加评论', 'ok');
    });
    renderComments();
    const commentCompose = U().el('div', { class: 'row comment-compose', style: { marginTop: '10px', gap: '8px' } }, commentI, sendBtn);

    const card = U().el('div', { class: 'card' },
      rec.title ? U().el('h2', { text: rec.title, style: { fontSize: '1.25rem', marginBottom: '6px' } }) : null,
      U().el('div', { class: 'row wrap tag-line', style: { marginBottom: '10px' } }, cat ? U().el('span', { class: 'chip detail-cat', text: cat.name }) : null, U().el('span', { class: 'muted', style: { fontSize: '0.75rem' }, text: U().fmtDate(rec.date || rec.createdAt) })),
      !hasImg ? U().el('div', { class: 'muted', text: '（无图片）' }) : null,
      rec.description ? U().el('p', { class: 'detail-desc', text: rec.description }) : null,
      tagRow.childNodes.length ? tagRow : null,
      meta.childNodes.length ? meta : null,
      cfRow.childNodes.length ? cfRow : null,
      commentHeader,
      commentCompose,
      commentsBox,
    );

    // —— 组装：顶部栏 / [图片 + 正文] ——
    // 图片和正文包在同一个 .detail-sheet 里：整页翻页时它们一起跟手移动。
    const page = U().el('div', { class: 'detail-page' });
    page.appendChild(topbar);
    const sheet = U().el('div', { class: 'detail-sheet' });
    if (carousel) sheet.appendChild(carousel);
    sheet.appendChild(card);
    page.appendChild(sheet);
    container.appendChild(page);
    // 挂到文档后才有真实宽度，此时再校正一次轮播高度（首帧不闪 4:3）
    if (carousel) { applyRatio(); requestAnimationFrame(applyRatio); }

    // 刚由相邻记录翻过来：新页面从同一侧滑入，视觉上接着上一屏
    if (pendingEnter) {
      const d = pendingEnter.dir || 1; pendingEnter = null;
      sheet.style.transition = 'none';
      sheet.style.transform = 'translate3d(' + (d * 24) + '%,0,0) scale(.965)';
      sheet.style.opacity = '0.3';
      // 用 setTimeout 而不是 requestAnimationFrame：rAF 在后台/低帧率场景可能被挂起，
      // 一旦不回调，新页面就会永远停在 24% 的偏移位置上。
      setTimeout(() => {
        sheet.style.transition = 'transform .3s cubic-bezier(.22,.7,.28,1), opacity .3s';
        sheet.style.transform = 'translate3d(0,0,0) scale(1)';
        sheet.style.opacity = '1';
      }, 20);
    }

    // 松手但没翻页：弹回原位
    function springBack() {
      sheet.style.transition = 'transform .28s cubic-bezier(.22,.7,.28,1), opacity .28s';
      sheet.style.transform = 'translate3d(0,0,0) scale(1)';
      sheet.style.opacity = '1';
    }
    // 整页翻页：dir=1 下一条（整页向左滑出），dir=-1 上一条
    function flipSheet(dir) {
      const to = dir > 0 ? nextId : prevId;
      if (!to) { springBack(); return; }
      sheet.style.transition = 'transform .22s cubic-bezier(.4,0,.72,1), opacity .22s';
      sheet.style.transform = 'translate3d(' + (dir * 102) + '%,0,0) scale(.94)';
      sheet.style.opacity = '0';
      pendingEnter = { dir: dir };
      setTimeout(() => App.app.go('record/' + to), 180);
    }

    // —— 手势 ——
    // ① 图片区左右滑 = 当前记录内部切图（传统轮播，正文不动）
    // ② 已经是第一张/最后一张，还继续往同方向滑 = 整页跟手翻页（图片 + 正文一起动）
    // ③ 图片区点击（无位移）= 全屏看图
    // 图片以外的区域完全不接管手势，滚动、选字、按钮点击都保持原生行为。
    let g = null;
    const atFirst = () => imgIdx <= 0;
    const atLast = () => imgIdx >= total - 1;
    function onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target;
      // 评论区长按要弹删除菜单，不能同时被当作翻页手势起点
      if (t.closest && t.closest('input,textarea,button,select,a,label,.comment')) return;
      // 手势从整页任意「非交互」区域都能发起（修复「图片外区域滑动毫无反应」）。
      // 是否落在图片区只用于区分后续是「切换图」还是「翻整页」，不再拦截起始位置。
      const onCarousel = !!(carousel && carousel.contains(t));
      g = { x: e.clientX, y: e.clientY, dx: 0, v: 0, lx: e.clientX, lt: Date.now(), t0: Date.now(), decided: false, mode: null, onCarousel };
      if (track) track.style.transition = 'none';
      sheet.style.transition = 'none';
      if (onCarousel) carousel.classList.add('grabbing');
      try { page.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function onMove(e) {
      if (!g) return;
      const now = Date.now();
      if (now - g.lt > 8) { g.v = (e.clientX - g.lx) / Math.max(1, now - g.lt); g.lx = e.clientX; g.lt = now; }
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.decided) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        g.decided = true;
        if (Math.abs(dx) <= Math.abs(dy) * 1.15) { g = null; return; } // 竖滑：交回页面原生滚动
      }
      g.dx = dx;
      if (e.cancelable) e.preventDefault();
      // 图片区滑到头继续同方向 = 整页翻页；不在图片区发起的横向滑动 = 直接整页翻页；
      // 仅在图片区且未到头时，才做记录内部切图。
      const canFlip = (atFirst() && dx > 0 && prevId) || (atLast() && dx < 0 && nextId);
      const wantPage = canFlip || !g.onCarousel;
      if (wantPage) {
        g.mode = 'page';
        if (track) track.style.transform = 'translate3d(calc(' + (-imgIdx * 100) + '%),0,0)';
        const d = dx * 0.92;
        sheet.style.transform = 'translate3d(' + d + 'px,0,0) scale(' + (1 - Math.min(.045, Math.abs(d) / 3000)) + ')';
        sheet.style.opacity = String(Math.max(.35, 1 - Math.abs(d) / 1100));
      } else {
        g.mode = 'img';
        if (!track) return;
        let d = dx;
        if ((atFirst() && d > 0) || (atLast() && d < 0)) d *= 0.3; // 到头给阻尼，明确「没有下一张了」
        track.style.transform = 'translate3d(calc(' + (-imgIdx * 100) + '% + ' + d + 'px),0,0)';
      }
    }
    function onUp(e) {
      if (!g) return;
      const dx = g.dx, v = g.v, mode = g.mode, tap = !g.decided && (Date.now() - g.t0) < 700, onCar = g.onCarousel;
      g = null;
      try { page.releasePointerCapture(e.pointerId); } catch (_) {}
      if (carousel) carousel.classList.remove('grabbing');
      if (tap) { if (onCar) openViewer(imgIdx); return; } // 点击图片区才打开看图；点文字区不触发
      if (!mode) return;
      const w = (carousel && carousel.clientWidth) || 320;
      if (mode === 'page') {
        const far = Math.abs(dx) > Math.min(90, w * 0.22);
        const fast = Math.abs(v) > 0.5 && Math.abs(dx) > 18;
        if (far || fast) flipSheet(dx < 0 ? 1 : -1); else springBack();
      } else {
        const far = Math.abs(dx) > Math.min(70, w * 0.18);
        const fast = Math.abs(v) > 0.5 && Math.abs(dx) > 14;
        if (far || fast) goImg(imgIdx + (dx < 0 ? 1 : -1)); else paintTrack(0, true);
      }
    }
    page.addEventListener('pointerdown', onDown);
    page.addEventListener('pointermove', onMove, { passive: false });
    page.addEventListener('pointerup', onUp);
    page.addEventListener('pointercancel', onUp);
  }

  // —— 编辑器（含自定义属性动态字段）——
  function openEditor(recId) {
    const domain = App.state.currentDomain();
    const existing = recId ? App.state.data.records.find((r) => r.id === recId) : null;
    let imageIds = existing ? (existing.imageIds || []).slice() : [];
    let selectedTags = existing ? (existing.tagIds || []).slice() : [];
    let customValues = existing ? Object.assign({}, existing.customValues) : {};
    const sessionAdded = [];
    let categoryId = existing ? existing.categoryId : (domain.categories[0] ? domain.categories[0].id : null);

    const titleI = U().el('input', { class: 'input', placeholder: '标题（可选）', value: existing ? existing.title : '' });
    const catSel = U().makeSelect(domain.categories.map((c) => [c.id, c.name]), categoryId, (v) => { categoryId = v; });
    catSel.classList.add('full');
    const catPlus = U().el('button', { class: 'icon-btn', html: U().icon('plusCircle', 18), title: '新建分类' });
    catPlus.addEventListener('click', () => U().quickAddCategory(domain, (item) => { App.db.saveDomain(domain); catSel.setOptions(domain.categories.map((c) => [c.id, c.name]), item.id); categoryId = item.id; if (App.app.refreshChrome) App.app.refreshChrome(); }));
    const catWrap = U().el('div', { class: 'row', style: { gap: '8px' } }, catSel, catPlus);
    // textarea 的 value 不能用 setAttribute 设置（对 textarea 无效），必须在创建后赋 .value，否则编辑时文字不回显
    const descI = U().el('textarea', { class: 'textarea', placeholder: '文字说明…' });
    descI.value = existing ? (existing.description || '') : '';
    let descTouched = false;
    descI.addEventListener('input', () => { descTouched = true; });
    const timeI = U().el('input', { class: 'input', type: 'number', min: '0', placeholder: '分钟', value: existing ? (existing.timeSpentMin || '') : '' });
    const incI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existing ? (existing.income || '') : '' });
    const expI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existing ? (existing.expense || '') : '' });
    let recDate = existing ? existing.date : Date.now();
    const dateBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
    function paintDate() { dateBtn.textContent = U().fmtDate(recDate); }
    paintDate();
    dateBtn.addEventListener('click', () => U().openCalendar({ value: U().fmtDate(recDate), onSelect: (v) => { recDate = new Date(v + 'T00:00:00').getTime(); paintDate(); } }));

    // 标签：未选=灰字 #标签；选中=胶囊
    const tagBox = U().el('div', { class: 'row wrap tag-line', style: { gap: '4px 10px' } });
    function rebuildTags() {
      U().clear(tagBox);
      domain.tags.forEach((t) => {
        const on = selectedTags.includes(t.id);
        const chip = U().el('span', { class: 'tag-sel' + (on ? ' on' : ''), text: '#' + t.name });
        chip.addEventListener('click', () => {
          if (selectedTags.includes(t.id)) { selectedTags = selectedTags.filter((x) => x !== t.id); chip.classList.remove('on'); }
          else { selectedTags.push(t.id); chip.classList.add('on'); }
        });
        tagBox.appendChild(chip);
      });
      const plus = U().el('span', { class: 'tag-sel tag-new', html: U().icon('plus', 14) + '<span>新建</span>', title: '新建标签' });
      plus.addEventListener('click', () => U().quickAddTag(domain, (item) => { App.db.saveDomain(domain); rebuildTags(); if (App.app.refreshChrome) App.app.refreshChrome(); }));
      tagBox.appendChild(plus);
      if (!domain.tags.length) tagBox.appendChild(U().el('span', { class: 'muted', text: '暂无标签，可点「新建」添加' }));
    }
    rebuildTags();

    // 自定义属性表单
    const cfWrap = U().el('div', { class: 'col', style: { gap: '10px' } });
    function rebuildCustom() {
      U().clear(cfWrap);
      (domain.customFields || []).forEach((f) => {
        let control;
        if (f.type === 'select') {
          const opts = [['', '—']].concat((f.options || []).map((o) => [o.id, o.name]));
          const sel = U().makeSelect(opts, customValues[f.id] || '', (v) => { if (v) customValues[f.id] = v; else delete customValues[f.id]; });
          sel.classList.add('full');
          control = sel;
        } else if (f.type === 'number') {
          const n = U().el('input', { class: 'input', type: 'number', value: customValues[f.id] != null ? customValues[f.id] : '' });
          n.addEventListener('input', () => { if (n.value === '') delete customValues[f.id]; else customValues[f.id] = Number(n.value); });
          control = n;
        } else {
          const t = U().el('input', { class: 'input', value: customValues[f.id] != null ? customValues[f.id] : '' });
          t.addEventListener('input', () => { if (t.value === '') delete customValues[f.id]; else customValues[f.id] = t.value; });
          control = t;
        }
        cfWrap.appendChild(U().el('div', { class: 'field' }, U().el('label', { text: f.name }), control));
      });
    }
    rebuildCustom();

    const fileInput = U().el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
    // 图片区：全屏页最顶端，大尺寸网格预览（空态是一整块上传区）
    const mediaBox = U().el('div', { class: 'media-grid' });
    function renderPreview() {
      U().clear(mediaBox);
      if (!imageIds.length) {
        mediaBox.classList.add('empty');
        const drop = U().el('div', { class: 'media-drop' }, U().el('div', { class: 'md-icon', text: '🖼️' }), U().el('div', { class: 'md-text', text: '点击添加图片' }), U().el('div', { class: 'md-sub', text: '可多选，支持拖拽' }));
        drop.addEventListener('click', () => fileInput.click());
        mediaBox.appendChild(drop);
        return;
      }
      mediaBox.classList.remove('empty');
      imageIds.forEach((id) => {
        const cell = U().el('div', { class: 'mg-item' });
        const im = U().el('img');
        fillThumb(im, id);
        const rm = U().el('div', { class: 'rm', text: '×' });
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          await App.storage.deleteImage(id);
          imageIds = imageIds.filter((x) => x !== id);
          renderPreview();
        });
        cell.appendChild(im); cell.appendChild(rm);
        mediaBox.appendChild(cell);
      });
      const add = U().el('div', { class: 'mg-add', html: U().icon('plus', 22) + '<span>添加</span>' });
      add.addEventListener('click', () => fileInput.click());
      mediaBox.appendChild(add);
    }
    fileInput.addEventListener('change', async () => { await handleFiles(fileInput.files); fileInput.value = ''; });
    ['dragover', 'dragenter'].forEach((ev) => mediaBox.addEventListener(ev, (e) => { e.preventDefault(); mediaBox.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => mediaBox.addEventListener(ev, (e) => { e.preventDefault(); mediaBox.classList.remove('drag'); }));
    mediaBox.addEventListener('drop', async (e) => { if (e.dataTransfer && e.dataTransfer.files) await handleFiles(e.dataTransfer.files); });
    async function handleFiles(files) { for (const f of files) { if (!f.type || f.type.indexOf('image/') !== 0) { U().toast('已跳过非图片文件', 'err'); continue; } const th = await U().makeThumb(f); const id = App.storage.uid(); await App.storage.saveImage(Object.assign({ id }, th)); imageIds.push(id); sessionAdded.push(id); } renderPreview(); U().toast('已添加 ' + files.length + ' 张图片', 'ok'); }
    renderPreview();

    function field(label, ...controls) { return U().el('div', { class: 'field' }, U().el('label', { text: label }), ...controls); }

    // 文字输入：标题一行、正文一块（都不带边框，像原生发布页）
    titleI.className = 'ed-title';
    descI.className = 'ed-desc';
    const timeRow = U().el('div', { class: 'row', style: { gap: '8px' } }, dateBtn, U().el('div', { class: 'ed-inline' }, timeI, U().el('span', { class: 'muted', text: '分钟' })));
    const moneyRow = U().el('div', { class: 'row', style: { gap: '10px' } }, U().el('div', { class: 'ed-inline' }, U().el('span', { class: 'muted', text: '收入 ¥' }), incI), U().el('div', { class: 'ed-inline' }, U().el('span', { class: 'muted', text: '支出 ¥' }), expI));

    // 顺序：图片 → 标题 → 正文 → 分类 → 标签 → 时间 → 金额 → 自定义属性
    const body = U().el('div', { class: 'ed-form' },
      U().el('div', { class: 'ed-media' }, mediaBox, fileInput),
      titleI,
      descI,
      field('分类', catWrap),
      field('标签', tagBox),
      field('时间', timeRow),
      field('金额', moneyRow),
      (domain.customFields && domain.customFields.length) ? field('自定义属性', cfWrap) : null,
    );

    let saved = false;
    const m = U().fullPage({
      title: existing ? '编辑记录' : '新建记录',
      body,
      onClose: () => { if (!saved) sessionAdded.forEach((id) => App.storage.deleteImage(id).catch(() => {})); },
      actions: [
        { label: '取消', onClick: (close) => close() },
        { label: '保存', primary: true, onClick: async (close) => {
            const dval = recDate;
            const rec = {
              id: existing ? existing.id : App.storage.uid(), domainId: domain.id,
              categoryId, tagIds: selectedTags, title: titleI.value.trim(),
              description: descTouched ? descI.value.trim() : ((existing && existing.description) || descI.value.trim()), imageIds: imageIds.slice(),
              timeSpentMin: Number(timeI.value) || 0, income: Number(incI.value) || 0, expense: Number(expI.value) || 0,
              customValues: customValues,
              date: isNaN(dval) ? Date.now() : dval,
              createdAt: existing ? existing.createdAt : App.storage.now(), updatedAt: App.storage.now(),
              comments: existing ? (existing.comments || []) : [],
            };
            await App.db.saveRecord(rec); saved = true;
            await App.state.reloadRecords(); U().toast('已保存', 'ok'); close(); App.app.renderRoute();
          } },
      ],
    });
  }

  return { renderList, renderDetail, openEditor };
})();
