/* 로그인 페이지 로직 (public/login.html에서 분리 — run-002 low auth/login-csp-unsafe-inline 수정).
   인라인 <script>와 onclick 핸들러를 외부 파일 + addEventListener로 옮겨 CSP에서
   script-src 'unsafe-inline'을 제거한다. */
lucide.createIcons();
  let timerInt = null;

  function showErr(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
  }
  function hideErr(id) {
    document.getElementById(id).classList.remove('show');
  }
  function showStep(id) {
    ['stepPin', 'step1', 'step2', 'stepSetPin'].forEach((s) => {
      document.getElementById(s).classList.toggle('active', s === id);
    });
  }
  function onlyDigits(el) {
    el.value = el.value.replace(/[^0-9]/g, '').slice(0, 6);
  }

  async function pinLogin() {
    hideErr('errPin');
    const pin = document.getElementById('pinInput').value.trim();
    if (!/^\d{6}$/.test(pin)) {
      showErr('errPin', 'PIN 6자리를 입력하세요.');
      return;
    }
    const btn = document.getElementById('btnPinLogin');
    btn.disabled = true;
    btn.textContent = '로그인 중...';
    try {
      const r = await fetch('/api/auth/pin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const d = await r.json();
      if (!d.ok) {
        if (d.code === 'PIN_NOT_SET') {
          showStep('step1');
          showErr('err1', '아직 PIN이 없습니다. 이메일 인증으로 본인 확인 후 PIN을 발급하세요.');
        } else {
          showErr('errPin', d.error || '로그인 실패');
        }
        btn.disabled = false;
        btn.textContent = '로그인';
        return;
      }
      location.href = '/';
    } catch (e) {
      showErr('errPin', '로그인 실패. 다시 시도하세요.');
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  }

  async function setPin() {
    hideErr('errSetPin');
    const pin = document.getElementById('newPin').value.trim();
    const pin2 = document.getElementById('newPin2').value.trim();
    if (!/^\d{6}$/.test(pin)) {
      showErr('errSetPin', 'PIN은 숫자 6자리여야 합니다.');
      return;
    }
    if (pin !== pin2) {
      showErr('errSetPin', 'PIN 확인이 일치하지 않습니다.');
      return;
    }
    const btn = document.getElementById('btnSetPin');
    btn.disabled = true;
    btn.textContent = '설정 중...';
    try {
      const r = await fetch('/api/auth/set-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const d = await r.json();
      if (!d.ok) {
        showErr('errSetPin', d.error || '설정 실패');
        btn.disabled = false;
        btn.textContent = 'PIN 설정하고 시작하기';
        return;
      }
      location.href = '/';
    } catch (e) {
      showErr('errSetPin', '설정 실패. 다시 시도하세요.');
      btn.disabled = false;
      btn.textContent = 'PIN 설정하고 시작하기';
    }
  }

  async function sendCode() {
    hideErr('err1');
    const btn = document.getElementById('btnSend');
    btn.disabled = true;
    btn.textContent = '전송 중...';
    try {
      const r = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!d.ok && d.error) {
        showErr('err1', d.error);
        btn.disabled = false;
        btn.textContent = '인증코드 받기';
        return;
      }
      showStep('step2');
      document.getElementById('sentTo').textContent = d.sentToMasked
        ? `인증코드를 ${d.sentToMasked} 메일함으로 보냈습니다. (10분 동안 유효)`
        : '인증코드를 메일로 보냈습니다. (10분 동안 유효)';
      startTimer(typeof d.ttlSec === 'number' && d.ttlSec > 0 ? d.ttlSec : 600);
      document.getElementById('code').focus();
    } catch (e) {
      showErr('err1', '전송 실패. 다시 시도하세요.');
      btn.disabled = false;
      btn.textContent = '인증코드 받기';
    }
  }

  async function verifyCode() {
    hideErr('err2');
    const code = document.getElementById('code').value.trim();
    if (code.length !== 6) {
      showErr('err2', '6자리 인증코드를 입력하세요.');
      return;
    }
    const btn = document.getElementById('btnVerify');
    btn.disabled = true;
    btn.textContent = '확인 중...';
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!d.ok) {
        showErr('err2', d.error || '인증 실패');
        btn.disabled = false;
        btn.textContent = '확인';
        return;
      }
      // 이 흐름의 목적은 PIN 발급/재설정 — 본인확인 후에는 항상 PIN 설정 화면으로.
      // 이미 PIN이 있는데 재설정을 원치 않으면 설정 화면의 '나중에 설정하기'로 건너뛴다.
      showStep('stepSetPin');
      document.getElementById('newPin').focus();
    } catch (e) {
      showErr('err2', '확인 실패. 다시 시도하세요.');
      btn.disabled = false;
      btn.textContent = '확인';
    }
  }

  function backToStart() {
    showStep('step1');
    document.getElementById('btnSend').disabled = false;
    document.getElementById('btnSend').textContent = '인증코드 받기';
    if (timerInt) clearInterval(timerInt);
    document.getElementById('timer').textContent = '';
  }

  function startTimer(sec) {
    const el = document.getElementById('timer');
    if (timerInt) clearInterval(timerInt);
    const tick = () => {
      const m = Math.floor(sec / 60), s = sec % 60;
      el.textContent = `남은 시간 ${m}:${String(s).padStart(2, '0')}`;
      if (sec <= 0) {
        clearInterval(timerInt);
        el.textContent = '인증코드가 만료되었습니다. 다시 요청하세요.';
      }
      sec--;
    };
    tick();
    timerInt = setInterval(tick, 1000);
  }

  ['pinInput', 'newPin', 'newPin2'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (e) => onlyDigits(e.target));
  });
  document.getElementById('code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyCode();
  });
  document.getElementById('pinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pinLogin();
  });
  document.getElementById('newPin2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setPin();
  });
  document.getElementById('pinInput').focus();

  // 버튼 핸들러 (onclick 속성 대신 addEventListener — CSP 'unsafe-inline' 제거용)
  document.getElementById('btnPinLogin').addEventListener('click', pinLogin);
  document.getElementById('btnToOtp').addEventListener('click', () => showStep('step1'));
  document.getElementById('btnSend').addEventListener('click', sendCode);
  document.getElementById('btnToPin').addEventListener('click', () => showStep('stepPin'));
  document.getElementById('btnVerify').addEventListener('click', verifyCode);
  document.getElementById('btnBackToStart').addEventListener('click', backToStart);
  document.getElementById('btnSetPin').addEventListener('click', setPin);
  document.getElementById('btnLater').addEventListener('click', () => { location.href = '/'; });
