/* MyHub 서브챗 — 셸 싱글턴 비서 패널 (D-18).
 *
 * 재구성 근거: 채팅 패널을 앱 창이 아닌 셸 소유 싱글턴으로 분리하고,
 * 전경 앱 컨텍스트는 postMessage 계약으로 주입한다. 비서의 uiAction은
 * 활성 창의 iframe으로 재타기팅하고, 앱 측은 assistant-bridge.js가 받는다.
 * 선언-로드 경합은 hello 재선언으로 해결한다. 메일 승인 토큰은 결과
 * 메시지로 앱에 내보내지 않는다 (토큰 필드는 전달 대상에서 제외).
 *
 * 노출: window.MyHubDesktopSubchat + module.exports
 */
(function () {
  'use strict';

  var ASSISTANTS = [
    { id: 'rumi', name: '루미' },
    { id: 'echo', name: '에코' },
    { id: 'nova', name: '노바' },
    { id: 'cali', name: '캘리' },
  ];

  function activeFrame(doc) {
    var frame = doc.querySelector('.dt-window.is-active iframe');
    return frame || null;
  }

  function createSubchat(deps) {
    var host = deps.host;
    var doc = host.ownerDocument;
    var win = doc.defaultView || window;
    var fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var contexts = {}; // appId → context
    var currentApp = null;
    var assistant = 'rumi';
    var panel = null;
    var listEl = null;
    var inputEl = null;
    var busy = false;

    function build() {
      if (panel) return;
      panel = doc.createElement('aside');
      panel.className = 'dt-subchat';
      panel.setAttribute('aria-label', '비서 채팅');
      var head = doc.createElement('header');
      head.className = 'dt-subchat-head';
      var select = doc.createElement('div');
      select.className = 'dt-subchat-who';
      ASSISTANTS.forEach(function (a) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'dt-subchat-avatar' + (a.id === assistant ? ' is-active' : '');
        b.dataset.assistant = a.id;
        b.setAttribute('aria-label', a.name);
        var img = doc.createElement('img');
        img.src = '/avatars/' + a.id + '.webp';
        img.alt = a.name;
        b.appendChild(img);
        b.addEventListener('click', function () {
          assistant = a.id;
          select.querySelectorAll('.dt-subchat-avatar').forEach(function (n) {
            n.classList.toggle('is-active', n.dataset.assistant === a.id);
          });
        });
        select.appendChild(b);
      });
      head.appendChild(select);
      var closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dt-subchat-close';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.innerHTML = '<i data-lucide="x"></i>';
      closeBtn.addEventListener('click', close);
      head.appendChild(closeBtn);
      panel.appendChild(head);

      listEl = doc.createElement('div');
      listEl.className = 'dt-subchat-list';
      panel.appendChild(listEl);

      var form = doc.createElement('form');
      form.className = 'dt-subchat-form';
      inputEl = doc.createElement('input');
      inputEl.type = 'text';
      inputEl.placeholder = '비서에게 물어보기';
      var sendBtn = doc.createElement('button');
      sendBtn.type = 'submit';
      sendBtn.className = 'dt-subchat-send';
      sendBtn.setAttribute('aria-label', '보내기');
      sendBtn.innerHTML = '<i data-lucide="arrow-up"></i>';
      form.appendChild(inputEl);
      form.appendChild(sendBtn);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var text = inputEl.value.trim();
        if (!text || busy) return;
        inputEl.value = '';
        send(text);
      });
      panel.appendChild(form);
      host.appendChild(panel);
      if (win.lucide) { try { win.lucide.createIcons(); } catch (e) { console.debug('서브챗 아이콘 실패:', e); } }
    }

    function open() {
      build();
      panel.classList.add('is-open');
      hello(); // 선언-로드 경합: 열 때마다 hello를 재선언한다
      if (inputEl) inputEl.focus();
    }

    function close() { if (panel) panel.classList.remove('is-open'); }
    function toggle() {
      build();
      if (panel.classList.contains('is-open')) close();
      else open();
    }
    function isOpen() { return !!(panel && panel.classList.contains('is-open')); }

    function hello() {
      var frame = activeFrame(doc);
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'myhub:bridge-hello', panel: 'subchat' }, win.location.origin);
      }
    }

    function setContext(appId, ctx) {
      contexts[appId] = ctx;
      currentApp = appId;
    }

    function addMessage(role, text) {
      var row = doc.createElement('div');
      row.className = 'dt-subchat-msg dt-subchat-msg-' + role;
      row.textContent = text;
      listEl.appendChild(row);
      listEl.scrollTop = listEl.scrollHeight;
      return row;
    }

    function retargetUiAction(action) {
      // 승인 토큰류 필드는 앱으로 내보내지 않는다
      var safe = {};
      Object.keys(action || {}).forEach(function (k) {
        if (/token/i.test(k)) return;
        safe[k] = action[k];
      });
      var frame = activeFrame(doc);
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'myhub:ui-action', action: safe }, win.location.origin);
      }
    }

    async function send(text) {
      if (!fetchFn) return;
      busy = true;
      addMessage('user', text);
      var bubble = addMessage('assistant', '');
      try {
        var res = await fetchFn('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistant: assistant,
            message: text,
            app: currentApp,
            context: currentApp ? contexts[currentApp] || null : null,
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ctype = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
        if (ctype.indexOf('text/event-stream') >= 0 && res.body && res.body.getReader) {
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buf = '';
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buf += decoder.decode(chunk.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (part) {
              part.split('\n').forEach(function (line) {
                if (line.indexOf('data:') !== 0) return;
                try {
                  var evt = JSON.parse(line.slice(5).trim());
                  if (evt.delta) bubble.textContent += evt.delta;
                  if (evt.uiAction) retargetUiAction(evt.uiAction);
                } catch (e) { console.debug('SSE 파싱 실패:', e); }
              });
            });
            listEl.scrollTop = listEl.scrollHeight;
          }
        } else {
          var data = await res.json();
          var payload = data && (data.data || data);
          bubble.textContent = (payload && (payload.reply || payload.text)) || '';
          if (payload && payload.uiAction) retargetUiAction(payload.uiAction);
        }
        if (!bubble.textContent) bubble.textContent = '응답이 비어 있어요.';
      } catch (e) {
        bubble.textContent = '비서와 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
        console.debug('서브챗 전송 실패:', e);
      } finally {
        busy = false;
        listEl.scrollTop = listEl.scrollHeight;
      }
    }

    win.addEventListener('message', function (ev) {
      if (ev.origin !== win.location.origin) return;
      var d = ev.data;
      if (d && d.type === 'myhub:bridge-ready') hello();
    });

    return {
      open: open, close: close, toggle: toggle, isOpen: isOpen,
      setContext: setContext, send: send, hello: hello,
      getAssistant: function () { return assistant; },
    };
  }

  var api = { ASSISTANTS: ASSISTANTS, createSubchat: createSubchat };

  if (typeof window !== 'undefined') window.MyHubDesktopSubchat = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopSubchat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
