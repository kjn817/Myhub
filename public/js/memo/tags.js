/* ================= 6. 태그 ================= */
async function loadTags() {
  const tags = await fetch('/api/memo/tags').then(r => r.json()).catch(() => []);
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
