// esc·friendlyError는 공용 코어(common/text-utils.js)가 맡는다 (F-L3, 5-4).
// 코어는 이 파일보다 먼저 받아야 한다 (chat.html 정적 태그 순서).
// escapeHtml은 호출처가 많아 이름을 유지한 채 코어 esc의 별칭으로 둔다.
const textUtils = typeof window !== 'undefined' ? window.MyHubTextUtils : null;
if (!textUtils) throw new Error('[chat.js] text-utils.js가 먼저 로드되어야 합니다');
const escapeHtml = textUtils.esc;
const friendlyError = textUtils.friendlyError;

const $ = (id) => document.getElementById(id);
let personas = [];
let history = [];
let sending = false;
let currentConvId = null; // 새 대화는 서버가 자동 생성
let conversations = [];
let lastSender = null;

// I-02 (2026-11-05): 채팅 무제한 대기 해소 — 타임아웃·취소·재시도를 표시.
// 서버 파이프라인(1차 LLM호출과 첫fetch와2차 LLM)이 길어질 수 있어
// 55초에서 자동 중단하고, 8초가 지나면 경고 문구를 보여준다.
// 값은 window.MyHubChatTiming으로 노출해 테스트·뒤에서 조정할 수 있다.
const chatTiming = { timeoutMs: 55000, progressMs: 8000 };
if (typeof window !== 'undefined') window.MyHubChatTiming = chatTiming;
let activeChatRequest = null; // 진행 중인 본 전송 {controller, timedOut, cancelled, timers[]}

function startChatRequest() {
  const controller = new AbortController();
  const state = { controller, timedOut: false, cancelled: false, timers: [] };
  state.timers.push(setTimeout(() => {
    state.timedOut = true;
    try { controller.abort(); } catch (e) { console.warn('채팅 요청 중단 실패:', e); }
  }, chatTiming.timeoutMs));
  return state;
}
function stopChatRequest(state) {
  if (!state) return;
  (state.timers || []).forEach((t) => clearTimeout(t));
  state.timers = [];
  if (activeChatRequest === state) activeChatRequest = null;
}
// 전송 버튼을 취소 버튼으로 전환 (기존 원형 버튼 UI 유지, Lucide x 아이콘)
const SEND_ICON_HTML = '➤';
const CANCEL_ICON_HTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
function armCancelButton() {
  const btn = $('send');
  btn.disabled = false;
  btn.dataset.mode = 'cancel';
  btn.innerHTML = CANCEL_ICON_HTML;
  btn.title = '전송 취소';
  btn.setAttribute('aria-label', '전송 취소');
}
function resetSendButton() {
  const btn = $('send');
  btn.disabled = false;
  delete btn.dataset.mode;
  btn.innerHTML = SEND_ICON_HTML;
  btn.title = '';
  btn.removeAttribute('aria-label');
}
function cancelActiveChat() {
  if (!activeChatRequest) return;
  activeChatRequest.cancelled = true;
  try { activeChatRequest.controller.abort(); } catch (e) { console.warn('채팅 요청 취소 실패:', e); }
}
// 경고 표시: 타이핑 말풍선 아래 상태 문구를 단계별로 바꾼다 (시간 기반).
function startChatProgress(state, typing) {
  const statusEl = typing ? typing.querySelector('.typing-status') : null;
  if (!statusEl) return;
  state.timers.push(setTimeout(() => {
    statusEl.textContent = '답변을 만들고 있어요. 조금만 더 기다려 주세요.';
    statusEl.style.display = '';
  }, chatTiming.progressMs));
  state.timers.push(setTimeout(() => {
    statusEl.textContent = '아직 답변을 기다리고 있어요. 오래 걸리면 자동으로 중단하고 알려드릴게요.';
    statusEl.style.display = '';
  }, chatTiming.progressMs * 3));
}

// 마크다운 설정 — CDN 도달 불가로 marked가 없을 수 있다. 무겁게 호출하면
// ReferenceError가 스크립트 전체 평가를 중단시켜 채팅이 통째로 죽으므로,
// renderMarkdown은 SEC-001 fail-closed 가드와 같은 조건으로 감싼다
// (라이브러리가 없으면 renderMarkdown은 텍스트로 표시한다).
if (typeof window.marked?.setOptions === "function") {
  window.marked.setOptions({ breaks: true, gfm: true });
}
// 폴백 렌더 (marked/DOMPurify 부재 시): 원문을 먼저 이스케이프한 뒤,
// 이스케이프된 문자열에 한해 기본 마크다운 기호만 패턴으로 정리한다.
// 보안 순서: 변환은 이스케이프 이후의 문자열에만 적용하고 기호 제거만
// 하므로, 태그가 절대로 새로 생길 수 없어 SEC-001 fail-closed가 유지된다.
// (.bubble에는 pre-wrap이 없어 줄바꿈은 <br>로 만든다.)
function renderPlainFallback(raw) {
  const safe = document.createElement("div");
  safe.textContent = raw;
  const escaped = safe.innerHTML;
  const codeSpans = [];
  let inFence = false;
  const lines = escaped.split("\n").map((line) => {
    // 코드 표시: 구분자 줄은 버리고, 표시 안의 줄은 기호 변환 없이 그대로 둔다
    if (/^\s*```/.test(line)) { inFence = !inFence; return null; }
    if (inFence) return line;
    // 수평선·표 구분자 줄은 버린다
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return null;
    if (/^[\s|:-]+$/.test(line) && line.includes("|") && line.includes("-")) return null;
    let out = line
      .replace(/^#{1,6}\s+/, "") // 제목 기호
      .replace(/^&gt;\s?/, "") // 인용 기호 (이스케이프된 '>')
      .replace(/^[*+]\s+/, "- "); // 글머리 기호 통일
    // 인라인 코드 구간은 먼저 보호한다 (안의 기호는 변환하지 않음)
    out = out.replace(/`([^`\n]+)`/g, (m, c) => {
      codeSpans.push(c);
      return `\uE000${codeSpans.length - 1}\uE001`;
    });
    out = out
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // 이미지 → 대체 텍스트
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1") // 링크 → 링크 텍스트
      .replace(/\*\*([^*\n]+)\*\*/g, "$1") // 굵게
      .replace(/~~([^~\n]+)~~/g, "$1") // 취소선
      .replace(/\*([^*\n]+)\*/g, "$1"); // 기울임
    return out.replace(/\uE000(\d+)\uE001/g, (m, i) => codeSpans[Number(i)]);
  });
  return lines.filter((l) => l !== null).join("<br>");
}
function renderMarkdown(text) {
  const raw = String(text ?? "");
  // SEC-001: Fail-closed - DOMPurify와 marked가 없으면 텍스트로 표시
  if (typeof window.marked?.parse !== "function" ||
      typeof window.DOMPurify?.sanitize !== "function") {
    return renderPlainFallback(raw);
  }
  try {
    const html = window.marked.parse(raw);
    // SEC-001: 정제되지 않은 HTML은 DOM에 삽입하기 전 최종 정제
    // (detached div로도 innerHTML 삽입 전 정제가 보안상 안전)
    const firstClean = window.DOMPurify.sanitize(html);
    const tmp = document.createElement('div');
    tmp.innerHTML = firstClean;
    // 하이라이트 적용 (정제된 HTML에만)
    tmp.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (e) { console.warn('코드 하이라이트 실패:', e); }
    });
    // SEC-001: 하이라이트 후 최종 정제 (하이라이트가 마크업 변경 가능)
    return window.DOMPurify.sanitize(tmp.innerHTML);
  } catch {
    return renderPlainFallback(raw);
  }
}

