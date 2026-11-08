let activeFilter = 'all';
const typeNames = { memo: '메모', chat: '대화', schedule: '일정', todo: '할 일' };
const typeLinks = { memo: '/memo.html', chat: '/chat.html', schedule: '/schedule.html', todo: '/todo.html' };

document.querySelectorAll('#filters button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.type;
    doSearch();
  });
});

async function doSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const types = activeFilter === 'all' ? '' : `&types=${activeFilter}`;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${types}&limit=50`);
    const data = await res.json();
    renderResults(data.results || []);
  } catch (e) {
    document.getElementById('results').innerHTML = '<div class="empty">검색 중 오류가 발생했습니다.</div>';
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderResults(results) {
  const el = document.getElementById('results');
  if (!results.length) {
    el.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
    return;
  }
  el.innerHTML = results.map(r => `
    <div class="result" data-link="${typeLinks[r.source_type]}">
      <div class="type">${typeNames[r.source_type]} · ${escapeHtml(r.created_at?.slice(0, 10) || '')}</div>
      <div class="title">${escapeHtml(r.title)}</div>
      <div class="snippet">${escapeHtml(r.snippet?.slice(0, 100) || '')}</div>
    </div>
  `).join('');
}

document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('q').addEventListener('keypress', e => {
  if (e.key === 'Enter') doSearch();
});
if (window.lucide) lucide.createIcons();
// 결과 카드 클릭 이동 — script-src-attr 'none'이라 인라인 onclick을 쓸 수 없어
// data-link + 위임 리스너로 처리한다.
document.getElementById('results').addEventListener('click', (e) => {
  const card = e.target.closest('.result[data-link]');
  if (card) location.href = card.dataset.link;
});
