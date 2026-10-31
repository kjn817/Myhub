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
      const updateRes = await fetch('/api/memo/' + window._editingMemoId, {
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
