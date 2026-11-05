/* ===== storage.js — 本地存储层 =====
 * 浏览器/预览：IndexedDB 存元数据 + 图片 Blob
 * Capacitor 原生：图片通过 Filesystem 写入 App 私有 Documents 目录（真正的原生本地存储）
 * 统一接口：saveImage / getImageURL / deleteImage
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
    if (type === 'image/heic') return 'heic';
    if (type === 'image/heif') return 'heif';
    if (type === 'image/avif') return 'avif';
    return 'bin';
  }
  // 扩展名 → MIME。相册多选只给路径、不给类型，必须自己推：
  // 推错就会把 HEIC 的字节存成 .jpg（相册点开是坏的、详情页裂图），所以这里要认全。
  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  };
  function mimeOf(name, type) {
    if (type && String(type).indexOf('image/') === 0) return String(type);
    const ext = extOf('', name);
    return MIME_BY_EXT[ext] || 'image/jpeg';
  }

  // ==========================================================================
  // ===== 相册存储（5+ / HBuilderX 打包的真机环境）=====
  // 图片本体写进手机公共相册目录「手机存储/Pictures/GoJo」（没有就自动创建），
  // IndexedDB 里只留文件路径和展示用的元数据，不再塞 Blob。
  //   好处：相册里直接能看到图、卸载重装不一定丢、数据库不会越滚越大。
  // 写入一律走「Java 层流复制」：源文件 → MediaStore 输出流，字节不经过 JS，
  // 所以再大的原图也不会因为 base64 过长而解码失败（Android 14 上的那个报错）。
  // 写不进去就如实抛错、由界面提示失败 —— 不再偷偷改存应用内，避免「看着成功、相册里没有」。
  // 读取失败（用户从相册里删了文件）返回 null，上层据此显示「图片丢失」，不会崩。
  // ==========================================================================
  const ALBUM_DIR = 'GoJo';
  const ALBUM_SHOW = 'Pictures/' + ALBUM_DIR;   // 给用户看的路径（提示文案统一用它）

  function hasPlus() { return (typeof plus !== 'undefined') && !!plus && !!plus.android; }

  // 系统 API 等级；拿不到返回 0（只表示「不确定」，不据此跳过 MediaStore）
  // 首次读到就缓存：一次运行里系统版本不会变，没必要每张图都跨桥问一遍
  let sdkCache = 0;
  function sdkInt() {
    if (sdkCache) return sdkCache;
    const n = sdkRead();
    if (n) sdkCache = n;
    return n;
  }
  function sdkRead() {
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
    // 最稳的一条：系统属性里直接读 API 等级（字符串，如 "29"）
    try {
      const s = plus.android.invoke('java.lang.System', 'getProperty', 'ro.build.version.sdk');
      const n = parseInt(String(s || ''), 10);
      if (n > 0 && n < 100) return n;
    } catch (e) {}
    // 最后兜底：plus.os.version 在安卓上是「10」「13」这种系统版本号，换算成 API 等级
    try {
      const MAP = { 4: 16, 5: 21, 6: 23, 7: 24, 8: 26, 9: 28, 10: 29, 11: 30, 12: 31, 13: 33, 14: 34, 15: 35, 16: 36 };
      const n = parseInt(String((plus.os && plus.os.version) || ''), 10);
      if (MAP[n]) return MAP[n];
    } catch (e) {}
    return 0;
  }

  // 公共图片目录（/storage/emulated/0/Pictures）；拿不到就按安卓标准路径兜底
  function picturesBase() {
    try {
      const Env = plus.android.importClass('android.os.Environment');
      if (Env) {
        const d = Env.getExternalStoragePublicDirectory(Env.DIRECTORY_PICTURES);
        if (d) {
          const p = (typeof d.getAbsolutePath === 'function') ? d.getAbsolutePath() : String(d);
          if (p && p.charAt(0) === '/') return String(p).replace(/\/+$/, '');
        }
      }
    } catch (e) {}
    return '/storage/emulated/0/Pictures';
  }

  // 应用私有目录（存缩略图用，不进相册，避免相册里混进一堆小图）
  let docBase = null;
  function privateDoc() {
    if (docBase !== null) return docBase;
    docBase = '';
    try {
      const u = plus.io.convertLocalFileSystemURL('_doc/');
      const s = String(u || '').replace(/^file:\/\//, '').replace(/\/+$/, '');
      if (s && s.charAt(0) === '/') docBase = s;
    } catch (e) {}
    return docBase;
  }

  // 相册里的文件名：GoJo_<图片id>_<随机尾缀>.<ext>
  // 带随机尾缀是为了「重复导入同一份备份」时不会和相册里的旧文件重名 ——
  // 重名时系统会偷偷改名成「xxx (1).jpg」，我们存的路径就对不上了。
  function albumFileName(id, type, name) {
    const ext = extOf(type, name);
    const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    return 'GoJo_' + id + '_' + tail + '.' + (ext === 'bin' ? 'jpg' : ext);
  }
  function albumAbsPath(fileName) { return picturesBase() + '/' + ALBUM_DIR + '/' + fileName; }

  // ——— 相册写入的日志 ———
  // 真机上没有控制台，写相册失败必须让开发者（console）看得见，绝不允许「静默失败」——
  // 之前高版本安卓存不进相册、界面却毫无反应，就是这一步缺失。
  // 用户侧的提示统一由调用方（storeImages）发，这里只负责留下可排查的日志。
  function albumLog(msg, e) {
    let line = '[相册] ' + msg;
    if (e) line += '：' + (e.message || e.errMsg || e.code || e);
    try { if (window.console && console.log) console.log(line); } catch (_) {}
    if (e) { try { if (window.console && console.warn) console.warn('[相册] 异常对象：', e); } catch (_) {} }
    return line;
  }

  // 保存前动态申请存储权限：
  //   · Android 9 及以下（API ≤ 28）写公共目录必须要 WRITE_EXTERNAL_STORAGE；
  //   · Android 10（API 29）仍可申请，同意后系统给「兼容模式」，写相册更稳；
  //   · Android 11+（API ≥ 30）该权限已被系统废弃，申请会被直接拒绝 —— 但这没关系，
  //     通过 MediaStore 写自己的图片本来就不需要任何权限。
  // 结果缓存在内存里，避免每次保存都反复弹窗。
  let permState = null;
  function ensureWritePerm() {
    if (permState) return Promise.resolve(permState);
    return new Promise((resolve) => {
      const sdk = sdkInt();
      const done = (st) => { permState = st; resolve(st); };
      try {
        if (!hasPlus() || typeof plus.android.requestPermissions !== 'function') {
          done({ granted: false, sdk: sdk, deniedAlways: true, noApi: true }); return;
        }
        plus.android.requestPermissions(
          ['android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.READ_EXTERNAL_STORAGE'],
          (r) => {
            const ok = !!(r && r.granted && r.granted.length);
            albumLog('存储权限：' + (ok ? '已授权' : '未授权')
              + (sdk >= 30 ? '（Android 11+ 该权限已被系统废弃，MediaStore 写入不需要它）' : ''));
            done({ granted: ok, sdk: sdk, deniedAlways: !!(r && r.deniedAlways && r.deniedAlways.length) });
          },
          (e) => { albumLog('存储权限申请被拒绝', e); done({ granted: false, sdk: sdk, deniedAlways: true }); }
        );
      } catch (e) {
        albumLog('存储权限申请异常', e);
        done({ granted: false, sdk: sdk, deniedAlways: true });
      }
    });
  }

  // 确保 Pictures/GoJo 目录存在（分区存储下由系统自动创建，这里主要服务兼容模式与直写兜底）
  // 建成一次就记住，后面每张图不用再反复跨桥查询目录
  let dirReady = false;
  function ensureAlbumDir() {
    const dir = picturesBase() + '/' + ALBUM_DIR;
    if (dirReady) return dir;
    try {
      const File = plus.android.importClass('java.io.File');
      const f = new File(dir);
      if (!f.exists()) {
        const ok = f.mkdirs();
        albumLog('相册目录不存在，创建 ' + dir + '：' + (ok ? '成功' : '失败'));
        dirReady = !!ok;
      } else {
        dirReady = true;
      }
      return dir;
    } catch (e) { albumLog('检查/创建相册目录失败', e); return ''; }
  }

  // Java int（IS_PENDING 这类整型列必须给 Integer，给 JS number 在部分底座会抛类型错）
  function javaInt(n) {
    try {
      const I = plus.android.importClass('java.lang.Integer');
      const v = I && I.valueOf ? I.valueOf(n) : null;
      if (v) return v;
    } catch (e) {}
    return String(n);   // ContentValues.getAsInteger 也能解析字符串
  }
  function putValue(cv, key, val) {
    if (val === null || val === undefined) return;
    try { cv.put(key, val); return; } catch (e) {}
    try { plus.android.invoke(cv, 'put', key, val); } catch (e) {}
  }

  // MediaStore.Images.Media.EXTERNAL_CONTENT_URI —— 不同底座对内部类的写法不一样，全试一遍
  let albumColl = null;
  function imagesCollection() {
    if (albumColl) return albumColl;
    const names = ['android.provider.MediaStore$Images$Media', 'android.provider.MediaStore.Images.Media'];
    for (let i = 0; i < names.length; i++) {
      try {
        const M = plus.android.importClass(names[i]);
        if (M && M.EXTERNAL_CONTENT_URI) { albumColl = M.EXTERNAL_CONTENT_URI; return albumColl; }
      } catch (e) {}
    }
    try {
      const MS = plus.android.importClass('android.provider.MediaStore');
      const IM = MS && MS.Images && MS.Images.Media;
      if (IM && IM.EXTERNAL_CONTENT_URI) { albumColl = IM.EXTERNAL_CONTENT_URI; return albumColl; }
    } catch (e) {}
    try {
      const Uri = plus.android.importClass('android.net.Uri');
      const u = (Uri && Uri.parse) ? Uri.parse('content://media/external/images/media') : null;
      if (u) { albumColl = u; return albumColl; }
    } catch (e) {}
    albumLog('拿不到 MediaStore 图片集合 URI');
    return null;
  }
  function uriToString(uri) {
    if (!uri) return '';
    let s = '';
    try { s = String(uri); } catch (e) { s = ''; }
    if (s.indexOf('content://') !== 0) {
      try { const t = plus.android.invoke(uri, 'toString'); s = t ? String(t) : ''; } catch (e) { s = ''; }
    }
    return s.indexOf('content://') === 0 ? s : '';
  }
  // ——— 调 Java 方法的安全层 ———
  // 5+ 各底座对「Java 对象的 JS 代理」实现不一致：
  //   · 多数版本把方法直接挂到返回的对象上，resolver.query 可以直接调；
  //   · 部分版本必须 importClass(实例) 之后方法才映射上来；
  //   · 还有的版本两个都不行，只能走 plus.android.invoke(对象, '方法名', 参数...) 反射。
  // 启动时那句 `resolver.query is not a function` 就是第二种情况：方法没挂上，直接 TypeError。
  // 这里三条路依次试，全都不行就返回 { ok:false }，调用方安静跳过 —— 绝不在控制台报红字。
  const jImported = typeof WeakSet === 'function' ? new WeakSet() : null;
  function jcall(obj, name) {
    if (!obj) return { ok: false, v: null };
    const args = Array.prototype.slice.call(arguments, 2);
    // ① 方法已经挂在代理对象上
    try { if (typeof obj[name] === 'function') return { ok: true, v: obj[name].apply(obj, args) }; } catch (e) {}
    // ② 反射调用（方法没映射上来时最可靠的一条）
    try {
      if (plus.android && typeof plus.android.invoke === 'function') {
        return { ok: true, v: plus.android.invoke.apply(null, [obj, name].concat(args)) };
      }
    } catch (e) {}
    // ③ 先 importClass 实例再调一次（每个对象只导一次）
    try {
      if (!jImported || !jImported.has(obj)) {
        plus.android.importClass(obj);
        if (jImported) jImported.add(obj);
      }
      if (typeof obj[name] === 'function') return { ok: true, v: obj[name].apply(obj, args) };
    } catch (e) {}
    return { ok: false, v: null };
  }
  // —— ContentResolver 的几个方法 ——
  function jquery(res, uri, sel, selArgs) {
    const r = jcall(res, 'query', uri, null, sel, selArgs, null);
    return r.ok ? r.v : null;
  }
  function jdelete(res, uri, sel, selArgs) {
    const r = jcall(res, 'delete', uri, sel, selArgs);
    return r.ok ? (Number(r.v) || 0) : 0;
  }
  function jupdate(res, uri, cv) {
    const r = jcall(res, 'update', uri, cv, null, null);
    return r.ok ? (Number(r.v) || 0) : 0;
  }
  // —— 游标方法（同一个桥，同样可能没映射上）——
  function curFirst(c) { const r = jcall(c, 'moveToFirst'); return r.ok ? !!r.v : false; }
  function curNext(c) { const r = jcall(c, 'moveToNext'); return r.ok ? !!r.v : false; }
  function curCol(c, name) { const r = jcall(c, 'getColumnIndex', name); return r.ok ? Number(r.v) : -1; }
  function curStr(c, i) { const r = jcall(c, 'getString', i); return (r.ok && r.v != null) ? String(r.v) : ''; }
  function curNum(c, i) { const r = jcall(c, 'getLong', i); return r.ok ? (Number(r.v) || 0) : 0; }
  function curClose(c) { if (c) { try { jcall(c, 'close'); } catch (e) {} } }

  function queryCol(resolver, uri, col) {
    const c = jquery(resolver, uri, null, null);
    try {
      if (!c || !curFirst(c)) return null;
      const i = curCol(c, col);
      if (i < 0) return null;
      if (col === '_size' || col === 'is_pending') return curNum(c, i);
      const s = curStr(c, i);
      return s ? s : null;
    } catch (e) {
      return null;
    } finally { curClose(c); }
  }
  // 写完必须回查：有些 ROM 的 insert 会「成功返回但一个字都没落盘」，只看不报错会误判成功
  // 返回字节数；0 = 确实没写进去；-1 = 查不到（当作未知，不误判失败）
  // 文件真实字节数；0 = 没有这个文件或空文件；-1 = 查不到（当作未知，不误判失败）
  function absFileLen(abs) {
    try {
      const File = plus.android.importClass('java.io.File');
      const f = new File(abs);
      if (!f.exists()) return 0;
      return Number(f.length()) || 0;
    } catch (e) { return -1; }
  }
  // 一次 query 同时取「真实路径 + 体积」（原来分两次查，每张图多一次跨桥往返）
  function checkWritten(resolver, uri, abs) {
    let size = null, real = abs;
    const c = jquery(resolver, uri, null, null);
    try {
      if (c && curFirst(c)) {
        const ip = curCol(c, '_data');
        if (ip >= 0) { const p = curStr(c, ip); if (p) real = p; }
        const is = curCol(c, '_size');
        if (is >= 0) size = curNum(c, is);
      }
    } catch (e) {
    } finally { curClose(c); }
    const len = absFileLen(real);
    if (len > 0) return { size: len, path: real };
    if (size !== null && size > 0) return { size: size, path: real };
    if (size === null && len < 0) return { size: -1, path: real };
    return { size: 0, path: real };
  }
  // base64 → 原始字节数（用于写完校验体积，避免「写了一半也算成功」）
  function b64Bytes(b64) {
    const s = String(b64 || '');
    const n = s.length;
    if (!n) return 0;
    let pad = 0;
    if (s.charAt(n - 1) === '=') pad++;
    if (n > 1 && s.charAt(n - 2) === '=') pad++;
    return Math.floor(n * 3 / 4) - pad;
  }
  // 往 Java 输出流里写字节。
  // 5+ 在部分底座上不会把方法挂到 openOutputStream 返回的对象上，直接 os.write() 就是
  // "os.write is not a function"，这种情况走 plus.android.invoke 反射调用。
  function writeRaw(stream, bytes) {
    if (!bytes) throw new Error('Base64 解码返回空');
    if (stream && typeof stream.write === 'function') { stream.write(bytes); return; }
    plus.android.invoke(stream, 'write', bytes);
  }
  // base64 → 输出流：分块解码、逐块写入。
  // 这里必须分块 —— 一张几 MB 的原图整段 base64 塞过 plus.android 桥，
  // Android 14 上 `Base64.decode` 会直接返回空（真机日志里的「Base64 整段解码失败」）。
  // 每块 65536 字符（4 的倍数，补位只会在最后一段），既不会切断编码单元，也不会撑爆单次调用。
  // 只服务「手上没有源文件」的导入 / 老数据迁移 / 拖拽，主链路（相册选图）走文件流复制，不经过这里。
  const B64_STEP = 65536;
  function writeToStream(stream, b64, B64) {
    const s = String(b64 || '');
    if (!s) throw new Error('图片数据为空');
    for (let i = 0; i < s.length; i += B64_STEP) {
      const part = s.slice(i, Math.min(i + B64_STEP, s.length));
      const bytes = B64.decode(part, 2);        // 2 = NO_WRAP
      if (!bytes) throw new Error('图片数据解码失败（第 ' + (Math.floor(i / B64_STEP) + 1) + ' 段）');
      writeRaw(stream, bytes);
    }
  }
  function closeStream(stream) {
    if (!stream) return;
    try { if (typeof stream.flush === 'function') stream.flush(); } catch (e) {}
    try { if (typeof stream.close === 'function') stream.close(); } catch (e) {}
  }
  // 直写进去的文件不一定立刻进媒体库，补一次系统扫描，相册才看得到。
  // 注意：扫描只是「让相册看到这个文件」的补登记，不参与我们自己的读写，
  // 所以永远放到下一个事件循环里发，绝不阻塞「文件落盘 → 立刻返回成功」这条主链路。
  function scanToGallery(abs, mime) {
    const fire = () => {
      try {
        const MSC = plus.android.importClass('android.media.MediaScannerConnection');
        if (!MSC || typeof MSC.scanFile !== 'function') return;
        const main = plus.android.runtimeMainActivity();
        MSC.scanFile(main, [abs], [mime], null);
        albumLog('已请求系统扫描入库（后台，不等待结果）：' + abs);
      } catch (e) { albumLog('请求系统扫描入库失败（文件已写入，相册可能稍后才显示）', e); }
    };
    try { setTimeout(fire, 0); } catch (e) { fire(); }
  }

  // 直写文件：一次解码 → 一次写入 → 一次关闭，写完只做一次体积校验。
  // 只服务「手上没有源文件可复制」的场景（浏览器拖拽 / 备份导入 / 缩略图）。
  // 写不完整就删掉重来？不 —— 直接失败，交给上层提示，绝不分块补齐。
  function writeBytesOnce(abs, b64) {
    const File = plus.android.importClass('java.io.File');
    const FOS = plus.android.importClass('java.io.FileOutputStream');
    const B64 = plus.android.importClass('android.util.Base64');
    if (!B64 || typeof B64.decode !== 'function') throw new Error('当前底座不支持 Base64 解码');
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    if (dir) { try { new File(dir).mkdirs(); } catch (e) {} }
    const want = b64Bytes(b64);
    let fos = null;
    try {
      fos = new FOS(abs);
      writeToStream(fos, b64, B64);      // 一次成型
      try { fos.flush(); } catch (e) {}
      fos.close(); fos = null;
      const len = absFileLen(abs);
      if (want > 0 && len >= 0 && len !== want) throw new Error('写入体积不符（' + len + '/' + want + ' 字节）');
      return abs;
    } catch (e) {
      try { if (fos) fos.close(); } catch (_) {}
      try { new File(abs).delete(); } catch (_) {}   // 别留下半截图
      throw e;
    }
  }

  // ——— 系统级「复制粘贴」：plus.io 直接把源文件拷进相册 ———
  // 这是唯一一次「读 + 写」：由系统自己搬字节，不经过 JS，也不经过 base64，
  // 一张几 MB 的照片通常几十毫秒就完事。
  function toFileUrl(p) {
    const s = String(p || '');
    if (!s) return s;
    if (s.indexOf('file://') === 0) return s;
    if (s.charAt(0) === '/') return 'file://' + s;
    return s;                                  // 相对路径（如 _doc/xxx.jpg）原样交给 plus.io
  }
  function errText(e) { return String((e && (e.message || e.errMsg || e.code)) || e || '未知原因'); }

  // 解析文件/目录对象：先按 file:// 形式问，不认再用原始绝对路径问一次。
  // 只是 URL 写法的兜底（两次查找都是毫秒级），不涉及任何写入重试。
  function resolveEntry(p) {
    return new Promise((resolve, reject) => {
      const raw = String(p || '');
      const tryUrl = (u, again) => {
        plus.io.resolveLocalFileSystemURL(u, resolve, (e) => {
          if (again) tryUrl(raw, false);
          else reject(e || new Error('路径不存在：' + raw));
        });
      };
      tryUrl(toFileUrl(raw), raw !== toFileUrl(raw));
    });
  }

  async function copyToAlbum(srcPath, fileName) {
    const dir = ensureAlbumDir() || (picturesBase() + '/' + ALBUM_DIR);
    const dest = dir + '/' + fileName;
    if (!plus.io || typeof plus.io.resolveLocalFileSystemURL !== 'function') {
      throw new Error('当前环境不支持 plus.io');
    }
    const srcEntry = await resolveEntry(srcPath);
    const dirEntry = await resolveEntry(dir);
    if (!srcEntry || typeof srcEntry.copyTo !== 'function') throw new Error('源文件对象不可用');
    let timer = null;
    try {
      await new Promise((resolve, reject) => {
        // 3 秒还没回调说明桥接卡住了，直接放弃走 MediaStore —— 绝不让界面挂着转圈
        timer = setTimeout(() => reject(new Error('复制超时')), 3000);
        try { srcEntry.copyTo(dirEntry, fileName, resolve, (e) => reject(e || new Error('copyTo 失败'))); }
        catch (e) { reject(e); }
      });
    } catch (e) {
      throw new Error('复制到相册失败：' + errText(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const len = absFileLen(dest);
    if (len === 0) {                       // 系统说复制成功但文件是空的：删掉，别留空壳
      try { const File = plus.android.importClass('java.io.File'); new File(dest).delete(); } catch (e) {}
      throw new Error('复制完成但文件是 0 字节');
    }
    return { uri: '', path: dest, size: len };
  }

  // —— 路径归一化：content:// / file:// / 绝对路径 / plus 相对路径 四种形态都要能吃 ——
  // 相册多选的返回在 5+ 各版本、各 ROM 上不一致：可能是 file:///storage/...，
  // 也可能是 /storage/...，极少数还是 _doc/xxx 这种相对路径。
  // 直接 new FileInputStream('_doc/x.jpg') 必炸，所以先统一转成绝对路径，再去掉 URL 编码
  // （文件名里的中文、空格、括号是 URI 编码过的）。
  function srcAbs(src) {
    let s = String(src || '');
    if (!s) return '';
    if (s.indexOf('content://') === 0) return s;      // 交给 ContentResolver.openInputStream
    if (s.indexOf('file://') === 0) s = s.slice(7);
    try { s = decodeURIComponent(s); } catch (e) {}
    if (s.charAt(0) !== '/') {
      try {
        const u = plus.io.convertLocalFileSystemURL(s);
        let a = String(u || '');
        if (a.indexOf('file://') === 0) a = a.slice(7);
        if (a.charAt(0) === '/') { try { a = decodeURIComponent(a); } catch (e) {} s = a; }
      } catch (e) {}
    }
    return s;
  }

  // 说明：这里曾经有一套「byte[] 缓冲 + read/write 循环」的复制实现，
  // 在部分底座上 read 返回的是包装对象而不是数字，循环一次都不跑（=「0 字节」），
  // 现已整体换成下面的 FileChannel.transferTo，字节同样不进 JS。

  // 在图片集合里建一条「正在写」的记录，返回 { uri, cv }。
  // insert 的列必须与 mediaStoreWrite 完全一致 —— 删除链路（findMediaRows / purgeAlbumEntry）
  // 靠 _display_name + relative_path 找登记，这里少写一列，删记录时相册里就会留下灰块。
  function insertMediaRow(resolver, coll, fileName, mime, ContentValues) {
    const cv = new ContentValues();
    putValue(cv, '_display_name', fileName);
    putValue(cv, 'mime_type', mime);
    putValue(cv, 'relative_path', 'Pictures/' + ALBUM_DIR);   // 分区存储：目录由系统建，不用自己 mkdir
    if (sdkInt() >= 29) putValue(cv, 'is_pending', javaInt(1));  // 写完再放行，避免相册里出现半截图
    const ins = jcall(resolver, 'insert', coll, cv);
    if (!ins.ok) throw new Error('当前底座调不通 ContentResolver.insert');
    if (!ins.v) throw new Error('系统拒绝在相册目录建文件（insert 返回空）');
    albumLog('insert 成功' + (uriToString(ins.v) ? '：' + uriToString(ins.v) : ''));
    return ins.v;
  }

  // 写完收尾：清 is_pending → 回查真实路径与体积。返回 { uri, path, size }
  function finishMediaRow(resolver, uri, absGuess, ContentValues) {
    const sdk = sdkInt();
    if (sdk >= 29) {
      try {
        const cv2 = new ContentValues();
        putValue(cv2, 'is_pending', javaInt(0));
        jupdate(resolver, uri, cv2);
      } catch (e) { albumLog('清除 is_pending 失败（图片可能不会出现在相册）', e); }
    }
    // 系统偶尔会把同名文件改成「xxx (1).jpg」：查到真实路径就用真实的，查不到用推算路径
    const info = checkWritten(resolver, uri, absGuess);
    if (info.size === 0) throw new Error('写入返回成功，但相册里查不到文件（0 字节）');
    albumLog('已写入相册：' + info.path + (info.size > 0 ? '（' + info.size + ' 字节）' : '（大小未知）'));
    return { uri: uriToString(uri), path: info.path, size: info.size > 0 ? info.size : 0 };
  }

  // —— Java 侧整份复制：字节一次都不进 JS ——
  // 上一版用 byte[] 缓冲循环（Array.newInstance 造数组 + read/write 反射）搬字节，
  // 在部分底座上 read 的返回值不是数字而是 Java 包装对象，`n > 0` 恒为 false ——
  // 循环一次都不跑，调用方只看到「读取原图失败（0 字节）」，而且不抛任何异常，最难查。
  // 现在改用 FileChannel.transferTo(long, long, WritableByteChannel)：
  //   · 只有实例方法（getChannel / transferTo / size），不碰静态方法、不造 byte[]；
  //   · 不依赖返回值（long 过桥同样可能变形），搬完直接拿目标文件长度对账，长度对上才算成功。
  function javaClass(name) {
    try { const c = plus.android.importClass(name); if (c) return c; } catch (e) {}
    return null;
  }
  function srcLength(srcAbs) {
    const n = absFileLen(srcAbs);
    return n > 0 ? n : 0;             // -1（查不到）与 0 都按「长度未知」处理
  }
  // 打开源图：本地路径走 FileInputStream；content:// 走 ParcelFileDescriptor 拿 fd 再包流。
  // 两条都是「拿到一个带 channel 的 FileInputStream」，后面的复制逻辑完全一样。
  function openSourceForCopy(src) {
    const FIS = javaClass('java.io.FileInputStream');
    if (!FIS) throw new Error('拿不到 FileInputStream');
    const s = String(src || '');
    if (s.indexOf('content://') === 0) {
      const resolver = getResolver();
      const Uri = javaClass('android.net.Uri');
      if (!resolver || !Uri || typeof Uri.parse !== 'function') throw new Error('拿不到 ContentResolver / Uri');
      const pr = jcall(resolver, 'openFileDescriptor', Uri.parse(s), 'r');
      const pfd = pr.ok ? pr.v : null;
      if (!pfd) throw new Error('打不开所选的图片（content://）');
      const fr = jcall(pfd, 'getFileDescriptor');
      if (!fr.ok || !fr.v) throw new Error('拿不到文件描述符（content://）');
      let want = 0;
      try { const sr = jcall(pfd, 'getStatSize'); want = Number(sr.v) || 0; } catch (e) {}
      return { fis: new FIS(fr.v), want: want };
    }
    const abs = srcAbs(s);
    if (!abs || abs.charAt(0) !== '/') throw new Error('图片路径无效：' + s);
    return { fis: new FIS(abs), want: srcLength(abs) };
  }
  function transferToOut(input, fos) {
    const cIn = jcall(input.fis, 'getChannel');
    const cOut = jcall(fos, 'getChannel');
    if (!cIn.ok || !cIn.v || !cOut.ok || !cOut.v) throw new Error('打不开文件通道');
    // 一次 transferTo 搬完整份（长度未知时给 1GB 上限，够任何手机照片）
    plus.android.invoke(cIn.v, 'transferTo', 0, input.want > 0 ? input.want : 1073741824, cOut.v);
    try { fos.flush(); } catch (e) {}
  }
  // 写进刚建好的相册行：① 先走 ContentResolver 给的文件描述符（最正规，走 MediaProvider 记账）；
  // ② 不通再直写系统分配的 _data 路径（Android 11+ 允许应用写自己的媒体文件）。
  // 两条都不解析返回值 —— 搬完拿目标文件长度对账，长度对上才算成功。
  function copyInJava(src, destAbs, destUri) {
    const FOS = javaClass('java.io.FileOutputStream');
    if (!FOS) throw new Error('拿不到 FileOutputStream');
    const input = openSourceForCopy(src);
    let fdErr = null;
    try {
      if (destUri) {
        let pfd = null, fos = null;
        try {
          const resolver = getResolver();
          const Uri = javaClass('android.net.Uri');
          const pr = (resolver && Uri) ? jcall(resolver, 'openFileDescriptor', Uri.parse(String(destUri)), 'w') : { ok: false };
          pfd = pr.ok ? pr.v : null;
          const fr = pfd ? jcall(pfd, 'getFileDescriptor') : { ok: false };
          if (fr.ok && fr.v) {
            fos = new FOS(fr.v);
            transferToOut(input, fos);
            try { fos.close(); } catch (e) {}
            fos = null;
            try { plus.android.invoke(pfd, 'close'); } catch (e) {}
            pfd = null;
            const gotFd = absFileLen(destAbs);
            if (gotFd > 0 && (input.want === 0 || gotFd === input.want)) return gotFd;
            fdErr = new Error('经文件描述符写入后长度为 ' + gotFd);
          }
        } catch (e) {
          fdErr = e;
          albumLog('经文件描述符写入失败，改用直写路径', e);
        } finally {
          try { if (fos) fos.close(); } catch (e) {}
          try { if (pfd) plus.android.invoke(pfd, 'close'); } catch (e) {}
        }
      }
      let fos2 = null;
      try {
        fos2 = new FOS(destAbs);
        transferToOut(input, fos2);
        try { fos2.close(); } catch (e) {}
        fos2 = null;
        const got = absFileLen(destAbs);
        if (!(got > 0)) throw new Error('复制后相册文件是 0 字节');
        if (input.want > 0 && got !== input.want) throw new Error('复制字节数不符（' + got + '/' + input.want + '）');
        return got;
      } catch (e2) {
        if (fdErr) albumLog('两条写入通道都失败：（fd）' + errText(fdErr) + '；（路径）' + errText(e2));
        throw e2;
      } finally {
        try { if (fos2) fos2.close(); } catch (e) {}
      }
    } finally {
      try { input.fis.close(); } catch (e) {}
    }
  }
  // 这一行在磁盘上的真实路径（同名冲突时系统会改名，所以必须以系统为准）
  function destPathOf(resolver, uri, fileName) {
    let p = '';
    const c = jquery(resolver, uri, null, null);
    try {
      if (c && curFirst(c)) {
        const i = curCol(c, '_data');
        if (i >= 0) p = curStr(c, i) || '';
      }
    } catch (e) {} finally { curClose(c); }
    return (p && p.charAt(0) === '/') ? p : albumAbsPath(fileName);
  }

  // 源文件 → MediaStore 直搬（Android 10+ 分区存储唯一合法写法，也是最不依赖跨桥能力的一条）：
  //   1. insert 在图片集合里建一条 pending 记录；
  //   2. openOutputStream 打开一次再关掉 —— pending 行是「懒创建」的，不 open 就没有实体文件；
  //   3. 拿系统分配的 _data 真实路径；
  //   4. Java 侧 FileChannel 整份复制（字节不进 JS）；
  //   5. 清 is_pending，图片才会真正出现在相册里。
  // 一步失败就如实抛出并删掉半截记录，不做任何重试。
  function mediaStoreCopyFile(srcPath, fileName, mime) {
    const resolver = getResolver();
    if (!resolver) throw new Error('拿不到 ContentResolver（不是 5+ 真机环境？）');
    const coll = imagesCollection();
    if (!coll) throw new Error('系统没有可用的图片集合 URI');
    const ContentValues = javaClass('android.content.ContentValues');
    if (!ContentValues) throw new Error('拿不到 ContentValues');

    let uri = null;
    try {
      uri = insertMediaRow(resolver, coll, fileName, mime, ContentValues);

      const outs = jcall(resolver, 'openOutputStream', uri);
      const os = outs.ok ? outs.v : null;
      if (!os) throw new Error('打不开相册写入流（openOutputStream 返回空）');
      closeStream(os);                       // 只要「建出文件」，内容稍后由 Java 复制写入

      const abs = destPathOf(resolver, uri, fileName);
      albumLog('相册目标文件：' + abs);

      const wrote = copyInJava(srcPath, abs, uri);
      albumLog('已复制 ' + wrote + ' 字节进相册');

      const done = finishMediaRow(resolver, uri, abs, ContentValues);
      return { uri: done.uri, path: done.path || abs, size: done.size || wrote };
    } catch (e) {
      try { if (uri) jdelete(resolver, uri, null, null); } catch (_) {}   // 别留下半截文件
      throw e;
    }
  }

  // —— 兜底通道：交给 5+ 自带的「保存到系统相册」（plus.gallery.save）——
  // 它是 DCloud 原生实现的，内部同样走 MediaStore，字节完全在原生层搬；
  // 我们只负责把源文件复制进应用私有目录 —— 那一步也是 plus.io 原生复制，字节同样不过 JS 桥。
  // 用在 MediaStore 直搬失败时（某些 ROM 不允许直接写 _data 路径），保证「图一定存得进相册」。
  function docFileAbs(name) {
    let p = '';
    try { p = String(plus.io.convertLocalFileSystemURL('_doc/' + name) || ''); } catch (e) {}
    if (p.indexOf('file://') === 0) p = p.slice(7);
    return p;
  }
  function removeDocFile(name) {
    try {
      plus.io.resolveLocalFileSystemURL('_doc/', (dir) => {
        try {
          dir.getFile(name, { create: false }, (f) => { try { f.remove(() => {}, () => {}); } catch (e) {} }, () => {});
        } catch (e) {}
      }, () => {});
    } catch (e) {}
  }
  function curStrOf(c, name) {
    const i = curCol(c, name);
    return i >= 0 ? (curStr(c, i) || '') : '';
  }
  function rowById(id) {
    const resolver = getResolver();
    const coll = imagesCollection();
    if (!resolver || !coll || !id) return null;
    let uriObj = null;
    try { uriObj = plus.android.invoke('android.net.Uri', 'withAppendedPath', coll, String(id)); } catch (e) {}
    if (!uriObj) return null;
    let data = '';
    const c = jquery(resolver, uriObj, null, null);
    try { if (c && curFirst(c)) data = curStrOf(c, '_data'); } catch (e) {} finally { curClose(c); }
    return { uri: uriToString(uriObj), data: data };
  }
  function rowByName(name) {
    const resolver = getResolver();
    const coll = imagesCollection();
    if (!resolver || !coll || !name) return null;
    let id = '';
    const c = jquery(resolver, coll, '_display_name=?', [name]);
    try { if (c && curFirst(c)) id = curStrOf(c, '_id'); } catch (e) {} finally { curClose(c); }
    if (!id) return null;
    return rowById(id);
  }
  async function gallerySave(srcPath, fileName) {
    if (!hasPlus() || !plus.gallery || typeof plus.gallery.save !== 'function') {
      throw new Error('当前底座没有 plus.gallery.save');
    }
    if (String(srcPath || '').indexOf('content://') === 0) {
      throw new Error('源是 content://，plus.gallery.save 通道不支持');
    }
    const srcEntry = await resolveEntry(srcPath);
    const dirEntry = await new Promise((resolve, reject) => {
      // 相对路径写法各底座不完全一致：'_doc/' 与 '_doc' 都试一次
      const done = (d) => resolve(d);
      const fail = () => {
        try { plus.io.resolveLocalFileSystemURL('_doc', done, (e) => reject(e || new Error('拿不到 _doc 目录'))); }
        catch (e) { reject(e); }
      };
      try { plus.io.resolveLocalFileSystemURL('_doc/', done, fail); } catch (e) { fail(); }
    });
    // 临时文件直接叫最终文件名（已带唯一 id + 随机后缀），相册里就是这个名字
    await new Promise((resolve, reject) => {
      try {
        srcEntry.copyTo(dirEntry, fileName, () => resolve(null),
          (e) => reject(new Error('复制到应用目录失败：' + errText(e))));
      } catch (e) { reject(e); }
    });
    const tmp = docFileAbs(fileName);
    let saved = {};
    try {
      saved = await new Promise((resolve, reject) => {
        try {
          plus.gallery.save(tmp || ('_doc/' + fileName),
            (r) => resolve(r || {}),
            (e) => reject(new Error('系统相册保存失败：' + errText(e))));
        } catch (e) { reject(e); }
      });
    } catch (e) {
      removeDocFile(fileName);
      throw e;
    }
    removeDocFile(fileName);          // 相册里已经有一份，私有目录这份删掉
    const row = rowByName(fileName);
    if (!row && !saved.path) throw new Error('系统相册保存成功，但找不到登记');
    // 系统相册的默认目录不一定是 GoJo：尽量把它挪进 Pictures/GoJo，挪不动也不影响使用
    let path = (row && row.data) || String(saved.path || '') || tmp;
    if (row && row.uri) {
      try {
        const CV = javaClass('android.content.ContentValues');
        if (CV) {
          const cv = new CV();
          putValue(cv, 'relative_path', 'Pictures/' + ALBUM_DIR);
          jupdate(resolverOf(), row.uri, cv);
          const moved = rowById(String(row.uri).split('/').pop());
          if (moved && moved.data) path = moved.data;
        }
      } catch (e) { albumLog('挪进 GoJo 目录失败（图片已在相册里，不影响使用）', e); }
    }
    return { uri: (row && row.uri) || '', path: path, size: absFileLen(path) };
  }

  // 通过 MediaStore 的「图片」集合落盘（没有源文件时用：备份导入 / 老数据迁移 / 网页拖拽）。
  // 与 mediaStoreCopyFile 的差别只在「字节从哪来」：这里从 base64 分块解码。
  function mediaStoreWrite(b64, fileName, mime) {
    const resolver = getResolver();
    if (!resolver) throw new Error('拿不到 ContentResolver（不是 5+ 真机环境？）');
    const coll = imagesCollection();
    if (!coll) throw new Error('系统没有可用的图片集合 URI');

    const B64 = plus.android.importClass('android.util.Base64');
    if (!B64 || typeof B64.decode !== 'function') throw new Error('当前底座不支持 Base64 解码');
    const ContentValues = plus.android.importClass('android.content.ContentValues');
    if (!ContentValues) throw new Error('拿不到 ContentValues');

    const abs = albumAbsPath(fileName);
    let uri = null, os = null;
    try {
      uri = insertMediaRow(resolver, coll, fileName, mime, ContentValues);

      const outs = jcall(resolver, 'openOutputStream', uri);
      os = outs.ok ? outs.v : null;
      if (!os) throw new Error('打不开相册写入流（openOutputStream 返回空）');
      writeToStream(os, b64, B64);   // 分块解码、逐块写入
      closeStream(os);
      os = null;

      const info = finishMediaRow(resolver, uri, abs, ContentValues);
      const want = b64Bytes(b64);
      if (want > 0 && info.size > 0 && info.size !== want) throw new Error('写入体积不符（' + info.size + '/' + want + ' 字节）');
      return { uri: info.uri, path: info.path, size: info.size || want };
    } catch (e) {
      try { if (os) os.close(); } catch (_) {}
      try { if (uri) jdelete(resolver, uri, null, null); } catch (_) {}   // 别留下半截文件
      throw e;
    }
  }

  // 写一张图进相册。返回 { uri, path, size }
  // 三条通道，按「代价从低到高」排，成功一条就收工：
  //   ① Android 10+ 且手上就有源文件（相册选图是绝大多数）→ MediaStore 流复制，字节不过 JS；
  //   ② Android 9 及以下 → plus.io copyTo，系统级复制，也最快；
  //   ③ 手上只有 base64（导入 / 迁移）→ 分块解码后写 MediaStore 或直写文件。
  // 全部失败就如实抛错，不再偷偷改存应用内 —— 上层据此提示「图片保存失败」并让用户重试。
  async function writeAlbum(src, fileName, mime) {
    const sdk = sdkInt();
    await ensureWritePerm();          // 保存前先确保存储权限已经申请过
    const input = src || {};
    let bytes = input.b64 || null;
    const needBytes = async () => {
      if (!bytes && input.getB64) bytes = await input.getB64();
      return bytes;
    };
    const srcPath = String(input.srcPath || '');
    albumLog('开始写入相册：' + fileName + '，API=' + (sdk || '未知')
      + '，方式=' + (srcPath ? (sdk >= 29 ? 'MediaStore 流复制' : 'plus.io 复制') : '字节写入'));

    // srcErr：直接搬源文件那一步的失败原因（最接近真相）
    // srcErr2：系统相册保存通道的失败原因
    // b64Err：字节通道的失败原因（多半只是「拿不到图片数据」这种次生结果）
    // 最终错误把前两条都带上 —— 只报最后一条会把真正的病因盖掉，排查时最误导人。
    let srcErr = null, srcErr2 = null, b64Err = null;

    // ① Android 10+：MediaStore 直搬（Java 侧复制，字节不进 JS）
    if (srcPath && sdk >= 29) {
      try {
        return mediaStoreCopyFile(srcPath, fileName, mime);
      } catch (e) {
        srcErr = e;
        albumLog('MediaStore 直搬失败，改用系统相册保存通道', e);
      }
      // ①-b 系统相册保存通道（plus.gallery.save，DCloud 原生实现）
      try {
        const r = await gallerySave(srcPath, fileName);
        albumLog('已保存到相册（系统相册通道）：' + r.path + (r.size > 0 ? '（' + r.size + ' 字节）' : ''));
        return r;
      } catch (e) {
        srcErr2 = e;
        albumLog('系统相册保存通道也失败，改用字节写入', e);
      }
    }

    // ② Android 9 及以下：系统级复制到公共目录
    if (srcPath && sdk < 29) {
      try {
        const r = await copyToAlbum(srcPath, fileName);
        albumLog('已复制到相册：' + r.path + '（' + r.size + ' 字节）');
        scanToGallery(r.path, mime);     // 只排一次后台扫描，不等它返回
        return r;
      } catch (e) {
        srcErr = e;
        albumLog('plus.io 复制失败，改用字节写入', e);
      }
    }

    // ③ 兜底通道：base64 分块写入（导入 / 迁移 / 上面两步都失败时）
    try {
      const b64 = await needBytes();
      if (!b64) throw new Error('拿不到图片数据');
      if (sdk >= 29) return mediaStoreWrite(b64, fileName, mime);
      const abs = albumAbsPath(fileName);
      ensureAlbumDir();
      writeBytesOnce(abs, b64);
      albumLog('已直接写入文件：' + abs);
      scanToGallery(abs, mime);
      return { uri: '', path: abs, size: absFileLen(abs) };
    } catch (e) {
      b64Err = e;
      albumLog('写入相册失败', e);
    }

    const parts = [];
    if (srcErr) parts.push('相册直搬失败：' + errText(srcErr));
    if (srcErr2) parts.push('系统相册通道失败：' + errText(srcErr2));
    if (!parts.length && b64Err) parts.push('字节写入失败：' + errText(b64Err));
    const finalErr = new Error(parts.length ? parts.join('；') : '图片写入相册失败');
    albumLog('图片写入相册失败：' + finalErr.message);
    throw finalErr;
  }

  // ---- 读取：三条通道依次尝试，全失败就返回空串（上层当作「图片丢失」） ----
  function readByPlusIo(abs) {
    return new Promise((resolve) => {
      try {
        if (!plus.io || typeof plus.io.resolveLocalFileSystemURL !== 'function') { resolve(''); return; }
        plus.io.resolveLocalFileSystemURL('file://' + abs, (entry) => {
          try {
            entry.file((file) => {
              try {
                const fr = new plus.io.FileReader();
                fr.onloadend = (e) => {
                  const d = (e && e.target && e.target.result) || fr.result || '';
                  const s = String(d);
                  const i = s.indexOf('base64,');
                  resolve(i >= 0 ? s.slice(i + 7) : '');
                };
                fr.onerror = () => resolve('');
                fr.readAsDataURL(file);
              } catch (e) { resolve(''); }
            }, () => resolve(''));
          } catch (e) { resolve(''); }
        }, () => resolve(''));
      } catch (e) { resolve(''); }
    });
  }

  // 用 plus 相对路径读（'_doc/.cache/xxx' 这种）：私有目录里的文件中转时用它，
  // 不经过绝对路径，绕开「绝对路径解析失败」的所有可能。
  function readPlusFile(rel) {
    return new Promise((resolve) => {
      try {
        plus.io.resolveLocalFileSystemURL(rel, (entry) => {
          try {
            entry.file((file) => {
              try {
                const fr = new plus.io.FileReader();
                fr.onloadend = () => {
                  const s = String(fr.result || '');
                  const i = s.indexOf('base64,');
                  resolve(i >= 0 ? s.slice(i + 7) : '');
                };
                fr.onerror = () => resolve('');
                fr.readAsDataURL(file);
              } catch (e) { resolve(''); }
            }, () => resolve(''));
          } catch (e) { resolve(''); }
        }, () => resolve(''));
      } catch (e) { resolve(''); }
    });
  }

  // 读取中转用的私有缓存目录。相册文件在 /storage/emulated/0，plus.io 够不着（分区存储），
  // 但应用自己的 _doc 一定读得到 —— 所以把相册文件复制过来读，读完立刻删。
  let cacheDirReady = false;
  let readPathLogged = false;        // 读图通道只在第一次成功时打一行日志，别刷屏
  function tempCopyPath() {
    const base = privateDoc();
    if (!base) return '';
    const dir = base + '/.cache';
    if (!cacheDirReady) {
      try {
        const File = javaClass('java.io.File');
        const f = new File(dir);
        cacheDirReady = (f.exists() || f.mkdirs()) ? true : false;
      } catch (e) { return ''; }
      if (!cacheDirReady) return '';
    }
    const name = 'rd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.bin';
    return dir + '/' + name;
  }

  // 任意来源（相册绝对路径 / content:// / 私有路径）→ base64；读不到返回 ''。
  // 这是整套读图方案的核心，两条通道都不让字节经过 JS 桥：
  //   ① 私有目录（以及系统允许直读的路径）→ plus.io.FileReader 原生读，最快，不产生副本；
  //   ② 相册里的文件 → Java 侧 FileChannel.transferTo 整份复制到 _doc/.cache（写相册用的同一套
  //      搬运方式，已在真机验证），再用 plus.io 读这份私有副本，读完立即删除。
  //   注意：绝不能用「byte[] 缓冲 + read 循环」在 JS 里读 —— 本底座上 read 的返回值不是数字，
  //   循环一次都不跑，最后只得到一个空串，和写相册那次「0 字节」是同一个病根。
  async function fileToB64(src) {
    const s = String(src || '');
    if (!s) return '';
    if (s.indexOf('content://') !== 0) {
      const abs = srcAbs(s);
      // Android 10+ 的 plus.io 根本进不了 /storage 这类公共目录（分区存储），直接跳过这一步，
      // 省掉每次读图都白跑一次注定失败的文件系统解析。
      const skipDirect = sdkInt() >= 29 && abs.indexOf('/storage/') === 0;
      if (abs && abs.charAt(0) === '/' && !skipDirect) {
        const direct = await readByPlusIo(abs);
        if (direct) return direct;
      }
    }
    return copyToTempAndRead(s);
  }

  // 复制到私有缓存再读：Java 侧整份搬字节（FileChannel.transferTo，和写相册同一套已验证的方式），
  // 再用 plus.io.FileReader 读私有副本，读完立刻删。任何来源（content:// / 绝对路径）都能吃。
  async function copyToTempAndRead(src) {
    const tmp = tempCopyPath();
    if (!tmp) return '';
    const rel = '_doc/.cache/' + tmp.split('/').pop();
    try {
      copyInJava(src, tmp);          // Java 侧整份复制，字节不进 JS
      const got = await readPlusFile(rel);
      if (!got) albumLog('读取图片失败（复制成功但读不出内容）：' + src);
      else if (!readPathLogged) {
        readPathLogged = true;
        albumLog('读图通道就绪（Java 复制 → 私有缓存 → plus.io 读取），首张 ' + got.length + ' 字节 base64');
      }
      return got;
    } catch (e) {
      albumLog('读取图片失败：' + src, e);
      return '';
    } finally {
      deleteAbsFile(tmp);            // 中转副本不留痕
    }
  }

  // 读一张相册图 → base64；读不到返回 ''（文件被相册误删 / 被清理软件删掉）。
  // 优先绝对路径（私有目录可直读，零复制），失败再用 content://（openFileDescriptor，
  // 不受分区存储的路径权限影响）—— 有些 ROM 只放开其中一条。
  async function readAlbumB64(meta) {
    const abs = meta.albumPath || '';
    const uri = meta.albumUri || '';
    if (abs) { const s = await fileToB64(abs); if (s) return s; }
    if (uri) { const s = await copyToTempAndRead(uri); if (s) return s; }
    return '';
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

  // 源文件 → base64：只在「按路径直接写失败」的兜底通道里用得到（正常写入根本不读字节）。
  // 与读相册图走同一条通道，避免再维护两套读字节的写法。
  const srcToB64 = (srcPath) => fileToB64(srcPath);

  // —— 图片存取 ——
  // img = { id, name, type, size, blob, srcPath }
  //   srcPath：图片在手机上的真实路径（相册多选 / 拖拽进来的本地文件）。
  //   有它就整份复制进相册 —— 字节在 Java 侧搬，不经过 JS，几十 MB 的图也不会出错。
  // 落库后的元数据（真机）：
  //   { id, name, type, size, albumPath, albumUri }
  // 只存路径，不存原图二进制 —— 原图本体在手机相册 Pictures/GoJo 里。
  // 从这一版起不再生成任何缩略图：相册里只有一张高清原图，列表直接用原图 + CSS 等比缩放。
  async function saveImage(img) {
    // ① 5+ 真机：原图写相册，库里只留路径。写不进去就抛错（不再偷偷改存应用内）。
    if (hasPlus()) {
      const fileName = albumFileName(img.id, img.type, img.name);
      const mime = mimeOf(img.name, img.type);
      // 有源文件路径就整份搬字节；只有 Blob 时现转 base64（导入 / 迁移）
      const saved = await writeAlbum({
        srcPath: img.srcPath || '',
        getB64: () => (img.blob ? blobToBase64(img.blob) : srcToB64(img.srcPath)),
      }, fileName, mime);
      const size = (saved.size > 0) ? saved.size : (Number(img.size) || 0);
      const meta = {
        id: img.id, name: img.name, type: mime, size: size,
        albumPath: saved.path, albumUri: saved.uri || '', native: false,
      };
      return put('images', meta);
    }
    if (isNative() && FS()) {
      const ext = extOf(img.type, img.name);
      const fullPath = 'gt/images/' + img.id + '.' + ext;
      await FS().writeFile({ path: fullPath, data: await blobToBase64(img.blob), directory: 'Documents', recursive: true });
      return put('images', { id: img.id, name: img.name, type: img.type, size: img.size, fullPath, native: true });
    }
    return put('images', { id: img.id, name: img.name, type: img.type, size: img.size, blob: img.blob }); // web：直接存原图
  }

  async function readImageBlob(id) {
    const meta = await get('images', id); if (!meta) return null;
    // 相册图：文件被误删 / 被清理软件干掉时读不到内容 → 返回 null，
    // 调用方据此显示「图片丢失」，而不是扔一个裂图出来。
    if (meta.albumPath || meta.albumUri) {
      const b64 = await readAlbumB64(meta);
      if (!b64) { evictURL(id); return null; }
      return base64ToBlob(b64, meta.type);
    }
    if (meta.native && FS()) {
      const r = await FS().readFile({ path: meta.fullPath, directory: 'Documents' });
      return base64ToBlob(r.data, meta.type);
    }
    return meta.blob || null;
  }
  const urlCache = {};
  async function getImageURL(id) {
    if (urlCache[id]) return urlCache[id];
    const b = await readImageBlob(id); if (!b) return null;
    const u = URL.createObjectURL(b); urlCache[id] = u; return u;
  }
  function evictURL(id) { if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }

  // 删掉一个绝对路径的文件（失败静默）
  function deleteAbsFile(abs) {
    if (!abs || abs.charAt(0) !== '/' || !hasPlus()) return false;
    try {
      const File = plus.android.importClass('java.io.File');
      const f = new File(abs);
      return !!f.delete();
    } catch (e) { return false; }
  }

  // —— 删除闸门：只认 Pictures/GoJo 里的文件 ——
  // 任何「删相册图」的动作都必须先过这道判断，路径不在这个专属目录里的一律不碰，
  // 防止因为元数据错乱 / 路径写错而误删用户其它照片。
  function inAlbum(p) {
    const s = String(p || '').replace(/\\/g, '/');
    return s.indexOf('/Pictures/' + ALBUM_DIR + '/') > -1;
  }
  // ContentResolver：所有 insert / openOutputStream / query / delete 的入口。
  // 5+ 各底座对「Java 对象的方法有没有挂到 JS 代理上」处理不一致，直接
  // runtimeMainActivity().getContentResolver() 在部分版本会抛「不是函数」——
  // 这里三条路都试（直调 → 反射 → importClass 后重试），拿到就缓存。
  let resolverCache = null;
  function getResolver() {
    if (resolverCache) return resolverCache;
    let main = null;
    try { main = plus.android.runtimeMainActivity(); } catch (e) { return null; }
    if (!main) return null;
    try { plus.android.importClass(main); } catch (e) {}
    let r = null;
    try { r = main.getContentResolver(); } catch (e) {}
    if (!r) { try { r = plus.android.invoke(main, 'getContentResolver'); } catch (e) {} }
    if (!r) { return null; }
    try { plus.android.importClass(r); } catch (e) {}
    resolverCache = r;
    return r;
  }
  function resolverOf() { return getResolver(); }
  function baseName(p) {
    const s = String(p || '');
    return s.slice(s.lastIndexOf('/') + 1);
  }

  // 在媒体库里把「这一张图」的登记全部找出来。
  // 同一个文件可能被登记不只一次（重复扫描、按路径和按 uri 各一条），漏掉任何一条，
  // 相册里就会留下一个点开一片灰的占位格 —— 这正是「删了记录还残留灰图」的成因。
  // 三条线索都查：
  //   ① _data 路径精确匹配（老系统 / 兼容模式）；
  //   ② GoJo 目录 + 文件名（分区存储下 _data 可能取不到，靠这条兜底）；
  //   ③ 只按文件名再查一次（个别 ROM 的 selection 组合不支持，查错会抛错，忽略换下一条）。
  // 按名字查到的必须再验一次目录，绝不误删别人的同名照片；名字是我们自己生成的
  // （GoJo_<id>_<随机>.<ext>），极端情况下查不到目录字段时用命名规则兜底。
  function findMediaRows(resolver, coll, path) {
    const rows = [];
    const seen = {};
    const abs = String(path || '');
    const name = baseName(abs);
    const ours = /^GoJo_/i.test(name);      // 本 App 生成的文件名
    const needDir = name && !ours;

    const collect = (c, checkDir) => {
      const ii = curCol(c, '_id');
      if (ii < 0) return;
      const di = curCol(c, '_data');
      const ri = curCol(c, 'relative_path');
      const id = curStr(c, ii);
      if (!id || seen[id]) return;
      const data = di >= 0 ? curStr(c, di) : '';
      const rel = ri >= 0 ? curStr(c, ri) : '';
      if (checkDir) {
        // 名字是本 App 生成的（GoJo_<id>_<随机>.<ext>）时，目录不再作为限制条件 ——
        // 走 plus.gallery.save 兜底写入的图可能落在 Pictures 根目录，不能因为目录不对就漏删。
        const okDir = ours || inAlbum(data) || rel === ('Pictures/' + ALBUM_DIR) || (!data && !rel && !needDir);
        if (!okDir) return;
      }
      seen[id] = true;
      rows.push({ id: id, data: data });
    };

    const tries = [];
    if (abs && inAlbum(abs)) tries.push(['_data=?', [abs], false]);
    if (name) {
      tries.push(['relative_path=? AND _display_name=?', ['Pictures/' + ALBUM_DIR, name], true]);
      tries.push(['_display_name=?', [name], true]);
    }
    for (let i = 0; i < tries.length; i++) {
      let c = null;
      try {
        c = jquery(resolver, coll, tries[i][0], tries[i][1]);
        if (!c) continue;
        while (curNext(c)) collect(c, tries[i][2]);
      } catch (e) { /* 列不存在 / selection 不支持：换下一条线索 */ }
      finally { curClose(c); }
    }
    return rows;
  }

  // 走系统媒体库删除。和「保存」时的多通路兜底一个思路：
  //   ① 保存时记下的 content:// uri —— Android 10+ 最正规的一条，索引 + 文件一起清；
  //   ② 路径 / 文件名查到的每一条登记，按 _id 删；
  //   ③ 部分 ROM 只认「拼好 id 的 content:// 地址」，再删一次；
  //   ④ 查到 0 条时直接按 _data / relative_path+文件名 批量清（老数据没记 uri 全靠这条）。
  // 任何一步删到东西就算成功；全部落空返回 false，交给上层补扫。
  function deleteFromMediaStore(path, uri) {
    if (!hasPlus()) return false;
    const sdk = sdkInt();
    const resolver = resolverOf(); if (!resolver) return false;
    const coll = imagesCollection();
    let hit = false;

    if (uri) {
      try {
        const Uri = plus.android.importClass('android.net.Uri');
        if (jdelete(resolver, Uri.parse(String(uri)), null, null) > 0) {
          hit = true; albumLog('媒体库已按 uri 删除（API=' + sdk + '）：' + uri);
        }
      } catch (e) { albumLog('按 uri 删除失败，改用路径 / 文件名继续'); }   // 不打印异常对象，避免控制台报红
    }
    if (!coll) return hit;

    const rows = findMediaRows(resolver, coll, path);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try { if (jdelete(resolver, coll, '_id=?', [String(r.id)]) > 0) hit = true; } catch (e) {}
      try {
        const Uri = plus.android.importClass('android.net.Uri');
        const one = Uri.withAppendedPath(coll, String(r.id));
        if (one && jdelete(resolver, one, null, null) > 0) hit = true;
      } catch (e) {}
      if (r.data) {
        try { if (jdelete(resolver, coll, '_data=?', [String(r.data)]) > 0) hit = true; } catch (e) {}
      }
    }
    if (rows.length) { albumLog('媒体库已清掉 ' + rows.length + ' 条登记：' + (path || uri || '')); return hit; }

    // ④ 一条都没查到：直接按条件清（有的 ROM 用 query 查不到，但 delete 能删掉）
    const nm = baseName(path);
    if (path && inAlbum(path)) {
      try { if (jdelete(resolver, coll, '_data=?', [String(path)]) > 0) hit = true; } catch (e) {}
    }
    if (nm) {
      try { if (jdelete(resolver, coll, 'relative_path=? AND _display_name=?', ['Pictures/' + ALBUM_DIR, nm]) > 0) hit = true; } catch (e) {}
    }
    if (hit) albumLog('媒体库登记已清空（按条件）：' + (path || uri || ''));
    return hit;
  }

  // 文件删掉之后，必须让媒体库重新扫一遍这个路径：
  // 文件已经不存在，系统扫到就会把那条登记清掉 —— 这是 Android 9 及以下、
  // 以及「直写落盘」那种没留下 uri 的图，擦掉相册灰块的关键一步。
  // 扫描是异步的，永远丢到下一个事件循环，不阻塞删除主链路。
  function rescanAfterDelete(abs) {
    if (!abs) return;
    const fire = () => {
      try {
        const MSC = plus.android.importClass('android.media.MediaScannerConnection');
        if (MSC && typeof MSC.scanFile === 'function') {
          MSC.scanFile(plus.android.runtimeMainActivity(), [abs], null, null);
          albumLog('已请求媒体库重扫（擦掉残留索引）：' + abs);
        }
      } catch (e) {
        // 老系统没有 scanFile(context, paths, mimes, cb) 这个重载时，退回单路径写法
        try {
          const MSC = plus.android.importClass('android.media.MediaScannerConnection');
          if (MSC && typeof MSC.scanFile === 'function') MSC.scanFile(plus.android.runtimeMainActivity(), abs, null);
        } catch (e2) { albumLog('请求媒体库重扫失败（不影响文件已删除）', e2); }
      }
    };
    try { setTimeout(fire, 0); } catch (e) { fire(); }
  }

  // 一次完整的「让这张图从相册彻底消失」：清索引 → 删文件 → 重扫 → 补一刀。
  // 顺序是先索引后文件：反过来先删文件，很多 ROM 会把那条登记留成灰块。
  // 只对 Pictures/GoJo 内的文件动手；uri 是我们自己保存时登记过的，可以单独按它删。
  function purgeAlbumEntry(path, uri) {
    const abs = String(path || '');
    const fileOk = !!abs && inAlbum(abs);
    let hit = false;

    hit = deleteFromMediaStore(fileOk ? abs : '', uri) || hit;

    if (fileOk) {
      if (deleteAbsFile(abs)) hit = true;
      else if (absFileLen(abs) > 0) albumLog('物理文件暂时删不掉（可能被占用），稍后重试：' + abs);
    } else if (abs) {
      albumLog('跳过删除物理文件：不在 Pictures/' + ALBUM_DIR + ' 内 → ' + abs);
    }
    if (abs) rescanAfterDelete(abs);

    // 补一刀（只补一次，绝不循环）：扫描是异步的，个别 ROM 会把登记先标成待删。
    // 上面已经删干净时，这里是空操作。
    if (fileOk || uri) {
      const again = () => {
        try { deleteFromMediaStore(fileOk ? abs : '', uri); } catch (e) {}
        try { if (fileOk && absFileLen(abs) > 0) deleteAbsFile(abs); } catch (e) {}
      };
      try { setTimeout(again, 700); } catch (e) { again(); }
    }
    return hit;
  }

  async function deleteImage(id) {
    const meta = await get('images', id); if (!meta) return;
    // 相册原图：先清媒体库索引，再删物理文件，最后补一次重扫。
    // 只删 Pictures/GoJo 内的文件；但「我们自己登记过的 uri」可以单独按 uri 删 ——
    // 路径拿不到时（老数据 / 导入数据）全靠这一条把灰块擦掉。
    if (meta.albumPath || meta.albumUri) {
      let path = meta.albumPath || '';
      const uri = meta.albumUri || '';
      if (!path && uri) {
        const resolver = resolverOf();
        if (resolver) {
          try {
            const Uri = plus.android.importClass('android.net.Uri');
            path = queryCol(resolver, Uri.parse(uri), '_data') || '';
            if (path) albumLog('已从媒体库查到原图路径：' + path);
          } catch (e) {}
        }
      }
      if (inAlbum(path) || uri) {
        purgeAlbumEntry(path, uri);
        albumLog('已删除相册原图：' + (path || uri));
      } else {
        albumLog('跳过删除：不在 Pictures/' + ALBUM_DIR + ' 内 → ' + (path || uri || '未知'));
      }
    }
    // 兼容老数据：残留的私有缩略图（新版本已不再生成）
    if (meta.thumbPath && meta.thumbPath.charAt(0) === '/') deleteAbsFile(meta.thumbPath);
    if (meta.native && FS()) {
      try { await FS().deleteFile({ path: meta.fullPath, directory: 'Documents' }); } catch (e) {}
      if (meta.thumbPath) { try { await FS().deleteFile({ path: meta.thumbPath, directory: 'Documents' }); } catch (e) {} }
    }
    evictURL(id);
    await del('images', id);
  }
  async function deleteImages(ids) { for (const id of ids) { try { await deleteImage(id); } catch (e) {} } }

  // —— 清理相册里遗留的模糊小图 ——
  // 老版本把封面缩略图也写进了 Pictures/GoJo，于是同一张照片在相册里会出现两张
  //（一张高清原图 + 一张模糊小图）。这里扫描一次相册，把宽度 < 400px 的删掉：
  //   · 只处理 Pictures/GoJo 目录，别的照片一律不碰；
  //   · 仍被记录引用（albumPath）的图跳过 —— 那是用户的真实原图，宁可留着也不错删。
  // 返回 { scanned, removed }。
  const JUNK_WIDTH = 400;
  function bitmapWidth(path) {
    try {
      const BF = plus.android.importClass('android.graphics.BitmapFactory');
      const Opt = plus.android.importClass('android.graphics.BitmapFactory$Options');
      if (!BF || !Opt) return 0;
      const opt = new Opt();
      try { opt.inJustDecodeBounds = true; } catch (e) { try { plus.android.setAttribute(opt, 'inJustDecodeBounds', true); } catch (_) {} }
      BF.decodeFile(path, opt);
      return Number(opt.outWidth) || 0;   // 只读图头，不解码像素，几乎不耗内存
    } catch (e) { return 0; }
  }
  let junkBusy = false;
  async function cleanAlbumJunk() {
    if (!hasPlus() || junkBusy) return { scanned: 0, removed: 0 };
    junkBusy = true;
    let scanned = 0, removed = 0;
    try {
      // 记录里引用的路径：绝不删
      const keep = {};
      try {
        ((await getAll('images')) || []).forEach((m) => {
          if (m.albumPath) keep[String(m.albumPath)] = true;
          if (m.albumUri) keep[String(m.albumUri)] = true;
        });
      } catch (e) {}

      const resolver = resolverOf();
      const coll = imagesCollection();
      const seen = {};
      const dir = picturesBase() + '/' + ALBUM_DIR;
      // 目录能不能列出来：能列说明 File.exists() 可信；列不出来多半是没拿到存储权限，
      // 此时「一张都不活」只是在骗人，绝不能拿它去批量清索引（会把好图的登记删掉）。
      let dirOk = false;
      try {
        const File = plus.android.importClass('java.io.File');
        dirOk = !!new File(dir).list();
      } catch (e) { dirOk = false; }

      // ① 媒体库里登记的 GoJo 图片：先全部读出来，再分两轮处理
      //   （先读全量是为了判断「文件是不是真的都没了」，见下面的 dead 判定）
      if (resolver && coll) {
        const rows = [];
        let c = null;
        try {
          // 先按「目录前缀」筛，筛不出来再退回全量查（个别底座不支持这种 selection 参数）
          c = jquery(resolver, coll, '_data LIKE ?', ['%/Pictures/' + ALBUM_DIR + '/%']);
          if (!c) c = jquery(resolver, coll, null, null);
          while (curNext(c || null)) {
            const idIdx = curCol(c, '_id');
            const dIdx = curCol(c, '_data');
            const wIdx = curCol(c, 'width');
            const mid = idIdx >= 0 ? String(curNum(c, idIdx)) : '';
            const path = dIdx >= 0 ? curStr(c, dIdx) : '';
            if (!path || !inAlbum(path)) continue;
            rows.push({ mid: mid, path: path, w: wIdx >= 0 ? curNum(c, wIdx) : 0, alive: absFileLen(path) !== 0 });
          }
        } catch (e) {
          // 这一步只是「顺手打扫」，任何异常都不该刷屏：安静降级，不影响使用。
          albumLog('媒体库查询不可用，本轮跳过相册清理');
        } finally { curClose(c); }
        // 查不到任何行（多数是底座不支持 query）：这一轮直接结束，交给下面的磁盘清理，
        // 绝不再去调 delete 之类的方法，避免同样的报错再刷一次屏。

        // 读不到文件有可能只是没拿到存储权限（分区存储下 File.exists 会一律返回 false），
        // 那种情况绝不能当成「文件都已删除」去批量清索引 —— 一张都不活且目录也读不到就整体跳过。
        const aliveCount = rows.filter((r) => r.alive).length;
        const trustAlive = aliveCount > 0 || dirOk;

        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          scanned++;
          seen[r.path] = true;
          if (keep[r.path]) continue;

          // ①-A 失效登记：文件已经不在了，这条记录就是相册里那块「点开一片灰」的占位图。
          // 之前删记录只删了文件、没清索引，历史遗留的灰块全在这一步被擦掉。
          if (!r.alive && trustAlive) {
            try { jdelete(resolver, coll, '_id=?', [String(r.mid)]); } catch (e) {}
            removed++;
            albumLog('已清理相册失效登记（灰块）：' + r.path);
            continue;
          }

          // ①-B 老版本写进相册的模糊小图（宽 < 400px）
          let w = r.w;
          if (!w) w = bitmapWidth(r.path);
          if (w > 0 && w < JUNK_WIDTH) {
            try { jdelete(resolver, coll, '_id=?', [String(r.mid)]); } catch (e) {}
            deleteAbsFile(r.path);
            rescanAfterDelete(r.path);
            removed++;
            albumLog('已清理相册小图：' + r.path + '（宽 ' + w + 'px）');
          }
        }
      }

      // ② 磁盘上没进媒体库的文件（老版本直写产生的）也清一遍
      try {
        const File = plus.android.importClass('java.io.File');
        const list = new File(dir).list();
        const n = list ? list.length : 0;
        for (let i = 0; i < n; i++) {
          const name = String(list[i] || '');
          if (!/\.(jpe?g|png|webp|gif|bmp)$/i.test(name)) continue;
          const p = dir + '/' + name;
          if (seen[p] || keep[p]) continue;
          scanned++;
          const w = bitmapWidth(p);
          if (w > 0 && w < JUNK_WIDTH) {
            deleteAbsFile(p);
            removed++;
            albumLog('已清理相册小图（磁盘）：' + p + '（宽 ' + w + 'px）');
          }
        }
      } catch (e) {}
    } catch (e) { albumLog('清理相册小图出错', e); }
    junkBusy = false;
    if (removed) albumLog('相册小图清理完成：检查 ' + scanned + ' 张，删除 ' + removed + ' 张');
    return { scanned, removed };
  }

  // 批量读取（用于导出）：返回 {id, type, name, full: Blob}
  // 备份包只装原图；新版本不再有缩略图，导入时也不生成。
  async function readImageForExport(id) {
    const meta = await get('images', id); if (!meta) return null;
    const full = await readImageBlob(id);
    return { id, type: meta.type, name: meta.name, full };
  }

  // 估算已用空间（原图在相册里，不在浏览器配额里，所以按图片元数据补上）
  async function estimateUsage() {
    let imgBytes = 0;
    try {
      const imgs = (await getAll('images')) || [];
      imgs.forEach((i) => { imgBytes += (i.size || 0) + ((i.thumbBlob && i.thumbBlob.size) || 0); });
    } catch (e) {}
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: (e.usage || 0) + imgBytes, quota: e.quota || 0, fallback: false };
      }
    } catch (e) {}
    return { usage: imgBytes, quota: 0, fallback: true };
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
      } else if (meta.thumbPath && meta.thumbPath.charAt(0) === '/') {
        // 5+ 相册方案：缩略图是应用私有目录里的真实文件
        if (deleteAbsFile(meta.thumbPath)) count++;
        meta.thumbPath = null;
        if (meta.thumbBlob) delete meta.thumbBlob;
        touched = true;
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
    // 5+ 相册方案补刀：私有缩略图目录里已经没有引用的孤儿文件
    if (hasPlus()) {
      const base = privateDoc();
      if (base) {
        try {
          const File = plus.android.importClass('java.io.File');
          const list = new File(base + '/gt/thumbs').list();
          const n = list ? list.length : 0;
          for (let i = 0; i < n; i++) {
            try { if (new File(base + '/gt/thumbs/' + list[i]).delete()) count++; } catch (e) {}
          }
        } catch (e) {}
      }
    }
    clearURLCache();
    return { count, bytes };
  }

  // —— 历史数据搬迁：把存在 IndexedDB 里的原图挪进相册 ——
  // 老版本把图片二进制直接塞在 IndexedDB 里（库越来越大、相册里也看不到）。
  // 这里在后台分批搬：原图 → Pictures/GoJo，缩略图 → 应用私有目录，库里只留路径。
  // 每次启动最多搬 maxPerRun 张，失败立刻停手并保留原 Blob（绝不把图弄丢）。
  let migBusy = false;
  async function migrateBlobsToAlbum(maxPerRun) {
    if (!hasPlus() || migBusy) return { moved: 0 };
    migBusy = true;
    let moved = 0;
    try {
      const imgs = (await getAll('images')) || [];
      const limit = maxPerRun || 6;
      for (const meta of imgs) {
        if (moved >= limit) break;
        if (meta.albumPath || !meta.blob) continue;
        try {
          const fileName = albumFileName(meta.id, meta.type, meta.name);
          const saved = await writeAlbum({ getB64: () => blobToBase64(meta.blob) }, fileName, meta.type || 'image/jpeg');
          meta.albumPath = saved.path;
          meta.albumUri = saved.uri || '';
          // 老数据里的缩略图字段不再需要：列表直接用原图
          delete meta.thumbBlob; delete meta.thumbPath; delete meta.thumbW; delete meta.thumbH;
          delete meta.blob;
          // 注意：不 revoke 旧的 objectURL —— 已经渲染出来的 <img> 还得靠它显示。
          await put('images', meta);
          moved++;
        } catch (e) { break; }
      }
    } catch (e) {}
    migBusy = false;
    return { moved };
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

  // —— 反向对账：相册里被用户删掉的图，App 内对应记录也要一起删掉 ——
  // 正向（App 删记录 → 删相册图）由 deleteImage 负责；这里补「反向」：
  // 扫描 images 表，凡是 albumPath / albumUri 指向的相册文件已经不存在的，就是相册被删的残留，
  // 删掉这条 images 记录，并从所有 records 的 imageIds 里摘除引用。
  // 带 trustAlive 防护：只有能确认文件系统可读（目录能列 / 抽样有活文件）时才动手，
  // 避免没拿到存储权限时把有效记录误删。仅启动时触发一次。
  function albumFileAlive(meta) {
    if (!meta) return false;
    // 1) 有绝对路径：直接 stat 最准
    if (meta.albumPath) return absFileLen(meta.albumPath) !== 0;
    // 2) 仅有 media uri：查它当前指向的文件路径再 stat
    if (meta.albumUri) {
      try {
        const resolver = resolverOf();
        if (resolver) {
          const Uri = plus.android.importClass('android.net.Uri');
          const p = queryCol(resolver, Uri.parse(String(meta.albumUri)), '_data');
          if (p) return absFileLen(p) !== 0;
        }
      } catch (e) {}
      return false; // 既无路径又取不到有效 _data：保守视为已失效
    }
    // 3) 既无路径也无 uri（老数据）：无法定位相册文件，保守认为还在以免误删
    return true;
  }

  let reconBusy = false;
  async function reconcileAlbumMissing() {
    if (!hasPlus() || reconBusy) return { checked: 0, removed: 0 };
    reconBusy = true;
    let checked = 0, removed = 0;
    try {
      const imgs = (await getAll('images')) || [];
      if (!imgs.length) return { checked: 0, removed: 0 };

      // trustAlive 防护：确认文件系统可读，避免无权限时把有效记录误删
      const dir = picturesBase() + '/' + ALBUM_DIR;
      let dirOk = false;
      try { const File = plus.android.importClass('java.io.File'); dirOk = !!new File(dir).list(); } catch (e) { dirOk = false; }
      let aliveSample = 0, sampled = 0;
      for (let i = 0; i < imgs.length && sampled < 20; i++) {
        const m = imgs[i];
        if (m.albumPath) { sampled++; if (absFileLen(m.albumPath) !== 0) aliveSample++; }
      }
      const trustAlive = dirOk || aliveSample > 0;
      if (!trustAlive) { albumLog('reconcile：无法确认文件系统可读（无权限？），跳过以免误删'); return { checked: 0, removed: 0, skipped: true }; }

      const orphans = [];
      for (const m of imgs) { checked++; if (!albumFileAlive(m)) orphans.push(m); }
      if (!orphans.length) return { checked, removed: 0 };

      const orphanIds = new Set(orphans.map((m) => m.id));
      try {
        const recs = (await getAll('records')) || [];
        for (const rec of recs) {
          if (rec.imageIds && rec.imageIds.some((id) => orphanIds.has(id))) {
            rec.imageIds = rec.imageIds.filter((id) => !orphanIds.has(id));
            try { await put('records', rec); } catch (e) {}
          }
        }
      } catch (e) { albumLog('reconcile：清理 records 引用失败', e); }

      for (const m of orphans) {
        try {
          if (m.thumbPath && m.thumbPath.charAt(0) === '/') deleteAbsFile(m.thumbPath);
          if (m.native && FS()) { try { if (m.thumbPath) await FS().deleteFile({ path: m.thumbPath, directory: 'Documents' }); } catch (e) {} }
          evictURL(m.id);
          await del('images', m.id);
          removed++;
          albumLog('reconcile：已清理相册已删图片的残留记录 ' + (m.albumPath || m.albumUri || m.id));
        } catch (e) {}
      }
    } catch (e) { albumLog('reconcile 出错', e); } finally { reconBusy = false; }
    if (removed) albumLog('reconcile 完成：检查 ' + checked + ' 条，清理 ' + removed + ' 条相册已删的残留记录');
    return { checked, removed };
  }

  // —— 安全上限自动清理：只对可安全删除的内容生效，有效原图永不自动清 ——
  // 阈值：缩略图总占用 > 200MB 自动 clearThumbs；orphan 残留记录 > 500 条自动 reconcile。
  // 在启动时（与 reconcile 同批次）调用；不另加定时 / 回前台触发。
  async function maybeAutoClean() {
    if (!hasPlus()) return { triggered: false };
    try {
      const imgs = (await getAll('images')) || [];
      let thumbBytes = 0, orphan = 0;
      for (const m of imgs) {
        if (m.thumbBlob && m.thumbBlob.size) thumbBytes += m.thumbBlob.size;
        if (m.thumbPath && m.thumbPath.charAt(0) === '/') { try { const s = absFileLen(m.thumbPath); if (s > 0) thumbBytes += s; } catch (e) {} }
        if (!albumFileAlive(m)) orphan++;
      }
      const THUMB_LIMIT = 200 * 1024 * 1024;
      const ORPHAN_LIMIT = 500;
      const did = [];
      let removed = 0;
      if (thumbBytes > THUMB_LIMIT) { try { await clearThumbs(); did.push('thumbs'); } catch (e) {} }
      if (orphan > ORPHAN_LIMIT) { try { const rr = await reconcileAlbumMissing(); did.push('orphans'); removed += (rr && rr.removed) || 0; } catch (e) {} }
      if (did.length) albumLog('maybeAutoClean：超阈值自动清理 ' + did.join(',') + '（缩略图 ' + thumbBytes + 'B / orphan ' + orphan + '）');
      return { triggered: did.length > 0, thumbBytes, orphan, removed };
    } catch (e) { albumLog('maybeAutoClean 出错', e); return { triggered: false }; }
  }

  return {
    open, get, getAll, put, del, clear,
    isNative, hasPlus, saveImage, getImageURL, deleteImage, deleteImages, readImageForExport, evictURL,
    estimateUsage, clearURLCache, ensurePersisted, clearThumbs, migrateBlobsToAlbum, cleanAlbumJunk, inAlbum,
    reconcileAlbumMissing, maybeAutoClean,
    ALBUM_SHOW: ALBUM_SHOW,
    readAlbumB64,
    uid: () => 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    now: () => Date.now(),
  };
})();
