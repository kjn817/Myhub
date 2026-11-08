// 키 로테이션 페이지 로직 (트랙 5 — 런북 §12.3의 콘솔 스니펫 단계를 UI로 전환)
// 계약:
// - 새 키 값은 입력란에서 POST /api/key-rotation/rotate 본문으로만 전송한다.
//   localStorage·sessionStorage·cookie·로그 어디에도 남기지 않으며, 실행이
//   끝나면 입력란을 비운다.
// - dry-run 응답의 pending이 기준 census(§12.2)와 전 항목 일치할 때만 실행
//   버튼이 활성화된다 (fail-closed). 실행 후에는 rotated == pending을 확인한다.
// - step-up이 필요하면 공용 헬퍼(public/js/step-up.js)가 PIN 모달을 띄운다.
(function () {
  var CENSUS = { memo_text: 4, memo_block: 0, google_token_row: 1, locked_file: 0 };
  var KEYS = ['memo_text', 'memo_block', 'google_token_row', 'locked_file'];
  var LABELS = {
    memo_text: '메모 본문',
    memo_block: '잠긴 블록',
    google_token_row: 'Google 토큰 행',
    locked_file: '잠긴 첨부'
  };
  var lastPending = null;

  function el(id) { return document.getElementById(id); }

  function show(boxId, msg) {
    var box = el(boxId);
    box.textContent = msg;
    box.classList.add('show');
  }
  function hide(boxId) { el(boxId).classList.remove('show'); }

  function countsEqual(a, b) {
    if (!a || !b) return false;
    return KEYS.every(function (k) { return a[k] === b[k]; });
  }

  function countsText(counts) {
    return KEYS.map(function (k) { return LABELS[k] + ' ' + counts[k]; }).join(' · ');
  }

  function renderCensus(pending) {
    var tbody = el('censusBody');
    tbody.innerHTML = '';
    KEYS.forEach(function (k) {
      var tr = document.createElement('tr');
      var match = pending[k] === CENSUS[k];
      tr.innerHTML = '<td></td><td></td><td></td><td></td>';
      tr.children[0].textContent = LABELS[k];
      tr.children[1].textContent = String(CENSUS[k]);
      tr.children[2].textContent = String(pending[k]);
      tr.children[3].textContent = match ? '일치' : '불일치';
      if (!match) tr.className = 'mismatch';
      tbody.appendChild(tr);
    });
    el('censusTable').style.display = 'table';
  }

  async function callRotate(dryRun) {
    var newKey = el('newKey').value;
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newKey: newKey, dryRun: dryRun })
    };
    var fetcher = window._fetchStepUp || window.fetch;
    var res = await fetcher.call(window, '/api/key-rotation/rotate', opts, '키 교체를 위해 PIN을 입력하세요.');
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      if (data && data.code === 'STEP_UP_REQUIRED') {
        throw new Error('PIN 확인이 필요합니다. 다시 시도해 PIN을 입력하세요.');
      }
      throw new Error((data && data.error) || ('요청 실패 (HTTP ' + res.status + ')'));
    }
    return data;
  }

  function reportError(prefix, report) {
    var msg = prefix;
    if (report && report.error) msg += ': ' + report.error;
    if (report && report.failures) {
      var parts = Object.keys(report.failures).map(function (k) {
        return (LABELS[k] || k) + ' ' + report.failures[k] + '건';
      });
      if (parts.length) msg += ' (복호화 실패 — ' + parts.join(', ') + ')';
    }
    show('errorBox', msg + ' 실행을 중단합니다. 이 건수만 Claude에 알려주세요.');
  }

  window.krDryRun = async function () {
    hide('errorBox'); hide('successBox'); hide('warnBox');
    el('executeBtn').disabled = true;
    lastPending = null;
    if (!el('newKey').value) { show('errorBox', '새 키 값을 입력하세요.'); return; }
    el('dryRunBtn').disabled = true;
    try {
      var report = await callRotate(true);
      if (!report || report.ok !== true) { reportError('dry-run 실패', report); return; }
      lastPending = report.pending;
      renderCensus(report.pending);
      if (countsEqual(report.pending, CENSUS)) {
        el('executeBtn').disabled = false;
        show('successBox', 'dry-run 확인 완료 — 전환 대상이 기준 건수와 전부 일치합니다. 실행 버튼을 누를 수 있습니다.');
      } else {
        show('errorBox', '전환 대상 건수가 기준과 다릅니다 — 실행할 수 없습니다 (fail-closed). dry-run 건수: ' + countsText(report.pending));
      }
    } catch (e) {
      show('errorBox', e.message || 'dry-run 중 오류가 발생했습니다.');
    } finally {
      el('dryRunBtn').disabled = false;
    }
  };

  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

  window.krExecute = async function () {
    hide('errorBox'); hide('successBox');
    if (!lastPending) { show('errorBox', '먼저 dry-run을 실행하세요.'); return; }
    el('executeBtn').disabled = true;
    el('dryRunBtn').disabled = true;
    try {
      var report = await callRotate(false);
      if (!report || report.ok !== true) {
        reportError('로테이션 실패', report);
        return;
      }
      if (!countsEqual(report.rotated, lastPending)) {
        show('errorBox', '전환 완료 건수가 dry-run 대상과 다릅니다 — rotated: ' + countsText(report.rotated) + ' / pending: ' + countsText(lastPending) + '. 대시보드 교체로 넘어가지 말고 이 건수를 Claude에 알려주세요.');
        return;
      }
      el('newKey').value = '';
      show('successBox', '로테이션 완료 — ' + countsText(report.rotated) + ' 전부 새 키로 전환됐습니다.');
      show('warnBox', '경고: 지금부터 Cloudflare 대시보드에서 MEMO_ENCRYPTION_KEY를 새 값으로 교체하기 전까지, 전환된 항목은 운영 화면에서 읽히지 않습니다. 이 페이지의 안내대로 대시보드 교체를 바로 이어서 마치고, 교체 후에는 보호 메모 열람으로 복호화를 확인하세요.');
    } catch (e) {
      show('errorBox', e.message || '로테이션 중 오류가 발생했습니다.');
    } finally {
      el('dryRunBtn').disabled = false;
    }
  };
  // 버튼 배선 — KEY_ROTATION_CSP script-src-attr 'none'이라 인라인 onclick 불가.
  var dryBtn = el('dryRunBtn');
  if (dryBtn) dryBtn.addEventListener('click', function () { window.krDryRun(); });
  var execBtn = el('executeBtn');
  if (execBtn) execBtn.addEventListener('click', function () { window.krExecute(); });
})();
