/* ===== records.js — 记录管理（多图画廊 / 灯箱 / 评论 / 编辑 / 筛选 / 批量）===== */
window.App = window.App || {};
App.records = (function () {
  const U = () => App.ui;
  let filterCat = null, filterTags = [], searchText = '';
  // 标签筛选浮层挂在 body 上：离开列表页 / 重绘列表时必须显式关掉，否则会留一层浮层在屏幕上
  let closeTagPanelRef = null;
  let sortField = 'date', sortDir = 'desc'; // 默认：记录日期 ↓（新→旧）
  let sortPanelEl = null;
  let dateFrom = null, dateTo = null, cfFilters = {};
  let multiMode = false, selected = {};
  let batchBarEl = null, viewContainer = null, viewDomain = null;
  let selAllCbEl = null, selAllTxtEl = null;
  // 整页翻页后，新记录从哪一侧滑入（1=右侧，-1=左侧）。
  // 只用于「入场动画」，不做任何数据/页码状态，翻页失败也不影响页面本身。
  let pendingEnter = null;

  // —— 字数胶囊：编辑器同一时刻只有一个，所以模块级只留一份引用 ——
  // activeDescI 同时给「全局唯一的 selectionchange 监听」做判断，避免每次打开编辑页都挂一个监听。
  let activeDescI = null;
  let activeCountPill = null;
  // 评论删除：每条评论右侧一个「···」按钮 → 二次确认弹窗。
  // 历史上试过长按（650ms 弹底部操作条），在安卓 WebView 上必然和系统选字冲突：
  // 一按住文字，系统先立起选区、弹出「复制/全选」气泡并截走触摸，我们的条要么被盖住、
  // 要么被判定成拖动而取消。现在长按完完整整还给系统（选字复制照旧），删除只走显式按钮。


  // 只统计文字与标点：Markdown 记号与空白都不算（口径在 md.js 的 count() 里统一维护）
  function paintCountPill() {
    const ta = activeDescI, pill = activeCountPill;
    if (!ta || !pill) return;
    const v = ta.value || '';
    const s = ta.selectionStart, e = ta.selectionEnd;
    const hasSel = s != null && e != null && e > s;   // s === e 就是没选中，不能显示「已选 0 字」
    const n = (App.md && App.md.count) ? App.md.count(hasSel ? v.slice(s, e) : v) : 0;
    pill.textContent = hasSel ? ('已选' + n + '字') : (n + '字');
    if (hasSel) pill.classList.add('on'); else pill.classList.remove('on');
  }
  // 输入法一次上屏会连发多个事件，合并成一次重算（长文重算是纯字符串正则，别在每次按键里跑两遍）。
  // 这里用 16ms 定时器而不是 requestAnimationFrame：
  // rAF 在页面不可见 / WebView 被系统暂停时不会回调，一旦那次没跑，计数闸门就永远卡住，
  // 之后无论怎么打字字数都不再变化（真机切后台再回来就会遇到）。定时器一定会触发。
  let countTimer = 0;
  function scheduleCountPill() {
    if (countTimer) return;
    countTimer = setTimeout(function () { countTimer = 0; paintCountPill(); }, 16);
  }
  // textarea 的 selectionchange 在老内核里不一定派发，这里只作加分项；
  // 真正的刷新靠 openEditor 里绑的 input / select / keyup / mouseup / touchend。
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('selectionchange', function () {
      if (activeDescI && document.activeElement === activeDescI) scheduleCountPill();
    });
  }

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

  // Markdown → HTML（详情页正文）。
  // 关键点 1：用户敲了几个空行，详情页就必须原样显示几个空行。因此不能用 md.render 整体切块
  // （它会把连续多个空行塌缩成一段间距，导致「敲了几个空行只显示一行」）。
  // 关键点 2：块级元素两侧**不能**无脑补 <br>（会多出一整行高的匿名行盒），
  // 但用户亲手敲的空行**必须**原样显示 —— 这两件事靠「空行计数」区分开。
  // 旧实现有个更早的毛病：把所有行（含块级行）都当成一行、最后 out.join('<br>')，
  // 于是每个 </h1>、</ul> 后面都紧跟一个 <br>，块级元素外多出一整行（1.78rem ≈ 28px）——
  // 那才是「标题上下各隔一个空行」的根因（实测：标题上 49px / 下 38px）。
  // 现在：块级元素自身的间距交给 CSS（.detail-desc.md-body 里用 rem 定义，随字号档位等比缩放），
  // 用户敲的空行则按个数补 <br>。
  // 规则：
  //   · 空行只累积计数。内联→内联补 blanks+1 个 <br>（第一个只是换行）；
  //   · 内联→块级补 blanks+1 个；块级之间、块级→内联只补 blanks 个（块级自己会断行）；
  //   · blanks=0 时一个都不补 —— 「正文A\n- 甲」这种紧挨着的写法不会多出空行；
  //   · 块级行丢弃行首 &nbsp; 缩进（否则会多出一个只含 nbsp 的行盒）；
  //   · 首块/末块打 data-first / data-last，供 CSS 收掉多余的上下边距；
  //     注意 data-first 只在 buf 还空着时打 —— 前面已有空行时不打，标题自带的半边距照旧叠加；
  //   · 代码围栏整组交给 md.render，输出一个完整的 <pre class="md-pre"><code>。
  function mdHtml(src) {
    if (src == null) return '';
    if (App.md && App.md.render) {
      const lines = String(src).split('\n');
      const isList = (s) => /^\s*([-*+]|\d+\.)\s+/.test(s);
      const isQuote = (s) => /^\s*>/.test(s);
      const isFence = (s) => /^\s*```/.test(s);
      const BLOCK_RE = /^<(h[1-6]|ul|ol|blockquote|pre|hr)\b/;
      let buf = '';
      let lastKind = '';       // '' | 'inline' | 'block'
      let blanks = 0;          // 距上一个内容块累积的空行数
      let lastBlockAt = -1;    // 最后一个块在 buf 里的起始下标（收尾时给末块打 data-last）
      const breaks = (n) => { while (n-- > 0) buf += '<br>'; };
      function emit(html, kind) {
        if (!html) return;
        // 内联→内联：一个换行 + 用户敲的空行，一个都不能少
        if (lastKind === 'inline' && kind === 'inline') breaks(blanks + 1);
        // 其余相邻关系：空行必须原样显示。
        // 计数规则 —— 连续 k 个 <br> 只产生 k-1 行空白（第一个 <br> 只是结束当前行）；
        // 而块级元素自己会断行，所以「内联 → 块级」要多补一个，块级之间/块级→内联则刚好 k 个。
        else if (blanks > 0) breaks(kind === 'block' && lastKind === 'inline' ? blanks + 1 : blanks);
        if (kind === 'block') {
          if (!buf) html = html.replace(/^<([a-zA-Z0-9]+)/, '<$1 data-first="1"');
          lastBlockAt = buf.length;
        }
        buf += html;
        lastKind = kind;
        blanks = 0;
      }
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.length === 0) { blanks++; i++; continue; }
        // 代码围栏：连围栏行一起整段交给 md.render，避免被逐行渲染成一堆空 <pre>
        if (isFence(line)) {
          const grp = [line]; i++;
          while (i < lines.length) {
            const cur = lines[i]; grp.push(cur); i++;
            if (isFence(cur)) break;
          }
          emit(App.md.render(grp.join('\n')), 'block');
          continue;
        }
        // 列表 / 引用：整组渲染，保证合成单个 <ul>/<blockquote>
        if (isList(line) || isQuote(line)) {
          const grp = [];
          while (i < lines.length && ((isList(line) && isList(lines[i])) || (isQuote(line) && isQuote(lines[i])))) {
            grp.push(lines[i]); i++;
          }
          const h = App.md.render(grp.join('\n')).replace(/^<p>/, '').replace(/<\/p>$/, '');
          emit(h, 'block');
          continue;
        }
        // 普通行：逐行渲染（标题/加粗/斜体/代码…），去掉 md.render 包的外层 <p>…</p>。
        // 关键：Markdown 解析会剥掉「行首空格」，导致详情页开头空格消失。
        // 所以先把行首空白摘出来，渲染剩余内容后再用 &nbsp; 原样补回去，
        // 空格→&nbsp;（永不触发 HTML 空格折叠），Tab 保留原样（pre-wrap 下显示制表位）。
        const leadMatch = line.match(/^[ \t]+/);
        let lead = leadMatch ? leadMatch[0] : '';
        lead = lead.replace(/ /g, '&nbsp;');
        const h = App.md.render(line.replace(/^[ \t]+/, '')).replace(/^<p>/, '').replace(/<\/p>$/, '');
        // 块级判定看渲染结果（而不是行首模式）：`---` 会变成 <hr>，缩进的 `# 标题` 仍是标题
        if (BLOCK_RE.test(h)) emit(h, 'block');
        else emit(lead + h, 'inline');
        i++;
      }
      if (lastKind === 'block' && lastBlockAt >= 0) {
        buf = buf.slice(0, lastBlockAt) + buf.slice(lastBlockAt).replace(/^<([a-zA-Z0-9]+)/, '<$1 data-last="1"');
      }
      return buf;
    }
    // 兜底（没有 md 模块时）：转义后按 \n 原样换成 <br>，宁可少排版也不能白屏/注入
    return String(src).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>');
  }

  // 列表封面 / 编辑页预览统一读原图：不再生成缩略图，尺寸交给 CSS 等比缩放。
  async function fillCover(imgEl, id) {
    const u = await App.storage.getImageURL(id);
    if (u) { imgEl.dataset.cover = id; imgEl.src = u; } else imgEl.style.background = 'var(--surface-2)';
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
    const descText = (App.md && App.md.plain) ? App.md.plain(rec.description) : String(rec.description || '').trim();
    // 卡片右下角的字数：口径与详情页完全一致（只算文字与标点，Markdown 记号与空白不算）
    const descCount = (App.md && App.md.count) ? App.md.count(rec.description) : 0;
    const titleEl = U().el('div', { class: 'rc-title', text: rec.title || '未命名记录' });
    const descEl = descText ? U().el('div', { class: 'rc-desc', text: descText }) : null;
    function putDesc() {
      if (!descEl || descEl.parentNode || !body) return;
      if (titleEl.parentNode === body) body.insertBefore(descEl, titleEl.nextSibling); else body.appendChild(descEl);
    }
    if (firstId) {
      cover = U().el('div', { class: 'thumb-cover' });
      // 封面用懒加载：列表里几十上百张图时，只有滚到眼前的才真正解码，滑动不卡
      const im = U().el('img', { loading: 'lazy', decoding: 'async' });
      // 图片文件其实已经不在了（导入不完整、被清理过）→ 封面整块摘掉，卡片改走纯文字排版
      const dropCover = () => {
        if (cover && cover.parentNode) cover.remove();
        cover = null;
        card.classList.add('no-cover');
        putDesc();
        scheduleRelayout();   // 卡片变矮了，稍后按新高度重新平衡两列
      };
      im.addEventListener('error', dropCover);
      fillCover(im, firstId).then(() => { if (!im.getAttribute('src')) dropCover(); }).catch(dropCover);
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
    // 卡片脚注：左边日期、右边字数，同一行两端对齐 —— 所有卡片的字数都压在右下角，
    // 扫列表时位置固定、成列，不会随标题长短跳来跳去（rc-foot 用 margin-top:auto 顶到底）。
    const foot = U().el('div', { class: 'rc-foot' },
      U().el('span', { class: 'rc-date', text: U().fmtDate(rec.date || rec.createdAt) }),
      descCount > 0 ? U().el('span', { class: 'rc-count', text: descCount + ' 字' }) : null);
    body = U().el('div', { class: 'rc-body' },
      titleEl,
      metaRow.childNodes.length ? metaRow : null,
      metaChips.childNodes.length ? metaChips : null,
      foot);
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

  // 详情页点标签 → 跳列表并只看这个标签的记录。
  // 其它筛选一律清空（分类 / 搜索词 / 日期 / 自定义属性 / 多选），否则点过去经常一片空白，
  // 用户会以为「这个标签下没有记录」。清空后 filterTags 只有这一项，paintTagFilter 会自动
  // 画成「已选 1 个 + #标签 ×」，用户随时能在列表页把它去掉。
  function gotoTag(tagId) {
    filterCat = null;
    filterTags = [tagId];
    searchText = '';
    dateFrom = null; dateTo = null;
    cfFilters = {};
    multiMode = false; selected = {};
    App.app.go('records');
  }

  function getFilteredSorted(domain) {
    let list = App.state.data.records.slice();
    if (filterCat) list = list.filter((r) => r.categoryId === filterCat);
    // 标签：多选，「任一命中」即保留；与分类 / 日期 / 搜索条件叠加（且的关系）
    if (filterTags.length) list = list.filter((r) => filterTags.some((tid) => (r.tagIds || []).includes(tid)));
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
      // 批量删除：红色按钮 + 二次确认，确认后逐条删（图片一起删），期间显示进度
      const delBtn = U().el('button', { class: 'btn danger', text: '删除' });
      delBtn.addEventListener('click', async () => {
        const ids = Object.keys(selected);
        if (!ids.length) return;
        batchBarEl.classList.add('hidden');   // 先让底栏让位，避免和确认弹窗的遮罩叠在一起
        const ok = await U().confirmDialog('确定删除选中的 ' + ids.length + ' 条记录？关联的图片也会一并删除，且不可恢复。', { okLabel: '删除', danger: true });
        if (!ok) { updateBatchBar(); return; }
        U().showBusy('正在删除…');
        let done = 0, failed = 0;
        try {
          for (let i = 0; i < ids.length; i++) {
            U().setBusyText('正在删除 ' + (i + 1) + ' / ' + ids.length + '…');
            try { await App.db.deleteRecord(ids[i]); done++; }
            catch (_) { failed++; }   // 单条失败不能中断整批，否则后面的记录看着像删了其实没删
          }
          await App.state.reloadRecords();
        } catch (_) {
          // 刷新失败也要往下走：否则遮罩撤了、列表却没重绘，看着像删一半
        } finally {
          U().hideBusy();
        }
        // 删除期间用户可能已经按返回切走了页面：此时别再往脱离文档的容器里渲染
        if (viewContainer && viewContainer.isConnected === false) { selected = {}; multiMode = false; }
        else { exitMulti(); window.scrollTo(0, 0); }   // 列表变短后浏览器会把滚动位置夹到页底，主动回到顶部
        if (failed) U().toast('已删除 ' + done + ' 条，' + failed + ' 条失败', 'err');
        else U().toast('已删除 ' + done + ' 条', 'ok');
      });
      batchBarEl.appendChild(U().el('span', { class: 'batch-count', text: '已选 ' + keys.length + ' 条' }));
      batchBarEl.appendChild(U().el('div', { class: 'batch-actions' }, moveBtn, delBtn, cancel));
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
    if (closeTagPanelRef) { try { closeTagPanelRef(); } catch (e) {} closeTagPanelRef = null; }
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
      U().clear(catRow);
      const mkChip = (label, key) => { const c = U().el('span', { class: 'chip selectable' + (filterCat === key ? ' active' : ''), text: label }); c.addEventListener('click', () => { filterCat = key; rebuildChips(); drawGrid(); }); return c; };
      catRow.appendChild(mkChip('全部', null));
      // 分类保持原有单选逻辑（点了就换，不叠加）
      domain.categories.forEach((cat) => catRow.appendChild(mkChip(cat.name, cat.id)));
      const plusCat = U().el('span', { class: 'chip add-chip', html: U().icon('plus', 15), title: '新建分类' });
      plusCat.addEventListener('click', () => U().quickAddCategory(domain, () => { App.db.saveDomain(domain); rebuildChips(); App.app.refreshChrome && App.app.refreshChrome(); }));
      catRow.appendChild(plusCat);
    }

    // —— 标签筛选：下拉菜单 + 菜单内文字搜索 + 多选（点选不关菜单）——
    // 交互：点「标签」按钮弹出浮层 → 顶部输入框边打字边过滤 → 点某一项立刻生效、
    // 浮层不关（方便连续点几个）→ 已选的标签在按钮右侧以「#标签 ×」形式常驻，点 × 取消。
    const tagLabel = U().el('span', { class: 'cf-sel-label' });
    const tagBtn = U().el('button', { class: 'cf-sel tag-select', type: 'button' },
      tagLabel, U().el('span', { class: 'cf-sel-chev', html: U().icon('chevron', 14) }));
    const tagPicked = U().el('div', { class: 'tag-picked' });
    let tagPanel = null, tagListEl = null, tagSearchEl = null;

    function paintTagFilter() {
      // 标签可能已经在设置里被删掉：先剔掉无效 id，免得筛选结果永远是空的
      filterTags = filterTags.filter((id) => domain.tags.some((t) => t.id === id));
      tagLabel.textContent = filterTags.length ? ('已选 ' + filterTags.length + ' 个') : '全部标签';
      tagBtn.classList.toggle('empty', !filterTags.length);
      U().clear(tagPicked);
      filterTags.forEach((tid) => {
        const t = domain.tags.find((x) => x.id === tid);
        if (!t) return;
        const x = U().el('button', { class: 'tag-picked-x', type: 'button', html: U().icon('x', 11), title: '取消该标签' });
        x.addEventListener('click', (e) => { e.stopPropagation(); toggleTag(tid); });
        tagPicked.appendChild(U().el('span', { class: 'chip tag-picked-chip' }, U().el('span', { text: '#' + t.name }), x));
      });
    }
    function toggleTag(tid) {
      if (filterTags.indexOf(tid) >= 0) filterTags = filterTags.filter((x) => x !== tid);
      else filterTags.push(tid);
      paintTagFilter();
      paintTagList();
      drawGrid();   // 实时刷新列表
    }
    function paintTagList() {
      if (!tagListEl) return;
      U().clear(tagListEl);
      const q = String((tagSearchEl && tagSearchEl.value) || '').trim().toLowerCase();
      const list = domain.tags.filter((t) => !q || String(t.name).toLowerCase().indexOf(q) >= 0);
      if (!list.length) {
        tagListEl.appendChild(U().el('div', { class: 'muted tag-panel-empty', text: domain.tags.length ? '没有匹配的标签' : '还没有标签' }));
        return;
      }
      list.forEach((t) => {
        const on = filterTags.indexOf(t.id) >= 0;
        const opt = U().el('button', { class: 'tag-opt' + (on ? ' on' : ''), type: 'button' },
          U().el('span', { class: 'tag-opt-name', text: '#' + t.name }),
          U().el('span', { class: 'tag-opt-mark', html: on ? U().icon('check', 14) : '' }));
        // 关键：不回传关闭 —— 点一下立刻选中（列表同时刷新），菜单保持打开
        opt.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleTag(t.id); });
        tagListEl.appendChild(opt);
      });
    }
    function onTagDocDown(e) {
      if (tagPanel && !tagPanel.contains(e.target) && !tagBtn.contains(e.target)) closeTagPanel();
    }
    // 页面滚动就收起浮层；但浮层内部自己的列表滚动不算（否则滚一下标签列表浮层就没了）
    function onTagScroll(e) {
      if (tagPanel && e && e.target && e.target.nodeType === 1 && tagPanel.contains(e.target)) return;
      closeTagPanel();
    }
    function closeTagPanel() {
      if (!tagPanel) return;
      const p = tagPanel; tagPanel = null; tagListEl = null; tagSearchEl = null;
      p.remove();
      tagBtn.classList.remove('open');
      document.removeEventListener('pointerdown', onTagDocDown, true);
      window.removeEventListener('scroll', onTagScroll, true);
    }
    closeTagPanelRef = closeTagPanel;
    function openTagPanel() {
      closeTagPanel();
      const panel = U().el('div', { class: 'tag-panel' });
      const search = U().el('input', { class: 'input tag-panel-search', placeholder: '输入文字搜索标签…' });
      const list = U().el('div', { class: 'tag-panel-list' });
      panel.appendChild(search); panel.appendChild(list);
      document.body.appendChild(panel);
      tagPanel = panel; tagListEl = list; tagSearchEl = search;
      const r = tagBtn.getBoundingClientRect();
      const w = Math.min(300, Math.max(200, Math.round(r.width + 80)), window.innerWidth - 16);
      panel.style.width = w + 'px';
      panel.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - w - 8)) + 'px';
      panel.style.top = (r.bottom + 6) + 'px';
      paintTagList();
      search.addEventListener('input', paintTagList);
      const h = panel.offsetHeight;
      if (r.bottom + 6 + h > window.innerHeight - 8) panel.style.top = Math.max(8, r.top - h - 6) + 'px';
      tagBtn.classList.add('open');
      setTimeout(() => { if (tagPanel === panel) document.addEventListener('pointerdown', onTagDocDown, true); }, 0);
      window.addEventListener('scroll', onTagScroll, true);
    }
    tagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tagPanel) closeTagPanel(); else openTagPanel();
    });
    tagRow.appendChild(U().el('span', { class: 'row-label', html: U().icon('tag', 14) + '<span>标签</span>' }));
    tagRow.appendChild(tagBtn);
    tagRow.appendChild(tagPicked);
    paintTagFilter();

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
    let loadSlide = null;   // 按需加载某一张（在下面按图片数量初始化）

    // 容器宽度固定 = 可用宽度（铺满横向），高度按「当前这张图」的原始比例算：
    // 不设任何上限，长图就让它长，保证整张图完整显示、上下都不被裁。
    // 老内核 WebView 不支持 CSS aspect-ratio，所以同时写一份显式像素高度兜底。
    function applyRatio() {
      if (!carousel || !track) return;
      const slide = track.children[imgIdx];
      const im = slide && slide.querySelector('img');
      if (!im || !im.naturalWidth || !im.naturalHeight) return;
      const w = carousel.clientWidth || carousel.offsetWidth || 0;
      if (!w) return;
      const h = Math.round(w * im.naturalHeight / im.naturalWidth);
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
      // 当前这张（以及左右各一张）按需加载，其余不动
      if (loadSlide) { loadSlide(imgIdx); loadSlide(imgIdx + 1); loadSlide(imgIdx - 1); }
    }
    if (total) {
      track = U().el('div', { class: 'dc-track' });
      // 每张图独立处理：读到就显示原图；读不到（相册里的文件被删了 / 被清理软件干掉）
      // 就在这一页显示「图片丢失」，绝不裂图、绝不崩。全部落空时把轮播高度让出来，
      // 不留一个巨大的空灰框。
      // 按需加载：只读当前这张 + 左右各一张，一条记录挂 20 张图也不会同时解码卡住。
      let lostCount = 0;
      function markSlideLost(slide) {
        if (!slide || slide._lost) return;
        slide._lost = true; lostCount++;
        const im = slide.querySelector('img');
        const lost = slide.querySelector('.dc-lost');
        if (im) im.style.display = 'none';
        if (lost) lost.style.display = '';
        if (lostCount >= total && carousel) carousel.classList.add('is-lost');
      }
      loadSlide = function (k) {
        if (k < 0 || k >= total || !track) return;
        const slide = track.children[k];
        if (!slide || slide._req || slide._lost) return;
        slide._req = true;
        const im = slide.querySelector('img');
        if (!im) return;
        App.storage.getImageURL(imgs[k]).then((u) => {
          if (!u) { slide._req = false; markSlideLost(slide); return; }
          im.addEventListener('load', () => { if (slide === track.children[imgIdx]) applyRatio(); });
          im.src = u;
        }).catch(() => { slide._req = false; markSlideLost(slide); });
      };
      imgs.forEach((imgId) => {
        const slide = U().el('div', { class: 'dc-slide' });
        const im = U().el('img', { alt: '' });
        const lost = U().el('div', { class: 'dc-lost', style: { display: 'none' } },
          U().el('div', { class: 'dc-lost-icon', html: U().icon('images', 26) }),
          U().el('div', { class: 'dc-lost-text', text: '图片丢失' }),
          U().el('div', { class: 'dc-lost-sub', text: '原图已不在相册中' }));
        slide.appendChild(im); slide.appendChild(lost);
        track.appendChild(slide);
      });
      carousel = U().el('div', { class: 'detail-carousel' }, track);
      if (total > 1) {
        dotsEl = U().el('div', { class: 'dc-dots' });
        for (let i = 0; i < total; i++) dotsEl.appendChild(U().el('span', { class: 'dc-dot' + (i === 0 ? ' active' : '') }));
        carousel.appendChild(dotsEl);
      }
      paintTrack(0, false);
      if (loadSlide) { loadSlide(0); if (total > 1) loadSlide(1); }
    }

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

    // 标签：蓝色可点 —— 点一下跳到列表页，只看这个标签在本领域下的记录。
    // 必须用 <button>：详情页的翻页手势在 onDown 里对 page 调了 setPointerCapture，
    // 会把 click 重定向到容器，span 上的监听根本收不到；button 本来就在手势排除名单里。
    const tagRow = U().el('div', { class: 'row wrap tag-line' });
    (rec.tagIds || []).forEach((tid) => {
      const t = domain.tags.find((x) => x.id === tid);
      if (!t) return;
      const tb = U().el('button', { class: 'tag-text tag-link', type: 'button', text: '#' + t.name });
      tb.addEventListener('click', () => gotoTag(t.id));
      tagRow.appendChild(tb);
    });

    // 正文字数：只算文字与标点（Markdown 记号、空白都不算，口径统一在 App.md.count）。
    // 提前算好 —— 元信息行要用它，正文那段也要用它判断要不要留白。
    const descCount = (App.md && App.md.count) ? App.md.count(rec.description) : 0;

    const meta = U().el('div', { class: 'row wrap', style: { gap: '8px', margin: '4px 0' } });
    // 时间保持原来的胶囊样式，不和字数绑在一起
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
    // 每条评论右侧的「···」：点了直接弹二次确认（取消 / 删除〔标红〕）。
    // 长按不再做任何事 —— 系统选字、复制全部照旧可用。
    function askRemoveComment(c) {
      Promise.resolve(U().confirmDialog('删除这条评论？删除后无法恢复。', { okLabel: '删除', danger: true }))
        .then((ok) => { if (ok) removeComment(c.id); })
        .catch(() => {});
    }
    function renderComments() {
      U().clear(commentsBox);
      const floors = floorMap();
      const list = (rec.comments || []).slice().sort((a, b) => commentDesc ? (b.createdAt - a.createdAt) : (a.createdAt - b.createdAt));
      // 没有评论就什么都不显示（不再放「还没有评论」这类占位文案）
      if (!list.length) return;
      list.forEach((c) => {
        const timeLine = U().el('div', { class: 'c-time' },
          U().el('span', { text: U().fmtDateTime(c.createdAt) }),
          U().el('span', { class: 'c-floor', text: ' · ' + (floors[c.id] || 1) + '楼' }));
        const moreBtn = U().el('button', {
          class: 'c-more', type: 'button', title: '更多', html: U().icon('more', 18),
        });
        moreBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (ev.preventDefault) ev.preventDefault();
          askRemoveComment(c);
        });
        const item = U().el('div', { class: 'comment', 'data-cid': c.id },
          U().el('div', { class: 'c-text' }, U().el('div', { text: c.text }), timeLine),
          moreBtn);
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

    // 正文：Markdown 渲染成富文本。字数已经放在上面的「分类 + 日期」行（日期后面），
    // 这里不再挂右下角胶囊 —— 同一屏出现两个「xx字」只会让人分不清哪个是哪个。
    let descEl = null;
    if (rec.description) {
      descEl = U().el('div', { class: 'detail-desc md-body', html: mdHtml(rec.description) });
    }

    const card = U().el('div', { class: 'card' },
      rec.title ? U().el('h2', { text: rec.title, style: { fontSize: '1.25rem', marginBottom: '6px' } }) : null,
      U().el('div', { class: 'row wrap tag-line', style: { marginBottom: '10px' } },
        cat ? U().el('span', { class: 'chip detail-cat', text: cat.name }) : null,
        U().el('span', { class: 'muted', style: { fontSize: '0.75rem' }, text: U().fmtDate(rec.date || rec.createdAt) }),
        descCount > 0 ? U().el('span', { class: 'detail-count muted', text: descCount + ' 字' }) : null),
      // 文字说明按 Markdown 渲染成富文本（加粗 / 列表 / 换行等），不再直接显示原始符号
      descEl,
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
    // 整页翻页：dir=1 下一条（当前页向左滑出，新页从右侧滑入），dir=-1 上一条（反向）
    function flipSheet(dir) {
      const to = dir > 0 ? nextId : prevId;
      if (!to) { springBack(); return; }
      sheet.style.transition = 'transform .22s cubic-bezier(.4,0,.72,1), opacity .22s';
      // 出场方向必须和手指同向：左滑(1) → 往左飞出；右滑(-1) → 往右飞出。
      // 这里写 -dir 才是「跟手继续往同一侧走」，写 dir 会变成往回弹，观感就是方向反了。
      sheet.style.transform = 'translate3d(' + (-dir * 102) + '%,0,0) scale(.94)';
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
    // 本次新建 / 编辑期间新写进相册的图片 id（取消或关闭时按它清相册）
    const sessionAdded = [];
    // 已有记录里被移除、但还没保存的图片 id（保存时才真正删相册原图，取消则恢复原状）
    const pendingRemove = [];
    let categoryId = existing ? existing.categoryId : (domain.categories[0] ? domain.categories[0].id : null);

    const titleI = U().el('input', { class: 'input', placeholder: '标题', value: existing ? existing.title : '' });
    const catSel = U().makeSelect(domain.categories.map((c) => [c.id, c.name]), categoryId, (v) => { categoryId = v; });
    catSel.classList.add('full');
    const catPlus = U().el('button', { class: 'icon-btn', html: U().icon('plusCircle', 18), title: '新建分类' });
    catPlus.addEventListener('click', () => U().quickAddCategory(domain, (item) => { App.db.saveDomain(domain); catSel.setOptions(domain.categories.map((c) => [c.id, c.name]), item.id); categoryId = item.id; if (App.app.refreshChrome) App.app.refreshChrome(); }));
    const catWrap = U().el('div', { class: 'row', style: { gap: '8px' } }, catSel, catPlus);
    // textarea 的 value 不能用 setAttribute 设置（对 textarea 无效），必须在创建后赋 .value，否则编辑时文字不回显
    const descI = U().el('textarea', { class: 'textarea', placeholder: '文字说明…（支持 Markdown 语法）' });
    descI.value = existing ? (existing.description || '') : '';
    let descTouched = false;
    // 键盘跟随的钩子：真正实现在页面末尾的 bindKeyboard 里。
    // 这里先占位 —— input / 回车这些回调在它之前就已经绑好了。
    let kbTick = function () {};
    // 字数胶囊：一枚极小、浮在排版栏【外面】上沿之上的胶囊（不占那 29px，也不参与按钮横滑）。
    // pointer-events:none：点它不会把焦点从输入框抢走，也不会挡住底部的最后一行。
    const countPill = U().el('span', { class: 'count-pill float', text: '0字' });
    const descWrap = U().el('div', { class: 'ed-desc-wrap' }, descI);
    activeDescI = descI;
    activeCountPill = countPill;
    paintCountPill();   // 先同步画一次：打开编辑页的第一帧就该是真实字数，不能闪一下「0字」

    // —— 底部排版栏的外壳 ——
    // 出现时机：正文聚焦才显示（.is-open），点到别处 / 失焦 180ms 后收起，绝不常驻占屏。
    // 高度固定 29px（见 CSS）：收起时也占位，否则显隐那一瞬 .page-sheet-body 会矮 29px，
    // 浏览器紧接着把光标重新滚进可视区 —— 用户看到的就是「点一下正文整页跳一下」。
    const dockTools = U().el('div', { class: 'ed-dock-tools' });
    const dock = U().el('div', { class: 'ed-dock' }, dockTools, countPill);
    let dockHideTimer = 0;
    function showDock() {
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = 0; }
      dock.classList.add('is-open');
    }
    function hideDockSoon() {
      if (dockHideTimer) clearTimeout(dockHideTimer);
      // 延时 180ms 再判断：点工具栏按钮的瞬间焦点会先跳到 body，
      // 立刻收起就会「点一下按钮，栏自己没了」。
      dockHideTimer = setTimeout(() => {
        dockHideTimer = 0;
        if (!dock.parentNode) return;             // 编辑页已关闭
        const ae = document.activeElement;
        if (ae === descI || (ae && dock.contains(ae))) return;
        dock.classList.remove('is-open');
        closeHMenu();                              // 菜单比栏先走一步，别孤零零留在屏幕上
      }, 180);
    }
    // 鼠标点按钮时把焦点留在输入框（键盘不收）；触屏走 bindTool 的 touchend。
    try { dock.addEventListener('mousedown', (e) => { if (e.target) e.preventDefault(); }, false); } catch (_) {}
    descI.addEventListener('focus', showDock);
    descI.addEventListener('blur', hideDockSoon);
    // 正文高度自适应：文字多少行，输入框就撑多高（整篇文章一眼看全），
    // 外层 .page-sheet-body 自己上下滚动，不再挤在一个小框里滑动。
    //
    // 【打字跳页·根治】旧实现每按一次键都先 height='auto' 塌回 min-height(120px) 再写回，
    // 塌缩瞬间滚动容器 .page-sheet-body 的 scrollHeight 骤减 → 浏览器把 scrollTop 钳到新的、
    // 更小的上限；高度恢复后没有任何代码把 scrollTop 写回 → 整页"往上一跳"，停在分类/标签栏。
    // 现在：打字只走「只增不减」，全程不塌缩；只有打开页面、以及停手 400ms 后才做一次
    // 带滚动钉回的收缩重算（同帧量完写回，无可见跳动）。
    let settleTimer = 0;
    // 把被引擎拉走/被钳小的滚动位置钉回去；只救"变小"，绝不干扰光标跟随时引擎自己的滚动
    function pinScroll(st) {
      const box = descI.closest('.page-sheet-body');
      if (!box) return;
      const target = Math.min(st, Math.max(0, box.scrollHeight - box.clientHeight));
      if (box.scrollTop < target - 8) box.scrollTop = target;
      // 部分 WebView 把"复位"排到下一帧，再补一次
      requestAnimationFrame(() => {
        if (document.activeElement !== descI) return;
        const t2 = Math.min(st, Math.max(0, box.scrollHeight - box.clientHeight));
        if (box.scrollTop < t2 - 8) box.scrollTop = t2;
      });
    }
    function growDesc(force) {
      const box = descI.closest('.page-sheet-body');
      const st = box ? box.scrollTop : 0;
      // box-sizing 是 border-box：把边框补回来，否则最后一行会被那 1px 细线压掉
      const frame = Math.max(0, descI.offsetHeight - descI.clientHeight);
      if (!force) {
        // 固定高度下 scrollHeight 依然返回内容总高，所以不塌缩也能量准
        const want = descI.scrollHeight + frame;
        if (want <= descI.offsetHeight + 1) return;   // 只涨不缩：变矮交给 settleDesc
        descI.style.height = want + 'px';
        pinScroll(st);
        return;
      }
      // 唯一允许塌缩的路径：打开页面 / 停手后，同一帧内塌缩→量→写回→钉滚动
      descI.style.height = 'auto';
      const h = descI.scrollHeight;
      if (!h || !isFinite(h)) return;              // 尚未完成排版：保持 CSS 的 min-height
      descI.style.height = (h + frame) + 'px';
      pinScroll(st);
    }
    // 停手 400ms 后再收敛一次：这样删掉大段文字时输入框会变矮，但打字过程中永远不会塌缩
    function settleDesc() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { settleTimer = 0; growDesc(true); }, 400);
    }

    // 插入恰好一个换行：回车统一走这里，杜绝「一次回车堆出多个 \n」。
    // 用 setRangeText 让浏览器自己维护选区与撤销栈；老内核不支持时退回 value 切片。
    function insertOneNewline() {
      const s = descI.selectionStart, en = descI.selectionEnd;
      if (s != null && en != null && typeof descI.setRangeText === 'function') {
      try {
        descI.setRangeText('\n', s, en, 'end');
        descTouched = true; growDesc(); scheduleCountPill(); settleDesc(); kbTick();
        return;
      } catch (_) { /* 兜底走下面的切片 */ }
      }
      const v = descI.value;
      if (s == null || en == null) { descI.value = v + '\n'; }
      else {
        descI.value = v.slice(0, s) + '\n' + v.slice(en);
        const np = s + 1;
        try { descI.setSelectionRange(np, np); } catch (_) {}
      }
      descTouched = true; growDesc(); scheduleCountPill(); settleDesc(); kbTick();
    }

    descI.addEventListener('input', (ev) => {
      descTouched = true; growDesc(); scheduleCountPill(); settleDesc();
      // 中文候选词上屏途中先不记（会把半成品塞进撤销栈），compositionend 时再补一次
      if (hist.lock || (ev && ev.isComposing)) return;
      histPush();
      kbTick();   // 键盘弹起 / 光标靠下时，把这一行顶到排版栏以上
    });
    // 选区变化：select 是老内核里 textarea 最可靠的事件；其余几个覆盖点选/拖选/长按拖动句柄/输入法上屏
    descI.addEventListener('select', scheduleCountPill);
    descI.addEventListener('keyup', scheduleCountPill);
    descI.addEventListener('mouseup', scheduleCountPill);
    descI.addEventListener('compositionend', scheduleCountPill);
    descI.addEventListener('focus', scheduleCountPill);
    descI.addEventListener('blur', scheduleCountPill);
    // 安卓上 touchend 早于选区稳定，延一帧再算（否则拿到的是拖动前的位置）
    descI.addEventListener('touchend', function () { setTimeout(scheduleCountPill, 30); }, { passive: true });

    // 【回车空两行·根治（真机实测结论）】
    // 5+ WebView 里实体键盘回车触发的是 beforeinput inputType=insertLineBreak（data=null），不是 insertText，
    // 旧兜底完全没拦；且一次物理回车会被拆成多次 insertLineBreak，导致 value 堆出多个 \n（不是 CSS 行高问题）。
    // 现在用 keydown 统一接管：阻止引擎默认插入、手动只插一个 \n；按住产生的重复(e.repeat)与 30ms 内的重复 keydown 一律吞掉。
    let lastEnterKeyDown = 0;
    descI.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;   // 输入法组词中的回车交给 IME 确认候选
      if (e.cancelable !== false) e.preventDefault();    // 阻止引擎默认插入，改由下面手动插一个 \n
      if (e.repeat) return;                              // 按住不放产生的重复：吞掉
      const now = Date.now();
      if (now - lastEnterKeyDown < 30) return;           // 同一物理按键被拆成多次 keydown：吞掉
      lastEnterKeyDown = now;
      insertOneNewline();
    });

    // 兜底：少数软键盘不发 keydown(Enter)，只发 beforeinput insertLineBreak/insertParagraph。
    // 一律拦掉引擎默认，再由我们插入恰好一个 \n（keydown 刚接管过则跳过，避免双插）。
    descI.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        if (e.cancelable !== false) e.preventDefault();
        if (Date.now() - lastEnterKeyDown > 50) insertOneNewline();   // 仅当 keydown 没接管时才补插
        return;
      }
      if (e.inputType === 'insertText' && typeof e.data === 'string' && e.data.indexOf('\n\n') !== -1) {
        if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
        const single = e.data.replace(/\n{2,}/g, '\n');
        const s = descI.selectionStart, en = descI.selectionEnd;
        if (s == null || en == null) { descI.value += single; }
        else {
          descI.value = descI.value.slice(0, s) + single + descI.value.slice(en);
          const np = s + single.length;
          try { descI.setSelectionRange(np, np); } catch (_) {}
        }
        descTouched = true; growDesc(); scheduleCountPill(); settleDesc();
      }
    });

    // ===== 排版栏的两个前提：记住选区、按按钮时别把焦点弄丢 =====
    //   ① 按钮在 touchstart 上绝不能 preventDefault —— 那会把「工具栏横向滑动」一起锁死，
    //      部分内核连随后的 click 都吞掉，按钮直接变哑。这里只 passive 地记下选区。
    //   ② 记选区必须早于 textarea 失焦：失焦后 selectionStart 可能被重置成 0，
    //      所以 touchstart / mousedown 各记一次，落地时再用 ensureFocusSel 捞回来 ——
    //      这就是「选中了文字点加粗，结果什么都没包住」的根治办法。
    //   ③ 改值一律走 applyValue（value 切片 + setSelectionRange，同一 tick 内完成），
    //      它自己会补 descTouched + growDesc + 字数 + 撤销栈。
    let savedSel = [0, 0];
    function rememberSel() {
      try {
        const s = descI.selectionStart, e = descI.selectionEnd;
        if (s != null && e != null) savedSel = [s, e];
      } catch (_) {}
    }
    function selRange() {
      const v = descI.value;
      let s = Math.min(savedSel[0] || 0, v.length);
      let e = Math.min(savedSel[1] || 0, v.length);
      if (e < s) { const t = s; s = e; e = t; }
      return [s, e];
    }
    // 点按钮前调用：确保焦点在正文上、选区是用户刚才那段
    function ensureFocusSel() {
      if (document.activeElement === descI) return;
      try { descI.focus({ preventScroll: true }); } catch (_) { try { descI.focus(); } catch (__) {} }
      // 安卓 WebView 失焦瞬间常把选区重置成 0/0，用刚才记住的捞回来
      if (descI.selectionStart === 0 && descI.selectionEnd === 0 && descI.value.length
        && (savedSel[0] > 0 || savedSel[1] > 0)) {
        try { descI.setSelectionRange(savedSel[0], savedSel[1]); } catch (_) {}
      }
    }

    // —— 撤回 / 重做：自建栈 ——
    // 不用 document.execCommand('undo')：它对 value= / setRangeText 写进去的内容不成组，
    // 一次改动常常撤不回来。自建栈只记「文本 + 光标」，行为完全可预期。
    let undoBtn = null, redoBtn = null;
    const hist = { st: [], idx: -1, timer: 0, lock: false };
    function histSync() {
      if (undoBtn) { undoBtn.disabled = hist.idx <= 0; undoBtn.classList.toggle('is-off', hist.idx <= 0); }
      if (redoBtn) { redoBtn.disabled = hist.idx >= hist.st.length - 1; redoBtn.classList.toggle('is-off', hist.idx >= hist.st.length - 1); }
    }
    function histSeed() {
      hist.st = [{ v: descI.value, s: descI.value.length, e: descI.value.length }];
      hist.idx = 0;
      histSync();
    }
    function histPushNow() {
      const v = descI.value;
      const s = descI.selectionStart == null ? v.length : descI.selectionStart;
      const e = descI.selectionEnd == null ? v.length : descI.selectionEnd;
      const cur = hist.st[hist.idx];
      if (cur && cur.v === v) { cur.s = s; cur.e = e; return; }
      hist.st = hist.st.slice(0, hist.idx + 1);
      hist.st.push({ v: v, s: s, e: e });
      if (hist.st.length > 50) hist.st.shift();
      hist.idx = hist.st.length - 1;
      histSync();
    }
    function histPush() {
      clearTimeout(hist.timer);
      hist.timer = setTimeout(histPushNow, 400);   // 连打时合并成一次快照
    }
    function histApply(i) {
      const it = hist.st[i];
      if (!it) return;
      hist.idx = i;
      descI.value = it.v;
      try { descI.focus({ preventScroll: true }); descI.setSelectionRange(it.s, it.e); } catch (_) {}
      savedSel = [it.s, it.e];
      descTouched = true; growDesc(true); scheduleCountPill(); settleDesc(); kbTick();
      histSync();
    }

    // 工具改值的唯一收口。
    // 【为什么开头要 histPushNow】输入是 400ms 防抖入栈的：打完字立刻点工具，
    // 若不先把「改动前」那一步落进栈，撤销会一步跳回上一次打字之前，把刚打的字一起吃掉。
    function applyValue(next, ns, ne) {
      clearTimeout(hist.timer); hist.timer = 0;
      histPushNow();
      const len = String(next == null ? '' : next).length;
      let a = Math.round(ns == null ? len : ns);
      let b = Math.round(ne == null ? a : ne);
      if (b < a) { const t = a; a = b; b = t; }
      a = Math.max(0, Math.min(a, len));
      b = Math.max(a, Math.min(b, len));
      descI.value = next;
      try { descI.focus({ preventScroll: true }); descI.setSelectionRange(a, b); } catch (_) {}
      savedSel = [a, b];
      descTouched = true; growDesc(true); scheduleCountPill(); settleDesc();
      histPushNow();   // 工具改动立即入栈，撤回一步就是一步
      kbTick();
    }
    // ===== 排版栏 =====
    // 记号怎么加、选区怎么扩、再点一次怎么脱 —— 全部由 js/vendor/md-toolbar.js 算
    // （@github/markdown-toolbar-element 2.2.3 的纯函数移植，MIT）。这里只负责两件事：
    // 把结果写回输入框（commitMd → applyValue），以及保证点按钮时键盘不收起（bindTool）。

    // 落地：compute 只吐 { text, selectionStart, selectionEnd }，由这里替换掉当前选区。
    // 【顺序要紧】移植函数会「就地」改写 descI 的选区（空选区扩到词、列表扩到整行、
    // 取消时外扩到记号两侧），所以必须在 compute 之后再读选区 —— 读早了会出现
    // 「选中 **abc** 里的 abc 点加粗 → ***abc***」这种叠记号。
    function commitMd(res) {
      if (!res) return;
      const v = descI.value;
      let s = descI.selectionStart, e = descI.selectionEnd;
      if (s == null || e == null) { s = v.length; e = v.length; }
      if (e < s) { const t = s; s = e; e = t; }
      const next = v.slice(0, s) + res.text + v.slice(e);
      const len = next.length;
      // 上界必须按「替换后的全文长度」夹：listStyle 的脱列表分支会算出
      // selectionEnd - totalPrefixLength，多行时可能是负数，不夹会抛 IndexSizeError
      // 让整次点击静默失效。
      let ns = res.selectionStart == null ? len : res.selectionStart;
      let ne = res.selectionEnd == null ? ns : res.selectionEnd;
      ns = Math.max(0, Math.min(ns, len));
      ne = Math.max(ns, Math.min(ne, len));
      applyValue(next, ns, ne);
    }
    function runMd(key) {
      const styles = (App.mdToolbar && App.mdToolbar.STYLES) ? App.mdToolbar.STYLES : null;
      if (!styles || !styles[key]) return;
      ensureFocusSel();
      let res = null;
      try { res = App.mdToolbar.compute(descI, styles[key]); } catch (_) { res = null; }
      commitMd(res);
    }

    // 标题（H1–H5 下拉）：按行加 `#` 前缀。
    // 原库的 md-header 走 blockStyle 会把 # 插在「词首」，在纯 textarea 里就会出现
    // 「正文中间冒出个 #」；所以复用它的行处理思路：先剥掉已有的任意块前缀，再按级别重加。
    // 同一级别再点一次 = 取消；跨类型（列表 / 引用 → 标题）是替换，不是叠加。
    const RE_HEAD_LV = /^[ \t]{0,3}(#{1,6})[ \t]+/;
    const RE_BLOCK_PREFIX = /^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,3}[.)][ \t]+|>[ \t]?)/;
    function runHeading(level) {
      ensureFocusSel();
      const origStart = descI.selectionStart, origEnd = descI.selectionEnd;
      App.mdToolbar.expandSelectionToLine(descI);
      const start = descI.selectionStart, end = descI.selectionEnd;
      const lines = descI.value.slice(start, end).split('\n');
      const prefix = new Array(level + 1).join('#') + ' ';
      const lvOf = (l) => { const m = RE_HEAD_LV.exec(l); return m ? m[1].length : 0; };
      const strip = (l) => l.replace(RE_BLOCK_PREFIX, '');
      const real = lines.filter((l) => l.trim());
      const allSame = real.length > 0 && real.every((l) => lvOf(l) === level);
      const outLines = allSame
        ? lines.map(strip)
        : lines.map((l) => (l.trim() ? prefix + strip(l) : l));
      const out = outLines.join('\n');
      const d = outLines.length ? (outLines[0].length - lines[0].length) : 0;
      const noSel = origStart === origEnd;
      commitMd({
        text: out,
        selectionStart: noSel ? origStart + d : start,
        selectionEnd: noSel ? origStart + d : start + out.length,
      });
    }

    // 按钮交互：绝对不收起键盘。
    // 触屏上真正会把焦点抢走的是 tap 之后浏览器补发的 mousedown/click（焦点一移键盘就收），
    // 所以在 touchend 里 preventDefault 掐掉后面那一串；mousedown 再兜一层鼠标 / 老 WebView。
    // 同一次点击会来好几个事件，用 swallow 布尔位去重（不用时间戳：时间戳会把用户
    // 400ms 内的第二次真实点击也吞掉，「连点两下取消加粗」直接哑）。
    // 注：不能在 touchstart 里 preventDefault —— 那会把「横向滑动工具栏」一起废掉。
    function bindTool(btn, run) {
      let moved = false, sx = 0, sy = 0, swallow = false, swTimer = 0;
      function arm() {
        swallow = true;
        clearTimeout(swTimer);
        swTimer = setTimeout(() => { swallow = false; }, 700);   // 触摸后没补发 click 时自动解锁
      }
      btn.addEventListener('touchstart', (e) => {
        moved = false;
        rememberSel();
        const t = e.touches && e.touches[0];
        if (t) { sx = t.clientX; sy = t.clientY; }
      }, { passive: true });
      btn.addEventListener('touchmove', (e) => {
        const t = e.touches && e.touches[0];
        if (t && (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8)) moved = true;
      }, { passive: true });
      btn.addEventListener('touchend', (e) => {
        if (moved) { arm(); return; }              // 这是在滑工具栏，不是点按钮
        if (e.cancelable !== false) { try { e.preventDefault(); } catch (_) {} }
        arm();
        try { run(); } catch (_) {}
      });
      btn.addEventListener('mousedown', (e) => {
        try { e.preventDefault(); } catch (_) {}   // 焦点留在输入框 → 键盘不收
        if (swallow) return;                       // 这一发是触摸补发的
        rememberSel();
        arm();                                     // 紧随其后的那发 click 不再执行
        try { run(); } catch (_) {}
      });
      btn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (_) {}
        if (swallow) { swallow = false; clearTimeout(swTimer); return; }
        rememberSel();
        try { run(); } catch (_) {}
      });
    }

    // 按钮表：撤回 / 重做 ｜ 标题(下拉) ｜ 行内 6 个 ｜ 块级 4 个
    const MD_TOOLS = [
      { k: 'bold', icon: 'mdBold', t: '加粗' },
      { k: 'italic', icon: 'mdItalic', t: '斜体' },
      { k: 'strike', icon: 'mdStrike', t: '删除线' },
      { k: 'mark', icon: 'mdMark', t: '高亮' },
      { k: 'code', icon: 'mdCode', t: '行内代码' },
      { k: 'link', icon: 'mdLink', t: '链接' },
      { k: 'unordered', icon: 'mdUl', t: '无序列表' },
      { k: 'ordered', icon: 'mdOl', t: '有序列表' },
      { k: 'task', icon: 'mdTask', t: '任务列表' },
      { k: 'quote', icon: 'mdQuote', t: '引用' },
    ];

    // H1–H5 收成一个下拉（平铺 5 个按钮会挤掉一半屏幕）
    const hBtn = U().el('button', { class: 'ed-tool ed-tool-h', type: 'button', title: '标题' },
      U().el('span', { class: 'ed-tool-h-txt', text: 'H' }),
      U().el('span', { class: 'ed-tool-h-chev', html: U().icon('chevron', 11) }));
    hBtn.setAttribute('aria-label', '标题 H1 到 H5');
    const hMenu = U().el('div', { class: 'ed-hmenu hidden', role: 'menu' });
    const H_TIPS = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题'];
    for (let lv = 1; lv <= 5; lv++) {
      const item = U().el('button', { class: 'ed-hmenu-item ed-hmenu-lv' + lv, type: 'button', role: 'menuitem' },
        U().el('span', { class: 'ed-hmenu-k', text: 'H' + lv }),
        U().el('span', { class: 'ed-hmenu-t', text: H_TIPS[lv - 1] }));
      bindTool(item, () => { closeHMenu(); runHeading(lv); });
      hMenu.appendChild(item);
    }
    let hOpen = false;
    function closeHMenu() {
      if (!hOpen) return;
      hOpen = false;
      hMenu.classList.add('hidden');
      hBtn.classList.remove('on');
      try { document.removeEventListener('pointerdown', onDocDown, true); } catch (_) {}
      try { document.removeEventListener('touchstart', onDocDown, true); } catch (_) {}
    }
    function onDocDown(e) {
      const t = e.target;
      if (t && (t === hBtn || (hBtn.contains && hBtn.contains(t)))) return;
      if (t && (t === hMenu || (hMenu.contains && hMenu.contains(t)))) return;
      closeHMenu();
    }
    function openHMenu() {
      if (hOpen) { closeHMenu(); return; }
      hOpen = true;
      hMenu.classList.remove('hidden');   // 位置交给 CSS：.ed-hmenu 贴在 .ed-dock 上沿
      hBtn.classList.add('on');
      try { document.addEventListener('pointerdown', onDocDown, true); } catch (_) {}
      try { document.addEventListener('touchstart', onDocDown, true); } catch (_) {}
    }
    bindTool(hBtn, openHMenu);

    // 组装：撤回 / 重做（最左）→ 分隔线 → 标题下拉 → 分隔线 → 10 个按钮（横向滑动）
    undoBtn = U().el('button', { class: 'ed-tool', type: 'button', title: '撤回', html: U().icon('mdUndo', 16) });
    redoBtn = U().el('button', { class: 'ed-tool', type: 'button', title: '重做', html: U().icon('mdRedo', 16) });
    bindTool(undoBtn, () => histApply(hist.idx - 1));
    bindTool(redoBtn, () => histApply(hist.idx + 1));
    dockTools.appendChild(undoBtn);
    dockTools.appendChild(redoBtn);
    dockTools.appendChild(U().el('span', { class: 'ed-tool-sep' }));
    dockTools.appendChild(hBtn);
    dockTools.appendChild(U().el('span', { class: 'ed-tool-sep' }));
    MD_TOOLS.forEach((t) => {
      // 行内 6 个与块级 4 个之间再隔一条线，扫一眼就能分组
      if (t.k === 'unordered') dockTools.appendChild(U().el('span', { class: 'ed-tool-sep' }));
      const b = U().el('button', { class: 'ed-tool', type: 'button', title: t.t, html: U().icon(t.icon, 16) });
      b.setAttribute('aria-label', t.t);
      bindTool(b, () => runMd(t.k));
      dockTools.appendChild(b);
    });
    // 菜单必须挂在 .ed-dock 上（不能进 .ed-dock-tools —— 那里的 overflow-x:auto 会把它裁掉）
    dock.appendChild(hMenu);
    histSeed();
    // 中文输入法：候选词上屏途中不要往撤销栈里塞半成品
    descI.addEventListener('compositionstart', () => { hist.lock = true; });
    descI.addEventListener('compositionend', () => { hist.lock = false; histPush(); });

    const timeI = U().el('input', { class: 'input', type: 'number', min: '0', placeholder: '分钟', value: existing ? (existing.timeSpentMin || '') : '' });
    const incI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existing ? (existing.income || '') : '' });
    const expI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existing ? (existing.expense || '') : '' });
    let recDate = existing ? existing.date : Date.now();
    const dateBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
    function paintDate() { dateBtn.textContent = U().fmtDate(recDate); }
    paintDate();
    dateBtn.addEventListener('click', () => U().openCalendar({ value: U().fmtDate(recDate), onSelect: (v) => { recDate = new Date(v + 'T00:00:00').getTime(); paintDate(); } }));

    // 标签：未选=灰字 #标签；选中=胶囊
    // 上方带一个搜索框：输入即实时过滤（已选中的标签始终保留在列表里，方便随手取消）
    const tagSearchI = U().el('input', { class: 'input tag-search', type: 'search', placeholder: '搜索标签…', autocomplete: 'off' });
    const tagBox = U().el('div', { class: 'row wrap tag-line', style: { gap: '4px 10px' } });
    function rebuildTags() {
      U().clear(tagBox);
      const kw = String(tagSearchI.value || '').trim().toLowerCase();
      const hit = (t) => !kw || String(t.name || '').toLowerCase().indexOf(kw) >= 0 || selectedTags.includes(t.id);
      let shown = 0;
      domain.tags.forEach((t) => {
        if (!hit(t)) return;
        shown++;
        const on = selectedTags.includes(t.id);
        const chip = U().el('span', { class: 'tag-sel' + (on ? ' on' : ''), text: '#' + t.name });
        chip.addEventListener('click', () => {
          if (selectedTags.includes(t.id)) { selectedTags = selectedTags.filter((x) => x !== t.id); chip.classList.remove('on'); }
          else { selectedTags.push(t.id); chip.classList.add('on'); }
        });
        tagBox.appendChild(chip);
      });
      const plus = U().el('span', { class: 'tag-sel tag-new', html: U().icon('plus', 14) + '<span>新建</span>', title: '新建标签' });
      plus.addEventListener('click', () => U().quickAddTag(domain, (item) => { App.db.saveDomain(domain); tagSearchI.value = ''; rebuildTags(); if (App.app.refreshChrome) App.app.refreshChrome(); }));
      tagBox.appendChild(plus);
      if (!domain.tags.length) tagBox.appendChild(U().el('span', { class: 'muted', text: '暂无标签，可点「新建」添加' }));
      else if (!shown && kw) tagBox.appendChild(U().el('span', { class: 'muted', text: '没有匹配的标签' }));
    }
    tagSearchI.addEventListener('input', rebuildTags);
    rebuildTags();
    const tagSection = U().el('div', { class: 'tag-picker' }, tagSearchI, tagBox);

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

    // —— 5+（HBuilderX）真机：走系统相册原生多选 ——
    // 安卓 WebView 里的 <input type="file"> 大多数只让选一张，点一次「+」只能加一张。
    // 5+ 提供 plus.gallery.pick({ multiple: true })，一次能勾多张，返回顺序就是点选顺序。
    function hasPlusGallery() {
      try { return typeof plus !== 'undefined' && !!plus && !!plus.gallery && typeof plus.gallery.pick === 'function'; } catch (e) { return false; }
    }
    function plusPickPaths() {
      return new Promise((resolve) => {
        try {
          plus.gallery.pick(
            (res) => {
              const arr = (res && res.files) ? res.files : ((typeof res === 'string') ? [res] : []);
              resolve(Array.isArray(arr) ? arr : []);
            },
            (err) => {                      // 用户取消：什么都不加（也不要再弹第二个选择器）
              const msg = String((err && (err.message || err.msg)) || '');
              if (msg && !/取消|cancel/i.test(msg)) U().toast('打开相册失败：' + msg, 'err');
              resolve([]);
            },
            { multiple: true, maximum: 30, filter: 'image', system: false, animation: true }
          );
        } catch (e) { resolve([]); }
      });
    }
    // —— 图片写入期间的全局 Loading + 保存按钮禁用 ——
    // 一张 3MB 的图写进相册要 1~3 秒，这段时间如果界面毫无反应，
    // 用户就会去点「保存」——记录里便会存下一个还没写完的图片 id（图片就丢了）。
    let busyDepth = 0;
    // 保存按钮：顶栏右上角对勾（与左上角的叉同尺寸、同色，左右对称）。
    // 提前建好是因为图片写入相册期间要能把它置灰禁用（setSaveEnabled）。
    const saveBtnEl = U().el('button', {
      class: 'icon-btn page-sheet-save', type: 'button', html: U().icon('check', 22), title: '保存',
    });
    function setSaveEnabled(on) {
      if (!saveBtnEl) return;
      saveBtnEl.disabled = !on;
      try {
        if (on) saveBtnEl.removeAttribute('disabled');
        else saveBtnEl.setAttribute('disabled', 'disabled');
      } catch (e) {}
      saveBtnEl.classList.toggle('is-disabled', !on);
    }
    function imgBusy(on, text) {
      busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
      const busy = busyDepth > 0;
      setSaveEnabled(!busy);                       // 只要还在处理，保存按钮一律禁用
      if (busy) U().showBusy(text || '图片处理中...'); else U().hideBusy();
    }
    // 统一的「加图片」入口：5+ 用原生相册多选，其它环境退回 <input type="file">
    // 选完只把「路径」交下去：原图字节由 storage 在 Java 层直接从文件搬进相册，
    // 不再先把整张图读成 base64 / Blob —— 那一步既慢（每张 1~3 秒、还占一份原图内存），
    // 又会在超大图上撑爆跨桥字符串（Android 14 上「Base64 整段解码失败」的根源）。
    async function pickImages() {
      if (U().isBusy()) return;                    // 上一批还在写入，忽略重复点击
      if (!hasPlusGallery()) { fileInput.click(); return; }
      const paths = await plusPickPaths();
      if (!paths.length) return;                   // 取消：什么都不做（不再补弹第二个选择器）
      const list = paths.map(function (p, i) {
        let nm = 'image-' + (i + 1) + '.jpg';
        try {
          const seg = String(p).split('/').pop();
          if (seg) nm = decodeURIComponent(seg.split('?')[0]);
        } catch (e) {}
        return { srcPath: p, name: nm, type: '', size: 0 };   // 类型交给 storage 按扩展名推断
      });
      imgBusy(true, '图片处理中...');
      try { await storeImages(list); }
      finally { imgBusy(false); renderPreview(); }
    }
    // 真正落盘：原图直接写进相册（真机走系统级复制），不再压缩、不再生成缩略图。
    // 写完一张立刻上屏；成功写入的 id 记进 sessionAdded —— 这就是「本次新增图片」的临时数组，
    // 用户点「取消 / 关闭」时按它把刚写进相册的图逐张删掉，不留垃圾。
    async function storeImages(list) {
      let added = 0, failed = 0;
      for (let i = 0; i < list.length; i++) {
        if (list.length > 1) U().setBusyText('图片处理中...（' + (i + 1) + '/' + list.length + '）');
        try {
          const f = list[i];
          const id = App.storage.uid();
          await App.storage.saveImage({
            id: id,
            name: f.name || ('gojo-' + (i + 1) + '.jpg'),
            // 相册多选只给路径、没有 Blob：类型留空由 storage 按扩展名推断
            type: f.type || '',
            size: f.size || 0,
            // 只有真的是 Blob 才传（网页选图 / 拖拽）；否则绝不能把普通对象当 blob 存进库
            blob: (typeof Blob !== 'undefined' && f instanceof Blob) ? f : undefined,
            srcPath: f.srcPath || '',   // 有源路径就整份搬字节，没有才走 base64
          });
          imageIds.push(id); sessionAdded.push(id); added++;
          renderPreview();                         // 每写完一张就刷新，进度看得见
        } catch (e) {
          failed++;
          try { if (window.console && console.warn) console.warn('[图片] 保存失败：', e); } catch (_) {}
        }
      }
      // 防呆：写失败必须明确告知（此时 Loading 已解除，提示不会压在遮罩下面）
      if (failed) U().toast(failed > 1 ? ('图片保存失败（' + failed + ' 张）') : '图片保存失败', 'err');
      else if (added) U().toast('已添加 ' + added + ' 张图片', 'ok');
    }
    // 图片区：全屏页最顶端，大尺寸网格预览（空态是一整块上传区）
    const mediaBox = U().el('div', { class: 'media-grid' });
    function renderPreview() {
      U().clear(mediaBox);
      if (!imageIds.length) {
        mediaBox.classList.add('empty');
        const drop = U().el('div', { class: 'media-drop' }, U().el('div', { class: 'md-icon', text: '🖼️' }), U().el('div', { class: 'md-text', text: '点击添加图片' }));
        drop.addEventListener('click', () => pickImages());
        mediaBox.appendChild(drop);
        return;
      }
      mediaBox.classList.remove('empty');
      imageIds.forEach((id) => {
        const cell = U().el('div', { class: 'mg-item' });
        // 懒加载：一次选了十几张图也不会同时解码，编辑页不会卡住
        const im = U().el('img', { loading: 'lazy', decoding: 'async', alt: '', draggable: 'false' });
        fillCover(im, id);
        // 点图片 = 看大图（在编辑器里就能确认这张图有没有拍糊、裁没裁到）
        cell.addEventListener('click', () => openPreview(id));
        const rm = U().el('div', { class: 'rm', text: '×' });
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          imageIds = imageIds.filter((x) => x !== id);
          const at = sessionAdded.indexOf(id);
          if (at > -1) {
            // 本次刚加的图：还没绑定记录，直接从相册删掉，并从「待清理」里摘掉
            sessionAdded.splice(at, 1);
            try { await App.storage.deleteImage(id); } catch (_) {}
          } else if (pendingRemove.indexOf(id) < 0) {
            // 已有记录的图：先只做标记。点「保存」才真正删相册原图；点「取消」就作废，
            // 记录和照片都不受影响（原来这里是立即删，取消后照片就没了）。
            pendingRemove.push(id);
          }
          renderPreview();
        });
        cell.appendChild(im); cell.appendChild(rm);
        mediaBox.appendChild(cell);
      });
      const add = U().el('div', { class: 'mg-add', html: U().icon('plus', 22) + '<span>添加</span>' });
      add.addEventListener('click', () => pickImages());
      mediaBox.appendChild(add);
    }

    // 编辑页看大图：把当前已添加的图一起交给灯箱，可以左右滑着逐张检查
    async function openPreview(id) {
      const srcs = [], ids = [];
      for (let k = 0; k < imageIds.length; k++) {
        const u = await App.storage.getImageURL(imageIds[k]);
        if (u) { srcs.push(u); ids.push(imageIds[k]); }
      }
      if (!srcs.length) { U().toast('原图已丢失，无法查看', 'err'); return; }
      let at = ids.indexOf(id); if (at < 0) at = 0;
      U().openImageViewer({
        srcs: srcs,
        index: at,
        nameAt: (k) => 'gojo-' + (k + 1) + '.jpg',
        getBlobAt: (k) => App.storage.readImageForExport(ids[k]).then((ex) => (ex && ex.full) || null),
      });
    }

    fileInput.addEventListener('change', async () => { await handleFiles(fileInput.files); fileInput.value = ''; });
    // —— 修复「拖动图片后自动重复添加」——
    // 页面内拖动一张已有图片时，浏览器会把这张图当成一个「文件」再次投递到 drop 事件，
    // 于是每拖一次就多出一张一模一样的图。这里用 dragstart 打标记，drop 时识别为内部拖动直接忽略；
    // 同时把 <img> 设为 draggable=false（CSS 里也加了 -webkit-user-drag: none），双保险。
    let innerDrag = false;
    ['dragover', 'dragenter'].forEach((ev) => mediaBox.addEventListener(ev, (e) => { e.preventDefault(); if (!innerDrag) mediaBox.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => mediaBox.addEventListener(ev, (e) => { e.preventDefault(); mediaBox.classList.remove('drag'); }));
    mediaBox.addEventListener('dragstart', (e) => {
      innerDrag = true;
      mediaBox.classList.remove('drag');   // 页内拖动不是「外部文件拖入」，不要闪那层变暗效果
      if (e.dataTransfer) { try { e.dataTransfer.effectAllowed = 'none'; } catch (_) {} }
    });
    mediaBox.addEventListener('dragend', () => { innerDrag = false; });
    mediaBox.addEventListener('drop', async (e) => {
      if (innerDrag) { innerDrag = false; return; }
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) await handleFiles(files);
    });
    async function handleFiles(files) {
      if (U().isBusy()) return;                    // 正在写入时不接受第二批
      const list = [];
      let skipped = 0;
      Array.prototype.forEach.call(files || [], (f) => {
        if (!f) return;
        if (!f.type || f.type.indexOf('image/') !== 0) { skipped++; return; }
        list.push(f);
      });
      if (skipped) U().toast('已跳过 ' + skipped + ' 个非图片文件', 'err');
      if (!list.length) return;
      imgBusy(true, '图片处理中...');
      try { await storeImages(list); }
      finally { imgBusy(false); renderPreview(); }  // 全部写完才解禁保存按钮
    }
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
      descWrap,
      field('分类', catWrap),
      field('标签', tagSection),
      field('时间', timeRow),
      field('金额', moneyRow),
      (domain.customFields && domain.customFields.length) ? field('自定义属性', cfWrap) : null,
    );

    let saved = false;
    // 「保存」逻辑：原来写在底栏按钮的 onClick 闭包里，现在由顶栏右上角对勾触发。
    async function doSave(close) {
      // 双保险：遮罩挡不住键盘回车一类的意外触发，这里再拦一次
      if (busyDepth > 0 || U().isBusy()) { U().toast('图片还在处理中，请稍候', 'err'); return; }
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
      await App.db.saveRecord(rec);
      saved = true;
      sessionAdded.length = 0;   // 新图已经正式绑定记录，不再列入待清理
      // 保存成功后，才真正删除「被移除的已有图片」对应的相册原图
      if (pendingRemove.length) {
        const gone = pendingRemove.slice();
        pendingRemove.length = 0;
        App.storage.deleteImages(gone).catch(() => {});
      }
      await App.state.reloadRecords(); U().toast('已保存', 'ok'); close(); App.app.renderRoute();
    }

    const m = U().fullPage({
      title: existing ? '编辑记录' : '新建记录',
      body,
      right: saveBtnEl,          // 右上角对勾：和左上角的叉左右对称
      onClose: () => {
        // 取消 / 关闭 / 返回键：本次新写进相册的图全部删掉，不留垃圾文件。
        // （saved 为 true 时这些图已经正式绑定记录，不能删。）
        if (!saved && sessionAdded.length) {
          sessionAdded.forEach((id) => App.storage.deleteImage(id).catch(() => {}));
          sessionAdded.length = 0;
        }
        pendingRemove.length = 0;   // 未保存的「移除」标记直接作废
        // 排版栏的延时收起、标题菜单的 document 级监听都要在这里断掉：
        // 编辑页一关，那段 180ms 定时器还会醒来摸一次已经不在文档里的节点。
        if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = 0; }
        try { closeHMenu(); } catch (_) {}
        // 字数胶囊的引用必须在这里断掉：document 上的 selectionchange 是常驻监听，
        // 只有确认编辑器真的关了、不再重绘，才不会再往已卸载的节点上写字。
        activeDescI = null; activeCountPill = null;
      },
    });
    saveBtnEl.addEventListener('click', () => doSave(m.close));
    // 排版栏接在滚动正文之后：.page-sheet 是 flex column，它会天然贴底（默认收起但占位 29px），
    // 且不影响 .page-sheet-body 作为唯一滚动容器（growDesc / pinScroll 都依赖这一点）。
    m.el.appendChild(dock);
    if (busyDepth > 0) setSaveEnabled(false);

    // 打开时就按现有内容撑开（编辑一条长记录时不该先出来一个 120px 的小框），
    // 等一帧让布局稳定再量高度。
    const kickGrow = () => { try { if (descI.isConnected !== false) { growDesc(true); paintCountPill(); } } catch (_) {} };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(kickGrow); else setTimeout(kickGrow, 0);

    // —— 软键盘 / 排版栏布局 ——
    // 规则（按需求定死）：
    //   ① 没键盘：正文区一直延伸到屏幕底部，排版栏只在聚焦时出现、贴在视口最下方；
    //   ② 有键盘：排版栏必须贴着键盘上沿，绝不能被键盘盖住；
    //   ③ 打字到最后一行：按「真正看得见的下沿」（扣掉键盘盖住的 + 栏压住的 + 胶囊探出的）
    //      自动上滚，光标行永远停在栏以上。
    // 两种键盘实现都覆盖：
    //   · adjustResize：布局视口自己变矮 → 栏在文档流里天然贴着键盘上沿，不用额外抬；
    //   · adjustPan / 悬浮键盘：视口没变矮，只有 visualViewport 被压矮 → 栏自己浮到键盘上沿。
    (function bindKeyboard() {
      try {
        const wv = (typeof plus !== 'undefined' && plus.webview && plus.webview.currentWebview)
          ? plus.webview.currentWebview() : null;
        if (wv && wv.setStyle) wv.setStyle({ softinputMode: 'adjustResize' });
      } catch (e) {}
      const sheet = m.el;
      const vv = window.visualViewport || null;
      // 基准高度「只涨不跌」：万一键盘已经弹起时才打开编辑页，记成小值会让状态永久卡死
      let baseH = window.innerHeight || 0;
      let raf = 0;
      function later(fn, ms) { try { return setTimeout(fn, ms); } catch (e) { fn(); return 0; } }
      // 键盘压掉的高度（只有「布局视口没变」时才有值）
      function viewGap() {
        if (!vv) return 0;
        const gap = (window.innerHeight || 0) - (vv.height || 0) - (vv.offsetTop || 0);
        return gap > 100 ? Math.round(gap) : 0;   // < 100px 属于地址栏之类的抖动，不当键盘
      }
      function kbState() {
        const h = window.innerHeight || 0;
        if (h > baseH) baseH = h;
        const gap = viewGap();
        const resized = (baseH - h) > 140;   // 最小的软键盘也 ≥ 200px；140 只挡折叠/旋屏误判
        // 视口自己已经变矮（adjustResize）时绝不能再按 gap 抬 —— 那样会抬高两次
        return { open: gap > 100 || resized, lift: resized ? 0 : gap };
      }
      // 排版栏真正压住正文的高度：浮起时是整条，不浮起时只有胶囊探出栏外的那 22px
      function dockCover() {
        if (!dock.classList.contains('is-open')) return 0;
        const bar = dock.classList.contains('is-floating') ? dock.offsetHeight : 0;
        return bar + countPill.offsetHeight + 4;
      }
      // 量「光标所在那一行」在正文内容里的纵向位置。
      // textarea 自己量不出来，只能用一个同字体 / 同宽度 / 同内边距的镜像层：
      // 把「光标之前的文字 + 一个零宽字符」放进去，零宽字符的 offsetTop 就是光标行顶端。
      function caretBox() {
        const cs = getComputedStyle(descI);
        const mir = document.createElement('div');
        mir.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;overflow:hidden;';
        mir.style.width = descI.clientWidth + 'px';
        mir.style.whiteSpace = 'pre-wrap';
        mir.style.wordWrap = 'break-word';
        mir.style.overflowWrap = 'break-word';
        mir.style.fontFamily = cs.fontFamily;
        mir.style.fontSize = cs.fontSize;
        mir.style.lineHeight = cs.lineHeight;
        mir.style.letterSpacing = cs.letterSpacing;
        mir.style.paddingTop = cs.paddingTop;
        mir.style.paddingLeft = cs.paddingLeft;
        mir.style.paddingRight = cs.paddingRight;
        mir.style.boxSizing = 'border-box';
        let pos = 0;
        try { pos = descI.selectionStart || 0; } catch (_) {}
        mir.textContent = descI.value.slice(0, pos);
        const mk = document.createElement('span');
        mk.textContent = '\u200b';
        mir.appendChild(mk);
        (descI.parentNode || document.body).appendChild(mir);
        const lineH = mk.offsetHeight || parseFloat(cs.lineHeight) || 26;
        const top = mk.offsetTop;
        mir.remove();
        return { top: top, h: lineH };
      }
      // 滚动容器「真正看得见」的下沿（扣掉被键盘盖住的 + 排版栏与胶囊压住的）
      // .page-sheet 是 position:fixed; inset:0，所以元素 rect 坐标就是视口坐标。
      function visibleBottom(box, boxRect) {
        const vvBottom = vv ? (vv.height + (vv.offsetTop || 0)) : (window.innerHeight || 0);
        const covered = Math.max(0, boxRect.bottom - vvBottom);
        return box.scrollTop + box.clientHeight - covered - dockCover() - 14;
      }
      function ensureCaret() {
        if (!descI.parentNode) return;
        const box = descI.closest('.page-sheet-body');
        if (!box || box.clientHeight < 40) return;
        const boxRect = box.getBoundingClientRect();
        const taRect = descI.getBoundingClientRect();
        const rel = (taRect.top - boxRect.top) + box.scrollTop;   // textarea 顶边在滚动内容里的位置
        const c = caretBox();
        const caretTop = rel + c.top;
        const caretBottom = caretTop + c.h;
        const viewBottom = visibleBottom(box, boxRect);
        if (caretBottom > viewBottom) box.scrollTop = Math.min(box.scrollHeight, box.scrollTop + (caretBottom - viewBottom));
        else if (caretTop < box.scrollTop + 8) box.scrollTop = Math.max(0, caretTop - 8);
      }
      function apply() {
        const st = kbState();
        sheet.classList.toggle('kb-on', st.open);
        // 有键盘且布局视口没变矮（adjustPan / 悬浮键盘）时，栏自己浮到键盘上沿
        dock.style.bottom = (st.open && st.lift) ? st.lift + 'px' : '';
        dock.classList.toggle('is-floating', !!(st.open && st.lift));
        // 浮起来就脱离文档流了：正文要自己补出这段高度，最后一行才滚得上来
        try {
          m.body.style.paddingBottom = (st.open && st.lift) ? (dock.offsetHeight + 10) + 'px' : '';
        } catch (e) {}
        if (st.open) ensureCaret();
      }
      function schedule() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; apply(); });
      }
      // 键盘动画有几百毫秒、部分 ROM 还会二次改视口：多打两拍兜底
      function settle() { apply(); later(apply, 140); later(apply, 360); }
      // 每次输入都调它，但先用一次便宜的判断挡掉大多数情况：
      // 输入框底部还在「看得见的下沿」以上时，光标一定看得见，连量都不用量。
      kbTick = function () {
        try {
          const box = descI.closest('.page-sheet-body');
          if (!box) return;
          const boxRect = box.getBoundingClientRect();
          const vvBottom = vv ? (vv.height + (vv.offsetTop || 0)) : (window.innerHeight || 0);
          const covered = Math.max(0, boxRect.bottom - vvBottom);
          const realBottom = boxRect.bottom - covered - dockCover();
          if (descI.getBoundingClientRect().bottom < realBottom - 28) return;
          ensureCaret();
        } catch (e) {}
      };
      if (vv) { vv.addEventListener('resize', schedule, false); vv.addEventListener('scroll', schedule, false); }
      window.addEventListener('resize', schedule, false);
      descI.addEventListener('focus', () => { later(settle, 220); later(settle, 520); });
      descI.addEventListener('blur', () => { later(schedule, 80); later(settle, 260); });
      // 在正文 / 排版栏之外点一下：收键盘，也让排版栏跟着收起（否则它会一直挂着）
      sheet.addEventListener('pointerdown', (e) => {
        try {
          const t = e.target;
          if (!t || t === descI) return;
          if (descI.contains && descI.contains(t)) return;
          if (dock.contains && dock.contains(t)) return;
          if (hMenu.contains && hMenu.contains(t)) return;
          descI.blur();
        } catch (_) {}
      });
      apply();   // 打开页面先摆一次位（编辑已有记录时输入框可能已经聚焦）
    })();
  }

  return { renderList, renderDetail, openEditor, mdHtml };
})();
