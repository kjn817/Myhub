/* ================= 1. 유틸 ================= */
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtSize(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b/1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + 'MB';
  return (b/1073741824).toFixed(2) + 'GB';
}

function fmtDate(s) {
  const d = new Date(s + (s.endsWith('Z') ? '' : 'Z'));
  const now = new Date();
  const diff = now - d;
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff < 60e3) return '방금 전';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + '분 전';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return '오늘 ' + hm;
  if (days === 1) return '어제 ' + hm;
  if (days < 7) return days + '일 전';
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
function highlight(text, q) {
  let out = esc(text);
  if (!q.trim()) return out;
  q.trim().split(/\s+/).forEach(tok => {
    if (!tok) return;
    const re = new RegExp('(' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}
const IMG_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg','avif','tif','tiff','ico','heic','heif','jfif','pjp','pjpeg'];
function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['xls','xlsx','csv'].includes(ext)) return 'file-spreadsheet';
  if (['doc','docx','hwp','txt','md','rtf'].includes(ext)) return 'file-text';
  if (ext === 'pdf') return 'file';
  if (['zip','rar','7z','tar','gz','bz2'].includes(ext)) return 'file-archive';
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'file-audio';
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'file-video';
  if (['ppt','pptx','key'].includes(ext)) return 'presentation';
  return 'paperclip';
}
function isImage(mime, name) {
  if ((mime || '').toLowerCase().startsWith('image/')) return true;
  const ext = String(name || '').split('.').pop().toLowerCase().split('?')[0];
  return IMG_EXTS.includes(ext);
}
function extractTags(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/#([가-힣a-zA-Z0-9_]+)/g)) set.add(m[1]);
  return [...set];
}
// 인라인 이미지 마커: ![이름](file:123), 너비 포함 시 ![이름|300](file:123)
function markerIds(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/!\[.*?\]\(file:(\d+)\)/g)) set.add(Number(m[1]));
  return set;
}
function parseMarkerAlt(alt) {
  const m = /^(.*)\|(\d+)$/.exec(alt);
  return m ? { alt: m[1], width: +m[2] } : { alt, width: 0 };
}

// 메모 텍스트에서 제목과 본문 분리
function extractTitle(text) {
  if (!text) return { title: '', body: '' };
  const lines = String(text).split('\n');
  const firstLine = (lines[0] || '').trim();
  // 첫 줄이 짧으면 제목으로
  if (firstLine && firstLine.length <= 60 && lines.length > 1) {
    return { title: firstLine, body: lines.slice(1).join('\n').trim() };
  }
  return { title: '', body: text };
}

const $ = (id) => document.getElementById(id);
let cachedMemos = [];
let lastFilterSig = '';
let searchTimer = null;
const memoTexts = {};
const memoFileMap = {}; // memoId -> { fileId: file }
const memoCache = {}; // memoId -> memo row
let activeTag = '', activeDate = '';
let selectedIds = []; // PC 다중선택

/* 반응형: PC(1024px+) 3열, 모바일 1열 */
const mqDesktop = window.matchMedia('(min-width: 1024px)');
const isDesktop = () => mqDesktop.matches;
mqDesktop.addEventListener('change', () => {
  closeAllPanes();
  selectedIds = [];
  updateLayoutMode();
  load();
});
function updatePanesVisibility() {
  const hasSel = isDesktop() && selectedIds.length > 0;
  const composer = $('composerCard');
  const colMid = $('colMid');
  const colRight = $('colRight');
  if (!composer || !colMid || !colRight) return;
  if (hasSel) {
    // 메모를 열면: 열린 메모는 2열, 새메모는 3열(달력 위)로 이동
    if (composer.parentNode !== colRight) colRight.prepend(composer);
  } else {
    // 아무것도 안 열면: 새메모는 2열 (달력은 항상 3열)
    if (composer.parentNode !== colMid) colMid.prepend(composer);
  }
}
function updateLayoutMode() {
  const desktop = isDesktop();
  updatePanesVisibility();
  if (desktop) {
    if (!tagbarOpen) setTagbar(true);
    if ($('calCard').hidden) { $('calCard').hidden = false; renderCal(); }
  } else {
    if (tagbarOpen) setTagbar(false);
    $('calCard').hidden = true;
    $('tglCal').classList.remove('on');
  }
}
/* PC 목록 페이지네이션 */
const PAGE_SIZE = 10;
let page = 0;
function renderPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages - 1) page = totalPages - 1;
  const pager = $('pager');
  if (!isDesktop() || totalPages <= 1) { pager.style.display = 'none'; return; }
  pager.style.display = 'flex';
  $('pgInfo').textContent = (page + 1) + ' / ' + totalPages;
  $('pgPrev').disabled = page === 0;
  $('pgNext').disabled = page >= totalPages - 1;
}

function refreshIcons() { if (window.lucide) { try { lucide.createIcons(); } catch (e) { console.warn('아이콘 새로고침 실패:', e); } } }
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

/* ================= 3. HTML ↔ 마크다운 ================= */
// 텍스트 노드 이스케이프
function escMd(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/([*_~`|[\]()])/g, '\\$1');
}
function escapeBlockStart(s) {
  return s.replace(/^(#{1,6}(?=\s)|>\s?|[*+-](?=\s)|\d+\.(?=\s))/, '\\$1');
}
function inlineNodeToMd(n, ctx) {
  if (n.nodeType === 3) return escMd(n.textContent);
  if (n.nodeType !== 1) return '';
  // 잠긴 블록 플레이스홀더는 [LOCKED_BLOCK:<id>] 마커로 직렬화한다 (UI-003).
  // 마커만 본문에 남고 비밀 평문은 locked_blocks의 암호문에만 존재한다.
  // 플레이스홀더의 표시 텍스트("잠긴 블록 (N자…)")가 본문에 새면 안 되므로
  // 자손을 순회하기 전에 여기서 차단한다.
  if (n.classList && n.classList.contains('locked-block')) {
    const bid = n.getAttribute('data-block-id');
    if (bid) return `[LOCKED_BLOCK:${bid}]`;
  }
  const tag = n.tagName;
  const inner = inlineToMd(n, ctx);
  switch (tag) {
    case 'B': case 'STRONG': return inner ? `**${inner}**` : '';
    case 'I': case 'EM': return inner ? `*${inner}*` : '';
    case 'U': return inner ? `<u>${inner}</u>` : '';
    case 'S': case 'STRIKE': case 'DEL': return inner ? `~~${inner}~~` : '';
    case 'CODE': return inner ? `\`${inner.replace(/`/g, '')}\`` : '';
    case 'BR': return '\n';
    case 'A': {
      const href = n.getAttribute('href') || '';
      return inner ? `[${inner}](${href})` : '';
    }
    case 'IMG': {
      const fid = n.getAttribute('data-fid');
      const rawAlt = n.getAttribute('alt') || '이미지';
      const w = n.style && n.style.width ? parseInt(n.style.width, 10) : 0;
      const alt = escMd(rawAlt).replace(/\]/g, '\\]') + (w > 0 ? '|' + w : '');
      if (fid) return `![${alt}](file:${fid})`;
      const pidx = n.getAttribute('data-pidx');
      if (pidx !== null && pidx !== undefined) return `![${alt}](pending:${pidx})`;
      return '';
    }
    case 'INPUT':
      if (n.type === 'checkbox') return ''; // 리스트에서 별도 처리
      return '';
    case 'SPAN': {
      const style = n.getAttribute('style') || '';
      const color = /color\s*:\s*([^;]+)/i.exec(style);
      const fs = /font-size\s*:\s*([^;]+)/i.exec(style);
      let open = '', close = '';
      if (color) { open += `<span style="color:${color[1].trim()}">`; close = '</span>' + close; }
      if (fs) { open += `<span style="font-size:${fs[1].trim()}">`; close = '</span>' + close; }
      return open ? `${open}${inner}${close}` : inner;
    }
    default: return inner;
  }
}
function inlineToMd(n, ctx) {
  let out = '';
  n.childNodes.forEach(ch => { out += inlineNodeToMd(ch, ctx); });
  return out;
}
function listToMd(list, ordered, depth) {
  let out = '';
  let i = 0;
  list.childNodes.forEach(li => {
    if (li.nodeType !== 1 || li.tagName !== 'LI') return;
    i++;
    const pad = '  '.repeat(depth);
    const marker = ordered ? `${i}.` : '-';
    const cb = li.querySelector(':scope > input[type="checkbox"]');
    const task = cb ? (cb.checked ? '[x] ' : '[ ] ') : '';
    let head = '', tail = '';
    li.childNodes.forEach(c => {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
        tail += listToMd(c, c.tagName === 'OL', depth + 1);
      } else if (c.nodeType === 1 && c.tagName === 'INPUT') {
        // 체크박스는 task로 처리됨
      } else if (c.nodeType === 3) {
        head += escMd(c.textContent);
      } else {
        head += blockOrInline(c);
      }
    });
    out += `${pad}${marker} ${task}${head.trim()}\n` + tail;
  });
  return out;
}
function blockOrInline(n) {
  if (/^(UL|OL|TABLE|BLOCKQUOTE|PRE|H[1-6]|DIV|P|HR)$/.test(n.tagName)) return blockNodeToMd(n);
  return inlineNodeToMd(n);
}
function tableToMd(t) {
  const rows = [...t.rows];
  if (!rows.length) return '';
  const cell = (c) => inlineToMd(c).trim().replace(/\n+/g, ' ');
  let out = '';
  rows.forEach((tr, ri) => {
    const cells = [...tr.cells];
    out += '| ' + cells.map(cell).join(' | ') + ' |\n';
    if (ri === 0) out += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
  });
  const cg = t.querySelector('colgroup');
  if (cg && cg.children.length) {
    const ws = [...cg.children].map(c => Math.round(parseFloat(c.style.width) || 0));
    if (ws.some(w => w > 0)) out += '<!-- tblwidths: ' + ws.join(',') + ' -->\n';
  }
  return out + '\n';
}
function blockNodeToMd(n) {
  if (n.nodeType === 3) {
    const t = escMd(n.textContent);
    // 텍스트 줄은 단일 개행: 표시(marked breaks)와 에디터 줄바꿈이 일치하도록
    return t.trim() ? escapeBlockStart(t) + '\n' : '';
  }
  if (n.nodeType !== 1) return '';
  // 블록 레벨로 삽입된 잠긴 블록 플레이스홀더(구 div 형태 포함)도 마커로 직렬화
  if (n.classList && n.classList.contains('locked-block')) {
    const bid = n.getAttribute('data-block-id');
    if (bid) return `[LOCKED_BLOCK:${bid}]\n\n`;
  }
  const tag = n.tagName;
  switch (tag) {
    case 'H1': return '# ' + inlineToMd(n).trim() + '\n\n';
    case 'H2': return '## ' + inlineToMd(n).trim() + '\n\n';
    case 'H3': return '### ' + inlineToMd(n).trim() + '\n\n';
    case 'H4': case 'H5': case 'H6': return '### ' + inlineToMd(n).trim() + '\n\n';
    case 'DIV': case 'P': {
      if ([...n.children].some(c => /^(UL|OL|TABLE|BLOCKQUOTE|PRE|H[1-6]|DIV|P|HR)$/.test(c.tagName))) {
        let o = '';
        n.childNodes.forEach(c => { o += blockNodeToMd(c); });
        return o;
      }
      const t = inlineToMd(n).replace(/\n+$/, '');
      return t.trim() ? escapeBlockStart(t) + '\n' : '\n';
    }
    case 'UL': return listToMd(n, false, 0) + '\n';
    case 'OL': return listToMd(n, true, 0) + '\n';
    case 'LI': return '- ' + inlineToMd(n).trim() + '\n';
    case 'BLOCKQUOTE': {
      let o = '';
      n.childNodes.forEach(c => { o += blockNodeToMd(c); });
      return o.trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
    }
    case 'PRE': return '```\n' + n.textContent.replace(/\n+$/, '') + '\n```\n\n';
    case 'TABLE': return tableToMd(n);
    case 'HR': return '---\n\n';
    case 'BR': return '\n';
    default: {
      const t = inlineNodeToMd(n);
      return t.trim() ? escapeBlockStart(t) + '\n' : '';
    }
  }
}
// 에디터 DOM → { markdown, pendings: File[] }
function serializeEditor(editor) {
  const imgs = [...editor.el.querySelectorAll('img[data-pending]')];
  imgs.forEach((im, i) => { im.setAttribute('data-pidx', String(i)); });
  const pendings = imgs.map(im => editor.blobMap.get(im.getAttribute('src'))).filter(Boolean);
  let out = '';
  editor.el.childNodes.forEach(ch => { out += blockNodeToMd(ch); });
  return { markdown: out.replace(/\n{3,}/g, '\n\n').trim(), pendings };
}
function editorIsEmpty(editor) {
  const { markdown, pendings } = serializeEditor(editor);
  return !markdown && !pendings.length && !editor.otherFiles.length;
}
// 마크다운 → 에디터용 HTML (file:ID 마커를 실제 이미지로)
function applyTableWidths(root) {
  root.querySelectorAll('span[data-tblw]').forEach(sp => {
    const widths = String(sp.dataset.tblw || '').split(',').map(n => parseInt(n, 10) || 0);
    const p = sp.parentNode;
    const table = p ? p.previousElementSibling : null;
    if (table && table.tagName === 'TABLE' && widths.some(w => w > 0)) {
      const oldCg = table.querySelector('colgroup');
      if (oldCg) oldCg.remove();
      const cg = document.createElement('colgroup');
      widths.forEach(w => {
        const col = document.createElement('col');
        if (w > 0) col.style.width = w + 'px';
        cg.appendChild(col);
      });
      table.prepend(cg);
      table.style.tableLayout = 'fixed';
    }
    if (p && p.tagName === 'P' && !p.textContent.trim()) p.remove();
    else sp.remove();
  });
}
// 잠긴 블록 마커([LOCKED_BLOCK:blk_...], 이스케이프된 \[ 형태 포함)를
// 플레이스홀더 HTML로 바꾼다 (UI-003). data-block-id가 있어야 해제가 가능하다.
function lockedBlockMarkerToHtml(src) {
  return String(src).replace(/\\?\[LOCKED_BLOCK:(blk_[\w-]+)\\?\]/g,
    (m, bid) => `<span class="locked-block" data-block-id="${bid}" contenteditable="false" style="background:#f0f0f0;border:1px dashed #999;padding:2px 8px;margin:0 2px;cursor:pointer;color:#666;border-radius:4px;">잠긴 블록 (클릭하여 해제)</span>`);
}
// 파일 표시 URL: 잠긴 파일은 원본(암호문) Cloudinary URL·썸네일을 쓰면 깨진
// 이미지가 되거나 암호문 파일이 내려간다. 복호화 서빙 경로(/content)를 쓴다.
function fileDisplayUrl(f, id) {
  return f && f.is_locked ? '/api/memo/files/' + id + '/content' : (f.thumb || f.url);
}
function fileFullUrl(f, id) {
  return f && f.is_locked ? '/api/memo/files/' + id + '/content' : f.url;
}
function mdToEditable(md, fileMap) {
  const withWidths = String(md).replace(/<!--[\s]*tblwidths:[\s]*([\d,\s]+)[\s]*-->/g,
    (m, nums) => '<span data-tblw="' + nums.replace(/\s+/g, '') + '"></span>');
  const withImgs = lockedBlockMarkerToHtml(withWidths).replace(/!\[([^\]]*)\]\(file:(\d+)\)/g, (m, alt, id) => {
    const f = fileMap && fileMap[id];
    if (!f) return m;
    const pa = parseMarkerAlt(alt);
    const style = pa.width ? ` style="width:${pa.width}px;max-width:100%;height:auto;"` : '';
    return `<img src="${esc(fileDisplayUrl(f, id))}" data-fid="${id}" data-full="${esc(fileFullUrl(f, id))}" alt="${esc(pa.alt)}"${style}>`;
  });
  let html;
  if (window.marked) {
    try { html = window.marked.parse(withImgs, { breaks: true }); }
    catch { html = '<p>' + esc(withImgs).replace(/\n/g, '<br>') + '</p>'; }
  } else {
    html = '<p>' + esc(withImgs).replace(/\n/g, '<br>') + '</p>';
  }
  let out = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  // 태스크 리스트를 에디터용 형식으로 변환
  out = out.replace(/<ul>(\s*<li>\s*<input[^>]*type="checkbox"[^>]*>.*?<\/li>\s*)+<\/ul>/gs, (m) => {
    return m.replace(/<ul>/, '<ul class="task-list">')
            .replace(/<li>/g, '<li class="task-item">')
            .replace(/(<input[^>]*type="checkbox"[^>]*>)([^<]*)/g, '$1<span>$2</span>');
  });
  return out;
}
// 화면 표시용: 마크다운 → HTML (마커를 이미지로 치환)
function renderBodyHtml(text, fileMap, q) {
  let src = q ? highlight(text, q) : String(text);
  // 명시적 제목(# Title)은 본문에서 제거 (제목은 별도 표시)
  src = src.replace(/^#\s+.+\n\n?/, '');
  src = lockedBlockMarkerToHtml(src);
  src = src.replace(/!\[([^\]]*)\]\(file:(\d+)\)/g, (m, alt, id) => {
    const f = fileMap && fileMap[id];
    if (!f) return m;
    const pa = parseMarkerAlt(alt);
    const style = pa.width ? ` style="width:${pa.width}px;max-width:100%;height:auto;"` : '';
    return `<img class="inline-img" src="${esc(fileDisplayUrl(f, id))}" data-fid="${id}" data-full="${esc(fileFullUrl(f, id))}" alt="${esc(pa.alt)}"${style}>`;
  });
  let html;
  if (window.marked) {
    try { html = window.marked.parse(src, { breaks: true }); }
    catch { html = '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>'; }
  } else {
    html = '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>';
  }
  return window.DOMPurify
    ? DOMPurify.sanitize(html, { ADD_TAGS: ['u', 'mark'], ADD_ATTR: ['style', 'target'] })
    : html;
}

