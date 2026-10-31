/* ===== db.js — 业务数据访问层（基于 storage） ===== */
window.App = window.App || {};
App.db = (function () {
  const S = () => App.storage;

  // —— KV ——
  async function getKV(key, def) {
    const r = await S().get('kv', key);
    return r ? r.value : def;
  }
  async function setKV(key, value) {
    await S().put('kv', { id: key, value }); return value;
  }

  // —— 领域 ——
  async function getDomains() { return (await S().getAll('domains')) || []; }
  async function getDomain(id) { return S().get('domains', id); }
  async function saveDomain(d) { return S().put('domains', d); }
  async function deleteDomain(id) {
    const recs = await getRecords(id);
    const imgIds = [];
    recs.forEach((r) => (r.imageIds || []).forEach((i) => imgIds.push(i)));
    await S().deleteImages(imgIds);
    for (const r of recs) await S().del('records', r.id);
    await S().del('domains', id);
  }

  // —— 记录 ——
  async function getRecords(domainId) {
    const all = (await S().getAll('records')) || [];
    return domainId ? all.filter((r) => r.domainId === domainId) : all;
  }
  async function getRecord(id) { return S().get('records', id); }
  async function saveRecord(r) { return S().put('records', r); }
  async function deleteRecord(id) {
    const r = await S().get('records', id); if (!r) return;
    if (r.imageIds && r.imageIds.length) await S().deleteImages(r.imageIds);
    await S().del('records', id);
  }

  // 批量把若干记录转移到目标领域；跨领域时分类/标签按名称尽力映射（无匹配则丢失）
  async function moveRecordsToDomain(ids, targetDomainId) {
    const target = await getDomain(targetDomainId); if (!target) return { moved: 0 };
    const idset = new Set(ids);
    const all = (await S().getAll('records')) || [];
    let moved = 0;
    for (const r of all) {
      if (!idset.has(r.id)) continue;
      const src = await getDomain(r.domainId);
      const srcCat = src && src.categories.find((c) => c.id === r.categoryId);
      const tCat = srcCat && target.categories.find((c) => c.name === srcCat.name);
      let newTags = [];
      if (src && r.tagIds && r.tagIds.length) {
        const srcTagNames = r.tagIds.map((tid) => { const t = src.tags.find((x) => x.id === tid); return t ? t.name : null; }).filter(Boolean);
        newTags = target.tags.filter((t) => srcTagNames.includes(t.name)).map((t) => t.id);
      }
      r.domainId = targetDomainId;
      r.categoryId = tCat ? tCat.id : null;
      r.tagIds = newTags;
      await saveRecord(r);
      moved++;
    }
    return { moved };
  }

  return { getKV, setKV, getDomains, getDomain, saveDomain, deleteDomain, getRecords, getRecord, saveRecord, deleteRecord, moveRecordsToDomain };
})();
