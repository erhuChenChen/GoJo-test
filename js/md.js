/* ===== md.js — 极轻量 Markdown 渲染器（无依赖 / 离线可用 / 单次线性扫描）=====
 *
 * 设计原则：
 *   ① 先整体 HTML 转义，再做 Markdown 替换 —— 源文本里的 <script> 之类永远只是文字，
 *      不会被当成标签执行（本项目的正文全部来自用户输入）。
 *   ② 只实现「够用」的子集，覆盖记录正文与使用说明的常见写法：
 *      # 标题(1~6) / **粗体** / *斜体* / ~~删除线~~ / ==高亮== / `行内代码` / ```代码块``` /
 *      [文字](链接) / - 无序列表 / - [ ] 任务列表 / 1. 有序列表 / > 引用 / --- 分隔线 / 空行分段 / 换行
 *   ③ 纯字符串拼接，不做 DOM 中间态、不做回溯型正则 —— 一屏正文里几十行也就几毫秒。
 */
window.App = window.App || {};
App.md = (function () {
  // HTML 转义：& 必须最先换，否则后续替换出来的 &lt; 会被二次转义
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 行内语法（输入必须是已转义的文本）
  function inline(s) {
    // 行内代码：先抽出来占位，避免里面的 ** / * 被当成语法
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    // 链接 [文字](地址)：只放行 http/https/mailto/#，其它一律原样保留（不生成链接）
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)?/g, function (m, text, href) {
      if (!/^(https?:\/\/|mailto:|#)/i.test(href)) return m;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });

    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // 高亮 ==文字==（GFM 之外的常见扩展）：放在删除线之后、单星号斜体之前，
    // 免得 == 里的内容先被 * 规则吃掉；单个 = 不匹配，`a == b` 不会误伤。
    s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    // 单星号斜体：前后不能紧贴字母数字，避免 3*4*5 这种被误判
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

    // 还原行内代码
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return '<code>' + codes[Number(i)] + '</code>';
    });
    return s;
  }

  var RE_UL = /^[-*+]\s+/;
  // 任务列表：RE_UL 剥掉「- 」之后，剩下的开头是 [ ] / [x]
  var RE_TASK = /^\[([ xX])\][ \t]+/;
  var RE_OL = /^\d{1,3}[.)]\s+/;
  var RE_QUOTE = /^>\s?/;
  var RE_HR = /^([-*_])(\s*\1){2,}$/;
  var RE_HEAD = /^(#{1,6})\s+(.*)$/;
  var RE_FENCE = /^```/;

  function render(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    var lines = text.split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (!para.length) return;
      // 段内单个换行 → <br>（用户写说明时习惯直接回车换行）
      out.push('<p>' + para.map(function (l) { return inline(esc(l)); }).join('<br>') + '</p>');
      para = [];
    }

    while (i < lines.length) {
      var raw = lines[i];
      var t = raw.trim();

      // 代码块 ```：原样保留内部内容（只转义，不解析）
      if (RE_FENCE.test(t)) {
        flushPara();
        var buf = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        out.push('<pre class="md-pre"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 空行：结束当前段落
      if (!t) { flushPara(); i++; continue; }

      // 分隔线
      if (RE_HR.test(t)) { flushPara(); out.push('<hr>'); i++; continue; }

      // 标题
      var m = RE_HEAD.exec(t);
      if (m) {
        flushPara();
        var lv = m[1].length;
        out.push('<h' + lv + '>' + inline(esc(m[2])) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 引用：连续多行并成一块，块内递归解析（可以放列表/标题）
      if (RE_QUOTE.test(t)) {
        flushPara();
        var qb = [];
        while (i < lines.length && RE_QUOTE.test(lines[i].trim())) {
          qb.push(lines[i].trim().replace(RE_QUOTE, ''));
          i++;
        }
        out.push('<blockquote>' + render(qb.join('\n')) + '</blockquote>');
        continue;
      }

      // 无序列表（含任务列表：- [ ] 待办 / - [x] 已完成）
      if (RE_UL.test(t)) {
        flushPara();
        var ub = [];
        while (i < lines.length && RE_UL.test(lines[i].trim())) {
          ub.push(lines[i].trim().replace(RE_UL, ''));
          i++;
        }
        out.push('<ul>' + ub.map(function (x) {
          var tk = RE_TASK.exec(x);
          // 任务项与普通项可以在同一个 <ul> 里混排：只给任务项加类，普通项仍是圆点
          if (tk) {
            return '<li class="md-task-item' + (tk[1].toLowerCase() === 'x' ? ' done' : '') + '">' +
              inline(esc(x.slice(tk[0].length))) + '</li>';
          }
          return '<li>' + inline(esc(x)) + '</li>';
        }).join('') + '</ul>');
        continue;
      }

      // 有序列表
      if (RE_OL.test(t)) {
        flushPara();
        var start = parseInt(t, 10) || 1;
        var ob = [];
        while (i < lines.length && RE_OL.test(lines[i].trim())) {
          ob.push(lines[i].trim().replace(RE_OL, ''));
          i++;
        }
        var attr = (start !== 1) ? ' start="' + start + '"' : '';
        out.push('<ol' + attr + '>' + ob.map(function (x) { return '<li>' + inline(esc(x)) + '</li>'; }).join('') + '</ol>');
        continue;
      }

      // 普通段落行（保留行首缩进之外的空白，交给 CSS 处理）
      para.push(raw.replace(/^\s+/, ''));
      i++;
    }
    flushPara();
    return out.join('');
  }

  // 便捷入口：把 Markdown 写进一个已有元素（每次都整块替换，避免残留旧节点）
  function into(el, src) {
    if (!el) return el;
    el.innerHTML = render(src);
    return el;
  }

  // 剥掉 Markdown 记号、只留纯文字。plain()（卡片摘要）和 count()（字数统计）
  // 共用这一套规则，免得两处口径漂移：摘要里看到的字和胶囊上数的字必须一致。
  // 注意：这里只处理「记号」本身，代码块内的正文照样保留（摘要那边另有整段删除）。
  function stripMarks(src) {
    return String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]*```.*$/gm, '')                        // 代码块围栏行（块内文字保留）
      .replace(/`([^`\n]+)`/g, '$1')                          // 行内代码：去反引号
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')                // 标题 #
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')                     // 引用 >
      .replace(/^[ \t]{0,3}[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')  // 任务列表 - [ ] / - [x]（必须先于无序列表剥，否则只剩 [ ]）
      .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')                 // 无序列表
      .replace(/^[ \t]{0,3}\d{1,3}[.)][ \t]+/gm, '')           // 有序列表 1. / 1)
      .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')    // 分隔线 --- *** ___
      .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')            // 图片 ![alt](url)：只留 alt
      .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')             // 链接 [文字](url)：只留文字
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/==([^=\n]+)==/g, '$1')                         // 高亮 ==文字==
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1$2');
  }

  // 去掉 Markdown 记号、只留纯文字：给列表卡片摘要这类「不能排版的地方」用，
  // 否则卡片上会直接看到 ## / ** 这些符号。
  function plain(src) {
    return stripMarks(String(src == null ? '' : src).replace(/```[\s\S]*?```/g, ' '))
      .replace(/[ \t]+$/gm, '')      // 代码块被换成空格后会留下「只有空格」的行，先擦掉
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // 字数：只算文字与标点，Markdown 记号不计，空白（空格/换行/制表符/全角空格）也不计。
  // 按「码点」数而不是 value.length：表情符号算 1 个字，不会被 UTF-16 拆成 2。
  // 刻意不用 Array.from / 展开运算符 —— 老安卓 WebView 上没有它们。
  function count(src) {
    var s = stripMarks(src);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code >= 0xDC00 && code <= 0xDFFF) continue;   // 代理对的后半个，跳过
      if (/\s/.test(s.charAt(i))) continue;             // 空白不计
      n++;
    }
    return n;
  }

  return { render: render, into: into, plain: plain, count: count, escape: esc };
})();
