
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
