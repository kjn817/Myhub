async function loadBriefing() {
  const content = document.getElementById('briefing-content');
  const errorDiv = document.getElementById('briefing-error');
  const retryBtn = document.getElementById('btn-retry');

  content.innerHTML = '<div class="briefing-loading">브리핑을 불러오는 중...</div>';
  errorDiv.style.display = 'none';
  retryBtn.style.display = 'none';

  try {
    const res = await fetch('/api/briefing/today');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) throw new Error('브리핑을 불러오지 못했습니다.');

    const data = await res.json();
    renderBriefing(data);
  } catch (e) {
    errorDiv.textContent = '브리핑을 불러오는 중 오류가 발생했습니다: ' + e.message;
    errorDiv.style.display = 'block';
    retryBtn.style.display = 'inline-block';
    content.innerHTML = '';
  }
}

function renderBriefing(data) {
  document.getElementById('briefing-date').textContent = data.date + ' 브리핑';
  document.getElementById('briefing-tz').textContent = '시간대: ' + (data.timezone || 'Asia/Seoul');

  const content = document.getElementById('briefing-content');
  let html = '';

  // 일정
  html += '<div class="briefing-section"><h2>오늘 일정</h2>';
  if (data.schedules && data.schedules.length > 0) {
    data.schedules.forEach(s => {
      const div = document.createElement('div');
      div.className = 'briefing-item';
      div.textContent = s.title + (s.start_at ? ' (' + s.start_at + ')' : '');
      html += div.outerHTML;
    });
  } else {
    html += '<div class="briefing-empty">오늘 등록된 일정이 없습니다.</div>';
  }
  html += '</div>';

  // 할 일
  html += '<div class="briefing-section"><h2>할 일</h2>';
  if (data.todos && data.todos.length > 0) {
    data.todos.forEach(t => {
      const div = document.createElement('div');
      div.className = 'briefing-item';
      div.textContent = t.title;
      html += div.outerHTML;
    });
  } else {
    html += '<div class="briefing-empty">미완료 할 일이 없습니다.</div>';
  }
  html += '</div>';

  // 메모
  if (data.memos && data.memos.length > 0) {
    html += '<div class="briefing-section"><h2>중요 메모</h2>';
    data.memos.forEach(m => {
      const div = document.createElement('div');
      div.className = 'briefing-item';
      div.textContent = m.text;
      html += div.outerHTML;
    });
    html += '</div>';
  }

  // AI 기억
  if (data.memories && data.memories.length > 0) {
    html += '<div class="briefing-section"><h2>기억</h2>';
    data.memories.forEach(m => {
      const div = document.createElement('div');
      div.className = 'briefing-item';
      div.textContent = m.content;
      html += div.outerHTML;
    });
    html += '</div>';
  }

  content.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', loadBriefing);

document.getElementById('btn-retry').addEventListener('click', loadBriefing);
