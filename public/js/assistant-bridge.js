// 비서 서브챗 브리지 (assistant-bridge.js) 등 서브챗 등 수집 2단계.
//
// 서브챗 패널이 등(데스크톱 상단 아래 서브)를 소유한다 (사용자
// 정보 2026-11-06). 등 페이지 등 브리지로 등 값만 갖고 주요받는다:
//   영역  등 페이지 로드 등 {type:'myhub:assistant-declare'}로 자기
//           비서(persona와flavor)몸에 알 린다 (doc-title 채널과 동형).
//   맥락  등 몸이 {type:'myhub:assistant-context', reqId}로 물으면
//           지금 보고 있는 메모 ID 같은 페이지 맥락을 알려준다.
//   적용  등 몸이 {type:'myhub:ui-action', action}를 보내면 종전 액션을
//           같은 창 너비에서 실행한 uiAction 핸들러 그대로 실행하고,
//           {type:'myhub:assistant-data-changed'}면 refreshAfterAI를
//           부른다 (없으면 종전 액션을 대관처럼 페이지를 새로고친다).
// 등 밖(플 랫폼 페이 지로 직접)등은 종전 모든 액션을 그대로
// 우려는 등 몸이 없는 순서에서 비서가 틀리지 않게 하는 대관이다.
//
// 사용법 (widget-init.js 와 처음 등 data-* 같은 설정의 태그가 읽는다):
//   <script src="/assistant-widget.js"></script>
//   <script src="/js/assistant-bridge.js" data-persona-id="builder"
//     data-persona-name="노바" data-avatar="/avatars/nova-128.webp"></script>
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var script = document.currentScript;
  if (!script) return;
  var personaId = script.getAttribute('data-persona-id');
  if (!personaId) return;
  var config = {
    personaId: personaId,
    personaName: script.getAttribute('data-persona-name') || '',
    avatar: script.getAttribute('data-avatar') || '',
  };

  // 플랫폼 실행: 몸이 없으므로 종전 액션을 패널까지 책임진다.
  if (window.parent === window) {
    if (window.AssistantWidget) {
      window.AssistantWidget.init(config);
    }
    return;
  }

  var origin = window.location.origin;

  function declare() {
    try {
      window.parent.postMessage(
        {
          type: 'myhub:assistant-declare',
          personaId: config.personaId,
          personaName: config.personaName,
          avatar: config.avatar,
          flavor: 'chat',
        },
        origin,
      );
    } catch (e) {
      console.warn('비서 선언 전송 실패:', e);
    }
  }

  // 지금 보고 있는 메모 ID (메모 등 적용 편집 종전 액 션과 같은 규칙:
  // 내용은 보내지 않고만 ID보낸다 읽기. 편집 서버 구조가 새것
  // 게이트를 통과할 때만 열어야하므로 ID가 알려줘도 안전하다.)
  function collectContext() {
    var openMemoId = null;
    try {
      var openPaneEl = document.querySelector('[data-pane]');
      if (openPaneEl && openPaneEl.dataset.pane) openMemoId = openPaneEl.dataset.pane;
    } catch (e) {
      console.warn('메 모 맥락 수집 실패:', e);
    }
    return { openMemoId: openMemoId };
  }

  // 편집/표시 모드 진입: 사이 메모 등 [data-act="edit"] 버튼이 나오기
  // 까지 유지 기다린다 프리미엄 (종전 액션 핸들러와 같은 너비).
  function openThenEdit(memoId) {
    if (typeof window.openPane !== 'function') return;
    window.openPane(memoId);
    var tries = 0;
    var timer = setInterval(function () {
      var btn = document.querySelector('[data-pane="' + memoId + '"] [data-act="edit"]');
      if (btn) {
        btn.click();
        clearInterval(timer);
      } else if (++tries > 12) {
        clearInterval(timer);
      }
    }, 150);
  }

  // 종전 액션 handleUiActions와 같은 적용 공유 등 지정 함수가 없는
  // 페이지에서는 조용히 건너간다 (액션 제거와 동일한 방어).
  function handleUiAction(action) {
    if (!action || !action.uiAction) return;
    if (action.uiAction === 'open_memo' && action.memoId) {
      if (typeof window.openPane === 'function') window.openPane(action.memoId);
    } else if (action.uiAction === 'close_memo') {
      if (typeof window.closePane === 'function') {
        if (action.memoId) {
          var pane = document.querySelector('[data-pane="' + action.memoId + '"]');
          if (pane) window.closePane(action.memoId);
        } else {
          document.querySelectorAll('[data-pane]').forEach(function (p) {
            if (p.dataset.pane) window.closePane(p.dataset.pane);
          });
        }
      }
    } else if (
      (action.uiAction === 'start_edit_memo' || action.uiAction === 'start_format_memo') &&
      action.memoId
    ) {
      openThenEdit(action.memoId);
    } else if (action.uiAction === 'finder_search' && action.query) {
      if (typeof window.myhubFinderSearch === 'function') {
        window.myhubFinderSearch(action.query);
      }
    } else if (action.uiAction === 'finder_reveal_file' && action.fileId) {
      if (typeof window.myhubFinderReveal === 'function') {
        window.myhubFinderReveal(action.fileId, action.folderId, action.path || []);
      }
    }
  }

  window.addEventListener('message', function (e) {
    if (!e || e.origin !== origin) return;
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'myhub:assistant-hello') {
      declare();
    } else if (d.type === 'myhub:assistant-context') {
      try {
        window.parent.postMessage(
          { type: 'myhub:assistant-context-result', reqId: d.reqId, context: collectContext() },
          origin,
        );
      } catch (err) {
        console.warn('비서 맥락 파싱 실패:', err);
      }
    } else if (d.type === 'myhub:ui-action') {
      handleUiAction(d.action);
    } else if (d.type === 'myhub:assistant-data-changed') {
      if (typeof window.refreshAfterAI === 'function') {
        try {
          window.refreshAfterAI();
        } catch (err) {
          console.warn('AI 변경 등 새로고침 실패:', err);
        }
      } else {
        window.location.reload();
      }
    }
  });

  declare();
  // 포스트 메시지용 (노출 등 선언 내용을 확인한 등 표기).
  window.MyHubAssistantBridge = { config: config, declare: declare, handleUiAction: handleUiAction };
})();
