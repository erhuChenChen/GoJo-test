/* ===== exim.js — 导出 / 导入（ZIP，本地内置 JSZip）===== */
window.App = window.App || {};
App.exim = (function () {
  const U = () => App.ui;

  function extOf(type, name) {
    if (name && name.indexOf('.') > -1) return name.split('.').pop().toLowerCase();
    if (type === 'image/png') return 'png'; if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
    if (type === 'image/webp') return 'webp'; if (type === 'image/gif') return 'gif'; return 'bin';
  }
  // ===== 导出 =====
  // 真机上 <a download> 会被 WebView 直接吞掉（点了没反应），plus.downloader 又不存在，
  // 所以导出就是「自己把文件写进公有下载目录」：
  //   (1) JSZip 直接产出 base64 的二进制 ZIP；
  //   (2) 两条通道写进 手机存储/Download/GoJobackup/xxx.gtbackup（目录不存在会自动创建）：
  //       MediaStore 下载集合（Android 10+ 免权限）→ 直接写 Download 目录（Android 9 及以下）。
  //   两条都失败就直接报错，不再保留私有目录 / 外置目录 / 分享面板那些兜底。
  // 只有浏览器预览（没有 plus 环境）才退回网页下载，仅用于开发时验证。
  const BAD_NAME = /[\\/:*?"<>|\r\n\t]/g;
  function safeName(n) { return String(n || 'backup').replace(BAD_NAME, '-'); }
  function stamp() {
    const d = new Date(); const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // 是否运行在 5+App（HBuilderX 打包的 APK）里
  function hasPlus() {
    return (typeof plus !== 'undefined') && !!plus && !!plus.android;
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'application/zip' });
  }

  // ===== 导出：两条通道，直接写进公有「下载」目录 =====
  // 目标路径固定为「手机存储/Download/GoJobackup/<文件名>.gtbackup」，目录不存在会自动创建。
  //   ① MediaStore 下载集合（Android 10+ 官方通道，不需要任何权限）
  //      ContentResolver.insert(relative_path: 'Download/GoJobackup') → openOutputStream → 分块 write
  //   ② 直接写 /storage/emulated/0/Download/GoJobackup/（Android 9 及以下没有下载集合）
  //      Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS) + 运行时申请写权限
  // 历史方案（_doc 私有目录、_downloads 外置目录、plus.share 分享面板、
  // OutputStreamWriter 二进制串、base64 文本包）已全部删除 ——
  // 真机上导出就是在下载目录里落一个文件，别的路都是多余的。
  const DL_DIR = 'GoJobackup';        // 公有下载目录下的固定子目录
  const DL_SHOW = '手机存储/Download/' + DL_DIR;   // 给用户看的路径（弹提示、说明文字统一用它）

  function b64Bytes(b64) {
    if (!b64) return 0;
    let pad = 0;
    if (b64.charAt(b64.length - 1) === '=') pad = (b64.charAt(b64.length - 2) === '=') ? 2 : 1;
    return Math.round(b64.length / 4) * 3 - pad;
  }

  function fileLength(abs) {
    try {
      const File = plus.android.importClass('java.io.File');
      const n = new File(abs).length();
      return typeof n === 'number' && n >= 0 ? n : -1;
    } catch (e) { return -1; }
  }

  // 分块写：android.util.Base64.decode() 返回 Java byte[]，回传 JS 常直接变 null，
  // 所以 decode 的结果内联喂给 write()，中间值不落 JS 变量。
  // 块大小固定 2048 字符：真机日志里 8192 写出 0 字节、4096 只写进半截，只有 2048 完整。
  function writeBinByBase64(abs, b64) {
    const File = plus.android.importClass('java.io.File');
    const FOS = plus.android.importClass('java.io.FileOutputStream');
    const B64 = plus.android.importClass('android.util.Base64');
    if (!B64 || typeof B64.decode !== 'function') throw new Error('当前底座不支持 Base64 解码');
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    if (dir) { try { new File(dir).mkdirs(); } catch (e) {} }   // 目录不存在就创建（已存在返回 false，忽略）
    const step = 2048;
    let fos = null;
    try {
      fos = new FOS(abs);
      for (let i = 0; i < b64.length; i += step) {
        fos.write(B64.decode(b64.slice(i, i + step), 2));   // 2 = NO_WRAP
      }
      fos.flush();
      fos.close(); fos = null;
    } catch (e) {
      try { if (fos) fos.close(); } catch (_) {}
      try { new File(abs).delete(); } catch (_) {}
      throw e;
    }
  }

  function sleep(ms) { return new Promise((r) => { try { setTimeout(r, ms); } catch (e) { r(); } }); }

  // 系统 API 等级。嵌套类 android.os.Build$VERSION 在部分底座上 importClass 拿不到，
  // 所以多试两条路；都拿不到就返回 0 —— 只表示「不确定」，绝不据此跳过 MediaStore。
  function sdkInt() {
    try {
      const V = plus.android.importClass('android.os.Build$VERSION');
      const n = V && V.SDK_INT;
      if (typeof n === 'number' && n > 0) return n;
    } catch (e) {}
    try {
      const B = plus.android.importClass('android.os.Build');
      const V = plus.android.getAttribute(B, 'VERSION');
      const n = plus.android.getAttribute(V, 'SDK_INT');
      if (typeof n === 'number' && n > 0) return n;
    } catch (e) {}
    try {
      const n = parseInt(String((plus.os && plus.os.version) || ''), 10);   // 形如 "13"
      if (n >= 4) return n;
    } catch (e) {}
    return 0;
  }

  // Android 9 及以下写公有目录需要 WRITE_EXTERNAL_STORAGE（10+ 会自动拒绝，无害）
  function ensureWritePerm() {
    return new Promise((resolve) => {
      try {
        if (!plus.android || typeof plus.android.requestPermissions !== 'function') { resolve(false); return; }
        plus.android.requestPermissions(
          ['android.permission.WRITE_EXTERNAL_STORAGE'],
          (r) => resolve(!!(r && r.granted && r.granted.length)),
          () => resolve(false)
        );
      } catch (e) { resolve(false); }
    });
  }

  // 导出前强制动态申请「存储读写」权限：弹系统授权框，用户允许后才真正导出。
  // Android 10+ 走 MediaStore 下载集合本身不需要该权限，但依旧调用系统 API 申请
  // （满足「强制动态申请」要求）；即便 WRITE 被系统自动拒绝也不阻断导出。
  // 旧内核里「先点导入才弹权限、之后导出才正常」正是缺了这步——导出前显式申请即可稳定复现授权。
  function ensureStoragePerms() {
    return new Promise((resolve) => {
      try {
        if (!hasPlus() || !plus.android || typeof plus.android.requestPermissions !== 'function') { resolve(true); return; }
        const perms = ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'];
        plus.android.requestPermissions(perms,
          (r) => {
            const granted = (r && r.granted) || [];
            const got = perms.some((p) => granted.indexOf(p) >= 0);
            resolve(got || sdkInt() >= 29);
          },
          () => resolve(sdkInt() >= 29)
        );
      } catch (e) { resolve(true); }
    });
  }
  // 导出入口统一的前置守卫：申请权限 → 未获授权则提示并中止
  async function guardExport() {
    if (!hasPlus()) return true;            // 浏览器预览等无原生环境，直接放行
    const ok = await ensureStoragePerms();
    if (!ok) { U().toast('导出需要存储权限，请在弹窗中允许', 'err'); return false; }
    return true;
  }

  function publicDownloadDir() {
    try {
      const Env = plus.android.importClass('android.os.Environment');
      if (Env) {
        const d = Env.getExternalStoragePublicDirectory(Env.DIRECTORY_DOWNLOADS);
        if (d) {
          const p = (typeof d.getAbsolutePath === 'function') ? d.getAbsolutePath() : String(d);
          if (p && p.charAt(0) === '/') return String(p).replace(/\/+$/, '');
        }
      }
    } catch (e) {}
    return '/storage/emulated/0/Download';
  }

  // /storage/emulated/0 是 FUSE，stat 会滞后：刚写完可能读到 0 或半截，隔一会儿重试几次，
  // 别把「还没刷新」当成「没写进去」。
  async function waitLen(abs, want) {
    let last = -1;
    for (let i = 0; i < 6; i++) {
      last = fileLength(abs);
      if (last === want) return true;
      if (i < 5) await sleep(220);
    }
    if (last > 0) {                       // 读到非 0 且稳定，就认为确实落盘了
      await sleep(400);
      const again = fileLength(abs);
      return again === want || again === last;
    }
    return false;
  }

  // 通道①：MediaStore 下载集合（Android 10+，免权限，GoJobackup 目录由系统自动创建）
  async function saveToMediaStore(b64, name) {
    let resolver = null;
    try { resolver = plus.android.runtimeMainActivity().getContentResolver(); } catch (e) { resolver = null; }
    if (!resolver) throw new Error('拿不到 ContentResolver');
    // 集合 URI：先按官方常量取，取不到（嵌套类 importClass 在个别底座上会返回 null）
    // 就直接 Uri.parse 出下载集合的 content URI —— 这个地址是系统固定的
    let coll = null;
    try {
      const Downloads = plus.android.importClass('android.provider.MediaStore$Downloads');
      if (Downloads && Downloads.EXTERNAL_CONTENT_URI) coll = Downloads.EXTERNAL_CONTENT_URI;
    } catch (e) { coll = null; }
    if (!coll) {
      try {
        const Uri = plus.android.importClass('android.net.Uri');
        if (Uri && typeof Uri.parse === 'function') coll = Uri.parse('content://media/external/downloads');
      } catch (e) { coll = null; }
    }
    if (!coll) throw new Error('系统无 MediaStore 下载集合');
    const ContentValues = plus.android.importClass('android.content.ContentValues');
    const B64 = plus.android.importClass('android.util.Base64');
    if (!B64 || typeof B64.decode !== 'function') throw new Error('当前底座不支持 Base64 解码');

    const want = b64Bytes(b64);
    const cv = new ContentValues();
    cv.put('_display_name', name);
    cv.put('mime_type', 'application/octet-stream');
    cv.put('relative_path', 'Download/' + DL_DIR);   // 目录不存在时系统会自动建
    let uri = null, os = null;
    try {
      uri = resolver.insert(coll, cv);
      if (!uri) throw new Error('系统拒绝在下载目录建文件');
      os = resolver.openOutputStream(uri);
      if (!os) throw new Error('打不开下载目录写入流');
      const CH = 2048;
      for (let i = 0; i < b64.length; i += CH) {
        os.write(B64.decode(b64.slice(i, i + CH), 2));   // 2 = NO_WRAP
      }
      os.flush(); os.close(); os = null;

      let got = -1;
      for (let i = 0; i < 6; i++) {
        try {
          const c = resolver.query(uri, null, null, null, null);
          if (c) {
            c.moveToFirst();
            const idx = c.getColumnIndex('_size');
            if (idx >= 0) got = c.getLong(idx) * 1;
            c.close();
          }
        } catch (e) { got = -1; }
        if (got === want) break;
        if (i < 5) await sleep(220);
      }
      if (got >= 0 && got !== want) throw new Error('写入体积不符 ' + got + '/' + want);
      return DL_SHOW + '/' + name;
    } catch (e) {
      try { if (os) os.close(); } catch (_) {}
      try { if (uri) resolver.delete(uri, null, null); } catch (_) {}   // 别留下半截文件
      throw e;
    }
  }

  // 通道②：直接写公有下载目录（Android 9 及以下 / 无 MediaStore 的环境）
  async function saveToPublicDownloadDir(b64, name) {
    const abs = publicDownloadDir() + '/' + DL_DIR + '/' + name;
    const want = b64Bytes(b64);
    if (!(sdkInt() >= 29)) { try { await ensureWritePerm(); } catch (e) {} }
    writeBinByBase64(abs, b64);         // 内部会 mkdirs 出 GoJobackup 目录
    if (!(await waitLen(abs, want))) throw new Error('落盘体积不符（读不到 ' + want + ' 字节）');
    return DL_SHOW + '/' + name;
  }

  // 浏览器预览专用：Blob → 临时链接 → <a download> → click()
  // 注意：click 之后不能立刻 revokeObjectURL，部分内核这时才开始读链接，会拿到失效地址。
  function webDownload(blob, filename) {
    const name = safeName(filename);
    if (!blob || !blob.size) throw new Error('备份数据为空（0 字节）');
    let url = '';
    try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
    if (!url) throw new Error('无法创建临时下载链接');

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    // 不用 display:none —— 少数 WebView 内核会因此忽略点击，改成离屏定位更稳
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '0';
    a.style.opacity = '0';
    document.body.appendChild(a);
    try {
      a.click();
    } catch (e) {
      try { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
    setTimeout(() => {
      try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 4000);
    return { name: name, size: blob.size, via: 'web' };
  }

  function errMsg(e) { return (e && (e.message || e.msg)) || String(e); }

  // 原生：两条通道依次尝试，都失败就直接报错（不再走私有目录 / 分享面板那两套兜底）
  async function finishExport(b64, filename) {
    const name = safeName(filename);
    if (!b64) { U().toast('导出失败：备份数据为空', 'err'); return; }
    const size = b64Bytes(b64);

    if (hasPlus()) {
      U().toast('正在保存到「' + DL_SHOW + '」…');
      const errs = [];

      // ① MediaStore 下载集合（Android 10+ 官方通道，免权限）
      try {
        const where = await saveToMediaStore(b64, name);
        U().toast('备份 ' + humanSize(size) + ' 已保存到「' + where + '」', 'ok');
        console.log('[exim] 已保存到 ' + where);
        return;
      } catch (e) { errs.push('MediaStore：' + errMsg(e)); console.warn('[exim] MediaStore 存下载目录失败：', errMsg(e)); }

      // ② 直接写 Download/GoJobackup（Android 9 及以下没有下载集合）
      try {
        const where = await saveToPublicDownloadDir(b64, name);
        U().toast('备份 ' + humanSize(size) + ' 已保存到「' + where + '」', 'ok');
        console.log('[exim] 已保存到 ' + where);
        return;
      } catch (e) { errs.push('直写目录：' + errMsg(e)); console.warn('[exim] 直接写下载目录失败：', errMsg(e)); }

      U().toast('导出失败：' + errs.join('；'), 'err');
      return;
    }

    // 浏览器预览 / 没有 plus 的环境
    try {
      const r = webDownload(base64ToBlob(b64), name);
      U().toast('备份包 ' + humanSize(r.size) + '，已开始下载', 'ok');
    } catch (e) {
      U().toast('导出失败：' + ((e && e.message) || e), 'err');
      console.warn('[exim] 导出失败：', e);
    }
  }

  async function exportAll() {
    if (!(await guardExport())) return;
    U().toast('正在导出…');
    const domains = await App.db.getDomains();
    const records = await App.storage.getAll('records');
    const settings = App.state.data.settings;
    const imageIds = [];
    records.forEach((r) => (r.imageIds || []).forEach((id) => imageIds.push(id)));
    const zip = new JSZip();
    const imageList = [];
    let missing = 0;
    for (const id of imageIds) {
      // 只打包原图：列表直接用原图展示，不再需要额外的小图文件。
      // 原图存在手机相册 Pictures/GoJo 里；文件被用户删掉时读不到，直接跳过并计数。
      const ex = await App.storage.readImageForExport(id, false);
      if (!ex || !ex.full) { missing++; continue; }
      const ext = extOf(ex.type, ex.name);
      imageList.push({ id, name: ex.name, type: ex.type, ext });
      zip.file('images/' + id + '.' + ext, ex.full);
    }
    const data = { version: 2, exportedAt: App.storage.now(), app: 'growth-tracker', domains, records, settings, imageList };
    zip.file('data.json', JSON.stringify(data));
    const b64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await finishExport(b64, 'gojo-backup-' + stamp() + '.gtbackup');
    if (missing) U().toast('有 ' + missing + ' 张原图已丢失（相册里被删了），未打包', 'err');
  }

  // 导出单个领域（ZIP：图片存原文件，JSON 只存元数据，绝不含 base64）
  async function exportDomain(domainId) {
    if (!(await guardExport())) return;
    U().toast('正在导出领域…');
    const domain = await App.db.getDomain(domainId);
    if (!domain) { U().toast('领域不存在', 'err'); return; }
    const records = (await App.storage.getAll('records')).filter((r) => r.domainId === domainId);
    const imageIds = [];
    records.forEach((r) => (r.imageIds || []).forEach((id) => imageIds.push(id)));
    const zip = new JSZip();
    const imageList = [];
    let missing = 0;
    for (const id of imageIds) {
      const ex = await App.storage.readImageForExport(id, false);
      if (!ex || !ex.full) { missing++; continue; }
      const ext = extOf(ex.type, ex.name);
      imageList.push({ id, name: ex.name, type: ex.type, ext });
      zip.file('images/' + id + '.' + ext, ex.full);
    }
    const data = { version: 2, exportedAt: App.storage.now(), app: 'growth-tracker', scope: 'domain', domains: [domain], records, imageList, settings: { customThemes: App.state.data.settings.customThemes || [] } };
    zip.file('data.json', JSON.stringify(data));
    const b64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await finishExport(b64, 'gojo-' + domain.name + '-' + stamp() + '.gtbackup');
    if (missing) U().toast('有 ' + missing + ' 张原图已丢失（相册里被删了），未打包', 'err');
  }

  function pickMode() {
    return new Promise((resolve) => {
      const body = U().el('div', {},
        U().el('p', { class: 'muted', text: '覆盖恢复：清空现有数据后导入。合并导入：保留现有数据，按 ID 覆盖/新增。' }),
        U().el('div', { class: 'row', style: { marginTop: '16px', gap: '10px', justifyContent: 'flex-end' } },
          (() => { const b = U().el('button', { class: 'btn', text: '取消' }); b.addEventListener('click', () => { close(); resolve(null); }); return b; })(),
          (() => { const b = U().el('button', { class: 'btn primary', text: '合并导入' }); b.addEventListener('click', () => { close(); resolve('merge'); }); return b; })(),
          (() => { const b = U().el('button', { class: 'btn danger', text: '覆盖恢复' }); b.addEventListener('click', () => { close(); resolve('replace'); }); return b; })()));
      let close;
      const m = U().modal({ title: '导入方式', body, actions: [] });
      close = m.close;
    });
  }

  // 缩略图已废弃：备份包只装原图，导入时也不生成任何小图。

  // —— 导入前统一格式 ——
  // 备份文件可能是：① 真正的 ZIP（PK\x03\x04 开头，二进制写入成功时的产物）；
  // ② base64 文本（老兼容模式的产物，首行是 B64_HEAD）。
  // 关键改动：整份文件一次性读成 ArrayBuffer。
  // 原来先 file.slice(0,2).arrayBuffer() 探魔数、再 blob.text() 读正文，这两个 API 在
  // 老内核 WebView / 5+ 里可能不存在或直接给空值 —— 一拿不到内容就落到「base64」分支，
  // 空字符串 strip 完不足 16 字符，于是报「文件内容不是有效的备份」。改成只依赖 FileReader。
  function readArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取文件失败（可能没有文件读取权限）'));
      fr.readAsArrayBuffer(file);
    });
  }
  // 在前若干字节里找 PK 魔数：正常 ZIP 在 0；有些系统会在文件头塞 BOM / 换行 / 日志头
  function pkOffset(bytes) {
    const n = Math.min(bytes.length - 3, 8192);
    for (let i = 0; i < n; i++) {
      if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b) continue;
      const a = bytes[i + 2], b = bytes[i + 3];
      if (a === 0x03 && b === 0x04) return i;             // 普通条目
      if (a === 0x05 && b === 0x06) return i;             // 空包（只有中央目录结尾）
      if (a === 0x07 && b === 0x08) return i;             // 分卷
    }
    return -1;
  }
  async function normalizeBackup(file) {
    const buf = await readArrayBuffer(file);
    const bytes = new Uint8Array(buf || new ArrayBuffer(0));
    if (!bytes.length) throw new Error('文件是空的（0 字节），请重新导出备份');

    const at = pkOffset(bytes);
    if (at === 0) return bytes.buffer;
    if (at > 0) return bytes.slice(at).buffer;            // 头部有杂物 → 从 PK 处截断

    // 不是 ZIP：尝试旧的 base64 文本包
    let txt = '';
    for (let i = 0; i < bytes.length; i += 4096) txt += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    const nl = txt.indexOf('\n');
    if (nl > 0 && txt.slice(0, nl).indexOf('GOJO-BACKUP') === 0) txt = txt.slice(nl + 1);
    let body = txt.replace(/[^A-Za-z0-9+/=]/g, '');
    while (body.length % 4 !== 0) body += '=';
    if (body.length < 16) throw new Error('文件内容不是有效的备份（请选择 .zip 或 .gtbackup 备份文件）');
    let bin;
    try { bin = atob(body); } catch (e) { throw new Error('备份内容解码失败，文件可能已损坏'); }
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const at2 = pkOffset(arr);
    if (at2 < 0) throw new Error('文件不是 GoJo 备份包（未找到 ZIP 内容）');
    return arr.slice(at2).buffer;
  }
  // 按文件名（不含路径）在包里查找条目：兼容「备份包被重新打过包、data.json 在子目录里」的情况
  function findEntry(zip, baseName) {
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && n.split('/').pop() === baseName);
    if (!names.length) return null;
    names.sort((a, b) => a.length - b.length);
    return zip.file(names[0]);
  }

  async function importAll(file, prefMode) {
    let mode = prefMode || await pickMode();
    if (!mode) return;
    U().toast('正在导入…');
    try {
      const zip = await JSZip.loadAsync(await normalizeBackup(file));
      const dataF = zip.file('data.json') || findEntry(zip, 'data.json');
      if (!dataF) throw new Error('备份包里没有 data.json，文件可能不完整');
      const txt = await dataF.async('string');
      const data = JSON.parse(txt);
      if (!data || (!Array.isArray(data.records) && !Array.isArray(data.domains))) {
        throw new Error('data.json 不是本应用的数据结构');
      }
      if (mode === 'replace') {
        // 覆盖恢复前先把旧图片从相册删掉（只删 Pictures/GoJo 内的），否则会留下无主原图
        try {
          const olds = (await App.storage.getAll('images')) || [];
          await App.storage.deleteImages(olds.map((x) => x.id));
        } catch (e) {}
        await App.storage.clear('kv'); await App.storage.clear('domains'); await App.storage.clear('records'); await App.storage.clear('images');
      }
      // 图片：只导入原图（新版本不再有缩略图，列表直接用原图）
      const imgList = data.imageList || [];
      let done = 0;
      for (const im of imgList) {
        const base = im.id + '.' + im.ext;
        const fullF = zip.file('images/' + base) || findEntry(zip, base);
        if (!fullF) continue;
        const fullBlob = new Blob([await fullF.async('arraybuffer')], { type: im.type || 'image/jpeg' });
        await App.storage.saveImage({
          id: im.id, name: im.name || ('img.' + im.ext), type: im.type || 'image/jpeg',
          size: fullBlob.size, blob: fullBlob,
        });
        done++;
        if (imgList.length > 3 && done % 3 === 0) U().toast('正在导入图片 ' + done + '/' + imgList.length + '…');
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程，避免大包导入时界面假死
      }
      // 自定义主题：合并（按 key 去重，避免覆盖现有）
      const incomingThemes = (data.settings && data.settings.customThemes) || [];
      if (mode === 'replace') {
        if (incomingThemes.length) await App.state.saveSettings({ customThemes: incomingThemes });
      } else if (incomingThemes.length) {
        const cur = App.state.data.settings.customThemes || [];
        const map = {}; cur.forEach((t) => { map[t.key] = true; });
        const merged = cur.slice();
        incomingThemes.forEach((t) => { if (!map[t.key]) merged.push(t); });
        await App.state.saveSettings({ customThemes: merged });
      }
      // 领域：同名保持独立（改名 + 新 id），不自动合并；不同名则新增。
      // 合并导入时若与现有（或本次已导入的）领域同名，自动加序号后缀（如「画画(导入) 2」）独立保存，不报错拦截。
      const existing = await App.db.getDomains();
      const taken = new Set((existing || []).map((x) => x.name));
      const idMap = {};
      for (const d of (data.domains || [])) {
        const origId = d.id;
        if (mode === 'replace') {
          idMap[origId] = origId; d.key = d.key || 'custom';
          await App.db.saveDomain(d);
        } else {
          if (taken.has(d.name)) {
            const base = d.name;
            let k = 1;
            do { k++; d.name = base + '(导入) ' + k; } while (taken.has(d.name));
          }
          taken.add(d.name);
          const newId = App.storage.uid();
          idMap[origId] = newId; d.id = newId; d.key = d.key || 'custom';
          await App.db.saveDomain(d);
        }
      }
      // 记录：按 id 映射迁移到对应（可能新建的）领域
      for (const r of (data.records || [])) {
        if (idMap[r.domainId]) r.domainId = idMap[r.domainId];
        await App.db.saveRecord(r);
      }
      // 设置（仅 replace 模式整体还原）
      if (mode === 'replace' && data.settings) await App.db.setKV('settings', Object.assign({}, data.settings));
      await App.db.setKV('setupDone', true);
      // 导入的图片可能沿用旧 id，内存里的 blob: URL 必须清掉，否则界面会显示导入前的旧图
      App.storage.clearURLCache();
      await App.state.init();
      if (!App.state.data.currentDomainId && App.state.data.domains[0]) await App.state.setCurrentDomain(App.state.data.domains[0].id);
      U().toast('导入完成', 'ok');
      App.themes.applyFromSettings(App.state.data.settings);
      App.app.boot();
    } catch (e) { console.error(e); U().toast('导入失败：' + e.message, 'err'); }
  }

  return { exportAll, exportDomain, importAll };
})();
