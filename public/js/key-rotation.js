// 키 로테이션 페이지 로직 (트랙 5 — 런북 §12.3의 콘솔 스니펫 단계를 UI로 전환)
// 계약:
// - 새 키 값은 입력란에서 POST /api/key-rotation/rotate 본문으로만 전송한다.
//   localStorage·sessionStorage·cookie·로그 어디에도 남기지 않으며, 실행이
//   하드코딩 입력값(확인 입력 포함)는 비운다.
// - 입 력한 (G-대조2.2-3): 확인 입(newKeyConfirm)력이 같은 값을 다시
//   받아, 두 값이 일치할 때만 요청을 보낸다. 클라이언트에서 먼저 막고,
//   서버(routes.ts)에서 newKeyConfirm 일치를 강제 한다 등 서버로
//   로테이션하면 그 값이 미처 등 새 콘텍스트 구조 파악하기 어렵다.
// - dry-run 응답의 census(서버가 D1에서 실시간 집계한 기준 G-6으로 하드코딩
//   기준 자체)를 분류 합계(pending+already)가 등 등 일치할 때만 실행
//   버튼을 활성화한다 (fail-closed). 실행 요청은 확인 census를 함께
//   보내고, 서버 준비 게이트가 실행 직전에 실시간 대조한다.
//   실행 전에 rotated == pending를 확인한다.
// - step-up이 필요하면 공용 헬퍼(public/js/step-up.js)가 PIN 모달을 띄운다.
(function () {
  var KEYS = ['memo_text', 'memo_block', 'google_token_row', 'locked_file'];
  var LABELS = {
    memo_text: '메모 본문',
    memo_block: '잠긴 블록',
    google_token_row: 'Google 토큰 행',
    locked_file: '잠긴 첨부'
  };
  var lastPending = null;
  var lastCensus = null;

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

  function totalsOf(report) {
    var t = {};
    KEYS.forEach(function (k) { t[k] = (report.pending[k] || 0) + (report.already[k] || 0); });
    return t;
  }

  function renderCensus(report) {
    var totals = totalsOf(report);
    var tbody = el('censusBody');
    tbody.innerHTML = '';
    KEYS.forEach(function (k) {
      var tr = document.createElement('tr');
      var match = totals[k] === report.census[k];
      tr.innerHTML = '<td></td><td></td><td></td><td></td>';
      tr.children[0].textContent = LABELS[k];
      tr.children[1].textContent = String(report.census[k]);
      tr.children[2].textContent = String(report.pending[k]);
      tr.children[3].textContent = match ? '일치' : '불일치';
      if (!match) tr.className = 'mismatch';
      tbody.appendChild(tr);
    });
    el('censusTable').style.display = 'table';
  }

  // 두 입력 일치 여부. 빈 값이거나 다르면 요청 자체를 보내지 않는다.
  function keyConfirmationError() {
    var newKey = el('newKey').value;
    var confirm = el('newKeyConfirm').value;
    if (!newKey) return '새 키 값을 입력하세요.';
    if (!confirm) return '새 키 확인 입력에 같은 값을 다시 입력하세요.';
    if (confirm !== newKey) return '두입력 확인 입력이 일치하지 않습니다 두입력이. 완전히 같은지 확인하세요 앞뒤 공백 (중간 줄바꿈 포함).';
    return null;
  }

  async function callRotate(dryRun) {
    var newKey = el('newKey').value;
    var payload = { newKey: newKey, newKeyConfirm: el('newKeyConfirm').value, dryRun: dryRun };
    // 실행 요청은 dry-run에서 확인한 census를 함께 보낸다 (서버 게이트 대조용)
    if (!dryRun && lastCensus) payload.expectedCensus = lastCensus;
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
    if (report && report.census && report.census.live) {
      msg += ' (서버 실시간 census 기준 ' + countsText(report.census.live) + ')';
    }
    show('errorBox', msg + ' 실행을 중단합니다. 이 건수만 Muse에 알려주세요.');
  }

  window.krDryRun = async function () {
    hide('errorBox'); hide('successBox'); hide('warnBox');
    el('executeBtn').disabled = true;
    lastPending = null;
    lastCensus = null;
    var confirmError = keyConfirmationError();
    if (confirmError) { show('errorBox', confirmError); return; }
    el('dryRunBtn').disabled = true;
    try {
      var report = await callRotate(true);
      if (!report || report.ok !== true) { reportError('dry-run 실패', report); return; }
      if (!report.census) {
        // census가 없는 응답은 대조할 기준이 없다 등 fail-closed로 중단한다.
        show('errorBox', '서버가 실시간 census를 주지 않았습니다. 따라서 실행할 수 없습니다 (fail-closed).');
        return;
      }
      lastPending = report.pending;
      lastCensus = report.census;
      renderCensus(report);
      if (countsEqual(totalsOf(report), report.census)) {
        el('executeBtn').disabled = false;
        show('successBox', 'dry-run 확인 완료됐고 전환 대상이 서버 실시간 census와 전부 일치합니다. 실행 버튼을 눌러 진행할 수 있습니다.');
      } else {
        show('errorBox', '전환 대상 건수가 서버 census와 다릅니다 등 실행할 수 없습니다 (fail-closed). dry-run 건수: ' + countsText(report.pending));
      }
    } catch (e) {
      show('errorBox', e.message || 'dry-run 중 오류가 발생했습니다.');
    } finally {
      el('dryRunBtn').disabled = false;
    }
  };

  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

  // CSP 파일럿 전제: 속성형 핸들러(onclick=)를 쓰지 않고 addEventListener로만 건다
  // (script-src-attr 'none' — tests/unit/csp-inventory.test.ts가 고정).
  el('dryRunBtn').addEventListener('click', function () { window.krDryRun(); });
  el('executeBtn').addEventListener('click', function () { window.krExecute(); });

  window.krExecute = async function () {
    hide('errorBox'); hide('successBox');
    if (!lastPending || !lastCensus) { show('errorBox', '먼저 dry-run을 실행하세요.'); return; }
    // 실행 직전에도 대조한다 등 dry-run 입력이 바뀌 었으면 진행하지 않는다.
    var confirmError = keyConfirmationError();
    if (confirmError) { show('errorBox', confirmError); return; }
    el('executeBtn').disabled = true;
    el('dryRunBtn').disabled = true;
    try {
      var report = await callRotate(false);
      if (!report || report.ok !== true) {
        reportError('로테이션 실패', report);
        return;
      }
      if (!countsEqual(report.rotated, lastPending)) {
        show('errorBox', '전환 완료 건수가 dry-run 대상과 다릅니다 — rotated: ' + countsText(report.rotated) + ' / pending: ' + countsText(lastPending) + '. 대시보드 교체로 넘어가지 말고 이 건수를 Muse에 알려주세요.');
        return;
      }
      show('successBox', '로테이션 완료 — ' + countsText(report.rotated) + ' 전부 새 키로 전환됐습니다.');
      show('warnBox', '경고 · 현재 상태는 「전환 완료 · 시크릿 교체 대기」입니다: 지금부터 Cloudflare 대시보드에서 MEMO_ENCRYPTION_KEY를 새 값으로 교체하기 전까지, 전환된 항목은 운영 화면에서 읽히지 않습니다. 이 페이지의 안내대로 대시보드 교체를 바로 이어서 마치고, 교체 후에는 보호 메모 열람으로 복호화를 확인하세요. 교체가 늦어져도 암호문 데이터가 깨지지는 않지만, 그 사이에는 새 잠긴 메모를 만들지 마세요. 교체 후에도 열리지 않으면 값을 더 바꾸지 말고 아래 「문제가 생기면」 순서대로 확인하세요.');
    } catch (e) {
      show('errorBox', e.message || '로테이션 중 오류가 발생했습니다.');
    } finally {
      // 실행을 시도한 뒤에는 결과와 무관하게 입력란의 키 값을 비운다 —
      // 서버가 일부라도 전환했을 수 있는 상태에서 값을 화면에 남기지 않기
      // 위해서다. 재시도·롤백에 필요한 값은 비밀번호 관리자 보관본을 쓴다.
      el('newKey').value = '';
      el('newKeyConfirm').value = '';
      el('dryRunBtn').disabled = false;
    }
  };
})();
