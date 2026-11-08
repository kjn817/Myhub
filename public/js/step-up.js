// 보호 step-up 공용 헬퍼 (트랙 1에서 public/js/memo/pane.js의 구현을 추출해 공용화)
// 계약은 메모 화면과 동일하다:
// - 서버 게이트가 403 { code: 'STEP_UP_REQUIRED' }를 돌려주면 PIN 모달을 띄우고
// - POST /api/auth/step-up { pin } 으로 5분 step-up 창을 발급받은 뒤
// - 원래 요청을 1회 재시도한다. PIN_INVALID면 모달을 다시 띄운다.
// - PIN 미설정 계정은 서버 게이트가 면제하므로 모달이 뜰 일이 없다.
// 메모 화면은 기존 번들(pane.js)의 동일 구현을 그대로 쓰고, 이 파일은
// 메모 번들을 로드하지 않는 페이지(백업 등)가 같은 계약을 쓰기 위한 것이다.
(function () {
  // 모달 스타일: memo.css의 .confirm-* 규칙과 같은 값. 이 파일을 로드하는
  // 페이지가 해당 CSS를 갖고 있지 않아도 모달이 동작하도록 주입한다.
  if (!document.getElementById('step-up-style')) {
    var style = document.createElement('style');
    style.id = 'step-up-style';
    style.textContent =
      '.confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;}' +
      '.confirm-modal{background:#fff;border-radius:8px;padding:24px;max-width:320px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,0.2);}' +
      '.confirm-modal p{margin:0 0 20px;font-size:15px;}' +
      '.confirm-btns{display:flex;gap:10px;justify-content:flex-end;}' +
      '.confirm-btns button{padding:8px 20px;border-radius:6px;border:1px solid #ddd;background:#fff;cursor:pointer;font-size:14px;}' +
      '.confirm-btns .confirm-yes{background:#007aff;color:#fff;border-color:#007aff;}';
    document.head.appendChild(style);
  }

  // PIN 입력 모달 (pane.js window._promptPin과 동일 구현)
  window._promptPin = function (msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        '<div class="confirm-modal">' +
        '<p></p>' +
        '<input type="password" inputmode="numeric" autocomplete="off" maxlength="6" class="pin-prompt-input" placeholder="PIN 6자리" style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:16px;font-size:16px;text-align:center;letter-spacing:6px;">' +
        '<div class="confirm-btns">' +
        '<button class="confirm-no">취소</button>' +
        '<button class="confirm-yes">확인</button>' +
        '</div></div>';
      overlay.querySelector('p').textContent = msg;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('.pin-prompt-input');
      input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6); });
      const done = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('.confirm-no').onclick = () => done(null);
      overlay.querySelector('.confirm-yes').onclick = () => done(input.value || null);
      overlay.onclick = (e) => { if (e.target === overlay) done(null); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value || null); });
      input.focus();
    });
  };

  // PIN 모달 → POST /api/auth/step-up (5분 창 발급). 성공이면 true.
  // 사용자가 취소하면 false — 호출자는 원래 403 응답으로 실패 처리한다.
  window._stepUpWithPin = async function (msg) {
    const pin = await window._promptPin(msg || '보호된 작업이에요. PIN을 입력하세요.');
    if (!pin) return false;
    let data = null;
    try {
      const res = await fetch('/api/auth/step-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      if (res.ok) return true;
      data = await res.json().catch(() => null);
    } catch (e) { console.warn('step-up 요청 실패:', e); return false; }
    if (data && data.code === 'PIN_INVALID') {
      return window._stepUpWithPin('PIN이 올바르지 않아요. 다시 입력하세요.');
    }
    return false;
  };

  // fetch + step-up 재시도 (pane.js window._fetchStepUp과 동일 계약)
  // msg는 PIN 모달 안내 문구 — 페이지마다 다르면 호출자가 넘긴다.
  window._fetchStepUp = async function (url, opts, msg) {
    let res = await fetch(url, opts);
    if (res.status === 403) {
      let data = null;
      try { data = await res.clone().json(); } catch (e) { data = null; }
      if (data && data.code === 'STEP_UP_REQUIRED') {
        if (await window._stepUpWithPin(msg || '보호된 작업이에요. PIN을 입력하세요.')) res = await fetch(url, opts);
      }
    }
    return res;
  };
})();
