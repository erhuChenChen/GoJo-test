/* ===== storage.js — 本地存储层 =====
 * 浏览器/预览：IndexedDB 存元数据 + 图片 Blob
 * Capacitor 原生：图片通过 Filesystem 写入 App 私有 Documents 目录（真正的原生本地存储）
 * 统一接口：saveImage / getImageURL / getThumbURL / deleteImage
 */
window.App = window.App || {};
App.storage = (function () {
  const DB_NAME = 'growthTrackerDB';
  const DB_VERSION = 1;
  let dbPromise = null;

  const STORES = ['kv', 'domains', 'records', 'images'];

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }
  function reqP(request) {
    return new Promise((res, rej) => { request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error); });
  }

  // —— 通用 KV / CRUD ——
  async function get(store, key) { return reqP((await tx(store, 'readonly')).get(key)); }
  async function getAll(store) { return reqP((await tx(store, 'readonly')).getAll()) || []; }
  async function put(store, val) { await reqP((await tx(store, 'readwrite')).put(val)); return val; }
  async function del(store, key) { await reqP((await tx(store, 'readwrite')).delete(key)); }
  async function clear(store) { await reqP((await tx(store, 'readwrite')).clear()); }

  // —— Capacitor 检测 ——
  function isNative() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  function FS() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem; }
  function extOf(type, name) {
    if (name && name.indexOf('.') > -1) return name.split('.').pop().toLowerCase();
    if (type === 'image/png') return 'png';
    if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
    if (type === 'image/webp') return 'webp';
    if (type === 'image/gif') return 'gif';
    return 'bin';
  }

  // —— Blob <-> Base64 ——
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const d = r.result.split(','); res(d[1] || ''); };
      r.onerror = rej; r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    const bin = atob(b64); const len = bin.length; const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'application/octet-stream' });
  }

  // —— 图片存取 ——
  // img = { id, name, type, size, blob, thumbBlob }
  async function saveImage(img) {
    if (isNative() && FS()) {
      const ext = extOf(img.type, img.name);
      const fullPath = 'gt/images/' + img.id + '.' + ext;
      const thumbPath = 'gt/thumbs/' + img.id + '.' + ext;
      await FS().writeFile({ path: fullPath, data: await blobToBase64(img.blob), directory: 'Documents', recursive: true });
      // 没有缩略图时不要把 thumbPath 写进元数据，否则会留下指向空文件的“幽灵路径”
      const meta = { id: img.id, name: img.name, type: img.type, size: img.size, fullPath, thumbPath: null, native: true };
      if (img.thumbBlob) {
        try {
          await FS().writeFile({ path: thumbPath, data: await blobToBase64(img.thumbBlob), directory: 'Documents', recursive: true });
          meta.thumbPath = thumbPath; meta.thumbW = img.thumbW || 0; meta.thumbH = img.thumbH || 0;
        } catch (e) {}
      }
      return put('images', meta);
    }
    return put('images', img); // web：直接存 blob + thumbBlob
  }

  async function readImageBlob(id) {
    const meta = await get('images', id); if (!meta) return null;
    if (meta.native && FS()) {
      const r = await FS().readFile({ path: meta.fullPath, directory: 'Documents' });
      return base64ToBlob(r.data, meta.type);
    }
    return meta.blob || null;
  }
  async function readThumbBlob(id) {
    const meta = await get('images', id); if (!meta) return null;
    if (meta.native && FS()) {
      if (!meta.thumbPath) return null; // 缩略图已被清理，调用方会回退到原图
      try { const r = await FS().readFile({ path: meta.thumbPath, directory: 'Documents' }); return base64ToBlob(r.data, meta.type); } catch (e) { return null; }
    }
    return meta.thumbBlob || meta.blob || null;
  }

  const urlCache = {};
  async function getImageURL(id) {
    if (urlCache[id]) return urlCache[id];
    const b = await readImageBlob(id); if (!b) return null;
    const u = URL.createObjectURL(b); urlCache[id] = u; return u;
  }
  async function getThumbURL(id) {
    const key = 't' + id;
    if (urlCache[key]) return urlCache[key];
    const b = await readThumbBlob(id); if (!b) return getImageURL(id);
    const u = URL.createObjectURL(b); urlCache[key] = u; return u;
  }
  function evictURL(id) { if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } if (urlCache['t' + id]) { URL.revokeObjectURL(urlCache['t' + id]); delete urlCache['t' + id]; } }

  async function deleteImage(id) {
    const meta = await get('images', id); if (!meta) return;
    if (meta.native && FS()) {
      try { await FS().deleteFile({ path: meta.fullPath, directory: 'Documents' }); } catch (e) {}
      try { await FS().deleteFile({ path: meta.thumbPath, directory: 'Documents' }); } catch (e) {}
    } else { evictURL(id); }
    await del('images', id);
  }
  async function deleteImages(ids) { for (const id of ids) { try { await deleteImage(id); } catch (e) {} } }

  // 批量读取（用于导出）：返回 {id, type, name, full: Blob, thumb: Blob}
  // withThumb 默认 false —— 备份包只装原图，缩略图在导入时按原图重建（见 exim.rebuildThumb）
  async function readImageForExport(id, withThumb) {
    const meta = await get('images', id); if (!meta) return null;
    const full = await readImageBlob(id);
    const thumb = withThumb ? await readThumbBlob(id) : null;
    return { id, type: meta.type, name: meta.name, full, thumb };
  }

  // 估算已用空间（优先用浏览器配额 API，否则按图片元数据累加）
  async function estimateUsage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0, fallback: false };
      }
    } catch (e) {}
    let s = 0; const imgs = await getAll('images'); (imgs || []).forEach((i) => s += (i.size || 0));
    return { usage: s, quota: 0, fallback: true };
  }
  // 清理内存中的图片 URL 缓存（释放内存，安全即时，不影响磁盘数据）
  function clearURLCache() { Object.keys(urlCache).forEach((k) => { try { URL.revokeObjectURL(urlCache[k]); } catch (e) {} delete urlCache[k]; }); }

  // —— 彻底清理缩略图（回收磁盘空间，原图 / 记录一律不动）——
  // 网页端：丢掉 IndexedDB 里每条图片元数据的 thumbBlob 字段；
  // 原生端：先删 Documents/gt/thumbs 下的对应文件，再把目录里残留的孤儿文件一并删掉。
  // 返回 { count: 删除个数, bytes: 释放字节数 }，用于给用户看「实际回收了多少」。
  async function clearThumbs() {
    const imgs = (await getAll('images')) || [];
    let count = 0, bytes = 0;
    for (const meta of imgs) {
      let touched = false;
      if (meta.native && FS()) {
        if (meta.thumbPath) {
          try { const st = await FS().stat({ path: meta.thumbPath, directory: 'Documents' }); if (st && st.size) bytes += st.size; } catch (e) {}
          try { await FS().deleteFile({ path: meta.thumbPath, directory: 'Documents' }); count++; } catch (e) {}
        }
        if (meta.thumbPath !== null) { meta.thumbPath = null; touched = true; }
        if (meta.thumbBlob) { delete meta.thumbBlob; touched = true; }
      } else if (meta.thumbBlob) {
        bytes += meta.thumbBlob.size || 0; count++;
        delete meta.thumbBlob; touched = true;
      }
      if ('thumbW' in meta || 'thumbH' in meta) { delete meta.thumbW; delete meta.thumbH; touched = true; }
      if (touched) { try { await put('images', meta); } catch (e) {} }
    }
    // 原生端补刀：删掉元数据里已经没有引用、但文件还赖在目录里的缩略图
    if (FS()) {
      try {
        const r = await FS().readdir({ path: 'gt/thumbs', directory: 'Documents' });
        for (const f of ((r && r.files) || [])) {
          if (!f || !f.name || f.name === '.' || f.name === '..') continue;
          try { await FS().deleteFile({ path: 'gt/thumbs/' + f.name, directory: 'Documents' }); count++; } catch (e) {}
        }
      } catch (e) {}
    }
    clearURLCache();
    return { count, bytes };
  }

  // 申请「持久化存储」权限：防止系统在磁盘紧张时自动清理本应用的 IndexedDB / 文件
  // 只申请权限，不参与任何读写链路；API 缺失、被拒绝、抛错都静默跳过，绝不影响启动与功能
  let persistAsked = false;
  function ensurePersisted() {
    if (persistAsked) return; persistAsked = true;
    try {
      const sm = navigator.storage;
      if (!sm || typeof sm.persist !== 'function') return;
      const first = (typeof sm.persisted === 'function') ? sm.persisted() : Promise.resolve(false);
      first.then((granted) => (granted ? true : sm.persist()))
        .then((ok) => { if (ok && window.console && console.info) console.info('[storage] 已获得持久化存储权限，系统不会自动清理本地数据'); })
        .catch(() => {});
    } catch (e) {}
  }

  // —— 旧缩略图补清晰 ——
  // 老版本生成的封面缩略图长边只有 400px，在高分屏上被放大 2~3 倍，看起来就是马赛克。
  // 这里在后台用原图重建一张 720×960 的 3:4 封面图并写回库，静默、仅一次、失败全部忽略。
  // 只处理网页端（原生端原图存在文件系统里，不做额外读取），且限制单页最多 8 张 / 同时 2 张。
  const thumbTried = {}; let thumbBusy = 0, thumbTotal = 0;
  async function upgradeThumb(id) {
    if (!id || thumbTried[id] || thumbTotal >= 8) return;
    thumbTried[id] = true; thumbTotal++;
    if (!App.ui || !App.ui.makeCoverBlob) return;
    try {
      const meta = await get('images', id);
      if (!meta || meta.native || !meta.blob) return;
      if (meta.thumbW && meta.thumbW >= 640) return;
      if ((meta.size || 0) > 6 * 1024 * 1024) return; // 超大原图跳过，避免解码占内存
      while (thumbBusy >= 2) await new Promise((r) => setTimeout(r, 120));
      thumbBusy++;
      let nb = null;
      try { nb = await App.ui.makeCoverBlob(meta.blob); } finally { thumbBusy--; }
      if (!nb) return;
      meta.thumbBlob = nb; meta.thumbW = 720; meta.thumbH = 960;
      await put('images', meta);
      const u = URL.createObjectURL(nb);
      delete urlCache['t' + id]; urlCache['t' + id] = u; // 旧 URL 不回收，留给已渲染的 <img>，避免瞬间裂图
      try { document.querySelectorAll('img[data-thumb="' + id + '"]').forEach((im) => { im.src = u; }); } catch (e) {}
    } catch (e) {}
  }

  return {
    open, get, getAll, put, del, clear,
    isNative, saveImage, getImageURL, getThumbURL, deleteImage, deleteImages, readImageForExport, evictURL, upgradeThumb,
    estimateUsage, clearURLCache, ensurePersisted, clearThumbs,
    uid: () => 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    now: () => Date.now(),
  };
})();
