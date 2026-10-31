/* ================= 7. 달력 ================= */
let calY = 0, calM = 0;
function initCal() {
  const now = new Date();
  calY = now.getFullYear();
  calM = now.getMonth() + 1;
}
async function renderCal() {
  if ($('calCard').hidden) return;
  $('calTitle').textContent = `${calY}년 ${calM}월`;
  const counts = {};
  try {
    const res = await fetch(`/api/memo/calendar?y=${calY}&m=${calM}`).then(r => r.json());
    res.forEach(x => { counts[x.day] = x.n; });
  } catch (e) { console.warn('메모 달력 조회 실패:', e); }
  const grid = $('calGrid');
  grid.innerHTML = '';
  ['일','월','화','수','목','금','토'].forEach(d => {
    const s = document.createElement('span');
    s.className = 'dow'; s.textContent = d;
    grid.appendChild(s);
  });
  const first = new Date(calY, calM - 1, 1).getDay();
  const days = new Date(calY, calM, 0).getDate();
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  for (let i = 0; i < first; i++) {
    const b = document.createElement('span');
    b.className = 'blank';
    grid.appendChild(b);
  }
  for (let d = 1; d <= days; d++) {
    const ymd = `${calY}-${String(calM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const b = document.createElement('button');
    b.className = 'day';
    b.textContent = d;
    if (counts[ymd]) { b.classList.add('has'); b.setAttribute('data-n', counts[ymd]); }
    if (ymd === todayStr) b.classList.add('today');
    if (ymd === activeDate) b.classList.add('sel');
    b.onclick = () => {
      activeDate = activeDate === ymd ? '' : ymd;
      renderCal();
      load();
    };
    grid.appendChild(b);
  }

  refreshIcons();}
$('tglCal').onclick = () => {
  const card = $('calCard');
  card.hidden = !card.hidden;
  $('tglCal').classList.toggle('on', !card.hidden);
  renderCal();
};
$('calPrev').onclick = () => { calM--; if (calM < 1) { calM = 12; calY--; } renderCal(); };
$('calNext').onclick = () => { calM++; if (calM > 12) { calM = 1; calY++; } renderCal(); };
