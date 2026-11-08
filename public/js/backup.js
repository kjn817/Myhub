async function createBackup() {
  const password = document.getElementById('password').value;
  const passwordConfirm = document.getElementById('passwordConfirm').value;
  const errorBox = document.getElementById('errorBox');
  const successBox = document.getElementById('successBox');
  const loading = document.getElementById('loading');
  const backupBtn = document.getElementById('backupBtn');
  
  // 초기화
  errorBox.classList.remove('show');
  successBox.classList.remove('show');
  
  // 입력 검증
  if (!password) {
    showError('백업 암호를 입력하세요.');
    return;
  }
  if (password.length < 8) {
    showError('백업 암호는 최소 8자 이상이어야 합니다.');
    return;
  }
  if (password !== passwordConfirm) {
    showError('백업 암호가 일치하지 않습니다.');
    return;
  }
  
  // 로딩 상태
  backupBtn.disabled = true;
  loading.classList.add('show');
  
  try {
    // step-up 게이트 (트랙 1): 발급이 403 STEP_UP_REQUIRED면 공용 헬퍼
    // (js/step-up.js)가 PIN 모달 → /api/auth/step-up → 1회 재시도를 한다.
    // 취소하면 원래 403이 돌아와 아래에서 안내 문구로 표시된다.
    const backupOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    };
    const response = window._fetchStepUp
      ? await window._fetchStepUp('/api/backup/encrypted', backupOpts, '백업 발급을 위해 PIN을 입력하세요.')
      : await fetch('/api/backup/encrypted', backupOpts);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.code === 'STEP_UP_REQUIRED') {
        throw new Error('PIN 확인이 필요합니다. 다시 시도해 PIN을 입력하세요.');
      }
      throw new Error(err.error || '백업 실패');
    }
    
    const backup = await response.json();
    
    // 파일 다운로드
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `myhub-backup-${date}.myhub-backup`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // 입력 필드 초기화 (보안)
    document.getElementById('password').value = '';
    document.getElementById('passwordConfirm').value = '';
    
    showSuccess('백업이 완료되었습니다. 파일을 안전하게 보관하세요.');
  } catch (e) {
    // 네트워크 오류는 한국어로 변환
    let msg = e.message || '백업 중 오류가 발생했습니다.';
    if (e instanceof TypeError || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = '네트워크 오류가 발생했습니다. 연결 상태를 확인하고 다시 시도하세요.';
    }
    showError(msg);
  } finally {
    backupBtn.disabled = false;
    loading.classList.remove('show');
  }
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.classList.add('show');
}

function showSuccess(msg) {
  const box = document.getElementById('successBox');
  box.textContent = msg;
  box.classList.add('show');
}

// Lucide 아이콘 초기화
if (window.lucide) lucide.createIcons();

document.getElementById('backupBtn').addEventListener('click', createBackup);