/* ================= 4. 작성 (컴포저) ================= */
const composerEditor = wireEditor($('composerRich'), $('composerToolbar'), true);
let composerTitle = '';
function makeTitleLabel() {
  const label = document.createElement('span');
  label.className = 'composer-title';
  label.id = 'composerTitleLabel';
  label.title = '클릭하여 제목 수정';
  label.textContent = composerTitle || '새 메모';
  label.addEventListener('click', editComposerTitle);
  return label;
}
function renderComposerTitle() {
  const cur = $('composerTitleLabel');
  if (!cur || cur.tagName === 'INPUT') return;
  cur.textContent = composerTitle || '새 메모';
}
function editComposerTitle() {
  const label = $('composerTitleLabel');
  if (!label || label.tagName === 'INPUT') return;
  const input = document.createElement('input');
  input.className = 'composer-title-input';
  input.id = 'composerTitleLabel';
  input.value = composerTitle;
  input.placeholder = '제목';
  input.setAttribute('aria-label', '제목');
  let done = false;
  const commit = (cancel) => {
    if (done) return; done = true;
    if (!cancel) composerTitle = input.value.trim();
    const newLabel = makeTitleLabel();
    input.replaceWith(newLabel);
  };
  input.addEventListener('blur', () => commit(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(false); }
    if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
  label.replaceWith(input);
  input.focus();
  input.select();
}
$('composerTitleLabel').addEventListener('click', editComposerTitle);
composerEditor.chipsBox = $('pending');

$('files').addEventListener('change', (e) => { handleEditorFiles(composerEditor, e.target.files); e.target.value = ''; });
composerEditor.el.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('add').click(); }
});

async function uploadPendings(memoId, pendings) {
  // Cloudinary 무료 플랜: 파일당 10MB 제한
  const MAX_SIZE = 10 * 1024 * 1024;
  const valid = [];
  for (const f of pendings) {
    if (f.size > MAX_SIZE) {
      toast(`"${f.name}"은 10MB를 초과해서 업로드할 수 없어요`, 5000);
    } else {
      valid.push(f);
    }
  }
  if (!valid.length) return [];
  // 한 번에 하나씩 순차 업로드 (멀티파트 다중 파일 파싱 이슈 방지, 인덱스 정렬 유지)
  const out = [];
  showUploadProgress(0, valid.length);
  for (let i = 0; i < valid.length; i++) {
    const f = valid[i];
    updateUploadProgress(i, valid.length, f.name);
    const fd = new FormData();
    fd.append('files', f, f.name);
    try {
      const res = await uploadWithProgress(`/api/memo/${memoId}/files`, fd, (loaded, total) => {
        // 전체 진행률 = (완료된 파일 수 + 현재 파일 진행률) / 전체
        const base = i / valid.length;
        const cur = total ? (loaded / total) / valid.length : 0;
        const pct = Math.round((base + cur) * 100);
        const el = document.getElementById('upload-progress');
        if (el) {
          el.querySelector('.up-fill').style.width = pct + '%';
          el.querySelector('.up-text').textContent = `${i+1}/${valid.length} - ${f.name} (${pct}%)`;
        }
      });
      out.push(res.files && res.files[0] ? res.files[0] : null);
      if (!res.files || !res.files[0]) {
        console.error('upload returned no files:', res);
        toast('파일 업로드 실패: ' + (res.error || f.name), 5000);
      }
    } catch (e) {
      console.error('upload failed:', f && f.name, e);
      toast('파일 업로드 실패: ' + f.name, 5000);
      out.push(null);
    }
  }
  hideUploadProgress();
  return out;
}
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error('Invalid response'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('timeout', () => reject(new Error('Timeout')));
    xhr.timeout = 120000; // 2분
    xhr.send(formData);
  });
}
function showUploadProgress(current, total) {
  let el = document.getElementById('upload-progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'upload-progress';
    el.innerHTML = `
      <div class="up-box">
        <div class="up-title">파일 업로드 중...</div>
        <div class="up-bar"><div class="up-fill"></div></div>
        <div class="up-text"></div>
      </div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  updateUploadProgress(current, total, '');
}
function updateUploadProgress(current, total, filename) {
  const el = document.getElementById('upload-progress');
  if (!el) return;
  const pct = total ? Math.round((current / total) * 100) : 0;
  el.querySelector('.up-fill').style.width = pct + '%';
  el.querySelector('.up-text').textContent = `${current}/${total} - ${filename || ''}`;
}
function hideUploadProgress() {
  const el = document.getElementById('upload-progress');
  if (el) el.style.display = 'none';
}
function applyFileIds(markdown, files) {
  let out = markdown;
  files.forEach((f, i) => {
    if (f) out = out.replace(`(pending:${i})`, `(file:${f.id})`);
  });
  return out;
}
// 인라인에서 제거된 이미지 파일 정리 (예전 텍스트에는 있고 새 텍스트에는 없는 file:ID)
function markerFileIds(text) {
  const s = new Set();
  const re = /\(file:(\d+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) s.add(Number(m[1]));
  return s;
}
async function cleanupOrphanFiles(oldText, newText) {
  const oldIds = markerFileIds(oldText);
  const newIds = markerFileIds(newText);
  for (const fid of oldIds) {
    if (!newIds.has(fid)) {
      try { await fetch('/api/memo/files/' + fid, { method: 'DELETE' }); } catch (e) { console.warn('첨부 파일 삭제 실패:', e); }
    }
  }
}

$('add').addEventListener('click', async () => {
  const cTitle = composerTitle.trim();
  if (!cTitle && editorIsEmpty(composerEditor)) return;
  const btn = $('add');
  btn.disabled = true;
  try {
    const { markdown: bodyMd, pendings } = serializeEditor(composerEditor);
    const markdown = cTitle ? cTitle + (bodyMd ? '\n\n' + bodyMd : '') : bodyMd;
    // 편집 모드: 기존 메모 업데이트
    if (window._editingMemoId) {
      const updateRes = await window._fetchStepUp('/api/memo/' + window._editingMemoId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: markdown }),
      }).then(r => r.json());
      if (updateRes.ok) {
        window._editingMemoId = null;
        var titleLabel = document.getElementById('composerTitleLabel');
        if (titleLabel) titleLabel.textContent = '새 메모';
        composerEditor.el.innerHTML = '';
        composerTitle = '';
        renderComposerTitle();
        if (typeof loadMemos === 'function') loadMemos();
      } else {
        alert('저장 실패: ' + (updateRes.error || 'unknown'));
      }
      btn.disabled = false;
      return;
    }
    // 1) 메모 먼저 생성 (이미지는 pending 마커)
    const created = await fetch('/api/memo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: markdown }),
    }).then(r => r.json());
    // 2) 인라인 이미지 업로드 후 마커를 file:ID로 치환
    if (pendings.length) {
      const files = await uploadPendings(created.id, pendings);
      const finalText = applyFileIds(markdown, files);
      await fetch('/api/memo/' + created.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: finalText }),
      });
    }
    // 3) 일반 첨부 파일 업로드
    if (composerEditor.otherFiles.length) {
      await uploadPendings(created.id, composerEditor.otherFiles);
    }
    // 초기화
    composerTitle = '';
    renderComposerTitle();
    composerEditor.el.innerHTML = '';
    composerEditor.blobMap.clear();
    composerEditor.otherFiles = [];
    refreshOtherFiles(composerEditor);
    composerEditor.toolbar.classList.add('hidden');
    hideImgResize();
    hideImgTools();
    loadTags();
    await load();
    renderCal();
    if (isDesktop() && created && created.id) selectMemo(created.id);
  } finally {
    btn.disabled = false;
  }
});

/* ================= 5. 필터 ================= */
function renderActiveFilters() {
  const box = $('activeFilters');
  box.innerHTML = '';
  const mk = (label, clear) => {
    const s = document.createElement('span');
    s.className = 'fchip';
    const lab = document.createElement('span');
    lab.innerHTML = label;
    s.appendChild(lab);
    const x = document.createElement('button');
    x.innerHTML = '<i data-lucide="x"></i>';
    x.onclick = clear;
    s.appendChild(x);
    box.appendChild(s);
  };
  if (activeTag) mk('#' + activeTag, () => { activeTag = ''; syncTagUI(); load(); });
  if (activeDate) {
    const [Y, M, D] = activeDate.split('-');
    mk(`<i data-lucide="calendar-days" class="ic-xs"></i> ${Number(M)}월 ${Number(D)}일`, () => { activeDate = ''; renderCal(); load(); });
  }

  refreshIcons();}

/* ================= 6. 태그 ================= */
async function loadTags() {
  const tags = await fetch('/api/memo/tags').then(r => r.json()).catch(() => []);
  const bar = $('tagbar');
  bar.innerHTML = '';
  tags.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tag' + (activeTag === t.tag ? ' on' : '');
    b.innerHTML = `#${esc(t.tag)}<span class="n">${t.n}</span>`;
    b.onclick = () => {
      activeTag = activeTag === t.tag ? '' : t.tag;
      syncTagUI();
      load();
    };
    bar.appendChild(b);
  });
  if (!tags.length) return;

  refreshIcons();}
