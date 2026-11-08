/**
 * MyHub 에디터 핵심 함수들 (테스트 가능하도록 분리)
 * pell 방식: 모든 변이는 execCommand로 수행 → 네이티브 undo 자동 기록
 */

function wrapSelectionStyle(style) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) {
    document.execCommand('insertHTML', false,
      `<span data-tmp style="${style}">\u200B</span>`);
    const span = document.querySelector('span[data-tmp]');
    if (span) {
      span.removeAttribute('data-tmp');
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return;
  }
  const div = document.createElement('div');
  div.appendChild(range.cloneContents());
  document.execCommand('insertHTML', false,
    `<span style="${style}">${div.innerHTML}</span>`);
}

function unwrapElement(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

const INLINE_TAGS = new Set(['B','STRONG','I','EM','U','S','STRIKE','DEL','SUB','SUP','CODE','FONT']);

function clearInlineFormatting(editorEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let range = sel.getRangeAt(0);
  if (range.collapsed) {
    const node = sel.anchorNode;
    if (!node) return;
    const block = node.nodeType === 3 ? node.parentElement : node;
    if (!block) return;
    const target = block.closest('p,div,li,h1,h2,h3,blockquote') || editorEl;
    range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const div = document.createElement('div');
  div.appendChild(range.cloneContents());
  div.querySelectorAll('b,strong,i,em,u,s,strike,del,sub,sup,code,font,a')
    .forEach(unwrapElement);
  div.querySelectorAll('span[style]').forEach(sp => {
    sp.removeAttribute('style');
    if (!sp.attributes.length) unwrapElement(sp);
  });
  div.querySelectorAll('b,i,u,s,strike,span').forEach(el => {
    if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
  });
  document.execCommand('insertHTML', false, div.innerHTML);
  // 선택이 여러 인라인 요소를 가로지를 때 실제 DOM에 남는 빈 껍데기(<b></b> 등) 청소
  editorEl.querySelectorAll('b,i,u,s,strike,span').forEach(el => {
    if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
  });
}

function doIndent(block, dir) {
  if (!block) return null;
  const cur = parseInt(block.style.marginLeft || '0', 10);
  const next = Math.max(0, cur + dir * 40);
  block.style.marginLeft = next ? next + 'px' : '';
  return block;
}

function toggleBlockquote(editorEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 'no-selection';
  const node = sel.anchorNode;
  if (!node) return 'no-selection';
  const block = node.nodeType === 3 ? node.parentElement : node;
  if (!block || !block.closest) return 'no-selection';
  const bq = block.closest('blockquote');
  if (bq && editorEl.contains(bq)) {
    const parent = bq.parentNode;
    while (bq.firstChild) parent.insertBefore(bq.firstChild, bq);
    parent.removeChild(bq);
    return 'unwrapped';
  }
  return 'not-in-blockquote';
}

function getCurrentBlock(editorEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node) return null;
  const block = node.nodeType === 3 ? node.parentElement : node;
  if (!block || !block.closest) return null;
  return block.closest('p,div,li,h1,h2,h3,blockquote') || editorEl;
}

// 실제 에디터(openLinkDialog)와 동일: 수동 DOM 생성 (execCommand createLink 미사용)
function applyLink(editorEl, url) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  let href = url.trim();
  if (href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    href = 'https://' + href;
  }
  const range = sel.getRangeAt(0);
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = range.toString() || url;
  if (range.collapsed) {
    range.insertNode(a);
  } else {
    range.deleteContents();
    range.insertNode(a);
  }
  range.setStartAfter(a);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

// Node.js/jest용 export
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    wrapSelectionStyle,
    unwrapElement,
    clearInlineFormatting,
    doIndent,
    toggleBlockquote,
    getCurrentBlock,
    applyLink,
    INLINE_TAGS,
  };
}
