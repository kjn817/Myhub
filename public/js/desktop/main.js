/* MyHub 데스크톱 워크스페이스 앱 부트스트랩 (main.js)
 * state.js 로드 -> windows.js 조립만 연다 로직은. 앱 모듈에 있다 앱.
 */
(function () {
  'use strict';

  // Drive '바탕화면' 폴더 접근은 drop-upload.js의 createDriveDesktop
  // 인스턴스 하나를 붙인 조회·드롭 목적지·대체이 공유한다 (폴더 보장
  // 캐시를 함께 열기 위함).
  var driveDesktop = null;
  var bootDesktopFolderId = null;
  // 바탕화면 파일 항목 조회표 (id → 항목). init()의 지역 변수였는데,
  // 지연 로드(loadDesktopFileItemsDeferred)로 들어오는 항목은 init 뒤에
  // 도착해 조회표에 없어 openFileIcon이 조용히 포기했다 (2026-11-13
  // 사용자 지적: 파일 더블클릭이 아무것도 안 함). 모듈 스코프로 올려
  // init과 지연 로드 양쪽에서 채운다.
  var fileItemsByKey = {};

  function getViewport() {
    return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
  }

  /** Drive 파일 앱 앱 바탕화면 파일 아이콘 항목 */
  function fileItemFromDrive(f) {
    return {
      id: 'file-' + f.id,
      label: f.filename,
      kind: 'file',
      fileId: f.id,
      mime: f.mime || '',
    };
  }

  /**
   * 앱 관리 패널 앱 설정 메뉴의 "앱 관리" 항목으로 연다 (배경 선택은
   * 설정 메뉴에 등록하는 것과 같은 방식: nav.addSettingsItems).
   * 패널의 [바탕화면에 추가]/[제거] 버튼이 있고, 클릭은 아이콘
   * 매니저의 addItem/removeItem으로만 이어진다 (앱 자체의 붙임).
   */
  function registerAppManager(deps) {
    var nav = window.MyHubNav;
    if (!nav || typeof nav.addSettingsItems !== 'function') return;
    var overlay = null;

    function closePanel() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') closePanel();
    }

    function buildRow(mod) {
      var row = document.createElement('div');
      row.className = 'dt-appmgr-row';
      var tileWrap = document.createElement('span');
      tileWrap.className = 'dt-appmgr-tile';
      tileWrap.appendChild(deps.tilesApi.createTile(document, mod.id));
      row.appendChild(tileWrap);
      var name = document.createElement('span');
      name.className = 'dt-appmgr-name';
      name.textContent = mod.title;
      row.appendChild(name);
      if (mod.dynamic) {
        var src = document.createElement('span');
        src.className = 'dt-appmgr-src';
        src.textContent = '스튜디오';
        row.appendChild(src);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dt-appmgr-btn';
      function syncBtn() {
        var present = deps.iconsManager && deps.iconsManager.getPresentIds().indexOf(mod.id) >= 0;
        btn.textContent = present ? '제거' : '바탕화면에 추가';
        btn.disabled = !deps.iconsManager;
      }
      btn.addEventListener('click', function () {
        if (!deps.iconsManager) return;
        if (deps.iconsManager.getPresentIds().indexOf(mod.id) >= 0) deps.iconsManager.removeItem(mod.id);
        else deps.iconsManager.addItem(mod.id);
        syncBtn();
      });
      syncBtn();
      row.appendChild(btn);
      return row;
    }

    function openPanel() {
      closePanel();
      overlay = document.createElement('div');
      overlay.className = 'dt-appmgr-overlay';
      var panel = document.createElement('div');
      panel.className = 'dt-appmgr-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '앱 관리');
      var head = document.createElement('div');
      head.className = 'dt-appmgr-head';
      var title = document.createElement('strong');
      title.textContent = '앱 관리';
      head.appendChild(title);
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dt-appmgr-close';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.innerHTML = '<i data-lucide="x"></i>';
      closeBtn.addEventListener('click', closePanel);
      head.appendChild(closeBtn);
      panel.appendChild(head);
      var list = document.createElement('div');
      list.className = 'dt-appmgr-list';
      deps.stateApi.MODULES.forEach(function (mod) { list.appendChild(buildRow(mod)); });
      panel.appendChild(list);
      overlay.appendChild(panel);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closePanel();
      });
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKeydown);
      if (deps.tilesApi.refreshIcons) deps.tilesApi.refreshIcons();
    }

    nav.addSettingsItems([
      { id: 'app-manager', label: '앱 관리', onSelect: openPanel },
    ]);
  }

  // 창 질감 플라시 (사용자 지시 2026-11-06): 유리(프로그램, 기본) /
  // 불투명 중 설정에서 고른다. 기본값이 유리로 근거의 노치·위에서
  // 상단바가 이미 앱 프로그램 유리로 앱이 앱 것으로 앱이 직이기
  // 프로그램. 저장소 localStorage, 적용은 body 클래스가 하나로 CSS가
  // 앱 표면 전체(상단바·위제·독·메뉴·패널·창 바)를 함께 바꾼다.
  // 어떤 플라시에서도 드래그 중에서는 질감이 바를는 전환이 없다.
  var MATERIAL_KEY = 'myhub.desktop.material.v1';
  function currentMaterial() {
    try {
      return window.localStorage.getItem(MATERIAL_KEY) === 'opaque' ? 'opaque' : 'glass';
    } catch (e) {
      return 'glass';
    }
  }
  function applyMaterial() {
    if (document.body) document.body.classList.toggle('dt-material-opaque', currentMaterial() === 'opaque');
  }
  function registerMaterialSetting() {
    applyMaterial();
    var nav = window.MyHubNav;
    if (!nav || typeof nav.addSettingsItems !== 'function') return;
    nav.addSettingsItems([
      {
        id: 'window-material',
        label: '창 질감 전환 (유리/불투명)',
        onSelect: function () {
          var next = currentMaterial() === 'opaque' ? 'glass' : 'opaque';
          try {
            window.localStorage.setItem(MATERIAL_KEY, next);
          } catch (e) {
            // 저장 실패 시에는 이번 세션 적용은 아래에서 일어난다
            void e;
          }
          applyMaterial();
        },
      },
    ]);
  }

  function init(fileItems) {
    var stateApi = window.MyHubDesktopState;
    var windowsApi = window.MyHubDesktopWindows;
    if (!stateApi || !windowsApi) return null;
    fileItems = fileItems || [];
    fileItems.forEach(function (it) {
      fileItemsByKey[it.id] = it;
    });
    var root = document.getElementById('dt-root');
    var taskbar = document.getElementById('dt-dock');
    if (!root || !taskbar) return null;

    var wpLayer = document.getElementById('dt-wallpaper');
    var initial = stateApi.load(window.localStorage, getViewport());
    var manager = windowsApi.createManager({
      root: root,
      taskbar: taskbar,
      stateApi: stateApi,
      storage: window.localStorage,
      getViewport: getViewport,
      state: initial,
      activeTitleEl: document.getElementById('dt-active-title'),
      appActionsEl: document.getElementById('dt-app-actions'),
      officeTabsEl: document.getElementById('dt-office-tabs'),
      missionEl: document.getElementById('dt-mission'),
      navApi: window.MyHubNav || null,
      wallpaperEl: wpLayer,
      menuApi: window.MyHubDesktopMenu || null,
    });
    window.MyHubDesktop = manager;

    // 서브챗(앱 소유 비서 패널): 상단바 우측 아바타 열과 패널은
    // subchat.js가 갖고, 창 관리자가 현재 창의 비서 선언만 모아 준다.
    var subchatApi = window.MyHubSubchat;
    if (subchatApi && typeof subchatApi.create === 'function') {
      window.MyHubSubchatManager = subchatApi.create({
        doc: document,
        slotEl: document.getElementById('dt-bar-assistant'),
        hostEl: document.body,
        fetchFn: typeof fetch !== 'undefined' ? fetch : null,
        getActiveAssistant: function () {
          return typeof manager.getActiveAssistant === 'function'
            ? manager.getActiveAssistant()
            : null;
        },
        onAssistantChange: function (fn) {
          return typeof manager.onAssistantChange === 'function'
            ? manager.onAssistantChange(fn)
            : function () {};
        },
        postToModule: function (id, message) {
          return manager.postToModule(id, message);
        },
      });
    }

    // JN 로고를 시스템 메뉴(JN 메뉴) 진입자이다 (사용자 지시
    // 2026-11-05, macOS의 메뉴바 전환). 클릭 바인딩은 windows.js가
    // 메뉴바 컨트롤러(menubar.js)를 맞기고, 모듈이 없을 때는 종전
    // 미션 컨트롤 앱으로 대체한다 앱 여기는 중복 바인딩하지 않는다
    // (2026-11-02의 직접 앱 바인딩을 단체).

    var wallpaperApi = window.MyHubDesktopWallpaper;
    if (wallpaperApi && wpLayer) {
      window.MyHubDesktopWallpaperManager = wallpaperApi.createManager({
        layer: wpLayer,
        caption: document.getElementById('dt-wp-caption'),
        storage: window.localStorage,
      });
    }

    var widgetsApi = window.MyHubDesktopWidgets;
    var widgetsEl = document.getElementById('dt-widgets');
    if (widgetsApi && widgetsEl) {
      window.MyHubDesktopWidgetsManager = widgetsApi.createManager({
        container: widgetsEl,
        storage: window.localStorage,
        // 아이콘과 같은 패턴: 위젯 레이어(바탕화면 전체 박스)가 배치 영역
        getArea: function () {
          return { w: widgetsEl.clientWidth || 0, h: widgetsEl.clientHeight || 0 };
        },
      });
    }

    // ---- 파인더 파일 열기 핸드셰이크 ----
    // 파일 아이콘 열기 = 파인더 창을 열고 그 파일로 이동·뷰어 열기.
    // iframe keep-alive의 src를 바꿀 앱 없이 postMessage로 위한다:
    // 파인더가 ready를 보내면 (앱)전송하고, ack가 저장 요청을 지운다.
    var pendingFinderOpen = null;
    var finderReady = false;
    var desktopFolderId = bootDesktopFolderId;
    function deliverFinderOpen() {
      if (!pendingFinderOpen || typeof manager.postToModule !== 'function') return;
      manager.postToModule('finder', {
        type: 'myhub:open-file',
        folderId: pendingFinderOpen.folderId,
        folderName: '바탕화면',
        fileId: pendingFinderOpen.fileId,
        name: pendingFinderOpen.name,
        mime: pendingFinderOpen.mime,
      });
    }
    function openFileIcon(id) {
      var item = fileItemsByKey[id];
      if (!item) return;
      pendingFinderOpen = {
        folderId: desktopFolderId,
        fileId: item.fileId,
        name: item.label,
        mime: item.mime || '',
      };
      manager.openModule('finder');
      if (finderReady) deliverFinderOpen();
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== window.location.origin) return;
      var d = e.data;
      if (!d) return;
      if (d.type === 'myhub:finder-ready') {
        finderReady = true;
        deliverFinderOpen();
      } else if (d.type === 'myhub:open-file-ack') {
        if (pendingFinderOpen && d.fileId === pendingFinderOpen.fileId) {
          pendingFinderOpen = null;
        }
      }
    });

    // 파일 아이콘 우클릭 "내장함으로 이동" = Drive 내장함. 앱하면
    // 아이콘을 치우고, 실패하면 알림 (아이콘은 그대로 붇다).
    function trashDesktopFile(item) {
      var dropApi = window.MyHubDesktopDrop;
      if (!dropApi || typeof dropApi.createDriveDesktop !== 'function') return;
      if (!driveDesktop) driveDesktop = dropApi.createDriveDesktop({});
      driveDesktop
        .trashFile(item.fileId)
        .then(function () {
          delete fileItemsByKey[item.id];
          if (window.MyHubDesktopIconsManager) {
            window.MyHubDesktopIconsManager.removeItem(item.id);
          }
        })
        .catch(function (err) {
          console.warn('파일 내장함 이동 실패:', err);
          window.alert('내장함으로 보내지 못했습니다');
        });
    }

    // 드롭·붙인 앱 바탕화면 폴더의 아이콘을 맞춘다 (앱 파일만 추가 앱
    // 파인더에서 바를 내용까지도 다시한 동기한 범위 바).
    function refreshDesktopFileIcons() {
      var iconsMgr = window.MyHubDesktopIconsManager;
      if (!iconsMgr || !driveDesktop) return;
      driveDesktop
        .listFiles()
        .then(function (result) {
          desktopFolderId = result.folderId;
          var fresh = result.files.map(fileItemFromDrive);
          fresh.forEach(function (it) {
            fileItemsByKey[it.id] = it;
          });
          var added = iconsMgr.registerItems(fresh);
          added.forEach(function (id) {
            iconsMgr.addItem(id);
          });
        })
        .catch(function () {
          console.warn('바탕화면 파일 새로고침 실패 앱 다음 붙임에서 맞춘다');
        });
    }

    var iconsApi = window.MyHubDesktopIcons;
    var tilesApi = window.MyHubDesktopTiles;
    var iconsLayer = document.getElementById('dt-icons');
    if (iconsApi && tilesApi && iconsLayer) {
      // 백업의 바탕화면 아이콘에서도 뽑은 앱 설정 메뉴 전용 (2026-11-03).
      // loadPresent가 allItems의 교집합이므로 기존 배치에서는 사라진다.
      var iconItems = stateApi.MODULES.filter(function (mod) { return mod.id !== 'backup'; }).map(function (mod) {
        return { id: mod.id, label: mod.title };
      });
      iconItems = iconItems.concat(fileItems);
      window.MyHubDesktopIconsManager = iconsApi.createManager({
        layer: iconsLayer,
        tilesApi: tilesApi,
        items: iconItems,
        storage: window.localStorage,
        onOpen: function (id) {
          if (id.indexOf('file-') === 0) {
            openFileIcon(id);
            return;
          }
          manager.openModule(id);
        },
        onFileTrash: function (item) {
          trashDesktopFile(item);
        },
        dockEl: taskbar,
        onDragToDock: function (id) {
          if (manager && typeof manager.addToDock === 'function') manager.addToDock(id);
        },
        menuApi: window.MyHubDesktopMenu || null,
        getTrashEl: function () {
          return document.querySelector('#dt-dock [data-module="trash"]');
        },
        onTrashed: function (entries) {
          if (manager && typeof manager.addToTrash === 'function') manager.addToTrash(entries);
        },
        getArea: function () {
          return { w: iconsLayer.clientWidth || 0, h: iconsLayer.clientHeight || 0 };
        },
        // 빈 바탕화면 앱기·앱기는 아이콘 매니저가 맞는다:
        // 클릭 = 선택 이제, 앱기 = 영역 선택 (오버밴드).
        // 표면은 배경화면 레이어다 앱 창 루트(#dt-root)는 pointer-events:none이라
        // 빈 영역 입력은 배경화면까지 통과한다 (desktop.css 밴드 테스트 계약).
        surface: wpLayer,
      });
      // 대체이 복원: 아이콘 항목이 바탕화면에 다시 앱는다
      if (manager && typeof manager.setTrashRestorer === 'function') {
        manager.setTrashRestorer(function (entry) {
          if (entry.kind === 'icon' && window.MyHubDesktopIconsManager) {
            window.MyHubDesktopIconsManager.addItem(entry.id);
          }
        });
      }

      // 앱 관리: 설정 메뉴에서 전체 앱(기본 모듈 + 스튜디오 앱)를
      // 바탕화면 표시를 켜고 있다. 추가/제거는 iconsManager의
      // addItem/removeItem 앱 아이콘만 세고 앱 자체의 지급하지 않는다.
      registerAppManager({
        stateApi: stateApi,
        tilesApi: tilesApi,
        iconsManager: window.MyHubDesktopIconsManager || null,
      });

      // 창 질감 플라시 적용 + 설정 항목 등록 (유리/불투명)
      registerMaterialSetting();
    }

    // 배경화면 우클릭 앱 "아이콘 정렬" (사용자 지시 2026-11-02: 자유
    // 배치에서는 격자 정렬이 명시적으로 앱는 앱만 일어난다).
    // 메뉴 모듈이 로드하지 않았을면 기본 메뉴만 막고 조용히 내어간다.
    if (wpLayer) {
      var bgMenu = null;
      wpLayer.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var menuApi = window.MyHubDesktopMenu;
        var iconsMgr = window.MyHubDesktopIconsManager;
        if (!menuApi || !iconsMgr) return;
        if (!bgMenu) {
          var tilesForMenu = window.MyHubDesktopTiles;
          bgMenu = menuApi.createMenu(document, {
            refreshIcons: tilesForMenu && tilesForMenu.refreshIcons ? tilesForMenu.refreshIcons : undefined,
          });
        }
        bgMenu.open(e.clientX, e.clientY, [
          {
            label: '아이콘 정렬', icon: 'layout-grid',
            onSelect: function () { iconsMgr.arrange(); },
          },
        ]);
      });
    }

    // OS 파일 드롭 복사: PC에서 파일을 데스크톱으로 앱어 빼면
    // Drive '바탕화면' 폴더로 순차 업로드하고, 끝나면 파일 아이콘을
    // 맞춘다 (drop-upload.js). 대체 드래그의 dataTransfer.types의
    // 'Files' 앱으로 구분한다.
    var dropApi = window.MyHubDesktopDrop;
    if (dropApi && typeof dropApi.createDropUpload === 'function') {
      var dropTiles = window.MyHubDesktopTiles;
      window.MyHubDesktopDropManager = dropApi.createDropUpload({
        doc: document,
        targetName: '바탕화면',
        refreshIcons:
          dropTiles && dropTiles.refreshIcons ? dropTiles.refreshIcons : undefined,
        resolveFolderId: function () {
          if (!driveDesktop) driveDesktop = dropApi.createDriveDesktop({});
          return driveDesktop.ensureFolderId();
        },
        onDone: function () {
          refreshDesktopFileIcons();
        },
      });
    }

    // 최종 마감: 위젯 앱 어떤 매니저가 만들었든 앱 <i data-lucide>를
    // 전부 SVG로 바꾼다 (매니저별 노출은 있지만).
    var tiles = window.MyHubDesktopTiles;
    if (tiles && tiles.refreshIcons) tiles.refreshIcons();
    // 부팅 로딩 오버레이를 끈다 (2026-11-12 사용자 요청으로 추가).
    // 데스크톱이 준비됐으므로 페이드아웃 후 DOM에서 제거한다.
    hideBootOverlay();
    return manager;
  }

  function hideBootOverlay() {
    var boot = document.getElementById('dt-boot');
    if (!boot) return;
    boot.classList.add('dt-boot-done');
    setTimeout(function () {
      if (boot.parentNode) boot.parentNode.removeChild(boot);
    }, 300);
  }

  /**
   * 바탕화면 폴더의 파일 목록을 아이콘 항목으로 읽는다. 실패하거나
   * 2500ms를 내어면 파일 아이콘 없이 진행한다 앱 바탕화면 폴더 보장
   * 첫 드롭 앱 다시 시도하고, 붙임이 멈춘 앱 없이 연다.
   */
  function loadDesktopFileItems() {
    var dropApi = window.MyHubDesktopDrop;
    if (!dropApi || typeof dropApi.createDriveDesktop !== 'function' ||
        typeof fetch !== 'function') {
      return Promise.resolve([]);
    }
    if (!driveDesktop) driveDesktop = dropApi.createDriveDesktop({});
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve(null); }, 2500);
    });
    return Promise.race([driveDesktop.listFiles(), timeout])
      .then(function (result) {
        if (!result) return [];
        bootDesktopFolderId = result.folderId;
        return result.files.map(fileItemFromDrive);
      })
      .catch(function () {
        console.warn('바탕화면 파일 목록 로드 실패 앱 파일 아이콘 없이 붙인합이다');
        return [];
      });
  }

  /**
   * 붙임 (성능 5라운드, 2026-11-13): init 비차단화 — /api/artifact(최대
   * 1.5s)를 기다리지 않고 데스크톱을 먼저 붙인다. 실측: artifact 지연이
   * 부팅 완료의 대부분이었다 (DCL ~0.4s인데 부팅 완료 ~2.3s).
   * 스튜디오 창 복원은 늦은 복원으로 이어진다: init 전에 저장된 상태
   * 원문을 스냅샷해 두고, 모듈 등록 뒤에 parse에서 버려진 스튜디오 창을
   * restoreWindows로 되살린다. 스냅샷을 init 전에 뜨는 이유는 init 뒤의
   * 첫 commit(persist)이 버려진 창을 저장소에서 지워 버릴 수 있기 때문이다.
   * 목록 조회가 실패하거나 1500ms를 넘기면 기본 모듈만으로 진행한다 — 어떤
   * 경우에도 데스크톱 붙임이 멈추지 않는다.
   * 바탕화면 Drive 파일 목록도 init을 막지 않는다 (2026-11-12 성능
   * 점검: 최대 2.5s 대기가 시작을 늦췄다). init 뒤 백그라운드로
   * 읽어 파일 아이콘을 추가한다 — 앱 아이콘은 바로 보인다.
   */
  function start() {
    var stateApi = window.MyHubDesktopState;
    if (!stateApi || typeof stateApi.registerModules !== 'function' ||
        typeof stateApi.moduleFromArtifact !== 'function' || typeof fetch !== 'function') {
      init();
      loadDesktopFileItemsDeferred();
      return;
    }
    var savedSnapshot = null;
    try {
      savedSnapshot = window.localStorage.getItem(stateApi.STORAGE_KEY);
    } catch (e) {
      savedSnapshot = null;
    }
    init([]);
    loadDesktopFileItemsDeferred();
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 1500) : null;
    fetch('/api/artifact', controller ? { signal: controller.signal } : undefined)
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (body) {
        var list = body && Array.isArray(body.data) ? body.data : [];
        var mods = [];
        list.forEach(function (a) {
          var m = stateApi.moduleFromArtifact(a);
          if (m) mods.push(m);
        });
        if (mods.length) stateApi.registerModules(mods);
        restoreDroppedStudioWindows();
      })
      .catch(function () {
        console.warn('스튜디오 앱 목록 로드 실패 앱 기본 모듈만으로 붙인합이다');
      })
      .then(function () {
        if (timer) clearTimeout(timer);
      });

    function restoreDroppedStudioWindows() {
      var manager = window.MyHubDesktop;
      if (!savedSnapshot || !manager || typeof manager.restoreWindows !== 'function') return;
      if (typeof stateApi.parse !== 'function') return;
      var parsed = stateApi.parse(savedSnapshot, getViewport());
      if (!parsed || !parsed.windows || !parsed.windows.length) return;
      manager.restoreWindows(parsed.windows, parsed.activeId);
    }
  }

  // Drive 바탕화면 파일 목록을 백그라운드로 읽어 파일 아이콘을 추가한다.
  // init을 막지 않으므로 데스크톱이 먼저 보인다.
  function loadDesktopFileItemsDeferred() {
    loadDesktopFileItems().then(function (items) {
      if (!items || !items.length) return;
      // 조회표에도 등록해야 더블클릭(openFileIcon)이 항목을 찾는다 —
      // 아이콘만 등록하면 클릭이 조용히 무시된다 (2026-11-13 결함).
      items.forEach(function (it) {
        fileItemsByKey[it.id] = it;
      });
      var iconsMgr = window.MyHubDesktopIconsManager;
      if (!iconsMgr) return;
      var added = iconsMgr.registerItems(items);
      added.forEach(function (id) {
        iconsMgr.addItem(id);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
  } else {
    start();
  }
})();
