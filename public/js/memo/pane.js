async function openPane(id) {
  id = Number(id);
  if (typeof window._debugPane === 'undefined') window._debugPane = [];
  window._debugPane.push('openPane called: ' + id);
  if (document.querySelector(`.pane[data-pane="${id}"]`)) return;
  let cached = memoCache[id];
  // 79차: 캐시에 없으면 서버에서 직접 조회
  // 82차: credentials 추가로 인증 쿠키 포함
  if (!cached) {
    try {
      const res = await fetch(`/api/memo/${id}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        cached = data.memo || data;
        if (cached && cached.id) {
          memoCache[id] = cached;
        }
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
          const putRes = await fetch('/api/memo/' + id, {
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
        const resp = await fetch(srcUrl);
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
        window.open(srcUrl, '_blank');
      }
    };
    const del = document.createElement('button');
    del.className = 'fdel';
    del.innerHTML = '<i data-lucide="x"></i>';
    del.setAttribute('aria-label', '파일 삭제');
    del.onclick = async () => {
      if (!confirm('파일을 삭제할까요?')) return;
      await fetch('/api/memo/files/' + f.id, { method: 'DELETE' });
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
    await fetch('/api/memo/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: finalText }),
    });
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
    const res = await fetch('/api/memo/' + id, { method: 'DELETE' });
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
