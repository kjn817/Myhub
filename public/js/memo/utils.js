/* ================= 1. 유틸 ================= */
// esc·friendlyError는 공용 코어(common/text-utils.js)가 맡는다 (F-L3, 5-4).
// 코어는 memo-bundle.js보다 먼저 받아야 한다 (memo.html 정적 태그 순서).
// 코어가 없으면 로드 시점에 명확한 오류를 낸다 (이스케이프는 생략 불가).
var textUtils = typeof window !== 'undefined' ? window.MyHubTextUtils : null;
if (!textUtils) throw new Error('[memo-bundle] text-utils.js가 먼저 로드되어야 합니다');
var esc = textUtils.esc;
var friendlyError = textUtils.friendlyError;
function fmtSize(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b/1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + 'MB';
  return (b/1073741824).toFixed(2) + 'GB';
}

function fmtDate(s) {
  const d = new Date(s + (s.endsWith('Z') ? '' : 'Z'));
  const now = new Date();
  const diff = now - d;
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff < 60e3) return '방금 전';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + '분 전';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return '오늘 ' + hm;
  if (days === 1) return '어제 ' + hm;
  if (days < 7) return days + '일 전';
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
function highlight(text, q) {
  let out = esc(text);
  if (!q.trim()) return out;
  q.trim().split(/\s+/).forEach(tok => {
    if (!tok) return;
    const re = new RegExp('(' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}
const IMG_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg','avif','tif','tiff','ico','heic','heif','jfif','pjp','pjpeg'];
function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['xls','xlsx','csv'].includes(ext)) return 'file-spreadsheet';
  if (['doc','docx','hwp','txt','md','rtf'].includes(ext)) return 'file-text';
  if (ext === 'pdf') return 'file';
  if (['zip','rar','7z','tar','gz','bz2'].includes(ext)) return 'file-archive';
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'file-audio';
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'file-video';
  if (['ppt','pptx','key'].includes(ext)) return 'presentation';
  return 'paperclip';
}
function isImage(mime, name) {
  if ((mime || '').toLowerCase().startsWith('image/')) return true;
  const ext = String(name || '').split('.').pop().toLowerCase().split('?')[0];
  return IMG_EXTS.includes(ext);
}
// 인라인 이미지 마커: ![이름](file:123), 너비 포함 시 ![이름|300](file:123)
function markerIds(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/!\[.*?\]\(file:(\d+)\)/g)) set.add(Number(m[1]));
  return set;
}
function parseMarkerAlt(alt) {
  const m = /^(.*)\|(\d+)$/.exec(alt);
  return m ? { alt: m[1], width: +m[2] } : { alt, width: 0 };
}
// 메모 파일 칩 다운로드 (F-L6: list.js·pane.js 30줄 verbatim 통합).
// 잠긴 파일은 f.url(암호문 Cloudinary URL)을 직접 받으면 암호문 파일이
// 내려간다 — 복호화 서빙 경로(/content)로 받아야 원본이 내려간다 (트랙 D).
async function downloadMemoFile(f) {
  const srcUrl = f.is_locked ? '/api/memo/files/' + f.id + '/content' : f.url;
  try {
    // 잠긴 파일은 보호 게이트 대상 — 403이면 PIN 모달 후 재시도한다.
    const resp = f.is_locked ? await window._fetchStepUp(srcUrl) : await fetch(srcUrl);
    if (!resp.ok) throw new Error('download_failed');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // 잠긴 파일은 게이트 403 페이지를 새 탭으로 여는 폴백이 무의미하다.
    if (f.is_locked) { toast('파일이 열 수 없어요. PIN 확인이 필요합니다.'); return; }
    window.open(srcUrl, '_blank');
  }
}

/* ================= 잠금 메모 공용 컴포넌트 (I-03) =================
   잠금 3단계(메모 잠금·민감도)를 아이콘이 아닌 긴 레벨로 바꿔줄 수 있는
   는 공용 메모. 전 메모 컴포넌트(본문 등 지정)는 이 보여줄 모드(즉시 적용)가
   공유한다. 클래스ID의 공용 규칙으로 myhub- 접두사를 낸다 (스타일
   memo.html의 myhub-lock 스타일 블록).
   민감도 등급은 서버 기준(migrations/0013·secret-mask)과 같다:
   0=일반·1=내부(AI 허용), 2=기밀·3=비밀정보(AI 차단). 기본값은 DB 기본 1. */
