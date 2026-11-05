/*!
 * md-toolbar.js — Markdown 工具栏的「算文本 + 算选区」纯函数层
 *
 * 移植自 @github/markdown-toolbar-element v2.2.3（MIT License）
 *   https://github.com/github/markdown-toolbar-element
 * 原库本体是自定义元素（<markdown-toolbar> / <md-bold> …）；这里只保留其中最值钱的那部分：
 * 把「选区怎么扩、记号怎么加、再点一次怎么脱」全部算准的纯函数，去掉自定义元素外壳。
 * 函数体逐字保留（isMultipleLines → compute 共 17 个），只做下面 4 处改造。
 *
 * 【改造 1】新增 placeholder：空选区且光标处没有词可扩时，插入「**粗体**」这类占位并选中占位文字。
 *            原库只插一对空记号、光标夹在中间，中文用户看不出发生了什么。
 * 【改造 2】link 的 replaceNext 由 'url' 改成 'https://'：md.js 的 inline() 只放行
 *            http(s)/mailto/#，「[](url)」在详情页里连链接都不算，用户还得自己删掉 url。
 * 【改造 3】mark（==高亮==）是 App 扩展（md.js 已支持 ==> <mark>），走同一条 trimFirst 包裹路径。
 * 【改造 4】跨类型前缀互斥：原库的「列表 / 引用 / 任务」是三套互不相识的前缀引擎，
 *            「- [ ] 甲」点无序会退化成「[ ] 甲」（内容被吃）、「> 甲」点有序会叠成「1. > 甲」。
 *            这里在三处做了「先剥掉别的块前缀再加自己的」。
 *
 * 与原库的另一个差异：compute() 只返回 { text, selectionStart, selectionEnd }，
 * 不写 textarea.value、不调 execCommand —— 落地交给 records.js 的 applyValue（要接 App 的自建撤销栈）。
 */
