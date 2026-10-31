/* MyHub 데스크톱 워크스페이스 — 부트스트랩 (main.js)
 * state.js 로드 -> windows.js 매니저 조립만 한다. 로직은 두 모듈에 있다.
 */
(function () {
  'use strict';

  function getViewport() {
    return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
  }

  function init() {
    var stateApi = window.MyHubDesktopState;
    var windowsApi = window.MyHubDesktopWindows;
    if (!stateApi || !windowsApi) return null;
    var root = document.getElementById('dt-root');
    var taskbar = document.getElementById('dt-taskbar');
    if (!root || !taskbar) return null;

    var initial = stateApi.load(window.localStorage, getViewport());
    var manager = windowsApi.createManager({
      root: root,
      taskbar: taskbar,
      stateApi: stateApi,
      storage: window.localStorage,
      getViewport: getViewport,
      state: initial,
    });
    window.MyHubDesktop = manager;
    return manager;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})();