function syncTagUI() {
  document.querySelectorAll('#tagbar .tag').forEach(b => {
    b.classList.toggle('on', !!activeTag && b.innerHTML.includes('#' + esc(activeTag)));
  });
  renderActiveFilters();
}
let tagbarOpen = false;
function setTagbar(open) {
  tagbarOpen = open;
  $('tagbar').hidden = !open;
  $('tglTag').classList.toggle('on', open);
  if (open) loadTags();
}
$('tglTag').onclick = () => setTagbar(!tagbarOpen);

/* ================= 7. 달력 ================= */
let calY = 0, calM = 0;
function initCal() {
  const now = new Date();
  calY = now.getFullYear();
  calM = now.getMonth() + 1;
}
async function renderCal() {
  if ($('calCard').hidden) return;
  $('calTitle').textContent = `${calY}년 ${calM}월`;
  const counts = {};
  try {
    const res = await fetch(`/api/memo/calendar?y=${calY}&m=${calM}`).then(r => r.json());
    res.forEach(x => { counts[x.day] = x.n; });
  } catch (e) { console.warn('메모 달력 조회 실패:', e); }
  const grid = $('calGrid');
  grid.innerHTML = '';
  ['일','월','화','수','목','금','토'].forEach(d => {
    const s = document.createElement('span');
    s.className = 'dow'; s.textContent = d;
    grid.appendChild(s);
  });
  const first = new Date(calY, calM - 1, 1).getDay();
  const days = new Date(calY, calM, 0).getDate();
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  for (let i = 0; i < first; i++) {
    const b = document.createElement('span');
    b.className = 'blank';
    grid.appendChild(b);
  }
  for (let d = 1; d <= days; d++) {
    const ymd = `${calY}-${String(calM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const b = document.createElement('button');
    b.className = 'day';
    b.textContent = d;
    if (counts[ymd]) { b.classList.add('has'); b.setAttribute('data-n', counts[ymd]); }
    if (ymd === todayStr) b.classList.add('today');
    if (ymd === activeDate) b.classList.add('sel');
    b.onclick = () => {
      activeDate = activeDate === ymd ? '' : ymd;
      renderCal();
      load();
    };
    grid.appendChild(b);
  }

  refreshIcons();}
$('tglCal').onclick = () => {
  const card = $('calCard');
  card.hidden = !card.hidden;
  $('tglCal').classList.toggle('on', !card.hidden);
  renderCal();
};
$('calPrev').onclick = () => { calM--; if (calM < 1) { calM = 12; calY--; } renderCal(); };
$('calNext').onclick = () => { calM++; if (calM > 12) { calM = 1; calY++; } renderCal(); };

/* ================= 8. 목록 (타임라인) ================= */
async function load() {
  const q = $('q').value.trim();
  const sig = q + '|' + activeTag + '|' + activeDate;
  if (sig !== lastFilterSig) { page = 0; lastFilterSig = sig; }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (activeTag) params.set('tag', activeTag);
  if (activeDate) params.set('date', activeDate);
  const memos = await fetch('/api/memo?' + params).then(r => r.json());
  cachedMemos = memos;
  $('count').textContent = memos.length ? memos.length + '개' : '';
  const list = $('list');
  $('empty').style.display = memos.length ? 'none' : 'block';
  list.innerHTML = '';
  renderActiveFilters();
  // 파일 목록을 먼저 병렬로 가져온 뒤 렌더 (인라인 이미지 치환용)
  // 메모 먼저 즉시 렌더 (파일은 백그라운드에서)
  memos.forEach(m => {
    memoTexts[m.id] = m.text;
    memoCache[m.id] = m;
    memoFileMap[m.id] = {};
  });
  if (isDesktop()) renderRows(memos);
  else renderCards(memos.map(m => ({ m, files: [] })), q);
  updatePanesVisibility();

  // 파일은 백그라운드에서 병렬 로딩 후 DOM 업데이트
  Promise.all(memos.filter(m => m.file_count).map(async (m) => {
    try {
      const files = await fetch(`/api/memo/${m.id}/files`).then(r => r.json());
      const fileMap = {};
      files.forEach(f => { fileMap[f.id] = f; });
      memoFileMap[m.id] = fileMap;
      // 해당 메모 카드/행만 업데이트
      updateMemoFiles(m.id, files);
    } catch (e) { console.warn('메모 파일 목록 조회 실패:', e); }
  }));
}

// 파일 로딩 완료 시 해당 메모만 업데이트 (깜빡임 없이)

function updateMemoFiles(memoId, files) {
  // 데스크톱: 행의 파일 아이콘 업데이트
  const row = document.querySelector(`[data-memo-id="${memoId}"]`);
  if (row) {
    const badge = row.querySelector('.file-badge');
    if (badge) {
      badge.textContent = files.length ? `📎 ${files.length}` : '';
      badge.style.display = files.length ? '' : 'none';
    }
  }
  // 열린 상세 팬이 있으면 다시 렌더링
  const pane = document.querySelector(`.memo-pane[data-id="${memoId}"]`);
  if (pane && !pane.querySelector('.pane-edit:not([hidden])')) {
    // 뷰 모드일 때만 다시 렌더링 (편집 중에는 건드리지 않음)
    const viewEl = pane.querySelector('.pane-view');
    if (viewEl && !viewEl.hidden) {
      const c = memoCache[memoId];
      const fm = memoFileMap[memoId] || {};
      if (c) {
        const body = viewEl.querySelector('.pane-body');
        if (body) {
          body.innerHTML = renderBodyHtml(c.text, fm, '');
          body.querySelectorAll('a[href]').forEach(a => {
            a.target = '_blank';
            a.rel = 'noopener';
          });
          body.querySelectorAll('img[data-full]').forEach(img => {
            img.style.cursor = 'default';
            img.onclick = null;
            img.addEventListener('mouseenter', () => showImgTools(img));
          });
        }
        renderPaneFiles(pane, memoId, fm, false);
      }
    }
  }
  // 모바일 카드: 해당 카드의 본문과 파일 영역 업데이트
  const card = document.querySelector(`li.memo[data-id="${memoId}"]`);
  if (card) {
    const m = memoCache[memoId];
    if (m) {
      const fm = memoFileMap[memoId] || {};
      const mdEl = card.querySelector('.md');
      if (mdEl) {
        mdEl.innerHTML = renderBodyHtml(m.text, fm, '');
        mdEl.querySelectorAll('img[data-full]').forEach(img => {
          img.addEventListener('mouseenter', () => showImgTools(img));
        });
      }
      // 파일 영역 업데이트
      const filesEl = card.querySelector('.files');
      if (filesEl) {
        filesEl.innerHTML = '';
        const refIds = markerIds(m.text);
        files.filter(f => !isImage(f.mime, f.filename)).forEach(f => {
          const wrap = document.createElement('span');
          wrap.className = 'file-chip';
          const open = document.createElement('a');
          open.href = '#';
          open.innerHTML = `<span><i data-lucide="${fileIcon(f.filename)}"></i></span><span class="name">${esc(f.filename)}</span><span class="size">${fmtSize(f.size)}</span>`;
          open.onclick = async (e) => {
            e.preventDefault();
            // 잠긴 파일은 복호화 서빙 경로로 받아야 원본이 내려간다 (트랙 D)
            const srcUrl = f.is_locked ? '/api/memo/files/' + f.id + '/content' : f.url;
            try {
              // 잠긴 파일은 보호 게이트 대상 — 403이면 PIN 모달 후 재시도한다.
              const resp = f.is_locked ? await window._fetchStepUp(srcUrl) : await fetch(srcUrl);
              if (!resp.ok) throw new Error('download_failed');
              const blob = await resp.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = f.filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch {
              // 잠긴 파일은 게이트 403 페이지를 새 탭으로 여는 폴백이 무의미하다.
              if (f.is_locked) { alert('파일을 열 수 없어요. PIN 확인이 필요합니다.'); return; }
              window.open(srcUrl, '_blank');
            }
          };
          wrap.appendChild(open);
          filesEl.appendChild(wrap);
        });
        refreshIcons();
      }
      // 이미지 영역 업데이트
      const imgsEl = card.querySelector('.imgs');
      if (imgsEl) {
        imgsEl.innerHTML = '';
        const refIds = markerIds(m.text);
        const gridImgs = files.filter(f => isImage(f.mime, f.filename) && !refIds.has(f.id));
        if (gridImgs.length === 1) imgsEl.classList.add('single');
        gridImgs.forEach(f => {
          const b = document.createElement('button');
          b.setAttribute('aria-label', '이미지 크게 보기');
          const img = document.createElement('img');
          img.src = f.is_locked ? '/api/memo/files/' + f.id + '/content' : (f.thumb || f.url);
          img.loading = 'lazy';
          img.alt = f.filename;
          img.setAttribute('data-full', f.is_locked ? '/api/memo/files/' + f.id + '/content' : f.url);
          img.setAttribute('data-fid', f.id);
          b.appendChild(img);
          b.onclick = () => openLightboxFromCard(card, img);
          imgsEl.appendChild(b);
        });
        imgsEl.querySelectorAll('img[data-full]').forEach(img => {
          img.addEventListener('mouseenter', () => showImgTools(img));
        });
      }
    }
  }
}

function renderCards(withFiles, q) {
  var list = document.getElementById('list');
  if (!list) return;
  list.innerHTML = '';
  for (var i = 0; i < withFiles.length; i++) {
    var m = withFiles[i].m;
    var li = document.createElement('li');
    li.className = 'memo';
    li.style.listStyle = 'none';
    li.style.position = 'relative';
    var d = document.createElement('div');
    d.className = 'memo-date';
    d.textContent = m.created_at || '';
    var t = document.createElement('div');
    t.className = 'memo-text';
    t.textContent = String(m.text || '');
    t.style.overflowWrap = 'break-word';
    t.style.wordBreak = 'break-word';
    t.style.display = '-webkit-box';
    t.style.webkitLineClamp = '3';
    t.style.webkitBoxOrient = 'vertical';
    t.style.overflow = 'hidden';
    li.appendChild(d);
    li.appendChild(t);
    li.setAttribute('data-id', m.id);
    li.addEventListener('click', (function(mid) {
      return function() { selectMemo(mid); };
    })(m.id));
    list.appendChild(li);
  }
  if (typeof refreshIcons === 'function') refreshIcons();
}
// HTML 엔티티 디코딩 — 서버 lib/memo-title.ts decodeHtmlEntities와 같은 규칙.
function decodeHtmlEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (e) { return whole; }
      }
      return whole;
    }
    const v = named[body.toLowerCase()];
    return v !== undefined ? v : whole;
  });
}
// 제목 도출 순서 계약 (서버 lib/memo-title.ts와 동일): 태그 제거 → 엔티티
// 디코딩 → 이미지 마커 치환 → 첫 줄 선택 → 60자 절단 → 마크다운 정리.
// 절단을 태그 제거보다 먼저 하면 긴 태그가 중간에서 잘려 닫는 '>'가 사라지고
// 태그 원문이 제목에 그대로 노출된다 (2026-11-08 운영 점검 결함).
function rowTitle(text) {
  const plain = decodeHtmlEntities(String(text || '').replace(/<[^>]*>/g, ''))
    .replace(/!\[([^\]]*)\]\((?:file|pending):\d+\)/g, '[이미지]');
  const line = (plain.split('\n').find(l => l.trim()) || '').slice(0, 60);
  return line
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*(?:[-+]|\d+[.)]|>)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim() || '(빈 메모)';
}
function renderRows(memos) {
  const list = $('list');
  list.innerHTML = '';
  renderPager(memos.length);
  const slice = memos.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  for (const m of slice) {
    const li = document.createElement('li');
    li.className = 'row' + (selectedIds.includes(m.id) ? ' sel' : '');
    li.dataset.id = m.id;
    const main = document.createElement('div');
    main.className = 'row-main';
    const textWrap = document.createElement('div');
    textWrap.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = rowTitle(m.text);
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.innerHTML = esc(fmtDate(m.created_at)) + (m.file_count ? ' · <i data-lucide="paperclip" class="ic-xs"></i>' + m.file_count : '');
    textWrap.append(title, sub);
    main.append(textWrap);
    // 잠금 인디케이터 (잠긴 메모만 표시, 클릭 불가)
    if (m.is_locked) {
      const lockInd = document.createElement('span');
      lockInd.className = 'row-lock-ind';
      lockInd.title = 'AI 접근 잠김';
      lockInd.innerHTML = `<i data-lucide="lock"></i>`;
      main.append(lockInd);
    }
    li.append(main);
    li.addEventListener('click', () => selectMemo(m.id));
    list.appendChild(li);
  }

  refreshIcons();}
function syncRowSelection() {
  document.querySelectorAll('#list .row').forEach(li => {
    li.classList.toggle('sel', selectedIds.includes(Number(li.dataset.id)));
  });
}
function selectMemo(id) {
  id = Number(id);
  if (selectedIds.includes(id)) closePane(id);
  else { selectedIds.push(id); openPane(id); }
  syncRowSelection();
  updatePanesVisibility();
}
function closePane(id, silent) {
  id = Number(id);
  selectedIds = selectedIds.filter(x => x !== id);
  const p = document.querySelector(`.pane[data-pane="${id}"]`);
  if (p) p.remove();
  if (!silent) { syncRowSelection(); updatePanesVisibility(); }
}
function closeAllPanes() {
  hideImgResize();
  hideImgTools();
  document.querySelectorAll('.pane').forEach(p => p.remove());
}
// 71차: 위젯에서 호출할 수 있도록 window에 노출
window.closePane = closePane;

/* ================= 9. 인라인 수정 ================= */
function startEdit(id) {
  const li = document.querySelector(`li.memo[data-id="${id}"]`);
  if (!li || li.querySelector('.editor')) return;
  const mdEl = li.querySelector('.md');
  const ed = document.createElement('div');
  ed.className = 'editor';
  const titleInput = document.createElement('input');
  titleInput.className = 'title-input';
  titleInput.placeholder = '제목';
  titleInput.autocomplete = 'off';
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar hidden';
  const rich = document.createElement('div');
  rich.className = 'rich';
  rich.contentEditable = 'true';
  rich.setAttribute('data-ph', '메모 수정...');
  const editor = wireEditor(rich, toolbar, true);
  editor.titleInput = titleInput;
  const chipsBox = document.createElement('div');
  chipsBox.className = 'pending';
  editor.chipsBox = chipsBox;
  const row = document.createElement('div');
  row.className = 'editor-row';
  const imgBtn = document.createElement('label');
  imgBtn.className = 'mini-file-btn';
  imgBtn.innerHTML = '<i data-lucide="image"></i>';
  imgBtn.title = '이미지 삽입';
  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.accept = 'image/*';
  imgInput.multiple = true;
  imgInput.addEventListener('change', () => { handleEditorFiles(editor, imgInput.files); imgInput.value = ''; });
  imgBtn.appendChild(imgInput);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-ghost';
  cancelBtn.textContent = '취소';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-accent';
  saveBtn.textContent = '저장';
  row.append(imgBtn, cancelBtn, saveBtn);
  ed.append(titleInput, toolbar, rich, chipsBox, row);
  mdEl.after(ed);
  mdEl.style.display = 'none';
  refreshIcons();
  const { title: mTitle, body: mBody } = extractTitle(memoTexts[id] || '');
  titleInput.value = mTitle;
  rich.innerHTML = mdToEditable(mBody, memoFileMap[id] || {});
  applyTableWidths(rich);
  rich.focus();
  cancelBtn.addEventListener('mousedown', (e) => e.preventDefault());
  cancelBtn.onclick = () => { hideImgResize(); hideImgTools(); ed.remove(); mdEl.style.display = ''; };
  // 저장 버튼: mousedown preventDefault 제거 (클릭 이벤트 방해 가능성)
  // 대신 blur 방지를 위해 pointerdown 사용
  saveBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  saveBtn.onclick = async () => {
    const mTitle = titleInput.value.trim();
    if (!mTitle && editorIsEmpty(editor)) return;
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';
    const oldText = memoTexts[id] || '';
    try {
      const { markdown: bodyMd, pendings } = serializeEditor(editor);
      const markdown = mTitle ? mTitle + (bodyMd ? '\n\n' + bodyMd : '') : bodyMd;
      let finalText = markdown;
      if (pendings.length) {
        const files = await uploadPendings(id, pendings);
        finalText = applyFileIds(markdown, files);
      }
      if (editor.otherFiles.length) {
        await uploadPendings(id, editor.otherFiles);
      }
      await window._fetchStepUp('/api/memo/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: finalText }),
      });
      await cleanupOrphanFiles(oldText, finalText);
      hideImgResize();
      hideImgTools();
      loadTags();
      load();
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  };
  rich.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  });
}

/* ================= 10. 이미지 도구 (복사) ================= */
function toast(msg, duration) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), duration || 1800);
}
async function copyImageToClipboard(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('fetch');
    const blob = await res.blob();
    const type = blob.type || 'image/png';
    await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
    toast('이미지를 클립보드에 복사했어요');
  } catch {
    try {
      await navigator.clipboard.writeText(url);
      toast('이미지 주소를 복사했어요');
    } catch {
      toast('복사에 실패했어요');
    }
  }
}
let imgToolsBar = null;
let imgToolsTimer = null;
function hideImgTools() {
  if (imgToolsBar) { imgToolsBar.remove(); imgToolsBar = null; }
  clearTimeout(imgToolsTimer);
}
function showImgTools(img) {
  if (imgToolsBar && imgToolsBar._img === img) return;
  if (imgResize && imgResize.resizing) return;
  hideImgTools();
  const bar = document.createElement('div');
  bar.className = 'img-tools';
  bar._img = img;
  const isEditMode = !!img.closest('[contenteditable="true"]');
  if (isEditMode) {
    // 수정모드: 삭제 버튼만 (휴지통, 적색)
    const delBtn = document.createElement('button');
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.className = 'danger';
    delBtn.title = '이미지 삭제';
    delBtn.setAttribute('aria-label', '이미지 삭제');
    delBtn.addEventListener('mousedown', (e) => e.preventDefault());
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ed = img.closest('[contenteditable="true"]');
      img.remove();
      hideImgTools();
      hideImgResize();
      if (ed) ed.dispatchEvent(new Event('input', { bubbles: true }));
    });
    bar.appendChild(delBtn);
  } else {
    // 일반모드: 돋보기 + 복사 + 다운로드 버튼
    const zoomBtn = document.createElement('button');
    zoomBtn.innerHTML = '<i data-lucide="zoom-in"></i>';
    zoomBtn.title = '크게 보기';
    zoomBtn.setAttribute('aria-label', '크게 보기');
    zoomBtn.addEventListener('mousedown', (e) => e.preventDefault());
    zoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideImgTools();
      // 라이트박스 열기
      const pane = img.closest('.memo-pane');
      if (pane) openLightboxFromCard(pane, img);
      else img.click();
    });
    bar.appendChild(zoomBtn);
    const copyBtn = document.createElement('button');
    copyBtn.innerHTML = '<i data-lucide="copy"></i>';
    copyBtn.title = '이미지 복사';
    copyBtn.setAttribute('aria-label', '이미지 복사');
    copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyImageToClipboard(img.getAttribute('data-full') || img.src);
    });
    bar.appendChild(copyBtn);
    const dlBtn = document.createElement('button');
    dlBtn.innerHTML = '<i data-lucide="download"></i>';
    dlBtn.title = '이미지 다운로드';
    dlBtn.setAttribute('aria-label', '이미지 다운로드');
    dlBtn.addEventListener('mousedown', (e) => e.preventDefault());
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = img.getAttribute('data-full') || img.src;
      a.download = img.getAttribute('alt') || 'image';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    bar.appendChild(dlBtn);
  }
  const place = () => {
    const r = img.getBoundingClientRect();
    bar.style.left = (r.left + 8 + window.scrollX) + 'px';
    bar.style.top = (r.top + 8 + window.scrollY) + 'px';
  };
  place();
  bar.addEventListener('mouseenter', () => clearTimeout(imgToolsTimer));
  bar.addEventListener('mouseleave', () => { imgToolsTimer = setTimeout(hideImgTools, 250); });
  document.body.appendChild(bar);
  imgToolsBar = bar;
  refreshIcons();
  img.addEventListener('mouseleave', () => { imgToolsTimer = setTimeout(hideImgTools, 250); }, { once: true });
}

/* ================= 11. 라이트박스 (줌) ================= */
let lbImages = [], lbIndex = 0, lbZoom = 1;
function setZoom(z) {
  lbZoom = Math.min(4, Math.max(1, z));
  $('lb-img').style.transform = lbZoom === 1 ? '' : `scale(${lbZoom})`;
}
function openLightboxFromCard(li, clickedImg) {
  const imgs = [...li.querySelectorAll('img[data-full]')];
  lbImages = imgs.map(im => ({ url: im.getAttribute('data-full'), filename: im.alt || '이미지' }));
  lbIndex = Math.max(0, imgs.indexOf(clickedImg));
  setZoom(1);
  renderLb();
  $('lb').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function renderLb() {
  const f = lbImages[lbIndex];
  if (!f) return;
  setZoom(1);
  $('lb-img').src = f.url;
  $('lb-img').alt = f.filename;
  $('lb-dl').href = f.url;
  $('lb-dl').setAttribute('download', f.filename);
  const multi = lbImages.length > 1;
  $('lb-prev').style.display = multi ? '' : 'none';
  $('lb-next').style.display = multi ? '' : 'none';
  $('lb-count').textContent = multi ? (lbIndex + 1) + ' / ' + lbImages.length : '';
}
function closeLightbox() {
  $('lb').classList.remove('open');
  document.body.style.overflow = '';
  $('lb-img').src = '';
  setZoom(1);
}
function lbNav(d) {
  lbIndex = (lbIndex + d + lbImages.length) % lbImages.length;
  renderLb();
}
$('lb-close').onclick = closeLightbox;
$('lb-copy').onclick = (e) => {
  e.stopPropagation();
  const f = lbImages[lbIndex];
  if (f) copyImageToClipboard(f.url);
};
$('lb').addEventListener('click', (e) => { if (e.target === $('lb') || e.target.classList.contains('stage')) closeLightbox(); });
$('lb-prev').onclick = (e) => { e.stopPropagation(); lbNav(-1); };
$('lb-next').onclick = (e) => { e.stopPropagation(); lbNav(1); };
$('lb-zin').onclick = (e) => { e.stopPropagation(); setZoom(lbZoom * 1.3); };
$('lb-zout').onclick = (e) => { e.stopPropagation(); setZoom(lbZoom / 1.3); };
$('lb-zreset').onclick = (e) => { e.stopPropagation(); setZoom(1); };
document.addEventListener('keydown', (e) => {
  if (!$('lb').classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lbNav(-1);
  if (e.key === 'ArrowRight') lbNav(1);
  if (e.key === '+' || e.key === '=') setZoom(lbZoom * 1.3);
  if (e.key === '-') setZoom(lbZoom / 1.3);
});

/* 키보드 단축키: / 검색, n 새 메모, Esc 닫기 */
document.addEventListener('keydown', (e) => {
  if ($('lb').classList.contains('open')) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); }
  else if ((e.key === 'n' || e.key === 'N') && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); $('composerRich').focus(); }
  else if (e.key === 'Escape' && document.activeElement === $('q')) { $('q').value = ''; $('q').blur(); load(); }
});

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


function buildToolbarButtons(bar, editor) {
  // 스테이징 전용 진단 패널 (TRACE 로그를 DOM에 표시)
  let diagPanel = document.getElementById('memo-trace-panel');
  if (!diagPanel) {
    diagPanel = document.createElement('div');
    diagPanel.id = 'memo-trace-panel';
    diagPanel.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#000;color:#0f0;font-family:monospace;font-size:11px;padding:8px;max-width:400px;max-height:200px;overflow:auto;z-index:9999;display:none;';
    document.body.appendChild(diagPanel);
  }
  const traceLog = (msg) => {
    console.log(msg);
    diagPanel.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = new Date().toISOString().slice(11, 19) + ' ' + msg;
    diagPanel.appendChild(line);
    // 최대 50줄 유지
    while (diagPanel.children.length > 50) diagPanel.removeChild(diagPanel.firstChild);
  };

  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 선택 유지
    b.addEventListener('click', () => {
      traceLog('[TRACE-01] 버튼 클릭 이벤트 진입: ' + title);
      try {
        restoreSel(editor);
        traceLog('[TRACE-02] restoreSel 완료');
      } catch (e) {
        traceLog('[TRACE-02-ERR] restoreSel 실패: ' + e.message);
      }
      closePops(bar);
      try {
        const result = fn(editor);
        traceLog('[TRACE-03] fn() 호출됨, Promise: ' + (result instanceof Promise));
        if (result instanceof Promise) {
          result.catch(e => traceLog('[TRACE-03-ERR] 비동기 오류: ' + e.message));
        }
      } catch (e) {
        traceLog('[TRACE-03-ERR] fn() 동기 오류: ' + e.message);
      }
      editor.el.focus();
    });
    return b;
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; return s; };
  // 블록 잠금 버튼 (UI-003 근본 수정, 2026-10-30)
  // 과거 이 버튼은 MEMO-001 "렌더러 정지"를 이유로 하드코딩 비활성화돼 있었다
  // (daf9acb·ad01376). 정지 원인은 끝내 확정되지 않았으나(가설만 존재), 구 핸들러의
  // 위험 패턴은 확인 가능했고 전부 제거했다:
  //  1) stale한 editor.savedRange를 그대로 addRange — restoreSel이 clone+연결성
  //     검증으로 하드닝됐고, 아래 핸들러도 폴백 시 clone만 쓴다.
  //  2) 선택 범위에 <div> 플레이스홀더 삽입 — <p> 안의 div는 브라우저가 DOM을
  //     재구성한다. 인라인 <span contenteditable="false">로 교체했다.
  //  3) 잠금 후 본문 미저장 — 구 서버 lock-block은 암호문 사본만 저장하므로, 저장하지
  //     않으면 비밀 평문이 memos.text에 그대로 남았다. 이제 플레이스홀더가
  //     [LOCKED_BLOCK:<id>] 마커로 직렬화되고(md.js), 대기 중 첨부가 없을 때는
  //     즉시 PUT해 마커를 본문에 반영한다.
  //     순서 (2026-10-30 서버 근본 수정 D-3 연계): 서버 lock-block이 본문의
  //     평문을 마커로 원자 치환하고, 본문에 없는 html은 fail-closed로 거부한다.
  //     그래서 미저장 편집 상태로 잠그면 서버 본문과 어긋나 거부된다 —
  //     핸들러는 저장 → 잠금 → 마커 반영 순서를 지킨다.
  //  4) 해제 시 PIN step-up 미연동 — fetchLockWithPin(페인)으로 PIN을 받아 재시도한다.
  const lockBlockBtn = btn('<i data-lucide="lock"></i>', '선택한 블록 잠금', async (editor) => {
    // 선택 영역 확보: 실시간 selection 우선, editor.savedRange 폴백은 clone만 사용
    let range = null;
    const liveSel = window.getSelection();
    if (liveSel.rangeCount && !liveSel.isCollapsed && editor.el.contains(liveSel.anchorNode)) {
      range = liveSel.getRangeAt(0).cloneRange();
    } else if (editor.savedRange && editor.savedRange.startContainer
        && editor.savedRange.startContainer.isConnected
        && editor.el.contains(editor.savedRange.startContainer)) {
      range = editor.savedRange.cloneRange();
    }
    if (!range || range.collapsed) {
      alert('잠글 텍스트를 먼저 선택해주세요.');
      return;
    }
    const memoId = window.currentEditingMemoId;
    if (!memoId) {
      alert('메모를 먼저 저장한 후에 블록을 잠글 수 있습니다.');
      return;
    }
    const selectedText = range.toString();
    if (!selectedText.trim()) {
      alert('잠글 텍스트를 선택해주세요.');
      return;
    }
    if (selectedText.length > 5000) {
      alert('선택한 텍스트가 너무 깁니다. (최대 5000자)');
      return;
    }
    // 순서 1) 저장: 서버 lock-block(D-3)은 저장된 본문에 선택 텍스트가
    // 있어야만 잠금을 적용한다(fail-closed). 미저장 편집을 먼저 PUT해
    // 서버 본문과 편집기 상태를 일치시킨다. 대기 중 첨부가 있으면 단순
    // PUT으로 파일이 유실될 수 있어, 먼저 저장하고 오도록 안내하고 중단한다.
    const hasPendingsEarly = (editor.blobMap && editor.blobMap.size > 0)
      || (editor.otherFiles && editor.otherFiles.length > 0);
    if (hasPendingsEarly) {
      alert('첨부 업로드가 끝나지 않았어요. 먼저 저장한 뒤 블록을 잠가주세요.');
      return;
    }
    if (typeof serializeEditor === 'function') {
      try {
        const { markdown: curMd } = serializeEditor(editor);
        const curTitle = editor.titleInput ? editor.titleInput.value.trim() : '';
        const curText = curTitle ? '# ' + curTitle + (curMd ? '\n\n' + curMd : '') : curMd;
        const saveRes = await window._fetchStepUp('/api/memo/' + memoId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: curText })
        });
        if (!saveRes.ok) {
          alert('블록 잠금 전에 본문 저장에 실패했습니다. 저장 버튼을 눌러주세요.');
          return;
        }
        if (typeof memoCache !== 'undefined' && memoCache[memoId]) memoCache[memoId].text = curText;
        if (typeof memoTexts !== 'undefined') memoTexts[memoId] = curText;
      } catch (e) {
        alert('블록 잠금 전에 본문 저장에 실패했습니다. 저장 버튼을 눌러주세요.');
        return;
      }
    }
    // 순서 2) 잠금: 서버가 본문의 평문을 [LOCKED_BLOCK:<id>] 마커로 원자 치환한다.
    let data;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch('/api/memo/' + memoId + '/lock-block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: selectedText }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        alert('블록 잠금 실패: ' + (errData.error === 'block_not_in_text'
          ? '선택한 내용이 저장된 본문과 달라요. 저장 후 다시 시도해주세요.'
          : (errData.error || '서버 오류')));
        return;
      }
      data = await res.json();
    } catch (e) {
      if (e.name === 'AbortError') alert('블록 잠금 요청 시간이 초과되었습니다. (10초)');
      else alert('블록 잠금 실패: ' + e.message);
      return;
    }
    if (!data.ok || !data.blockId) {
      alert('블록 잠금 실패: ' + (data.error || '알 수 없는 오류'));
      return;
    }
    // 플레이스홀더 삽입: 인라인 span (div-in-p 재구성 회피), 편집 불가 원자 요소
    const placeholder = document.createElement('span');
    placeholder.className = 'locked-block';
    placeholder.setAttribute('data-block-id', data.blockId);
    placeholder.setAttribute('contenteditable', 'false');
    placeholder.textContent = '잠긴 블록 (' + selectedText.length + '자, 클릭하여 해제)';
    placeholder.style.cssText = 'background:#f0f0f0;border:1px dashed #999;padding:2px 8px;margin:0 2px;cursor:pointer;color:#666;border-radius:4px;';
    placeholder.addEventListener('click', () => { unlockLockedBlockEl(placeholder, memoId); });
    try {
      range.deleteContents();
      range.insertNode(placeholder);
      const sel = window.getSelection();
      sel.removeAllRanges();
      const after = document.createRange();
      after.setStartAfter(placeholder);
      after.collapse(true);
      sel.addRange(after);
    } catch (domErr) {
      console.error('DOM 업데이트 실패:', domErr);
      alert('화면 갱신에 실패했습니다. 새로고침해주세요.');
      return;
    }
    editor.el.dispatchEvent(new Event('input', { bubbles: true }));
    // 순서 3) 마커 반영: 서버는 이미 본문을 마커로 치환했지만, 편집기 DOM의
    // 플레이스홀더를 직렬화한 텍스트로 한 번 더 PUT해 로컬 상태와 일치시킨다.
    // 대기 중 첨부가 있으면(이미 위에서 중단했으므로 보통 없음) 직렬화가 그
    // 파일들을 잃으므로 자동 저장하지 않는다.
    const hasPendings = (editor.blobMap && editor.blobMap.size > 0)
      || (editor.otherFiles && editor.otherFiles.length > 0);
    if (!hasPendings && typeof serializeEditor === 'function') {
      try {
        const { markdown: bodyMd } = serializeEditor(editor);
        const pTitle = editor.titleInput ? editor.titleInput.value.trim() : '';
        const finalText = pTitle ? '# ' + pTitle + (bodyMd ? '\n\n' + bodyMd : '') : bodyMd;
        const putRes = await window._fetchStepUp('/api/memo/' + memoId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: finalText })
        });
        if (putRes.ok) {
          if (typeof memoCache !== 'undefined' && memoCache[memoId]) memoCache[memoId].text = finalText;
          if (typeof memoTexts !== 'undefined') memoTexts[memoId] = finalText;
        } else {
          alert('블록은 잠겼지만 본문 저장에 실패했습니다. 저장 버튼을 눌러주세요.');
        }
      } catch (e) {
        console.warn('블록 잠금 본문 반영 실패:', e);
        alert('블록은 잠겼지만 본문 저장에 실패했습니다. 저장 버튼을 눌러주세요.');
      }
    }
  });
  const popupBtn = (label, title, kind) => {
    const b = document.createElement('button');
    b.type = 'button'; b.innerHTML = label; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      // 팝업 열기 전에 현재 selection을 먼저 저장 (restoreSel보다 먼저)
      const selBefore = window.getSelection();
      const savedRange = selBefore.rangeCount ? selBefore.getRangeAt(0).cloneRange() : null;
      restoreSel(editor);
      if (bar.querySelector('.pop')) { closePops(bar); return; }
      const pop = document.createElement('div');
      pop.className = 'pop';
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      // 저장된 range로 selection 복원하는 헬퍼
      const restoreSaved = () => {
        if (savedRange) {
          editor.el.focus();
          const s = window.getSelection();
          s.removeAllRanges();
          try { s.addRange(savedRange.cloneRange()); } catch (e) { console.warn('선택 영역 복원 실패:', e); }
        } else {
          restoreSel(editor);
        }
      };
      if (kind === 'color' || kind === 'highlight') {
        const colors = kind === 'color' ? PALETTE : HIGHLIGHTS;
        const prop = kind === 'color' ? 'color:' : 'background-color:';
        colors.forEach(c => {
          const sw = document.createElement('button');
          sw.type = 'button'; sw.className = 'sw'; sw.style.background = c;
          sw.setAttribute('aria-label', c);
          sw.addEventListener('click', () => { restoreSaved(); wrapSelectionStyle(prop + c); closePops(bar); editor.el.focus(); });
          pop.appendChild(sw);
        });
        if (kind === 'highlight') {
          const none = document.createElement('button');
          none.type = 'button'; none.className = 'sz'; none.textContent = '없음';
          none.addEventListener('click', () => { restoreSaved(); wrapSelectionStyle('background-color:transparent'); closePops(bar); editor.el.focus(); });
          pop.appendChild(none);
        }
      } else {
        const customRow = document.createElement('div');
        customRow.className = 'sz-custom';
        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = '12pt';
        customInput.setAttribute('aria-label', '직접 입력 (예: 12pt)');
        customInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            let v = customInput.value.trim();
            if (!v) return;
            if (/^\d+(\.\d+)?$/.test(v)) v += 'pt';
            restoreSaved(); wrapSelectionStyle('font-size:' + v);
            closePops(bar);
            editor.el.focus();
          }
          e.stopPropagation();
        });
        customInput.addEventListener('mousedown', (e) => e.stopPropagation());
        const customBtn = document.createElement('button');
        customBtn.type = 'button'; customBtn.className = 'sz'; customBtn.textContent = '적용';
        customBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        customBtn.addEventListener('click', () => {
          let v = customInput.value.trim();
          if (!v) return;
          if (/^\d+(\.\d+)?$/.test(v)) v += 'pt';
          restoreSaved(); wrapSelectionStyle('font-size:' + v);
          closePops(bar);
          editor.el.focus();
        });
        customRow.append(customInput, customBtn);
        pop.appendChild(customRow);
        SIZES.forEach(([label, size]) => {
          const sz = document.createElement('button');
          sz.type = 'button'; sz.className = 'sz'; sz.textContent = label;
          sz.addEventListener('click', () => { restoreSaved(); wrapSelectionStyle('font-size:' + size); closePops(bar); editor.el.focus(); });
          pop.appendChild(sz);
        });
      }
      bar.appendChild(pop);
    });
    return b;
  };

  bar.append(
    btn('<i data-lucide="undo-2"></i>', '되돌리기', () => execCmd('undo')),
    btn('<i data-lucide="redo-2"></i>', '다시 실행', () => execCmd('redo')),
    sep(),
    btn('<i data-lucide="bold"></i>', '굵게', () => execCmd('bold')),
    btn('<i data-lucide="italic"></i>', '기울임', () => execCmd('italic')),
    btn('<i data-lucide="underline"></i>', '밑줄', () => execCmd('underline')),
    btn('<i data-lucide="strikethrough"></i>', '취소선', () => execCmd('strikeThrough')),
    sep(),

    btn('<i data-lucide="list"></i>', '글머리 기호', (ed) => {
      restoreSel(ed);
      if (!ed.el.textContent.trim() && !ed.el.querySelector('ul,ol,li')) {
        execCmd('insertHTML', '<ul><li><br></li></ul>');
      } else {
        execCmd('insertUnorderedList');
      }
    }),
    btn('<i data-lucide="list-ordered"></i>', '번호 매기기', (ed) => {
      restoreSel(ed);
      if (!ed.el.textContent.trim() && !ed.el.querySelector('ul,ol,li')) {
        execCmd('insertHTML', '<ol><li><br></li></ol>');
      } else {
        execCmd('insertOrderedList');
      }
    }),
    btn('<i data-lucide="indent"></i>', '들여쓰기', (ed) => {
      restoreSel(ed);
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const block = node.nodeType === 3 ? node.parentElement : node;
      let target = block.closest('p, div, li');
      // 에디터 자체가 잡히거나 블록이 없으면: 현재 내용을 p로 감싸기
      if (!target || target === ed.el) {
        // 선택 영역이 있으면 그 부분을, 없으면 현재 블록을 p로 감싸기
        if (!range.collapsed) {
          execCmd('formatBlock', 'p');
          target = sel.anchorNode.nodeType === 3
            ? sel.anchorNode.parentElement.closest('p')
            : sel.anchorNode.closest('p');
        } else {
          // 빈 에디터면 그냥 p 생성
          execCmd('insertHTML', '<p>\u200B</p>');
          const p = ed.el.querySelector('p:last-child');
          if (p) {
            const r = document.createRange();
            r.selectNodeContents(p);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);
            target = p;
          }
        }
      }
      if (target && target !== ed.el) {
        const cur = parseInt(target.style.marginLeft || '0', 10);
        target.style.marginLeft = (cur + 40) + 'px';
      }
    }),
    btn('<i data-lucide="outdent"></i>', '내어쓰기', (ed) => {
      restoreSel(ed);
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const block = node.nodeType === 3 ? node.parentElement : node;
      const target = block.closest('p, div, li') || block;
      if (target && target !== ed.el) {
        const cur = parseInt(target.style.marginLeft || '0', 10);
        target.style.marginLeft = Math.max(0, cur - 40) + 'px';
      }
    }),
    btn('<i data-lucide="quote"></i>', '인용', (ed) => {
      restoreSel(ed);
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const node = sel.anchorNode;
      const block = node.nodeType === 3 ? node.parentElement : node;
      const bq = block.closest('blockquote');
      if (bq) {
        // 이미 인용 안이면 해제: 내용을 꺼내고 blockquote 제거
        const parent = bq.parentNode;
        while (bq.firstChild) parent.insertBefore(bq.firstChild, bq);
        parent.removeChild(bq);
      } else {
        execCmd('formatBlock', 'blockquote');
      }
      ed.el.focus();
    }),

    btn('<i data-lucide="table"></i>', '표 삽입', () => openTablePicker(bar, editor)),
    btn('<i data-lucide="link"></i>', '링크', (ed) => openLinkDialog(bar, ed)),
    sep(),
    popupBtn('<i data-lucide="palette"></i>', '글자색', 'color'),
    popupBtn('<i data-lucide="highlighter"></i>', '형광펜', 'highlight'),
    popupBtn('<i data-lucide="a-large-small"></i>', '글자 크기', 'size'),
    btn('<i data-lucide="eraser"></i>', '서식 지우기', (ed) => {
      restoreSel(ed);
      const unwrap = (el) => {
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      };
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      let range = sel.getRangeAt(0);
      if (range.collapsed) {
        const node = sel.anchorNode;
        const block = node.nodeType === 3 ? node.parentElement : node;
        const target = block.closest('p,div,li,h1,h2,h3,blockquote') || ed.el;
        range = document.createRange();
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      // detached div에서 정리 후 insertHTML로 교체 (네이티브 undo에 기록)
      const div = document.createElement('div');
      div.appendChild(range.cloneContents());
      div.querySelectorAll('b,strong,i,em,u,s,strike,del,sub,sup,code,font,a').forEach(unwrap);
      div.querySelectorAll('span[style]').forEach(sp => {
        sp.removeAttribute('style');
        if (!sp.attributes.length) unwrap(sp);
      });
      div.querySelectorAll('b,i,u,s,strike,span').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
      });
      execCmd('insertHTML', div.innerHTML);
      // 선택이 여러 인라인 요소를 가로지를 때 실제 DOM에 남는 빈 껍데기(<b></b> 등) 청소
      ed.el.querySelectorAll('b,i,u,s,strike,span').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
      });
      ed.el.focus();
    }),
    sep(),
    lockBlockBtn
  );
  refreshIcons();
}

// 표 크기 그리드 피커 (Notion/TipTap식)
// ---- 블록 잠금 해제 공용 헬퍼 (UI-003) ----
// 해제 API 호출 + step-up PIN 재시도. fetchLockWithPin은 pane.js의 전역 함수로,
// 번들 로드 후 클릭 시점에는 항상 존재한다. 없으면(단독 로드 등) 일반 fetch로 폴백.
//
// unlock_pending 처리 (트랙 C 관찰 연계, 2026-10-30): 서버는 복호화에 성공했지만
// locked_blocks 제거 UPDATE가 실패하면 {ok:true, html, warning:'unlock_pending'}을
// 돌려준다 — 복호문은 왔지만 암호문 블록이 DB에 남아 있는 부분 성공이다.
// 이를 무경고 성공으로 처리하면 호출자가 플레이스홀더/마커를 평문으로 교체·저장해
// blockId가 UI에서 사라지고, 암호문 사본만 DB에 영구 잔류한다(고아 암호문).
// 그래서 여기서 1회 자동 재시도한다: 재시도에서 블록이 이미 제거됐으면 404가
// 오는데, 그 경우 첫 응답의 html로 완전 성공으로 간주한다. 재시도 후에도
// warning이 남으면 그대로 호출자에게 전달하고, 호출자는 플레이스홀더/마커를
// 유지한 채 사용자에게 보류를 알려야 한다 (재클릭으로 재시도 가능하게).
async function requestUnlockBlock(memoId, blockId) {
  const url = '/api/memo/' + memoId + '/unlock-block/' + blockId;
  const call = async () => {
    const res = (typeof fetchLockWithPin === 'function')
      ? await fetchLockWithPin(url, {})
      : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  const first = await call();
  if (first.data && first.data.ok && first.data.warning === 'unlock_pending') {
    const retry = await call();
    if (retry.data && retry.data.ok) return retry;
    if (retry.res.status === 404) {
      // 재시도 시점에 블록이 이미 제거됨 = 해제 완료. 첫 응답의 html을 쓴다.
      return { res: first.res, data: { ok: true, html: first.data.html } };
    }
    return retry.data ? retry : first;
  }
  return first;
}

// 에디터 안 플레이스홀더 해제: 성공하면 플레이스홀더를 복호화된 텍스트로 되돌린다.
// unlock_pending이 남으면 플레이스홀더를 유지하고 보류를 알린다 (위 주석 참조).
async function unlockLockedBlockEl(el, memoId) {
  const blockId = el.getAttribute('data-block-id');
  if (!blockId) return;
  // 확인은 네이티브 confirm이 아니라 공용 커스텀 모달(window._confirmAction)로
  // 받는다. 네이티브 다이얼로그는 자동화 브라우저가 자동 닫기 때문에, 그걸
  // 관문으로 쓰면 해제 흐름 전체가 아무 반응 없이 죽는다 (실측으로 확정).
  const confirmed = (typeof window !== 'undefined' && typeof window._confirmAction === 'function')
    ? await window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')
    : confirm('이 블록의 잠금을 해제할까요?');
  if (!confirmed) return;
  try {
    const { data } = await requestUnlockBlock(memoId, blockId);
    if (data.ok && data.warning === 'unlock_pending') {
      alert('서버에서 암호문 블록을 제거하지 못해 해제를 보류했어요.\n블록은 잠긴 상태로 유지됩니다. 다시 시도해주세요.');
      return;
    }
    if (data.ok && typeof data.html === 'string') {
      const parent = el.parentNode;
      el.replaceWith(document.createTextNode(data.html));
      if (parent) parent.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (data.code === 'PIN_REQUIRED' || data.code === 'PIN_INVALID') {
      alert('PIN 확인이 필요합니다. 다시 시도해주세요.');
    } else {
      alert('잠금 해제 실패: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (e) {
    alert('잠금 해제 실패: ' + e.message);
  }
}

async function openPane(id) {
  id = Number(id);
  if (typeof window._debugPane === 'undefined') window._debugPane = [];
  window._debugPane.push('openPane called: ' + id);
  if (document.querySelector(`.pane[data-pane="${id}"]`)) return;
  let cached = memoCache[id];
  // 79차: 캐시에 없으면 서버에서 직접 조회
  // 82차: credentials 추가로 인증 쿠키 포함
  // 트랙 2: 잠긴 메모는 목록 캐시의 본문이 비어 있을 수 있어(body_protected)
  // 항상 단건 조회를 거친다 — 게이트 403이면 _fetchStepUp이 PIN 모달로 잇는다.
  if (!cached || cached.is_locked) {
    try {
      const res = await window._fetchStepUp(`/api/memo/${id}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        const fresh = data.memo || data;
        if (fresh && fresh.id) {
          cached = fresh;
          memoCache[id] = fresh;
        }
      } else if (cached && cached.body_protected) {
        // step-up 거부/취소 — 본문 없는 팬을 열지 않는다
        return;
      }
    } catch (e) { console.warn('메모 조회 실패:', e); }
  }
  if (!cached) return;
  let fileMap = memoFileMap[id];
  if (!fileMap && cached.file_count) {
    try {
      const files = await fetch(`/api/memo/${id}/files`).then(r => r.json());
      fileMap = {};
      files.forEach(f => { fileMap[f.id] = f; });
      memoFileMap[id] = fileMap;
    } catch (e) { console.warn('메모 파일 목록 조회 실패:', e); fileMap = {}; }
  }
  fileMap = fileMap || {};
  const panes = $('panes');
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.pane = id;
  pane.innerHTML = `
    <div class="pane-head">
      <span class="date"></span>
      <span class="pane-actions"></span>
    </div>
    <div class="pane-view"></div>
    <div class="pane-edit" hidden></div>
    <div class="pane-files"></div>`;
  panes.appendChild(pane);
  const viewEl = pane.querySelector('.pane-view');
  const editEl = pane.querySelector('.pane-edit');
  const actionsEl = pane.querySelector('.pane-actions');
  const dateEl = pane.querySelector('.pane-head .date');
  let editor = null, rich = null;

  function refreshHead() {
    const c = memoCache[id];
    if (!c) return;
    dateEl.innerHTML = esc(fmtDate(c.created_at)) + (c.file_count ? ' · <i data-lucide="paperclip" class="ic-xs"></i> ' + c.file_count : '');
  }
  function showView(targetPane) {
    const p = targetPane || pane;
    const pActionsEl = p.querySelector('.pane-actions');
    const pViewEl = p.querySelector('.pane-view');
    const pEditEl = p.querySelector('.pane-edit');
    const pDateEl = p.querySelector('.pane-head .date');
    pEditEl.hidden = true;
    pViewEl.hidden = false;
    const isLocked = memoCache[id]?.is_locked ? true : false;
    pActionsEl.innerHTML = `
      ${isLocked ? '<span class="pane-lock-ind" title="AI 접근 잠김"><i data-lucide="lock"></i></span>' : ''}
      <button data-act="edit" title="수정" aria-label="수정"><i data-lucide="pencil"></i></button>
      <button data-act="del" class="danger" title="삭제" aria-label="삭제" onclick="window._deleteMemo(this)"><i data-lucide="trash-2"></i></button>
      <button data-act="close" title="닫기" aria-label="닫기"><i data-lucide="x"></i></button>`;
    wireActions(p);
    refreshIcons();
    const c = memoCache[id];
    const fm = memoFileMap[id] || {};
    pViewEl.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'md pane-body';
    body.innerHTML = renderBodyHtml(c.text, fm, '');
    // 모든 링크는 새탭에서 열기
    body.querySelectorAll('a[href]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
    body.querySelectorAll('img[data-full]').forEach(img => {
      img.style.cursor = 'default';
      img.onclick = null;
      img.addEventListener('mouseenter', () => showImgTools(img));
    });
    // 잠긴 블록 플레이스홀더 (보기 모드): 클릭 → step-up 해제 → 본문 마커를
    // 복호문으로 되돌려 저장하고 다시 그린다 (UI-003, 트랙 D).
    body.querySelectorAll('.locked-block').forEach(el => {
      el.addEventListener('click', async () => {
        const blockId = el.getAttribute('data-block-id');
        if (!blockId) return;
        if (!await window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')) return;
        try {
          const { data } = await requestUnlockBlock(id, blockId);
          if (data.ok && data.warning === 'unlock_pending') {
            // 부분 성공(복호문 수신·암호문 DB 잔류): 마커를 평문으로 교체해
            // 저장하면 blockId가 사라져 암호문 사본이 고아가 된다.
            // 마커를 유지하고 보류를 알린다 (재클릭으로 재시도 가능).
            alert('서버에서 암호문 블록을 제거하지 못해 해제를 보류했어요.\n블록은 잠긴 상태로 유지됩니다. 다시 시도해주세요.');
            return;
          }
          if (!data.ok || typeof data.html !== 'string') {
            if (data.code !== 'PIN_REQUIRED' && data.code !== 'PIN_INVALID') {
              alert('잠금 해제 실패: ' + (data.error || '알 수 없는 오류'));
            }
            return;
          }
          const cur = memoCache[id];
          if (!cur) return;
          const markerRe = new RegExp('\\\\?\\[LOCKED_BLOCK:' + blockId + '\\\\?\\]');
          const newText = String(cur.text || '').replace(markerRe, () => data.html);
          const putRes = await window._fetchStepUp('/api/memo/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: newText })
          });
          if (!putRes.ok) { alert('잠금은 해제됐지만 본문 반영에 실패했습니다.'); return; }
          cur.text = newText;
          if (typeof memoTexts !== 'undefined') memoTexts[id] = newText;
          showView(p);
        } catch (e) {
          alert('잠금 해제 실패: ' + e.message);
        }
      });
    });
    viewEl.appendChild(body);
    renderPaneFiles(pane, id, fm, false);
    refreshHead();
  }
  function showEdit() {
    viewEl.hidden = true;
    editEl.hidden = false;
    window.currentEditingMemoId = id;
    const memoForEdit = memoCache[id];
    if (memoForEdit) memoForEdit._pendingLock = !!memoForEdit.is_locked;
    const isLockedEdit = memoForEdit?.is_locked ? true : false;
    actionsEl.innerHTML = `
      <button data-act="lock" title="${isLockedEdit ? 'AI 접근 잠김 (클릭하여 해제)' : 'AI 접근 허용 (클릭하여 잠금)'}" aria-label="잠금"><i data-lucide="${isLockedEdit ? 'lock' : 'lock-open'}"></i></button>
      <button data-act="save" title="저장 (⌘/Ctrl+Enter)" aria-label="저장"><i data-lucide="save"></i></button>
      <button data-act="cancel" title="취소" aria-label="취소"><i data-lucide="x"></i></button>`;
    wireActions();
    refreshIcons();
    if (!editor) {
      const titleInput = document.createElement('input');
      titleInput.className = 'title-input';
      titleInput.placeholder = '제목';
      titleInput.autocomplete = 'off';
      titleInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          pane.querySelector('[data-act="save"]').click();
        }
      });
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar hidden';
      rich = document.createElement('div');
      rich.className = 'rich';
      rich.contentEditable = 'true';
      rich.setAttribute('role', 'textbox');
      editor = wireEditor(rich, toolbar, true);
      editor.titleInput = titleInput;
      const chips = document.createElement('div');
      chips.className = 'pending';
      editor.chipsBox = chips;
      // 파일 첨부 진입점: 새 메모 컴포저에는 #files 입력이 있지만 기존 메모
      // 편집(pane)에는 붙여넣기·드래그드롭 외에 파일을 고르는 경로가 없었다
      // (누락 — otherFiles 칩·저장 시 업로드 등 하위 배선은 전부 살아 있었다).
      // inedit와 같은 .editor-row/.mini-file-btn 패턴으로 일반 파일 첨부를 연다.
      const attachRow = document.createElement('div');
      attachRow.className = 'editor-row';
      const attachBtn = document.createElement('label');
      attachBtn.className = 'mini-file-btn';
      attachBtn.title = '파일 첨부';
      attachBtn.setAttribute('aria-label', '파일 첨부');
      attachBtn.innerHTML = '<i data-lucide="paperclip"></i>';
      const attachInput = document.createElement('input');
      attachInput.type = 'file';
      attachInput.multiple = true;
      attachInput.setAttribute('aria-label', '파일 첨부');
      attachInput.addEventListener('change', () => { handleEditorFiles(editor, attachInput.files); attachInput.value = ''; });
      attachBtn.appendChild(attachInput);
      attachRow.appendChild(attachBtn);
      editEl.append(titleInput, toolbar, rich, chips, attachRow);
      rich.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          pane.querySelector('[data-act="save"]').click();
        }
      });
    }
    const fm = memoFileMap[id] || {};
    try {
      const memoText = (memoCache[id] && memoCache[id].text) || '';
      const { title, body } = extractTitle(memoText);
      editor.titleInput.value = title || '';
      rich.innerHTML = mdToEditable(body || '', fm) || '';
    } catch (e) {
      console.error('편집 내용 로드 실패:', e);
      rich.innerHTML = '<p>내용을 불러오지 못했습니다.</p>';
    }
    // 저장돼 있던 잠긴 블록 플레이스홀더에도 해제 클릭을 연결한다 (UI-003)
    rich.querySelectorAll('.locked-block').forEach(el => {
      el.addEventListener('click', () => { unlockLockedBlockEl(el, id); });
    });
    applyTableWidths(rich);
    renderPaneFiles(pane, id, fm, true);
    refreshIcons();
    rich.focus();
  }
  function wireActions(targetPane) {
    const waPane = targetPane || pane;
    const waActionsEl = waPane.querySelector('.pane-actions');
    const q = (a) => waActionsEl.querySelector(`[data-act="${a}"]`);
    // 보기 모드에서는 lock 토글 없음 (편집 모드에서만)
    // 단, 편집 모드의 lock 버튼은 아래에서 처리
    const lb = q('lock');
    if (lb && actionsEl.querySelector('[data-act="save"]')) {
      // 편집 모드: 토글 시 UI만 변경, 저장은 save 버튼에서
      lb.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      lb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const memo = memoCache[id];
        if (!memo) return;
        // pending 상태로 저장 (실제 저장은 save 버튼에서)
        const newLocked = !memo._pendingLock;
        memo._pendingLock = newLocked;
        lb.innerHTML = `<i data-lucide="${newLocked ? 'lock' : 'lock-open'}"></i>`;
        lb.title = newLocked ? 'AI 접근 잠김 (클릭하여 해제)' : 'AI 접근 허용 (클릭하여 잠금)';
        lb.classList.toggle('active', newLocked);
        refreshIcons();
        return false;
      });
    }
    const eb = q('edit');
    if (eb) { eb.addEventListener('mousedown', (e) => e.preventDefault()); eb.onclick = showEdit; }
    const sb = q('save');
    if (sb) {
      sb.addEventListener('mousedown', (e) => e.preventDefault());
      sb.onclick = async () => {
        // pending된 lock 상태가 있으면 먼저 저장
        const memo = memoCache[id];
        if (memo && memo._pendingLock !== undefined) {
          try {
            const lockRes = await fetchLockWithPin('/api/memo/' + id + '/lock', { locked: memo._pendingLock });
            // HTTP 오류(예: 암호화 실패 500)면 본문 저장을 중단한다 —
            // 실패를 삼키고 PUT을 진행하면 잠금 상태와 본문이 어긋난다.
            if (!lockRes.ok) {
              alert('잠금 설정 실패');
              return;
            }
            memo.is_locked = memo._pendingLock ? 1 : 0;
            delete memo._pendingLock;
          } catch (err) {
            alert('잠금 설정 실패');
            return;
          }
        }
        await savePane(id, pane, editor, rich);
        showView();
      };
    }
    const cb = q('cancel');
    if (cb) { cb.addEventListener('mousedown', (e) => e.preventDefault()); cb.onclick = () => {
      const p = waPane;
      const vEl = p.querySelector('.pane-view');
      const eEl = p.querySelector('.pane-edit');
      if (vEl) vEl.hidden = false;
      if (eEl) eEl.hidden = true;
      // view 모드 버튼으로 복원
      try { showView(p); } catch (e) { console.warn('showView 실패:', e); }
    }; }
    // 삭제 버튼은 HTML의 onclick="window._deleteMemo(this)" 사용 (커스텀 모달)
    // wireActions()에서 덮어쓰지 않음
    const xb = q('close');
    if (xb) { xb.addEventListener('mousedown', (e) => e.preventDefault()); xb.onclick = () => {
      if (typeof closePane === 'function') { try { closePane(id); } catch (e) { console.warn('closePane 실패:', e); } }
    }; }
  }
  showView(pane);
  wireActions(pane);
  updatePanesVisibility();
}
// 팬 하단: 첨부 파일 목록 (마커 없는 이미지 + 일반 파일)
function renderPaneFiles(pane, memoId, fileMap, isEditMode) {
  const sec = pane.querySelector('.pane-files');
  if (!sec) return;
  sec.innerHTML = '';
  const files = Object.values(fileMap);
  if (!files.length) return;
  const refIds = markerIds(memoCache[memoId] ? memoCache[memoId].text : '');
  const imgBox = document.createElement('div');
  imgBox.className = 'imgs';
  const fileBox = document.createElement('div');
  fileBox.className = 'files';
  const gridImgs = files.filter(f => isImage(f.mime, f.filename) && !refIds.has(f.id));
  if (gridImgs.length === 1) imgBox.classList.add('single');
  gridImgs.forEach(f => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', '이미지 크게 보기');
    const img = document.createElement('img');
    // 잠긴 파일은 worker 경유 URL 사용
    const imgUrl = f.is_locked ? '/api/memo/files/' + f.id + '/content' : (f.thumb || f.url);
    img.src = imgUrl;
    img.loading = 'lazy';
    img.alt = f.filename;
    img.setAttribute('data-full', imgUrl);
    img.setAttribute('data-fid', f.id);
    b.appendChild(img);
    // 잠긴 이미지 표시
    if (f.is_locked) {
      const badge = document.createElement('span');
      badge.innerHTML = '<i data-lucide="lock"></i>';
      badge.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);color:white;padding:2px 6px;border-radius:4px;font-size:12px;';
      badge.title = '잠긴 이미지';
      b.style.position = 'relative';
      b.appendChild(badge);
    }
    b.onclick = () => openLightboxFromCard(pane, img);
    imgBox.appendChild(b);
  });
  imgBox.querySelectorAll('img[data-full]').forEach(img => {
    img.addEventListener('mouseenter', () => showImgTools(img));
  });
  files.filter(f => !isImage(f.mime, f.filename)).forEach(f => {
    const wrap = document.createElement('span');
    wrap.className = 'file-chip';
    const open = document.createElement('a');
    open.href = '#';
    open.innerHTML = `<span><i data-lucide="${fileIcon(f.filename)}"></i></span><span class="name">${esc(f.filename)}</span><span class="size">${fmtSize(f.size)}</span>`;
    open.onclick = async (e) => {
      e.preventDefault();
      // 잠긴 파일은 f.url(암호문 Cloudinary URL)을 직접 받으면 암호문 파일이
      // 내려간다 — 복호화 서빙 경로(/content)로 받아야 원본이 내려간다 (트랙 D).
      const srcUrl = f.is_locked ? '/api/memo/files/' + f.id + '/content' : f.url;
      try {
        // 잠긴 파일은 보호 게이트 대상 — 403이면 PIN 모달 후 재시도한다.
        const resp = f.is_locked ? await window._fetchStepUp(srcUrl) : await fetch(srcUrl);
        if (!resp.ok) throw new Error('download_failed');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        // 잠긴 파일은 게이트 403 페이지를 새 탭으로 여는 폴백이 무의미하다.
        if (f.is_locked) { alert('파일을 열 수 없어요. PIN 확인이 필요합니다.'); return; }
        window.open(srcUrl, '_blank');
      }
    };
    const del = document.createElement('button');
    del.className = 'fdel';
    del.innerHTML = '<i data-lucide="x"></i>';
    del.setAttribute('aria-label', '파일 삭제');
    del.onclick = async () => {
      if (!confirm('파일을 삭제할까요?')) return;
      await window._fetchStepUp('/api/memo/files/' + f.id, { method: 'DELETE' });
      delete memoFileMap[memoId][f.id];
      renderPaneFiles(pane, memoId, memoFileMap[memoId], isEditMode);
      load();
    };
    // 파일 잠금 버튼
    const lockBtn = document.createElement('button');
    lockBtn.className = 'flock';
    lockBtn.innerHTML = `<i data-lucide="${f.is_locked ? 'lock' : 'lock-open'}"></i>`;
    lockBtn.setAttribute('aria-label', f.is_locked ? '파일 잠금 해제' : '파일 잠금');
    lockBtn.title = f.is_locked ? '잠금 해제 (클릭)' : '잠금 (클릭)';
    if (f.is_locked) lockBtn.style.color = 'var(--dim)';
    lockBtn.onclick = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const newLocked = !f.is_locked;
      try {
        lockBtn.disabled = true;
        const res = await fetchLockWithPin('/api/memo/files/' + f.id + '/lock', { locked: newLocked });
        const data = await res.json();
        if (data.ok) {
          f.is_locked = newLocked;
          // 파일 URL 업데이트 (잠긴 파일은 worker 경유)
          if (newLocked) {
            f.url = '/api/memo/files/' + f.id + '/content';
          }
          renderPaneFiles(pane, memoId, memoFileMap[memoId], isEditMode);
        } else if (data.error === 'migration_needed') {
          alert('D1 마이그레이션 필요: ' + data.message);
        } else {
          alert('파일 잠금 실패');
        }
      } catch (err) {
        alert('파일 잠금 실패: ' + err.message);
      } finally {
        lockBtn.disabled = false;
      }
    };
    if (isEditMode) wrap.append(open, lockBtn, del);
    else {
      // 보기 모드에서도 잠긴 파일 표시
      if (f.is_locked) {
        const lockIcon = document.createElement('span');
        lockIcon.innerHTML = '<i data-lucide="lock"></i>';
        lockIcon.style.cssText = 'color:var(--dim);margin-left:4px;';
        lockIcon.title = '잠긴 파일';
        wrap.appendChild(lockIcon);
      }
      wrap.append(open);
    }
    fileBox.appendChild(wrap);
  });
  sec.append(imgBox, fileBox);

  refreshIcons();}
