// 把根目录的纯 web 资源收集到 www/（Capacitor 的 webDir）。
// 根目录保持「可读源码」，用于开发与本地预览；www/ 是压缩后的打包副本，只给 Capacitor 用。
// 压缩策略刻意保守：只去注释 / 缩进 / 多余空白，绝不重命名、绝不改动表达式，语义 100% 不变。
//
// 注意：这里用逐文件递归复制（不用 fs.cpSync）——某些受限环境下 cpSync 复制目录会
// 直接被中断，逐文件 copyFileSync 则完全稳定。
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const www = path.join(root, 'www');

// 需要打包进 App 的资源（node_modules / android / .workbuddy 等都不会进 www）
const items = ['index.html', 'css', 'js', 'assets'];

const stats = { before: 0, after: 0, files: 0 };

// —— CSS：去注释 + 折叠空白（本项目 CSS 已无 url()/data URI，折叠绝对安全）——
function minifyCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim() + '\n';
}

// —— JS：只删「整行注释」与行首缩进，保留换行（避免 ASI 语义变化）——
function minifyJs(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      if (end === -1) { inBlock = true; continue; }
      line = t.slice(end + 2);
      if (!line.trim()) continue;
    }
    out.push(line.trim());
  }
  return out.join('\n') + '\n';
}

// —— HTML：去注释 + 折叠标签之间的空白与换行 ——
function minifyHtml(src) {
  return src
    .replace(/<!--(?!\[)[\s\S]*?-->/g, '')
    .replace(/[ \t]*\r?\n\s*/g, '\n')
    .replace(/>\n+</g, '><')
    .trim() + '\n';
}

function transform(destPath, src) {
  const ext = path.extname(destPath).toLowerCase();
  const isMinified = /\.min\.js$/i.test(destPath); // 已是压缩产物，原样拷
  let out = src;
  if (!isMinified) {
    if (ext === '.css') out = minifyCss(src);
    else if (ext === '.js') out = minifyJs(src);
    else if (ext === '.html' || ext === '.htm') out = minifyHtml(src);
  }
  if (out !== src) {
    stats.before += Buffer.byteLength(src);
    stats.after += Buffer.byteLength(out);
    stats.files++;
  }
  return out;
}

// 逐文件递归复制 + 边拷边压
function copyTree(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const raw = fs.readFileSync(src, 'utf8');
  // 二进制/图片等非文本资源直接按字节复制
  if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp3|mp4)$/i.test(src)) {
    fs.writeFileSync(dest, fs.readFileSync(src));
    return;
  }
  fs.writeFileSync(dest, transform(dest, raw));
}

if (fs.existsSync(www)) fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

for (const it of items) {
  const src = path.join(root, it);
  if (!fs.existsSync(src)) continue;
  copyTree(src, path.join(www, it));
  console.log('[copy-web] + ' + it);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const saved = stats.before - stats.after;
const pct = stats.before ? ((saved / stats.before) * 100).toFixed(1) : '0';
console.log('[copy-web] 压缩 ' + stats.files + ' 个文件：' + kb(stats.before) + ' → ' + kb(stats.after) +
  '（省 ' + kb(saved) + ' / ' + pct + '%）');
console.log('[copy-web] done -> www/');
