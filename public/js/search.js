// 통합 검색 페이지 로직 등 CSP enforce를 위해 search.html의 인라인 스크립트에서 추출 (2026-11-01)
// 결과 항목의 속성클릭 핸들러는 로 data-href + 컨테이너 이벤트 위임으로 전환한다.
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
    <div class="result" data-href="${typeLinks[r.source_type]}">
      <div class="type">${typeNames[r.source_type]} · ${escapeHtml(r.created_at?.slice(0, 10) || '')}</div>
      <div class="title">${escapeHtml(r.title)}</div>
      <div class="snippet">${escapeHtml(r.snippet?.slice(0, 100) || '')}</div>
    </div>
  `).join('');
}

document.getElementById('results').addEventListener('click', (e) => {
  const item = e.target.closest('.result');
  if (item && item.dataset.href) location.href = item.dataset.href;
});
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('q').addEventListener('keypress', e => {
  if (e.key === 'Enter') doSearch();
});
lucide.createIcons();
