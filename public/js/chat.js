
const $ = (id) => document.getElementById(id);
let personas = [];
let history = [];
let sending = false;
let currentConvId = null; // 새 대화는 서버가 자동 생성
let conversations = [];
let lastSender = null;

// 마크다운 설정
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text) {
  const raw = String(text ?? "");
  // SEC-001: Fail-closed - DOMPurify나 marked가 없으면 텍스트로 표시
  if (typeof window.marked?.parse !== "function" ||
      typeof window.DOMPurify?.sanitize !== "function") {
    const safe = document.createElement("div");
    safe.textContent = raw;
    return safe.innerHTML;
  }
  try {
    const html = window.marked.parse(raw);
    // SEC-001: 정제되지 않은 HTML을 DOM에 삽입하기 전 최초 정제
    // (detached div라도 innerHTML 삽입 전 정제가 보안상 안전)
    const firstClean = window.DOMPurify.sanitize(html);
    const tmp = document.createElement('div');
    tmp.innerHTML = firstClean;
    // 하이라이팅 적용 (정제된 HTML에만)
    tmp.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (e) { console.warn('코드 하이라이팅 실패:', e); }
    });
    // SEC-001: 하이라이팅 후 최종 정제 (하이라이팅이 마크업 변경 가능)
    return window.DOMPurify.sanitize(tmp.innerHTML);
  } catch {
    const safe = document.createElement("div");
    safe.textContent = raw;
    return safe.innerHTML;
  }
}

