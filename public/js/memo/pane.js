// pane.js에서 분리 (2026-11-01 단일 파일 분해): 등 하단 첨부 파일 목록 렌더링만.
// memo-bundle.js로 함께 번호순으로 위임 함수 공유 방식과 기존과 동일하다.

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
        if (f.is_locked) { toast('파일이 열 수 없어요. PIN 확인이 필요합니다.'); return; }
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
          toast(friendlyError(data, '데이터 준비가 아직 끝나지 않았어요. 잠시 후 다시 시도해 주세요.'));
        } else {
          toast('파일 잠금 실패');
        }
      } catch (err) {
        toast('파일 잠금 실패: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.'));
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

/* 창 반 제목 게시 (myhub:doc-title, 단축 H): 제목은 등 이름이 아닌
   문서 이름이라는 HIG 규칙 등 애플 메모 중 가장 최근 주의 제목은 창
   제목줄에 뿐. 사이 없으면 name=null로 모듈 제목('메모')는
   파악한다. 잠긴 메모는 본문 텍스트가 비어 있어 '제목 없음'으로만
   게시한다 (제목은 지배하지 않는다). */
function notifyMemoDocTitle() {
  try {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
    const panes = document.querySelectorAll('.pane[data-pane]');
    let name = null;
    if (panes.length) {
      const id = Number(panes[panes.length - 1].dataset.pane);
      const text = (typeof memoTexts !== 'undefined' && memoTexts[id])
        || (typeof memoCache !== 'undefined' && memoCache[id] && memoCache[id].text) || '';
      name = extractTitle(text).title || '제목 없음';
    }
    window.parent.postMessage({ type: 'myhub:doc-title', name, dirty: false }, window.location.origin);
  } catch (e) { console.warn('메모 제목 동기 실패:', e); }
}
window.notifyMemoDocTitle = notifyMemoDocTitle;

/* 보여줄 모드 잠금 메뉴 적용 (I-03): 기존 lock/sensitivity API를 그대로 낸다.
   잠금 해제는 fetchLockWithPin의 PIN step-up을 대행하므로 기존 편집 모드
   잠금 버튼·step-up 동작과 동일하다. 성공 시에만 캐시를 갱신한다. */
async function setMemoLockFromView(id, locked) {
  const res = await fetchLockWithPin('/api/memo/' + id + '/lock', { locked: !!locked });
  if (!res.ok) return false;
  if (memoCache[id]) memoCache[id].is_locked = locked ? 1 : 0;
  return true;
}
async function setMemoSensitivityFromView(id, sensitivity) {
  const res = await fetch('/api/memo/' + id + '/sensitivity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sensitivity }),
  });
  if (!res.ok) return false;
  if (memoCache[id]) memoCache[id].sensitivity = sensitivity;
  return true;
}

