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
  // 即时 Markdown 模式下「整篇正文」的取数入口（由 openEditor 注册，关闭时置空）。
  // 字数胶囊、保存、撤销都靠它拿到「当前块 + 其余块」拼起来的完整文本。
  let activeDocText = null;
  // 编辑页正文的两种模式：
  //   'blocks' = 即时 Markdown（默认，块级渲染，只有光标所在块显示源码）
  //   'source' = 老的整篇 textarea（逃生门：任何边角情况都能一键切回去）
  // 探针可以用 App.records.editorMode = 'source' 无条件退回老行为。
  let editorMode = 'blocks';
  // 评论删除：每条评论右侧一个「···」按钮 → 二次确认弹窗。
  // 历史上试过长按（650ms 弹底部操作条），在安卓 WebView 上必然和系统选字冲突：
  // 一按住文字，系统先立起选区、弹出「复制/全选」气泡并截走触摸，我们的条要么被盖住、
  // 要么被判定成拖动而取消。现在长按完完整整还给系统（选字复制照旧），删除只走显式按钮。


  // 只统计文字与标点：Markdown 记号与空白都不算（口径在 md.js 的 count() 里统一维护）
  function paintCountPill() {
    const ta = activeDescI, pill = activeCountPill;
    if (!ta || !pill) return;
    // 整篇文字的来源随模式变：源码模式就是 textarea 本身，块模式走 activeDocText()
    const v = activeDocText ? String(activeDocText() || '') : (ta.value || '');
    const s = ta.selectionStart, e = ta.selectionEnd;
    const hasSel = s != null && e != null && e > s;   // s === e 就是没选中，不能显示「已选 0 字」
    const selText = (hasSel && ta.value) ? String(ta.value).slice(s, e) : '';
    const n = (App.md && App.md.count) ? App.md.count(hasSel ? selText : v) : 0;
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

  // ===== 正文「即时 Markdown」的块切分（纯函数，不碰 DOM）=====
  // 唯一真源永远是整篇字符串，块只是它的一种视图。硬约束（有探针守）：
  //   splitDoc(t).map(b => b.text).join('\n') === t
  // 判定顺序必须与 js/md.js 的 render() 完全一致（fence → blank → hr → head → quote → ul → ol → p），
  // 否则「切出来的块」和「渲染出来的段落」对不上，点哪一块都会点偏。
  const RE_BLK_FENCE = /^```/;
  const RE_BLK_HR = /^([-*_])(\s*\1){2,}$/;
  const RE_BLK_HEAD = /^(#{1,6})\s+/;
  const RE_BLK_QUOTE = /^>\s?/;
  const RE_BLK_UL = /^[-*+]\s+/;
  const RE_BLK_OL = /^\d{1,3}[.)]\s+/;

  function lineKind(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (RE_BLK_FENCE.test(t)) return 'fence';
    if (!t) return 'blank';
    if (RE_BLK_HR.test(t)) return 'hr';          // 必须在 ul 之前：`---` 不能被当成列表项
    if (RE_BLK_HEAD.test(t)) return 'head';
    if (RE_BLK_QUOTE.test(t)) return 'quote';
    if (RE_BLK_UL.test(t)) return 'ul';
    if (RE_BLK_OL.test(t)) return 'ol';
    return 'p';
  }

  function splitDoc(src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text) return [{ kind: 'p', text: '' }];
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const k = lineKind(lines[i]);
      let j = i + 1;
      if (k === 'fence') {
        while (j < lines.length && !RE_BLK_FENCE.test(lines[j].trim())) j++;
        if (j < lines.length) j++;                              // 吃掉收尾围栏（找不到就吃到 EOF）
      } else if (k === 'hr' || k === 'head') {
        j = i + 1;                                              // 单行成块
      } else {
        while (j < lines.length && lineKind(lines[j]) === k) j++; // 同类连续行并成一块
      }
      out.push({ kind: k, text: lines.slice(i, j).join('\n') });
      i = j;
    }
    return out;
  }

  // 块 → HTML。空行块只负责「撑出那段空白」，用 em 计算高度，跟随字号档位缩放。
  function blockHtml(b) {
    if (b.kind === 'blank') {
      const n = Math.max(1, b.text.split('\n').length);
      return '<div class="ed-gap" style="height:calc(1.78em * ' + n + ')"></div>';
    }
    return (App.md && App.md.render) ? App.md.render(b.text) : mdHtml(b.text);
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
      if (key === 'time') { if (rec.timeSpentMin) box.appendChild(U().el('span', { class: 'mini-chip', html: U().icon('clock', 13) + ' ' + U().fmtDuration(rec.timeSpentMin, 'short') })); }
      else if (key === 'income') { if (rec.income) box.appendChild(U().el('span', { class: 'mini-chip inc', html: U().icon('wallet', 13) + ' ' + U().fmtMoney(rec.income) })); }
      else if (key === 'expense') { if (rec.expense) box.appendChild(U().el('span', { class: 'mini-chip exp', html: U().icon('wallet', 13) + ' -' + U().fmtMoney(rec.expense) })); }
      else { const f = (domain.customFields || []).find((x) => x.id === key); if (!f) return; const v = (rec.customValues || {})[key]; if (v == null || v === '') return; let txt = String(v); if (f.type === 'select') { const o = (f.options || []).find((o) => o.id === v); txt = o ? o.name : txt; } box.appendChild(U().el('span', { class: 'mini-chip', title: f.name, text: txt })); }
    });
    return box;
  }

  // 待办进度徽标：▢3/5 ⇄ ☑5/5（全部完成时方框填强调色）。
  // 方框用 CSS 画、对勾用 svg —— 旧 WebView 的中文字体常缺 U+25A2 / U+2611，直接写 ▢ 会变豆腐块。
  // 列表卡片与详情页待办块共用这一个构造器，两处的形状、字号口径才不会漂。
  function progBadge(done, total, cls) {
    const all = total > 0 && done >= total;
    const el = U().el('span', { class: 'prog' + (all ? ' is-all' : '') + (cls ? ' ' + cls : '') });
    el.appendChild(U().el('span', { class: 'prog-box', html: all ? U().icon('check', 9) : '' }));
    el.appendChild(U().el('span', { class: 'prog-num', text: done + '/' + total }));
    return el;
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
    // 卡片脚注：左边日期、中间待办进度（有才出）、右边字数，一行三元素两端对齐 ——
    // 所有卡片的字数都压在右下角，扫列表时位置固定、成列，不会随标题长短跳来跳去。
    // 进度徽标只对「有待办」的记录出现：没待办的卡片不该多一个字。
    const stList = rec.steps || [];
    const stTotal = stList.length;
    const stDone = stTotal ? stList.filter((s) => s.done).length : 0;
    const foot = U().el('div', { class: 'rc-foot' },
      U().el('span', { class: 'rc-date', text: U().fmtDate(rec.date || rec.createdAt) }),
      stTotal ? progBadge(stDone, stTotal, 'rc-prog') : null,
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
    stopDetailTick();                      // 离开详情页：把「待办块每秒重算」退掉（列表不需要）
    // 计时小窗【不关】：它现在是全局常驻的（见 initTimerWin），回列表也该看得见
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

  // ===== 详情页待办块的公共件 =====
  // 详情页与编辑页共用这一个输入弹窗（原来它藏在 openEditor 闭包里，详情页要用就得搬出来）。
  function promptText(title, value, okLabel, cb) {
    const inp = U().el('input', { class: 'input', value: value || '', placeholder: '写点什么…' });
    const dlg = U().modal({
      title: title,
      body: U().el('div', { class: 'field' }, inp),
      actions: [{ label: okLabel || '确定', primary: true, onClick: () => { const v = String(inp.value || '').trim(); dlg.close(); cb(v); } }],
    });
    setTimeout(() => { try { inp.focus(); } catch (_) {} }, 80);
  }

  // 详情页的计时订阅：切路由 / 重绘详情时必须退订，否则每秒往已卸载的节点上写字，
  // 而且回调会越积越多（切 30 次就是 30 份同时跑，中低端机直接掉帧）。
  let detailTickOff = null;
  function stopDetailTick() {
    if (detailTickOff) { try { detailTickOff(); } catch (_) {} detailTickOff = null; }
  }

  // ===== 可拖拽的计时小窗（只在详情页出现）=====
  // 为什么挂 body 而不是详情页里：详情页在 .detail-page 上做了 setPointerCapture 做上下条翻页，
  // 任何挂在它子树里的浮层都会被指针重定向吞掉点击。挂 body + 用 touch 事件就互不干扰。
  // 为什么要它：计时可以在编辑页之外继续跑（保存/关闭都不停表），得有一个随时能看能停的入口。
  let timerWin = null;          // { el, clock, name, note, ctx, pos, onResize }
  let timerWinPos = null;       // { side:'left'|'right', y } 内存缓存，避免每次挂载都闪一下
  const TMWIN_M = 8;            // 吸边留白

  function navReserve() {
    const nav = document.querySelector('.bottom-nav');
    return ((nav && nav.offsetHeight) || 48) + 10;      // 底部导航 + 呼吸
  }
  function placeTimerWin(pos, animate) {
    if (!timerWin) return pos;
    const el = timerWin.el;
    const w = el.offsetWidth || 132, h = el.offsetHeight || 60;
    const side = pos.side === 'left' ? 'left' : 'right';
    const left = side === 'left' ? TMWIN_M : (window.innerWidth - w - TMWIN_M);
    const maxTop = Math.max(TMWIN_M, (window.innerHeight || 640) - navReserve() - h);
    const top = Math.max(TMWIN_M, Math.min(maxTop, Number(pos.y) || 0));
    el.classList.toggle('snap', !!animate);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    return { side: side, y: top };
  }
  function closeTimerWin() {
    if (!timerWin) return;
    try { if (timerWin.onResize) window.removeEventListener('resize', timerWin.onResize); } catch (_) {}
    try { timerWin.el.remove(); } catch (_) {}
    timerWin = null;
  }
  // 小窗上改备注：只 patch 这一段（不碰时间，也不重建整页）
  function patchSegNote(recId, segId, v) {
    return App.db.patchRecord(recId, (cur) => {
      let hit = null;
      (cur.steps || []).forEach((s) => (s.segs || []).forEach((g) => { if (g.id === segId) hit = g; }));
      if (!hit) return null;
      hit.note = v;
      return { steps: cur.steps };
    });
  }
  // 折叠态：只剩「● 00:03」，点时钟展开（展开后才有 ⏸ 和 − 两个按钮）。
  // 记住折叠与否（KV: timerWinMini）：切换页面时小窗常驻，形状不该每次变回去。
  let timerWinMini = false;
  function setTimerWinMini(on, animate) {
    if (!timerWin) return;
    timerWinMini = !!on;
    timerWin.el.classList.toggle('mini', timerWinMini);
    // 宽度变了，吸边坐标要重算（否则「贴右」会变成离边一小截）
    timerWin.pos = placeTimerWin(timerWin.pos || timerWinPos || { side: 'right', y: 80 }, !!animate);
    try { App.db.setKV('timerWinMini', timerWinMini); } catch (_) {}
  }

  function ensureTimerWin() {
    if (timerWin && timerWin.el.isConnected) return timerWin;
    const el = U().el('div', { class: 'tmwin' });
    const clock = U().el('span', { class: 'tmwin-clock', text: '00:00' });
    const pause = U().el('button', { class: 'tmwin-btn', type: 'button', html: U().icon('pause', 14), title: '暂停' });
    // 放大：进专注计时页（全屏 FocusTimer），进去后小窗隐藏
    const focusBtn = U().el('button', { class: 'tmwin-btn is-focus', type: 'button', html: U().icon('expand', 13), title: '专注计时' });
    // 「−」折叠：只显示时钟，把窗子收成一颗小胶囊
    const minus = U().el('button', { class: 'tmwin-btn is-min', type: 'button', text: '−', title: '收起' });
    pause.setAttribute('aria-label', '暂停');
    focusBtn.setAttribute('aria-label', '进入专注计时');
    minus.setAttribute('aria-label', '收起计时窗');
    // 顶行只放「时钟 + 暂停 + 收起」；放大按钮挪到底行最右（备注右边），见 sub
    const topRow = U().el('div', { class: 'tmwin-top' },
      U().el('span', { class: 'tmwin-dot' }), clock, U().el('span', { class: 'tmwin-sp' }), pause, minus);
    const name = U().el('span', { class: 'tmwin-name' });
    const note = U().el('button', { class: 'tmwin-note', type: 'button' });
    const sub = U().el('div', { class: 'tmwin-sub' }, name, note, focusBtn);
    el.appendChild(topRow); el.appendChild(sub);
    document.body.appendChild(el);

    pause.addEventListener('click', async () => {
      await App.timer.stop();
      U().toast('已暂停', 'ok');          // 订阅会把小窗收掉
    });
    focusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (App.focus && App.focus.open) App.focus.open();
      else U().toast('专注页未就绪', 'err');
    });
    minus.addEventListener('click', (e) => { e.stopPropagation(); setTimerWinMini(true, true); });
    clock.addEventListener('click', () => { if (timerWinMini) setTimerWinMini(false, true); });
    note.addEventListener('click', () => {
      const c = timerWin && timerWin.ctx;
      if (!c) return;
      const rec = winRec(c.recId);
      const st = rec && (rec.steps || []).find((s) => s.id === c.stepId);
      const seg = st && (st.segs || []).find((g) => g.id === c.segId);
      promptText('这一段在做什么', (seg && seg.note) || '', '保存', async (v) => {
        try { await patchSegNote(c.recId, c.segId, v); } catch (_) { U().toast('保存失败，请重试', 'err'); return; }
        if (note.textContent !== (v || '加备注')) note.textContent = v || '加备注';
        note.classList.toggle('is-empty', !v);
      });
    });

    // 拖拽：touch（不用 Pointer Events —— 系统会抢 pointercancel）。
    // 6px 阈值：手指只是点一下时仍然算点击，不会把「暂停」点成拖动。
    let drag = null;
    let tapMoved = false;      // 上一次手指抬起是不是「拖」结束的（拖完不能算点击）
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      drag = { sx: t.clientX, sy: t.clientY, ox: el.offsetLeft, oy: el.offsetTop, moved: false };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!drag || e.touches.length !== 1) return;
      const t = e.touches[0], dx = t.clientX - drag.sx, dy = t.clientY - drag.sy;
      if (!drag.moved) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        drag.moved = true;
        el.classList.add('dragging');
        el.classList.remove('snap');
      }
      if (e.cancelable) e.preventDefault();     // 确认在拖了才锁手势，轻点不受影响
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = Math.max(TMWIN_M, Math.min(window.innerWidth - w - TMWIN_M, drag.ox + dx));
      const y = Math.max(TMWIN_M, Math.min((window.innerHeight || 640) - navReserve() - h, drag.oy + dy));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }, { passive: false });
    function endDrag() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      tapMoved = moved;                          // 交给下面的 click 守卫：拖完不算点
      el.classList.remove('dragging');
      if (!moved) return;                        // 点按：交给按钮自己的 click
      const side = (el.offsetLeft + el.offsetWidth / 2) < window.innerWidth / 2 ? 'left' : 'right';
      const pos = placeTimerWin({ side: side, y: el.offsetTop }, true);
      if (timerWin) timerWin.pos = pos;
      timerWinPos = pos;
      try { App.db.setKV('timerWinPos', pos); } catch (_) {}
    }
    el.addEventListener('touchend', endDrag);
    el.addEventListener('touchcancel', endDrag);

    // 点小窗本体（没点到任何按钮）→ 跳到这条记录的详情页。
    // 三重守卫：① 折叠态交给 clock 的「展开」；② 刚拖过的一下不算点；③ 按钮自己的 click 已处理。
    el.addEventListener('click', (e) => {
      if (timerWinMini) return;
      if (tapMoved) { tapMoved = false; return; }
      if (e.target && e.target.closest && e.target.closest('button')) return;
      const c = timerWin && timerWin.ctx;
      if (!c || !c.recId) return;
      if ((location.hash || '') === '#/record/' + c.recId) return;   // 已经在这条详情页
      App.app.go('record/' + c.recId);
    });

    const onResize = () => { if (timerWin) timerWin.pos = placeTimerWin(timerWin.pos || timerWinPos || { side: 'right', y: 80 }, false); };
    window.addEventListener('resize', onResize);

    timerWin = { el: el, clock: clock, name: name, note: note, ctx: null, pos: null, onResize: onResize };
    // 先算好坐标再亮：直接 append 会有一帧闪在左上角 (0,0)
    const applyPos = () => {
      if (!timerWin || !el.isConnected) return;
      const pos = timerWinPos || { side: 'right', y: Math.round((window.innerHeight || 640) * 0.24) };
      timerWinPos = pos;
      timerWin.pos = placeTimerWin(pos, false);
    };
    const show = () => setTimeout(() => { try { if (el.isConnected) el.classList.add('on'); } catch (_) {} }, 0);
    // 位置与折叠状态一起读：两件都到位再算坐标，避免「先亮在默认位再跳到记住的位置」
    try {
      Promise.all([
        Promise.resolve(App.db.getKV('timerWinPos', null)).catch(() => null),
        Promise.resolve(App.db.getKV('timerWinMini', false)).catch(() => false),
      ]).then((res) => {
        const p = res && res[0];
        if (p && p.side) timerWinPos = p;
        timerWinMini = !!(res && res[1]);
        el.classList.toggle('mini', timerWinMini);
        applyPos(); show();
      }).catch(() => { applyPos(); show(); });
    } catch (_) { applyPos(); show(); }
    return timerWin;
  }
  // 小窗要跨页面常驻，就不能再依赖「当前详情页那条 rec」：按 recId 去全局内存里找，
  // 找不到（刚启动 / 列表还没刷出来）就异步取一次并缓存，取到后下一拍自然补上名字。
  const winRecCache = Object.create(null);
  const winRecFetching = Object.create(null);
  function winRec(id) {
    if (!id) return null;
    const list = (App.state && App.state.data && App.state.data.records) || [];
    const hit = list.find((r) => r.id === id);
    if (hit) return hit;
    if (winRecCache[id]) return winRecCache[id];
    if (!winRecFetching[id] && App.db && App.db.getRecord) {
      winRecFetching[id] = true;
      Promise.resolve(App.db.getRecord(id)).then((r) => { if (r) winRecCache[id] = r; })
        .catch(() => {}).then(() => { winRecFetching[id] = false; });
    }
    return null;
  }

  // 专注页打开期间：小窗必须让位（专注页本身就是全屏计时，再飘一颗窗子重复且挡视线）。
  // 由 App.focus 通过 setFocusMode 置位；关页时复位并立刻重画一次，还在跑的话窗子自己回来。
  let focusMode = false;
  function setFocusMode(on) {
    focusMode = !!on;
    if (focusMode) { closeTimerWin(); return; }
    try { paintTimerWin(App.timer ? App.timer.state() : null); } catch (_) {}
  }

  function paintTimerWin(st) {
    const live = !!(st && st.running);
    if (!live || focusMode) { closeTimerWin(); return; }
    const w = ensureTimerWin();
    w.ctx = { recId: st.recId, stepId: st.stepId, segId: st.segId };
    w.clock.textContent = U().fmtClock(st.elapsedSec);          // 每秒只有这一行变
    const rec = winRec(st.recId);
    const step = rec && (rec.steps || []).find((s) => s.id === st.stepId);
    const nameTxt = step ? (step.text || '未命名待办') : '计时中';
    if (w.name.textContent !== nameTxt) w.name.textContent = nameTxt;
    const seg = step && (step.segs || []).find((g) => g.id === st.segId);
    const noteTxt = (seg && seg.note) || '加备注';
    if (w.note.textContent !== noteTxt) w.note.textContent = noteTxt;
    w.note.classList.toggle('is-empty', !(seg && seg.note));
  }

  // 全局订阅：计时一开，不论在哪个页面小窗都在；暂停/结束才收起来。
  // 原来是「详情页 renderDetail 里订阅、离开就 close」，所以一保存回列表就看不见了。
  let globalTickOff = null;
  function initTimerWin() {
    if (!App.timer || globalTickOff) return;
    globalTickOff = App.timer.on(paintTimerWin);
    paintTimerWin(App.timer.state());
  }

  // 轮播高度的「上次算出来的值」，键 = 记录 id + ':' + 图片序号。
  // 为什么要缓存：applyRatio 是靠 img 的 naturalWidth/Height 算的，而图片是异步解码的 ——
  // 关掉编辑页就地重绘详情时，第一帧还没有高度，整页比真实矮一截，
  // 滚动恢复就被钳在错误的位置上（表现为「关页面后往上跳了一屏多」）。
  // 缓存住上一次的高度，重绘首帧直接给上，滚动一次到位，图解码完再核对修正。
  const carouselH = Object.create(null);
  function carKey(id, idx) { return id + ':' + idx; }

  function renderDetail(container, id) {
    stopDetailTick();                      // 先退订上一份，再重建
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
      carouselH[carKey(rec.id, imgIdx)] = h;      // 记下来：下次重绘首帧直接用
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
      // 有缓存就先按缓存撑开，避免「切图瞬间塌成 0 高再弹回来」（老内核没有 aspect-ratio 兜底）
      const cached = carouselH[carKey(rec.id, imgIdx)];
      if (cached && carousel) carousel.style.height = cached + 'px';
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
      // 首帧就用上一次算好的高度：图片解码要等，否则重绘后整页高度先矮一截
      const h0 = carouselH[carKey(rec.id, 0)];
      if (h0) carousel.style.height = h0 + 'px';
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
    // 有待办时不再显示「时长」胶囊：下面的步骤块已经有一行「总用时」，同屏出现两次会互相打架
    const hasSteps = Array.isArray(rec.steps) && rec.steps.length > 0;
    // 时间保持原来的胶囊样式，不和字数绑在一起
    if (rec.timeSpentMin && !hasSteps) meta.appendChild(U().el('span', { class: 'chip', html: U().icon('clock', 15) + ' ' + U().fmtDuration(rec.timeSpentMin) }));
    if (rec.income) meta.appendChild(U().el('span', { class: 'chip inc', text: '收入 ' + U().fmtMoney(rec.income) }));
    if (rec.expense) meta.appendChild(U().el('span', { class: 'chip exp', text: '支出 ' + U().fmtMoney(rec.expense) }));

    // 自定义属性展示
    const cfRow = U().el('div', { class: 'row wrap', style: { gap: '6px', margin: '4px 0' } });
    (domain.customFields || []).forEach((f) => { const v = (rec.customValues || {})[f.id]; if (v == null || v === '') return; let txt = String(v); if (f.type === 'select') { const o = (f.options || []).find((o) => o.id === v); txt = o ? o.name : txt; } cfRow.appendChild(U().el('span', { class: 'chip', title: f.name, html: '<b>' + f.name + '：</b>' + txt })); });

    // —— 待办与用时 ——
    // 20261117a 起这块是「可管」的：加 / 改名 / 上移下移 / 删除 / 勾选，还能直接开始、暂停、结束计时。
    // 三条铁律：
    //  ① 写库只经 patchSteps() → App.db.patchRecord（只改 steps 与 timeSpentMin），绝不 saveRecord ——
    //     详情页的 rec 是打开那一刻的快照，整条写回会把编辑器里没保存的字段一起盖成旧值；
    //  ② 每秒只改 textContent（dNums 注册表），不重建 DOM —— 重建会闪，也会把用户正看的滚动位置顶掉；
    //  ③ 计时订阅在 renderDetail / renderList 入口统一退订（stopDetailTick），切路由不泄漏。
    const stepsBox = U().el('div', { class: 'detail-steps' });
    const dNums = [];                 // [{ el, fn }] 需要每秒刷新的数字
    let dSumEl = null;                // 汇总行（总用时也要跟着跳）
    function bindDNum(el, fn) { if (el) dNums.push({ el: el, fn: fn }); return el; }
    function dSteps() { if (!Array.isArray(rec.steps)) rec.steps = []; return rec.steps; }

    // 所有写库都从这里走：回调里就地改「库里的最新那份」，只回写 steps + timeSpentMin。
    // 用同步的 syncTimeFromSteps 回写总时长 —— 手填过（timeSpentMinManual）就不覆盖，口径只有一份实现。
    function patchSteps(mutator) {
      return App.db.patchRecord(rec.id, (cur) => {
        if (!Array.isArray(cur.steps)) cur.steps = [];
        if (mutator(cur.steps) === false) return null;        // 目标已不存在：不动库
        const tmp = { steps: cur.steps, timeSpentMinManual: cur.timeSpentMinManual, timeSpentMin: cur.timeSpentMin };
        syncTimeFromSteps(tmp, cur.timeSpentMin == null ? null : cur.timeSpentMin);
        return { steps: cur.steps, timeSpentMin: tmp.timeSpentMin };
      });
    }
    function dFail() { U().toast('保存失败，请重试', 'err'); }

    function dAddStep() {
      promptText('新建待办', '', '添加', async (v) => {
        const step = { id: App.storage.uid(), text: v, note: '', done: false, doneAt: null, segs: [] };
        try { await patchSteps((list) => { list.push(step); }); } catch (e) { dFail(); return; }
        paintStepsBlock();
      });
    }
    function dRenameStep(s) {
      promptText('待办名称', s.text, '保存', async (v) => {
        try { await patchSteps((list) => { const t = list.find((x) => x.id === s.id); if (!t) return false; t.text = v; }); }
        catch (e) { dFail(); return; }
        paintStepsBlock();
      });
    }
    async function dMoveStep(s, dir) {
      try {
        await patchSteps((list) => {
          const i = list.findIndex((x) => x.id === s.id), j = i + dir;
          if (i < 0 || j < 0 || j >= list.length) return false;
          const one = list.splice(i, 1)[0]; list.splice(j, 0, one);
        });
      } catch (e) { dFail(); return; }
      paintStepsBlock();
    }
    async function dDeleteStep(s) {
      const ok = await U().confirmDialog('删除「' + (s.text || '未命名待办') + '」及其全部计时记录？', { okLabel: '删除', danger: true }).catch(() => false);
      if (!ok) return;
      // 正在计时的待办要先把表停掉，否则会留下一条永远收不了口的段
      const st = App.timer ? App.timer.state() : { running: false };
      if (st.running && st.recId === rec.id && st.stepId === s.id) { try { await App.timer.stop(); } catch (_) {} }
      try { await patchSteps((list) => { const i = list.findIndex((x) => x.id === s.id); if (i < 0) return false; list.splice(i, 1); }); }
      catch (e) { dFail(); return; }
      paintStepsBlock();
    }
    function dStepMenu(s) {
      const list = U().el('div', { class: 'col', style: { gap: '2px' } });
      const row = (label, disabled, fn) => {
        const b = U().el('button', { class: 'ed-hmenu-item', type: 'button' }, U().el('span', { class: 'ed-hmenu-t', text: label }));
        if (disabled) { b.disabled = true; b.classList.add('is-off'); }
        else b.addEventListener('click', () => { dlg.close(); fn(); });
        list.appendChild(b);
      };
      const all = dSteps(), at = all.findIndex((x) => x.id === s.id);
      row('重命名', false, () => dRenameStep(s));
      row('上移一位', at <= 0, () => dMoveStep(s, -1));
      row('下移一位', at < 0 || at >= all.length - 1, () => dMoveStep(s, 1));
      row('删除这条待办', false, () => dDeleteStep(s));
      const dlg = U().modal({ title: '待办操作', body: list, center: true });
    }
    function dEditSegNote(s, g) {
      promptText('这一段在做什么', g.note, '保存', async (v) => {
        try {
          await patchSteps((list) => {
            const t = list.find((x) => x.id === s.id);
            const sg = t && (t.segs || []).find((y) => y.id === g.id);
            if (!sg) return false;
            sg.note = v;
          });
        } catch (e) { dFail(); return; }
        paintStepsBlock();
      });
    }
    function dEditSegTime(s, g) {
      openSegTime(g, async (st, en) => {
        try {
          await patchSteps((list) => {
            const t = list.find((x) => x.id === s.id);
            const sg = t && (t.segs || []).find((y) => y.id === g.id);
            if (!sg) return false;
            sg.start = st;
            if (en != null) sg.end = en;
          });
        } catch (e) { dFail(); return; }
        paintStepsBlock();
      });
    }
    function dDeleteSeg(s, g) {
      U().confirmDialog('删除这一段计时（' + U().fmtHMS(segSec(g)) + '）？', { okLabel: '删除', danger: true }).then(async (ok) => {
        if (!ok) return;
        // 正在跑的那一段必须先把表停掉再摘：反过来会留下 end=null 的悬挂段，
        // 下次启动时 timer.init() 按 0 秒收口，这段时长就凭空消失了。
        const st = App.timer ? App.timer.state() : { running: false };
        if (st.running && st.segId === g.id) { try { await App.timer.stop(); } catch (_) {} }
        try {
          await patchSteps((list) => {
            const t = list.find((x) => x.id === s.id);
            if (!t || !Array.isArray(t.segs)) return false;
            const i = t.segs.findIndex((y) => y.id === g.id);
            if (i < 0) return false;
            t.segs.splice(i, 1);
          });
        } catch (e) { dFail(); return; }
        paintStepsBlock();
      }).catch(() => {});
    }
    async function dToggleTimer(s) {
      if (!App.timer) return;
      const st = App.timer.state();
      if (st.running && st.recId === rec.id && st.stepId === s.id) {
        await App.timer.stop();
        U().toast('已暂停', 'ok');
        return;                       // 收口后订阅会重画这一块
      }
      const r = await App.timer.start(rec.id, s.id);
      if (!r || !r.ok) {
        U().toast(r && r.reason === 'nostep' ? '这条待办已经被删掉了' : '没能开始计时，请重试', 'err');
        return;
      }
      if (r.prev && r.prev.recId !== rec.id) U().toast('已结束另一条记录上的计时', 'ok');
    }
    async function dFinishTimer(s) {
      if (!App.timer) return;
      const st = App.timer.state();
      if (!(st.running && st.recId === rec.id && st.stepId === s.id)) return;
      await App.timer.stop({ done: true });     // 停表 + 打勾，同一次写库
      U().toast('已结束并标记完成', 'ok');
    }

    function buildDetailStep(s) {
      const segs = s.segs || [];
      const st = App.timer ? App.timer.state() : { running: false };
      const live = !!(st.running && st.recId === rec.id && st.stepId === s.id);
      const row = U().el('div', { class: 'dst-step' + (s.done ? ' is-done' : '') + (live ? ' is-live' : '') });
      const top = U().el('div', { class: 'step-top' });
      const chk = U().el('button', { class: 'step-chk' + (s.done ? ' on' : ''), type: 'button', html: s.done ? U().icon('check', 13) : '', title: s.done ? '标记为未完成' : '标记为已完成' });
      chk.setAttribute('aria-label', s.done ? '标记为未完成' : '标记为已完成');
      chk.addEventListener('click', () => { toggleStepDone(s.id, !s.done); });
      const name = U().el('div', { class: 'dst-name', text: s.text || '未命名待办' });
      // 用时恒绑定（原来只有 >0 才写，空着看起来像坏掉），每秒由 paintDNums 刷新
      const dur = bindDNum(U().el('span', { class: 'step-dur' }), () => stepSec(s));
      const more = U().el('button', { class: 'icon-btn step-more', type: 'button', html: U().icon('more', 18), title: '待办操作' });
      more.addEventListener('click', () => dStepMenu(s));
      top.appendChild(chk); top.appendChild(name); top.appendChild(dur); top.appendChild(more);
      row.appendChild(top);

      // 计时按钮就放在这一行下面：详情页不再需要「回编辑页滑到待办卡」才能停表
      const acts = U().el('div', { class: 'dst-acts' });
      const tbtn = U().el('button', { class: 'step-timer' + (live ? ' is-run' : ''), type: 'button' },
        U().el('span', { class: 'step-timer-ic', html: U().icon(live ? 'pause' : 'play', 13) }),
        U().el('span', { text: live ? '暂停' : (segs.length ? '继续计时' : '开始计时') }));
      tbtn.addEventListener('click', () => dToggleTimer(s));
      acts.appendChild(tbtn);
      if (live) {
        const fin = U().el('button', { class: 'step-timer is-fin', type: 'button' },
          U().el('span', { text: '结束并完成' }));
        fin.addEventListener('click', () => dFinishTimer(s));
        acts.appendChild(fin);
      }

      if (segs.length) {
        const segsEl = U().el('div', { class: 'step-segs' });
        segs.forEach((g) => {
          const liveSeg = g.end == null;
          const line = U().el('div', { class: 'seg-row' + (liveSeg ? ' is-live' : '') });
          // 与编辑页同一套：时刻可点改起止，已结束的段补「时:分:秒」耗时，行尾可删
          const time = U().el('button', { class: 'seg-time', type: 'button', title: '修改起止时间' });
          if (liveSeg) {
            bindDNum(time, () => segSec(g));
            time.classList.add('is-clock');   // 与编辑页同义：带这个类 = 正在走的时钟
          } else time.textContent = hmLabel(g.start) + '–' + hmLabel(g.end);
          time.addEventListener('click', () => dEditSegTime(s, g));
          line.appendChild(time);
          // 备注从「只读文字」改成可点即改：小窗上也能改，两边同一个入口语义
          const noteBtn = U().el('button', { class: 'seg-note-ro', type: 'button', text: g.note || '加备注' });
          noteBtn.addEventListener('click', () => dEditSegNote(s, g));
          line.appendChild(noteBtn);
          if (!liveSeg) line.appendChild(U().el('span', { class: 'seg-dur', text: U().fmtHMS(segSec(g)) }));
          const del = U().el('button', { class: 'icon-btn seg-del', type: 'button', html: U().icon('x', 13), title: '删除这一段' });
          del.addEventListener('click', () => dDeleteSeg(s, g));
          line.appendChild(del);
          segsEl.appendChild(line);
        });
        row.appendChild(segsEl);
      }
      // 操作按钮一律放在最后（分段列表之后）：正在计时时，「暂停 / 结束并完成」
      // 就永远在那一行走动的时钟下方，而不是夹在待办名和时钟中间。
      row.appendChild(acts);
      return row;
    }

    function paintStepsBlock() {
      // 一条待办都没有：整块不出现。空白态（「还没有待办…」+ 一条 1px 分割线 + 汇总位）
      // 会白占一百多像素，对「本来就不写待办」的笔记毫无意义 —— 要加待办进编辑页加。
      if (!dSteps().length) {
        stepsBox.classList.add('is-empty');
        U().clear(stepsBox);
        dNums.length = 0;
        dSumEl = null;
        return;
      }
      stepsBox.classList.remove('is-empty');
      // 只清空这一块重画：不动 page / sheet / card，滚动位置天然保留
      U().clear(stepsBox);
      dNums.length = 0;
      const list = dSteps();
      const add = U().el('button', { class: 'icon-btn steps-add', type: 'button', html: U().icon('plus', 18), title: '新建待办' });
      add.setAttribute('aria-label', '新建待办');
      add.addEventListener('click', (e) => { e.stopPropagation(); dAddStep(); });
      dSumEl = U().el('span', { class: 'dst-sum' });
      stepsBox.appendChild(U().el('div', { class: 'dst-head' },
        U().el('span', { class: 'dst-title', text: '待办计时' }), dSumEl, add));
      const listEl = U().el('div', { class: 'dst-list' });
      list.forEach((s) => listEl.appendChild(buildDetailStep(s)));
      stepsBox.appendChild(listEl);
      paintDNums();                    // 画完立刻同步一次，绝不等下一秒
    }
    function paintDNums() {
      for (let i = 0; i < dNums.length; i++) {
        try { dNums[i].el.textContent = U().fmtHMS(dNums[i].fn()); } catch (_) {}
      }
      if (dSumEl) {
        const list = dSteps();
        // 一条都没有时不摆「0/0 · 0 分」这种废话，空态文案已经说清楚了
        if (!list.length) {
          if (dSumEl.dataset.k !== '') { dSumEl.dataset.k = ''; U().clear(dSumEl); }
        } else {
          const done = list.filter((s) => s.done).length;
          const total = list.length;
          const k = done + '/' + total;
          // 这个函数每秒都会被 tick 叫一次：只有「完成数」变了才重建徽标，
          // 其余时间只改「总用时」那几个字 —— 否则每秒重建一次节点，列表会微微抖。
          if (dSumEl.dataset.k !== k) {
            dSumEl.dataset.k = k;
            U().clear(dSumEl);
            dSumEl.appendChild(progBadge(done, total));
            dSumEl.appendChild(U().el('span', { class: 'dst-sum-time' }));
          }
          const timeEl = dSumEl.querySelector('.dst-sum-time');
          if (timeEl) {
            const txt = ' · 总用时 ' + (U().fmtDuration(Math.round(recSec(rec) / 60)) || '0 分');
            if (timeEl.textContent !== txt) timeEl.textContent = txt;
          }
        }
      }
    }

    // 就地勾选：只 patch steps 里的 done/doneAt —— 绝不 saveRecord（那会把这页没编辑过的
    // 字段一起写回旧值）。乐观更新 + 失败回滚，勾一下不会等一次 IO 才变色。
    async function toggleStepDone(id, next) {
      const s = (rec.steps || []).find((x) => x.id === id);
      if (!s) return;
      const prevDone = s.done, prevAt = s.doneAt;
      s.done = next; s.doneAt = next ? Date.now() : null;
      paintStepsBlock();
      try {
        await App.db.patchRecord(rec.id, (cur) => {
          const t = (cur.steps || []).find((x) => x.id === id);
          if (!t) return null;
          t.done = next; t.doneAt = s.doneAt;
          return { steps: cur.steps };          // 勾选不改 timeSpentMin
        });
      } catch (e) {
        s.done = prevDone; s.doneAt = prevAt;
        paintStepsBlock();
        U().toast('保存失败，请重试', 'err');
      }
    }
    paintStepsBlock();

    // 计时订阅：一秒钟一次只刷数字；只有「开始/换段/收口」才重画整块（那时代码结构真的变了）。
    function mountDetailTick() {
      stopDetailTick();
      if (!App.timer) return;                 // 探针桩环境里没有 timer.js，必须容错
      const st0 = App.timer.state();
      let lastKey = (st0.running && st0.recId === rec.id) ? st0.segId : '';
      detailTickOff = App.timer.on((st) => {
        paintDNums();
        const key = (st.running && st.recId === rec.id) ? st.segId : '';
        if (key !== lastKey) { lastKey = key; paintStepsBlock(); }
        paintTimerWin(st);          // 每秒只改小窗里的时钟
      });
    }

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
      stepsBox,
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
    mountDetailTick();                       // 进详情页才挂每秒刷新，离开时由 renderDetail/renderList 退订
    paintTimerWin(App.timer ? App.timer.state() : null);   // 重进详情页：表还在跑就把小窗挂回来
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

  // —— 步骤 / 分段计时：时长口径的唯一实现 ——
  // 只存绝对时间戳 start / end，任何显示都现算 —— 不做「定时器累加」，
  // 所以切后台、锁屏、被系统冻结都不会让读数变慢或丢秒。
  const SEG_MAX_SEC = 8 * 3600;   // 单段硬上限：忘了停也不会凭空多出几十小时
  function segSec(s) {
    if (!s || !s.start) return 0;
    const end = (s.end == null) ? Date.now() : s.end;
    return Math.max(0, Math.min(SEG_MAX_SEC, Math.round((end - s.start) / 1000)));
  }
  function stepSec(step) { return ((step && step.segs) || []).reduce((a, s) => a + segSec(s), 0); }
  function recSec(rec) { return ((rec && rec.steps) || []).reduce((a, s) => a + stepSec(s), 0); }
  // 把「步骤计时总时长」回写进 timeSpentMin。
  //   timeSpentMinManual=true → 一律不覆盖（用户手填优先）
  //   有计时且 > 0           → 取整分钟（最小 1）
  //   没有计时               → 用 fallback（旧数据沿用原值；null 就是空）
  // 仪表盘 / 目标进度 / 按时长排序都只认 timeSpentMin，所以它们一行都不用改。
  function syncTimeFromSteps(rec, fallbackMin) {
    if (rec.timeSpentMinManual) return rec.timeSpentMin;
    const sec = recSec(rec);
    if (sec > 0) { rec.timeSpentMin = Math.max(1, Math.round(sec / 60)); return rec.timeSpentMin; }
    rec.timeSpentMin = (fallbackMin == null) ? null : fallbackMin;
    return rec.timeSpentMin;
  }
  // 旧记录没有 steps / segs：读取端一律兜底，不写库（保存时自然补齐）
  function normalizeSteps(rec) {
    if (!Array.isArray(rec.steps)) rec.steps = [];
    rec.steps.forEach((s) => {
      if (!Array.isArray(s.segs)) s.segs = [];
      if (typeof s.done !== 'boolean') s.done = false;
      if (s.note == null) s.note = '';
      if (s.doneAt == null) s.doneAt = null;
      s.segs.forEach((g) => { if (g.note == null) g.note = ''; });
    });
    return rec.steps;
  }

  // 分段起止时刻显示成 HH:MM（详情页与编辑页共用；编辑页内部那份 hhmm 仍保留给实时行）
  function hmLabel(ts) {
    const d = new Date(Number(ts) || 0);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // "9:05" / "09:05" / "9：05" → 当日分钟数；不合法 → null。
  // 不写死两位：input[type=time] 在个别魔改 ROM 的 WebView 里会退化成普通文本框。
  function parseHM(v) {
    const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return (h > 23 || mi > 59) ? null : h * 60 + mi;
  }
  // 在 baseTs 那一天上取 hh:mm 的绝对时间戳：只换时分，日期永远跟着原记录走
  function tsOnDay(baseTs, minutes) {
    const d = new Date(Number(baseTs) || Date.now());
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d.getTime();
  }
  // 改一段计时的首尾时间（编辑页计时视图 / 详情页共用同一个弹窗）
  // onSave(startTs, endTs|null)：endTs 为 null = 这段还在跑，调用方不要动它的 end。
  function openSegTime(g, onSave) {
    if (!g) return;
    const live = g.end == null;
    const stI = U().el('input', { class: 'input', type: 'time', step: '60' });
    stI.value = hmLabel(g.start);
    const enI = U().el('input', { class: 'input', type: 'time', step: '60' });
    enI.value = live ? '' : hmLabel(g.end);
    if (live) enI.disabled = true;
    const dimStyle = { color: 'var(--text-dim)', fontSize: 'calc(var(--font-scale, 1) * 12.5px)', lineHeight: '1.6' };
    const err = U().el('div', {
      style: {
        color: 'var(--danger)', fontSize: 'calc(var(--font-scale, 1) * 12.5px)',
        lineHeight: '1.6', minHeight: 'calc(var(--font-scale, 1) * 20px)',
      },
    });
    const body = U().el('div', {},
      U().el('div', { class: 'field' }, U().el('label', { text: '开始' }), stI),
      U().el('div', { class: 'field' }, U().el('label', { text: '结束' }), enI),
      U().el('div', { style: dimStyle, text: live ? '正在计时：结束时间由计时器收口，先只调整开始。' : '保存后这一段时长与总用时自动重算。' }),
      err);

    function submit(close) {
      const sm = parseHM(stI.value);
      if (sm == null) { err.textContent = '开始时间请填 HH:MM'; return; }
      const em = live ? null : parseHM(enI.value);
      if (!live && em == null) { err.textContent = '结束时间请填 HH:MM'; return; }
      const start = tsOnDay(g.start, sm);
      let end = (em == null) ? null : tsOnDay(g.start, em);
      if (end != null && end <= start) end += 86400000;      // 跨午夜：结束算第二天（与 segSec 的绝对时间口径一致）
      const now = Date.now();
      if (start > now) { err.textContent = '开始时间不能晚于现在'; return; }
      if (end != null && end > now) { err.textContent = '结束时间不能晚于现在'; return; }
      if (Math.round(((end == null ? now : end) - start) / 1000) > SEG_MAX_SEC) { err.textContent = '单段计时不能超过 8 小时'; return; }
      close();
      onSave(start, end);
    }

    U().modal({
      title: '修改计时',
      body,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: '保存', primary: true, onClick: (c) => submit(c) },
      ],
    });
    setTimeout(() => { try { stI.focus(); } catch (_) {} }, 80);
  }

  // —— 编辑器（含自定义属性动态字段）——
  function openEditor(recId, opts) {
    const domain = App.state.currentDomain();
    // curId 是这条笔记「现在的」id：新建时为空，点计时（或保存）时才真正落库。
    // 之后所有写库动作都认它，绝不能再从 recId 形参取 —— 那个值永远是打开时的快照。
    // 注意：这里【不再】收掉计时小窗 —— 它是全局常驻的，编辑页里也要能看见（z-index 55 > page-sheet 50）
    let curId = recId || null;
    let existingRec = recId ? App.state.data.records.find((r) => r.id === recId) : null;
    let imageIds = existingRec ? (existingRec.imageIds || []).slice() : [];
    let selectedTags = existingRec ? (existingRec.tagIds || []).slice() : [];
    let customValues = existingRec ? Object.assign({}, existingRec.customValues) : {};
    // 本次新建 / 编辑期间新写进相册的图片 id（取消或关闭时按它清相册）
    const sessionAdded = [];
    // 已有记录里被移除、但还没保存的图片 id（保存时才真正删相册原图，取消则恢复原状）
    const pendingRemove = [];
    let categoryId = existingRec ? existingRec.categoryId : (domain.categories[0] ? domain.categories[0].id : null);

    // —— 三视图状态 ——
    // 必须在这里提前声明：renderPreview / showDock 在「视图搭好之前」就会被调用
    // （renderPreview 在图片逻辑初始化时先跑一次），这时读 tabBtns 不能报错。
    let curView = 1;                                  // 0=图片 1=正文 2=步骤·计时
    const tabBtns = [];
    // 步骤是本篇笔记的一份副本，保存时整份写回；旧记录没有 steps 时补成空数组
    let steps = [];
    if (existingRec && Array.isArray(existingRec.steps)) {
      steps = JSON.parse(JSON.stringify(existingRec.steps));
      normalizeSteps({ steps: steps });
    }
    // 编辑页里挂到 window / document 上的监听，关页面时统一拆掉（开关多次不累积）
    const teardown = [];

    const titleI = U().el('input', { class: 'input', placeholder: '标题', value: existingRec ? existingRec.title : '' });
    const catSel = U().makeSelect(domain.categories.map((c) => [c.id, c.name]), categoryId, (v) => { categoryId = v; });
    catSel.classList.add('full');
    const catPlus = U().el('button', { class: 'icon-btn', html: U().icon('plusCircle', 18), title: '新建分类' });
    catPlus.addEventListener('click', () => U().quickAddCategory(domain, (item) => { App.db.saveDomain(domain); catSel.setOptions(domain.categories.map((c) => [c.id, c.name]), item.id); categoryId = item.id; if (App.app.refreshChrome) App.app.refreshChrome(); }));
    const catWrap = U().el('div', { class: 'row', style: { gap: '8px' } }, catSel, catPlus);
    // textarea 的 value 不能用 setAttribute 设置（对 textarea 无效），必须在创建后赋 .value，否则编辑时文字不回显
    // —— 即时 Markdown 模式下它只承载「当前正在编辑的那一块」，整篇文字在 mdText 里
    const descI = U().el('textarea', { class: 'textarea', placeholder: '写点什么…' });
    descI.value = '';
    let descTouched = false;

    // ===== 即时 Markdown：真源 + 块视图 =====
    // mdText 永远是整篇字符串；docBlocks 只是 splitDoc(mdText) 的结果；
    // activeK = 当前正在编辑的块下标（-1 表示没有块处于源码态）。
    // 唯一的 textarea（descI）会在块之间「搬家」—— 只换父亲，绝不重建，所以
    // input/keydown/撤销/字数那些监听一辈子只绑一次。
    let mdText = existingRec ? (existingRec.description || '') : '';
    let docBlocks = splitDoc(mdText);
    let activeK = -1;
    let edMode = (opts && opts.mode) || editorMode || 'blocks';
    const docEl = U().el('div', { class: 'ed-doc md-body' });
    // 键盘跟随的钩子：真正实现在页面末尾的 bindKeyboard 里。
    // 这里先占位 —— input / 回车这些回调在它之前就已经绑好了。
    let kbTick = function () {};
    // 字数胶囊：一枚极小、浮在排版栏【外面】上沿之上的胶囊（不占那 29px，也不参与按钮横滑）。
    // pointer-events:none：点它不会把焦点从输入框抢走，也不会挡住底部的最后一行。
    const countPill = U().el('span', { class: 'count-pill float', text: '0字' });
    // 容器里「要么是 descI，要么是 docEl」，永远只挂一个（不用 display:none 藏着另一套）
    const descWrap = U().el('div', { class: 'ed-desc-wrap' });
    activeDescI = descI;
    activeCountPill = countPill;
    activeDocText = () => docText();
    paintCountPill();   // 先同步画一次：打开编辑页的第一帧就该是真实字数，不能闪一下「0字」

    // —— 底部工具条的外壳（29px，一行）——
    // 这一行常态放「视图胶囊」，正文聚焦时整条换成 Markdown 排版栏（.is-open）——
    // 两套内容绝对叠在同一格里，高度永远 29px，所以换内容不会让 .page-sheet-body 变高变矮。
    // （原来是「29px 空白占位 + 卡片底部悬浮一颗 38px 胶囊」，底部白白空一条还得压住正文。）
    const dockPill = U().el('div', { class: 'ed-dock-pill' });   // 胶囊的停车位，2455 之后填内容
    const dockTools = U().el('div', { class: 'ed-dock-tools' });
    const dock = U().el('div', { class: 'ed-dock' }, dockPill, dockTools, countPill);
    let dockHideTimer = 0;
    // 「正在打字」状态：写在 .page-sheet 上，正文聚焦时让底部胶囊淡出。
    // 只用 opacity/visibility 切换 —— 让位用的 padding 常驻，布局不变就不会触发重排滚动。
    function setEditing(on) {
      const sh = descI.closest('.page-sheet');
      if (sh) sh.classList.toggle('editing', !!on);
    }
    function showDock() {
      if (curView !== 1) return;                 // 只有正文视图允许弹出排版栏
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = 0; }
      dock.classList.add('is-open');
      setEditing(true);
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
        setEditing(false);
        closeHMenu();                              // 菜单比栏先走一步，别孤零零留在屏幕上
      }, 180);
    }
    // 鼠标点按钮时把焦点留在输入框（键盘不收）；触屏走 bindTool 的 touchend。
    try { dock.addEventListener('mousedown', (e) => { if (e.target) e.preventDefault(); }, false); } catch (_) {}
    descI.addEventListener('focus', showDock);
    descI.addEventListener('blur', hideDockSoon);

    // ===== 块模式：点哪块就把源码框搬到哪块 =====
    // 用 touchstart/mousedown 而不是 click：它们先于 blur 到达，能赶在「旧块失焦」之前完成搬家，
    // 避免「先提交重绘 → 点击目标已被替换 → 这一下白点」的经典竞态。
    function blockIndexFrom(target) {
      let n = target;
      while (n && n !== docEl) {
        if (n.getAttribute && n.getAttribute('data-k') != null) return Number(n.getAttribute('data-k'));
        n = n.parentNode;
      }
      return -1;
    }
    function onDocPress(e) {
      if (edMode !== 'blocks' || !e.target || e.target === descI) return;
      const k = blockIndexFrom(e.target);
      if (k < 0 || !docBlocks[k]) return;
      // 空行块点一下就变成「可编辑的空段落」——否则一段被清空之后就再也点不进去了
      if (docBlocks[k].kind === 'blank') {
        docBlocks[k].kind = 'p';
        const el = docEl.children[k];
        if (el) { el.className = 'ed-block md-body'; el.style.height = ''; el.innerHTML = ''; }
      }
      const el = docEl.children[k];
      const r = el ? el.getBoundingClientRect() : null;
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      const where = (r && y != null && y > r.top + r.height / 2) ? 'end' : 'start';
      openBlock(k, where);
    }
    docEl.addEventListener('touchstart', onDocPress, { passive: true });
    docEl.addEventListener('mousedown', onDocPress);
    // 失焦后延迟 200ms 再决定要不要提交：
    //  · 焦点落到排版栏 / 输入框 → 用户还在编辑，别提交（否则工具按钮会对着已重绘的节点干活）
    //  · 焦点落到别处 → 提交并还原成渲染态
    let blurCommitTimer = 0;
    descI.addEventListener('blur', () => {
      clearTimeout(blurCommitTimer);
      blurCommitTimer = setTimeout(() => {
        blurCommitTimer = 0;
        if (edMode !== 'blocks' || activeK < 0) return;
        if (document.activeElement === descI) return;
        if (dock.classList.contains('is-open')) return;      // 排版栏还开着 = 还在编辑
        commitActive();
      }, 200);
    });
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
      const box = descI.closest('.ed-scroll');
      if (!box) return;
      const target = Math.min(st, Math.max(0, box.scrollHeight - box.clientHeight));
      if (box.scrollTop < target - 8) box.scrollTop = target;
      // 部分 WebView 把"复位"排到下一帧，再补一次
      // 用 setTimeout 而不是 rAF：rAF 在页面不可见/被系统暂停时不回调，补钉会永远丢掉
      setTimeout(() => {
        if (document.activeElement !== descI) return;
        const t2 = Math.min(st, Math.max(0, box.scrollHeight - box.clientHeight));
        if (box.scrollTop < t2 - 8) box.scrollTop = t2;
      }, 16);
    }
    // 正文滚动区「能分给输入框的高度」。
    // 不能直接量 descI.parentNode.clientHeight：一旦输入框已经被写成内容高，
    // 那个高度就是「内容高」而不是「可用高」，量出来永远自洽。
    // 只有滚动容器自己的可视高是稳定的（它不会因为内容变高而变高）。
    function availHeight() {
      const box = descI.closest('.ed-scroll');
      if (!box) return 0;
      const cs = getComputedStyle(box);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const wrap = descWrap;   // 不能用 descI.parentNode：块模式下它的父亲是 .ed-block（margin 为 0）
      let mt = 0;
      if (wrap) { const ws = getComputedStyle(wrap); mt = parseFloat(ws.marginTop) || 0; }
      return Math.max(0, box.clientHeight - pad - mt);
    }
    function growDesc(force) {
      // 块模式：高度只由「这一块」的内容决定，外层 .ed-scroll 负责滚动。
      // 不存在「撑满可用高」这回事，所以这里只需要把高度同步成内容高（同帧量完写回，不产生跳动）。
      if (edMode === 'blocks') {
        if (!descI.isConnected) return;
        const box = descI.closest('.ed-scroll');
        const st = box ? box.scrollTop : 0;
        const frame = Math.max(0, descI.offsetHeight - descI.clientHeight);
        descI.style.height = '0px';
        const h = descI.scrollHeight;
        descI.style.height = h ? (h + frame) + 'px' : '';
        pinScroll(st);
        return;
      }
      const box = descI.closest('.ed-scroll');
      const st = box ? box.scrollTop : 0;
      // box-sizing 是 border-box：把边框补回来，否则最后一行会被那 1px 细线压掉
      const frame = Math.max(0, descI.offsetHeight - descI.clientHeight);
      if (!force) {
        // 固定高度下 scrollHeight 依然返回内容总高，所以不塌缩也能量准。
        // 撑满态下 scrollHeight 恒 >= clientHeight，所以空笔记走到这里直接 return，
        // 不写行内高、不碰滚动 —— 这正是「打字不跳页」依赖的那条路径。
        const want = descI.scrollHeight + frame;
        if (want <= descI.offsetHeight + 1) return;   // 只涨不缩：变矮交给 settleDesc
        descI.style.height = want + 'px';
        pinScroll(st);
        return;
      }
      // 唯一允许塌缩的路径：打开页面 / 停手后，同一帧内塌缩→量→写回→钉滚动。
      // 撑满布局下不能只写 height='auto' 再读 scrollHeight：flex-grow 会先把框拉到可用高，
      // scrollHeight 就等于 clientHeight，永远量不到真实内容高（空笔记会一直撑满、长文会被裁）。
      // 所以先量稳定的可用高，再临时关掉 grow、高度归零量内容高，最后二选一。
      const avail = availHeight();
      descI.style.flexGrow = '0';
      descI.style.height = '0px';
      const h = descI.scrollHeight;
      descI.style.flexGrow = '';
      if (!h || !isFinite(h)) { descI.style.height = ''; return; }  // 尚未完成排版：交回 CSS
      // 内容比可用高矮 → 清掉行内高，让 flex 撑满；更高 → 写死内容高，由 .ed-scroll 滚动
      descI.style.height = (h + frame > avail) ? (h + frame) + 'px' : '';
      pinScroll(st);
    }
    // 停手 400ms 后再收敛一次：这样删掉大段文字时输入框会变矮，但打字过程中永远不会塌缩
    function settleDesc() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { settleTimer = 0; growDesc(true); }, 400);
    }

    // ===== 即时 Markdown：块视图 =====
    // 真源是 mdText（整篇字符串），docBlocks 是它的视图，activeK 是唯一处于源码态的块。
    // 一条铁律：按键路径【绝不重绘】—— 用户正在打的那块本来就是源码，所见即所得。
    // 只有「换块 / 失焦 / 切视图 / 切模式 / 保存」这五处才重绘，并且都带滚动锚点补偿。
    function docText() {
      if (edMode !== 'blocks') return descI.value;
      if (activeK < 0 || activeK >= docBlocks.length) return mdText;
      return docBlocks.map((b, i) => (i === activeK ? descI.value : b.text)).join('\n');
    }
    function renderDoc(anchor) {
      const box = descWrap.closest('.ed-scroll');
      const st = (anchor && anchor.st != null) ? anchor.st : (box ? box.scrollTop : 0);
      const top0 = anchor ? (anchor.top || 0) : 0;
      if (descI.parentNode) descI.parentNode.removeChild(descI);   // 唯一实例先摘出来，重绘要保住它
      U().clear(docEl);
      docBlocks.forEach((b, i) => {
        const el = U().el('div', {
          class: 'ed-block' + (b.kind === 'blank' ? ' is-gap' : ' md-body'),
          'data-k': String(i), 'data-kind': b.kind,
        });
        if (b.kind === 'blank') el.style.height = 'calc(1.78em * ' + Math.max(1, b.text.split('\n').length) + ')';
        else el.innerHTML = blockHtml(b);
        docEl.appendChild(el);
      });
      // 空文档：给一个能点的占位（点它就开始写第一段）
      if (!mdText.trim()) {
        const ph = U().el('div', { class: 'ed-md-empty', text: '写点什么…' });
        ph.addEventListener('click', () => openBlock(0));
        docEl.appendChild(ph);
      }
      if (!box) return;
      if (anchor && anchor.k >= 0 && docEl.children[anchor.k]) {
        // 锚点补偿：块重绘后高度可能变了一点，把「原来那一块在视口里的位置」钉回去
        const el2 = docEl.children[anchor.k];
        box.scrollTop = Math.max(0, st + (el2.offsetTop - top0));
      } else box.scrollTop = st;
    }
    // where: 'end'（默认）| 'start'
    function openBlock(k, where) {
      if (edMode !== 'blocks') return;
      if (k < 0) k = 0;
      if (k >= docBlocks.length) { docBlocks.push({ kind: 'p', text: '' }); k = docBlocks.length - 1; renderDoc(); }
      if (activeK === k) {
        setTimeout(() => { try { descI.focus({ preventScroll: true }); } catch (_) {} }, 0);
        return;
      }
      if (activeK >= 0) commitActive();          // 先把上一块写回（内部会重绘一次）
      if (k >= docBlocks.length) k = docBlocks.length - 1;
      const el = docEl.children[k];
      if (!el) return;
      const ph = docEl.querySelector('.ed-md-empty');
      if (ph) ph.remove();
      activeK = k;
      descI.value = docBlocks[k].text;
      el.classList.add('is-editing');
      el.appendChild(descI);                     // 搬家（只换父亲，绝不重建）
      descI.style.height = '0px';
      growDesc();
      setTimeout(() => {
        if (activeK !== k || !descI.isConnected) return;
        try { descI.focus({ preventScroll: true }); } catch (_) { try { descI.focus(); } catch (__) {} }
        const pos = where === 'start' ? 0 : descI.value.length;
        try { descI.setSelectionRange(pos, pos); } catch (_) {}
        showDock(); paintCountPill();
      }, 0);
    }
    function commitActive() {
      if (edMode !== 'blocks' || activeK < 0) return;
      const k = activeK;
      const el = docEl.children[k];
      const box = descWrap.closest('.ed-scroll');
      const anchor = { k: k, top: el ? el.offsetTop : 0, st: box ? box.scrollTop : 0 };
      const txt = descI.value;
      const parts = docBlocks.map((b, i) => (i === k ? txt : b.text));
      mdText = parts.join('\n');
      docBlocks = splitDoc(mdText);
      descTouched = true;
      activeK = -1;
      if (descI.parentNode) descI.parentNode.removeChild(descI);
      if (el) el.classList.remove('is-editing');
      renderDoc(anchor);
      histPushNow();
      scheduleCountPill();
    }
    // 把两种模式挂上去（初始与切换都走这里）。容器里永远只有一个孩子：
    // 源码模式是 descI，块模式是 docEl —— 不用 display:none 藏另一套。
    function applyMode(next) {
      edMode = next === 'source' ? 'source' : 'blocks';
      descWrap.setAttribute('data-mode', edMode);
      if (descI.parentNode) descI.parentNode.removeChild(descI);
      if (docEl.parentNode) docEl.parentNode.removeChild(docEl);
      if (edMode === 'source') {
        descI.className = 'ed-desc';
        descI.style.height = '';
        descI.value = mdText;
        descWrap.appendChild(descI);
      } else {
        descI.className = 'blk-src';
        activeK = -1;
        docBlocks = splitDoc(mdText);
        descWrap.appendChild(docEl);
        renderDoc();
      }
      paintModeBtn();
      scheduleCountPill();
    }
    let switching = false;
    function setMode(next) {
      const want = next === 'source' ? 'source' : 'blocks';
      if (switching || want === edMode) return;
      switching = true;
      try {
        if (edMode === 'blocks') commitActive();      // 块 → mdText
        else { mdText = descI.value; descTouched = descTouched || false; }
        applyMode(want);
        if (want === 'source') setTimeout(() => { try { growDesc(true); } catch (_) {} }, 0);
      } finally { setTimeout(() => { switching = false; }, 0); }
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
      // 块模式的快照是【整篇】，否则「删掉一整个块」这种操作撤不回来
      const v = docText();
      hist.st = [{ v: v, s: descI.value.length, e: descI.value.length, k: activeK }];
      hist.idx = 0;
      histSync();
    }
    function histPushNow() {
      const v = edMode === 'blocks' ? docText() : descI.value;
      const s = descI.selectionStart == null ? descI.value.length : descI.selectionStart;
      const e = descI.selectionEnd == null ? descI.value.length : descI.selectionEnd;
      const cur = hist.st[hist.idx];
      if (cur && cur.v === v) { cur.s = s; cur.e = e; cur.k = activeK; return; }
      hist.st = hist.st.slice(0, hist.idx + 1);
      hist.st.push({ v: v, s: s, e: e, k: activeK });
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
      if (edMode === 'blocks') {
        // 整篇回放：重扫块，再把光标放回原来那一块（块序号可能因为拆/合变了，钳一下）
        mdText = it.v;
        docBlocks = splitDoc(mdText);
        activeK = -1;
        if (descI.parentNode) descI.parentNode.removeChild(descI);
        renderDoc();
        descTouched = true;
        if (it.k >= 0) openBlock(Math.min(it.k, docBlocks.length - 1), 'start');
        scheduleCountPill(); histSync();
        return;
      }
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
    // 模式切换：即时 Markdown ⇄ 源码（逃生门）。两个入口同一个函数：
    //   · 排版栏末尾（聚焦时看得见）
    //   · 底部胶囊右侧那颗小按钮（没聚焦时也能切）
    const modeBtns = [];
    function paintModeBtn() {
      modeBtns.forEach((b) => {
        const toSource = edMode === 'blocks';
        b.innerHTML = U().icon(toSource ? 'mdCode' : 'eye', 16);
        b.title = toSource ? '切到源码' : '切回即时排版';
        b.setAttribute('aria-label', b.title);
      });
    }
    function makeModeBtn(cls) {
      const b = U().el('button', { class: cls, type: 'button' });
      b.addEventListener('click', (e) => { e.stopPropagation(); setMode(edMode === 'blocks' ? 'source' : 'blocks'); });
      modeBtns.push(b);
      return b;
    }
    dockTools.appendChild(U().el('span', { class: 'ed-tool-sep' }));
    dockTools.appendChild(makeModeBtn('ed-tool'));
    // 菜单必须挂在 .ed-dock 上（不能进 .ed-dock-tools —— 那里的 overflow-x:auto 会把它裁掉）
    dock.appendChild(hMenu);
    histSeed();
    // 中文输入法：候选词上屏途中不要往撤销栈里塞半成品
    descI.addEventListener('compositionstart', () => { hist.lock = true; });
    descI.addEventListener('compositionend', () => { hist.lock = false; histPush(); });

    const timeI = U().el('input', { class: 'input', type: 'number', min: '0', placeholder: '分钟', value: existingRec ? (existingRec.timeSpentMin || '') : '' });
    const incI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existingRec ? (existingRec.income || '') : '' });
    const expI = U().el('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', value: existingRec ? (existingRec.expense || '') : '' });
    let recDate = existingRec ? existingRec.date : Date.now();
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
    // 图片区：单列满宽、按原图比例上下排列（不再是 2 列方形缩略图）。
    // 高度全部由 JS 写死在格子上（layoutCell），img 只负责填满它，所以：
    //   ① 图片没加载完也有稳定高度，不会「加载一张跳一下」；
    //   ② 超高图（长截图）能在这里直接封顶，交给 CSS 裁掉下半截 + 渐隐提示。
    const mediaBox = U().el('div', { class: 'media-grid' });
    const MEDIA_AR_DEFAULT = 0.75;               // 加载前先按 3:4 竖图占位
    // 单张图的高度上限 = 图片视图的「一屏可视高度」。
    // 不用 80vh：卡片比视口矮（顶栏 + 上下留边），按 80vh 算会把 2:3 这类普通竖图
    // 也白白裁掉二十几像素；按可视区算才是「最多占满一屏，超过才裁」。
    function mediaCap() {
      const box = (mediaBox.closest && mediaBox.closest('.ed-scroll')) || null;
      const vis = box ? box.clientHeight : 0;
      if (vis > 160) return vis - 8;             // 留 8px 让下一张露一点，看得出还能往下滚
      return Math.round((window.innerHeight || 640) * 0.8);
    }
    function layoutCell(cell) {
      const w = mediaBox.clientWidth || 0;
      if (!w) return;                            // 还没挂载，等 paintMediaSizes 补
      const ar = Number(cell.getAttribute('data-ar')) || MEDIA_AR_DEFAULT;   // 宽 / 高
      const cap = mediaCap();
      const full = Math.round(w / ar);
      const h = Math.min(full, cap);
      cell.style.height = h + 'px';
      // 只有「缩到满宽后比 80% 屏高还高」的图才裁切 + 提示看全图
      cell.classList.toggle('is-capped', h < full - 1);
    }
    function paintMediaSizes() {
      const cells = mediaBox.querySelectorAll('.mg-item');
      for (let i = 0; i < cells.length; i++) layoutCell(cells[i]);
    }
    // 满宽原图解码后一张能到 40MB+（4000×3000），十来张就把 webview 撑爆。
    // 只给可视区上下 1.5 屏内的格子挂 src，离屏立刻摘掉 ——
    // 高度已经被 layoutCell 写死，所以摘图不会引起任何跳动。
    let mediaIO = null;
    function ensureMediaIO() {
      if (mediaIO || typeof IntersectionObserver !== 'function') return;
      mediaIO = new IntersectionObserver((rows) => {
        for (let i = 0; i < rows.length; i++) {
          const cell = rows[i].target;
          if (rows[i].isIntersecting) { if (cell._fill) cell._fill(); }
          else if (cell._drop) cell._drop();
        }
      }, { root: imgScroll, rootMargin: '150% 0px' });
    }
    // renderPreview 是图片区的唯一重绘入口，顺手把「图片」标签上的数量角标同步掉
    function renderPreview() { renderPreviewInner(); try { syncTabs(); } catch (_) {} }
    function renderPreviewInner() {
      U().clear(mediaBox);
      if (!imageIds.length) {
        mediaBox.classList.add('empty');
        const drop = U().el('div', { class: 'media-drop' }, U().el('div', { class: 'md-icon', text: '🖼️' }), U().el('div', { class: 'md-text', text: '点击添加图片' }));
        drop.addEventListener('click', () => pickImages());
        mediaBox.appendChild(drop);
        return;
      }
      mediaBox.classList.remove('empty');
      const io = mediaIO;
      imageIds.forEach((id, idx) => {
        const cell = U().el('div', { class: 'mg-item' });
        cell.setAttribute('data-ar', String(MEDIA_AR_DEFAULT));
        const im = U().el('img', { decoding: 'async', alt: '', draggable: 'false' });
        // 懒挂：进可视区才真正设 src；第一次渲染（IO 还没建）就立刻加载前几张，
        // 保证打开编辑页马上能看到图，而不是等一个 IO 回调。
        let loaded = false;
        const load = () => {
          if (loaded || im.getAttribute('src')) return;
          loaded = true;
          fillCover(im, id);
        };
        cell._fill = load;
        cell._drop = () => { if (im.getAttribute('src')) im.removeAttribute('src'); };
        if (io) io.observe(cell); else if (idx < 3) load();
        // 图解码出来才知道真实比例：写上 data-ar 再重排这一格（只纠正一次）
        im.addEventListener('load', () => {
          if (!im.naturalWidth || !im.naturalHeight) return;
          cell.setAttribute('data-ar', String(im.naturalWidth / im.naturalHeight));
          layoutCell(cell);
        });
        // 点图片 = 看大图（在编辑器里就能确认这张图有没有拍糊、裁没裁到）
        cell.addEventListener('click', () => openPreview(id));

        // 控件全部收进顶部一行：满宽图可能有两千多像素高，
        // 原来贴在格子底角的按钮会直接滚出屏幕、根本点不到。
        const bar = U().el('div', { class: 'mg-bar' });
        const idxTag = U().el('div', { class: 'mg-idx', text: String(idx + 1) });   // 顺序 = imageIds 顺序，第 1 张是封面
        const grip = U().el('div', { class: 'mg-grip', html: U().icon('sort', 13), title: '调整顺序' });
        grip.addEventListener('click', (e) => { e.stopPropagation(); openImgMenu(id); });
        const rm = U().el('div', { class: 'rm', text: '×' });
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeImg(id); });
        bar.appendChild(idxTag); bar.appendChild(grip); bar.appendChild(rm);

        // 超高图底部渐隐 + 一句提示（纯装饰，pointer-events:none，不拦手势；点整格才是开大图）
        const fade = U().el('div', { class: 'mg-fade' });
        const more = U().el('span', { class: 'mg-more', text: '点击看全图' });

        cell.appendChild(im); cell.appendChild(fade); cell.appendChild(more); cell.appendChild(bar);
        mediaBox.appendChild(cell);
        layoutCell(cell);
      });
      const add = U().el('div', { class: 'mg-add', html: U().icon('plus', 22) + '<span>添加图片</span>' });
      add.addEventListener('click', () => pickImages());
      mediaBox.appendChild(add);
    }

    // 移除一张图（原来的「×」逻辑抽出来，菜单里的「删除」共用同一套语义）
    async function removeImg(id) {
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
    }

    function moveImg(from, to) {
      if (to < 0 || to >= imageIds.length || from === to) return;
      const arr = imageIds.slice();
      const one = arr.splice(from, 1)[0];
      arr.splice(to, 0, one);
      imageIds = arr;
      renderPreview();
    }

    // 图片顺序菜单：前移 / 后移 / 删除。只改 imageIds 数组，保存时整份写回。
    function openImgMenu(id) {
      const at = imageIds.indexOf(id);
      if (at < 0) return;
      const list = U().el('div', { class: 'col', style: { gap: '2px' } });
      const dlg = U().modal({ title: '第 ' + (at + 1) + ' 张 · 共 ' + imageIds.length + ' 张', body: list, center: true });
      const row = (label, disabled, fn) => {
        const b = U().el('button', { class: 'ed-hmenu-item', type: 'button' },
          U().el('span', { class: 'ed-hmenu-t', text: label }));
        if (disabled) { b.disabled = true; b.classList.add('is-off'); }
        else b.addEventListener('click', () => { dlg.close(); fn(); });
        list.appendChild(b);
      };
      row('前移一位', at === 0, () => moveImg(at, at - 1));
      row('后移一位', at === imageIds.length - 1, () => moveImg(at, at + 1));
      row('删除这张', false, () => removeImg(id));
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
    // 正文按当前模式挂上去：块模式 = 渲染层（.ed-doc），源码模式 = 整篇 textarea（老行为）
    applyMode(edMode);
    // 投入分钟：右侧灰字实时回显「= X 小时 Y 分」——121 分钟这种数一眼没概念，
    // 但不做「1h1min」字符串解析（手机键盘敲字母麻烦、容错分支多、收益低）。
    // 用户一改就算「手填」，之后计时汇总不再覆盖它；清空 = 交还给计时汇总。
    const timeHint = U().el('span', { class: 'muted ed-time-hint' });
    const timeRow = U().el('div', { class: 'row wrap', style: { gap: '8px' } }, dateBtn, U().el('div', { class: 'ed-inline' }, timeI, U().el('span', { class: 'muted', text: '分钟' }), timeHint));
    let timeManual = !!(existingRec && existingRec.timeSpentMinManual);
    let timeTouched = false;
    function paintTimeHint() {
      const raw = String(timeI.value == null ? '' : timeI.value).trim();
      const m = Number(raw);
      timeHint.textContent = (raw !== '' && m > 0) ? ('= ' + U().fmtDuration(m)) : '';
    }
    timeI.addEventListener('input', () => {
      timeTouched = true;
      timeManual = String(timeI.value || '').trim() !== '';
      paintTimeHint();
    });
    paintTimeHint();
    const moneyRow = U().el('div', { class: 'row', style: { gap: '10px' } }, U().el('div', { class: 'ed-inline' }, U().el('span', { class: 'muted', text: '收入 ¥' }), incI), U().el('div', { class: 'ed-inline' }, U().el('span', { class: 'muted', text: '支出 ¥' }), expI));

    // —— 横向三视图：图片 / 正文 / 步骤·计时 ——
    // 三张卡常驻 DOM，只靠 transform 移动 —— 这是「切视图不丢输入 / 滚动 / 计时」的实现基础。
    // 千万别改成 display 切换或重建：那会丢滚动位置、丢光标、把正在跑的计时打断。
    const ED_GAP = 4;
    const viewsEl = U().el('div', { class: 'ed-views' });
    const trackEl = U().el('div', { class: 'ed-track' });
    const slots = [], cards = [];
    for (let vi = 0; vi < 3; vi++) {
      const slot = U().el('div', { class: 'ed-slot' });
      slot.setAttribute('data-view', String(vi));
      const card = U().el('div', { class: 'ed-card' });
      slots.push(slot); cards.push(card);
      slot.appendChild(card); trackEl.appendChild(slot);
    }
    viewsEl.appendChild(trackEl);

    // ① 图片视图
    const imgScroll = U().el('div', { class: 'ed-scroll' },
      U().el('div', { class: 'ed-media' }, mediaBox, fileInput));
    cards[0].appendChild(imgScroll);

    // ② 正文视图：标题固定在卡片顶部，正文自己滚动（谁都不挤占谁）。
    // 这里曾经还有一行「待办 1/3 · 总用时 25 分 →」的折叠摘要，和底部胶囊第三个标签
    // 干的是同一件事（都跳到待办视图），纯重复 —— 20261117a 删掉，标题下面直接是正文。
    const textHead = U().el('div', { class: 'ed-text-head' }, titleI);
    const textScroll = U().el('div', { class: 'ed-scroll' }, descWrap);
    textScroll.setAttribute('data-ed-scroll', '1');   // 给 4 处 closest('.ed-scroll') 加个保险标记
    cards[1].classList.add('ed-card--text');
    cards[1].appendChild(textHead); cards[1].appendChild(textScroll);

    // ③ 步骤与计时视图
    const stepsScroll = U().el('div', { class: 'ed-scroll' });
    cards[2].appendChild(stepsScroll);

    // 元数据（分类 / 标签 / 时间 / 金额 / 自定义属性）不再常驻正文滚动流，改由顶部「⋯」抽屉承载。
    // 这里先放在隐藏的「停车位」里保活 —— 控件实例不重建，所以「改了即时写进闭包变量、
    // 保存时统一组装」的老逻辑一行都不用改。抽屉打开时把子节点整体搬过去，关掉再搬回来。
    const metaPark = U().el('div', { class: 'ed-meta-park hidden' },
      field('分类', catWrap),
      field('标签', tagSection),
      field('时间', timeRow),
      field('金额', moneyRow),
      (domain.customFields && domain.customFields.length) ? field('自定义属性', cfWrap) : null);

    function pitchPx() { return (slots[0].offsetWidth || 0) + ED_GAP; }
    // 景深：当前卡 1.0，邻卡缩到 0.97 / 透明度 0.8；拖到一半时按距离连续插值
    function paintDepth(dx) {
      const p = pitchPx() || 1;
      const pos = curView - (dx || 0) / p;
      for (let i = 0; i < 3; i++) {
        const d = Math.min(1, Math.abs(i - pos));
        // 缩小要「朝远离屏幕中心的方向收」，原点钉在靠中心那条边上：
        // 居中缩放会让左右各内缩约 7px，正好吃掉 6px 的露边 → 静止在正文视图时
        // 两边邻卡完全看不见，"旁边还有卡片"这个提示就消失了。
        cards[i].style.transformOrigin = i < pos ? 'right center' : (i > pos ? 'left center' : '');
        cards[i].style.transform = d > 0.001 ? 'scale(' + (1 - d * 0.03).toFixed(3) + ')' : '';
        cards[i].style.opacity = d > 0.001 ? String((1 - d * 0.2).toFixed(2)) : '';
      }
    }
    // 位移一律换算成像素：百分比基准是「轨道自身宽度」，而一格是「槽宽 + 间距」，两者不等
    function railGo(i, animated, dx) {
      curView = Math.max(0, Math.min(2, i));
      if (animated) {
        trackEl.style.transition = 'transform .28s cubic-bezier(.22,.7,.28,1)';
      } else {
        // 不带动画时临时关过渡（对位不该有惯性），下一拍再把行内值清掉交还 CSS
        trackEl.style.transition = 'none';
        setTimeout(() => { if (trackEl.isConnected) trackEl.style.transition = ''; }, 0);
      }
      trackEl.style.transform = 'translate3d(' + (-curView * pitchPx() + (dx || 0)) + 'px,0,0)';
      paintDepth(dx || 0);
      syncTabs();
    }
    function syncTabs() {
      if (!tabBtns.length) return;                    // 视图还没搭好（早期的 renderPreview）
      tabBtns.forEach((b, i) => b.classList.toggle('on', i === curView));
      const n0 = tabBtns[0].querySelector('.ed-tab-n');
      const n2 = tabBtns[2].querySelector('.ed-tab-n');
      if (n0) n0.textContent = imageIds.length ? String(imageIds.length) : '';
      if (n2) n2.textContent = steps.length ? (steps.filter((s) => s.done).length + '/' + steps.length) : '';
    }
    function goView(i, opts) {
      i = Math.max(0, Math.min(2, i));
      const force = !!(opts && opts.force);
      // 切走正文先收键盘：adjustResize 会把三张卡一起压扁，和位移动画叠在一起很乱
      // 顺便把「正在编辑的那一块」提交掉：切回来时它就该是渲染态，而不是又弹着源码框
      if (i !== 1) {
        if (edMode === 'blocks' && activeK >= 0) { try { commitActive(); } catch (_) {} }
        try { if (document.activeElement === descI) descI.blur(); } catch (_) {}
      }
      if (i === curView && !force) { syncTabs(); return; }
      railGo(i, true, 0);
      // 非正文视图不该挂着 Markdown 栏（29px 一条工具条吊在步骤列表下面很怪）
      if (i !== 1) { dock.classList.remove('is-open'); try { closeHMenu(); } catch (_) {} }
    }

    // —— 左右滑动切换视图 ——
    // 用 touch 事件而不是 Pointer Events：5+ 里 pointercancel 常被滚动判定提前抢走，
    // 表现就是「划好几下才偶尔成功」（全局手势 app.js:327 已经踩过这个坑）。
    // 规矩同全局手势：touchstart 只记录、判定为横向之后才 preventDefault、
    // 一旦判成竖向就永久让路 —— 绝不跟正文滚动和选字抢。
    // 与 app.js 的全局横滑不冲突：overlayOpen() 把 .page-sheet 列进了禁用名单。
    const SW_START = 6, SW_COMMIT_PX = 56, SW_COMMIT_RATIO = 0.15, SW_VEL = 0.35, SW_FLICK_PX = 20;
    // textarea 故意不排除：正文视图 90% 面积都是它，排掉就滑不动了
    const NO_SWIPE = 'input,select,button,a,label,.ed-dock,.mg-bar,.media-drop,[data-noswipe]';
    let swipeG = null, swipeDrag = false, lastTouchAt = 0;

    function setCardAnim(on) {
      for (let i = 0; i < 3; i++) cards[i].style.transition = on ? '' : 'none';
    }
    function beginSwipe(target, x, y) {
      if (target && target.closest && target.closest(NO_SWIPE)) return;
      if (U().isImageViewerOpen && U().isImageViewerOpen()) return;
      swipeG = { x0: x, y0: y, lx: x, lt: Date.now(), t0: Date.now(), dx: 0, vx: 0, mode: 'pend' };
      swipeDrag = false;
    }
    function moveSwipe(x, y, ev) {
      if (!swipeG) return;
      const now = Date.now();
      const dt = Math.max(1, now - swipeG.lt);
      if (dt > 8) { swipeG.vx = (x - swipeG.lx) / dt; swipeG.lx = x; swipeG.lt = now; }
      const dx = x - swipeG.x0, dy = y - swipeG.y0;
      if (swipeG.mode === 'pend') {
        if (Math.abs(dx) < SW_START && Math.abs(dy) < SW_START) return;
        // 竖向明显占优 → 判为滚动，之后不再改判（反复横跳会让手势看起来「粘手」）
        if (Math.abs(dy) > Math.abs(dx) * 1.1) { swipeG.mode = 'v'; return; }
        swipeG.mode = 'h';
        setCardAnim(false);
        swipeDrag = true;
      }
      if (swipeG.mode !== 'h') return;
      swipeG.dx = dx;
      if (ev && ev.cancelable) ev.preventDefault();     // 只有确认横向才锁手势
      // 首个视图继续右滑 / 末个继续左滑：阻尼到 30%，明确「到头了」
      const d = ((curView === 0 && dx > 0) || (curView === 2 && dx < 0)) ? dx * 0.3 : dx;
      swipeG.drag = d;
      trackEl.style.transition = 'none';
      trackEl.style.transform = 'translate3d(' + (-curView * pitchPx() + d) + 'px,0,0)';
      paintDepth(d);
    }
    function endSwipe(cancelled) {
      const g = swipeG; swipeG = null;
      const wasDrag = swipeDrag; swipeDrag = false;
      setCardAnim(true);
      if (!g || g.mode !== 'h') { if (wasDrag) railGo(curView, true, 0); return; }
      const w = slots[0].offsetWidth || window.innerWidth || 320;
      const far = Math.abs(g.dx) > Math.min(SW_COMMIT_PX, w * SW_COMMIT_RATIO);
      const fast = Math.abs(g.vx || 0) > SW_VEL && Math.abs(g.dx) > SW_FLICK_PX;
      if (!cancelled && (far || fast)) goView(curView + (g.dx < 0 ? 1 : -1));
      else railGo(curView, true, 0);
    }

    const onTS = (e) => {
      lastTouchAt = Date.now();
      if (!e.touches || e.touches.length !== 1) { swipeG = null; return; }
      beginSwipe(e.target, e.touches[0].clientX, e.touches[0].clientY);
    };
    const onTM = (e) => {
      if (!swipeG) return;
      if (!e.touches || e.touches.length !== 1) { swipeG = null; return; }
      moveSwipe(e.touches[0].clientX, e.touches[0].clientY, e);
    };
    const onTE = () => endSwipe(false);
    const onTC = () => endSwipe(true);
    // 桌面浏览器预览用：鼠标拖拽走同一套状态机（真机上两者互斥，800ms 内不重复接管）
    const onMD = (e) => {
      if (e.button !== 0 || Date.now() - lastTouchAt < 800) return;
      if (e.target && e.target.closest && e.target.closest('textarea,input')) return;
      beginSwipe(e.target, e.clientX, e.clientY);
    };
    const onMM = (e) => { if (swipeG) moveSwipe(e.clientX, e.clientY, e); };
    const onMU = () => { if (swipeG) endSwipe(false); };

    viewsEl.addEventListener('touchstart', onTS, { passive: true });
    viewsEl.addEventListener('touchmove', onTM, { passive: false });
    viewsEl.addEventListener('touchend', onTE);
    viewsEl.addEventListener('touchcancel', onTC);
    viewsEl.addEventListener('mousedown', onMD);
    teardown.push(() => {
      viewsEl.removeEventListener('touchstart', onTS);
      viewsEl.removeEventListener('touchmove', onTM);
      viewsEl.removeEventListener('touchend', onTE);
      viewsEl.removeEventListener('touchcancel', onTC);
      viewsEl.removeEventListener('mousedown', onMD);
    });
    // 鼠标的 move/up 必须挂在 window 上：手指（鼠标）滑出卡片也照样跟手
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    teardown.push(() => {
      window.removeEventListener('mousemove', onMM);
      window.removeEventListener('mouseup', onMU);
    });

    // 视图切换胶囊：贴在页面最底部那一行（.ed-dock-pill）里，不再压在卡片上。
    // 三张卡常驻、只用 transform 位移，所以切视图不丢状态；胶囊只是「显式入口 + 数量角标」。
    // 为什么不放进轨道：轨道常驻 transform，放它里面会被一起平移。
    const tabPill = U().el('div', { class: 'ed-tabpill' });
    ['图片', '正文', '待办'].forEach((label, i) => {
      const b = U().el('button', { class: 'ed-tab', type: 'button' },
        U().el('span', { text: label }), U().el('span', { class: 'ed-tab-n' }));
      b.setAttribute('data-view', String(i));
      b.addEventListener('click', () => goView(i));
      tabBtns.push(b); tabPill.appendChild(b);
    });
    dockPill.appendChild(tabPill);
    // 「源码/即时」小按钮：放进胶囊右端（成为胶囊的一部分，不孤零零挂在屏幕边缘），
    // 没聚焦正文时也能切模式。
    const pillModeBtn = makeModeBtn('ed-pill-mode');
    tabPill.appendChild(pillModeBtn);
    paintModeBtn();      // 这颗按钮是后建的，这里补一次图标/标题
    // 「笔记信息」（分类/标签/时间/金额）搬去顶栏右侧：它不仅省掉一行，也和保存对勾同处拇指区
    const metaBtn = U().el('button', { class: 'icon-btn ed-meta', type: 'button', html: U().icon('more', 20), title: '笔记信息' });
    metaBtn.setAttribute('aria-label', '笔记信息');
    metaBtn.addEventListener('click', () => openMeta());

    let metaDlg = null;
    function openMeta() {
      if (metaDlg) return;
      const holder = U().el('div', { class: 'col', style: { gap: '14px' } });
      while (metaPark.firstChild) holder.appendChild(metaPark.firstChild);
      metaDlg = U().modal({
        title: '笔记信息',
        body: holder,
        actions: [{ label: '完成', primary: true }],
        onClose: () => {
          metaDlg = null;
          while (holder.firstChild) metaPark.appendChild(holder.firstChild);
        },
      });
    }

    // ================= ③ 步骤与分段计时 =================
    // 数据：steps[i].segs[j] = { id, start, end, note }；start/end 都是绝对时间戳，
    // 进行中的段 end === null。所有时长都由 App.records.segSec/stepSec 现算，不落库。
    function hhmm(ts) {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function stepById(id) { for (let i = 0; i < steps.length; i++) if (steps[i].id === id) return steps[i]; return null; }
    function stepsTotalSec() { return steps.reduce((a, s) => a + stepSec(s), 0); }

    // 每秒只改这些节点的 textContent，绝不重建 DOM（重建会把滚动位置和焦点一起打飞）
    let numBinders = [];
    function bindNum(el, fn) { numBinders.push({ el: el, fn: fn }); return el; }
    function paintNums() {
      for (let i = 0; i < numBinders.length; i++) {
        try { numBinders[i].el.textContent = U().fmtHMS(numBinders[i].fn()); } catch (_) {}
      }
    }

    const stepsSumEl = U().el('b', { class: 'steps-total' });
    const stepsDoneEl = U().el('span', { class: 'muted' });
    const addStepBtn = U().el('button', { class: 'icon-btn steps-add', type: 'button', html: U().icon('plus', 18), title: '新建待办' });
    addStepBtn.addEventListener('click', () => addStep());
    const stepsHead = U().el('div', { class: 'steps-head' },
      U().el('div', { class: 'steps-stat' }, U().el('span', { class: 'muted', text: '总用时' }), stepsSumEl),
      stepsDoneEl, addStepBtn);
    const stepsList = U().el('div', { class: 'steps-list' });
    stepsScroll.appendChild(stepsHead);
    stepsScroll.appendChild(stepsList);

    // 这里原来挂着「正文卡底部的计时悬浮条」：不显示备注、暂停/结束两个按钮从没绑过事件、
    // 占一整行还盖住正文，关掉编辑页就随 sheet 一起销毁 —— 20261117a 整条删除。
    // 编辑页想看时钟/暂停，去待办视图（每行都有实时读数 + 暂停）；详情页有可拖拽的计时小窗。


    // 步骤/计时一改就立刻落库（只碰 steps 与 timeSpentMin，不碰标题正文）。
    // 新笔记还没有 id，先留在内存里，等 doSave 一起写。
    function commitSteps() {
      if (!curId) return Promise.resolve();
      const copy = JSON.parse(JSON.stringify(steps));
      const manual = timeManual;
      return Promise.resolve(App.db.patchRecord(curId, (rec) => {
        // 内存副本里「进行中」的段（end=null）不能覆盖库里已经收口的那一段 —— 那会把时长抹掉。
        // （点暂停时 timer.stop() 先写库、再 reloadSteps()，中间这段时间差就是覆盖窗口。）
        const dbSeg = {};
        (rec.steps || []).forEach((s) => { (s.segs || []).forEach((g) => { dbSeg[g.id] = g; }); });
        copy.forEach((s) => {
          (s.segs || []).forEach((g) => {
            const d = dbSeg[g.id];
            if (d && d.end != null && g.end == null) g.end = d.end;
          });
        });
        const tmp = { steps: copy, timeSpentMinManual: manual, timeSpentMin: rec.timeSpentMin };
        syncTimeFromSteps(tmp, rec.timeSpentMin == null ? null : rec.timeSpentMin);
        return { steps: copy, timeSpentMin: tmp.timeSpentMin };
      })).catch(() => {});
    }

    // 计时器只认库里的数据，所以每次开始/结束之后把 steps 读回来（唯一真源）
    async function reloadSteps() {
      if (curId) {
        try {
          const rec = await App.db.getRecord(curId);
          if (rec && Array.isArray(rec.steps)) {
            steps = JSON.parse(JSON.stringify(rec.steps));
            normalizeSteps({ steps: steps });
          }
        } catch (_) {}
      }
      renderSteps(); syncTabs();
    }

    function paintStepsHead() {
      stepsSumEl.textContent = U().fmtDuration(Math.round(stepsTotalSec() / 60)) || '0 分';
      stepsDoneEl.textContent = '完成 ' + steps.filter((s) => s.done).length + '/' + steps.length;
    }
    function buildSegRow(g) {
      const live = g.end == null;
      const row = U().el('div', { class: 'seg-row' + (live ? ' is-live' : '') });
      // 时刻是按钮：点一下就能改这一段的开始 / 结束（原来是只读文本）。
      // 正在走的那一段显示的是「已用时长」（bindNum 每秒刷），点它同样能改开始时间。
      const time = U().el('button', { class: 'seg-time', type: 'button', title: '修改起止时间' });
      if (live) { bindNum(time, () => segSec(g)); time.classList.add('is-clock'); }
      else time.textContent = hhmm(g.start) + '–' + hhmm(g.end);
      time.addEventListener('click', () => {
        openSegTime(g, (st, en) => {
          g.start = st;
          if (en != null) g.end = en;
          renderSteps(); syncTabs(); commitSteps();
        });
      });
      const noteBtn = U().el('button', { class: 'seg-note', type: 'button', text: g.note || '加备注' });
      noteBtn.addEventListener('click', () => editSegNote(g));
      const del = U().el('button', { class: 'icon-btn seg-del', type: 'button', html: U().icon('x', 13), title: '删除这一段' });
      del.addEventListener('click', () => delSeg(g));
      row.appendChild(time); row.appendChild(noteBtn);
      // 已结束的段在备注后面补一个耗时（时:分:秒）；正在走的那段左边就是耗时，不重复
      if (!live) row.appendChild(U().el('span', { class: 'seg-dur', text: U().fmtHMS(segSec(g)) }));
      row.appendChild(del);
      return row;
    }

    function buildStepRow(s) {
      const st = App.timer ? App.timer.state() : { running: false };
      const isRun = !!(st.running && st.recId === curId && st.stepId === s.id);
      const row = U().el('div', { class: 'step-row' + (s.done ? ' is-done' : '') + (isRun ? ' is-live' : '') });
      const chk = U().el('button', { class: 'step-chk' + (s.done ? ' on' : ''), type: 'button', html: s.done ? U().icon('check', 13) : '' });
      chk.setAttribute('aria-label', s.done ? '标记为未完成' : '标记为已完成');
      chk.addEventListener('click', () => {
        s.done = !s.done;
        s.doneAt = s.done ? Date.now() : null;
        renderSteps(); syncTabs(); commitSteps();
      });
      const name = U().el('button', { class: 'step-name', type: 'button', text: s.text || '未命名待办' });
      name.addEventListener('click', () => editStepText(s));
      const dur = bindNum(U().el('span', { class: 'step-dur' }), () => stepSec(s));
      const more = U().el('button', { class: 'icon-btn step-more', type: 'button', html: U().icon('more', 18), title: '待办操作' });
      more.addEventListener('click', () => openStepMenu(s));
      row.appendChild(U().el('div', { class: 'step-top' }, chk, name, dur, more));

      if (s.segs && s.segs.length) {
        const wrap = U().el('div', { class: 'step-segs' });
        s.segs.forEach((g) => wrap.appendChild(buildSegRow(g)));
        row.appendChild(wrap);
      }
      const btn = U().el('button', { class: 'step-timer' + (isRun ? ' is-run' : ''), type: 'button' },
        U().el('span', { class: 'step-timer-ic', html: U().icon(isRun ? 'pause' : 'play', 13) }),
        U().el('span', { text: isRun ? '暂停' : ((s.segs && s.segs.length) ? '继续计时' : '开始计时') }));
      btn.addEventListener('click', () => toggleStepTimer(s, isRun));
      row.appendChild(U().el('div', { class: 'step-actions' }, btn));
      return row;
    }

    function renderSteps() {
      U().clear(stepsList);
      numBinders = [];
      if (!steps.length) {
        stepsList.appendChild(U().el('div', { class: 'steps-empty', text: '还没有待办。点右上角「+」加一条，然后就能给它分段计时。' }));
      } else {
        steps.forEach((s) => stepsList.appendChild(buildStepRow(s)));
      }
      paintNums();
      paintStepsHead();
    }

    async function toggleStepTimer(s, isRun) {
      if (!App.timer) return;
      if (isRun) {
        await App.timer.stop();
        U().toast('已暂停', 'ok');
        await reloadSteps();
        return;
      }
      // 计时要把分段写进记录，所以必须先有一条真实记录。
      // 新建笔记不再要求用户「先去点保存」——点计时就静默存一份（标题/正文/图片/步骤一起带上）。
      if (!curId && !(await ensureRecord())) return;
      const r = await App.timer.start(curId, s.id);
      if (!r || !r.ok) {
        U().toast(r && r.reason === 'nostep' ? '这一步已经被删掉了' : '没能开始计时，请重试', 'err');
        return;
      }
      if (r.prev) U().toast('已结束上一条待办的计时，开始「' + (s.text || '未命名待办') + '」', 'ok');
      await reloadSteps();
    }

    // —— 待办 / 分段的增删改（输入弹窗 promptText 已上提到模块级，详情页共用）——
    function addStep() {
      promptText('新建待办', '', '添加', (v) => {
        steps.push({ id: App.storage.uid(), text: v, note: '', done: false, doneAt: null, segs: [] });
        renderSteps(); syncTabs(); commitSteps();
      });
    }
    function editStepText(s) {
      promptText('待办名称', s.text, '保存', (v) => { s.text = v; renderSteps(); commitSteps(); });
    }
    function editSegNote(g) {
      promptText('这一段在做什么', g.note, '保存', (v) => { g.note = v; renderSteps(); commitSteps(); });
    }
    function openStepMenu(s) {
      const i = steps.indexOf(s);
      const list = U().el('div', { class: 'col', style: { gap: '2px' } });
      const dlg = U().modal({ title: '待办操作', body: list, center: true });
      const row = (label, disabled, fn) => {
        const b = U().el('button', { class: 'ed-hmenu-item', type: 'button' }, U().el('span', { class: 'ed-hmenu-t', text: label }));
        if (disabled) { b.disabled = true; b.classList.add('is-off'); }
        else b.addEventListener('click', () => { dlg.close(); fn(); });
        list.appendChild(b);
      };
      row('重命名', false, () => editStepText(s));
      row('上移一位', i <= 0, () => {
        const one = steps.splice(i, 1)[0];
        steps.splice(i - 1, 0, one);
        renderSteps(); commitSteps();
      });
      row('下移一位', i >= steps.length - 1, () => {
        const one = steps.splice(i, 1)[0];
        steps.splice(i + 1, 0, one);
        renderSteps(); commitSteps();
      });
      row('删除这条待办', false, () => {
        U().confirmDialog('删除「' + (s.text || '未命名待办') + '」及其全部计时记录？', { okLabel: '删除', danger: true }).then(async (ok) => {
          if (!ok) return;
          const st = App.timer ? App.timer.state() : { running: false };
          if (st.running && st.stepId === s.id) await App.timer.stop();
          steps = steps.filter((x) => x.id !== s.id);
          renderSteps(); syncTabs(); await commitSteps();
        });
      });
    }
    function delSeg(g) {
      U().confirmDialog('删除这一段计时（' + U().fmtHMS(segSec(g)) + '）？', { okLabel: '删除', danger: true }).then(async (ok) => {
        if (!ok) return;
        const st = App.timer ? App.timer.state() : { running: false };
        if (st.running && st.segId === g.id) await App.timer.stop();
        const step = steps.find((s) => (s.segs || []).indexOf(g) > -1);
        if (step) step.segs = step.segs.filter((x) => x.id !== g.id);
        renderSteps(); syncTabs(); await commitSteps();
      });
    }

    // 计时读数：待办头 + 每步 + 每段共用同一个订阅（详情页有它自己的一份，见 renderDetail）
    let offTimer = null;
    if (App.timer) {
      let lastKey = App.timer.state().segId || '';
      offTimer = App.timer.on((st) => {
        paintStepsHead(); paintNums();
        const key = (st.running && st.recId === curId) ? st.segId : '';
        if (key !== lastKey) { lastKey = key; reloadSteps(); }   // 开始/结束：把新段或 end 读回来
      });
    }
    renderSteps();

    const body = viewsEl;

    let saved = false;        // 点过右上角 ✓ 正式保存过
    let autoSaved = false;    // 因为「点计时」被静默暂存过（列表里已经多了一条）
    let stateFresh = false;   // 关页面之前是否已经拿过最新库（避免 onClose 再白读一次）
    // 计时器是直接 patchRecord 写库的，而编辑器里的 steps 是「打开时的一份副本」。
    // 保存时如果整份覆盖，会把计时器刚刚收口的段（end 有值）写回 end:null —— 时长就丢了。
    // 合并规则：同一个段 id，库里已经有 end 的以库里为准（那是唯一事实）。
    async function mergeStepsFromDb(id, next) {
      let cur = null;
      try { cur = await App.db.getRecord(id); } catch (_) { return next; }
      if (!cur || !Array.isArray(cur.steps)) return next;
      const bySeg = {};
      cur.steps.forEach((s) => { (s.segs || []).forEach((g) => { bySeg[g.id] = g; }); });
      next.forEach((s) => {
        (s.segs || []).forEach((g) => {
          const d = bySeg[g.id];
          if (d && d.end != null && g.end == null) g.end = d.end;
        });
      });
      return next;
    }
    // 把编辑器当前状态组装成一条完整记录（不落库）。id 用 curId —— 它一旦分配就不再变，
    // 所以「静默暂存」之后再点保存，写回去的还是同一条，不会变成两条。
    function buildRecord() {
      const dval = recDate;
      // 投入分钟：本次真改过才以手填为准（清空 = 交还给计时汇总）；没碰过则沿用原规则。
      const rawMin = String(timeI.value == null ? '' : timeI.value).trim();
      const manualMin = rawMin === '' ? null : Math.max(0, Number(rawMin) || 0);
      // ★ 从「白名单重建」改成「黑名单覆盖」：先整体继承旧记录，再覆盖本次编辑到的字段。
      //   原来是逐字段列举（只搬 id / createdAt / comments），以后每加一个字段
      //   （steps / timeSpentMinManual 是头两个）都会被静默吞掉。
      const rec = Object.assign({}, existingRec || {}, {
        id: curId || App.storage.uid(),
        domainId: domain.id,
        categoryId, tagIds: selectedTags.slice(), title: titleI.value.trim(),
        description: descTouched ? docText().trim() : ((existingRec && existingRec.description) || docText().trim()), imageIds: imageIds.slice(),
        income: Number(incI.value) || 0, expense: Number(expI.value) || 0,
        customValues: customValues,
        date: isNaN(dval) ? Date.now() : dval,
        createdAt: existingRec ? existingRec.createdAt : App.storage.now(), updatedAt: App.storage.now(),
        comments: existingRec ? (existingRec.comments || []) : [],
        // 步骤与分段计时整份写回（深拷贝：别把编辑器里的数组对象直接挂到记录上）
        steps: JSON.parse(JSON.stringify(steps)),
      });
      if (timeTouched) {
        rec.timeSpentMinManual = timeManual;
        rec.timeSpentMin = manualMin;
        if (!timeManual) syncTimeFromSteps(rec, null);   // 清空 = 交还计时；没计时就是空
      } else {
        rec.timeSpentMinManual = timeManual;
        if (timeManual) rec.timeSpentMin = (existingRec && existingRec.timeSpentMin != null) ? existingRec.timeSpentMin : null;
        else syncTimeFromSteps(rec, existingRec ? existingRec.timeSpentMin : null);
      }
      return rec;
    }
    // 落库。成功返回记录，失败返回 null（调用方必须当回事：失败就当作「还没保存」）。
    async function persistRecord() {
      // 双保险：遮罩挡不住键盘回车一类的意外触发，这里再拦一次
      if (busyDepth > 0 || U().isBusy()) { U().toast('图片还在处理中，请稍候', 'err'); return null; }
      const rec = buildRecord();
      if (curId) rec.steps = await mergeStepsFromDb(curId, rec.steps);
      try { await App.db.saveRecord(rec); }
      catch (e) { U().toast('保存失败，请检查存储空间', 'err'); return null; }
      // 落库成功后才认这条 id / 这份数据：后面的保存、计时都写同一条记录
      curId = rec.id;
      existingRec = rec;
      sessionAdded.length = 0;   // 新图已经绑定记录，不再列入待清理
      return rec;
    }
    // 新建笔记第一次点计时：静默把当前内容整条存下来（计时要把段写进库，没有 id 没处写）。
    // 失败就如实返回 false —— 调用方不开始计时，语义仍然是「没保存」。
    async function ensureRecord() {
      if (curId) return true;
      const rec = await persistRecord();
      if (!rec) return false;
      autoSaved = true;
      try { await App.state.reloadRecords(); stateFresh = true; } catch (_) {}   // 只刷内存，不 renderRoute（会顶掉编辑页）
      U().toast('笔记已暂存，点 ✕ 关闭也不会丢', 'ok');
      return true;
    }
    // 「保存」：顶栏右上角对勾触发
    async function doSave(close) {
      const rec = await persistRecord();
      if (!rec) return;
      // 保存成功后，才真正删除「被移除的已有图片」对应的相册原图
      if (pendingRemove.length) {
        const gone = pendingRemove.slice();
        pendingRemove.length = 0;
        App.storage.deleteImages(gone).catch(() => {});
      }
      saved = true;
      // 不再自己 renderRoute()：收口到 onClose（close() 会走它），避免「先重绘一次再重绘一次」的闪跳。
      await App.state.reloadRecords(); stateFresh = true;
      U().toast('已保存', 'ok'); close();
    }

    const m = U().fullPage({
      title: existingRec ? '编辑记录' : '新建记录',
      body,
      right: [metaBtn, saveBtnEl],   // 右上角：笔记信息（⋯）+ 保存对勾
      // 返回键分级：非正文视图时先回正文，正文视图才交给默认的「关页面」。
      // 抽屉 / 灯箱是后 push 的浮层，closeTopLayer 会先把它们关掉，再来问这里。
      // 专注页（focus，z-index 53）盖在编辑页之上，且它不是路由页 —— 返回应该先退它，
      // 否则从编辑页点「放大」进来后按返回，会直接把脚下的编辑页关掉、专注页留在屏幕上。
      onBack: () => {
        if (App.focus && App.focus.isOpen && App.focus.isOpen()) { App.focus.close(); return true; }
        if (curView !== 1) { goView(1); return true; }
        return false;
      },
      onClose: () => {
        // 取消 / 关闭 / 返回键：本次新写进相册、但还没绑定到记录上的图全部删掉，不留垃圾文件。
        // 判据用「数组非空」而不是「没保存过」——点计时会静默暂存一次（那时数组已被清空），
        // 之后再新加的图仍然属于「没绑定」，关页时该删。
        if (sessionAdded.length) {
          sessionAdded.forEach((id) => App.storage.deleteImage(id).catch(() => {}));
          sessionAdded.length = 0;
        }
        pendingRemove.length = 0;   // 未保存的「移除」标记直接作废
        // 只要这条记录「可能被写过」，关掉编辑页就得重绘一次 —— 三条路径（✓ / × / 返回键）都经过这里：
        //  · 正式保存过 → 必须刷；
        //  · 点计时被静默暂存过 → 列表里已经多了一条，必须刷；
        //  · curId 非空（编辑已有记录）→ 计时器 / 详情页随时可能 patchRecord 写过段与勾选，
        //    用户点 × 退出后详情页还显示旧状态，得退到列表再进来才更新，这就是原来的反人类表现。
        // 带 keepScroll：只换内容，别把人踢回页面顶部。
        const touched = saved || autoSaved || !!curId;
        if (touched) {
          const hashNow = location.hash || '';
          Promise.resolve(stateFresh ? null : App.state.reloadRecords()).catch(() => {})
            .then(() => {
              // 读完库的这段时间里用户可能已经跳走了，那就别再抢路由
              if ((location.hash || '') === hashNow) App.app.renderRoute({ keepScroll: true });
            });
        }
        // 排版栏的延时收起、标题菜单的 document 级监听都要在这里断掉：
        // 编辑页一关，那段 180ms 定时器还会醒来摸一次已经不在文档里的节点。
        if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = 0; }
        try { closeHMenu(); } catch (_) {}
        // 字数胶囊的引用必须在这里断掉：document 上的 selectionchange 是常驻监听，
        // 只有确认编辑器真的关了、不再重绘，才不会再往已卸载的节点上写字。
        activeDescI = null; activeCountPill = null;
        // 计时订阅必须解绑：留着会一直往已卸载的节点上写数字（计时本身继续跑，段已落库）
        if (offTimer) { offTimer(); offTimer = null; }
        // 手势 / 尺寸监听一律解绑：编辑页开关多次不能累积监听（旧代码在这里留过一组）
        teardown.forEach((fn) => { try { fn(); } catch (_) {} });
        teardown.length = 0;
      },
    });
    saveBtnEl.addEventListener('click', () => doSave(m.close));
    // 胶囊挂在 .ed-views 内（已经在前面 append 好）；元数据「停车位」与排版栏接在最后，
    // dock 仍是 .page-sheet 的最后子节点 —— 29px 恒占位的既有断言依赖这一点。
    m.el.appendChild(metaPark);
    m.el.appendChild(dock);
    if (busyDepth > 0) setSaveEnabled(false);

    // 槽宽要进了文档才量得准：先按默认居中摆一次，下一拍再精确对齐
    railGo(1, false, 0);
    setTimeout(() => { try { railGo(curView, false, 0); } catch (_) {} }, 0);
    // 进了文档才能量到真实宽度：重挂一次图片区（此时 IntersectionObserver 的 root 也已生效），
    // 再按真实宽度把每格高度算一遍。
    ensureMediaIO();
    renderPreview();
    paintMediaSizes();
    teardown.push(() => { try { if (mediaIO) { mediaIO.disconnect(); mediaIO = null; } } catch (_) {} });
    const onWinResize = () => { railGo(curView, false, 0); paintMediaSizes(); };   // 旋屏 / 键盘改视口后重新对位与重排图片
    window.addEventListener('resize', onWinResize, false);
    teardown.push(() => window.removeEventListener('resize', onWinResize, false));

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
        const box = descI.closest('.ed-scroll');
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
          // 浮起来就脱离文档流了：正文要自己补出这段高度，最后一行才滚得上来。
          // 必须补在「正文自己的滚动容器」上：.page-sheet-body 已经不再滚动，
          // 补在它上面只是把三张卡整体压扁，光标会被顶高约一个栏高。
          textScroll.style.paddingBottom = (st.open && st.lift) ? (dock.offsetHeight + 10) + 'px' : '';
        } catch (e) {}
        if (st.open) ensureCaret();
        // 正文区可用高度变了（键盘弹起 / 浮起补白 / 收键盘），撑满的输入框要重新量一次：
        // 留 400ms 让键盘动画停稳，避免在动画中途反复塌缩→重排。
        settleDesc();
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
          const box = descI.closest('.ed-scroll');
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

  // segSec / stepSec / recSec / syncTimeFromSteps 一并导出：
  // js/timer.js 写库时要用同一套口径，避免两处各算一遍导致数字对不上。
  // editorMode 用 getter/setter 暴露：探针或用户想「无条件退回整篇 textarea」，设一下就行
  // （只影响【之后打开】的编辑页，正在编辑的那一页用自己的切换按钮）
  return {
    renderList, renderDetail, openEditor, mdHtml, segSec, stepSec, recSec,
    syncTimeFromSteps, normalizeSteps, closeTimerWin, initTimerWin, splitDoc,
    setFocusMode, progBadge, promptText, patchSegNote,
    get editorMode() { return editorMode; },
    set editorMode(v) { editorMode = v === 'source' ? 'source' : 'blocks'; },
  };
})();