window.App = window.App || {};
App.mdToolbar = (function () {
  'use strict';

  // —————————————————————— 基础工具 ——————————————————————

  function isMultipleLines(s) { return String(s).trim().split('\n').length > 1; }
  function repeatStr(s, n) { return new Array(n + 1).join(s); }
  function startsWith(s, p) { return !!p && String(s).slice(0, p.length) === p; }
  function endsWith(s, p) { return !!p && String(s).slice(String(s).length - p.length) === p; }

  // 「别的块前缀」：标题 / 引用 / 任务项 / 无序 / 有序（行首最多 3 个空白，与 Markdown 一致）
  var RE_BLOCK_ANY = /^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,3}[.)][ \t]+|>[ \t]?)/;
  // 只算「非列表」的块前缀：给列表用，列表自己的前缀交给 undoOrdered/undoUnordered 判
  var RE_BLOCK_NONLIST = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/;
  var RE_TASK_LINE = /^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/;

  function stripEach(text, re) {
    return String(text).split('\n').map(function (line) { return line.replace(re, ''); }).join('\n');
  }

  // 空选区时向左右扩到「词」；选区两边正好是记号时把记号也圈进来（这样再点一次就是脱掉）
  function wordSelectionStart(text, i) {
    var index = i;
    while (text[index] && text[index - 1] != null && !text[index - 1].match(/\s/)) index -= 1;
    return index;
  }
  function wordSelectionEnd(text, i, multiline) {
    var index = i;
    var breakpoint = multiline ? /\n/ : /\s/;
    while (text[index] && !text[index].match(breakpoint)) index += 1;
    return index;
  }

  function expandSelectedText(ta, prefixToUse, suffixToUse, multiline) {
    if (ta.selectionStart === ta.selectionEnd) {
      ta.selectionStart = wordSelectionStart(ta.value, ta.selectionStart);
      ta.selectionEnd = wordSelectionEnd(ta.value, ta.selectionEnd, multiline);
    } else {
      var expandedStart = ta.selectionStart - prefixToUse.length;
      var expandedEnd = ta.selectionEnd + suffixToUse.length;
      var beginsWithPrefix = ta.value.slice(expandedStart, ta.selectionStart) === prefixToUse;
      var endsWithSuffix = ta.value.slice(ta.selectionEnd, expandedEnd) === suffixToUse;
      if (beginsWithPrefix && endsWithSuffix) {
        ta.selectionStart = expandedStart;
        ta.selectionEnd = expandedEnd;
      }
    }
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  }

  // 选区扩到整行（列表 / 标题用）
  function expandSelectionToLine(ta) {
    var lines = ta.value.split('\n');
    var counter = 0;
    for (var index = 0; index < lines.length; index += 1) {
      var lineLength = lines[index].length + 1;
      if (ta.selectionStart >= counter && ta.selectionStart < counter + lineLength) ta.selectionStart = counter;
      if (ta.selectionEnd >= counter && ta.selectionEnd < counter + lineLength) ta.selectionEnd = counter + lineLength - 1;
      counter += lineLength;
    }
  }

  // 块级语法（引用 / 任务）前后各留一个空行，免得粘在上一段末尾
  function newlinesToSurroundSelectedText(ta) {
    var beforeSelection = ta.value.slice(0, ta.selectionStart);
    var afterSelection = ta.value.slice(ta.selectionEnd);
    var breaksBefore = beforeSelection.match(/\n*$/);
    var breaksAfter = afterSelection.match(/^\n*/);
    var newlinesBeforeSelection = breaksBefore ? breaksBefore[0].length : 0;
    var newlinesAfterSelection = breaksAfter ? breaksAfter[0].length : 0;
    var newlinesToAppend = '';
    var newlinesToPrepend = '';
    if (beforeSelection.match(/\S/) && newlinesBeforeSelection < 2) newlinesToAppend = repeatStr('\n', 2 - newlinesBeforeSelection);
    if (afterSelection.match(/\S/) && newlinesAfterSelection < 2) newlinesToPrepend = repeatStr('\n', 2 - newlinesAfterSelection);
    return { newlinesToAppend: newlinesToAppend, newlinesToPrepend: newlinesToPrepend };
  }

  // —————————————————————— 行内 / 块级包裹 ——————————————————————
  // 加粗、斜体、删除线、高亮、代码、链接、引用都走它
  function blockStyle(ta, arg) {
    var prefix = arg.prefix;
    var suffix = arg.suffix;
    var blockPrefix = arg.blockPrefix;
    var blockSuffix = arg.blockSuffix;
    var replaceNext = arg.replaceNext;
    var scanFor = arg.scanFor;
    var originalSelectionStart = ta.selectionStart;
    var originalSelectionEnd = ta.selectionEnd;

    var selectedText = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    var prefixToUse = (isMultipleLines(selectedText) && blockPrefix.length > 0) ? (blockPrefix + '\n') : prefix;
    var suffixToUse = (isMultipleLines(selectedText) && blockSuffix.length > 0) ? ('\n' + blockSuffix) : suffix;

    if (arg.prefixSpace) {
      var beforeSelection = ta.value[ta.selectionStart - 1];
      if (ta.selectionStart !== 0 && beforeSelection != null && !beforeSelection.match(/\s/)) prefixToUse = ' ' + prefixToUse;
    }
    selectedText = expandSelectedText(ta, prefixToUse, suffixToUse, arg.multiline);
    var selectionStart = ta.selectionStart;
    var selectionEnd = ta.selectionEnd;
    var hasReplaceNext = replaceNext.length > 0 && suffixToUse.indexOf(replaceNext) > -1 && selectedText.length > 0;
    var newlinesToAppend = '';
    var newlinesToPrepend = '';
    if (arg.surroundWithNewlines) {
      var ref = newlinesToSurroundSelectedText(ta);
      newlinesToAppend = ref.newlinesToAppend;
      newlinesToPrepend = ref.newlinesToPrepend;
      prefixToUse = newlinesToAppend + prefix;
      suffixToUse += newlinesToPrepend;
    }

    // ① 已经带着记号 → 脱掉（对称记号再点一次 = 取消，通用工具栏的标准行为）
    if ((prefixToUse || suffixToUse) && startsWith(selectedText, prefixToUse) && endsWith(selectedText, suffixToUse)) {
      var stripped = selectedText.slice(prefixToUse.length, selectedText.length - suffixToUse.length);
      if (originalSelectionStart === originalSelectionEnd) {
        var pos = originalSelectionStart - prefixToUse.length;
        pos = Math.max(pos, selectionStart);
        pos = Math.min(pos, selectionStart + stripped.length);
        selectionStart = pos;
        selectionEnd = pos;
      } else {
        selectionEnd = selectionStart + stripped.length;
      }
      return { text: stripped, selectionStart: selectionStart, selectionEnd: selectionEnd };
    }

    // 【改造 1】空选区 + 没词可扩 → 插入占位并选中它，用户直接打字就是替换
    var ph = arg.placeholder;
    if (ph && !selectedText.length) {
      return {
        text: prefixToUse + ph + suffixToUse,
        selectionStart: originalSelectionStart + prefixToUse.length,
        selectionEnd: originalSelectionStart + prefixToUse.length + ph.length
      };
    }

    // ② 普通包裹（trimFirst：首尾空白留在记号外面，只包住文字本体）
    if (!hasReplaceNext) {
      var replacementText = prefixToUse + selectedText + suffixToUse;
      selectionStart = originalSelectionStart + prefixToUse.length;
      selectionEnd = originalSelectionEnd + prefixToUse.length;
      var whitespaceEdges = selectedText.match(/^\s*|\s*$/g);
      if (arg.trimFirst && whitespaceEdges) {
        var leadingWhitespace = whitespaceEdges[0] || '';
        var trailingWhitespace = whitespaceEdges[1] || '';
        replacementText = leadingWhitespace + prefixToUse + selectedText.trim() + suffixToUse + trailingWhitespace;
        selectionStart += leadingWhitespace.length;
        selectionEnd -= trailingWhitespace.length;
      }
      return { text: replacementText, selectionStart: selectionStart, selectionEnd: selectionEnd };
    }

    // ③ 链接：选中文本本身就是网址 → 文字和地址都用它
    //    【改造 2b】原库这里只返回 prefixToUse + suffixToUse，会把选中的文字整个丢掉，
    //    得到「[](https://x.com)」这种有地址没文字的空链接。这里把正文也带上。
    if (scanFor.length > 0 && selectedText.match(scanFor)) {
      suffixToUse = suffixToUse.replace(replaceNext, selectedText);
      return {
        text: prefixToUse + selectedText + suffixToUse,
        selectionStart: selectionStart + prefixToUse.length,
        selectionEnd: selectionStart + prefixToUse.length + selectedText.length
      };
    }

    // ④ 链接：没有网址 → 选中 https:// 占位，用户直接输入域名
    var out = prefixToUse + selectedText + suffixToUse;
    var s2 = selectionStart + prefixToUse.length + selectedText.length + suffixToUse.indexOf(replaceNext);
    return { text: out, selectionStart: s2, selectionEnd: s2 + replaceNext.length };
  }

  // 多行逐行加前后缀（引用 / 任务列表）
  function multilineStyle(ta, arg) {
    var prefix = arg.prefix;
    var suffix = arg.suffix;
    var raw = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    var selectionStart = ta.selectionStart;
    var selectionEnd = ta.selectionEnd;
    var lines = raw.split('\n');
    var undoStyle = lines.every(function (line) { return startsWith(line, prefix) && endsWith(line, suffix); });
    var text;
    if (undoStyle) {
      text = lines.map(function (line) { return line.slice(prefix.length, line.length - suffix.length); }).join('\n');
      selectionEnd = selectionStart + text.length;
    } else {
      // 【改造 4】先把别的块前缀（# / > / - / 1. / - [ ] ）剥掉再加自己的，否则会叠成「1. > 甲」
      text = lines.map(function (line) { return prefix + line.replace(RE_BLOCK_ANY, '') + suffix; }).join('\n');
      if (arg.surroundWithNewlines) {
        var ref = newlinesToSurroundSelectedText(ta);
        selectionStart += ref.newlinesToAppend.length;
        selectionEnd = selectionStart + text.length;
        text = ref.newlinesToAppend + text + ref.newlinesToPrepend;
      }
    }
    return { text: text, selectionStart: selectionStart, selectionEnd: selectionEnd };
  }

  // —————————————————————— 列表（有序 / 无序）——————————————————————

  function undoOrderedListStyle(text) {
    var lines = text.split('\n');
    var orderedListRegex = /^\d+\.\s+/;
    var shouldUndo = lines.every(function (line) { return orderedListRegex.test(line); });
    var result = shouldUndo ? lines.map(function (line) { return line.replace(orderedListRegex, ''); }) : lines;
    return { text: result.join('\n'), processed: shouldUndo };
  }
  function undoUnorderedListStyle(text) {
    var lines = text.split('\n');
    var prefix = '- ';
    var shouldUndo = lines.every(function (line) { return startsWith(line, prefix); });
    var result = shouldUndo ? lines.map(function (line) { return line.slice(prefix.length); }) : lines;
    return { text: result.join('\n'), processed: shouldUndo };
  }
  function makePrefix(index, unorderedList) {
    return unorderedList ? '- ' : (index + 1) + '. ';
  }
  function clearExistingListStyle(style, selectedText) {
    var undoResult, undoResultOpositeList, pristineText;
    if (style.orderedList) {
      undoResult = undoOrderedListStyle(selectedText);
      undoResultOpositeList = undoUnorderedListStyle(undoResult.text);
      pristineText = undoResultOpositeList.text;
    } else {
      undoResult = undoUnorderedListStyle(selectedText);
      undoResultOpositeList = undoOrderedListStyle(undoResult.text);
      pristineText = undoResultOpositeList.text;
    }
    return [undoResult, undoResultOpositeList, pristineText];
  }

  function listStyle(ta, style) {
    var noInitialSelection = ta.selectionStart === ta.selectionEnd;
    var selectionStart = ta.selectionStart;
    var selectionEnd = ta.selectionEnd;
    expandSelectionToLine(ta);
    var selectedText = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    var lineList = selectedText.split('\n');
    var nonEmpty = lineList.filter(function (l) { return l.trim(); });

    // 【改造 4】两种「前缀打架」先在这里拆掉：
    //   a) 整段都是任务项（- [ ] / - [x]）→ 先只留文字本体，且禁止走「取消列表」短路
    //      否则任务项点「无序」会被当成「已是无序」直接脱成「[ ] 甲」（内容被吃）
    //   b) 整段是标题 / 引用 → 先剥掉这些前缀，否则会叠成「1. > 甲」
    var wasTask = nonEmpty.length > 0 && nonEmpty.every(function (l) { return RE_TASK_LINE.test(l); });
    if (wasTask) {
      selectedText = lineList.map(function (l) { return l.replace(RE_TASK_LINE, '$1'); }).join('\n');
    } else if (nonEmpty.some(function (l) { return RE_BLOCK_NONLIST.test(l); })) {
      selectedText = stripEach(selectedText, RE_BLOCK_NONLIST);
    }

    var res = clearExistingListStyle(style, selectedText);
    var undoResult = res[0];
    var undoResultOpositeList = res[1];
    var pristineText = res[2];

    var prefixedLines = pristineText.split('\n').map(function (value, index) {
      return makePrefix(index, style.unorderedList) + value;
    });
    var totalPrefixLength = prefixedLines.reduce(function (prev, _cur, idx) {
      return prev + makePrefix(idx, style.unorderedList).length;
    }, 0);
    var totalPrefixLengthOpositeList = prefixedLines.reduce(function (prev, _cur, idx) {
      return prev + makePrefix(idx, !style.unorderedList).length;
    }, 0);

    // 已经是同一种列表 → 取消（wasTask 时不算，见改造 4a）
    if (undoResult.processed && !wasTask) {
      if (noInitialSelection) {
        selectionStart = Math.max(selectionStart - makePrefix(0, style.unorderedList).length, 0);
        selectionEnd = selectionStart;
      } else {
        selectionStart = ta.selectionStart;
        selectionEnd = ta.selectionEnd - totalPrefixLength;
      }
      return { text: pristineText, selectionStart: selectionStart, selectionEnd: selectionEnd };
    }

    var ref = newlinesToSurroundSelectedText(ta);
    var newlinesToAppend = ref.newlinesToAppend;
    var newlinesToPrepend = ref.newlinesToPrepend;
    var text = newlinesToAppend + prefixedLines.join('\n') + newlinesToPrepend;

    if (noInitialSelection) {
      selectionStart = Math.max(selectionStart + makePrefix(0, style.unorderedList).length + newlinesToAppend.length, 0);
      selectionEnd = selectionStart;
    } else if (undoResultOpositeList.processed) {
      // 有序 ↔ 无序互转：选区长度按两边前缀长度差修正
      selectionStart = Math.max(ta.selectionStart + newlinesToAppend.length, 0);
      selectionEnd = ta.selectionEnd + newlinesToAppend.length + totalPrefixLength - totalPrefixLengthOpositeList;
    } else {
      selectionStart = Math.max(ta.selectionStart + newlinesToAppend.length, 0);
      selectionEnd = ta.selectionEnd + newlinesToAppend.length + totalPrefixLength;
    }

    return { text: text, selectionStart: selectionStart, selectionEnd: selectionEnd };
  }

  // —————————————————————— 样式表 + 分发 ——————————————————————
  // 行内：prefix/suffix 对称包裹；trimFirst 保住首尾空白
  // 块级：multiline 逐行加前缀；surroundWithNewlines 前后补空行
  var STYLES = {
    bold: { prefix: '**', suffix: '**', trimFirst: true, placeholder: '粗体' },
    italic: { prefix: '_', suffix: '_', trimFirst: true, placeholder: '斜体' },
    strike: { prefix: '~~', suffix: '~~', trimFirst: true, placeholder: '删除线' },
    mark: { prefix: '==', suffix: '==', trimFirst: true, placeholder: '高亮' },
    code: { prefix: '`', suffix: '`', blockPrefix: '```', blockSuffix: '```', placeholder: '代码' },
    // 【改造 2】replaceNext 用 'https://' 而不是原库的 'url'
    link: { prefix: '[', suffix: '](https://)', replaceNext: 'https://', scanFor: 'https?://', placeholder: '' },
    unordered: { prefix: '- ', multiline: true, unorderedList: true },
    ordered: { prefix: '1. ', multiline: true, orderedList: true },
    task: { prefix: '- [ ] ', multiline: true, surroundWithNewlines: true },
    quote: { prefix: '> ', multiline: true, surroundWithNewlines: true }
  };

  var DEFAULTS = {
    prefix: '', suffix: '', blockPrefix: '', blockSuffix: '',
    multiline: false, replaceNext: '', prefixSpace: false, scanFor: '',
    surroundWithNewlines: false, orderedList: false, unorderedList: false,
    trimFirst: false, placeholder: ''
  };
  function withDefaults(s) {
    var out = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    if (s) for (k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
    return out;
  }

  // 原库 styleSelectedText 的「只算不写」版
  function compute(ta, styleArgs) {
    if (!ta) return null;
    var arg = withDefaults(styleArgs);
    var res;
    if (arg.orderedList || arg.unorderedList) res = listStyle(ta, arg);
    // 【改造 4b】原库只对「真跨行」走 multilineStyle，单行的引用 / 任务会落到 blockStyle，
    // 那里不剥别的块前缀，于是「# 甲」点引用会叠成「> # 甲」。multilineStyle 对单行同样成立，统一走它。
    else if (arg.multiline) res = multilineStyle(ta, arg);
    else res = blockStyle(ta, arg);
    if (!res) return null;
    // 只做「非负 / 有序」的粗修，上界交给落地方按最终全文长度夹（res.text 只是替换片段，不是全文）
    var a = Math.max(0, Math.round(res.selectionStart || 0));
    var b = Math.max(0, Math.round(res.selectionEnd == null ? a : res.selectionEnd));
    if (b < a) { var t = a; a = b; b = t; }
    return { text: res.text, selectionStart: a, selectionEnd: b };
  }

  return {
    compute: compute,
    STYLES: STYLES,
    expandSelectionToLine: expandSelectionToLine
  };
})();
