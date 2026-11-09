/* ================= 6. 태그 ================= */
// 마지막으로 불러온 태그 목록 을 다시 상단 메모바의 태그 메뉴가 연다
let lastTags = null;
async function loadTags() {
  const rawTags = await fetch('/api/memo/tags').then(r => r.json()).catch(() => []);
  // 응답이 배열이 아닌 값(예 오류 객체)일 때 빈 배열로 degrade 해 forEach pageerror 방지
  const tags = Array.isArray(rawTags) ? rawTags : [];
  lastTags = tags;
  const bar = $('tagbar');
  bar.innerHTML = '';
  tags.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tag' + (activeTag === t.tag ? ' on' : '');
    b.innerHTML = `#${esc(t.tag)}<span class="n">${t.n}</span>`;
    b.onclick = () => {
      activeTag = activeTag === t.tag ? '' : t.tag;
      syncTagUI();
      load();
    };
    bar.appendChild(b);
  });
  if (!tags.length) return;

  refreshIcons();}
function syncTagUI() {
  document.querySelectorAll('#tagbar .tag').forEach(b => {
    b.classList.toggle('on', !!activeTag && b.innerHTML.includes('#' + esc(activeTag)));
  });
  renderActiveFilters();
}
let tagbarOpen = false;
function setTagbar(open) {
  tagbarOpen = open;
  $('tagbar').hidden = !open;
  $('tglTag').classList.toggle('on', open);
  if (open) loadTags();
}
$('tglTag').onclick = () => setTagbar(!tagbarOpen);