async function openPane(id) {
  id = Number(id);
  if (document.querySelector(`.pane[data-pane="${id}"]`)) return;
  let cached = memoCache[id];
  // 79차: 캐시가 없으면 서버에서 직접 조회
  // 82차: credentials 추가로 넣을 쿠키 포함
  // 단축 2: 잠긴 메모는 목록 캐시가 본문이 비어 있을 수 있어(body_protected)
  // 정상 권한 조회가 건너뛴 등 게이트 403이면 _fetchStepUp의 PIN 모달로 넘는다.
  if (!cached || cached.is_locked) {
    try {
      const res = await window._fetchStepUp(`/api/memo/${id}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        const fresh = data.memo || data;
        if (fresh && fresh.id) {
          // 권한 GET 응답에는 sensitivity가 없다 등 목록 캐시가 가진 값을
          // 보존해야 잠금 메모가 현재 민감도대로 올바르게 표시한다 (I-03).
          if (typeof fresh.sensitivity !== 'number' && cached && typeof cached.sensitivity === 'number') {
            fresh.sensitivity = cached.sensitivity;
          }
          cached = fresh;
          memoCache[id] = fresh;
        }
      } else if (cached && cached.body_protected) {
        // step-up 거부/취소 등 본문 없는 사유 내지 않는다
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
    dateEl.innerHTML = esc(fmtDate(c.created_at)) + (c.file_count ? ' 쨌 <i data-lucide="paperclip" class="ic-xs"></i> ' + c.file_count : '');
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
      ${isLocked ? '<span class="pane-lock-ind" title="AI 접근 잠금"><i data-lucide="lock"></i></span>' : ''}
      <span class="myhub-lock-slot" data-act="lockmenu"></span>
      ${isLocked ? '' : '<button data-act="tags" title="AI 태그 적용" aria-label="AI 태그 적용"><i data-lucide="tags"></i></button>'}
      <button data-act="edit" title="수정" aria-label="수정"><i data-lucide="pencil"></i></button>
      <button data-act="del" class="danger" title="삭제" aria-label="삭제" onclick="window._deleteMemo(this)"><i data-lucide="trash-2"></i></button>
      <button data-act="close" title="닫기" aria-label="닫기"><i data-lucide="x"></i></button>`;
    wireActions(p);
    refreshIcons();
    wireLockMenu(p);
    wireTagSuggest(p);
    const c = memoCache[id];
    const fm = memoFileMap[id] || {};
    pViewEl.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'md pane-body';
    body.innerHTML = renderBodyHtml(c.text, fm, '');
    // 모든 마크가 트리에서 숨김
    body.querySelectorAll('a[href]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
    body.querySelectorAll('img[data-full]').forEach(img => {
      img.style.cursor = 'default';
      img.onclick = null;
      img.addEventListener('mouseenter', () => showImgTools(img));
    });
    // 이미지 캡션 (E4): alt가 파일명뿐인('이미지')가 아닌 경우에만
    // figure 캡션으로 표시한다 (캡션은 alt 편집으로 저장된 값).
    body.querySelectorAll('img[data-full]').forEach(img => {
      const alt = (img.getAttribute('alt') || '').trim();
      const fid = img.getAttribute('data-fid');
      const f = fid ? fm[fid] : null;
      if (!alt || alt === '이미지' || (f && alt === f.filename)) return;
      const fig = document.createElement('figure');
      fig.className = 'img-figure';
      const cap = document.createElement('figcaption');
      cap.textContent = alt;
      img.replaceWith(fig);
      fig.append(img, cap);
    });
    // 잠긴 블록 플레이스홀더 (보여줄 모드): 내부 등 step-up 해제 등 본문 마지막을
    // 복호문으로 되돌린 만들고 다시 그린다 (UI-003, 단축 D).
    body.querySelectorAll('.locked-block').forEach(el => {
      el.addEventListener('click', async () => {
        const blockId = el.getAttribute('data-block-id');
        if (!blockId) return;
        if (!await window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')) return;
        try {
          const { data } = await requestUnlockBlock(id, blockId);
          if (data.ok && data.warning === 'unlock_pending') {
            // 부분 성공(복호문 수신·암호문 DB 삭제): 마지막을 빈칸으로 교체해
            // 만들면 blockId가 들어온 암호문 원본이 있는가 한다.
            // 마지막을 허용하고 보류를 남김 (클릭으로 다시 가능).
            toast('서버에서 암호문 블록을 제거하지 못해 해제를 보류했어요.\n블록은 잠긴 상태로 유지됩니다. 다시 시도해주세요.');
            return;
          }
          if (!data.ok || typeof data.html !== 'string') {
            if (data.code !== 'PIN_REQUIRED' && data.code !== 'PIN_INVALID') {
              toast('잠금 해제 실패: ' + friendlyError(data, '잠시 후 다시 시도해 주세요.'));
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
          if (!putRes.ok) { toast('잠금은 해제했지만 본문 반영이 실패했어요.'); return; }
          cur.text = newText;
          if (typeof memoTexts !== 'undefined') memoTexts[id] = newText;
          showView(p);
        } catch (e) {
          toast('잠금 해제 실패: ' + friendlyError(e, '잠시 후 다시 시도해 주세요.'));
        }
      });
    });
    viewEl.appendChild(body);
    // 태그 적용 칩이 붙을 자리 (AI 태그 적용 버튼이 채워짐)
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-suggest';
    tagRow.hidden = true;
    pViewEl.appendChild(tagRow);
    // 보여줄 오류 체크리스트 잠금 (E3 구성)
    wireViewChecklist(body, id, () => showView(p));
    renderPaneFiles(pane, id, fm, false);
    refreshHead();
  }
  // 보여줄 모드 잠금 메뉴 (I-03): 레벨 넣는 "잠금" 메뉴로 메모 잠금·민감도를
  // 즉시 적용한다. 편집 모드의 아이콘 잠금 버튼(_pendingLock)과는 경로가
  // 들어 충돌하지 않는 등 보여줄에서 바꿔 상태는 memoCache에 반영해
  // 편집 진입 등 showEdit의 그 값을 읽는다.
  function wireLockMenu(targetPane) {
    const p = targetPane || pane;
    const slot = p.querySelector('[data-act="lockmenu"]');
    if (!slot || typeof buildMemoLockMenu !== 'function') return;
    const c = memoCache[id];
    if (!c) return;
    const menu = buildMemoLockMenu({
      state: { locked: !!c.is_locked, sensitivity: typeof c.sensitivity === 'number' ? c.sensitivity : 1 },
      onChange: async (next, key) => {
        try {
          const ok = key === 'locked'
            ? await setMemoLockFromView(id, next.locked)
            : await setMemoSensitivityFromView(id, next.sensitivity);
          if (!ok) { toast('잠금 설정이 실패했어요'); return false; }
        } catch (e) {
          console.warn('잠금 설정 실패:', e);
          toast('잠금 설정이 실패했어요');
          return false;
        }
        toast(key === 'locked'
          ? (next.locked ? '메모를 잠갔어요' : '잠금을 해제했어요')
          : '민감도 ' + memoSensitivityLabel(next.sensitivity) + '(으)로 바꿨어요');
        // 잠금 표시·태그 버튼 호출 등 보여줄 코드가 상태에 따라 달라지므로
        // 다시 그린다 (메뉴의 등 상태로 구축된다).
        showView(p);
        return true;
      },
    });
    slot.innerHTML = '';
    slot.appendChild(menu);
    refreshIcons();
  }
  // AI 태그 적용 (범위 3-3): 적용만 생기고, 적용한 사용자가 칩을 눌러
  // 확정한다 (자동 적용 금지). 잠긴 메모에는 버튼 자체가 없다.
  function wireTagSuggest(targetPane) {
    const p = targetPane || pane;
    const btn = p.querySelector('[data-act="tags"]');
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', async () => {
      const row = p.querySelector('.tag-suggest');
      if (!row) return;
      if (!row.hidden) { row.hidden = true; return; }
      btn.disabled = true;
      try {
        const res = await fetch('/api/memo/' + id + '/tag-suggestions', { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) { toast('잠긴 메모에서는 태그 적용이 안 돼 요'); return; }
        if (!data.tags || !data.tags.length) { toast('적용한 태그가 없어요'); return; }
        row.innerHTML = '';
        const label = document.createElement('span');
        label.className = 'tag-suggest-label';
        label.textContent = 'AI 태그 적용 등 눌러서 크기';
        row.appendChild(label);
        data.tags.forEach(tag => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'tag';
          chip.textContent = '#' + tag;
          chip.addEventListener('click', async () => {
            const cur = memoCache[id];
            if (!cur || cur.is_locked) return;
            const newText = String(cur.text || '').replace(/\s+$/, '') + '\n\n#' + tag;
            try {
              const putRes = await window._fetchStepUp('/api/memo/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newText }),
              });
              if (!putRes.ok) { toast('태그 내용에 실패했어요'); return; }
              cur.text = newText;
              if (typeof memoTexts !== 'undefined') memoTexts[id] = newText;
              chip.remove();
              loadTags();
              toast('태그를 복사했어요');
            } catch (e) {
              console.warn('태그 복사 실패:', e);
              toast('태그 내용에 실패했어요');
            }
          });
          row.appendChild(chip);
        });
        row.hidden = false;
      } catch (e) {
        console.warn('태그 적용 실패:', e);
        toast('태그 적용을 가져오지 못했어요');
      } finally {
        btn.disabled = false;
      }
    });
  }
  function showEdit() {
    viewEl.hidden = true;
    editEl.hidden = false;
    window.currentEditingMemoId = id;
    const memoForEdit = memoCache[id];
    if (memoForEdit) memoForEdit._pendingLock = !!memoForEdit.is_locked;
    const isLockedEdit = memoForEdit?.is_locked ? true : false;
    actionsEl.innerHTML = `
      <button data-act="lock" title="${isLockedEdit ? 'AI 접근 잠금 (내부에서 해제)' : 'AI 접근 허용 (내부에서 잠금)'}" aria-label="잠금"><i data-lucide="${isLockedEdit ? 'lock' : 'lock-open'}"></i></button>
      <button data-act="save" title="저장 (단축/Ctrl+Enter)" aria-label="저장"><i data-lucide="save"></i></button>
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
      editor = wireEditor(rich, toolbar, true, { memoId: id });
      editor.titleInput = titleInput;
      const chips = document.createElement('div');
      chips.className = 'pending';
      editor.chipsBox = chips;
      // 파일 첨부 진입점: 등 메모 컴포넌트는 #files 입력에 넣지 기존 메모
      // 편집(pane)는 붙여넣기·드래그드롭으로 뒤에 파일이 곧바로 경로가 없었다
      // (아님 등 otherFiles 카운트뿐 등 업로드 등 상위 배경의 프로 이하 있었다).
      // inedit의 같은 .editor-row/.mini-file-btn 패턴으로 일반 파일 첨부를 건다.
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
    // 저장된 넣는 잠긴 블록 플레이스홀더에 해제 내부 연결한다 (UI-003)
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
    // data-act="lock" 잠금 버튼은 편집 모드 전용이다 (보여줄 모드는 잠금을
    // data-act="lockmenu" 메뉴가 wireLockMenu로 따로 처리한다, I-03).
    const lb = q('lock');
    if (lb && actionsEl.querySelector('[data-act="save"]')) {
      // 편집 모드: 잠금 등 UI만 변경, 내용은 save 버튼에서
      lb.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      lb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const memo = memoCache[id];
        if (!memo) return;
        // pending 상태로 고정 (실제 내용은 save 버튼에서)
        const newLocked = !memo._pendingLock;
        memo._pendingLock = newLocked;
        lb.innerHTML = `<i data-lucide="${newLocked ? 'lock' : 'lock-open'}"></i>`;
        lb.title = newLocked ? 'AI 접근 잠금 (내부에서 해제)' : 'AI 접근 허용 (내부에서 잠금)';
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
        // pending의 lock 상태가 있으면 먼저 고정
        const memo = memoCache[id];
        if (memo && memo._pendingLock !== undefined) {
          try {
            const lockRes = await fetchLockWithPin('/api/memo/' + id + '/lock', { locked: memo._pendingLock });
            // HTTP 오류(등: 암호화 실패 500)면 본문 내용을 중단한다 등
            // 실패를 알리고 PUT을 진행하면 잠금 상태와 본문이 숨긴다.
            if (!lockRes.ok) {
              toast('잠금 설정 실패');
              return;
            }
            memo.is_locked = memo._pendingLock ? 1 : 0;
            delete memo._pendingLock;
          } catch (err) {
            toast('잠금 설정 실패');
            return;
          }
        }
        const saved = await savePane(id, pane, editor, rich);
        // 고정 실패 시에는 편집 오류를 메모에 (게스트는 savePane의 프로)
        if (saved) { showView(); notifyMemoDocTitle(); }
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
    // 삭제 버튼의 HTML은 onclick="window._deleteMemo(this)" 사용 (커스텀 모달)
    // wireActions()에서 일어나지 않음
    const xb = q('close');
    if (xb) { xb.addEventListener('mousedown', (e) => e.preventDefault()); xb.onclick = () => {
      if (typeof closePane === 'function') { try { closePane(id); } catch (e) { console.warn('closePane 실패:', e); } }
    }; }
  }
  showView(pane);
  wireActions(pane);
  updatePanesVisibility();
  notifyMemoDocTitle();
}
async function savePane(id, pane, editor, rich) {
  const pTitle = (editor.titleInput ? editor.titleInput.value : '').trim();
  if (!pTitle && editorIsEmpty(editor)) return true; // 만들어진 내용 없음 등 성공으로 간주
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
    if (!putRes.ok) { toast('내용에 실패했어요'); return false; }
    await cleanupOrphanFiles(oldText, finalText);
    hideImgResize();
    hideImgTools();
    editor.blobMap.clear();
    editor.otherFiles = [];
    refreshOtherFiles(editor);
    // 파일맵 새로고침 후 팬 내용 갱신
    let files = [];
    try { files = await fetch(`/api/memo/${id}/files`).then(r => r.json()); } catch (e) { console.warn('메모 파일 목록 조회 실패:', e); }
    if (!Array.isArray(files)) files = []; // 깨진 응답은 빈 파일 목록으로 degrade
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
    return true;
  } finally {
    btn.disabled = false;
  }
}

// 보여줄 오류 체크리스트 잠금 (E3 구성): 렌더러 체크박스의 순서는 원본
// 마크다운의 '- [ ]' 줄 순서가 1:1로 대응한 현재로 n번째 체크를
// 실지 PUT한다. 개수가 숨긴하면(코드 블록 안의 마지막 등) 배경의
// 않는데 등 나머지 줄을 실지 것보다 동작하지 않게 이름 안전하다.
function wireViewChecklist(container, memoId, rerender) {
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  if (!boxes.length) return;
  const src = String((memoCache[memoId] && memoCache[memoId].text) || '');
  const taskLineCount = src.split('\n').filter(l => /^\s*[-*]\s+\[[ xX]\]/.test(l)).length;
  if (taskLineCount !== boxes.length) return;
  boxes.forEach((box, idx) => {
    box.disabled = false;
    box.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const c = memoCache[memoId];
      if (!c || c.is_locked) return;
      const lines = String(c.text || '').split('\n');
      const re = /^(\s*[-*]\s+\[)([ xX])(\])/;
      let seen = -1;
      let flipped = false;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          seen++;
          if (seen === idx) {
            lines[i] = lines[i].replace(re, (m, pre, mark, post) => pre + (mark === ' ' ? 'x' : ' ') + post);
            flipped = true;
            break;
          }
        }
      }
      if (!flipped) return;
      const newText = lines.join('\n');
      try {
        const res = await window._fetchStepUp('/api/memo/' + memoId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: newText }),
        });
        if (!res.ok) { toast('체크 내용에 실패했어요'); return; }
        c.text = newText;
        if (typeof memoTexts !== 'undefined') memoTexts[memoId] = newText;
        rerender();
      } catch (err) {
        console.warn('체크 복사 실패:', err);
        toast('체크 내용에 실패했어요');
      }
    });
  });
}

// AI 데이터 변경 등 새로고침 (범위 3-4 응답): assistant-widget의
// dataChanged 응답에는 window.refreshAfterAI를 부른다. 정의가 없으면
// 전체를 location.reload()로 떨어진 "AI 따로 메모 따로"의 분리감이
// 생긴 등 목록·태그·달력 다시 열고, 보여줄 모드 새로 등 내용으로
// 다시 그린다. 편집 중인 화면 잠긴 메모 새로 건드리지 않는다.
window.refreshAfterAI = async function () {
  await load();
  loadTags();
  if (typeof renderCal === 'function') renderCal();
  const panes = [...document.querySelectorAll('.pane[data-pane]')];
  for (const p of panes) {
    const pid = Number(p.dataset.pane);
    const editEl = p.querySelector('.pane-edit');
    if (editEl && !editEl.hidden) continue; // 편집 중 등 사용자 입력을 지운다
    const c = memoCache[pid];
    if (!c || c.is_locked) continue; // 잠긴 메모는 step-up 없이 다시 내지 않는다
    p.remove();
    await openPane(pid);
  }
};

$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 300); });
// 전역 삭제 함수 (동적 버튼용)
window._deleteMemo = async function(btn) {
  const pane = btn.closest('.pane');
  const id = pane ? pane.dataset.pane : null;
  if (!id) { toast('메모 ID를 찾을 수 없어요'); return; }
  // 커스텀 확인 모달 (자동화 테스트 가능)
  if (!await window._confirmDelete('이 메모를 삭제할까요?')) return;
  try {
    const res = await window._fetchStepUp('/api/memo/' + id, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast('삭제가 실패했어요: ' + friendlyError(data || { status: res.status }, '잠시 후 다시 시도해 주세요.'));
      return;
    }
  } catch (err) {
    toast('삭제가 실패했어요: ' + friendlyError(err, '잠시 후 다시 시도해 주세요.'));
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


// pane.js에서 분리 (2026-11-01 단일 파일 분해): PIN/step-up 모달·확인 모달·공용 숨김.
// memo-bundle.js로 함께 번호순으로 위임 함수 공유 방식과 기존과 동일하다.

// 잠금 해제 step-up용 PIN 입력 모달 (서버가 PIN을 요구할 때만 뜬다)
window._promptPin = function(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'myhub-stepup-overlay';
    overlay.innerHTML = `
      <div class="myhub-stepup-modal">
        <p>${msg}</p>
        <input type="password" inputmode="numeric" autocomplete="off" maxlength="6" class="myhub-stepup-pin-input" placeholder="PIN 6자리" style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:16px;font-size:16px;text-align:center;letter-spacing:6px;">
        <div class="myhub-stepup-btns">
          <button class="myhub-stepup-no">취소</button>
          <button class="myhub-stepup-yes">확인</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.myhub-stepup-pin-input');
    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6); });
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.myhub-stepup-no').onclick = () => done(null);
    overlay.querySelector('.myhub-stepup-yes').onclick = () => done(input.value || null);
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
  const pin = await window._promptPin(msg || '보호한 메모예요. 로그인된 같은 PIN을 입력하세요. 확인하면 5분 동안 다시 묻지 않아요.');
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
    overlay.className = 'memo-confirm-overlay';
    overlay.innerHTML = `
      <div class="memo-confirm-modal">
        <p>${msg}</p>
        <div class="memo-confirm-btns">
          <button class="memo-confirm-no">취소</button>
          <button class="memo-confirm-yes${danger ? ' danger' : ''}">${yesLabel || '확인'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.memo-confirm-no').onclick = () => done(false);
    overlay.querySelector('.memo-confirm-yes').onclick = () => done(true);
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

/* 창 상단 메뉴바 정의 (공유: js/desktop/windows.js 상단 주석).
   결과 입력 같은 컨트롤러 차 등에 얹고, 명령은(창 메모·첨부)와
   보여줄 잠금·태그 선택만 메뉴로 허용한다. 태그 항목은 태그 칩
   내부와 같은 잠금 동작이고, 목록의 등 등 lastTags로 렌더한다. */
window.MyHubMenus = [
  {
    label: '파일',
    items: [
      {
        label: '새 메모',
        run: () => {
          const el = $('composerRich');
          if (el) el.focus();
        },
      },
      { label: '파일 첨부', target: '#files' },
    ],
  },
  {
    label: '보기',
    items: () => {
      const items = [
        {
          label: '달력',
          checked: () => $('tglCal').classList.contains('on'),
          target: '#tglCal',
        },
        { label: '태그', checked: () => tagbarOpen, target: '#tglTag' },
      ];
      if (lastTags && lastTags.length) {
        items.push({ separator: true });
        lastTags.forEach((t) => {
          items.push({
            label: '#' + t.tag,
            sub: t.n + '개',
            checked: () => activeTag === t.tag,
            run: () => {
              activeTag = activeTag === t.tag ? '' : t.tag;
              syncTagUI();
              load();
            },
          });
        });
      }
      return items;
    },
  },
];

/* ================= 열 너비 드래그 조절 (범위 2) =================
   PC 3단의 경계 핸들을 누른 CSS 변환이 바뀌어서 등 너비가 조절하고,
   펼치면 localStorage의 저장된 다음도 유지한다 (복원된 memo.html
   코드 스크립트). 좁은 폭(<1024px)에서는 너비 세로로 펼치는 기존
   모바일 규칙이라는 핸들 자체가 표시하지 않고 드래그도 시작하지 않는다. */
(function initColResizers() {
  const layout = $('layout');
  if (!layout) return;
  const CONF = {
    left: { key: 'myhub.memo.colLeft', varName: '--memo-col-left', def: 300, min: 220, max: 560 },
    right: { key: 'myhub.memo.colRight', varName: '--memo-col-right', def: 340, min: 260, max: 600 },
  };
  layout.querySelectorAll('.col-resizer').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      if (window.innerWidth < 1024) return;
      const conf = CONF[h.dataset.side];
      if (!conf) return;
      e.preventDefault();
      const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue(conf.varName), 10) || conf.def;
      const startX = e.clientX;
      h.classList.add('dragging');
      try { h.setPointerCapture(e.pointerId); } catch (err) { console.warn('포인터 캡처 실패:', err); }
      const move = (ev) => {
        const dx = h.dataset.side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.max(conf.min, Math.min(conf.max, cur + dx));
        document.documentElement.style.setProperty(conf.varName, w + 'px');
      };
      const up = () => {
        h.classList.remove('dragging');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue(conf.varName), 10);
        if (w) {
          try { localStorage.setItem(conf.key, String(w)); }
          catch (err) { console.warn('열 너비 복원 실패:', err); }
        }
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  });
})();

/* 주의 제목 무거운 요청은 현재 애플 메모 제목으로 보낸다
   (load 순서 경유를 자기치유 등 windows.js의 myhub:request-doc-title) */
if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'myhub:request-doc-title'
      && typeof notifyMemoDocTitle === 'function') notifyMemoDocTitle();
  });
}
