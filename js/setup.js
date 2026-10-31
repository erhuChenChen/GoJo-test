/* ===== setup.js — 首次启动向导（选领域 / 自定义）===== */
window.App = window.App || {};
App.setup = (function () {
  const U = () => App.ui;
  let selected = 'drawing';

  function presetCard(key) {
    const p = App.domains.PRESETS[key];
    const card = U().el('div', { class: 'preset-card' + (selected === key ? ' active' : ''), 'data-key': key },
      U().el('div', { class: 'pc-emoji', text: p.icon }),
      U().el('div', { class: 'pc-name', text: p.name }),
    );
    card.addEventListener('click', () => {
      selected = key;
      document.querySelectorAll('.preset-card').forEach((c) => c.classList.toggle('active', c.getAttribute('data-key') === key));
      toggleCustom(key === 'custom');
    });
    return card;
  }

  function toggleCustom(on) {
    const box = document.getElementById('custom-box');
    if (box) box.classList.toggle('hidden', !on);
  }

  function render(appEl) {
    selected = 'drawing';
    const nameInput = U().el('input', { class: 'input', id: 'setup-name', placeholder: '领域名称' });
    const catsInput = U().el('textarea', { class: 'textarea', id: 'setup-cats', placeholder: '输入主要分类，用逗号或换行分隔，例如：素描, 水彩, 油画' });

    const customBox = U().el('div', { id: 'custom-box', class: 'hidden' },
      U().el('div', { class: 'field' }, U().el('label', { text: '领域名称' }), nameInput),
      U().el('div', { class: 'field' }, U().el('label', { text: '主要分类' }), catsInput),
    );

    const startBtn = U().el('button', { class: 'btn primary block', text: '开始使用 →' });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true; startBtn.textContent = '正在创建…';
      try {
        let domain;
        if (selected === 'custom') {
          const name = nameInput.value.trim();
          if (!name) { U().toast('请填写领域名称', 'err'); startBtn.disabled = false; startBtn.textContent = '开始使用 →'; return; }
          const cats = catsInput.value.split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean);
          domain = App.domains.createCustom(name, cats);
        } else {
          const name = nameInput.value.trim();
          domain = App.domains.createFromPreset(selected, name || undefined);
        }
        await App.db.saveDomain(domain);
        await App.state.setCurrentDomain(domain.id);
        await App.state.completeSetup();
        U().toast('已就绪，开始记录吧！', 'ok');
        App.app.boot();
      } catch (e) { console.error(e); U().toast('创建失败：' + e.message, 'err'); startBtn.disabled = false; startBtn.textContent = '开始使用 →'; }
    });

    const wizard = U().el('div', { class: 'wizard' },
      U().el('h1', { text: '成长记录' }),
      U().el('p', { class: 'lead', text: '选择你要管理的领域，应用会据此生成对应的预设分类、标签与统计项。之后你随时可以在设置里增删或新增领域。' }),
      U().el('div', { class: 'section-title', text: '选择领域' }),
      U().el('div', { class: 'preset-grid' },
        presetCard('drawing'), presetCard('fitness'), presetCard('reading'), presetCard('custom')),
      customBox,
      U().el('div', { style: { height: '18px' } }),
      startBtn,
    );
    U().mount(appEl, wizard);
  }

  return { render };
})();
