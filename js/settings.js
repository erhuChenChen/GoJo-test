/* ===== settings.js — 设置（领域/分类标签/自定义属性/仪表盘/目标/主题/备份）===== */
window.App = window.App || {};
App.settings = (function () {
  const U = () => App.ui;
  let activeTab = 'domains';
  let contentEl = null;   // 当前设置页内容容器：物理返回键要重渲染时用
  let tabDragEndAt = 0; // 拖动结束时间戳：用来吞掉紧随其后的那次 click

  const TABS = [
    { key: 'about', label: '关于' },{ key: 'domains', label: '领域' }, { key: 'cattag', label: '分类标签' },
    { key: 'customfields', label: '自定义属性' }, { key: 'dash', label: '仪表盘' }, { key: 'goal', label: '目标' },
    { key: 'theme', label: '主题' }, { key: 'backup', label: '备份' },
    
  ];

  // ===== 关于页配置 =====
  // 兜底版本号：只有拿不到运行时版本时才用它（原生打包后优先读 plus.runtime.version，
  // 也就是 manifest.json 里配置的 versionName，改了包名/版本号这里不需要跟着改）。
  const APP_VERSION = '1.0.0';
  // 检查更新要请求的 GitHub 仓库，格式 '用户名/仓库名'。
  // 例如仓库是 https://github.com/zhangsan/gojo 就填 'zhangsan/gojo'。
  // 留空则点「检查更新」会提示未配置（不会报错、不会白屏）。
  const UPDATE_REPO = 'erhuChenChen/GoJo-test';
  // 使用说明：直接平铺展示的文字，整段替换成你自己的内容即可。
  // 这里的内容会按 Markdown 渲染（## 是二级标题、- 是列表项、**文字** 是加粗），
  // 写普通换行也可以，会原样换行显示。
  const ABOUT_USAGE = [
    '## 一、这是什么',
    'GoJo 是一个纯本地的图文记录工具：写下今天做了什么，纯文字或者图文记录，按领域归档。',
    '所有数据只存在你的手机里，不联网、不上传、不需要账号。',
    '',
    '## 二、基本使用',
    '1. 添加记录：底部「记录」页 → 右下角 + → 写标题 / 正文 / 加图 → 保存。',
    '2. 图文记录：点开一条记录，左右滑动切换，正文支持Markdown语法。',
    '3. 评论：记录详情页底部可以给这条记录追加评论，长按评论可删除。',
    '4. 自定义设置：「设置」页提供多种自定义功能，可滑动拖拽设置项排序。',
    '',
    '## 三、图片存在哪',
    '上传的图片会存进手机相册的 Pictures/GoJo 文件夹（没这个文件夹会自动创建），记录里只保存图片的路径。所以：',
    '',
    '- 在相册里能直接看到这些图，也能用其它 App 打开；',
    '- 如果在相册里把某张图删了，记录里那张图会显示「图片丢失」，不会崩；',
    '**⚠️注意：在 App 里删记录时，相册里对应 Pictures/GoJo 文件夹的图片也会一起删掉；同样的，在相册里删除 Pictures/GoJo 文件夹的图片，App 里对应的图片也会一起删掉。**',
    '',
    '## 四、备份与恢复',
    '设置 → 备份 → 导出全部数据，会生成一个 `.gtbackup` 文件，存放在 **手机存储/Download/GoJobackup**，里面包含数据和你所有的原图。',
    '',
    '换手机时：旧机导出 → 把文件拷到新机 → 新机「导入备份恢复」。导入会把图片重新释放到相册，再把记录接上。',
    '**⚠️注意：卸载 App 会清除本地数据，请务必定期导出备份！**',
    '',
    '## 五、常见问题',
    '',
    '- 换手机后图片显示不出来？先确认导入时是否允许了存储权限。',
    '- 想省空间？设置 → 备份 → 清理缓存，只删缩略图，原图不动。',

  ].join('\n');

  function render(container) {
    U().clear(container);
    const tabsEl = U().el('div', { class: 'tabs' });
    const content = U().el('div', { class: 'settings-body' });
    contentEl = content;
    orderedTabs().forEach((t) => {
      const tab = U().el('div', { class: 'tab' + (t.key === activeTab ? ' active' : ''), 'data-key': t.key, text: t.label });
      tab.addEventListener('click', () => {
        if (Date.now() - tabDragEndAt < 350) return; // 刚拖动过，别把松手当成点击切换
        activeTab = t.key; tabsEl.querySelectorAll('.tab').forEach((x) => x.classList.remove('active')); tab.classList.add('active'); renderContent(content);
      });
      tabsEl.appendChild(tab);
    });
    container.appendChild(tabsEl);
    container.appendChild(content);
    renderContent(content);
    enableTabDrag(tabsEl);
  }

  // —— 顶部导航顺序：有保存过的顺序就照着排，缺失（新版本新增的 tab）追加到末尾 ——
  function orderedTabs() {
    const saved = (App.state.data.settings && App.state.data.settings.tabOrder) || [];
    const out = [];
    saved.forEach((k) => { const t = TABS.find((x) => x.key === k); if (t && !out.some((x) => x.key === k)) out.push(t); });
    TABS.forEach((t) => { if (!out.some((x) => x.key === t.key)) out.push(t); });
    return out;
  }

  // —— 长按拖动排序（pointer 事件，鼠标与触摸通用；移动端 HTML5 dragstart 不触发）——
  // window 级监听器只注册一次，否则每次切 tab 重渲染都会叠一层（旧闭包还被引用着）
  const tabDrag = { tabs: null, el: null, timer: null, active: false, startX: 0, startY: 0, lastX: 0, scrollTimer: null };
  let tabDragBound = false;

  function tabDragClearPress() { if (tabDrag.timer) { clearTimeout(tabDrag.timer); tabDrag.timer = null; } }
  function tabDragStopScroll() { if (tabDrag.scrollTimer) { clearInterval(tabDrag.scrollTimer); tabDrag.scrollTimer = null; } }

  function tabDragStart(tab) {
    const tabsEl = tabDrag.tabs;
    tabDrag.active = true; tabDrag.el = tab;
    tab.classList.add('dragging');
    tabsEl.classList.add('reordering');
    // 拖到两端时自动横滚：窄屏上 7 个标签会超出可视区
    tabDragStopScroll();
    tabDrag.scrollTimer = setInterval(() => {
      if (!tabDrag.el) return;
      const r = tabsEl.getBoundingClientRect();
      if (tabDrag.lastX < r.left + 44) tabsEl.scrollLeft -= 10;
      else if (tabDrag.lastX > r.right - 44) tabsEl.scrollLeft += 10;
    }, 16);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    // 触摸拖动期间禁掉页面/横向容器的原生滚动，否则手指一动就变成滑动而不是拖拽
    window.addEventListener('touchmove', tabDragOnTouchMove, { passive: false });
  }

  function tabDragOnTouchMove(e) { if (tabDrag.active && e.cancelable) e.preventDefault(); }

  // 用手指（或鼠标）当前位置决定插到哪两个标签之间
  function tabDragMoveTo(x) {
    const tabsEl = tabDrag.tabs, dragEl = tabDrag.el;
    if (!dragEl || !tabsEl) return;
    const others = Array.prototype.filter.call(tabsEl.querySelectorAll('.tab'), (el) => el !== dragEl);
    let ref = null;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) { ref = others[i]; break; }
    }
    if (ref) { if (ref.previousElementSibling !== dragEl) tabsEl.insertBefore(dragEl, ref); }
    else if (tabsEl.lastElementChild !== dragEl) tabsEl.appendChild(dragEl);
  }

  function tabDragEnd(commit) {
    const tabsEl = tabDrag.tabs, dragEl = tabDrag.el;
    if (!tabDrag.active) { tabDragClearPress(); return; }
    tabDrag.active = false;
    tabDragStopScroll();
    window.removeEventListener('touchmove', tabDragOnTouchMove);
    if (dragEl) dragEl.classList.remove('dragging');
    if (tabsEl) tabsEl.classList.remove('reordering');
    tabDrag.el = null;
    tabDragEndAt = Date.now();
    if (!commit || !tabsEl) return;
    const keys = Array.prototype.map.call(tabsEl.querySelectorAll('.tab'), (el) => el.getAttribute('data-key'));
    App.state.saveSettings({ tabOrder: keys });
  }

  function enableTabDrag(tabsEl) {
    tabDrag.tabs = tabsEl; // 每次重渲染都指向新的导航条

    // 导航条自身的监听跟着元素走，元素被替换就自动回收
    tabsEl.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const tab = e.target.closest ? e.target.closest('.tab') : null;
      if (!tab || !tabsEl.contains(tab)) return;
      tabDrag.startX = e.clientX; tabDrag.startY = e.clientY; tabDrag.lastX = e.clientX;
      tabDragClearPress();
      tabDrag.timer = setTimeout(() => { tabDrag.timer = null; tabDragStart(tab); }, 320);
    });
    tabsEl.addEventListener('contextmenu', (e) => { if (tabDrag.active) e.preventDefault(); });
    tabsEl.addEventListener('dragstart', (e) => e.preventDefault());

    if (tabDragBound) return;
    tabDragBound = true;

    window.addEventListener('pointermove', (e) => {
      if (!tabDrag.active) {
        // 长按判定前先动了 → 用户是在滑动这排标签，取消长按
        if (tabDrag.timer && (Math.abs(e.clientX - tabDrag.startX) > 10 || Math.abs(e.clientY - tabDrag.startY) > 10)) tabDragClearPress();
        return;
      }
      tabDrag.lastX = e.clientX;
      if (e.cancelable) e.preventDefault();
      tabDragMoveTo(e.clientX);
    });

    window.addEventListener('pointerup', () => tabDragEnd(true));
    window.addEventListener('pointercancel', () => tabDragEnd(false));
  }

  function renderContent(content) {
    // 切走「主题」页时丢掉未保存的颜色预览，全局变量还原成已保存的主题
    if (activeTab !== 'theme') { themeDraft = null; endThemePreview(); }
    U().clear(content);
    if (activeTab === 'domains') renderDomains(content);
    else if (activeTab === 'cattag') renderCatTag(content);
    else if (activeTab === 'customfields') renderCustomFields(content);
    else if (activeTab === 'dash') renderDash(content);
    else if (activeTab === 'goal') renderGoal(content);
    else if (activeTab === 'theme') renderTheme(content);
    else if (activeTab === 'backup') renderBackup(content);
    else if (activeTab === 'about') renderAbout(content);
  }

  // 设置页子 Tab 左右滑动切换（由全局手势调用）。按当前排列顺序移动，
  // 到头不过界，同步高亮并让顶栏自动滚到可见位置。
  function swipeTab(dir) {
    const tabs = orderedTabs();
    let i = -1;
    for (let k = 0; k < tabs.length; k++) { if (tabs[k].key === activeTab) { i = k; break; } }
    if (i < 0) i = 0;
    const ni = Math.max(0, Math.min(tabs.length - 1, i + dir));
    if (ni === i) return;
    activeTab = tabs[ni].key;
    const tabsEl = document.querySelector('.settings-body') ? document.querySelector('.tabs') : null;
    if (tabsEl) {
      tabsEl.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.getAttribute('data-key') === activeTab));
      const act = tabsEl.querySelector('.tab.active');
      if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
    if (contentEl) renderContent(contentEl);
  }

  // 离开设置页（切到底部其它 tab）时，同样丢弃未保存的主题预览，避免「没保存却像已生效」
  window.addEventListener('hashchange', () => {
    if ((location.hash || '').indexOf('#/settings') !== 0) { themeDraft = null; endThemePreview(); }
  });

  // —— 领域管理 ——
  // 格式化为 年-月-日（用于领域创建日期展示）
  function ymd(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function renderDomains(content) {
    const domains = App.state.data.domains;
    const list = U().el('div', { class: 'col', style: { gap: '10px' } });
    domains.forEach((d) => {
      const isCur = d.id === App.state.data.currentDomainId;
      const delBtn = U().el('button', { class: 'btn danger', text: '删除' });
      delBtn.addEventListener('click', async () => {
        if (!(await U().confirmDialog('删除领域「' + d.name + '」会同时删除其下所有记录与图片，确定？', { okLabel: '删除', danger: true }))) return;
        await App.db.deleteDomain(d.id);
        await App.state.reloadDomains();
        if (App.state.data.currentDomainId === d.id) { const first = App.state.data.domains[0]; if (first) await App.state.setCurrentDomain(first.id); }
        U().toast('已删除领域', 'ok'); renderContent(content); if (App.app.refreshChrome) App.app.refreshChrome();
      });
      const switchBtn = U().el('button', { class: 'btn' + (isCur ? '' : ' primary'), text: isCur ? '当前' : '切换到此' });
      if (!isCur) switchBtn.addEventListener('click', async () => { await App.state.setCurrentDomain(d.id); U().toast('已切换到「' + d.name + '」', 'ok'); if (App.app.refreshChrome) App.app.refreshChrome(); renderContent(content); });
      // 重命名 + 改图标：记录/图片/分类标签全部按 id 关联，不受影响
      const renBtn = U().el('button', { class: 'icon-btn', html: U().icon('edit', 15), title: '重命名领域', style: { width: '34px', height: '34px' } });
      renBtn.addEventListener('click', () => {
        const ef = emojiField(d.icon || '✨');
        const nameI = U().el('input', { class: 'input', value: d.name, placeholder: '领域名称' });
        const body = U().el('div', {}, U().el('div', { class: 'field' }, U().el('label', { text: '名称' }), nameI), ef.wrap);
        U().modal({
          title: '重命名领域', body,
          actions: [
            { label: '取消', onClick: (c) => c() },
            { label: '保存', primary: true, onClick: async (c) => {
                const v = nameI.value.trim();
                if (!v) { U().toast('名称不能为空', 'err'); return; }
                if (App.state.data.domains.some((x) => x.id !== d.id && x.name === v)) { U().toast('名称已存在', 'err'); return; }
                const dom = App.state.data.domains.find((x) => x.id === d.id);
                if (!dom) return;
                dom.name = v;
                dom.icon = ef.get();
                await App.db.saveDomain(dom);
                await App.state.reloadDomains();
                U().toast('已重命名为「' + v + '」', 'ok');
                c(); renderContent(content);
                if (App.app.refreshChrome) App.app.refreshChrome();
                const vw = App.app && App.app.view;
                if (vw && (location.hash || '').indexOf('#/records') === 0) App.records.renderList(vw);
              } },
          ],
        });
        setTimeout(() => { nameI.focus(); nameI.select(); }, 60);
      });
      // 统计改为「X个记录」；创建日期（年-月-日）与记录数同色、偏小，置于标题同一行靠右
      const recCount = App.state.data.records.filter((r) => r.domainId === d.id).length;
      const dateStr = ymd(d.createdAt);
      list.appendChild(U().el('div', { class: 'card' },
        U().el('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'baseline' } },
          U().el('div', { class: 'row' }, U().el('span', { style: { fontSize: '1.625rem' }, text: d.icon || '✨' }), U().el('div', { style: { fontWeight: '700', fontSize: '1rem' }, text: d.name })),
          dateStr ? U().el('span', { class: 'muted', style: { fontSize: '0.72rem', whiteSpace: 'nowrap', marginLeft: '8px' }, text: dateStr }) : null),
        U().el('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' } },
          U().el('span', { class: 'muted', style: { fontSize: '0.75rem' }, text: recCount + '个记录' }),
          U().el('div', { class: 'row' }, renBtn, switchBtn, delBtn))));
    });
    const addBtn = U().el('button', { class: 'btn primary block', html: U().icon('plus', 18) + '<span>添加领域</span>' });
    addBtn.addEventListener('click', () => openAddDomain(content));
    content.appendChild(list);
    content.appendChild(U().el('div', { style: { height: '12px' } }));
    content.appendChild(addBtn);
  }

  function openAddDomain(content) {
    let sel = 'drawing';
    const ef = emojiField((App.domains.PRESETS[sel] && App.domains.PRESETS[sel].icon) || '✨');
    const nameI = U().el('input', { class: 'input', placeholder: '领域名称' });
    const catsI = U().el('textarea', { class: 'textarea', placeholder: '自定义分类，用逗号分隔' });
    const customBox = U().el('div', { class: 'hidden' }, U().el('div', { class: 'field' }, U().el('label', { text: '领域名称' }), nameI), U().el('div', { class: 'field' }, U().el('label', { text: '主要分类' }), catsI));
    const grid = U().el('div', { class: 'preset-grid' });
    Object.keys(App.domains.PRESETS).forEach((k) => {
      const p = App.domains.PRESETS[k];
      const card = U().el('div', { class: 'preset-card' + (sel === k ? ' active' : ''), 'data-key': k }, U().el('div', { class: 'pc-emoji', text: p.icon }), U().el('div', { class: 'pc-name', text: p.name }));
      card.addEventListener('click', () => { sel = k; grid.querySelectorAll('.preset-card').forEach((c) => c.classList.toggle('active', c.getAttribute('data-key') === k)); customBox.classList.toggle('hidden', k !== 'custom'); ef.set(p.icon); });
      grid.appendChild(card);
    });
    const body = U().el('div', {}, U().el('div', { class: 'section-title', text: '选择领域' }), grid, customBox, ef.wrap);
    const m = U().modal({
      title: '添加领域', body, wide: true,
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: '添加', primary: true, onClick: async (c) => {
            let dom;
            if (sel === 'custom') { const n = nameI.value.trim(); if (!n) { U().toast('请填写领域名称', 'err'); return; } dom = App.domains.createCustom(n, catsI.value.split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean)); }
            else { dom = App.domains.createFromPreset(sel, nameI.value.trim() || undefined); }
            if ((App.state.data.domains || []).some((x) => x.name === dom.name)) { U().toast('名称已存在', 'err'); return; }
            dom.icon = ef.get();
            await App.db.saveDomain(dom); await App.state.reloadDomains();
            if (!App.state.data.currentDomainId) await App.state.setCurrentDomain(dom.id);
            U().toast('已添加「' + dom.name + '」', 'ok'); c(); renderContent(content); if (App.app.refreshChrome) App.app.refreshChrome();
          } },
      ],
    });
  }

  // —— 分类与标签（卡片化：分类=整行可排序，标签=胶囊换行）——
  let dotsCleanup = null;
  function closeDots() { if (dotsCleanup) { const f = dotsCleanup; dotsCleanup = null; f(); } }

  // 卡片右上角「…」菜单
  function openDotsMenu(anchor, items) {
    closeDots();
    const panel = U().el('div', { class: 'popmenu dots-menu' });
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      panel.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('scroll', close, true);
      if (dotsCleanup === close) dotsCleanup = null;
    }
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
    dotsCleanup = close;
    items.forEach((it) => {
      const b = U().el('button', { class: 'pm-item' + (it.danger ? ' danger' : ''), html: U().icon(it.icon || 'edit', 16) + '<span>' + it.label + '</span>' });
      b.addEventListener('click', () => { close(); it.onClick(); });
      panel.appendChild(b);
    });
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + 'px';
    panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
    window.addEventListener('scroll', close, true);
  }

  // 轻量文本输入弹窗（新增/重命名共用）
  // 名称防呆校验：去首尾空格后，禁止为空或与现有名称重复（重命名时跳过自身旧名）。
  // 返回错误提示字符串；校验通过返回 null。
  function validateName(raw, existingNames, skipName) {
    const v = (raw || '').trim();
    if (!v) return '名称不能为空';
    if (existingNames.some((n) => n !== skipName && n === v)) return '名称已存在';
    return null;
  }

  function askText({ title, value, placeholder, okLabel, onOk, validate }) {
    const inp = U().el('input', { class: 'input', value: value || '', placeholder: placeholder || '' });
    U().modal({
      title: title,
      body: U().el('div', { class: 'field' }, U().el('label', { text: placeholder || '名称' }), inp),
      actions: [
        { label: '取消', onClick: (c) => c() },
        { label: okLabel || '确定', primary: true, onClick: (c) => {
            const v = inp.value.trim();
            if (!v) { U().toast('名称不能为空', 'err'); return; }
            if (validate) { const err = validate(inp.value); if (err) { U().toast(err, 'err'); return; } }
            c(); onOk(v);
        } },
      ],
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  }

  // —— Emoji 图标选择器：自由输入 + 常用快捷选择（新增 / 重命名领域共用）——
  const COMMON_EMOJI = ['✨','🎨','📚','🏋️','🎯','🎵','📷','✍️','💡','🌱','💻','🧪','📝','🏃','🍳','🎮','📈','❤️','🌟','🔥','🌈','🐱','🚀','☕'];
  function emojiField(initial) {
    let val = initial || '✨';
    const input = U().el('input', { class: 'input emoji-input', value: val, maxlength: '4', placeholder: '点选或输入 Emoji' });
    const grid = U().el('div', { class: 'emoji-pick' });
    function paintActive() { grid.querySelectorAll('.emoji-opt').forEach((b) => b.classList.toggle('active', b.textContent === val)); }
    COMMON_EMOJI.forEach((e) => {
      const b = U().el('button', { class: 'emoji-opt' + (e === val ? ' active' : ''), type: 'button', text: e });
      b.addEventListener('click', () => { val = e; input.value = e; paintActive(); });
      grid.appendChild(b);
    });
    input.addEventListener('input', () => { val = (input.value || '').trim() || '✨'; paintActive(); });
    const wrap = U().el('div', { class: 'field' }, U().el('label', { text: '图标 Emoji' }), input, grid);
    return { wrap, get: () => val, set: (v) => { val = v || '✨'; input.value = val; paintActive(); } };
  }

  function renderCatTag(content) {
    const domain = App.state.currentDomain();
    if (!domain) { content.appendChild(U().el('div', { class: 'empty-state', text: '请先添加领域' })); return; }
    const wrap = U().el('div', { class: 'entity-wrap' }, catCard(domain), tagCard(domain));
    content.appendChild(wrap);
  }

  // 落库 + 若当前就在列表页则立即重绘（分类顺序实时同步到列表页分类栏）
  function afterEntityChange(domain) {
    persistDomain(domain);
    const v = App.app && App.app.view;
    if (v && (location.hash || '').indexOf('#/records') === 0) App.records.renderList(v);
  }

  function entityCard(title, iconName) {
    const titleEl = U().el('div', { class: 'ec-title' },
      U().el('span', { class: 'ec-ico', html: U().icon(iconName, 15) }), U().el('span', { text: title }));
    const count = U().el('span', { class: 'ec-count' });
    const more = U().el('button', { class: 'ec-more', html: U().icon('more', 18), title: '更多操作' });
    const head = U().el('div', { class: 'ec-head' }, titleEl, count, U().el('span', { class: 'ec-grow' }), more);
    const body = U().el('div', { class: 'ec-body' });
    const card = U().el('div', { class: 'card entity-card' }, head, body);
    return { card, body, more, count };
  }

  function catCard(domain) {
    let mode = 'view';   // view | edit | delete
    const { card, body, more, count } = entityCard('分类', 'sort');

    more.addEventListener('click', () => openDotsMenu(more, [
      { label: mode === 'edit' ? '完成编辑' : '编辑', icon: 'edit', onClick: () => { mode = (mode === 'edit' ? 'view' : 'edit'); paint(); } },
      { label: mode === 'delete' ? '完成删除' : '删除', icon: 'trash', danger: true, onClick: () => { mode = (mode === 'delete' ? 'view' : 'delete'); paint(); } },
    ]));

    function move(from, to) {
      if (to < 0 || to >= domain.categories.length || from === to) return;
      const it = domain.categories.splice(from, 1)[0];
      domain.categories.splice(to, 0, it);
      afterEntityChange(domain);
      paint();
    }

    function rowOf(c, i) {
      const row = U().el('div', { class: 'cat-row mode-' + mode });
      if (mode === 'edit') {
        const inp = U().el('input', { class: 'cat-input', value: c.name });
        inp.addEventListener('input', () => {
          const v = inp.value.trim();
          // 非法或重名：阻止保存（保留旧值），避免落库脏数据
          if (!v || domain.categories.some((x) => x.id !== c.id && x.name === v)) return;
          c.name = inp.value.trim(); afterEntityChange(domain);
        });
        inp.addEventListener('change', () => {
          const v = inp.value.trim();
          if (!v || domain.categories.some((x) => x.id !== c.id && x.name === v)) { U().toast(v ? '名称已存在' : '名称不能为空', 'err'); inp.value = c.name; }
        });
        row.appendChild(inp);
      } else {
        row.appendChild(U().el('span', { class: 'cat-name', text: c.name }));
      }

      if (mode === 'delete') {
        const del = U().el('button', { class: 'row-x', html: U().icon('x', 15), title: '删除' });
        del.addEventListener('click', () => {
          domain.categories = domain.categories.filter((x) => x.id !== c.id);
          afterEntityChange(domain); paint();
        });
        row.appendChild(del);
        return row;
      }

      const grip = U().el('span', { class: 'cat-grip', html: U().icon('grip', 16) });
      const up = U().el('button', { class: 'mini-btn', html: U().icon('chevron', 15), title: '上移' });
      up.firstChild && (up.style.transform = 'rotate(180deg)');
      const down = U().el('button', { class: 'mini-btn', html: U().icon('chevron', 15), title: '下移' });
      if (i === 0) up.disabled = true;
      if (i === domain.categories.length - 1) down.disabled = true;
      up.addEventListener('click', (e) => { e.stopPropagation(); move(i, i - 1); });
      down.addEventListener('click', (e) => { e.stopPropagation(); move(i, i + 1); });
      const tail = U().el('div', { class: 'cat-tail' }, up, down);
      row.insertBefore(grip, row.firstChild);
      row.appendChild(tail);

      // 拖拽排序（触屏走上下按钮，桌面/鼠标可直接拖）。
      // 编辑/删除态或触屏设备不绑定 draggable：原生拖拽在触摸长按时会让整页卡死。
      const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
      if (mode === 'view' && !isTouch) {
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', (e) => { row.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; } catch (err) {} });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', (e) => {
          e.preventDefault(); row.classList.remove('drag-over');
          const from = Number(e.dataTransfer.getData('text/plain'));
          if (!isFinite(from) || from === i) return;
          move(from, i);
        });
      }
      return row;
    }

    function paint() {
      U().clear(body);
      count.textContent = String(domain.categories.length);
      if (!domain.categories.length) body.appendChild(U().el('div', { class: 'ec-empty', text: '还没有分类，点下方按钮新建' }));
      domain.categories.forEach((c, i) => body.appendChild(rowOf(c, i)));
      if (mode !== 'delete') {
        const add = U().el('button', { class: 'ec-add', html: U().icon('plus', 15) + '<span>新增分类</span>' });
        add.addEventListener('click', () => askText({
          title: '新增分类', placeholder: '分类名称', okLabel: '添加',
          validate: (raw) => validateName(raw, domain.categories.map((x) => x.name)),
          onOk: (v) => { domain.categories.push(App.domains.makeCat(v, domain.categories.length)); afterEntityChange(domain); paint(); },
        }));
        body.appendChild(add);
      }
      more.classList.toggle('active', mode !== 'view');
    }

    paint();
    return card;
  }

  function tagCard(domain) {
    let mode = 'view';
    const { card, body, more, count } = entityCard('标签', 'tag');

    more.addEventListener('click', () => openDotsMenu(more, [
      { label: mode === 'edit' ? '完成编辑' : '编辑', icon: 'edit', onClick: () => { mode = (mode === 'edit' ? 'view' : 'edit'); paint(); } },
      { label: mode === 'delete' ? '完成删除' : '删除', icon: 'trash', danger: true, onClick: () => { mode = (mode === 'delete' ? 'view' : 'delete'); paint(); } },
    ]));

    function addTag() {
      askText({
        title: '新增标签', placeholder: '标签名称', okLabel: '添加',
        validate: (raw) => validateName(raw, domain.tags.map((x) => x.name)),
        onOk: (v) => { domain.tags.push(App.domains.makeTag(v, domain.tags.length)); afterEntityChange(domain); paint(); },
      });
    }

    function chipOf(t) {
      if (mode === 'edit') {
        // 编辑态：胶囊直接变成输入框，宽度随文字自适应
        const inp = U().el('input', { class: 'tag-chip tag-input', value: t.name });
        const fit = () => { inp.style.width = Math.max(52, (inp.value.length + 1) * 14 + 18) + 'px'; };
        fit();
        inp.addEventListener('input', () => {
          const v = inp.value.trim();
          if (!v || domain.tags.some((x) => x.id !== t.id && x.name === v)) return; // 阻止保存非法/重名
          t.name = inp.value.trim(); fit(); afterEntityChange(domain);
        });
        inp.addEventListener('change', () => {
          const v = inp.value.trim();
          if (!v || domain.tags.some((x) => x.id !== t.id && x.name === v)) { U().toast(v ? '名称已存在' : '名称不能为空', 'err'); inp.value = t.name; fit(); }
        });
        return inp;
      }
      const chip = U().el('span', { class: 'tag-chip' + (mode === 'delete' ? ' del' : '') }, U().el('span', { text: '#' + t.name }));
      if (mode === 'delete') {
        const x = U().el('button', { class: 'tc-x', html: U().icon('x', 12), title: '删除' });
        x.addEventListener('click', () => {
          domain.tags = domain.tags.filter((y) => y.id !== t.id);
          afterEntityChange(domain); paint();
        });
        chip.appendChild(x);
        chip.classList.add('del');
      }
      return chip;
    }

    function paint() {
      U().clear(body);
      count.textContent = String(domain.tags.length);
      if (!domain.tags.length && mode !== 'delete') body.appendChild(U().el('div', { class: 'ec-empty', text: '还没有标签' }));
      domain.tags.forEach((t) => body.appendChild(chipOf(t)));
      if (mode !== 'delete') {
        const add = U().el('button', { class: 'tag-chip tag-add', html: U().icon('plus', 14), title: '新增标签' });
        add.addEventListener('click', addTag);
        body.appendChild(add);
      }
      more.classList.toggle('active', mode !== 'view');
    }

    paint();
    return card;
  }

  async function persistDomain(domain) { await App.db.saveDomain(domain); }

  // —— 自定义下拉组件已统一迁移至 ui.js（App.ui.makeSelect / App.ui.closeSelMenu），此处仅做转发以保持调用不变 ——
  function makeSelect(...a) { return U().makeSelect(...a); }
  function closeSelMenu() { U().closeSelMenu(); }

  // —— 自定义属性（纯展示 / 编辑 两态切换，最简状态机：editingId）——
  function renderCustomFields(content) {
    const domain = App.state.currentDomain();
    if (!domain) { content.appendChild(U().el('div', { class: 'empty-state', text: '请先添加领域' })); return; }
    const TYPE_LABEL = { select: '单选', text: '文本', number: '数字' };
    const TYPES = [['select', '单选'], ['text', '文本'], ['number', '数字']];
    let editingId = null;   // null = 全部展示态；否则该 id 的卡片进入编辑态
    let menuCleanup = null; // 当前已打开菜单的关闭函数
    const box = U().el('div', { class: 'col cf-list' });

    function closeMenu() { if (menuCleanup) { const fn = menuCleanup; menuCleanup = null; fn(); } }

    // 卡片右上「三个点」菜单：编辑 / 删除
    function openCardMenu(anchor, f) {
      closeMenu();
      const panel = U().el('div', { class: 'popmenu cf-menu' });
      let closed = false;
      function close() {
        if (closed) return; closed = true;
        panel.remove();
        document.removeEventListener('pointerdown', onDoc, true);
        window.removeEventListener('scroll', close, true);
        if (menuCleanup === close) menuCleanup = null;
      }
      const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
      menuCleanup = close;

      const editItem = U().el('button', { class: 'pm-item', html: U().icon('edit', 16) + '<span>编辑</span>' });
      editItem.addEventListener('click', () => { close(); editingId = f.id; rebuild(); });
      const delItem = U().el('button', { class: 'pm-item danger', html: U().icon('trash', 16) + '<span>删除</span>' });
      delItem.addEventListener('click', () => {
        close();
        domain.customFields = domain.customFields.filter((x) => x.id !== f.id);
        domain.cardFields = (domain.cardFields || []).filter((k) => k !== f.id);
        persistDomain(domain);
        if (editingId === f.id) editingId = null;
        rebuild();
      });
      panel.appendChild(editItem);
      panel.appendChild(delItem);
      document.body.appendChild(panel);
      const r = anchor.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + 'px';
      panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
      window.addEventListener('scroll', close, true);
    }

    // —— 展示态卡片 ——
    function viewCard(f) {
      const card = U().el('div', { class: 'card cf-item' });
      const more = U().el('button', { class: 'cf-more', html: U().icon('more', 18), title: '更多操作' });
      more.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(more, f); });
      const head = U().el('div', { class: 'cf-head' },
        U().el('div', { class: 'cf-name', text: f.name }),
        U().el('span', { class: 'cf-type', text: TYPE_LABEL[f.type] || f.type }),
        more);
      card.appendChild(head);
      if (f.type === 'select') {
        const tags = U().el('div', { class: 'cf-tags' });
        const opts = f.options || [];
        if (!opts.length) tags.appendChild(U().el('span', { class: 'cf-empty', text: '暂无选项' }));
        opts.forEach((o) => tags.appendChild(U().el('span', { class: 'cf-tag', text: o.name })));
        card.appendChild(tags);
      }
      return card;
    }

    // —— 编辑态卡片（改动先落在 draft，保存才写回）——
    function editCard(f) {
      const draft = { name: f.name, type: f.type, options: (f.options || []).map((o) => ({ id: o.id, name: o.name })) };
      const card = U().el('div', { class: 'card cf-item editing' });

      const nameI = U().el('input', { class: 'input cf-edit-name', value: draft.name, placeholder: '属性名称' });
      nameI.addEventListener('input', () => { draft.name = nameI.value; });
      const typeSel = makeSelect(TYPES, draft.type, (v) => { draft.type = v; renderTags(); });

      const tagsBox = U().el('div', { class: 'cf-tags' });
      const addRow = U().el('div', { class: 'cf-opt-add' });
      const optI = U().el('input', { class: 'input', placeholder: '添加选项，如「手」' });
      const addBtn = U().el('button', { class: 'btn', text: '添加' });

      function addOption() {
        const v = optI.value.trim(); if (!v) return;
        draft.options.push({ id: App.storage.uid(), name: v });
        optI.value = ''; renderTags(); optI.focus();
      }
      addBtn.addEventListener('click', addOption);
      optI.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } });

      function renderTags() {
        U().clear(tagsBox);
        if (!draft.options.length) tagsBox.appendChild(U().el('span', { class: 'cf-empty', text: '暂无选项，在下方添加' }));
        draft.options.forEach((o) => {
          const x = U().el('button', { class: 'cf-tag-x', html: U().icon('x', 12), title: '删除该选项' });
          x.addEventListener('click', () => { draft.options = draft.options.filter((k) => k.id !== o.id); renderTags(); });
          tagsBox.appendChild(U().el('span', { class: 'cf-tag editable' }, U().el('span', { text: o.name }), x));
        });
        const isSelect = draft.type === 'select';
        tagsBox.style.display = isSelect ? '' : 'none';
        addRow.style.display = isSelect ? '' : 'none';
      }

      addRow.appendChild(optI);
      addRow.appendChild(addBtn);

      const cancelBtn = U().el('button', { class: 'btn', text: '取消' });
      cancelBtn.addEventListener('click', () => { editingId = null; rebuild(); });
      const saveBtn = U().el('button', { class: 'btn primary', text: '保存' });
      saveBtn.addEventListener('click', () => {
        const n = draft.name.trim();
        if (!n) { U().toast('请填写属性名称', 'err'); return; }
        f.name = n; f.type = draft.type; f.options = draft.options;
        persistDomain(domain);
        editingId = null; rebuild(); U().toast('已保存', 'ok');
      });

      card.appendChild(U().el('div', { class: 'cf-edit-row' }, nameI, typeSel));
      card.appendChild(tagsBox);
      card.appendChild(addRow);
      card.appendChild(U().el('div', { class: 'cf-actions' }, cancelBtn, saveBtn));
      renderTags();
      return card;
    }

    function rebuild() {
      closeMenu();
      closeSelMenu();
      U().clear(box);
      // ① 新增区（置顶）
      const aName = U().el('input', { class: 'input', placeholder: '属性名称，如「身体部位」' });
      const aType = makeSelect(TYPES, 'select');
      const aBtn = U().el('button', { class: 'btn primary', text: '添加属性' });
      aBtn.addEventListener('click', () => {
        const n = aName.value.trim();
        if (!n) { U().toast('请填写名称', 'err'); return; }
        const f = App.domains.makeField(n, domain.customFields.length);
        f.type = aType.getValue();
        domain.customFields.push(f); persistDomain(domain); rebuild();
      });
      box.appendChild(U().el('div', { class: 'row cf-add-row' }, aName, aType, aBtn));

      // ② 属性列表（新到旧）
      if (!domain.customFields.length) {
        box.appendChild(U().el('div', { class: 'muted cf-hint', text: '暂无自定义属性。例如可添加「身体部位」(选项:手/脚)，添加后在记录编辑、列表、搜索、筛选、仪表盘中联动。' }));
      } else {
        domain.customFields.slice().reverse().forEach((f) => {
          box.appendChild(editingId === f.id ? editCard(f) : viewCard(f));
        });
      }
    }

    rebuild();
    content.appendChild(U().el('div', { class: 'section-title', text: '自定义属性（动态表单）' }));
    content.appendChild(box);
  }

  // —— 仪表盘组件（按领域隔离）——
  function renderDash(content) {
    const domain = App.state.currentDomain();
    if (!domain) { content.appendChild(U().el('div', { class: 'empty-state', text: '请先添加领域' })); return; }
    if (!domain.dashboardWidgets) domain.dashboardWidgets = App.domains.DEFAULT_WIDGETS.map((w) => Object.assign({}, w));
    let widgets = domain.dashboardWidgets;
    const save = async () => { await persistDomain(domain); U().toast('已保存仪表盘配置', 'ok'); };

    const list = U().el('div', { class: 'sortable' });
    // 标星强调：★ = 该组件在仪表盘上使用主题强调色的实色卡片（高对比文字）；☆ = 保持毛玻璃
    function makeStar(w) {
      const btn = U().el('button', { class: 'icon-btn star-btn' + (w.starred ? ' on' : ''), html: U().icon(w.starred ? 'starFill' : 'star', 16) });
      function paint() {
        btn.classList.toggle('on', !!w.starred);
        btn.innerHTML = U().icon(w.starred ? 'starFill' : 'star', 16);
        btn.title = w.starred ? '取消标星强调' : '标星强调：在仪表盘用强调色实色卡片';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', w.starred ? 'true' : 'false');
      }
      paint();
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        w.starred = !w.starred;
        paint();
        await persistDomain(domain);
      });
      return btn;
    }
    function render() {
      U().clear(list);
      // 只列内置组件；自定义统计项改为下方卡片（见 customBox）
      const ids = [];
      widgets.forEach((w, i) => { if (!w.custom) ids.push(i); });
      ids.forEach((i, k) => {
        const w = widgets[i];
        const def = App.dashboard.defForWidget(w);
        const up = U().el('button', { class: 'icon-btn', html: U().icon('chevron', 18), style: { transform: 'rotate(180deg)' } });
        const down = U().el('button', { class: 'icon-btn', html: U().icon('chevron', 18) });
        const prevI = k > 0 ? ids[k - 1] : -1;
        const nextI = k < ids.length - 1 ? ids[k + 1] : -1;
        if (prevI < 0) up.disabled = true;
        if (nextI < 0) down.disabled = true;
        up.addEventListener('click', () => { if (prevI < 0) return; const t = widgets[prevI]; widgets[prevI] = widgets[i]; widgets[i] = t; render(); });
        down.addEventListener('click', () => { if (nextI < 0) return; const t = widgets[nextI]; widgets[nextI] = widgets[i]; widgets[i] = t; render(); });
        const chk = U().el('input', { type: 'checkbox' }); chk.checked = !!w.enabled; chk.addEventListener('change', () => { w.enabled = chk.checked; });
        const label = def ? def.label : w.key;
        const row = U().el('div', { class: 'sort-item', draggable: 'true' }, U().el('span', { class: 'drag', html: U().icon('grip', 18) }), U().el('span', { class: 'si-label', text: label }), makeStar(w), chk);
        row.appendChild(up); row.appendChild(down);
        // 拖拽排序
        row.addEventListener('dragstart', (e) => { row.classList.add('dragging'); e.dataTransfer.setData('text/plain', String(i)); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); });
        row.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); const to = i; if (!isFinite(from) || from === to) return; const item = widgets.splice(from, 1)[0]; if (!item) return; widgets.splice(to, 0, item); render(); });
        list.appendChild(row);
      });
    }
    render();

    // —— 自定义统计项：卡片化（展示态 / 编辑态，最简状态机 editingKey；配置存于 w.custom）——
    const C_FIELDS = [['records', '记录数'], ['time', '投入时长'], ['income', '收入'], ['expense', '支出']];
    const C_RANGES = [['all', '不限时间'], ['month', '本月'], ['30d', '近30天'], ['year', '今年'], ['custom', '自定义时间段']];
    const C_RANGE_LABEL = { all: '不限时间', month: '本月', '30d': '近30天', year: '今年', custom: '自定义时间段' };
    let editingKey = null;  // null = 全部展示态
    let newKey = null;      // 本次新建、尚未保存的项（取消时移除）
    let menuCleanup = null;
    const customBox = U().el('div', { class: 'col goal-list' });

    function closeMenu() { if (menuCleanup) { const fn = menuCleanup; menuCleanup = null; fn(); } }
    function cFieldLabel(k) { const f = C_FIELDS.find((x) => x[0] === k); return f ? f[1] : '记录数'; }

    function customValueText(w) {
      const def = App.dashboard.defForWidget(w);
      if (!def || !def.compute) return '—';
      const r = def.compute(domain, App.state.data.records);
      return String(r.value) + (r.unit || '');
    }
    function summaryOf(w) {
      const c = w.custom || {};
      const parts = [];
      if (c.catFilter) { const cat = domain.categories.find((x) => x.id === c.catFilter); if (cat) parts.push(cat.name); }
      if (c.tagFilter) { const t = domain.tags.find((x) => x.id === c.tagFilter); if (t) parts.push('#' + t.name); }
      if (c.cfFilter) {
        const f = (domain.customFields || []).find((x) => x.id === c.cfFilter);
        if (f) { const o = (f.options || []).find((x) => x.id === c.cfValue); parts.push(f.name + (o ? '=' + o.name : '')); }
      }
      if (c.timeRange && c.timeRange !== 'all') parts.push(c.timeRange === 'custom' ? ((c.startDate || '…') + ' ~ ' + (c.endDate || '…')) : C_RANGE_LABEL[c.timeRange]);
      return parts.length ? parts.join(' · ') : '不限条件';
    }

    // 卡片右上「三个点」菜单：编辑 / 显示隐藏 / 删除
    function openCardMenu(anchor, w) {
      closeMenu();
      const panel = U().el('div', { class: 'popmenu cf-menu' });
      let closed = false;
      function close() {
        if (closed) return; closed = true;
        panel.remove();
        document.removeEventListener('pointerdown', onDoc, true);
        window.removeEventListener('scroll', close, true);
        if (menuCleanup === close) menuCleanup = null;
      }
      const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
      menuCleanup = close;

      const editItem = U().el('button', { class: 'pm-item', html: U().icon('edit', 16) + '<span>编辑</span>' });
      editItem.addEventListener('click', () => { close(); editingKey = w.key; newKey = null; rebuildCustom(); });
      const toggleItem = U().el('button', { class: 'pm-item', html: U().icon('eye', 16) + '<span>' + (w.enabled === false ? '在仪表盘显示' : '在仪表盘隐藏') + '</span>' });
      toggleItem.addEventListener('click', async () => {
        close();
        w.enabled = w.enabled === false;
        await persistDomain(domain);
        rebuildCustom();
      });
      const delItem = U().el('button', { class: 'pm-item danger', html: U().icon('trash', 16) + '<span>删除</span>' });
      delItem.addEventListener('click', async () => {
        close();
        if (!(await U().confirmDialog('删除该自定义统计项？', { okLabel: '删除', danger: true }))) return;
        const idx = widgets.findIndex((x) => x.key === w.key);
        if (idx >= 0) widgets.splice(idx, 1);
        await persistDomain(domain);
        if (editingKey === w.key) editingKey = null;
        rebuildCustom();
      });
      panel.appendChild(editItem);
      panel.appendChild(toggleItem);
      panel.appendChild(delItem);
      document.body.appendChild(panel);
      const r = anchor.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + 'px';
      panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
      window.addEventListener('scroll', close, true);
    }

    // 展示态：名称 + 数值 + 条件摘要
    function viewCustomCard(w) {
      const card = U().el('div', { class: 'card custom-card' });
      const more = U().el('button', { class: 'cf-more', html: U().icon('more', 18), title: '更多操作' });
      more.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(more, w); });
      card.appendChild(U().el('div', { class: 'cf-head' },
        U().el('div', { class: 'custom-name' },
          U().el('span', { class: 'custom-name-txt', text: w.label || '未命名统计' }),
          w.enabled === false ? U().el('span', { class: 'custom-flag', text: '已隐藏' }) : null),
        makeStar(w),
        more));
      card.appendChild(U().el('div', { class: 'custom-val', text: customValueText(w) }));
      card.appendChild(U().el('div', { class: 'custom-sub', text: cFieldLabel((w.custom || {}).field) + ' · ' + summaryOf(w) }));
      return card;
    }

    // 编辑态：改动先落 draft，保存才写回 w.custom
    function editCustomCard(w) {
      const c = w.custom || {};
      const draft = {
        label: w.label || '', field: c.field || 'records',
        catFilter: c.catFilter || '', tagFilter: c.tagFilter || '',
        cfFilter: c.cfFilter || '', cfValue: c.cfValue || '',
        timeRange: c.timeRange || 'all', startDate: c.startDate || '', endDate: c.endDate || '',
      };
      const card = U().el('div', { class: 'card custom-card editing' });

      const nameI = U().el('input', { class: 'input', value: draft.label, placeholder: '统计名称，如「商稿收入」' });
      nameI.addEventListener('input', () => { draft.label = nameI.value; });

      const fieldSel = makeSelect(C_FIELDS, draft.field, (v) => { draft.field = v; });
      const catSel = makeSelect([['', '不限分类']].concat(domain.categories.map((x) => [x.id, x.name])), draft.catFilter, (v) => { draft.catFilter = v; });
      const tagSel = makeSelect([['', '不限标签']].concat(domain.tags.map((x) => [x.id, x.name])), draft.tagFilter, (v) => { draft.tagFilter = v; });
      const cfList = (domain.customFields || []).filter((f) => f.type === 'select');
      const cfSel = makeSelect([['', '不限自定义属性']].concat(cfList.map((x) => [x.id, x.name])), draft.cfFilter, (v) => { draft.cfFilter = v; draft.cfValue = ''; paintValueField(); });

      const cfValWrap = U().el('div', { class: 'goal-field' });
      function paintValueField() {
        U().clear(cfValWrap);
        cfValWrap.appendChild(U().el('label', { text: '属性选项' }));
        const f = cfList.find((x) => x.id === draft.cfFilter);
        const opts = [['', '不限选项']].concat((f ? (f.options || []) : []).map((o) => [o.id, o.name]));
        cfValWrap.appendChild(makeSelect(opts, draft.cfValue, (v) => { draft.cfValue = v; }));
      }
      paintValueField();

      const rangeSel = makeSelect(C_RANGES, draft.timeRange, (v) => { draft.timeRange = v; paintDates(); });
      const dateWrap = U().el('div', { class: 'goal-grid' });
      function paintDates() {
        U().clear(dateWrap);
        const isCustom = draft.timeRange === 'custom';
        dateWrap.style.display = isCustom ? '' : 'none';
        if (!isCustom) return;
        const sBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
        const eBtn = U().el('button', { class: 'btn btn-date', type: 'button' });
        function paintS() { sBtn.textContent = draft.startDate || '未选择开始日期'; sBtn.classList.toggle('empty', !draft.startDate); }
        function paintE() { eBtn.textContent = draft.endDate || '未选择结束日期'; eBtn.classList.toggle('empty', !draft.endDate); }
        paintS(); paintE();
        sBtn.addEventListener('click', () => U().openCalendar({ value: draft.startDate || null, onSelect: (v) => { draft.startDate = v; paintS(); } }));
        eBtn.addEventListener('click', () => U().openCalendar({ value: draft.endDate || null, onSelect: (v) => { draft.endDate = v; paintE(); } }));
        dateWrap.appendChild(U().el('div', { class: 'goal-field' }, U().el('label', { text: '开始日期' }), sBtn));
        dateWrap.appendChild(U().el('div', { class: 'goal-field' }, U().el('label', { text: '结束日期' }), eBtn));
      }
      paintDates();

      card.appendChild(U().el('div', { class: 'goal-edit' },
        U().el('div', { class: 'goal-field' }, U().el('label', { text: '统计名称' }), nameI),
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '统计字段' }), fieldSel),
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '时间段' }), rangeSel)),
        dateWrap,
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '分类筛选' }), catSel),
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '标签筛选' }), tagSel)),
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '属性筛选' }), cfSel),
          cfValWrap)));

      const cancelBtn = U().el('button', { class: 'btn', text: '取消' });
      cancelBtn.addEventListener('click', () => {
        if (newKey && newKey === w.key) { const idx = widgets.findIndex((x) => x.key === w.key); if (idx >= 0) widgets.splice(idx, 1); }
        newKey = null; editingKey = null; rebuildCustom();
      });
      const saveBtn = U().el('button', { class: 'btn primary', text: '保存' });
      saveBtn.addEventListener('click', async () => {
        const label = draft.label.trim();
        if (!label) { U().toast('请填写统计名称', 'err'); return; }
        if (draft.timeRange === 'custom') {
          if (!draft.startDate || !draft.endDate) { U().toast('请选择完整的起止日期', 'err'); return; }
          if (draft.startDate > draft.endDate) { U().toast('开始日期不能晚于结束日期', 'err'); return; }
        }
        w.label = label;
        w.custom = {
          field: draft.field, catFilter: draft.catFilter || null, tagFilter: draft.tagFilter || null,
          cfFilter: draft.cfFilter || null, cfValue: draft.cfValue || null,
          timeRange: draft.timeRange, startDate: draft.startDate || '', endDate: draft.endDate || '', label,
        };
        await persistDomain(domain);
        newKey = null; editingKey = null;
        rebuildCustom(); U().toast('已保存', 'ok');
      });
      card.appendChild(U().el('div', { class: 'cf-actions' }, cancelBtn, saveBtn));
      return card;
    }

    function addCustom() {
      const label = '新统计项';
      const w = {
        key: 'custom_' + App.storage.uid(), label, enabled: true,
        custom: { field: 'records', catFilter: null, tagFilter: null, cfFilter: null, cfValue: null, timeRange: 'all', startDate: '', endDate: '', label },
      };
      widgets.push(w);
      editingKey = w.key; newKey = w.key;
      rebuildCustom();
    }

    function rebuildCustom() {
      closeMenu(); closeSelMenu();
      U().clear(customBox);
      const customs = widgets.filter((w) => w.custom);
      if (!customs.length) {
        customBox.appendChild(U().el('div', { class: 'muted cf-hint', text: '暂无自定义统计项。例如新建「商稿收入」：统计字段=收入，分类=商稿，时间段=本月。' }));
      } else {
        customs.forEach((w) => customBox.appendChild(editingKey === w.key ? editCustomCard(w) : viewCustomCard(w)));
      }
      const addBtn = U().el('button', { class: 'btn block', html: U().icon('plus', 18) + '<span>新增自定义统计项</span>' });
      addBtn.addEventListener('click', addCustom);
      customBox.appendChild(addBtn);
    }
    rebuildCustom();

    const saveBtn = U().el('button', { class: 'btn primary block', text: '保存仪表盘配置' });
    saveBtn.addEventListener('click', save);

    // 列表卡片显示字段（记录名称 / 日期固定显示，不可取消；这里只放可选字段）
    const cardFieldsBox = U().el('div', { class: 'card-fields' });
    function renderCardFields() {
      U().clear(cardFieldsBox);
      if (!domain.cardFields) domain.cardFields = [];
      const opts = [
        { key: 'time', label: '时长' },
        { key: 'income', label: '收入' },
        { key: 'expense', label: '支出' },
        { key: 'tags', label: '标签' },
        { key: 'category', label: '分类' },
      ].concat((domain.customFields || []).map((f) => ({ key: f.id, label: f.name })));
      opts.forEach((o) => {
        const on = (domain.cardFields || []).includes(o.key);
        const chip = U().el('span', { class: 'chip selectable' + (on ? ' active' : ''), text: o.label });
        chip.addEventListener('click', () => {
          domain.cardFields = domain.cardFields || [];
          if (domain.cardFields.includes(o.key)) domain.cardFields = domain.cardFields.filter((x) => x !== o.key);
          else domain.cardFields.push(o.key);
          persistDomain(domain); renderCardFields();
        });
        cardFieldsBox.appendChild(chip);
      });
    }
    renderCardFields();

    content.appendChild(U().el('div', { class: 'section-title', text: '组件（勾选显示 · 箭头/拖拽排序）' }));
    content.appendChild(list);
    content.appendChild(U().el('div', { class: 'section-title', style: { marginTop: '20px' }, text: '自定义统计项（点击 ⋯ 编辑）' }));
    content.appendChild(customBox);
    content.appendChild(U().el('div', { style: { height: '14px' } }));
    content.appendChild(saveBtn);
    content.appendChild(U().el('div', { class: 'section-title', style: { marginTop: '20px' }, text: '列表卡片附加字段' }));
    content.appendChild(U().el('div', { class: 'muted', style: { fontSize: '0.75rem', marginBottom: '10px' }, text: '记录名称与日期固定显示；下面勾选需要额外展示的字段，默认全部不勾选。' }));
    content.appendChild(cardFieldsBox);
  }

  // —— 目标（多目标并存 · 卡片化：展示态 / 编辑态，最简状态机 editingId）——
  function renderGoal(content) {
    const domain = App.state.currentDomain();
    if (!domain) { content.appendChild(U().el('div', { class: 'empty-state', text: '请先添加领域' })); return; }
    if (!domain.goals) domain.goals = [App.domains.makeGoal('目标', 'records', 20, 0)];

    const METRICS = [['records', '记录数'], ['hours', '投入小时'], ['income', '收入金额'], ['expense', '支出金额']];
    const METRIC_LABEL = { records: '记录数', hours: '投入小时', income: '收入金额', expense: '支出金额' };
    const MODES = [['auto', '自动统计'], ['manual', '手动打卡']];
    const MODE_LABEL = { auto: '自动统计', manual: '手动打卡' };
    const STYLES = [['bar', '条形'], ['ring', '圆环']];

    let editingId = null;    // null = 全部展示态
    let menuCleanup = null;  // 已打开菜单的关闭函数
    const list = U().el('div', { class: 'col goal-list' });

    function closeMenu() { if (menuCleanup) { const fn = menuCleanup; menuCleanup = null; fn(); } }

    // 当前进度（与仪表盘同口径）
    function currentOf(g) {
      if (g.mode === 'manual' || g.valueManual) return Number(g.value) || 0;
      const recs = App.state.data.records.filter((r) => r.domainId === domain.id);
      if (g.metric === 'records') return recs.length;
      if (g.metric === 'hours') return recs.reduce((a, x) => a + (Number(x.timeSpentMin) || 0), 0) / 60;
      if (g.metric === 'income') return recs.reduce((a, x) => a + (Number(x.income) || 0), 0);
      if (g.metric === 'expense') return recs.reduce((a, x) => a + (Number(x.expense) || 0), 0);
      return 0;
    }
    function numText(g, v) {
      if (g.metric === 'income' || g.metric === 'expense') return U().fmtMoney(v);
      if (g.metric === 'hours') return String(Math.round(v * 10) / 10);
      return String(Math.round(v));
    }
    function unitOf(g) { return g.metric === 'hours' ? ' h' : (g.metric === 'records' ? ' 条' : ''); }

    function buildRing(pct, color, pctTxt, trackColor) {
      const wrap = U().el('div', { class: 'goal-ring' });
      const deg = Math.max(0, Math.min(100, Math.round(pct * 100)));
      // 用内联 style 而不是 SVG 属性：CSS 里的 stroke 优先级高于属性，会被 .gr-track 覆盖掉
      const track = trackColor || 'rgba(127,127,127,0.26)';
      wrap.innerHTML = '<svg viewBox="0 0 36 36">'
        + '<circle class="gr-track" cx="18" cy="18" r="15.9155" style="stroke:' + track + '"/>'
        + '<circle class="gr-prog" cx="18" cy="18" r="15.9155" style="stroke:' + color + ';stroke-dasharray:' + deg + ' ' + (100 - deg) + '"/>'
        + '</svg><span class="gr-pct">' + pctTxt + '</span>';
      return wrap;
    }

    // 目标配色：颜色可以作用在「进度条/圆环」上，也可以铺满「卡片背景」。
    // 卡片背景上色时一律用不透明实色，文字与进度条改用「与之对比」的墨色，
    // 否则纯色背景上的同色进度条会糊成一片（旧版就是这个问题）。
    function inkOf(bg) { return App.themes.textOn(bg); }          // '#f2f3f7' 或 '#1b2027'
    function isInkDark(ink) { return App.themes.luminance(ink) < 0.5; }
    function inkSoft(ink, a) { return isInkDark(ink) ? 'rgba(20,24,32,' + a + ')' : 'rgba(255,255,255,' + a + ')'; }

    // 卡片右上「三个点」菜单：编辑 / 删除
    function openCardMenu(anchor, g) {
      closeMenu();
      const panel = U().el('div', { class: 'popmenu cf-menu' });
      let closed = false;
      function close() {
        if (closed) return; closed = true;
        panel.remove();
        document.removeEventListener('pointerdown', onDoc, true);
        window.removeEventListener('scroll', close, true);
        if (menuCleanup === close) menuCleanup = null;
      }
      const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
      menuCleanup = close;

      const editItem = U().el('button', { class: 'pm-item', html: U().icon('edit', 16) + '<span>编辑</span>' });
      editItem.addEventListener('click', () => { close(); editingId = g.id; rebuild(); });
      const delItem = U().el('button', { class: 'pm-item danger', html: U().icon('trash', 16) + '<span>删除</span>' });
      delItem.addEventListener('click', async () => {
        close();
        if (!(await U().confirmDialog('删除该目标？', { okLabel: '删除', danger: true }))) return;
        domain.goals = domain.goals.filter((x) => x.id !== g.id);
        persistDomain(domain);
        if (editingId === g.id) editingId = null;
        rebuild();
      });
      panel.appendChild(editItem);
      panel.appendChild(delItem);
      document.body.appendChild(panel);
      const r = anchor.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + 'px';
      panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc, true); }, 0);
      window.addEventListener('scroll', close, true);
    }

    // —— 手动打卡：+1 直接累加；+N 走居中弹窗 ——
    async function bumpGoal(g, n) {
      const v = Number(n) || 0;
      if (v <= 0) return;
      g.value = (Number(g.value) || 0) + v;
      await persistDomain(domain);
      rebuild();
      U().toast('已打卡 +' + v, 'ok');
    }

    function openIncDialog(g) {
      U().promptNumber({
        title: '添加数值',
        tip: '当前进度：' + (Number(g.value) || 0) + ' / ' + (Number(g.target) || 0),
        onConfirm: (v) => bumpGoal(g, v),
      });
    }

    // —— 展示态：名称 + 「当前 / 目标」（同一行）+ 大圆环/进度条 + 手动打卡 ——
    function viewCard(g) {
      const color = g.color || App.domains.GOAL_PALETTE[0];
      const tintCard = g.colorTarget === 'card';      // 上色对象：进度条（默认）/ 卡片背景
      const card = U().el('div', { class: 'card goal-card' + (tintCard ? ' goal-solid' : '') });
      // 背景上色 → 实色铺满；进度条/圆环/文字全部改用与之对比的墨色
      let ink = color;                         // 圆环 / 进度条填充色（默认就是目标色）
      let trackColor = '';                     // 进度条轨道 / 圆环底环
      if (tintCard) {
        ink = inkOf(color);
        trackColor = inkSoft(ink, 0.28);       // 半透明墨色轨道：既看得见，又不会压过填充
        card.style.background = color;         // 不透明实色（同时清掉原有高光渐变）
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
      const more = U().el('button', { class: 'cf-more', html: U().icon('more', 18), title: '更多操作' });
      more.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(more, g); });

      const cur = currentOf(g);
      const target = Number(g.target) || 0;
      const pct = target > 0 ? Math.max(0, Math.min(1, cur / target)) : 0;
      const pctTxt = Math.round(pct * 100) + '%';

      // 头部：名称（左） + 进度数字（右，同一行） + 三点
      card.appendChild(U().el('div', { class: 'cf-head goal-head' },
        U().el('div', { class: 'goal-name' },
          U().el('span', { class: 'goal-dot', style: { background: tintCard ? ink : color } }),
          U().el('span', { class: 'goal-name-txt', text: g.name || '未命名目标' })),
        U().el('span', { class: 'goal-num', text: numText(g, cur) + ' / ' + numText(g, target) + unitOf(g) }),
        more));

      if (g.style === 'ring') {
        card.appendChild(buildRing(pct, ink, pctTxt, trackColor));
      } else {
        card.appendChild(U().el('div', { class: 'goal-bar-row' },
          U().el('div', { class: 'goal-bar', style: tintCard ? { background: trackColor } : null },
            U().el('span', { style: { width: (pct * 100) + '%', background: ink } })),
          U().el('span', { class: 'goal-pct', text: pctTxt })));
      }

      card.appendChild(U().el('div', { class: 'goal-sub', text: (METRIC_LABEL[g.metric] || '记录数') + ' · ' + (MODE_LABEL[g.mode] || '自动统计') }));

      // 手动打卡：与仪表盘完全一致的小胶囊按钮（紧凑、只包文字、居中）
      if (g.mode === 'manual') {
        const actions = U().el('div', { class: 'gr-actions' });
        const plus1 = U().el('button', { class: 'btn tiny', text: '+1' });
        plus1.addEventListener('click', () => { bumpGoal(g, 1); });
        const plusN = U().el('button', { class: 'btn tiny primary', text: '+n' });
        // +n 的颜色跟随目标配色：上色到进度条时=目标色底 + 对比字；上色到卡片时=墨色底 + 反相字
        plusN.style.background = ink;
        plusN.style.borderColor = ink;
        plusN.style.color = App.themes.textOn(ink);
        plusN.style.fontWeight = '800';
        plusN.addEventListener('click', () => { openIncDialog(g); });
        actions.appendChild(plus1);
        actions.appendChild(plusN);
        card.appendChild(actions);
      }
      return card;
    }

    // —— 编辑态（改动先落在 draft，保存才写回）——
    function editCard(g) {
      const computedNow = Math.round((Number(currentOf(g)) || 0) * 100) / 100; // 卡片上真实显示的进度
      const draftedManual = !!g.valueManual || g.mode === 'manual';
      const draft = {
        name: g.name || '', metric: g.metric || 'records', mode: g.mode || 'auto',
        target: Number(g.target) || 1, style: g.style || 'bar',
        color: g.color || App.domains.GOAL_PALETTE[0],
        colorTarget: g.colorTarget === 'card' ? 'card' : 'bar',
        // 回显「当前进度」：手动/已手填覆盖 → 取存储值；否则取实时算出值（绝不再默认 0）
        value: draftedManual ? (Number(g.value) || 0) : computedNow,
      };
      let valueTouched = false; // 用户是否真的改过「当前进度」
      const card = U().el('div', { class: 'card goal-card editing' });

      const nameI = U().el('input', { class: 'input', value: draft.name, placeholder: '目标名称' });
      nameI.addEventListener('input', () => { draft.name = nameI.value; });
      const metricSel = makeSelect(METRICS, draft.metric, (v) => { draft.metric = v; });
      const targetI = U().el('input', { class: 'input', type: 'number', min: '1', value: draft.target });
      targetI.addEventListener('input', () => { draft.target = Number(targetI.value) || 1; });
      // 当前进度：无论推进方式如何，始终允许手动修改（解除只读限制）
      const valueI = U().el('input', { class: 'input', type: 'number', min: '0', step: 'any', value: draft.value });
      valueI.addEventListener('input', () => {
        const raw = Number(valueI.value);
        draft.value = isFinite(raw) && raw >= 0 ? raw : 0;
        valueTouched = true;
      });
      const valueHint = U().el('div', { class: 'goal-hint', text: '手动填写后会以你填的数值为准；自动统计目标在你未手填时仍由记录实时计算。' });

      const modeSel = makeSelect(MODES, draft.mode, (v) => {
        draft.mode = v;
        // 切到手动打卡且没手填过时，继承卡片当前显示值，避免从 0 跳变
        if (v === 'manual' && !valueTouched && !g.valueManual) { draft.value = computedNow; valueI.value = draft.value; }
      });

      const styleSel = makeSelect(STYLES, draft.style, (v) => { draft.style = v; });
      // 颜色：改用应用内的小浮层取色器（原生 input[type=color] 在手机上会弹出跑到屏幕外）
      const colorDot = U().el('span', { class: 'ct-dot', style: { background: draft.color } });
      const colorHex = U().el('span', { class: 'ct-hex', text: String(draft.color).toUpperCase() });
      const colorBtn = U().el('button', { type: 'button', class: 'color-trigger' }, colorDot, colorHex);
      colorBtn.addEventListener('click', () => {
        U().openColorPicker({
          anchor: colorBtn, value: draft.color,
          onInput: (h) => { draft.color = h; colorDot.style.background = h; colorHex.textContent = h.toUpperCase(); },
        });
      });

      // 上色对象：应用到进度条 / 应用到卡片背景
      const targetSeg = U().el('div', { class: 'seg', role: 'radiogroup' });
      const segBtns = [];
      [['bar', '进度条'], ['card', '卡片背景']].forEach(([v, t]) => {
        const b = U().el('button', { type: 'button', class: 'seg-item', role: 'radio', text: t });
        b.addEventListener('click', () => { if (draft.colorTarget === v) return; draft.colorTarget = v; syncTarget(); });
        segBtns.push({ btn: b, value: v });
        targetSeg.appendChild(b);
      });
      function syncTarget() { segBtns.forEach((it) => { const on = it.value === draft.colorTarget; it.btn.classList.toggle('active', on); it.btn.setAttribute('aria-checked', on ? 'true' : 'false'); }); }
      syncTarget();

      card.appendChild(U().el('div', { class: 'goal-edit' },
        U().el('div', { class: 'goal-field' }, U().el('label', { text: '目标名称' }), nameI),
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '统计方式' }), metricSel),
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '推进方式' }), modeSel)),
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '目标总数' }), targetI),
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '当前进度' }), valueI)),
        valueHint,
        U().el('div', { class: 'goal-grid' },
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '进度样式' }), styleSel),
          U().el('div', { class: 'goal-field' }, U().el('label', { text: '颜色' }), colorBtn)),
        U().el('div', { class: 'goal-field' }, U().el('label', { text: '上色对象' }), targetSeg)));

      const cancelBtn = U().el('button', { class: 'btn', text: '取消' });
      cancelBtn.addEventListener('click', () => { editingId = null; rebuild(); });
      const saveBtn = U().el('button', { class: 'btn primary', text: '保存' });
      saveBtn.addEventListener('click', () => {
        const n = draft.name.trim();
        if (!n) { U().toast('请填写目标名称', 'err'); return; }
        g.name = n; g.metric = draft.metric; g.mode = draft.mode;
        g.target = draft.target; g.style = draft.style; g.color = draft.color;
        g.colorTarget = draft.colorTarget;
        // 当前进度：始终以你填写的值为准并保存；自动目标未手填时仍按记录实时计算
        g.value = Math.max(0, draft.value);
        g.valueManual = (draft.mode === 'manual') || valueTouched;
        persistDomain(domain);
        editingId = null; rebuild(); U().toast('已保存', 'ok');
      });
      card.appendChild(U().el('div', { class: 'cf-actions' }, cancelBtn, saveBtn));
      return card;
    }

    function rebuild() {
      closeMenu();
      closeSelMenu();
      U().clear(list);
      domain.goals.forEach((g) => list.appendChild(editingId === g.id ? editCard(g) : viewCard(g)));
      const aBtn = U().el('button', { class: 'btn primary block', html: U().icon('plus', 18) + '<span>新增目标</span>' });
      aBtn.addEventListener('click', () => {
        const g = App.domains.makeGoal('新目标', 'records', 20, domain.goals.length);
        domain.goals.push(g); persistDomain(domain);
        editingId = g.id; rebuild();
      });
      list.appendChild(aBtn);
    }

    rebuild();
    content.appendChild(U().el('div', { class: 'section-title', text: '目标（可并存多个，独立配色）' }));
    content.appendChild(list);
  }

  // —— 主题与换肤（含日间/夜间/跟随系统）——
  // 注意：saveSettings 会替换 settings 对象引用，绝不能缓存旧对象，否则会“点两次才生效”
  const live = () => App.state.data.settings;
  const reapply = () => App.themes.applyFromSettings(live());
  function systemIsDark() { return App.themes.systemIsDark ? App.themes.systemIsDark() : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function sideIsEffective(side) {
    const ap = live().appearance || 'auto';
    if (ap === 'auto') return side === (systemIsDark() ? 'night' : 'day');
    return ap === side;
  }

  // 外观模式：真·单选（任意时刻只有一个高亮），点击即时反馈
  function segControl(value, onChange) {
    const wrap = U().el('div', { class: 'seg', role: 'radiogroup' });
    const items = [];
    const sync = (v) => items.forEach((it) => { const on = it.value === v; it.btn.classList.toggle('active', on); it.btn.setAttribute('aria-checked', on ? 'true' : 'false'); });
    [['auto', '跟随系统'], ['day', '日间模式'], ['night', '夜间模式']].forEach(([v, t]) => {
      const btn = U().el('button', { type: 'button', class: 'seg-item', role: 'radio', text: t });
      btn.addEventListener('click', () => { if (value === v) return; value = v; sync(v); onChange(v); });
      items.push({ btn: btn, value: v });
      wrap.appendChild(btn);
    });
    sync(value);
    return wrap;
  }

  function themeSwatch(opt, active, onPick, onEdit) {
    const txtColor = opt.text || App.themes.textOn(opt.bg);
    const accentInk = App.themes.onColor(opt.accent || '#8b9cff');
    const sw = U().el('div', {
      class: 'theme-swatch' + (active ? ' active' : ''), 'data-key': opt.key,
      style: { borderColor: active ? (opt.accent || 'var(--accent)') : 'var(--border)' },
    });
    // 上方约 1/5：强调色带；下方约 4/5：背景色 + 主题名
    sw.appendChild(U().el('div', { class: 'ts-accent', style: { background: opt.accent || 'var(--accent)' } }));
    sw.appendChild(U().el('div', { class: 'ts-bg', style: { background: opt.bg, color: txtColor } },
      U().el('span', { class: 'sw-name', text: opt.name })));
    if (active) sw.appendChild(U().el('span', { class: 'check', html: U().icon('check', 17), style: { color: accentInk } }));
    if (onEdit) {
      const edit = U().el('button', { class: 'sw-edit', html: U().icon('edit', 12), title: '修改颜色' });
      edit.addEventListener('click', (e) => { e.stopPropagation(); onEdit(opt); });
      sw.appendChild(edit);
    }
    sw.addEventListener('click', () => onPick(opt.key));
    return sw;
  }

  // —— 主题改色：不再弹全屏遮罩，改为在页面底部「自定义背景与强调色」区域就地展开 ——
  let themeDraft = null;   // { key, name, bg, accent }：当前正在就地编辑的主题
  // 实时预览态：拖动调色盘时全局已按草稿上色，但一次都没有写存储。
  // 取消 / 切换编辑对象 / 离开主题页时必须还原成「已保存」的主题，避免未保存的颜色看起来像生效了。
  let themePreviewing = false;
  function endThemePreview() { if (!themePreviewing) return; themePreviewing = false; reapply(); }

  function openThemeEditor(opt, content) {
    endThemePreview();     // 换一个主题编辑前，先把上一个草稿的预览还原
    themeDraft = { key: opt.key, name: opt.name, bg: opt.bg || '#15171c', accent: opt.accent || '#8b9cff' };
    renderTheme(content, true);
    const body = content.querySelector('.tie-body');
    const card = body && body.parentElement;
    // 显式滚动窗口（scrollIntoView 会被祖先的 overflow 影响，不稳）；用即时滚动，
    // 平滑滚动在部分 WebView / 后台标签页里不会推进动画，会停在原位。
    // 等到展开动画结束再滚：否则编辑区高度还是 0，文档不够高，会被 clamp 在半路
    if (card) setTimeout(() => {
      const y = card.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0) - 72;
      window.scrollTo(0, Math.max(0, y));
    }, 360);
  }

  // 就地展开的编辑器（高度从 0 平滑长到内容高度，不遮挡页面）
  function themeEditorSection(content, animate) {
    const body = U().el('div', { class: 'tie-body' });
    const card = U().el('div', { class: 'card tie-card' }, body);
    content.appendChild(U().el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '自定义背景与强调色' }));
    content.appendChild(card);

    const d = themeDraft;
    if (!d) {
      const customBtn = U().el('button', { class: 'btn', html: U().icon('edit', 15) + '<span>编辑「自定义」主题</span>' });
      customBtn.addEventListener('click', () => {
        openThemeEditor({ key: 'custom', name: '自定义', bg: live().customBg || '#15171c', accent: live().customAccent || '#8b9cff' }, content);
      });
      body.appendChild(U().el('div', { class: 'tie-rest' },
        U().el('div', { class: 'tie-hint', text: '点任意主题卡片右下角的铅笔，颜色设置会在这里就地展开，不再弹遮罩。' }),
        customBtn));
      return;
    }

    const prev = U().el('div', { class: 'tp-preview' });
    const prevDot = U().el('span', { class: 'tp-dot' });
    const prevTxt = U().el('span', { class: 'tp-txt', text: d.name });
    prev.appendChild(prevDot); prev.appendChild(prevTxt);
    function paintPrev() {
      prev.style.background = d.bg;
      prevDot.style.background = d.accent;
      prevTxt.style.color = App.themes.textOn(d.bg);
    }
    paintPrev();

    // 实时预览：拖动调色盘时立刻把「草稿配色」写进 :root 的 CSS 变量，全站立刻跟着变。
    // 注意这里只改运行时变量，绝不写 localStorage / IndexedDB —— 存储仍只在「覆盖 / 另存」时发生。
    function previewColors() {
      themePreviewing = true; // 标记「当前全局色来自未保存的草稿」
      const preset = App.themes.PRESETS.some((p) => p.key === d.key); // 预设用自身 key，自定义/我的主题统一走 custom
      App.themes.apply(preset ? d.key : 'custom', d.bg, d.accent);
    }

    function colorRow(label, key, fallback) {
      const cur = d[key] || fallback;
      const dot = U().el('span', { class: 'ct-dot', style: { background: cur } });
      const hexEl = U().el('span', { class: 'ct-hex', text: String(cur).toUpperCase() });
      const btn = U().el('button', { type: 'button', class: 'color-trigger' }, dot, hexEl);
      // input（拖动中）与 change（松手/提交）走同一条全局更新路径：
      // 个别 WebView 只稳定发其中一个，两边都绑才不会出现「只有小色块变色」。
      function applyDraft(h) {
        if (h) { d[key] = h; dot.style.background = h; hexEl.textContent = h.toUpperCase(); }
        paintPrev();
        previewColors();
      }
      btn.addEventListener('click', () => {
        U().openColorPicker({
          anchor: btn, value: d[key] || fallback,
          onInput: applyDraft,
          onChange: applyDraft,
        });
      });
      return U().el('div', { class: 'field' }, U().el('label', { text: label }), btn);
    }

    async function overwrite() {
      const key = d.key;
      const saved = (live().customThemes || []).find((t) => t.key === key);
      if (key === 'custom') {
        await App.state.saveSettings({ customBg: d.bg, customAccent: d.accent });
      } else if (saved) {
        const list = live().customThemes.map((t) => (t.key === key ? Object.assign({}, t, { bg: d.bg, accent: d.accent }) : t));
        await App.state.saveSettings({ customThemes: list });
      } else {
        const ov = Object.assign({}, live().themeOverrides || {});
        ov[key] = { bg: d.bg, accent: d.accent };
        await App.state.saveSettings({ themeOverrides: ov });
      }
      themeDraft = null; themePreviewing = false; reapply(); renderTheme(content);
      U().toast('已覆盖「' + d.name + '」', 'ok');
    }

    async function saveAsNew() {
      const n = '我的主题 ' + ((live().customThemes || []).length + 1);
      const ct = { key: 'custom_' + App.storage.uid(), name: n, bg: d.bg, accent: d.accent };
      await App.state.saveSettings({ customThemes: (live().customThemes || []).concat([ct]) });
      themeDraft = null; themePreviewing = false; reapply(); renderTheme(content);
      U().toast('已另存为「' + n + '」', 'ok');
    }

    const cancelBtn = U().el('button', { class: 'btn', text: '取消' });
    // 取消：丢掉草稿，并把刚才实时预览改过的全局变量还原成「已保存」的主题
    cancelBtn.addEventListener('click', () => { themeDraft = null; endThemePreview(); renderTheme(content); });
    const saveNewBtn = U().el('button', { class: 'btn', text: '另存为新预设' });
    saveNewBtn.addEventListener('click', saveAsNew);
    const overwriteBtn = U().el('button', { class: 'btn primary block', text: '覆盖「' + d.name + '」' });
    overwriteBtn.addEventListener('click', overwrite);

    body.appendChild(prev);
    body.appendChild(colorRow('背景颜色', 'bg', '#15171c'));
    body.appendChild(colorRow('强调色（按钮 / 高亮）', 'accent', '#8b9cff'));
    body.appendChild(U().el('div', { class: 'tp-tip', text: '改完可以覆盖这个主题，或另存为一个新的预设。' }));
    body.appendChild(U().el('div', { class: 'tie-actions' },
      overwriteBtn,
      U().el('div', { class: 'tie-actions-row' }, cancelBtn, saveNewBtn)));

    if (animate) {
      // 先压到 0 高，再长到真实高度：setTimeout 而不是 rAF（后台/无头场景 rAF 可能不回调）
      body.style.height = '0px';
      body.style.opacity = '0';
      body.style.overflow = 'hidden';
      setTimeout(() => {
        const h = body.scrollHeight;
        body.style.transition = 'height .3s cubic-bezier(.22,.7,.28,1), opacity .22s ease';
        body.style.height = h + 'px';
        body.style.opacity = '1';
        setTimeout(() => { body.style.height = ''; body.style.overflow = ''; body.style.transition = ''; }, 330);
      }, 20);
    }
  }

  // 外观模式说明文案的实时刷新。
  // 系统切深浅色时设置页不会重渲染，所以由 themes.js 每次主题落地广播 app:theme，
  // 这里就地改文本，绝不重渲染整页（否则会打断就地展开的调色盘）。
  let noteTimer = 0, noteBound = false;
  function syncAppearanceNote() {
    // 每次现取节点：renderTheme 会 U().clear 整块重建，闭包里的旧引用可能已经卸载
    const el = document.querySelector('.ap-note');
    if (!el) return;
    // fresh=true：事件驱动，绕开 350ms 缓存，避免「主题已经是深色、文案还写浅色」的窗口
    const t = App.themes.appearanceNote(live(), true);
    if (el.textContent !== t) el.textContent = t;   // 同值不写，调色盘高频刷色时不做无用写
  }
  function bindThemeLive() {
    if (noteBound) return;   // 全局只注册一次
    noteBound = true;
    // 合并高频广播（拖调色盘时 apply 会被连续调用），120ms 内只刷新一次
    const soon = () => { clearTimeout(noteTimer); noteTimer = setTimeout(syncAppearanceNote, 120); };
    document.addEventListener('app:theme', soon, false);   // 主链路：系统切深浅 → 主题落地 → 广播
    document.addEventListener('resume', soon, false);      // 兜底：从系统设置切回 App
  }

  function renderTheme(content, animateEditor) {
    const cur = live();
    U().clear(content);
    bindThemeLive();   // 让「当前系统为深/浅色」跟着系统实时变

    // 外观模式
    content.appendChild(U().el('div', { class: 'section-title', text: '外观模式' }));
    content.appendChild(segControl(cur.appearance || 'auto', async (v) => {
      await App.state.saveSettings({ appearance: v });
      reapply(); renderTheme(content);
    }));
    const ap = cur.appearance || 'auto';
    content.appendChild(U().el('div', { class: 'muted ap-note', style: { fontSize: '0.75rem', marginTop: '8px' }, text: App.themes.appearanceNote(cur) }));

    // 全局字号（四档，持久化保存）
    const fsLabels = [['small', '小'], ['standard', '标准'], ['large', '大'], ['xlarge', '超大']];
    const fsWrap = U().el('div', { class: 'seg', role: 'radiogroup' });
    const fsBtns = [];
    const fsSync = (k) => fsBtns.forEach((b) => { const on = b.value === k; b.btn.classList.toggle('active', on); b.btn.setAttribute('aria-checked', on ? 'true' : 'false'); });
    fsLabels.forEach(([k, t]) => {
      const b = U().el('button', { type: 'button', class: 'seg-item', role: 'radio', text: t });
      b.addEventListener('click', async () => { if ((live().fontScaleKey || 'standard') === k) return; await App.state.saveSettings({ fontScaleKey: k }); App.app.applyFontScale(); fsSync(k); });
      fsBtns.push({ btn: b, value: k }); fsWrap.appendChild(b);
    });
    fsSync(live().fontScaleKey || 'standard');
    content.appendChild(U().el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '全局字号' }));
    content.appendChild(fsWrap);
    content.appendChild(U().el('div', { class: 'muted', style: { fontSize: '0.75rem', marginTop: '8px' }, text: '调整后整个应用文字会等比例缩放，并自动保存；下次打开保持不变。' }));

    // 保存单个外观模式的主题（单击立刻生效）
    async function pickSide(side, key) {
      await App.state.saveSettings(side === 'day' ? { dayTheme: key } : { nightTheme: key });
      reapply();
      renderTheme(content);
      if (!sideIsEffective(side)) U().toast('已保存为' + (side === 'day' ? '日间' : '夜间') + '主题，当前外观模式下暂不显示', 'ok');
    }

    const editTheme = (opt) => openThemeEditor(opt, content);

    function pickerBlock(title, currentKey, side) {
      const grid = U().el('div', { class: 'gallery', style: { gridTemplateColumns: 'repeat(3,1fr)', marginTop: '10px' } });
      App.themes.themeOptions(live()).forEach((opt) => grid.appendChild(themeSwatch(opt, opt.key === currentKey, (k) => pickSide(side, k), editTheme)));
      const wrap = U().el('div', { style: { marginTop: '18px' } }, U().el('div', { class: 'section-title', text: title }), grid);
      return wrap;
    }

    const showDay = ap !== 'night';
    const showNight = ap !== 'day';
    if (showDay) content.appendChild(pickerBlock('日间专属主题', cur.dayTheme || 'light', 'day'));
    if (showNight) content.appendChild(pickerBlock('夜间专属主题', cur.nightTheme || 'dark', 'night'));
    content.appendChild(U().el('div', { class: 'muted', style: { fontSize: '0.75rem', marginTop: '8px' }, text: '点主题卡片右下角的铅笔，颜色设置会在下方就地展开，改完可选「覆盖原主题」或「另存为新预设」。' }));

    // 重命名主题
    function renameTheme(ct) {
      const nameI = U().el('input', { class: 'input', value: ct.name });
      U().modal({
        title: '重命名主题',
        body: U().el('div', { class: 'field' }, U().el('label', { text: '主题名称' }), nameI),
        actions: [
          { label: '取消', onClick: (c) => c() },
          { label: '保存', primary: true, onClick: async (c) => {
              const n = nameI.value.trim();
              if (!n) { U().toast('请输入名称', 'err'); return; }
              const list = (live().customThemes || []).map((t) => (t.key === ct.key ? Object.assign({}, t, { name: n }) : t));
              await App.state.saveSettings({ customThemes: list });
              c(); renderTheme(content); U().toast('已重命名为「' + n + '」', 'ok');
          } },
        ],
      });
      setTimeout(() => { nameI.focus(); nameI.select(); }, 60);
    }

    // 我的主题（保存的自定义配色预设）
    const myGrid = U().el('div', { class: 'gallery', style: { gridTemplateColumns: 'repeat(3,1fr)', marginTop: '10px' } });
    (cur.customThemes || []).forEach((ct) => {
      const sw = themeSwatch({ key: ct.key, name: ct.name, bg: ct.bg, accent: ct.accent }, false, async () => {
        await App.state.saveSettings({ dayTheme: ct.key, nightTheme: ct.key });
        reapply(); renderTheme(content); U().toast('已应用「' + ct.name + '」', 'ok');
      }, editTheme);
      const actions = U().el('div', { class: 'sw-actions' });
      const edit = U().el('button', { class: 'icon-btn', html: U().icon('edit', 15), title: '重命名' });
      edit.addEventListener('click', (e) => { e.stopPropagation(); renameTheme(ct); });
      const del = U().el('button', { class: 'icon-btn', html: U().icon('x', 15), title: '删除' });
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const list = (live().customThemes || []).filter((x) => x.key !== ct.key);
        await App.state.saveSettings({ customThemes: list });
        reapply(); renderTheme(content); U().toast('已删除主题', 'ok');
      });
      actions.appendChild(edit); actions.appendChild(del);
      sw.appendChild(actions);
      // 长按 / 右键也可重命名
      let lp = null;
      const startLp = () => { lp = setTimeout(() => { lp = null; renameTheme(ct); }, 550); };
      const stopLp = () => { if (lp) { clearTimeout(lp); lp = null; } };
      sw.addEventListener('touchstart', startLp, { passive: true });
      ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => sw.addEventListener(ev, stopLp));
      sw.addEventListener('mousedown', startLp);
      ['mouseup', 'mouseleave'].forEach((ev) => sw.addEventListener(ev, stopLp));
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); renameTheme(ct); });
      myGrid.appendChild(sw);
    });
    content.appendChild(U().el('div', { class: 'section-title', style: { marginTop: '18px' }, text: '我的主题（保存的配色预设）' }));
    content.appendChild(myGrid);
    if (!(cur.customThemes || []).length) content.appendChild(U().el('div', { class: 'muted', style: { fontSize: '0.78125rem', marginTop: '8px' }, text: '还没有保存的主题。给任意主题改色后选「另存为新预设」即可保存到这里。' }));

    // 就地展开的颜色编辑区（替代原来的全屏遮罩弹窗）
    themeEditorSection(content, !!animateEditor);
  }

  // —— 备份 ——
  function renderBackup(content) {
    const exp = U().el('button', { class: 'btn block', html: U().icon('download', 18) + '<span>导出全部数据（含图片）</span>' });
    exp.addEventListener('click', () => App.exim.exportAll());
    // 导出路径说明：真机上直接把文件写进公有下载目录，用户自己去文件管理器找
    const expHint = U().el('div', {
      class: 'muted exp-tip',
      style: { marginTop: '8px' },
      html: '导出后文件保存在「<b>手机存储/Download/GoJobackup</b>」文件夹里（没有该文件夹会自动创建）。<br>'
        + '用文件管理器打开 手机存储 → Download → GoJobackup，即可找到 <b>gojo-backup-日期-时间.gtbackup</b>。',
    });
    // —— 导入：文件选择器只放 .zip / .gtbackup，图片一律屏蔽 ——
    // 安卓系统选择器是按 MIME 过滤的（不是按后缀），所以 accept 里同时写上：
    //   ① 后缀 .zip / .gtbackup（Chrome/WebView 会尽量换算成 MIME）；
    //   ② ZIP 的几个常见 MIME；
    //   ③ application/octet-stream —— 自定义后缀 .gtbackup 在系统里通常就归到这一类。
    // 关键是「不写 image/*」，这样相册/图片文件会被置灰、选不中。
    // 个别机型按后缀过滤时会把 .gtbackup 藏起来，所以再给一个「兼容模式」入口兜底，
    // 那里用不筛类型的 input，但选中后照样做后缀 + ZIP 魔数校验，图片还是进不来。
    const ACCEPT_STRICT = '.zip,.gtbackup,application/zip,application/x-zip-compressed,application/x-compressed,application/octet-stream';
    // 关键：不能用 display:none —— 部分 WebView 内核里对隐藏的 file input 调 click()
    // 不会唤起选择器（点了没反应）。改成离屏定位，元素仍在渲染树里，才能正常拉起。
    function makePicker(accept) {
      return U().el('input', {
        type: 'file',
        accept: accept,
        style: { position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px', opacity: '0' },
      });
    }
    const fileI = makePicker(ACCEPT_STRICT);
    const fileAny = makePicker('*/*');
    const isBackupName = (n) => /\.(zip|gtbackup)$/i.test(String(n || ''));
    async function onPicked(input) {
      const f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      const nm = String(f.name || '');
      // 后缀白名单：图片（.jpg/.png/.heic…）在这里直接被拦下
      // 有些系统给的文件名不带后缀，这种情况放行，交给 importAll 按 PK 魔数判断
      if (nm && !isBackupName(nm)) {
        U().toast('只能导入 .zip 或 .gtbackup 备份文件', 'err');
        return;
      }
      await App.exim.importAll(f);
    }
    fileI.addEventListener('change', () => onPicked(fileI));
    fileAny.addEventListener('change', () => onPicked(fileAny));
    const imp = U().el('button', { class: 'btn block', html: U().icon('upload', 18) + '<span>导入备份恢复（可选覆盖/合并）</span>' });
    imp.addEventListener('click', () => fileI.click());
    const impCompat = U().el('button', { class: 'btn block compact-compat', text: '找不到备份文件？点这里用兼容模式选择' });
    impCompat.addEventListener('click', () => fileAny.click());

    // 存储管理
    const usageEl = U().el('div', { class: 'muted', text: '正在计算已用空间…' });
    function fmtSize(b) {
      b = Number(b) || 0;
      if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
      if (b >= 1024) return Math.round(b / 1024) + ' KB';
      return b + ' B';
    }
    function refreshUsage() {
      App.storage.estimateUsage().then((r) => {
        const txt = '已用空间：' + fmtSize(r.usage);
        usageEl.textContent = r.quota ? (txt + '  ·  配额 ' + (r.quota / 1073741824).toFixed(2) + ' GB') : txt;
      });
    }
    refreshUsage();
    const cacheHint = U().el('div', {
      class: 'muted exp-tip',
      style: { marginTop: '8px' },
      text: '清理旧版本遗留的模糊小图、本机缩略图缓存，以及「相册里已删除、但 App 还残留」的图片记录；原图与正常记录不会被删除。',
    });
    const cacheB = U().el('button', { class: 'btn block', html: U().icon('trash', 18) + '<span>清理小图与缓存（释放空间）</span>' });
    cacheB.addEventListener('click', async () => {
      if (!(await U().confirmDialog('将清理：① 相册 GoJo 目录里宽度小于 400px 的模糊小图；② 本机缩略图缓存；③ 相册里已删除、但 App 还残留的图片记录（自动摘除其引用）。原图与正常记录完整保留，是否继续？', { okLabel: '立即清理', danger: true }))) return;
      cacheB.disabled = true;
      U().toast('正在清理…');
      let r = { count: 0, bytes: 0 }, junk = { scanned: 0, removed: 0 }, recon = { checked: 0, removed: 0 };
      try { r = await App.storage.clearThumbs(); } catch (e) { console.error(e); }
      try { junk = await App.storage.cleanAlbumJunk(); } catch (e) { console.error(e); }
      try { recon = await App.storage.reconcileAlbumMissing(); } catch (e) { console.error(e); }
      cacheB.disabled = false;
      refreshUsage();
      const total = (r.count || 0) + (junk.removed || 0) + (recon.removed || 0);
      if (!total) { U().toast('没有可清理的内容', 'ok'); return; }
      U().toast('已清理 ' + total + ' 项' + (junk.removed ? '（相册小图 ' + junk.removed + ' 张）' : '') + (r.bytes ? '，释放约 ' + fmtSize(r.bytes) : '') + (recon.removed ? '；并清理相册已删的残留记录 ' + recon.removed + ' 条' : '') + '（原图与正常记录未动）', 'ok');
    });

    // 分领域导出（自定义深色下拉）
    const domSel = U().makeSelect(App.state.data.domains.map((d) => [d.id, d.name]), App.state.data.domains[0] ? App.state.data.domains[0].id : '', null);
    domSel.style.width = '100%';
    const expDom = U().el('button', { class: 'btn block', html: U().icon('download', 18) + '<span>导出选中领域</span>' });
    expDom.addEventListener('click', () => { const v = domSel.getValue(); if (v) App.exim.exportDomain(v); });

    const clearB = U().el('button', { class: 'btn danger block', html: U().icon('trash', 18) + '<span>清空所有数据</span>' });
    clearB.addEventListener('click', async () => {
      if (!(await U().confirmDialog('将删除全部领域、记录、图片与设置，且不可恢复。建议先导出备份。', { okLabel: '确认清空', danger: true }))) return;
      // 先把相册里的原图删干净（只删 Pictures/GoJo 内的），再清库，避免相册里留一堆孤儿图
      try {
        const imgs = (await App.storage.getAll('images')) || [];
        await App.storage.deleteImages(imgs.map((i) => i.id));
      } catch (e) {}
      await App.storage.clear('kv'); await App.storage.clear('domains'); await App.storage.clear('records'); await App.storage.clear('images');
      await App.state.init(); U().toast('已清空', 'ok'); App.app.boot();
    });

    const intro = U().el('p', {
      class: 'muted',
      style: { marginBottom: '12px' },
      html: '数据仅保存在本设备本地，不联网。原图存在手机相册「<b>Pictures/GoJo</b>」里，导出备份时会把它们一起打包。'
        + '<br>换设备时：先在本机导出，再到新设备导入即可同步（导入会把图片重新释放到相册）。',
    });
    content.appendChild(U().el('div', { class: 'card' }, intro, exp, expHint, U().el('div', { style: { height: '10px' } }), imp, impCompat, fileI, fileAny));
    content.appendChild(U().el('div', { style: { height: '14px' } }));
    content.appendChild(U().el('div', { class: 'section-title', text: '存储管理' }));
    content.appendChild(U().el('div', { class: 'card' }, usageEl, U().el('div', { style: { height: '10px' } }), cacheB, cacheHint));
    content.appendChild(U().el('div', { style: { height: '14px' } }));
    content.appendChild(U().el('div', { class: 'section-title', text: '分领域导出' }));
    content.appendChild(U().el('div', { class: 'card' }, U().el('div', { class: 'muted exp-tip', style: { marginBottom: '10px' }, html: '仅导出单个领域的数据与图片，便于按领域备份。<br>文件同样保存到「<b>手机存储/Download/GoJobackup</b>」。' }), domSel, U().el('div', { style: { height: '10px' } }), expDom));
    content.appendChild(U().el('div', { style: { height: '14px' } }));
    content.appendChild(clearB);
  }

  // —— 关于 ——
  // 自上而下：版本号 → 检查更新按钮 → 使用说明（长文本平铺）。
  // 检查更新：请求 GitHub Releases API，取最新 tag_name 与本地版本比较。

  // ===== 版本号：一律从运行时读，绝不写死 =====
  // 5+（HBuilderX）打包后：
  //   plus.runtime.version     → 版本名称（manifest 里的 versionName，如 2.0.0）
  //   plus.runtime.versionCode → 版本号（manifest 里的 versionCode，整数，每次发版必须递增）
  // Capacitor 包的版本是异步接口，取到后写进 RUNTIME_* 变量并回填界面。
  // 只有运行时完全取不到（纯网页预览）时，才退回下面的 APP_VERSION 常量。
  let RUNTIME_VERSION = '';
  let RUNTIME_VERSION_CODE = '';
  function plusRuntime() {
    try {
      const p = window.plus;
      if (p && p.runtime) return p.runtime;
    } catch (e) {}
    return null;
  }
  function appVersion() {
    if (RUNTIME_VERSION) return RUNTIME_VERSION;
    const rt = plusRuntime();
    if (rt && rt.version) return String(rt.version);   // versionName
    return APP_VERSION;                                // 常量兜底
  }
  function appVersionCode() {
    if (RUNTIME_VERSION_CODE !== '') return RUNTIME_VERSION_CODE;
    const rt = plusRuntime();
    if (rt && rt.versionCode !== undefined && rt.versionCode !== null && String(rt.versionCode) !== '') {
      return String(rt.versionCode);
    }
    return '';                                         // 网页预览没有版本序号，不显示
  }
  // 界面上统一用这个：v2.0.0 (100)；拿不到 versionCode 时只显示 v2.0.0
  function versionLabel() {
    const v = appVersion();
    const c = appVersionCode();
    return 'v' + v + (c ? ' (' + c + ')' : '');
  }
  function vParts(v) {
    return String(v || '').replace(/^v/i, '').split(/[.\-+_]/).map((x) => parseInt(x, 10) || 0);
  }
  function vCompare(a, b) {
    const A = vParts(a), B = vParts(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i] || 0, y = B[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  function openExternal(url) {
    if (!url) return;
    try {
      if (window.plus && plus.runtime && typeof plus.runtime.openURL === 'function') { plus.runtime.openURL(url); return; }
    } catch (e) {}
    try { window.open(url, '_blank'); } catch (e) {}
  }
  function fetchJSON(url, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('请求超时，请检查网络')); } }, ms || 12000);
      const fin = (ok, val) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve(val) : reject(val); };
      try {
        fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
          .then((r) => {
            if (r.status === 404) throw new Error('仓库或 Release 不存在（404）');
            if (r.status === 403) throw new Error('请求过于频繁，请稍后再试（403）');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then((j) => fin(true, j))
          .catch((e) => fin(false, e));
      } catch (e) { fin(false, e); }
    });
  }

  function renderAbout(content) {
    // ① 版本号（运行时读取：versionName + versionCode，取不到才用常量兜底）
    const verText = U().el('div', { class: 'about-ver', text: versionLabel() });
    const verCard = U().el('div', { class: 'card about-hero' },
      U().el('div', { class: 'about-logo', text: 'GoJo' }),
      verText);
    // plus 是异步注入的：首屏渲染时可能还没就绪，先显示兜底值，plusready 后再刷新成真实版本
    if (!(plusRuntime() && plusRuntime().version)) {
      const refreshVer = () => {
        if (!verText.parentNode) return;   // 用户已经切走了就不动
        verText.textContent = versionLabel();
      };
      if (window.plus) setTimeout(refreshVer, 0);
      else document.addEventListener('plusready', refreshVer, false);
    }
    // Capacitor 包：版本号要异步取，取到后回填（取不到就保持上面的值）
    try {
      const c = window.Capacitor;
      if (c && c.Plugins && c.Plugins.App && c.Plugins.App.getInfo) {
        c.Plugins.App.getInfo().then((info) => {
          if (!info) return;
          if (info.version) RUNTIME_VERSION = String(info.version);
          if (info.build) RUNTIME_VERSION_CODE = String(info.build);
          if (verText.parentNode) verText.textContent = versionLabel();
        }).catch(() => {});
      }
    } catch (e) {}

    // ② 检查更新
    const updBox = U().el('div', { class: 'about-upd' });
    const updBtn = U().el('button', { class: 'btn block', html: U().icon('download', 18) + '<span>检查更新</span>' });
    let checking = false;
    updBtn.addEventListener('click', async () => {
      if (checking) return;
      if (!UPDATE_REPO) {
        U().clear(updBox);
        updBox.appendChild(U().el('div', { class: 'muted about-upd-tip', text: '还没有配置更新仓库：请在 js/settings.js 顶部把 UPDATE_REPO 填成「用户名/仓库名」。' }));
        return;
      }
      checking = true;
      U().clear(updBox);
      updBox.appendChild(U().el('div', { class: 'muted about-upd-tip', text: '正在检查…' }));
      try {
        const j = await fetchJSON('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest');
        const tag = (j && (j.tag_name || j.name)) || '';
        U().clear(updBox);
        if (!tag) {
          updBox.appendChild(U().el('div', { class: 'muted about-upd-tip', text: '没有读取到版本号，请稍后再试。' }));
        } else if (vCompare(tag, appVersion()) > 0) {
          updBox.appendChild(U().el('div', { class: 'about-upd-new', text: '发现新版本 ' + tag }));
          const body = String((j && j.body) || '').trim();
          if (body) updBox.appendChild(U().el('div', { class: 'muted about-upd-note', text: body.length > 600 ? body.slice(0, 600) + '…' : body }));
          const go = U().el('button', { class: 'btn primary block', html: U().icon('download', 18) + '<span>前往下载</span>' });
          go.addEventListener('click', () => openExternal(j && j.html_url));
          updBox.appendChild(go);
        } else {
          updBox.appendChild(U().el('div', { class: 'about-upd-ok', text: '已是最新版本（' + versionLabel() + '）' }));
        }
      } catch (e) {
        U().clear(updBox);
        updBox.appendChild(U().el('div', { class: 'about-upd-err', text: '检查失败：' + ((e && e.message) || e) }));
      }
      checking = false;
    });

    // ③ 使用说明：直接平铺，不做折叠/按钮；文本按 Markdown 渲染（标题/列表/加粗都生效）
    const doc = U().el('div', {
      class: 'about-doc md-body',
      html: (App.md && App.md.render) ? App.md.render(ABOUT_USAGE) : String(ABOUT_USAGE).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    });

    content.appendChild(verCard);
    content.appendChild(U().el('div', { style: { height: '12px' } }));
    content.appendChild(updBtn);
    content.appendChild(updBox);
    content.appendChild(U().el('div', { style: { height: '18px' } }));
    content.appendChild(U().el('div', { class: 'section-title', text: '使用说明' }));
    content.appendChild(U().el('div', { class: 'card about-doc-card' }, doc));
  }

  // 物理返回键：设置页里的「就地改色」算一层临时状态，先收起编辑再谈返回
  function backToParent() {
    if (activeTab !== 'theme' || !themeDraft) return false;
    themeDraft = null;
    endThemePreview();
    if (contentEl) renderTheme(contentEl);
    return true;
  }

  return { render, backToParent, swipeTab };
})();
