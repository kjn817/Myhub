/* ================= 12. 시작 ================= */
initCal();
updateLayoutMode();
$('pgPrev').onclick = () => { if (page > 0) { page--; renderRows(cachedMemos); } };
$('pgNext').onclick = () => { page++; renderRows(cachedMemos); };
loadTags();
load();