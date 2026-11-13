/* MyHub 서브챗 앱 앱 소유 비서 패널 (subchat.js, 서브챗 열기 2단계)
 *
 * 사용자 정보 (2026-11-06): 서브챗은 앱 창 안의 패널이 아니라 앱 메인
 * 상단바 우측 아바타를 누르면 그 아래로 열리는 앱 독립 오버레이이다.
 * 패널 상태는 앱 모듈 앱이 갖고, 현재 앱과는 연결한 창 관리자가
 * 수집한 선언(myhub:assistant-declare)으로만 연다:
 *   - 맥락: 전송 시점에 현재 앱 브리핑을 myhub:assistant-context로
 *     물어 받아 채팅 본문을 주입한다 (종전 위젯의 수집 규칙과 동일).
 *   - 적용: 응답의 uiActions를 myhub:ui-action으로 현재 창 iframe에
 *     포함시킨다. 조작 연결이 끊기면 열기 실패다.
 *   - 오피스(flavor 'office'): 지시·찾기·만들기 찾기을
 *     myhub:assistant-office 명령으로 뷰어 세션 대판과 있는 창에
 *     전임한다 (메일 승인 선택은 창 안에만 둔다).
 * 현재 앱이 비서를 선언하지 않았을면 기본 비서는 루미로 앱 바탕화면
 * 자세의 상단바에서도 바로 채팅을 앱 있었다 연다.
 */
