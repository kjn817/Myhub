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