async function loadPersonas() {
  try {
    const r = await fetch('/api/ai/personas');
    personas = await r.json() || [];
  } catch { personas = []; }
  if (!personas.length) {
    personas = [
      { id: 'concierge', name: '루미', avatar: '/avatars/rumi.webp', desc: '대표 비서' },
      { id: 'keeper', name: '에코', avatar: '/avatars/echo.webp', desc: '기록 담당' },
      { id: 'builder', name: '노바', avatar: '/avatars/nova.webp', desc: '만들기 담당' },
      { id: 'scheduler', name: '캘리', avatar: '/avatars/cali.webp', desc: '일정·할일 담당' },
    ];
  }
  // 우측 토스트 참여자 목록
  $('participantList').innerHTML = personas.map((p) =>
    `<div class="participant"><img src="${p.avatar}" alt="">` +
    `<div class="pinfo"><div class="pname">${p.name}</div><div class="pdesc">${p.desc || ''}</div></div>` +
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

  // 같은 사람이 연속으로 말하면 그룹에 추가
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
      row.innerHTML = `<img class="avatar" src="${persona.avatar}" alt="">` +
        `<div class="content"><div class="sender">${persona.name}</div></div>`;
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
  // 출처 표시 (웹검색 grounding)
  // 제목이 "최신뉴스", "다음뉴스" 같은 포털 이름뿐인 경우가 있어 도메인을 함께 표시한다
  if (sources && sources.length > 0) {
    const srcDiv = document.createElement('div');
    srcDiv.className = 'sources';
    srcDiv.innerHTML = '<div class="sources-title">출처</div>' +
      sources.map((s, i) => {
        let host = '';
        try { host = new URL(s.url).hostname; } catch (e) { console.warn('출처 URL 파싱 실패:', e); }
        const label = host ? `${escapeHtml(s.title)} — ${escapeHtml(host)}` : escapeHtml(s.title);
        return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="source-link">${i + 1}. ${label}</a>`;
      }).join('');
    bubble.appendChild(srcDiv);
  }
  content.appendChild(bubble);
  // 승인 요청 버튼 (b트랙): 가장 최근 대기 요청 1건에 대해 승인/세션 허용/거부.
  // 버튼은 텍스트 명령("승인해" 등)을 입력창에 넣어 기존 send() 경로를 재사용한다.
  // 여러 요청이 대기 중이면 가장 최근 것만 버튼으로, 나머지는 텍스트로 답한다.
  if (!isMine && approvalRequests && approvalRequests.length > 0) {
    const latest = approvalRequests[approvalRequests.length - 1];
    const bar = document.createElement('div');
    bar.className = 'approval-bar';
    const extra = approvalRequests.length > 1
      ? `<span class="approval-pending-note">외 ${approvalRequests.length - 1}개 요청 대기 중</span>`
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
  // 모델명은 복사 버튼 우측에 표시
  if (!isMine && messageId) {
    const fbDiv = createFeedbackButtons(messageId, text, meta);
    content.appendChild(fbDiv);
    // 기존 피드백 상태 복원
    loadFeedbackState(messageId, fbDiv);
  }
  wrap.scrollTop = wrap.scrollHeight;
  lastSender = groupKey;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showTyping(personaId) {
  const persona = personas.find((p) => p.id === personaId);
  if (!persona) return null;
  const wrap = $('msgs');
  const div = document.createElement('div');
  div.className = 'msg-group typing-group';
  div.dataset.sender = '__typing__';
  div.innerHTML = `<div class="typing-row">` +
    `<img class="avatar" src="${persona.avatar}" alt="">` +
    `<div><div class="sender" style="font-size:13px;font-weight:600;margin-bottom:6px;">${persona.name}</div>` +
    `<div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

// ===== 라우팅 =====
function routeMessage(text) {
  // 1. @멘션
  const mention = text.match(/@(\S+)/);
  if (mention) {
    const name = mention[1];
    const p = personas.find((x) => x.name === name || x.id === name);
    if (p) return { personaId: p.id, clean: text.replace(mention[0], '').trim() };
  }
  // 2. 키워드 라우팅
  const t = text.toLowerCase();
  const novaKw = ['코드', '만들어', '버그', '함수', '개발', '프로그램', '테트리스', '게임', '모듈', 'api'];
  const echoKw = ['메모', '기억', '요약', '정리해', '잊지마', '기록'];
  const caliKw = ['일정', '스케줄', '할일', '할 일', '약속', '예약', '캘린더', '리마인드', '미리알림', '치과', '병원', '회의'];
  if (novaKw.some((k) => t.includes(k))) return { personaId: 'builder', clean: text };
  if (echoKw.some((k) => t.includes(k))) return { personaId: 'keeper', clean: text };
  if (caliKw.some((k) => t.includes(k))) return { personaId: 'scheduler', clean: text };
  // 3. 기본: 루미
  return { personaId: 'concierge', clean: text };
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

  // GitHub 검색 명령어: /깃헙 또는 /github
  const ghMatch = text.match(/^\/(깃헙|github)\s+(.+)/s);
  if (ghMatch) {
    await sendGithub(ghMatch[2].trim());
    sending = false;
    $('send').disabled = false;
    $('input').focus();
    return;
  }

  const { personaId, clean } = routeMessage(text);
  const persona = personas.find((p) => p.id === personaId);
  history.push({ role: 'user', content: text });

  const typing = showTyping(personaId);

  try {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId, conversationId: currentConvId, messages: history.slice(-20) }),
    });
    const d = await r.json();
    if (typing) typing.remove();
    if (d.ok) {
      // 서버가 생성한 conversationId를 저장 (연속 대화용)
      if (d.conversationId && d.conversationId !== currentConvId) {
        currentConvId = d.conversationId;
      }
      history.push({ role: 'assistant', content: d.text, personaId });
      // 모델명은 간결하게 (provider prefix 제거)
      // 파이프라인 정보가 있으면 함께 표시 (예: "검색: Exa, 작성: gemini-3.5-flash-lite")
      let modelLabel = (d.model || '').split('/').pop() || '';
      if (d.pipeline) {
        modelLabel = d.pipeline;
      }
      // 폴백 정보는 사용자에게 노출하지 않음 (내부용)
      // Phase 3C: messageId 전달 (피드백 연결용)
      addMsg('assistant', d.text, personaId, modelLabel, d.sources, d.images, d.messageId, d.approvalRequests);
    } else if (d.error === 'CONVERSATION_NOT_FOUND') {
      // 대화가 없으면 새로 시작 (ID 초기화 후 재시도하지 않고 안내)
      currentConvId = null;
      addMsg('assistant', '대화를 찾을 수 없어 새 대화를 시작합니다. 다시 말씀해주세요.', personaId);
    } else {
      // 에러가 객체로 오면 message 추출 (89차: [object Object] 방지)
      const errMsg = typeof d.error === 'object' && d.error !== null
        ? (d.error.message || d.error.code || '오류가 발생했습니다.')
        : (d.error || '오류가 발생했습니다.');
      addMsg('assistant', errMsg, personaId);
    }
  } catch {
    if (typing) typing.remove();
    addMsg('assistant', '연결에 실패했습니다.', personaId);
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
      addMsg('assistant', '이미지 생성 실패: ' + (d.error || 'unknown'), 'concierge');
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
  group.innerHTML = `<div class="msg-row"><img class="avatar" src="/avatars/rumi.webp" alt="">` +
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
        `<div class="mention-item" data-name="${p.name}">` +
        `<img src="${p.avatar}" alt=""><div><div class="mname">@${p.name}</div>` +
        `<div class="mdesc">${p.desc || ''}</div></div></div>`).join('');
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

$('send').onclick = send;
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
  { id: 'summarize', name: '요약·기록 (에코)', provider: 'workers-ai', providerName: 'Workers AI' },
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
    renderQuotaRows(qr);
  } catch (e) { console.warn('모델 목록 로드 실패:', e); }
}

