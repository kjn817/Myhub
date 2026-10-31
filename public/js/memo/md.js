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
