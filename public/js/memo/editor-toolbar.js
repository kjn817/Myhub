/* ================= 2. WYSIWYG 에디터 ================= */
function execCmd(cmd, val) {
  document.execCommand(cmd, false, val === undefined ? null : val);
}
// 선택 영역을 <span style="...">로 감싸기 (색상/크기용) - insertHTML로 네이티브 undo에 기록
function wrapSelectionStyle(style) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  if (range.collapsed) {
    // Word식: 커서 위치에 빈 span 삽입
    const span = document.createElement('span');
    span.style.cssText = style;
    span.innerHTML = '\u200B';
    range.insertNode(span);
    const r = document.createRange();
    r.setStart(span.firstChild, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }

  // 선택 영역을 span으로 감싸기 (insertHTML 대신 직접 DOM 조작)
  const span = document.createElement('span');
  span.style.cssText = style;
  try {
    range.surroundContents(span);
  } catch {
    // surroundContents가 실패하면 (부분 선택 등) insertHTML 폴백
    const div = document.createElement('div');
    div.appendChild(range.cloneContents());
    execCmd('insertHTML', `<span style="${esc(style)}">${div.innerHTML}</span>`);
  }
}

const PALETTE = ['#DC2626','#EA580C','#F59E0B','#CA8A04','#84CC16','#16A34A','#10B981','#14B8A6','#06B6D4','#0EA5E9','#2563EB','#4F46E5','#7C3AED','#A855F7','#DB2777','#EC4899','#F43F5E','#1F2937','#4B5563','#9CA3AF'];
const HIGHLIGHTS = ['#FEF08A','#FDE68A','#FECACA','#FED7AA','#FDE68A','#D9F99D','#BBF7D0','#A7F3D0','#99F6E4','#BAE6FD','#BFDBFE','#C7D2FE','#DDD6FE','#E9D5FF','#FBCFE8','#F9A8D4','#FECDD3','#E5E7EB','#D1D5DB','#F3F4F6'];
const SIZES = [['9pt','9pt'],['10pt','10pt'],['12pt','12pt'],['14pt','14pt'],['18pt','18pt'],['24pt','24pt']];

function closePops(bar) {
  bar.querySelectorAll('.pop').forEach(p => {
    if (p._escHandler) document.removeEventListener('keydown', p._escHandler);
    p.remove();
  });
}
// 바깥 클릭 시 모든 팝업 닫기
document.addEventListener('mousedown', (e) => {
  document.querySelectorAll('.toolbar').forEach(bar => {
    if (!bar.contains(e.target)) closePops(bar);
  });
});