function renderModelRows() {
  const wrap = $('modelRows');
  wrap.innerHTML = '';
  CAPABILITIES.forEach((cap) => {
    const row = document.createElement('div');
    row.className = 'model-row';
    // 프로바이더는 고정 표시 (변경 불가), 모델만 해당 프로바이더 내에서 선택
    row.innerHTML = `<label>${cap.name}</label>
      <div style="font-size:12px;color:#5f6368;margin:2px 0 4px;">🔒 ${cap.providerName} 고정</div>`;
    const sel = document.createElement('select');
    // 해당 프로바이더의 모델만 표시
    const providerModels = allModels.filter((m) => m.provider === cap.provider);
    sel.innerHTML = `<option value="">자동 (추천)</option>` +
      providerModels.map((m) => `<option value="${m.id}">${m.id}</option>`).join('');
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

function renderQuotaRows(qr) {
  const wrap = $('quotaRows');
  wrap.innerHTML = '';
  const usage = qr.usage || [];
  const budgets = qr.budgets || {};
  const names = { 'gemini': 'Gemini', 'groq': 'Groq', 'workers-ai': 'Workers AI' };
  if (!usage.length) wrap.innerHTML = '<div style="font-size:13px;color:var(--dim)">오늘 사용 기록이 없어.</div>';
  usage.forEach((u) => {
    const budget = budgets[u.provider];
    const pct = budget ? Math.min(100, Math.round((u.requests / budget) * 100)) : 0;
    const tok = (u.in_tok || 0) + (u.out_tok || 0);
    wrap.innerHTML += `<div class="quota-row"><b>${names[u.provider] || u.provider}</b> · ${u.requests}회` +
      `${tok ? ` · ${tok.toLocaleString()} 토큰` : ''}` +
      (budget ? `<div class="quota-bar"><div style="width:${pct}%"></div></div>` : '') + `</div>`;
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
}

// 이어보기: 다음 페이지를 뒤에 붙인다 (이미 받은 id는 중복 방지)
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
    div.innerHTML = `<div class="ctitle">${escapeHtml(cv.title || '새 대화')}</div>` +
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

async function switchConversation(id) {
  currentConvId = id;
  oldestId = null;
  hasMore = true;
  history = [];
  renderConvList();
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
      // 맨 앞에 삽입 (역순으로)
      const frag = document.createDocumentFragment();
      const tmpWrap = document.createElement('div');
      msgs.forEach((m) => {
        const tmpDiv = document.createElement('div');
        tmpDiv.innerHTML = '__MSG__';
        // addMsg를 직접 호출하는 대신 수동으로 구성
      });
      // 간단히: 기존 addMsg 로직 재사용하되 prepend
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
    row.innerHTML = `<img class="avatar" src="${persona.avatar}" alt="">` +
      `<div class="content"><div class="sender">${persona.name}</div></div>`;
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
  // 모델명은 복사 버튼 우측에 표시
  if (!isMine && messageId) {
    const fbDiv = createFeedbackButtons(messageId, text, meta);
    content.appendChild(fbDiv);
    loadFeedbackState(messageId, fbDiv);
  }
  // 날짜 구분선 다음에 삽입
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
// 동적 버튼에 이벤트 연결 (injectNavButtons 이후 실행됨)
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
  // 로고 다음에 메뉴 버튼, spacer 앞에 참여자/설정 버튼
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
  // 랜딩 입력은 기본 동작
});

// ============================================================================
// Phase 3C: 피드백 UI
// ============================================================================

const FEEDBACK_REASONS = [
  { code: 'inaccurate', label: '내용이 부정확함' },
  { code: 'irrelevant', label: '질문과 관련 없음' },
  { code: 'too_long', label: '답변이 너무 김' },
  { code: 'too_short', label: '설명이 부족함' },
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
    // 활성 상태 복원 (활성이면 파란 배경, 아니면 투명)
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
    // 기존 AI 답변을 history에서 제거 (다시 생성하므로)
    const aiIdx = history.findIndex((m) => m.role === 'assistant' && m.content);
    // 간단히: 마지막 assistant 메시지를 제거하고 다시 요청
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') { history.splice(i, 1); break; }
    }
    // 화면의 해당 AI 버블을 로딩 상태로 표시
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
  try {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId, conversationId: currentConvId, messages: history.slice(-20) }),
    });
    const d = await r.json();
    if (bubble) { bubble.style.opacity = ''; }
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
    }
  } catch (e) {
    if (bubble) { bubble.style.opacity = ''; }
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
  // 사유 없이 바로 싫어요
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '사유 없이 싫어요';
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
      // 같은 버튼 재클릭 → 취소 (DELETE)
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
      alert('피드백 저장 실패: ' + (d.error || 'unknown'));
    }
  } catch (e) {
    alert('피드백 전송 실패');
  } finally {
    feedbackInFlight[key] = false;
  }
}

