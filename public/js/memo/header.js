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