function openTablePicker(bar, editor) {
  // 이미 열려있으면 닫기 (토글)
  if (bar.querySelector('.pop .tp-grid')) {
    closePops(bar);
    return;
  }
  closePops(bar);
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  const label = document.createElement('div');
  label.className = 'tp-label';
  label.textContent = '\u00a0';
  const grid = document.createElement('div');
  grid.className = 'tp-grid';
  const cells = [];
  for (let r = 1; r <= 8; r++) {
    for (let c = 1; c <= 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'tp-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `${r}행 ${c}열`);
      cell.setAttribute('tabindex', '0');
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  function highlight(rr, cc) {
    cells.forEach(x => {
      const on = +x.dataset.r <= rr && +x.dataset.c <= cc;
      x.classList.toggle('on', on);
    });
    label.textContent = `${rr} × ${cc}`;
  }
  grid.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.tp-cell');
    if (!t || !grid.contains(t)) return;
    highlight(+t.dataset.r, +t.dataset.c);
  });
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.tp-cell');
    if (!t || !grid.contains(t)) return;
    insertTableRc(editor, +t.dataset.r, +t.dataset.c);
    closePops(bar);
    editor.el.focus();
  });
  grid.addEventListener('mouseleave', () => {
    cells.forEach(x => x.classList.remove('on'));
    label.textContent = '\u00a0';
  });
  pop.append(label, grid);
  bar.appendChild(pop);
  // 우측 오버플로우 시 우측 정렬로 전환
  requestAnimationFrame(() => {
    const r = pop.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) {
      pop.style.left = 'auto';
      pop.style.right = '8px';
    }
  });
  refreshIcons();
  pop._escHandler = (e) => {
    if (e.key === 'Escape') { closePops(bar); document.removeEventListener('keydown', pop._escHandler); }
  };
  document.addEventListener('keydown', pop._escHandler);
}
function openLinkDialog(bar, editor) {
  closePops(bar);
  const sel = window.getSelection();
  const has = sel.rangeCount && !sel.getRangeAt(0).collapsed;
  const selectedText = has ? sel.getRangeAt(0).toString() : '';
  // 커서가 기존 링크 안에 있는지 확인
  let existingLink = null;
  if (sel.rangeCount) {
    const node = sel.anchorNode;
    const el = node.nodeType === 3 ? node.parentElement : node;
    existingLink = el.closest ? el.closest('a') : null;
  }
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.innerHTML = `
    <div style="padding:12px;min-width:260px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${existingLink ? '링크 수정' : '링크 삽입'}</div>
      <input type="url" placeholder="https://" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:4px;font-size:14px;margin-bottom:8px" />
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-cancel" style="padding:6px 12px;border:1px solid var(--border);background:#fff;border-radius:4px;cursor:pointer">취소</button>
        <button type="button" class="btn-ok" style="padding:6px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer">${existingLink ? '수정' : '삽입'}</button>
      </div>
    </div>`;
  const input = pop.querySelector('input');
  input.value = existingLink ? existingLink.href : 'https://';
  const doInsert = () => {
    const url = input.value.trim();
    if (!url || url === 'https://') { closePops(bar); return; }
    restoreSel(editor);
    // 기존 링크면 href 업데이트
    if (existingLink && editor.el.contains(existingLink)) {
      existingLink.href = url;
      closePops(bar);
      editor.el.focus();
      return;
    }
    // 수동으로 링크 생성 (execCommand보다 안전)
    const s = window.getSelection();
    if (!s.rangeCount) { closePops(bar); return; }
    // 프로토콜이 없으면 https:// 추가
    let href = url.trim();
    if (href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
      href = 'https://' + href;
    }
    const range = s.getRangeAt(0);
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
    s.removeAllRanges();
    s.addRange(range);
    closePops(bar);
    editor.el.focus();
  };
  pop.querySelector('.btn-ok').onclick = doInsert;
  pop.querySelector('.btn-cancel').onclick = () => closePops(bar);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doInsert();
    if (e.key === 'Escape') closePops(bar);
  });
  bar.appendChild(pop);
  // 위치 조정
  requestAnimationFrame(() => {
    const r = pop.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) {
      pop.style.left = 'auto';
      pop.style.right = '8px';
    }
  });
  refreshIcons();
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
function insertTableRc(editor, rows, cols) {
  restoreSel(editor);
  let html = '<table><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td><br></td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  execCmd('insertHTML', html);
}

