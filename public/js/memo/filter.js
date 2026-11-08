/* ================= 5. 필터 ================= */
function renderActiveFilters() {
  const box = $('activeFilters');
  box.innerHTML = '';
  const mk = (label, clear) => {
    const s = document.createElement('span');
    s.className = 'fchip';
    const lab = document.createElement('span');
    lab.innerHTML = label;
    s.appendChild(lab);
    const x = document.createElement('button');
    x.innerHTML = '<i data-lucide="x"></i>';
    x.onclick = clear;
    s.appendChild(x);
    box.appendChild(s);
  };
  if (activeTag) mk('#' + activeTag, () => { activeTag = ''; syncTagUI(); load(); });
  if (activeDate) {
    const [Y, M, D] = activeDate.split('-');
    mk(`<i data-lucide="calendar-days" class="ic-xs"></i> ${Number(M)}월 ${Number(D)}일`, () => { activeDate = ''; renderCal(); load(); });
  }

  refreshIcons();}