const MEMO_SENSITIVITY_LEVELS = [
  { value: 0, label: '일반', desc: 'AI가 읽을 수 있어요' },
  { value: 1, label: '내부', desc: 'AI가 읽을 수 있어요' },
  { value: 2, label: '기밀', desc: 'AI가 읽을 수 없어요' },
  { value: 3, label: '비밀정보', desc: 'AI가 읽을 수 없어요' },
];
function memoSensitivityLabel(v) {
  const lv = MEMO_SENSITIVITY_LEVELS.find((l) => l.value === v);
  return lv ? lv.label : '내부';
}
function normalizeMemoLockState(state) {
  const s = state || {};
  const sens = typeof s.sensitivity === 'number' ? Math.max(0, Math.min(3, s.sensitivity)) : 1;
  return { locked: !!s.locked, sensitivity: sens };
}
function memoLockStateLabel(state) {
  const s = normalizeMemoLockState(state);
  return (s.locked ? '잠금 · ' : '') + memoSensitivityLabel(s.sensitivity);
}
/* 저장된 메모의 잠금 설정을 기존 API로 적용한다 (컴포넌트 생성 직후에).
   순서: 민감도 선 잠금. 잠금은 마지막에 거는 이유가 제목 위의 본문 PUT을
   step-up 게이트가 걸기 때문이다 등 등 함수 생성 흐름의 모든 본문·파일
   저장이 끝난 뒤에 호출해야 한다. 기본값(잠금 해제·민감도 1=DB 기본)과
   같은 항목은 호출하지 않는다. 잠금 해제는 오류가 않는다(컴포넌트 신규
   메모 적용하고, 해제는 보여줄·편집 모드의 기존 경로가 대행한다). */
async function applyMemoLockSettings(memoId, settings) {
  const s = normalizeMemoLockState(settings);
  const failed = [];
  if (s.sensitivity !== 1) {
    try {
      const res = await fetch('/api/memo/' + memoId + '/sensitivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sensitivity: s.sensitivity }),
      });
      if (!res.ok) failed.push('sensitivity');
    } catch (e) { failed.push('sensitivity'); }
  }
  if (s.locked) {
    try {
      const res = (typeof fetchLockWithPin === 'function')
        ? await fetchLockWithPin('/api/memo/' + memoId + '/lock', { locked: true })
        : await fetch('/api/memo/' + memoId + '/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked: true }),
        });
      if (!res.ok) failed.push('lock');
    } catch (e) { failed.push('lock'); }
  }
  return { ok: failed.length === 0, failed };
}
/* 레벨 넣는 "잠금" 메뉴를 만든다.
   opts: { state:{locked,sensitivity}, onChange(nextState, changedKey) }
   onChange가 false를 알려주면(적용 실패) 선택을 되돌린다. 그 뒤에
   반환값을 기다려 등 내부 상태를 갱신한다 (컴포넌트 닫기만 생기고,
   보여줄 모드의 onChange 안에 API를 호출한다). */