(function () {
  'use strict';

  var DEFAULT_PERSONA = {
    personaId: 'concierge',
    personaName: '루미',
    avatar: '/avatars/rumi-128.webp',
    flavor: 'chat',
  };
  var CONTEXT_TIMEOUT_MS = 800;
  var OFFICE_TIMEOUT_MS = 120000;

  function create(deps) {
    deps = deps || {};
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    var slotEl = deps.slotEl || null;
    var hostEl = deps.hostEl || doc.body;
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var setTimeoutFn = deps.setTimeoutFn || setTimeout;
    var clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
    var getActiveAssistant =
      deps.getActiveAssistant || function () { return null; };
    var postToModule = deps.postToModule || function () { return false; };

    var binding = null; // {winId, personaId, personaName, avatar, flavor}
    var bindingKey = '';
    var open = false;
    var sessions = new Map(); // personaId -> 세션
    create.instanceSeq = (create.instanceSeq || 0) + 1;
    var reqPrefix = 'subchat-' + create.instanceSeq + '-';
    var reqSeq = 0;
    var pending = new Map(); // reqId -> {resolve, timer}

    // ---------- DOM ----------
    var avatarBtn = null;
    var panel = doc.createElement('div');
    panel.className = 'myhub-subchat-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="myhub-subchat-head">' +
      '<img class="myhub-subchat-head-avatar" alt="">' +
      '<div class="myhub-subchat-head-info">' +
      '<div class="myhub-subchat-head-name"></div>' +
      '<div class="myhub-subchat-head-sub"></div>' +
      '</div>' +
      '<span class="myhub-subchat-state"></span>' +
      '<button type="button" class="myhub-subchat-close" aria-label="닫기"><i data-lucide="x"></i></button>' +
      '</div>' +
      '<div class="myhub-subchat-msgs"></div>' +
      '<div class="myhub-subchat-reply" aria-live="polite"></div>' +
      '<ul class="myhub-subchat-findings"></ul>' +
      '<div class="myhub-subchat-sub" hidden></div>' +
      '<div class="myhub-subchat-input-row">' +
      '<input type="text" class="myhub-subchat-input" autocomplete="off">' +
      '<button type="button" class="myhub-subchat-send" aria-label="전송"><i data-lucide="arrow-up"></i></button>' +
      '</div>' +
      '<div class="myhub-subchat-office-row" hidden>' +
      '<button type="button" class="myhub-subchat-memo-btn">메모로 만들기</button>' +
      '<button type="button" class="myhub-subchat-mail-btn">메일로 보내기</button>' +
      '</div>';
    hostEl.appendChild(panel);

    var headAvatar = panel.querySelector('.myhub-subchat-head-avatar');
    var headName = panel.querySelector('.myhub-subchat-head-name');
    var headSub = panel.querySelector('.myhub-subchat-head-sub');
    var stateEl = panel.querySelector('.myhub-subchat-state');
    var msgsEl = panel.querySelector('.myhub-subchat-msgs');
    var replyEl = panel.querySelector('.myhub-subchat-reply');
    var findingsEl = panel.querySelector('.myhub-subchat-findings');
    var subEl = panel.querySelector('.myhub-subchat-sub');
    var inputEl = panel.querySelector('.myhub-subchat-input');
    var sendBtn = panel.querySelector('.myhub-subchat-send');
    var officeRow = panel.querySelector('.myhub-subchat-office-row');
    var memoBtn = panel.querySelector('.myhub-subchat-memo-btn');
    var mailBtn = panel.querySelector('.myhub-subchat-mail-btn');
    if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();

    panel.querySelector('.myhub-subchat-close').addEventListener('click', closePanel);
    sendBtn.addEventListener('click', onSend);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onSend();
    });
    memoBtn.addEventListener('click', toggleMemoSub);
    mailBtn.addEventListener('click', toggleMailSub);
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) closePanel();
    });

    // ---------- 바인딩 ----------
    function resolveBinding() {
      var active = null;
      try {
        active = getActiveAssistant();
      } catch (e) {
        console.warn('활성 비서 조회 실패:', e);
      }
      if (active && active.personaId) {
        return {
          winId: active.winId || null,
          personaId: active.personaId,
          personaName: active.personaName || '',
          avatar: active.avatar || '',
          flavor: active.flavor === 'office' ? 'office' : 'chat',
        };
      }
      return {
        winId: null,
        personaId: DEFAULT_PERSONA.personaId,
        personaName: DEFAULT_PERSONA.personaName,
        avatar: DEFAULT_PERSONA.avatar,
        flavor: 'chat',
      };
    }

    function applyBinding(next) {
      var key =
        (next.winId || '-') + '|' + next.personaId + '|' + next.flavor + '|' + next.avatar;
      if (key === bindingKey) return;
      bindingKey = key;
      binding = next;
      renderAvatar();
      renderHead();
      // 오피스 화면 상태는 창 단위의 앱 창이 바를면 비순다 (메일 초안
      // 선택은 앱 창 안에 남고, 패널은 그 초안을 앱는 것이 정확하다).
      office.reply = '';
      office.findings = [];
      office.busy = false;
      closeSub();
      renderOffice();
      renderSession();
    }

    function renderAvatar() {
      if (!slotEl) return;
      slotEl.innerHTML = '';
      avatarBtn = doc.createElement('button');
      avatarBtn.type = 'button';
      avatarBtn.className = 'dt-assistant-btn myhub-subchat-avatar';
      var label = binding.personaName ? binding.personaName + '에게 묻기' : '비서에게 묻기';
      avatarBtn.title = label;
      avatarBtn.setAttribute('aria-label', label);
      avatarBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      var img = doc.createElement('img');
      img.src = binding.avatar || '';
      img.alt = binding.personaName || '';
      avatarBtn.appendChild(img);
      avatarBtn.addEventListener('click', togglePanel);
      slotEl.appendChild(avatarBtn);
    }

    function renderHead() {
      headAvatar.src = binding.avatar || '';
      headAvatar.alt = binding.personaName || '';
      headName.textContent = binding.personaName || '비서';
      headSub.textContent =
        binding.flavor === 'office' ? '문서에서 바로 지시하세요' : '이 페이지에서 바로 물어보세요';
      var office = binding.flavor === 'office';
      officeRow.hidden = !office;
      msgsEl.hidden = office;
      replyEl.hidden = !office;
      findingsEl.hidden = !office;
      sendBtn.innerHTML = office ? '지시하기' : '<i data-lucide="arrow-up"></i>';
      sendBtn.setAttribute('aria-label', office ? '지시하기' : '전송');
      inputEl.placeholder =
        binding.flavor === 'office'
          ? '예: 문서 내용을 고쳐줘'
          : (binding.personaName || '비서') + '에게 물어보기...';
      if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();
    }

    function togglePanel() {
      open ? closePanel() : openPanel();
    }
    function openPanel() {
      open = true;
      panel.hidden = false;
      if (avatarBtn) avatarBtn.setAttribute('aria-expanded', 'true');
      if (binding.flavor === 'chat') {
        var s = session();
        if (!s.restored) restoreConversation(s);
        if (!s.messages.length) {
          pushMsg(s, 'assistant', '안녕하세요! ' + (binding.personaName || '비서') + '이에요. 무엇을 도와드릴까요?');
        }
        renderSession();
      }
      setTimeoutFn(function () {
        try {
          inputEl.focus();
        } catch (e) {
          console.warn('서브챗 입력 사용한 실패:', e);
        }
      }, 50);
    }
    function closePanel() {
      open = false;
      panel.hidden = true;
      if (avatarBtn) avatarBtn.setAttribute('aria-expanded', 'false');
    }

    // ---------- 채팅 세션 ----------
    function session() {
      var id = binding.personaId;
      if (!sessions.has(id)) {
        sessions.set(id, {
          personaId: id,
          conversationId: null,
          lastCreatedMemoId: null,
          messages: [],
          sending: false,
          restored: false,
        });
      }
      return sessions.get(id);
    }
    function restoreConversation(s) {
      s.restored = true;
      if (!fetchFn) return;
      fetchFn('/api/ai/conversations/active?personaId=' + encodeURIComponent(s.personaId))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok && data.conversationId) s.conversationId = data.conversationId;
        })
        .catch(function (e) { console.warn('대화 복구 실패:', e); });
    }
    function markdown(text) {
      var html = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html = html.replace(/\s*\(id:\s*\d+\)/g, '');
      html = html.replace(/^- \[ \] /gm, '☐ ');
      html = html.replace(/^- \[x\] /gm, '☑ ');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\n/g, '<br>');
      return html;
    }
    function pushMsg(s, role, text, candidates, toolName) {
      var msg = { role: role, text: text };
      if (candidates) {
        msg.candidates = candidates;
        msg.toolName = toolName || '';
      }
      s.messages.push(msg);
      if (binding && binding.personaId === s.personaId) renderSession();
      return msg;
    }
    function renderSession() {
      if (!binding || binding.flavor !== 'chat') return;
      var s = session();
      msgsEl.innerHTML = '';
      s.messages.forEach(function (m) {
        var div = doc.createElement('div');
        div.className = 'myhub-subchat-msg ' + m.role;
        div.innerHTML = markdown(m.text);
        if (m.candidates && m.candidates.length) {
          var box = doc.createElement('div');
          box.className = 'myhub-subchat-candidates';
          m.candidates.forEach(function (c) {
            var b = doc.createElement('button');
            b.type = 'button';
            b.className = 'myhub-subchat-candidate';
            var dateStr = c.start_at ? String(c.start_at).split('T')[0] : '';
            b.textContent = c.title + (dateStr ? ' (' + dateStr + ')' : '');
            b.addEventListener('click', function () {
              box.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
              var action =
                m.toolName && m.toolName.indexOf('update') >= 0 ? 'update' : 'delete';
              var retry =
                'ID ' + c.id + '번 일정 ' + (action === 'delete' ? '삭제해줘' : '선택했어');
              sendChat(retry);
            });
            box.appendChild(b);
          });
          div.appendChild(box);
        }
        msgsEl.appendChild(div);
      });
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    // ---------- 맥락 RPC ----------
    function rpc(winId, message, timeoutMs) {
      return new Promise(function (resolve) {
        reqSeq += 1;
        var reqId = reqPrefix + reqSeq;
        var timer = setTimeoutFn(function () {
          pending.delete(reqId);
          resolve(null);
        }, timeoutMs);
        pending.set(reqId, {
          resolve: function (v) {
            clearTimeoutFn(timer);
            resolve(v);
          },
        });
        message.reqId = reqId;
        if (!postToModule(winId, message)) {
          clearTimeoutFn(timer);
          pending.delete(reqId);
          resolve(null);
        }
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('message', function (e) {
        if (!e || e.origin !== window.location.origin) return;
        var d = e.data;
        if (!d || typeof d.type !== 'string' || !d.reqId) return;
        if (d.type !== 'myhub:assistant-context-result' && d.type !== 'myhub:assistant-office-result') return;
        var p = pending.get(d.reqId);
        if (!p) return;
        pending.delete(d.reqId);
        p.resolve(d);
      });
    }

    function requestContext(winId) {
      if (!winId) return Promise.resolve(null);
      return rpc(winId, { type: 'myhub:assistant-context' }, CONTEXT_TIMEOUT_MS).then(function (res) {
        return res && res.context ? res.context : null;
      });
    }

    // ---------- 채팅 전송 ----------
    function onSend() {
      var text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      if (binding.flavor === 'office') sendOfficeInstruct(text);
      else sendChat(text);
    }

    function sendChat(text) {
      var s = session();
      if (s.sending) return;
      var targetWinId = binding.winId;
      var personaId = binding.personaId;
      s.sending = true;
      pushMsg(s, 'user', text);
      var typing = pushMsg(s, 'assistant', '...');
      requestContext(targetWinId).then(function (context) {
        // 종전 위젯과 같은 본문 치환 규칙: "방금 만든" 치환 + 닫힌
        // 메모 ID 주입 (내용을 보내지 않는다 앱 잠금 게이트는 서버 몫).
        var sendText = text;
        if (s.lastCreatedMemoId && (text.includes('방금 만든') || text.includes('방금 생성'))) {
          sendText = text + ' (메모 ID: ' + s.lastCreatedMemoId + ')';
        }
        if (context && context.openMemoId) {
          sendText = sendText + ' (지금 보고 있는 메모 ID: ' + context.openMemoId + ')';
        }
        if (!fetchFn) {
          typing.text = '연결에 실패했어요.';
          s.sending = false;
          renderSession();
          return;
        }
        fetchFn('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personaId: personaId,
            conversationId: s.conversationId,
            messages: [{ role: 'user', content: sendText }],
          }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            var idx = s.messages.indexOf(typing);
            if (idx >= 0) s.messages.splice(idx, 1);
            if (data.conversationId) s.conversationId = data.conversationId;
            var candidateHit = null;
            if (data.toolResults) {
              for (var i = 0; i < data.toolResults.length; i++) {
                var tr = data.toolResults[i];
                if (tr.success && tr.data && tr.data.id && (tr.toolName === 'memo_create' || tr.toolName === 'memo_create_from_source')) {
                  s.lastCreatedMemoId = tr.data.id;
                }
                if (!tr.success && tr.error === 'multiple_candidates' && tr.candidates && tr.candidates.length > 0) {
                  candidateHit = tr;
                }
              }
            }
            if (candidateHit) {
              pushMsg(s, 'assistant', '비슷한 항목이 여러 개 있어요. 선택해주세요:', candidateHit.candidates, candidateHit.toolName);
              s.sending = false;
              renderSession();
              return;
            }
            if (data.ok && data.text) {
              pushMsg(s, 'assistant', data.text);
              if (data.uiActions && Array.isArray(data.uiActions) && data.uiActions.length) {
                if (targetWinId) {
                  data.uiActions.forEach(function (action) {
                    postToModule(targetWinId, { type: 'myhub:ui-action', action: action });
                  });
                } else {
                  pushMsg(s, 'assistant', '이 동작은 해당 앱 창이 앞에 있을 때 실행해요.');
                }
              }
              if (data.dataChanged && targetWinId) {
                postToModule(targetWinId, { type: 'myhub:assistant-data-changed' });
              }
            } else {
              var errMsg = '죄송해요, 응답을 받지 못했어요.';
              if (data.error) {
                if (typeof data.error === 'string') errMsg = data.error;
                else if (data.error.message) {
                  errMsg = data.error.message;
                  if (data.error.code === 'AI_DAILY_QUOTA_EXHAUSTED' && data.error.retryAfter) {
                    errMsg += ' (' + data.error.retryAfter + '초 복구합니다)';
                  }
                }
              }
              pushMsg(s, 'assistant', errMsg);
            }
            s.sending = false;
            renderSession();
          })
          .catch(function () {
            var idx = s.messages.indexOf(typing);
            if (idx >= 0) s.messages.splice(idx, 1);
            pushMsg(s, 'assistant', '연결에 실패했어요.');
            s.sending = false;
            renderSession();
          });
      });
    }

    // ---------- 오피스 모드 ----------
    var office = { reply: '', findings: [], busy: false, sub: null };
    function renderOffice() {
      if (!binding || binding.flavor !== 'office') return;
      replyEl.textContent = office.reply || '';
      findingsEl.innerHTML = '';
      (office.findings || []).forEach(function (f) {
        var li = doc.createElement('li');
        li.className = 'myhub-subchat-finding myhub-subchat-finding-' + (f.severity || 'info');
        li.textContent = f.message || '';
        findingsEl.appendChild(li);
      });
      stateEl.textContent = office.busy ? '작업 중…' : '';
      sendBtn.disabled = office.busy;
      memoBtn.disabled = office.busy;
      mailBtn.disabled = office.busy;
    }
    function officeCommand(payload) {
      if (!binding.winId) return Promise.resolve(null);
      return rpc(binding.winId, Object.assign({ type: 'myhub:assistant-office' }, payload), OFFICE_TIMEOUT_MS);
    }
    function sendOfficeInstruct(text) {
      if (office.busy || !binding.winId) return;
      office.busy = true;
      office.reply = '';
      office.findings = [];
      renderOffice();
      officeCommand({ cmd: 'instruct', text: text }).then(function (res) {
        office.busy = false;
        if (!res || !res.ok) {
          office.reply = '비서 응답이 실패했어요.';
        } else {
          office.reply = res.reply || '';
          office.findings = res.findings || [];
        }
        renderOffice();
      });
    }

    function closeSub() {
      office.sub = null;
      subEl.hidden = true;
      subEl.innerHTML = '';
    }
    function toggleMemoSub() {
      if (office.sub === 'memo') {
        closeSub();
        return;
      }
      office.sub = 'memo';
      subEl.hidden = false;
      subEl.innerHTML = '';
      var search = doc.createElement('input');
      search.type = 'text';
      search.className = 'myhub-subchat-sub-input';
      search.placeholder = '메모 검색 (비우면 최근 메모)';
      var list = doc.createElement('div');
      list.className = 'myhub-subchat-memo-list';
      subEl.appendChild(search);
      subEl.appendChild(list);
      var timer = null;
      function load(q) {
        list.textContent = '불러오는 중…';
        officeCommand({ cmd: 'memo-list', q: q }).then(function (res) {
          list.innerHTML = '';
          var memos = res && res.ok ? res.memos || [] : [];
          if (!memos.length) {
            var empty = doc.createElement('div');
            empty.className = 'myhub-subchat-empty';
            empty.textContent = '메모가 없어요. (잠긴 메모는 비서에게 보이지 않아요)';
            list.appendChild(empty);
            return;
          }
          memos.forEach(function (m) {
            var item = doc.createElement('button');
            item.type = 'button';
            item.className = 'myhub-subchat-memo-item';
            item.textContent = m.title || '(제목 없음)';
            item.addEventListener('click', function () {
              closeSub();
              if (office.busy) return;
              office.busy = true;
              renderOffice();
              officeCommand({ cmd: 'memo-create', memoId: m.id }).then(function (r2) {
                office.busy = false;
                office.reply = r2 && r2.ok ? r2.reply || '' : '문서를 만들지 못했어요.';
                renderOffice();
              });
            });
            list.appendChild(item);
          });
        });
      }
      search.addEventListener('input', function () {
        if (timer) clearTimeoutFn(timer);
        timer = setTimeoutFn(function () { load(search.value.trim()); }, 300);
      });
      load('');
      try {
        search.focus();
      } catch (e) {
        console.warn('메모 검색 사용한 실패:', e);
      }
    }
    function toggleMailSub() {
      if (office.sub === 'mail') {
        closeSub();
        return;
      }
      office.sub = 'mail';
      subEl.hidden = false;
      subEl.innerHTML = '';
      var to = doc.createElement('input');
      to.type = 'email';
      to.className = 'myhub-subchat-sub-input';
      to.placeholder = '받는 사람 이메일';
      var hint = doc.createElement('input');
      hint.type = 'text';
      hint.className = 'myhub-subchat-sub-input';
      hint.placeholder = '본문에 참고할 내용 (선택)';
      var draftBtn = doc.createElement('button');
      draftBtn.type = 'button';
      draftBtn.className = 'myhub-subchat-sub-btn';
      draftBtn.textContent = '초안 만들기';
      var view = doc.createElement('div');
      view.className = 'myhub-subchat-mail-view';
      subEl.appendChild(to);
      subEl.appendChild(hint);
      subEl.appendChild(draftBtn);
      subEl.appendChild(view);
      draftBtn.addEventListener('click', function () {
        var addr = to.value.trim();
        if (!addr) {
          view.textContent = '받는 사람을 입력해 주세요.';
          return;
        }
        office.busy = true;
        renderOffice();
        officeCommand({ cmd: 'mail-draft', to: addr, instruction: hint.value.trim() }).then(function (res) {
          office.busy = false;
          renderOffice();
          if (!res || !res.ok) {
            view.textContent = (res && res.error) || '초안 생성에 실패했어요.';
            return;
          }
          view.innerHTML = '';
          var subj = doc.createElement('div');
          subj.className = 'myhub-subchat-mail-line';
          subj.textContent = '제목: ' + (res.draft ? res.draft.subject : '');
          var body = doc.createElement('div');
          body.className = 'myhub-subchat-mail-body';
          body.textContent = res.draft ? res.draft.body : '';
          var send = doc.createElement('button');
          send.type = 'button';
          send.className = 'myhub-subchat-sub-btn myhub-subchat-mail-send';
          send.textContent = '승인하고 발송';
          send.addEventListener('click', function () {
            if (office.busy) return;
            office.busy = true;
            renderOffice();
            officeCommand({ cmd: 'mail-send' }).then(function (r2) {
              office.busy = false;
              renderOffice();
              view.textContent = r2 && r2.message ? r2.message : '발송 결과를 받지 못했어요.';
            });
          });
          view.appendChild(subj);
          view.appendChild(body);
          view.appendChild(send);
        });
      });
    }

    // ---------- 시작 ----------
    applyBinding(resolveBinding());
    var unsubscribe = null;
    if (typeof deps.onAssistantChange === 'function') {
      unsubscribe = deps.onAssistantChange(function () {
        applyBinding(resolveBinding());
      });
    }

    return {
      toggle: togglePanel,
      open: openPanel,
      close: closePanel,
      isOpen: function () { return open; },
      getBinding: function () { return binding; },
      sendChat: sendChat,
      destroy: function () {
        if (unsubscribe) unsubscribe();
        pending.forEach(function (p) { p.resolve(null); });
        pending.clear();
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        if (slotEl) slotEl.innerHTML = '';
      },
    };
  }

  var api = { create: create };
  if (typeof window !== 'undefined') window.MyHubSubchat = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubSubchat = api;
})();
