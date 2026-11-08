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