function updateFeedbackUI(container, activeValue) {
  const likeBtn = container.querySelector('.fb-like');
  const dislikeBtn = container.querySelector('.fb-dislike');
  // Gemini 스타일: 활성 시 파란색 아이콘 + 연한 배경 (dataset.active로 호버와 구분)
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

// ===== 모바일 상단바 자동 숨김 (chat.html 인라인에서 이동 — CHAT_CSP script-src 'self' enforce로 인라인 차단됨) =====
// 모바일: #msgs 스크롤시 상단바 숨기기/보이기
// .chat-layout의 margin-top만 변경 - #msgs 내부는 건드리지 않음
(function() {
  if (window.innerWidth > 768) return;
  const nav = document.querySelector('.g-nav');
  const msgs = document.getElementById('msgs');
  if (!nav || !msgs) return;
  let lastY = msgs.scrollTop;
  let acc = 0;
  let ticking = false;
  msgs.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = msgs.scrollTop;
      const max = msgs.scrollHeight - msgs.clientHeight;
      // 러버밴드 오버스크롤 무시
      if (y >= 0 && y <= max) {
        const dy = y - lastY;
        // 방향 바뀌면 누적 리셋
        if ((dy > 0 && acc < 0) || (dy < 0 && acc > 0)) acc = 0;
        acc += dy;
        if (acc > 24) {
          nav.classList.add('nav-hidden');
          document.body.classList.add('nav-hidden');
          acc = 0;
        } else if (acc < -24 || y < 8) {
          nav.classList.remove('nav-hidden');
          document.body.classList.remove('nav-hidden');
          acc = 0;
        }
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true });
})();