async function savePane(id, pane, editor, rich) {
  const pTitle = (editor.titleInput ? editor.titleInput.value : '').trim();
  if (!pTitle && editorIsEmpty(editor)) return;
  const btn = pane.querySelector('[data-act="save"]');
  const oldText = memoTexts[id] || '';
  btn.disabled = true;
  try {
    const { markdown: bodyMd, pendings } = serializeEditor(editor);
    const markdown = pTitle ? '# ' + pTitle + (bodyMd ? '\n\n' + bodyMd : '') : bodyMd;
    let finalText = markdown;
    if (pendings.length) {
      const files = await uploadPendings(id, pendings);
      finalText = applyFileIds(markdown, files);
    }
    if (editor.otherFiles.length) await uploadPendings(id, editor.otherFiles);
    const putRes = await window._fetchStepUp('/api/memo/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: finalText }),
    });
    if (!putRes.ok) { toast('저장에 실패했어요'); return; }
    await cleanupOrphanFiles(oldText, finalText);
    hideImgResize();
    hideImgTools();
    editor.blobMap.clear();
    editor.otherFiles = [];
    refreshOtherFiles(editor);
    // 파일맵 새로고침 후 팬 내용 갱신
    let files = [];
    try { files = await fetch(`/api/memo/${id}/files`).then(r => r.json()); } catch (e) { console.warn('메모 파일 목록 조회 실패:', e); }
    const fm = {};
    files.forEach(f => { fm[f.id] = f; });
    memoFileMap[id] = fm;
    if (memoCache[id]) {
      memoCache[id] = { ...memoCache[id], text: finalText, file_count: files.length };
      memoTexts[id] = finalText;
    }
    rich.innerHTML = mdToEditable(finalText, fm);
    applyTableWidths(rich);
    renderPaneFiles(pane, id, fm, false);
    const head = pane.querySelector('.pane-head .date');
    if (head) head.innerHTML = esc(fmtDate(memoCache[id].created_at)) + (files.length ? ' · <i data-lucide="paperclip" class="ic-xs"></i> ' + files.length : '');
    loadTags();
    load();
    renderCal();
    toast('저장했어요');
  } finally {
    btn.disabled = false;
  }
}