async function loadPersonas() {
  try {
    const r = await fetch('/api/ai/personas');
    personas = await r.json() || [];
  } catch { personas = []; }
  if (!personas.length) {
    personas = [
      { id: 'concierge', name: '루미', avatar: '/avatars/rumi-128.webp', desc: '일상 비서' },
      { id: 'keeper', name: '에코', avatar: '/avatars/echo-128.webp', desc: '기록 담당' },
      { id: 'builder', name: '노바', avatar: '/avatars/nova-128.webp', desc: '만들기 담당' },
      { id: 'scheduler', name: '캘리', avatar: '/avatars/cali-128.webp', desc: '일정·할일 담당' },
    ];
  }
  // 우측 토스트 참여자 목록 (N-03: 서버 문자열은 전부 escapeHtml 경유 —
  // 특히 이름·설명·아바타 URL은 태그/따옴표 앞에 깨지지 않는다)
  $('participantList').innerHTML = personas.map((p) =>
    `<div class="participant"><img src="${escapeHtml(p.avatar)}" alt="">` +
    `<div class="pinfo"><div class="pname">${escapeHtml(p.name)}</div><div class="pdesc">${escapeHtml(p.desc || '')}</div></div>` +
    `<div class="online-dot"></div></div>`).join('');
}

function todayDivider() {
  const d = new Date();
  const str = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`;
  const div = document.createElement('div');
  div.className = 'date-divider';
  div.textContent = str;
  $('msgs').appendChild(div);
}

function addMsg(role, text, personaId, meta, sources, images, messageId, approvalRequests) {
  const wrap = $('msgs');
  const persona = personas.find((p) => p.id === personaId);
  const isMine = role === 'user';

  // 같은 사람이 연속으로 말하면 그룹을 추가
  let group = wrap.lastElementChild;
  const groupKey = isMine ? 'mine' : personaId;
  if (!group || !group.classList.contains('msg-group') ||
      group.dataset.sender !== groupKey || group.classList.contains('typing-group')) {
    group = document.createElement('div');
    group.className = 'msg-group' + (isMine ? ' mine' : '');
    group.dataset.sender = groupKey;
    const row = document.createElement('div');
    row.className = 'msg-row';
    if (!isMine && persona) {
      row.innerHTML = `<img class="avatar" src="${escapeHtml(persona.avatar)}" alt="">` +
        `<div class="content"><div class="sender">${escapeHtml(persona.name)}</div></div>`;
    } else {
      row.innerHTML = `<div class="content"></div>`;
    }
    group.appendChild(row);
    wrap.appendChild(group);
  }

  const content = group.querySelector('.content');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  // AI 생성 이미지 표시
  if (images && images.length > 0) {
    images.forEach((img) => {
      const imgEl = document.createElement('img');
      imgEl.src = img.url;
      imgEl.alt = img.prompt;
      imgEl.className = 'generated-image';
      imgEl.loading = 'lazy';
      bubble.appendChild(imgEl);
    });
  }
  // 출처 표시 (검색 grounding)
  // 제목이 "최신이슈", "다음이슈" 같은 포털 이름뿐인 경우가 있어 도메인을 함께 표시한다
  if (sources && sources.length > 0) {
    const srcDiv = document.createElement('div');
    srcDiv.className = 'sources';
    srcDiv.innerHTML = '<div class="sources-title">출처</div>' +
      sources.map((s, i) => {
        let host = '';
        try { host = new URL(s.url).hostname; } catch (e) { console.warn('출처 URL 파싱 실패:', e); }
        const label = host ? `${escapeHtml(s.title)} · ${escapeHtml(host)}` : escapeHtml(s.title);
        return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="source-link">${i + 1}. ${label}</a>`;
      }).join('');
    bubble.appendChild(srcDiv);
  }
  content.appendChild(bubble);
  // 승인 요청 버튼 (b트랙): 가장 최근 대기 요청 1건에 대해 승인/세션 허용/거부.
  // 버튼의 텍스트 명령("승인해" 등)을 입력창에 넣어 기존 send() 경로를 사용한다.
  // 여러 요청이 대기 중이면 가장 최근 것만 버튼으로, 나머지는 텍스트로 통합한다.
  if (!isMine && approvalRequests && approvalRequests.length > 0) {
    const latest = approvalRequests[approvalRequests.length - 1];
    const bar = document.createElement('div');
    bar.className = 'approval-bar';
    const extra = approvalRequests.length > 1
      ? `<span class="approval-pending-note">외 ${approvalRequests.length - 1}건 요청 대기 중</span>`
      : '';
    bar.innerHTML =
      `<button type="button" class="approval-btn approval-btn-approve" data-reply="승인해">승인</button>` +
      `<button type="button" class="approval-btn" data-reply="이 세션 허용해">이 세션 허용</button>` +
      `<button type="button" class="approval-btn approval-btn-deny" data-reply="거부해">거부</button>` +
      extra;
    bar.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (sending) return;
        bar.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        $('input').value = btn.dataset.reply;
        send();
      });
    });
    bar.dataset.tool = latest.tool || '';
    content.appendChild(bar);
  }
  // Phase 3C: 피드백 버튼 (AI 답변에만, messageId가 있을 때)
  // 모델명 복사 버튼 우측에 표시
  if (!isMine && messageId) {
    const fbDiv = createFeedbackButtons(messageId, text, meta);
    content.appendChild(fbDiv);
    // 기존 피드백 상태 복원
    loadFeedbackState(messageId, fbDiv);
  }
  wrap.scrollTop = wrap.scrollHeight;
  lastSender = groupKey;
}

