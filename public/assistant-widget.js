/**
 * 모듈 비서 위젯 — 각 모듈 페이지에 비서 아바타 + 플로팅 채팅
 * 사용법: <script src="/assistant-widget.js"></script>
 *         AssistantWidget.init({ personaId: 'scheduler', personaName: '캘리', avatar: '/avatars/cali.webp' });
 */
(function () {
  'use strict';

  var W = {
    personaId: 'concierge',
    personaName: '비서',
    avatar: '',
    open: false,
    sending: false,

    init: function (opts) {
      this.personaId = opts.personaId || 'concierge';
      this.personaName = opts.personaName || '비서';
      this.avatar = opts.avatar || '';
      // 81차: 대화 ID를 메모리 변수로 관리 (서버 발급, localStorage 미사용)
      this.conversationId = null;
      // 82차: 마지막 생성 메모 ID (방금 만든 참조용)
      this.lastCreatedMemoId = null;
      this.build();
      this.bind();
      // 페이지 로드 시 서버에서 활성 대화 ID 복구
      this.restoreConversation();
    },

    // 81차: 서버에서 활성 대화 ID 조회
    restoreConversation: function () {
      var self = this;
      fetch('/api/ai/conversations/active?personaId=' + encodeURIComponent(this.personaId))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok && data.conversationId) {
            self.conversationId = data.conversationId;
          }
        })
        .catch(function (e) { console.warn('대화 저장 실패:', e); });
    },

    build: function () {
      // 아바타 버튼 (상단바에 추가)
      var nav = document.querySelector('.g-nav');
      if (nav) {
        var clock = nav.querySelector('#clock');
        var btn = document.createElement('button');
        btn.id = 'awAvatarBtn';
        btn.className = 'aw-avatar-btn';
        btn.setAttribute('aria-label', this.personaName + '에게 묻기');
        btn.innerHTML = '<img src="' + this.avatar + '" alt="' + this.personaName + '">';
        if (clock) { nav.insertBefore(btn, clock); }
        else { nav.appendChild(btn); }
      }

      // 플로팅 패널
      var panel = document.createElement('div');
      panel.id = 'awPanel';
      panel.className = 'aw-panel';
      panel.innerHTML =
        '<div class="aw-head">' +
          '<img src="' + this.avatar + '" alt="' + this.personaName + '" class="aw-head-avatar">' +
          '<div class="aw-head-info"><div class="aw-head-name">' + this.personaName + '</div>' +
          '<div class="aw-head-sub">이 페이지에서 바로 물어보세요</div></div>' +
          '<button class="aw-close" id="awClose" aria-label="닫기"><i data-lucide="x"></i></button>' +
        '</div>' +
        '<div class="aw-msgs" id="awMsgs"></div>' +
        '<div class="aw-input-row">' +
          '<input id="awInput" type="text" placeholder="' + this.personaName + '에게 물어보기..." autocomplete="off">' +
          '<button id="awSend" aria-label="전송"><i data-lucide="arrow-up"></i></button>' +
        '</div>';
      document.body.appendChild(panel);

      if (window.lucide) lucide.createIcons();
    },

    bind: function () {
      var self = this;
      document.getElementById('awAvatarBtn').addEventListener('click', function () { self.toggle(); });
      document.getElementById('awClose').addEventListener('click', function () { self.close(); });
      document.getElementById('awSend').addEventListener('click', function () { self.send(); });
      document.getElementById('awInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') self.send();
      });
    },

    toggle: function () {
      this.open ? this.close() : this.openPanel();
    },

    openPanel: function () {
      this.open = true;
      document.getElementById('awPanel').classList.add('open');
      var msgs = document.getElementById('awMsgs');
      if (!msgs.children.length) {
        this.addMsg('assistant', '안녕하세요! ' + this.personaName + '예요. 무엇을 도와드릴까요?');
      }
      setTimeout(function () { document.getElementById('awInput').focus(); }, 100);
    },

    close: function () {
      this.open = false;
      document.getElementById('awPanel').classList.remove('open');
    },

    addMsg: function (role, text) {
      var msgs = document.getElementById('awMsgs');
      var div = document.createElement('div');
      div.className = 'aw-msg ' + role;
      div.innerHTML = this.markdown(text);
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    },
    markdown: function(text) {
      var html = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // (id: 123) 같은 내부 식별자 제거
      html = html.replace(/\s*\(id:\s*\d+\)/g, '');
      // 체크박스: - [ ] → ☐, - [x] → ☑
      html = html.replace(/^- \[ \] /gm, '☐ ');
      html = html.replace(/^- \[x\] /gm, '☑ ');
      // 굵게: **text**
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // 줄바꿈
      html = html.replace(/\n/g, '<br>');
      return html;
    },

    send: async function () {
      var input = document.getElementById('awInput');
      var text = input.value.trim();
      if (!text || this.sending) return;
      this.sending = true;
      input.value = '';
      this.addMsg('user', text);
      var typing = this.addMsg('assistant', '...');
      typing.classList.add('typing');

      // 82차: "방금 만든"을 실제 ID로 변환 (클라이언트에서 명시적 처리)
      var sendText = text;
      if (this.lastCreatedMemoId && (text.includes('방금 만든') || text.includes('방금 생성'))) {
        sendText = text + ' (메모 ID: ' + this.lastCreatedMemoId + ')';
      }

      try {
        var res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personaId: this.personaId,
            // 81차: 명시적 conversationId 전달 (서버 자동 추측 폐기)
            conversationId: this.conversationId,
            messages: [{ role: 'user', content: sendText }]
          })
        });
        var data = await res.json();
        typing.remove();
        // 81차: 서버에서 발급한 conversationId를 메모리에 저장
        if (data.conversationId) {
          this.conversationId = data.conversationId;
        }
        // 82차: 생성된 메모 ID 저장
        if (data.toolResults) {
          for (var i = 0; i < data.toolResults.length; i++) {
            var tr = data.toolResults[i];
            if (tr.success && tr.data && tr.data.id && (tr.toolName === 'memo_create' || tr.toolName === 'memo_create_from_source')) {
              this.lastCreatedMemoId = tr.data.id;
            }
            // 후보 선택 버튼 표시 (일정/할일 중복 시)
            if (!tr.success && tr.error === 'multiple_candidates' && tr.candidates && tr.candidates.length > 0) {
              this.showCandidateButtons(tr.candidates, tr.toolName);
              typing.remove();
              this.sending = false;
              return;
            }
          }
        }
        if (data.ok && data.text) {
          this.addMsg('assistant', data.text);
          // UI 액션 처리 (메모 열기/닫기 등)
          if (data.uiActions && Array.isArray(data.uiActions)) {
            this.handleUiActions(data.uiActions);
          }
          // 데이터 변경 시 페이지별 새로고침
          if (data.dataChanged) {
            if (typeof window.refreshAfterAI === 'function') {
              window.refreshAfterAI();
            } else {
              location.reload();
            }
          }
        } else {
          // 89차: 구조화된 오류 메시지 표시 (할당량 소진 등)
          var errMsg = '죄송해요, 응답을 받지 못했어요.';
          if (data.error) {
            if (typeof data.error === 'string') {
              errMsg = data.error;
            } else if (data.error.message) {
              errMsg = data.error.message;
              // 할당량 소진 시 재시도 안내 추가
              if (data.error.code === 'AI_DAILY_QUOTA_EXHAUSTED' && data.error.retryAfter) {
                errMsg += ' (' + data.error.retryAfter + '에 복구됩니다)';
              }
            }
          }
          this.addMsg('assistant', errMsg);
        }
      } catch (e) {
        typing.remove();
        this.addMsg('assistant', '연결에 실패했어요.');
      }
      this.sending = false;
    },

    showCandidateButtons: function (candidates, toolName) {
      var self = this;
      var msgDiv = document.createElement('div');
      msgDiv.className = 'msg assistant';
      
      var label = document.createElement('div');
      label.textContent = '여러 항목이 발견됐습니다. 선택해주세요:';
      label.style.marginBottom = '8px';
      msgDiv.appendChild(label);
      
      var btnContainer = document.createElement('div');
      btnContainer.style.display = 'flex';
      btnContainer.style.flexDirection = 'column';
      btnContainer.style.gap = '6px';
      
      candidates.forEach(function (c) {
        var btn = document.createElement('button');
        btn.className = 'candidate-btn';
        btn.style.cssText = 'padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; text-align: left; font-size: 14px;';
        btn.onmouseover = function() { btn.style.background = '#f0f7ff'; };
        btn.onmouseout = function() { btn.style.background = '#fff'; };
        
        var dateStr = c.start_at ? c.start_at.split('T')[0] : '';
        btn.textContent = c.title + (dateStr ? ' (' + dateStr + ')' : '');
        
        btn.onclick = function() {
          // 버튼 비활성화
          var buttons = btnContainer.querySelectorAll('button');
          buttons.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
          btn.style.opacity = '1';
          btn.style.background = '#e6f0ff';
          
          // 선택된 ID로 다시 요청
          var action = 'delete';
          if (toolName && toolName.indexOf('update') >= 0) action = 'update';
          
          var retryMsg = 'ID ' + c.id + '번 일정 ' + (action === 'delete' ? '삭제해줘' : '선택했어');
          self.addMsg('user', retryMsg);
          self.send(retryMsg);
        };
        
        btnContainer.appendChild(btn);
      });
      
      msgDiv.appendChild(btnContainer);
      this.messagesEl.appendChild(msgDiv);
      this.scrollToBottom();
    },

    handleUiActions: function (actions) {
      var self = this;
      actions.forEach(function (action) {
        if (action.uiAction === 'open_memo' && action.memoId) {
          // 메모 열기: pane.js의 openPane 호출
          if (typeof window.openPane === 'function') {
            window.openPane(action.memoId);
          }
        } else if (action.uiAction === 'close_memo') {
          // 메모 닫기: pane.js의 closePane 호출
          if (typeof window.closePane === 'function') {
            var closed = false;
            if (action.memoId) {
              // 특정 메모 닫기
              var pane = document.querySelector('[data-pane="' + action.memoId + '"]');
              if (pane) {
                window.closePane(action.memoId);
                closed = true;
              }
            } else {
              // 열린 모든 패널 닫기
              var panes = document.querySelectorAll('[data-pane]');
              if (panes.length > 0) {
                panes.forEach(function (pane) {
                  var id = pane.dataset.pane;
                  if (id) window.closePane(id);
                });
                closed = true;
              }
            }
            // 실제로 닫힌 패널이 없으면 사용자에게 알림
            if (!closed) {
              self.addMsg('assistant', '현재 열린 메모가 없습니다.');
            }
          } else if (action.uiAction === 'start_edit_memo' && action.memoId) {
            // 69차: 편집 모드 진입
            if (typeof window.openPane === 'function') {
              window.openPane(action.memoId);
              // 편집 모드 진입 (pane.js의 edit 기능 호출)
              setTimeout(function () {
                var editBtn = document.querySelector('[data-pane="' + action.memoId + '"] .edit-btn');
                if (editBtn) editBtn.click();
              }, 500);
            }
          } else if (action.uiAction === 'start_format_memo' && action.memoId) {
            // 69차: 서식 편집 모드 진입
            if (typeof window.openPane === 'function') {
              window.openPane(action.memoId);
              setTimeout(function () {
                var formatBtn = document.querySelector('[data-pane="' + action.memoId + '"] .format-btn');
                if (formatBtn) formatBtn.click();
                else {
                  // 서식 버튼이 없으면 편집 모드로 대체
                  var editBtn = document.querySelector('[data-pane="' + action.memoId + '"] .edit-btn');
                  if (editBtn) editBtn.click();
                }
              }, 500);
            }
          }
        }
      });
    }
  };

  window.AssistantWidget = W;
})();