// 마크다운 블록 자동 변환 (#, -, 1., [], >)
function mdBlockConvert(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
  const node = sel.anchorNode;
  const block = node.nodeType === 3 ? node.parentElement : node;
  const p = block.closest ? (block.closest('p,div,h1,h2,h3,blockquote,li') || block) : block;
  if (!p || !el.contains(p) || p.tagName === 'LI') return;
  const text = p.textContent.replace(/\u00a0/g, ' ');
  let m;
  // 헤딩: # , ## , ###
  if ((m = text.match(/^(#{1,3})\s+$/))) {
    const level = m[1].length;
    const h = document.createElement('h' + level);
    h.innerHTML = '<br>';
    p.replaceWith(h);
    const r = document.createRange();
    r.setStart(h, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return;
  }
  // 글머리: - , *
  if (/^[-*]\s+$/.test(text)) {
    const ul = document.createElement('ul');
    ul.innerHTML = '<li><br></li>';
    p.replaceWith(ul);
    const li = ul.querySelector('li');
    const r = document.createRange();
    r.setStart(li, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return;
  }
  // 번호: 1.
  if (/^\d+\.\s+$/.test(text)) {
    const ol = document.createElement('ol');
    ol.innerHTML = '<li><br></li>';
    p.replaceWith(ol);
    const li = ol.querySelector('li');
    const r = document.createRange();
    r.setStart(li, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return;
  }
  // 체크박스: [] , [x]
  if (/^\[\s?\]\s+$/.test(text) || /^\[x\]\s+$/i.test(text)) {
    const checked = /^\[x\]\s+$/i.test(text);
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    ul.innerHTML = `<li class="task-item"><input type="checkbox" ${checked ? 'checked' : ''} tabindex="-1"><span><br></span></li>`;
    p.replaceWith(ul);
    const span = ul.querySelector('span');
    const r = document.createRange();
    r.setStart(span, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    // 체크박스 클릭 처리
    ul.querySelector('input').addEventListener('click', (ev) => ev.stopPropagation());
    return;
  }
  // 인용: >
  if (/^>\s+$/.test(text)) {
    const bq = document.createElement('blockquote');
    bq.innerHTML = '<br>';
    p.replaceWith(bq);
    const r = document.createRange();
    r.setStart(bq, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return;
  }
}

// 마크다운 인라인 자동 변환 (**bold**, *italic*, ~~strike~~)
function mdInlineConvert(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return;
  const text = node.textContent;
  const offset = range.startOffset;
  // 커서 앞 텍스트에서 패턴 찾기
  const before = text.slice(0, offset);
  let m, tag, pattern;
  // **bold**
  if ((m = before.match(/\*\*([^*]+)\*\*$/))) {
    tag = 'strong'; pattern = m[0];
  }
  // ~~strike~~
  else if ((m = before.match(/~~([^~]+)~~$/))) {
    tag = 's'; pattern = m[0];
  }
  // *italic* (bold가 아닐 때)
  else if ((m = before.match(/(?<!\*)\*([^*]+)\*$/))) {
    tag = 'em'; pattern = m[0];
  }
  else return;
  const content = m[1];
  // 텍스트 노드 분리 및 변환
  const startIdx = offset - pattern.length;
  const afterText = text.slice(offset);
  node.textContent = text.slice(0, startIdx);
  const elem = document.createElement(tag);
  elem.textContent = content;
  const afterNode = document.createTextNode(afterText);
  node.after(elem, afterNode);
  // 커서를 변환된 요소 뒤로
  const r = document.createRange();
  r.setStart(afterNode, 0); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}

// 툴바 활성 상태 업데이트 (커서 위치의 서식 반영)
function updateToolbarActive(el, toolbar) {
  if (!toolbar || !el.contains(document.activeElement) && !toolbar.contains(document.activeElement)) {
    // 에디터에 포커스가 없어도 선택 영역이 에디터 안에 있으면 업데이트
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return;
  }
  const cmds = {
    'bold': 'bold',
    'italic': 'italic',
    'underline': 'underline',
    'strikethrough': 'strikeThrough',
  };
  toolbar.querySelectorAll('button').forEach(btn => {
    const title = btn.getAttribute('title');
    let cmd = null;
    if (title === '굵게') cmd = 'bold';
    else if (title === '기울임') cmd = 'italic';
    else if (title === '밑줄') cmd = 'underline';
    else if (title === '취소선') cmd = 'strikeThrough';
    else if (title === '글머리 기호') cmd = 'insertUnorderedList';
    else if (title === '번호 매기기') cmd = 'insertOrderedList';
    if (cmd) {
      try {
        btn.classList.toggle('active', document.queryCommandState(cmd));
      } catch (e) { console.warn('queryCommandState 실패:', e); }
    }
  });
}

// 에디터 배선: 툴바 show/hide, 붙여넣기/드래그, 선택 추적
function refreshOtherFiles(editor) {
  const box = editor.chipsBox;
  if (!box) return;
  box.innerHTML = '';
  editor.otherFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'p-chip';
    chip.innerHTML = `<i data-lucide="${fileIcon(f.name)}"></i><span class="name">${esc(f.name)} (${fmtSize(f.size)})</span>`;
    const x = document.createElement('button');
    x.innerHTML = '<i data-lucide="x"></i>';
    x.setAttribute('aria-label', '제거');
    x.addEventListener('mousedown', (e) => e.preventDefault());
    x.addEventListener('click', () => { editor.otherFiles.splice(i, 1); refreshOtherFiles(editor); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
