// 백업 페이지 로직 등 CSP enforce를 위해 backup.html의 인라인 스크립트에서 추출 (2026-11-01)
// 버튼 배선은 onclick 제거하고 addEventListener로 대체 (script-src-attr 'none' 전제).
async function createBackup() {
  const password = document.getElementById('password').value;
  const passwordConfirm = document.getElementById('passwordConfirm').value;
  const errorBox = document.getElementById('errorBox');
  const successBox = document.getElementById('successBox');
  const loading = document.getElementById('loading');
  const backupBtn = document.getElementById('backupBtn');
  
  // 오류메시지 숨기기
  errorBox.classList.remove('show');
  successBox.classList.remove('show');
  errorBox.textContent = '';
  
  // 입력 검증
  if (!password) {
    showError('비밀번호를 입력해주세요.');
    return;
  }
  if (password.length < 8) {
    showError('비밀번호는 특수문자를 포함한 8글자 이상이어야 합니다.');
    return;
  }
  if (password !== passwordConfirm) {
    showError('백업 암호가 일치하지 않습니다.');
    return;
  }
  
  // 작업 시작 로직
  backupBtn.disabled = true;
  loading.classList.add('show');
  
  try {
    // step-up 자동 처리: 403 STEP_UP_REQUIRED가 오면 PIN 재확인을 거쳐
    // 같은 요청을 1번 다시 보낸다 (window._fetchStepUp이 있으면 그걸 쓰고,
    // 없으면 일반 fetch로 보낸 뒤 아래에서 STEP_UP_REQUIRED를 확인한다).
    const backupOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    };
    const response = window._fetchStepUp
      ? await window._fetchStepUp('/api/backup/encrypted', backupOpts, '백업 파일을 여는 비밀번호를 확인하세요.')
      : await fetch('/api/backup/encrypted', backupOpts);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.code === 'STEP_UP_REQUIRED') {
        throw new Error('백업하려면 먼저 PIN을 등록하세요.');
      }
      throw new Error(err.error || '백업이 실패했습니다.');
    }
    
    const backup = await response.json();
    
    // 백업 JSON을 파일로 내려받는다 (날짜별 파일명).
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `myhub-backup-${date}.myhub-backup`;
    a.click();
    URL.revokeObjectURL(url);
    
    // 아래 주석 처리된 줄은 백업 내용물(파일·태그·메모) 확인용 초안이다.
    // const fptails = backup.data && backup.data.files ? backup.data.files : [];
    // const fileTags = backup.data && backup.data.fileTags ? backup.data.fileTags : [];
    // const memos = backup.data && backup.data.memos ? backup.data.memos : [];

    showSuccess('백업이 완료됐습니다. 백업 파일은 비밀번호로 보호되니 안전한 곳에 보관하세요.');
    document.getElementById('password').value = '';
    document.getElementById('passwordConfirm').value = '';
  } catch (error) {
    showError(error.message || '백업 중 오류가 발생했습니다.');
  } finally {
    backupBtn.disabled = false;
    loading.classList.remove('show');
  }
}

function showError(message) {
  const errorBox = document.getElementById('errorBox');
  errorBox.textContent = message;
  errorBox.classList.add('show');
}

function showSuccess(message) {
  const successBox = document.getElementById('successBox');
  successBox.textContent = message;
  successBox.classList.add('show');
}

// 버튼 이벤트 연결
document.getElementById('backupBtn').addEventListener('click', createBackup);

// Enter 키로 비밀번호 입력란에서 확인했으면 지정방법
// Enter닿았다면 지정 입니다.
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && (e.target.id === 'password' || e.target.id === 'passwordConfirm')) {
    createBackup();
  }
});