function buildMemoLockMenu(opts) {
  const onChange = (opts && opts.onChange) || (async () => true);
  let state = normalizeMemoLockState(opts && opts.state);
  const wrap = document.createElement('span');
  wrap.className = 'myhub-lock-menu';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'myhub-lock-btn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', '잠금 설정');
  const panel = document.createElement('div');
  panel.className = 'myhub-lock-panel';
  panel.hidden = true;
  function renderBtn() {
    btn.innerHTML = '<i data-lucide="lock"></i><span class="myhub-lock-btn-label">잠금</span>'
      + '<span class="myhub-lock-state">' + esc(memoLockStateLabel(state)) + '</span>';
    if (typeof refreshIcons === 'function') refreshIcons();
  }
  function renderPanel() {
    panel.innerHTML = '';
    const lockHead = document.createElement('div');
    lockHead.className = 'myhub-lock-head';
    lockHead.textContent = '메모 잠금';
    panel.appendChild(lockHead);
    const lockGroup = document.createElement('div');
    lockGroup.setAttribute('role', 'radiogroup');
    lockGroup.setAttribute('aria-label', '메모 잠금');
    [
      { locked: false, label: '잠그지 않음', desc: 'AI가 이 메모를 읽을 수 있어요' },
      { locked: true, label: '메모 잠금', desc: '본문을 암호화하고 AI 접근을 막아요' },
    ].forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'myhub-lock-opt' + (state.locked === o.locked ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', state.locked === o.locked ? 'true' : 'false');
      b.dataset.lockValue = o.locked ? '1' : '0';
      b.innerHTML = '<span class="myhub-lock-opt-label">' + esc(o.label) + '</span>'
        + '<span class="myhub-lock-opt-desc">' + esc(o.desc) + '</span>';
      b.addEventListener('click', async () => {
        const next = { locked: o.locked, sensitivity: state.sensitivity };
        if (next.locked === state.locked) { closePanel(); return; }
        const ok = await onChange(next, 'locked');
        if (ok === false) return;
        state = next;
        renderBtn(); renderPanel(); closePanel();
      });
      lockGroup.appendChild(b);
    });
    panel.appendChild(lockGroup);
    const sensHead = document.createElement('div');
    sensHead.className = 'myhub-lock-head';
    sensHead.textContent = '민감도';
    panel.appendChild(sensHead);
    const sensGroup = document.createElement('div');
    sensGroup.setAttribute('role', 'radiogroup');
    sensGroup.setAttribute('aria-label', '민감도');
    MEMO_SENSITIVITY_LEVELS.forEach((lv) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'myhub-lock-opt' + (state.sensitivity === lv.value ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', state.sensitivity === lv.value ? 'true' : 'false');
      b.dataset.sensValue = String(lv.value);
      b.innerHTML = '<span class="myhub-lock-opt-label">' + esc(lv.label) + '</span>'
        + '<span class="myhub-lock-opt-desc">' + esc(lv.desc) + '</span>';
      b.addEventListener('click', async () => {
        const next = { locked: state.locked, sensitivity: lv.value };
        if (next.sensitivity === state.sensitivity) { closePanel(); return; }
        const ok = await onChange(next, 'sensitivity');
        if (ok === false) return;
        state = next;
        renderBtn(); renderPanel(); closePanel();
      });
      sensGroup.appendChild(b);
    });
    panel.appendChild(sensGroup);
  }
  function closePanel() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }
  function onDocDown(e) { if (!wrap.contains(e.target)) closePanel(); }
  function onKeyDown(e) { if (e.key === 'Escape') closePanel(); }
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel.hidden) {
      renderPanel();
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    } else {
      closePanel();
    }
  });
  wrap.append(btn, panel);
  renderBtn();
  renderPanel();
  // 호출자 상태를 옵션으로 갈아끼울 때(컴포넌트 설정 등 초기화) 낸다.
  wrap._setMemoLockState = (next) => { state = normalizeMemoLockState(next); renderBtn(); renderPanel(); };
  wrap._getMemoLockState = () => ({ locked: state.locked, sensitivity: state.sensitivity });
  return wrap;
}

// 메모 텍스트에서 제목과 본문 분리
function extractTitle(text) {
  if (!text) return { title: '', body: '' };
  const lines = String(text).split('\n');
  const firstLine = (lines[0] || '').trim();
  // 제목 입력칸이 비어도 드롭다운 등 서식 태그(<span style=등>)는 마크다운
  // 이스케이프 번호를 끼는다 (태그가 제목에 그대로 보이고 싶고 방지).
  // 태그만 넣는 줄이면 제목에 없는 것으로 본다.
  let title = firstLine
    .replace(/<[^>]*>/g, '')
    .replace(/\\([!-/:-@\[-`{-~])/g, '$1')
    .trim();
  // 둘째 합성(savePane·블록 잠금)는 제목 앞에 붙이는 마크다운 제목
  // 마지막(# )는 서식이지 제목 텍스트가 아니다. 표시 규칙(rowTitle의
  // ^#{1,6} 제거, renderBodyHtml의 제목 중 제거)와 같은 공유로
  // 여기서도 번호를 등 번호지 않으면 등 내용이 '# ' + '# 제목'으로
  // 합성된 편집·내용 반복된 끝나면 #은 나머지 귀결된다
  // (2026-11-05 아침 배포에서 씌움). 내부 개별 확인 형태(# # 제목)는
  // 반복 제거로 등 번에 정상화한다. # 등 공백이 없는 해시태그는
  // 마지막이 아니면 건드리지 않는다.
  while (/^#{1,6}\s+/.test(title)) title = title.replace(/^#{1,6}\s+/, '').trim();
  // 첫 줄이 짧으면 제목으로
  if (title && title.length <= 60 && lines.length > 1) {
    return { title, body: lines.slice(1).join('\n').trim() };
  }
  return { title: '', body: text };
}