function showTyping(personaId) {
  const persona = personas.find((p) => p.id === personaId);
  if (!persona) return null;
  const wrap = $('msgs');
  const div = document.createElement('div');
  div.className = 'msg-group typing-group';
  div.dataset.sender = '__typing__';
  div.innerHTML = `<div class="typing-row">` +
    `<img class="avatar" src="${escapeHtml(persona.avatar)}" alt="">` +
    `<div><div class="sender" style="font-size:13px;font-weight:600;margin-bottom:6px;">${escapeHtml(persona.name)}</div>` +
    `<div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>` +
    `<div class="typing-status" role="status" style="display:none;font-size:12px;color:#5f6368;margin-top:2px;"></div></div></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

// ===== 라우팅 =====
function routeMessage(text) {
  // 1. @멘션 (비서 카드 선택은 입력창에 @멘션을 채우는 방식이라, 명시 선택은
  //    키워드 라우팅보다 항상 우선한다 — tests/chat-p3-fallback-routing가 고정)
  const mention = text.match(/@(\S+)/);
  if (mention) {
    const name = mention[1];
    const p = personas.find((x) => x.name === name || x.id === name);
    if (p) return { personaId: p.id, clean: text.replace(mention[0], '').trim(), routedBy: 'mention' };
  }
  // 2. 키워드 라우팅
  const t = text.toLowerCase();
  const novaKw = ['코드', '만들기', '버그', '함수', '개발', '프로그램', '팩토리', '게임', '모듈', 'api'];
  const echoKw = ['메모', '기억', '요약', '정리해', '잊지마', '기록'];
  const caliKw = ['일정', '스케줄', '할일', '할 일', '약속', '예약', '캘린더', '리마인드', '미리알림', '치과', '병원', '회의'];
  if (novaKw.some((k) => t.includes(k))) return { personaId: 'builder', clean: text, routedBy: 'keyword' };
  if (echoKw.some((k) => t.includes(k))) return { personaId: 'keeper', clean: text, routedBy: 'keyword' };
  if (caliKw.some((k) => t.includes(k))) return { personaId: 'scheduler', clean: text, routedBy: 'keyword' };
  // 3. 기본: 루미
  return { personaId: 'concierge', clean: text };
}

// 서버 오류 응답에서 표시할 문구를 만든다 (객체로 오면 맵이 code를 먼저
// 객체 그대로 [object Object]·원시 코드 노출 방지. send와 sendRegenerate 공용)
function chatErrorText(d, fallback) {
  return friendlyError(d, fallback);
}

async function send() {
  const text = $('input').value.trim();
  if (!text || sending) return;
  hideLanding(); // 랜딩 숨기기
  sending = true;
  $('send').disabled = true;
  $('mentionPopup').classList.remove('show');

  addMsg('user', text);
  $('input').value = '';
  $('input').style.height = 'auto';

  // 이미지 생성 명령어: /이미지 또는 /image
  const imgMatch = text.match(/^\/(이미지|image)\s+(.+)/s);
  if (imgMatch) {
    await sendImage(imgMatch[2].trim());
    sending = false;
    $('send').disabled = false;
    $('input').focus();
    return;
  }

  // GitHub 검색 명령어: /깃허브 또는 /github
  const ghMatch = text.match(/^\/(깃허브|github)\s+(.+)/s);
  if (ghMatch) {
    await sendGithub(ghMatch[2].trim());
    sending = false;
    $('send').disabled = false;
    $('input').focus();
    return;
  }

  const { personaId, clean, routedBy } = routeMessage(text);
  const persona = personas.find((p) => p.id === personaId);
  history.push({ role: 'user', content: text });
  // I-08: 키워드 자동 라우팅으로 대상이 바뀌면 조용히 하지 않고 고정한다
  // (명시 @멘션·기본 루미는 사용자가 이미 아는 선택이라 고정하지 않는다).
  if (routedBy === 'keyword' && persona) {
    addMsg('assistant', `말씀하신 내용에 맞게 담당 비서를 ${persona.name}(으)로 바꿨어요. 다른 비서에게 묻고 싶으면 @로 지정해 주세요.`, personaId);
  }

  const typing = showTyping(personaId);

  // I-02: 타임아웃(55초)취소(전송 버튼 전환)경고 표시를 건다
  const reqState = startChatRequest();
  activeChatRequest = reqState;
  startChatProgress(reqState, typing);
  armCancelButton();

  try {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId, conversationId: currentConvId, messages: history.slice(-20) }),
      signal: reqState.controller.signal,
    });
    // 응답을 받았지만 본문이 JSON이 아니면(서버 500의 HTML 응답 등)
    // 연결 실패와 구분해 서버 오류로 고정한다
    const d = await r.json().catch(() => null);
    if (typing) typing.remove();
    if (!d) {
      addMsg('assistant', '서버 응답을 읽지 못했어요. 서버에서 문제가 생겼을 수 있어요 잠시 후 다시 시도해 주세요.', personaId);
    } else if (d.ok) {
      // 서버가 생성한 conversationId를 저장 (연속 대화용)
      if (d.conversationId && d.conversationId !== currentConvId) {
        currentConvId = d.conversationId;
      }
      history.push({ role: 'assistant', content: d.text, personaId });
      // 모델명을 간결하게 (provider prefix 제거)
      // 파이프라인 정보가 있으면 함께 표시 (예: "검색: Exa, 작성: gemini-3.5-flash-lite")
      let modelLabel = (d.model || '').split('/').pop() || '';
      if (d.pipeline) {
        modelLabel = d.pipeline;
      }
      // 폴백 정보는 사용자에게 노출하지 않음 (내부용)
      // Phase 3C: messageId 전달 (피드백 연결용)
      addMsg('assistant', d.text, personaId, modelLabel, d.sources, d.images, d.messageId, d.approvalRequests);
    } else if (d.error === 'CONVERSATION_NOT_FOUND' || d.error?.code === 'CONVERSATION_NOT_FOUND') {
      // 대화가 없으면 새로 시작 (ID 초기화 후 재시작하지 않고 안내)
      currentConvId = null;
      addMsg('assistant', '대화를 찾을 수 없어 새 대화를 시작합니다. 말씀해 주세요.', personaId);
    } else {
      // I-09: 원시 오류 코드는 맵을 거친 문구로만 표시한다 (HTTP 상태와 함께)
      addMsg('assistant', chatErrorText({ error: d.error, status: r.status }, '답변을 받지 못했어요. 잠시 후 다시 시도해 주세요.'), personaId);
    }
  } catch (e) {
    if (typing) typing.remove();
    // I-02: 타임아웃·취소와 연결 실패를 서로 구분해 고정한다
    if (reqState.timedOut) {
      addMsg('assistant', '답변이 너무 오래 걸려 중단했어요. 잠시 후 다시 시도해 주세요.', personaId);
    } else if (reqState.cancelled) {
      addMsg('assistant', '전송이 취소됐어요.', personaId);
    } else {
      console.warn('채팅 연결 실패:', e);
      addMsg('assistant', '연결에 실패했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', personaId);
    }
  } finally {
    stopChatRequest(reqState);
    resetSendButton();
  }
  sending = false;
  $('send').disabled = false;
  $('input').focus();
}

// ===== 이미지 생성 =====
async function sendImage(prompt) {
  const typing = showTyping('concierge');
  try {
    const r = await fetch('/api/ai/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const d = await r.json();
    if (typing) typing.remove();
    if (d.ok) {
      addImageMsg(d.url, prompt);
    } else {
      addMsg('assistant', friendlyError(d, '이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.'), 'concierge');
    }
  } catch {
    if (typing) typing.remove();
    addMsg('assistant', '이미지 생성 연결 실패.', 'concierge');
  }
}

function addImageMsg(url, prompt) {
  const wrap = $('msgs');
  const group = document.createElement('div');
  group.className = 'msg-group';
  group.dataset.sender = 'concierge';
  group.innerHTML = `<div class="msg-row"><img class="avatar" src="/avatars/rumi-128.webp" alt="">` +
    `<div class="content"><div class="sender">루미</div>` +
    `<div class="bubble"><img src="${escapeHtml(url)}" alt="${escapeHtml(prompt)}" class="generated-image" loading="lazy">` +
    `<div class="meta">이미지 생성: ${escapeHtml(prompt.slice(0, 50))}</div></div></div></div>`;
  wrap.appendChild(group);
  wrap.scrollTop = wrap.scrollHeight;
}

// ===== GitHub 검색 =====
async function sendGithub(query) {
  const typing = showTyping('concierge');
  try {
    const r = await fetch('/api/ai/github?q=' + encodeURIComponent(query));
    const d = await r.json();
    if (typing) typing.remove();
    if (d.ok && d.items.length > 0) {
      const md = d.items.map((it, i) =>
        `${i + 1}. **[${it.name}](${it.url})** ⭐ ${it.stars}\n   ${it.desc || ''} ${it.lang ? `(${it.lang})` : ''}`
      ).join('\n\n');
      addMsg('assistant', `GitHub 검색 결과 (${query}):\n\n${md}`, 'concierge', 'github');
    } else {
      addMsg('assistant', 'GitHub 검색 결과 없음: ' + query, 'concierge');
    }
  } catch {
    if (typing) typing.remove();
    addMsg('assistant', 'GitHub 검색 연결 실패.', 'concierge');
  }
}

// ===== @멘션 자동완성 =====
$('input').addEventListener('input', () => {
  const v = $('input').value;
  const atMatch = v.match(/@(\S*)$/);
  const popup = $('mentionPopup');
  if (atMatch) {
    const q = atMatch[1].toLowerCase();
    const matched = personas.filter((p) =>
      p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    if (matched.length) {
      popup.innerHTML = matched.map((p) =>
        `<div class="mention-item" data-name="${escapeHtml(p.name)}">` +
        `<img src="${escapeHtml(p.avatar)}" alt=""><div><div class="mname">@${escapeHtml(p.name)}</div>` +
        `<div class="mdesc">${escapeHtml(p.desc || '')}</div></div></div>`).join('');
      popup.classList.add('show');
      popup.querySelectorAll('.mention-item').forEach((el) => {
        el.onclick = () => {
          $('input').value = v.replace(/@\S*$/, '@' + el.dataset.name + ' ');
          popup.classList.remove('show');
          $('input').focus();
        };
      });
      return;
    }
  }
  popup.classList.remove('show');
});

// 전송 중에는 같은 버튼이 취소 버튼으로 동작한다 (I-02)
$('send').onclick = () => {
  if (activeChatRequest) { cancelActiveChat(); return; }
  send();
};
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') $('mentionPopup').classList.remove('show');
});
$('input').addEventListener('input', () => {
  $('input').style.height = 'auto';
  $('input').style.height = Math.min($('input').scrollHeight, 120) + 'px';
});

// ===== 설정 패널 =====
// (settingsBtn2 이벤트는 bindNavButtons에서 연결)
$('settingsClose').onclick = closeSettings;
$('settingsOverlay').onclick = closeSettings;
function closeSettings() {
  $('settingsPanel').classList.remove('open');
  $('settingsOverlay').classList.remove('show');
}

const CAPABILITIES = [
  { id: 'chat', name: '대화 (루미)', provider: 'gemini', providerName: 'Gemini' },
  { id: 'summarize', name: '요약·기록 (에코)', provider: 'workers-ai', providerName: '이중 구조 (메모 턴 Workers AI · 비메모 턴 NVIDIA)', note: '여기서 고른 모델은 메모 턴(Workers AI)에만 적용돼요. 비메모 턴은 NVIDIA nemotron 고정이에요.' },
  { id: 'code', name: '코드·빌드 (노바)', provider: 'gemini', providerName: 'Gemini' },
  { id: 'schedule', name: '일정·할일 (캘리)', provider: 'groq', providerName: 'Groq' },
];
let allModels = [];
let allSettings = {};

async function loadSettings() {
  try {
    const [mr, sr, qr] = await Promise.all([
      fetch('/api/ai/models').then((r) => r.json()),
      fetch('/api/ai/settings').then((r) => r.json()),
      fetch('/api/ai/quota').then((r) => r.json()),
    ]);
    allModels = (mr.models || []).filter((m) => m.status === 'active');
    allSettings = sr.settings || {};
    renderModelRows();
    renderFlagRows();
    renderQuotaRows(qr);
  } catch (e) { console.warn('모델 목록 로드 실패:', e); }
}

function renderModelRows() {
  const wrap = $('modelRows');
  wrap.innerHTML = '';
  CAPABILITIES.forEach((cap) => {
    const row = document.createElement('div');
    row.className = 'model-row';
    // 프로바이더는 고정 표시 (변경 불가), 모델만 해당 프로바이더 안에서 선택
    row.innerHTML = `<label>${escapeHtml(cap.name)}</label>
      <div style="font-size:12px;color:#5f6368;margin:2px 0 4px;">📌 ${escapeHtml(cap.providerName)} 고정</div>` +
      (cap.note ? `<div style="font-size:12px;color:#5f6368;margin:0 0 4px;">${escapeHtml(cap.note)}</div>` : '');
    const sel = document.createElement('select');
    // 해당 프로바이더의 모델만 표시 (N-03: 모델 id는 서버 문자열 — 속성·텍스트 모두 이스케이프)
    const providerModels = allModels.filter((m) => m.provider === cap.provider);
    sel.innerHTML = `<option value="">자동 (추천)</option>` +
      providerModels.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('');
    sel.value = allSettings[`model.${cap.id}`] || '';
    sel.onchange = async () => {
      await fetch('/api/ai/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: `model.${cap.id}`, value: sel.value }),
      });
    };
    row.appendChild(sel);
    wrap.appendChild(row);
  });
}

// ===== 기능 설정 (H-05) =====
// 서버 허용 목록(src/services/ai-settings-spec.ts)과 짝을 이루는 목록이다.
// 여기 없는 다른 제품 안에선 켤 수 없고, 서버는 목록 밖 값을 거부한다.
// budget.<provider>는 이 목록에 넣지 않는다 — 기록된(미집계) 표시 전용(H-04).
const FLAG_SETTINGS = [
  { key: 'ai.emergency_disable', label: '긴급 차단 (전체 비서)', kind: 'enum', options: [['', '이제'], ['all', '전체 차단']] },
  { key: 'clef.router_mode', label: 'Clef 라우터', kind: 'enum', options: [['off', 'off'], ['shadow', 'shadow'], ['active', 'active']] },
  { key: 'memory.v2_enabled', label: '장기 기억 v2', kind: 'bool' },
  { key: 'memory.legacy_enabled', label: '레거시 기억', kind: 'bool' },
  { key: 'memory.llm_extract_enabled', label: '메모 저장 시 LLM 사실 추출 (비용·지연 추가)', kind: 'bool' },
  { key: 'memory.llm_reflection_enabled', label: 'LLM 성찰', kind: 'bool' },
  { key: 'memory.llm_consolidation_enabled', label: 'LLM 기억 통합', kind: 'bool' },
  { key: 'ai.prompt_v2', label: '프롬프트 v2 (전역)', kind: 'bool' },
  { key: 'ai.marker_mode', label: '마커 모드', kind: 'enum', options: [['off', 'off'], ['shadow', 'shadow']] },
  { key: 'voice.daily_limit', label: '음성 일일 상한 (회)', kind: 'number' },
];
// 비서별 플래그 — 서버 스펙의 <persona> 자리에 실제 비서 id가 들어간다.
const FLAG_PERSONAS = [
  { id: 'concierge', name: '루미' },
  { id: 'keeper', name: '에코' },
  { id: 'builder', name: '노바' },
  { id: 'scheduler', name: '캘리' },
];
FLAG_PERSONAS.forEach((p) => {
  FLAG_SETTINGS.push({ key: `ai.engine_v2.${p.id}`, label: `엔진 v2 (${p.name})`, kind: 'enum', options: [['', '기본값'], ['fc', 'fc'], ['marker', 'marker']] });
  FLAG_SETTINGS.push({ key: `ai.prompt_v2.${p.id}`, label: `프롬프트 v2 (${p.name})`, kind: 'bool' });
});

async function saveSetting(key, value) {
  const r = await fetch('/api/ai/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || '설정 저장 실패');
  allSettings[key] = value;
}

function renderFlagRows() {
  const wrap = $('flagRows');
  if (!wrap) return;
  wrap.innerHTML = '';
  FLAG_SETTINGS.forEach((def) => {
    const row = document.createElement('div');
    row.className = 'model-row';
    const label = document.createElement('label');
    label.textContent = def.label;
    row.appendChild(label);
    const current = allSettings[def.key] || '';
    if (def.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = current === 'true';
      input.onchange = async () => {
        try { await saveSetting(def.key, input.checked ? 'true' : 'false'); }
        catch (e) { input.checked = !input.checked; alert(e.message); }
      };
      row.appendChild(input);
    } else if (def.kind === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.value = current;
      input.placeholder = '기본 100';
      input.onchange = async () => {
        try { await saveSetting(def.key, input.value); }
        catch (e) { input.value = allSettings[def.key] || ''; alert(e.message); }
      };
      row.appendChild(input);
    } else {
      const sel = document.createElement('select');
      sel.innerHTML = def.options.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join('');
      sel.value = current;
      sel.onchange = async () => {
        try { await saveSetting(def.key, sel.value); }
        catch (e) { sel.value = allSettings[def.key] || ''; alert(e.message); }
      };
      row.appendChild(sel);
    }
    wrap.appendChild(row);
  });
}

function renderQuotaRows(qr) {
  const wrap = $('quotaRows');
  wrap.innerHTML = '';
  const usage = qr.usage || [];
  const budgets = qr.budgets || {};
  const names = { 'gemini': 'Gemini', 'groq': 'Groq', 'workers-ai': 'Workers AI' };
  if (!usage.length) wrap.innerHTML = '<div style="font-size:13px;color:var(--dim)">오늘 사용 기록이 없어요.</div>';
  usage.forEach((u) => {
    const budget = budgets[u.provider];
    const pct = budget ? Math.min(100, Math.round((u.requests / budget) * 100)) : 0;
    const tok = (u.in_tok || 0) + (u.out_tok || 0);
    wrap.innerHTML += `<div class="quota-row"><b>${escapeHtml(names[u.provider] || u.provider)}</b> · ${u.requests}건` +
      `${tok ? ` · ${tok.toLocaleString()} 토큰` : ''}` +
      // budget은 기록된(미집계) 값 사용률 바는 참고 표시만 하고 초과해도 차단하지 않는다 (H-04)
      (budget ? `<div style="font-size:12px;color:#5f6368;">기록된 예산 ${budget}건 중 ${pct}% (미집계 · 참고용)</div><div class="quota-bar"><div style="width:${pct}%"></div></div>` : '') + `</div>`;
  });
}

let oldestId = null;
let hasMore = true;
let loadingMore = false;

const CONV_PAGE_SIZE = 50;
let convHasMore = false;
let convNextOffset = null;
let convLoadingMore = false;

async function loadConversations() {
  try {
    const r = await fetch(`/api/ai/conversations?limit=${CONV_PAGE_SIZE}&offset=0`);
    const d = await r.json();
    conversations = d.conversations || [];
    convHasMore = !!d.hasMore;
    convNextOffset = d.nextOffset ?? null;
  } catch { conversations = []; convHasMore = false; convNextOffset = null; }
  renderConvList();
  // 서버가 첫 응답 때 대화 제목을 만들면 목록 구조도 이 창 바도 따라간다
  notifyChatDocTitle();
}

// 이전보기: 다음 페이지를 키에 붙인다 (대화 받은 id의 중복 방지)
async function loadMoreConversations() {
  if (!convHasMore || convNextOffset === null || convLoadingMore) return;
  convLoadingMore = true;
  try {
    const r = await fetch(`/api/ai/conversations?limit=${CONV_PAGE_SIZE}&offset=${convNextOffset}`);
    const d = await r.json();
    const seen = new Set(conversations.map((cv) => cv.id));
    (d.conversations || []).forEach((cv) => { if (!seen.has(cv.id)) conversations.push(cv); });
    convHasMore = !!d.hasMore;
    convNextOffset = d.nextOffset ?? null;
  } catch (e) { console.warn('대화 목록 추가 로드 실패:', e); /* 상태 유지 — 버튼을 다시 눌러 재시도할 수 있다 */ }
  convLoadingMore = false;
  renderConvList();
}

function renderConvList() {
  const wrap = $('convList');
  wrap.innerHTML = '';
  conversations.forEach((cv) => {
    const div = document.createElement('div');
    div.className = 'conv-item' + (cv.id === currentConvId ? ' active' : '');
    div.innerHTML = `<div class="ctitle">${escapeHtml(cv.title || '제목 없음')}</div>` +
      (cv.last_msg ? `<div class="cpreview">${escapeHtml(cv.last_msg.slice(0, 40))}</div>` : '') +
      `<button class="cdel" title="삭제">×</button>`;
    div.onclick = (e) => {
      if (e.target.classList.contains('cdel')) return;
      switchConversation(cv.id);
    };
    div.querySelector('.cdel').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('이 대화를 삭제할까요?')) return;
      await fetch('/api/ai/conversations/' + cv.id, { method: 'DELETE' });
      if (cv.id === currentConvId) {
        const r = await fetch('/api/ai/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json();
        currentConvId = d.id;
      }
      loadConversations().then(() => switchConversation(currentConvId));
    };
    wrap.appendChild(div);
  });
  if (convHasMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'conv-more-btn';
    more.textContent = '이전 대화 더 보기';
    more.onclick = () => loadMoreConversations();
    wrap.appendChild(more);
  }
}

/* 창 바 제목 게시 (myhub:doc-title, 트랙 H): 제목은 앱 이름이 아니라
   콘텐츠 이름이라는 HIG 규칙 — 현재 대화의 제목이 창 제목줄에 오른다.
   대화가 없으면 null로 모듈 제목('AI 채팅')을 따라간다. */
function notifyChatDocTitle() {
  try {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
    let name = null;
    if (currentConvId) {
      const cv = (typeof conversations !== 'undefined' ? conversations : []).find((c) => c.id === currentConvId);
      name = (cv && cv.title) || '제목 없음';
    }
    window.parent.postMessage({ type: 'myhub:doc-title', name, dirty: false }, window.location.origin);
  } catch (e) { console.warn('대화 제목 동기화 실패:', e); }
}
if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'myhub:request-doc-title') notifyChatDocTitle();
  });
}

async function switchConversation(id) {
  currentConvId = id;
  oldestId = null;
  hasMore = true;
  history = [];
  renderConvList();
  notifyChatDocTitle();
  $('msgs').innerHTML = '';
  closeSidebar();
  await loadHistory();
}

$('newChatBtn').onclick = async () => {
  const r = await fetch('/api/ai/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const d = await r.json();
  if (d.ok) {
    await loadConversations();
    switchConversation(d.id);
  }
};

/* 창 상단 메뉴바 정의 (계약: js/desktop/windows.js 상단 주석).
   목록과 사이드바·토스트가 뜨는 동안 드롭다운 안에 내용 자체를
   렌더한다 (사용자 지시 2026-11-05): 파일 목록 메뉴를 열면 그
   지점에 파일 배열의 항목으로 펼쳐지고, 고르면 전환 후 접힌다.
   참여자 선택은 비서 카드 클릭과 같은 멘션 채우기 동작이다. */
window.MyHubMenus = [
  {
    // 첫 메뉴 라벨은 운영 실측 정본 '대화' (2026-11-11 앱 대조 카탈로그:
    // 상단바 'AI 채팅 대화 대화 목록 참여자'). 전사본은 라벨 문자열이
    // 소실돼 교차 확인 불가 — 운영 관찰 기록이 유일한 근거이다.
    label: '대화',
    items: [
      { label: '새 대화', run: () => $('newChatBtn').click() },
      { separator: true },
      {
        label: '비서 설정',
        run: () => {
          const b = $('settingsBtn2');
          if (b) b.click();
        },
      },
    ],
  },
  {
    label: '대화 목록',
    items: () => {
      const items = conversations.map((cv) => ({
        label: cv.title || '제목 없음',
        sub: cv.last_msg ? String(cv.last_msg).slice(0, 26) : '',
        checked: cv.id === currentConvId,
        run: () => switchConversation(cv.id),
      }));
      if (!items.length) items.push({ label: '대화가 없습니다', disabled: true });
      if (convHasMore) {
        items.push({ separator: true });
        items.push({ label: '이전 대화 더 보기', run: () => loadMoreConversations() });
      }
      return items;
    },
  },
  {
    label: '참여자',
    items: () =>
      personas.map((p) => ({
        label: p.name,
        sub: p.desc || '',
        run: () => {
          hideLanding();
          const input = $('input');
          input.value = '@' + p.name + ' ';
          input.focus();
        },
      })),
  },
];

async function loadHistory() {
  todayDivider();
  try {
    const r = await fetch(`/api/ai/room-history?limit=30&conversationId=${currentConvId}`);
    const d = await r.json();
    const msgs = d.messages || [];
    hasMore = d.hasMore;
    if (msgs.length) oldestId = msgs[0].id;
    if (!msgs.length) {
      showLanding();
    } else {
      hideLanding();
      msgs.forEach((m) => addMsg(m.role, m.content, m.persona_id || 'concierge', m.model || '', null, null, m.id));
    }
    history = msgs.map((m) => ({ role: m.role, content: m.content, personaId: m.persona_id || undefined }));
  } catch {
    showLanding();
  }
  requestAnimationFrame(() => {
    const wrap = $('msgs');
    wrap.scrollTop = wrap.scrollHeight;
  });
}

function showLanding() {
  $('landing').classList.remove('hidden');
  $('inputBar').style.display = 'none';
  $('msgs').innerHTML = '';
  history = [];
}

function hideLanding() {
  $('landing').classList.add('hidden');
  $('inputBar').style.display = '';
}

async function loadMore() {
  if (!hasMore || loadingMore || !oldestId) return;
  loadingMore = true;
  const wrap = $('msgs');
  const prevHeight = wrap.scrollHeight;
  try {
    const r = await fetch(`/api/ai/room-history?limit=30&before=${oldestId}&conversationId=${currentConvId}`);
    const d = await r.json();
    const msgs = d.messages || [];
    hasMore = d.hasMore;
    if (msgs.length) {
      oldestId = msgs[0].id;
      // 맨 앞에 삽입 (최신순으로) — 기존 prependMsg 로직 사용
      msgs.reverse().forEach((m) => prependMsg(m.role, m.content, m.persona_id || 'concierge', m.model || '', m.id));
      wrap.scrollTop = wrap.scrollHeight - prevHeight;
    }
  } catch (e) { console.warn('이전 메시지 로드 실패:', e); }
  loadingMore = false;
}

function prependMsg(role, text, personaId, meta, messageId) {
  const wrap = $('msgs');
  const persona = personas.find((p) => p.id === personaId);
  const isMine = role === 'user';
  const group = document.createElement('div');
  group.className = 'msg-group' + (isMine ? ' mine' : '');
  group.dataset.sender = isMine ? 'mine' : personaId;
  const row = document.createElement('div');
  row.className = 'msg-row';
  if (!isMine && persona) {
    row.innerHTML = `<img class="avatar" src="${escapeHtml(persona.avatar)}" alt="">` +
      `<div class="content"><div class="sender">${escapeHtml(persona.name)}</div></div>`;
  } else {
    row.innerHTML = `<div class="content"></div>`;
  }
  group.appendChild(row);
  const content = group.querySelector('.content');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  content.appendChild(bubble);
  // Phase 3C: 피드백 버튼 (AI 답변에만, messageId가 있을 때)
  // 모델명 복사 버튼 우측에 표시
  if (!isMine && messageId) {
    const fbDiv = createFeedbackButtons(messageId, text, meta);
    content.appendChild(fbDiv);
    loadFeedbackState(messageId, fbDiv);
  }
  // 날짜 구분선은 다음에 삽입
  const divider = wrap.querySelector('.date-divider');
  if (divider && divider.nextSibling) {
    wrap.insertBefore(group, divider.nextSibling);
  } else {
    wrap.prepend(group);
  }
}

// 위로 스크롤하면 이전 메시지 로드
$('msgs').addEventListener('scroll', () => {
  if ($('msgs').scrollTop < 100) loadMore();
});

function openSidebar() {
  $('sidebarLeft').classList.add('open');
  $('sidebarOverlay').classList.add('show');
}
function closeSidebar() {
  $('sidebarLeft').classList.remove('open');
  $('sidebarOverlay').classList.remove('show');
}
// 동적 버튼은 이벤트 연결 (injectNavButtons 이후 실행)
function bindNavButtons() {
  const tl = $('toggleLeft');
  if (tl) tl.onclick = openSidebar;
  const pb = $('participantBtn');
  if (pb) pb.onclick = (e) => { e.stopPropagation(); $('participantToast').classList.toggle('show'); };
  const sb = $('settingsBtn2');
  if (sb) sb.onclick = () => {
    $('settingsPanel').classList.add('open');
    $('settingsOverlay').classList.add('show');
    loadSettings();
  };
}
$('sidebarOverlay').onclick = closeSidebar;
document.addEventListener('click', (e) => {
  const toast = $('participantToast');
  if (toast.classList.contains('show') && !toast.contains(e.target)) {
    toast.classList.remove('show');
  }
});

// 메인 상단바에 채팅 컨트롤 주입 (Mac 스타일)
(function injectNavButtons() {
  const nav = document.querySelector('.g-nav');
  if (!nav) return;
  const spacer = nav.querySelector('.spacer');
  if (!spacer) return;
  const btnStyle = 'border:none;background:none;cursor:pointer;padding:8px;color:#6b7280;border-radius:8px;display:flex;align-items:center;justify-content:center;';
  const svgBtn = (id, title, path) => {
    const b = document.createElement('button');
    b.id = id; b.title = title; b.style.cssText = btnStyle;
    b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    b.onmouseover = () => b.style.background = 'rgba(0,0,0,0.05)';
    b.onmouseout = () => b.style.background = 'none';
    return b;
  };
  const menuBtn = svgBtn('toggleLeft', '대화 목록', '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>');
  const partBtn = svgBtn('participantBtn', '참여자', '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>');
  const setBtn = svgBtn('settingsBtn2', '설정', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>');
  // 로고 다음은 메뉴 버튼, spacer 앞에 참여자/설정 버튼
  const logo = nav.querySelector('.brand-logo');
  if (logo && logo.nextSibling) nav.insertBefore(menuBtn, logo.nextSibling);
  else nav.insertBefore(menuBtn, spacer);
  nav.insertBefore(partBtn, spacer);
  nav.insertBefore(setBtn, spacer);
})();

loadPersonas().then(() => loadConversations()).then(() => loadHistory()).then(() => {
  // nav 버튼 주입 후 이벤트 바인딩
  setTimeout(bindNavButtons, 50);

  // 랜딩 입력 처리
  const landingInput = $('landingInput');
  const landingSend = $('landingSend');
  const sendLanding = () => {
    const text = landingInput.value.trim();
    if (!text) return;
    hideLanding();
    $('input').value = text;
    landingInput.value = '';
    send();
  };
  landingSend.onclick = sendLanding;
  landingInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendLanding();
    }
  });
  document.querySelectorAll('.assistant-card').forEach((card) => {
    card.onclick = () => {
      const pid = card.dataset.persona;
      const persona = personas.find((p) => p.id === pid);
      const name = persona ? persona.name : pid;
      hideLanding();
      $('input').value = `@${name} `;
      $('input').focus();
    };
  });
  // 랜딩 입력의 기본 동작
});

// ============================================================================
// Phase 3C: 피드백 UI
// ============================================================================

const FEEDBACK_REASONS = [
  { code: 'inaccurate', label: '내용이 부정확해' },
  { code: 'irrelevant', label: '질문과 관계 없음' },
  { code: 'too_long', label: '답변이 너무 길어' },
  { code: 'too_short', label: '설명이 부족해' },
  { code: 'wrong_action', label: '원하지 않는 동작' },
  { code: 'other', label: '기타' },
];

/* Gemini 스타일 액션 버튼: 좋아요·싫어요·다시 생성·복사 (2026-10-13) */
const SVG_ICONS = {
  like: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
  dislike: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>',
  regenerate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

function createActionButton(icon, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ai-action-btn';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = SVG_ICONS[icon];
  btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;border-radius:50%;background:transparent;color:#5f6368;cursor:pointer;transition:background 0.15s;';
  btn.onmouseenter = () => {
    // 활성 상태가 아닐 때만 호버 배경 적용
    if (btn.dataset.active !== 'true') btn.style.background = '#f0f4f9';
  };
  btn.onmouseleave = () => {
    // 활성 상태 복원 (활성이면 찬 배경, 아니면 투명)
    btn.style.background = btn.dataset.active === 'true' ? '#e8f0fe' : 'transparent';
  };
  btn.onclick = onClick;
  return btn;
}

function createFeedbackButtons(messageId, messageText, modelLabel) {
  const div = document.createElement('div');
  div.className = 'feedback-buttons';
  div.dataset.messageId = messageId;
  div.style.cssText = 'display:flex;gap:2px;margin-top:8px;align-items:center;';

  const likeBtn = createActionButton('like', '좋아요', () => submitFeedback(messageId, 'like', null, div));
  likeBtn.classList.add('fb-btn', 'fb-like');
  likeBtn.dataset.value = 'like';

  const dislikeBtn = createActionButton('dislike', '싫어요', () => showReasonPicker(messageId, div));
  dislikeBtn.classList.add('fb-btn', 'fb-dislike');
  dislikeBtn.dataset.value = 'dislike';

  const regenBtn = createActionButton('regenerate', '다시 생성', () => regenerateResponse(messageId, div));
  regenBtn.classList.add('ai-regen-btn');

  const copyBtn = createActionButton('copy', '복사', () => copyResponse(messageText, copyBtn));
  copyBtn.classList.add('ai-copy-btn');

  div.appendChild(likeBtn);
  div.appendChild(dislikeBtn);
  div.appendChild(regenBtn);
  div.appendChild(copyBtn);

  // 모델명을 복사 버튼 우측에 표시
  if (modelLabel) {
    const modelSpan = document.createElement('span');
    modelSpan.className = 'model-meta-inline';
    modelSpan.textContent = modelLabel;
    modelSpan.style.cssText = 'font-size:11px;color:#999;margin-left:8px;';
    div.appendChild(modelSpan);
  }
  return div;
}

/* 다시 생성: 마지막 사용자 메시지로 새 답변 요청 */
async function regenerateResponse(messageId, container) {
  const btn = container.querySelector('.ai-regen-btn');
  if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
  try {
    // 마지막 사용자 메시지 찾기
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // 기존 AI 답변은 history에서 제거 (다시 생성하므로):
    // 마지막 assistant 메시지를 제거하고 다시 요청
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') { history.splice(i, 1); break; }
    }
    // 화면에 해당 AI 버블을 로딩 상태로 표시
    const bubble = container.closest('.msg-group')?.querySelector('.bubble');
    if (bubble) { bubble.style.opacity = '0.5'; }
    await sendRegenerate(lastUser.content, bubble, container);
  } finally {
    if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
  }
}

async function sendRegenerate(userText, bubble, container) {
  const { personaId } = routeMessage(userText);
  const persona = personas.find((p) => p.id === personaId);
  // 실패 고정: 취소하면 사용자는 무반응으로 보므로, 일반 전송(send)와
  // 같은 규칙으로 버블에 실패 문구를 남긴다
  const fail = (msg) => {
    if (bubble) {
      bubble.style.opacity = '';
      bubble.textContent = msg;
    }
  };
  // I-02: 다시 생성도 같은 타임아웃을 건다 (취소 버튼은 본 전송 전용)
  const reqState = startChatRequest();
  try {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId, conversationId: currentConvId, messages: history.slice(-20) }),
      signal: reqState.controller.signal,
    });
    // 응답을 받았지만 본문이 JSON이 아니면(서버 500의 HTML 응답 등)
    // 연결 실패와 구분해 서버 오류로 고정한다
    const d = await r.json().catch(() => null);
    if (bubble) { bubble.style.opacity = ''; }
    if (!d) {
      fail('서버 응답을 읽지 못해 다시 생성하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    if (d.ok) {
      history.push({ role: 'assistant', content: d.text, personaId });
      if (bubble) {
        bubble.innerHTML = renderMarkdown(d.text);
        // 모델명을 피드백 버튼 우측에 업데이트
        const modelLabel = (d.model || '').split('/').pop() || '';
        if (container) {
          let modelSpan = container.querySelector('.model-meta-inline');
          if (modelLabel) {
            if (!modelSpan) {
              modelSpan = document.createElement('span');
              modelSpan.className = 'model-meta-inline';
              modelSpan.style.cssText = 'font-size:11px;color:#999;margin-left:8px;';
              container.appendChild(modelSpan);
            }
            modelSpan.textContent = modelLabel;
          } else if (modelSpan) {
            modelSpan.remove();
          }
        }
      }
    } else {
      fail(chatErrorText({ error: d.error, status: r.status }, '답변을 받지 못했어요. 잠시 후 다시 시도해 주세요.'));
    }
  } catch (e) {
    if (reqState.timedOut) {
      fail('답변이 너무 오래 걸려 다시 생성을 중단했어요. 잠시 후 다시 시도해 주세요.');
    } else {
      console.warn('다시 생성 연결 실패:', e);
      fail('연결에 실패해 다시 생성하지 못했어요.');
    }
  } finally {
    stopChatRequest(reqState);
  }
}

/* 복사: 답변 텍스트를 클립보드에 복사 */
async function copyResponse(text, btn) {
  try {
    await navigator.clipboard.writeText(text || '');
    const orig = btn.innerHTML;
    btn.innerHTML = SVG_ICONS.check;
    btn.style.color = '#1a73e8';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 1500);
  } catch (e) {
    console.warn('클립보드 복사 실패:', e);
  }
}

function showReasonPicker(messageId, container) {
  // 기존 picker 제거
  const existing = container.querySelector('.reason-picker');
  if (existing) {
    existing.remove();
    return;
  }
  const picker = document.createElement('div');
  picker.className = 'reason-picker';
  picker.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';
  // 이유 없이 바로 싫어요
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '이유 없이 싫어요';
  skipBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;';
  skipBtn.onclick = () => submitFeedback(messageId, 'dislike', null, container);
  picker.appendChild(skipBtn);

  FEEDBACK_REASONS.forEach((r) => {
    const btn = document.createElement('button');
    btn.textContent = r.label;
    btn.style.cssText = skipBtn.style.cssText;
    btn.onclick = () => submitFeedback(messageId, 'dislike', r.code, container);
    picker.appendChild(btn);
  });
  container.appendChild(picker);
}

let feedbackInFlight = {};
// 현재 선택 상태 추적 (취소 판단용)
let feedbackState = {};

async function submitFeedback(messageId, value, reasonCode, container) {
  const key = `${messageId}`;
  if (feedbackInFlight[key]) return; // 중복 클릭 방지
  feedbackInFlight[key] = true;

  try {
    const current = feedbackState[messageId];
    let method, url, body;

    if (current === value) {
      // 같은 버튼 토글 시 취소 (DELETE)
      method = 'DELETE';
      url = `/api/ai/feedback/${messageId}`;
      body = null;
    } else {
      // 설정/변경 (PUT, 멱등)
      method = 'PUT';
      url = '/api/ai/feedback';
      body = JSON.stringify({ messageId, value, reasonCode });
    }

    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body,
    });
    const d = await r.json();
    if (d.ok) {
      const newValue = d.cancelled ? null : value;
      feedbackState[messageId] = newValue;
      updateFeedbackUI(container, newValue);
      // picker 제거
      const picker = container.querySelector('.reason-picker');
      if (picker) picker.remove();
    } else {
      alert(friendlyError(d, '피드백을 전송하지 못했어요. 잠시 후 다시 시도해 주세요.'));
    }
  } catch (e) {
    console.warn('피드백 전송 실패:', e);
    alert('피드백을 보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
  } finally {
    feedbackInFlight[key] = false;
  }
}

function updateFeedbackUI(container, activeValue) {
  const likeBtn = container.querySelector('.fb-like');
  const dislikeBtn = container.querySelector('.fb-dislike');
  // Gemini 스타일: 활성 땐 눌린 아이콘 + 옅은 배경 (dataset.active로 호버와 구분)
  if (likeBtn) {
    const active = activeValue === 'like';
    likeBtn.dataset.active = active ? 'true' : 'false';
    likeBtn.style.color = active ? '#1a73e8' : '#5f6368';
    likeBtn.style.background = active ? '#e8f0fe' : 'transparent';
  }
  if (dislikeBtn) {
    const active = activeValue === 'dislike';
    dislikeBtn.dataset.active = active ? 'true' : 'false';
    dislikeBtn.style.color = active ? '#1a73e8' : '#5f6368';
    dislikeBtn.style.background = active ? '#e8f0fe' : 'transparent';
  }
}

async function loadFeedbackState(messageId, container) {
  try {
    const r = await fetch(`/api/ai/feedback/${messageId}`);
    const d = await r.json();
    if (d.ok && d.feedback) {
      feedbackState[messageId] = d.feedback.value;
      updateFeedbackUI(container, d.feedback.value);
    }
  } catch (e) {
    console.warn('피드백 표시 실패:', e);
  }
}