$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 300); });
// 전역 삭제 함수 (동적 버튼용)
window._deleteMemo = async function(btn) {
  const pane = btn.closest('.pane');
  const id = pane ? pane.dataset.pane : null;
  if (!id) { alert('메모 ID를 찾을 수 없어요'); return; }
  // 커스텀 확인 모달 (자동화 테스트 가능)
  if (!await window._confirmDelete('이 메모를 삭제할까요?')) return;
  try {
    const res = await window._fetchStepUp('/api/memo/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('삭제 실패: ' + res.status);
  } catch (err) {
    alert('삭제에 실패했어요: ' + err.message);
    return;
  }
  if (typeof cachedMemos !== 'undefined') cachedMemos = cachedMemos.filter(m => m.id != id);
  if (typeof closePane === 'function') closePane(id);
  else if (pane) pane.remove();
  if (typeof renderRows === 'function' && typeof cachedMemos !== 'undefined') {
    renderRows(cachedMemos);
  } else {
    location.reload();
  }
};

// 잠금 해제 step-up용 PIN 입력 모달 (서버가 PIN을 요구할 때만 뜬다)
window._promptPin = function(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p>${msg}</p>
        <input type="password" inputmode="numeric" autocomplete="off" maxlength="6" class="pin-prompt-input" placeholder="PIN 6자리" style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:16px;font-size:16px;text-align:center;letter-spacing:6px;">
        <div class="confirm-btns">
          <button class="confirm-no">취소</button>
          <button class="confirm-yes">확인</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.pin-prompt-input');
    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6); });
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.confirm-no').onclick = () => done(null);
    overlay.querySelector('.confirm-yes').onclick = () => done(input.value || null);
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value || null); });
    input.focus();
  });
};

