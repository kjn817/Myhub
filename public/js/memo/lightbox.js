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
