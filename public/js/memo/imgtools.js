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