// 잠금 토글 fetch + step-up 재시도: 해제 요청이 403 PIN_REQUIRED/PIN_INVALID로
// 거부되면 PIN을 입력받아 1회만 재시도한다. PIN 미설정 계정은 서버가 그대로
// 허용하므로 모달이 뜨지 않는다. 잠금 요청은 서버가 PIN을 요구하지 않는다.
async function fetchLockWithPin(url, bodyObj) {
  const send = (b) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b)
  });
  let res = await send(bodyObj);
  if (res.status === 403) {
    let data = null;
    try { data = await res.clone().json(); } catch (e) { console.warn('잠금 해제 응답 파싱 실패:', e); }
    if (data && (data.code === 'PIN_REQUIRED' || data.code === 'PIN_INVALID')) {
      const pin = await window._promptPin(data.code === 'PIN_INVALID'
        ? 'PIN이 올바르지 않아요. 다시 입력하세요.'
        : '잠금 해제를 위해 PIN을 입력하세요.');
      if (pin) res = await send({ ...bodyObj, pin });
    }
  }
  return res;
}

// 보호 메모 step-up (트랙 2): 서버 게이트가 403 STEP_UP_REQUIRED를 돌려주면
// PIN 모달 → POST /api/auth/step-up (5분 창 발급) → 원래 요청 1회 재시도.
// PIN_INVALID면 모달을 다시 띄운다. 사용자가 취소하면 원래 403 응답을 그대로
// 돌려주므로 호출자는 기존 실패 처리로 떨어진다.
window._stepUpWithPin = async function(msg) {
  const pin = await window._promptPin(msg || '보호된 메모예요. PIN을 입력하세요.');
  if (!pin) return false;
  let data = null;
  try {
    const res = await fetch('/api/auth/step-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    if (res.ok) return true;
    data = await res.json().catch(() => null);
  } catch (e) { console.warn('step-up 요청 실패:', e); return false; }
  if (data && data.code === 'PIN_INVALID') {
    return window._stepUpWithPin('PIN이 올바르지 않아요. 다시 입력하세요.');
  }
  return false;
};

window._fetchStepUp = async function(url, opts) {
  let res = await fetch(url, opts);
  if (res.status === 403) {
    let data = null;
    try { data = await res.clone().json(); } catch (e) { data = null; } // JSON 아님 — 게이트 아님
    if (data && data.code === 'STEP_UP_REQUIRED') {
      if (await window._stepUpWithPin()) res = await fetch(url, opts);
    }
  }
  return res;
};

// 커스텀 확인 모달 (네이티브 confirm 대체 — 자동화 테스트 가능)
// 네이티브 confirm()은 자동화 브라우저가 다이얼로그를 자동 닫기 때문에,
// 그것을 관문으로 쓰는 흐름은 검증 환경에서 조용히 죽는다 (블록 해제가
// 실제로 그랬다 — UI-003 후속 QA). 보안 흐름의 확인은 반드시 이 모달로 받는다.
window._confirmAction = function(msg, yesLabel, danger) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p>${msg}</p>
        <div class="confirm-btns">
          <button class="confirm-no">취소</button>
          <button class="confirm-yes${danger ? ' danger' : ''}">${yesLabel || '확인'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.confirm-no').onclick = () => done(false);
    overlay.querySelector('.confirm-yes').onclick = () => done(true);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
  });
};

window._confirmDelete = function(msg) {
  return window._confirmAction(msg, '삭제', true);
};

// 모바일용: 메모를 바로 편집 모드로 열기
window.openPaneForEdit = function(id) {
  // 데스크톱 pane 시스템 사용
  if (typeof selectMemo === 'function') {
    selectMemo(id);
    setTimeout(function() {
      var pane = document.querySelector('.pane[data-pane="' + id + '"]');
      if (pane) {
        // 모바일에서는 pane을 모달로 표시
        pane.classList.add('mobile-modal');
        var eb = pane.querySelector('[data-act="edit"]');
        if (eb) eb.click();
      }
    }, 150);
  }
};

// 71차: 위젯에서 호출할 수 있도록 window에 노출
window.openPane = openPane;

/* ================= 11. 시작 ================= */
initCal();
updateLayoutMode();
$('pgPrev').onclick = () => { if (page > 0) { page--; renderRows(cachedMemos); } };
$('pgNext').onclick = () => { page++; renderRows(cachedMemos); };
loadTags();
load();
