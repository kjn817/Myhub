const editors = new Set();
document.addEventListener('selectionchange', () => {
  for (const ed of editors) {
    if (!ed.el.isConnected) { if (ed.destroy) ed.destroy(); continue; }
    if (ed.onSelectionChange) ed.onSelectionChange();
    if (ed.onTableSelectionChange) ed.onTableSelectionChange();
  }
});
function wireEditor(el, toolbar, pinToolbar, opts) {
  opts = opts || {};
  const editor = { el, toolbar, memoId: opts.memoId || null, blobMap: new Map(), otherFiles: [], savedRange: null, imgInput: null, pinToolbar: !!pinToolbar };
  buildToolbarButtons(toolbar, editor);
  if (pinToolbar) toolbar.classList.remove('hidden');

  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.accept = 'image/*';
  imgInput.multiple = true;
  imgInput.style.display = 'none';
  imgInput.addEventListener('change', () => { handleEditorFiles(editor, imgInput.files); imgInput.value = ''; });
  document.body.appendChild(imgInput);
  editor.imgInput = imgInput;

  el.addEventListener('focus', () => toolbar.classList.remove('hidden'));
  el.addEventListener('blur', () => {
    if (editor.pinToolbar) return;
    setTimeout(() => { if (!editor.pinToolbar) toolbar.classList.add('hidden'); }, 120);
  });
  editor.onSelectionChange = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && el.contains(sel.anchorNode)) {
      editor.savedRange = sel.getRangeAt(0).cloneRange();
      updateToolbarActive(el, toolbar);
    }
  };
  el.addEventListener('keyup', () => updateToolbarActive(el, toolbar));
  el.addEventListener('click', () => updateToolbarActive(el, toolbar));
  el.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      handleEditorFiles(editor, files);
      return;
    }
    // URL을 선택 영역에 붙여넣기 → 링크로 변환
    const text = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
    const sel = window.getSelection();
    if (text && /^https?:\/\/[^\s]+$/.test(text) && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
      e.preventDefault();
      restoreSel(editor);
      const url = text;
      const range = sel.getRangeAt(0);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = range.toString();
      range.deleteContents();
      range.insertNode(a);
      sel.removeAllRanges();
      const nr = document.createRange();
      nr.setStartAfter(a);
      nr.collapse(true);
      sel.addRange(nr);
    }
  });
  // 마크다운 자동 변환 (input rules)
  el.addEventListener('input', (e) => {
    if (e.inputType !== 'insertText' || e.data !== ' ') {
      // **bold**, *italic*, ~~strike~~ 는 스페이스 없이도 변환 (마지막 문자 입력 시)
      if (e.inputType === 'insertText' && e.data) {
        mdInlineConvert(el);
      }
      return;
    }
    mdBlockConvert(el);
    mdInlineConvert(el);
  });
  // Ctrl+Spacebar: 서식 지우기 (Word 단축키)
  el.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault();
      restoreSel(editor);
      execCmd('removeFormat');
      return;
    }
    // 인용 블록에서 빈 상태로 Enter → 인용 탈출
    if (e.key === 'Enter' && !e.shiftKey) {
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const node = sel.anchorNode;
        const block = node.nodeType === 3 ? node.parentElement : node;
        const bq = block.closest ? block.closest('blockquote') : null;
        if (bq && el.contains(bq) && !bq.textContent.trim()) {
          e.preventDefault();
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          bq.replaceWith(p);
          const nr = document.createRange();
          nr.selectNodeContents(p);
          nr.collapse(true);
          sel.removeAllRanges();
          sel.addRange(nr);
          return;
        }
      }
    }
  });
  // 스마트 목록: Enter 계속/종료, Tab 들여쓰기
  el.addEventListener('keydown', (e) => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
    const node = sel.anchorNode;
    const li = node.nodeType === 1 ? node.closest('li') : node.parentElement?.closest('li');
    if (!li || !el.contains(li)) return;
    // Tab: 들여쓰기/내어쓰기
    if (e.key === 'Tab') {
      e.preventDefault();
      restoreSel(editor);
      execCmd(e.shiftKey ? 'outdent' : 'indent');
      return;
    }
    // Enter: 빈 항목이면 목록 종료, 아니면 계속
    if (e.key === 'Enter' && !e.shiftKey) {
      const text = li.textContent.trim();
      // 체크박스 항목의 텍스트만 확인 (체크박스 제외)
      const span = li.querySelector('span');
      const content = span ? span.textContent.trim() : text;
      if (!content) {
        e.preventDefault();
        const ul = li.parentElement;
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        if (li.nextSibling) {
          // 중간에 빈 항목이면 분리
          ul.after(p);
        } else {
          ul.after(p);
        }
        li.remove();
        // 빈 ul 정리
        if (!ul.querySelector('li')) ul.remove();
        const r = document.createRange();
        r.setStart(p, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      }
      // 내용이 있으면 기본 동작 (새 li 생성) - 브라우저가 처리
    }
  });
  // 드롭 위치 표시 캐럿
  let dropCaret = null;
  function caretRangeAt(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    return range;
  }
  function removeDropCaret() {
    if (dropCaret) { dropCaret.remove(); dropCaret = null; }
  }
  function updateDropCaret(x, y) {
    removeDropCaret();
    const range = caretRangeAt(x, y);
    if (!range || !el.contains(range.startContainer)) return;
    if (dragImg && (dragImg.contains(range.startContainer) || range.startContainer === dragImg)) return;
    dropCaret = document.createElement('span');
    dropCaret.className = 'drop-caret';
    try {
      range.collapse(true);
      range.insertNode(dropCaret);
    } catch { removeDropCaret(); }
  }
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('dropping');
    updateDropCaret(e.clientX, e.clientY);
  });
  el.addEventListener('dragleave', () => { el.classList.remove('dropping'); removeDropCaret(); });
  // 에디터 안의 이미지 드래그 → 원하는 위치로 이동 (작은 배지로 표시)
  let dragImg = null;
  el.addEventListener('dragstart', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img && el.contains(img)) {
      dragImg = img;
      e.dataTransfer.effectAllowed = 'move';
      try {
        // 드래그 고스트 없이 마우스 포인터만 (위치는 주황 캐럿으로 표시)
        const ghost = document.createElement('div');
        ghost.style.cssText = 'position:fixed;top:-100px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      } catch (e) { console.warn('드래그 이미지 설정 실패:', e); }
    }
  });
  el.addEventListener('dragend', () => { dragImg = null; hideImgResize(); removeDropCaret(); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('dropping');
    // 1) 에디터 내부 이미지 이동 → 캐럿 위치에 직접 이동 (엔터/빈줄 보존)
    if (dragImg && el.contains(dragImg)) {
      e.preventDefault();
      const moving = dragImg;
      dragImg = null;
      if (dropCaret && el.contains(dropCaret)) {
        const caretParent = dropCaret.parentNode;
        caretParent.insertBefore(moving, dropCaret);
        removeDropCaret();
        hideImgResize();
        hideImgTools();
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        removeDropCaret();
      }
      return;
    }
    e.preventDefault();
    removeDropCaret();
    if (!(e.dataTransfer.files && e.dataTransfer.files.length)) return;
    // 드롭한 자리에 캐럿을 옮긴 뒤 삽입 (TipTap/ProseMirror와 같은 방식)
    const range = caretRangeAt(e.clientX, e.clientY);
    if (range && el.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      editor.savedRange = range.cloneRange();
    }
    handleEditorFiles(editor, e.dataTransfer.files);
  });
  // 에디터 이미지 클릭 → 리사이즈 핸들
  el.addEventListener('click', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img && el.contains(img)) showImgResize(editor, img);
    else hideImgResize();
  });
  el.addEventListener('input', hideImgResize);
  // 에디터 이미지 호버 → 복사 도구
  el.addEventListener('mouseover', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img && el.contains(img)) showImgTools(img);
  });
  wireTableTools(el);
  return editor;
}
/* 표 도구: 열 너비 드래그 + 행/열/표 편집 */
function wireTableTools(el) {
  let tblBar = null;
  let resizeState = null;
  function selCell() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    const c = n && n.closest ? n.closest('td, th') : null;
    return (c && el.contains(c)) ? c : null;
  }
  function hideBar() { if (tblBar) { tblBar.remove(); tblBar = null; } }
  function positionBar(table) {
    if (!tblBar || !table.isConnected) { hideBar(); return; }
    const r = table.getBoundingClientRect();
    tblBar.style.top = Math.max(4, window.scrollY + r.top - tblBar.offsetHeight - 8) + 'px';
    tblBar.style.left = Math.min(window.innerWidth - 220, Math.max(8, window.scrollX + r.left)) + 'px';
  }
  function ensureColgroup(table) {
    let cg = table.querySelector('colgroup');
    const ncols = table.rows[0] ? table.rows[0].cells.length : 0;
    if (!cg) { cg = document.createElement('colgroup'); table.prepend(cg); }
    while (cg.children.length < ncols) cg.appendChild(document.createElement('col'));
    while (cg.children.length > ncols) cg.lastChild.remove();
    return cg;
  }
  function changed() { el.dispatchEvent(new Event('input', { bubbles: true })); }
  function showBar(table) {
    hideBar();
    tblBar = document.createElement('div');
    tblBar.className = 'tbl-bar';
    const items = [
      ['+ 행', () => {
        const cell = selCell(); if (!cell) return;
        const refRow = cell.parentNode;
        const tr = document.createElement('tr');
        for (let i = 0; i < refRow.cells.length; i++) { const td = document.createElement('td'); td.innerHTML = '<br>'; tr.appendChild(td); }
        refRow.parentNode.insertBefore(tr, refRow.nextSibling);
        ensureColgroup(table); changed();
      }],
      ['− 행', () => {
        const cell = selCell(); if (!cell) return;
        if (table.rows.length <= 1) table.remove(); else cell.parentNode.remove();
        changed(); if (!table.isConnected) hideBar();
      }],
      ['+ 열', () => {
        const cell = selCell();
        const idx = cell ? cell.cellIndex + 1 : table.rows[0].cells.length;
        [...table.rows].forEach(tr => {
          const td = document.createElement('td'); td.innerHTML = '<br>';
          tr.insertBefore(td, tr.cells[idx] || null);
        });
        ensureColgroup(table); changed();
      }],
      ['− 열', () => {
        const cell = selCell(); if (!cell) return;
        if (table.rows[0].cells.length <= 1) table.remove();
        else { const i = cell.cellIndex; [...table.rows].forEach(tr => { if (tr.cells[i]) tr.cells[i].remove(); }); }
        ensureColgroup(table); changed(); if (!table.isConnected) hideBar();
      }],
      ['표 삭제', () => { table.remove(); hideBar(); changed(); }, true],
    ];
    items.forEach(([label, fn, danger]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      if (danger) b.className = 'danger';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { fn(); if (tblBar) positionBar(table); });
      tblBar.appendChild(b);
    });
    document.body.appendChild(tblBar);
    positionBar(table);
  }
  document.addEventListener('selectionchange', () => {
    if (resizeState || !document.contains(el)) return;
    const cell = selCell();
    const table = cell ? cell.closest('table') : null;
    if (table) { if (!tblBar) showBar(table); else positionBar(table); }
    else hideBar();
  });
  window.addEventListener('scroll', hideBar, { passive: true, capture: true });
  // 열 너비 드래그: 셀 오른쪽 경계 호버 → col-resize
  el.addEventListener('mousemove', (e) => {
    if (resizeState) return;
    const t = e.target;
    const cell = t && t.closest ? t.closest('td, th') : null;
    document.querySelectorAll('.rich [data-redge]').forEach(c => { delete c.dataset.redge; c.style.cursor = ''; });
    if (cell && el.contains(cell)) {
      const r = cell.getBoundingClientRect();
      if (r.right - e.clientX < 9 && e.clientX <= r.right + 2) {
        cell.dataset.redge = '1'; cell.style.cursor = 'col-resize';
      }
    }
  });
  el.addEventListener('mousedown', (e) => {
    const t = e.target;
    const cell = t && t.closest ? t.closest('td, th') : null;
    if (cell && cell.dataset.redge && el.contains(cell)) {
      e.preventDefault(); e.stopPropagation();
      const table = cell.closest('table');
      const cg = ensureColgroup(table);
      table.style.tableLayout = 'fixed';
      table.style.width = '100%';
      [...cg.children].forEach((c, i) => {
        if (!c.style.width) {
          const w = (c.offsetWidth || (table.rows[0].cells[i] || {}).offsetWidth || 80);
          c.style.width = w + 'px';
        }
      });
      resizeState = { col: cg.children[cell.cellIndex], startX: e.clientX, startW: parseFloat(cg.children[cell.cellIndex].style.width) || 80 };
      const move = (me) => {
        if (!resizeState) return;
        resizeState.col.style.width = Math.max(40, resizeState.startW + me.clientX - resizeState.startX) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        resizeState = null; changed();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up, { once: true });
    }
  });
}
/* 이미지 리사이즈 핸들 (에디터 전용) */
let imgResize = null;
function hideImgResize() {
  if (imgResize && imgResize.resizing) return;
  if (imgResize) {
    imgResize.handle.remove();
    imgResize.badge.remove();
    imgResize = null;
  }
  window.removeEventListener('scroll', hideImgResize);
}
function showImgResize(editor, img) {
  hideImgResize();
  const handle = document.createElement('div');
  handle.className = 'img-handle';
  handle.setAttribute('aria-label', '이미지 크기 조절');
  const badge = document.createElement('div');
  badge.className = 'img-wbadge';
  document.body.append(handle, badge);
  const place = () => {
    const r = img.getBoundingClientRect();
    handle.style.left = (r.right - 6 + window.scrollX) + 'px';
    handle.style.top = (r.bottom - 6 + window.scrollY) + 'px';
    badge.textContent = Math.round(r.width) + 'px';
    badge.style.left = (r.right + 8 + window.scrollX) + 'px';
    badge.style.top = (r.bottom - 10 + window.scrollY) + 'px';
  };
  place();
  imgResize = { handle, badge };
  window.addEventListener('scroll', hideImgResize, { passive: true });
  // 더블클릭 → 원본 크기로
  img.addEventListener('dblclick', () => {
    img.style.width = ''; img.style.maxWidth = ''; img.style.height = '';
    place();
  });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideImgTools();
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const maxW = editor.el.clientWidth || 600;
    if (!img.style.width) {
      img.style.width = Math.round(startW) + 'px';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    }
    let dragged = false;
    imgResize.resizing = true;
    const move = (ev) => {
      dragged = true;
      const w = Math.max(48, Math.min(maxW, startW + (ev.clientX - startX)));
      img.style.width = Math.round(w) + 'px';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      place();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      imgResize.resizing = false;
      if (dragged) {
        // 드래그 직후 click이 핸들을 숨기지 않도록 1회 억제
        const suppress = (ce) => { ce.stopPropagation(); window.removeEventListener('click', suppress, true); };
        window.addEventListener('click', suppress, true);
        setTimeout(() => window.removeEventListener('click', suppress, true), 300);
      }
      editor.el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

function restoreSel(editor) {
  editor.el.focus();
  if (editor.savedRange) {
    // UI-003/MEMO-001 하드닝: 저장된 Range를 그대로 재사용하지 않는다.
    // - 분리(detached)됐거나 에디터 밖을 가리키는 stale Range는 복원하지 않는다
    //   (stale Range의 addRange가 렌더러 정지 가설 A였고, 전 버튼이 공유하는 경로다).
    // - addRange에는 반드시 clone을 넘긴다 (저장본 자체를 Selection에 넘기면
    //   Range가 Selection 쪽으로 이동·변경돼 다음 복원에서 재사용할 수 없다).
    const saved = editor.savedRange;
    const startNode = saved.startContainer;
    if (!startNode || !startNode.isConnected || !editor.el.contains(startNode)) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    try { sel.addRange(saved.cloneRange()); } catch (e) { console.warn('선택 영역 복원 실패:', e); }
  }
}
// 에디터에 파일 넣기: 이미지는 본문 커서 위치에, 나머지는 첨부 칩으로
function handleEditorFiles(editor, fileList) {
  const MAX_SIZE = 10 * 1024 * 1024;
  const files = [...fileList].filter(f => f.size > 0);
  if (!files.length) return;
  // 10MB 초과 파일은 선택 시점에 차단
  const valid = [];
  for (const f of files) {
    if (f.size > MAX_SIZE) {
      toast(`"${f.name}"은 10MB를 초과해서 첨부할 수 없어요`, 5000);
    } else {
      valid.push(f);
    }
  }
  if (!valid.length) return;
  editor.el.focus();
  restoreSel(editor);
  // 선택 영역이 없으면 맨 뒤에 삽입
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.el.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(editor.el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  for (const f of valid) {
    if (isImage(f.type, f.name)) {
      const url = URL.createObjectURL(f);
      editor.blobMap.set(url, f);
      execCmd('insertHTML', `<img src="${url}" data-pending="1" alt="${esc(f.name)}">`);
      execCmd('insertParagraph'); // 이미지 뒤에 빈 줄
    } else {
      editor.otherFiles.push(f);
      refreshOtherFiles(editor);
    }
  }
}
