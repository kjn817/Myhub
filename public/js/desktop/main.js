/* MyHub 데스크톱 부트스트랩 — 모듈 조립만 한다.
 *
 * 재구성 근거: 구 홈 흡수 후 셸이 본체가 된 구조. 조립 순서:
 * state 로드 → 창 관리자·독·아이콘·위젯·배경화면·서브챗 연결 →
 * 동적 모듈(시스템 폴더) 등록 → 상단바(JN=미션 토글, 시계, 프록시 슬롯).
 * 밴드 선택 표면은 배경 레이어(wpLayer = #dt-surface)이고, 선택 판정은
 * desktop-icons의 selectInRect가 맡는다. 구 #dt-trash 패널은 최종 상태에서
 * 제거됨 — 삭제 동선은 우클릭 메뉴·독 휴지통 드롭뿐이다.
 */
(function () {
  'use strict';

  function getViewport() {
    return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
  }

  function init() {
    var S = window.MyHubDesktopState;
    var W = window.MyHubDesktopWindows;
    var T = window.MyHubDesktopTiles;
    var D = window.MyHubDesktopDock;
    var I = window.MyHubDesktopIcons;
    var WG = window.MyHubDesktopWidgets;
    var MN = window.MyHubDesktopMenu;
    var WP = window.MyHubDesktopWallpaper;
    var SC = window.MyHubDesktopSubchat;
    var FI = window.MyHubFileIcons;
    if (!S || !W || !T || !D || !I) return null;

    var storage = window.localStorage;
    var root = document.getElementById('dt-root');
    var taskbar = document.getElementById('dt-taskbar');
    var surface = document.getElementById('dt-surface');
    var iconsLayer = document.getElementById('dt-icons');
    var widgetsLayer = document.getElementById('dt-widgets');
    var wallpaperLayer = document.getElementById('dt-wallpaper');
    var captionEl = document.getElementById('dt-wallpaper-cap');
    var actionsEl = document.getElementById('dt-app-actions');
    var appTitleEl = document.getElementById('dt-app-title');
    var assistantEl = document.getElementById('dt-bar-assistant');
    var subchatHost = document.getElementById('dt-subchat');

    var state;
    try {
      state = S.load(storage);
    } catch (e) {
      console.debug('데스크톱 상태 복원 실패 — 기본값 사용:', e);
      state = S.emptyState();
    }

    var subchat = SC ? SC.createSubchat({ host: subchatHost }) : null;
    var manager = null;
    var icons = null;
    var dock = null;
    var settingsMenu = null;
    var wallpaperApi = null;
    var driveTrashCount = 0;

    function titlesMap() {
      var map = {};
      S.MODULES.forEach(function (m) { map[m.id] = m.title; });
      return map;
    }

    function totalTrash() {
      var local = icons ? icons.getTrashCount() : I.loadTrash(storage).length;
      return local + driveTrashCount;
    }

    function renderDock(ctx) {
      if (!dock) return;
      dock.render({ running: (ctx && ctx.running) || {}, trashCount: totalTrash() });
    }

    function buildDock() {
      dock = D.createDock({
        root: taskbar,
        tiles: T,
        ids: D.loadDockIds(storage),
        titles: titlesMap(),
        getRecents: function () { return D.loadRecents(storage); },
        onOpen: function (id) {
          if (!manager) return;
          if (id === 'mission') manager.toggleMission();
          else manager.openModule(id);
        },
        onContextMenu: function (id, ev, opts) {
          if (!MN) return;
          var items = [{ label: '열기', onSelect: function () { if (manager) manager.openModule(id); } }];
          if (opts.pinned) {
            items.push({
              label: '독에서 제거', disabled: id === 'finder',
              onSelect: function () {
                dock.setIds(dock.getIds().filter(function (x) { return x !== id; }));
                D.saveDockIds(storage, dock.getIds());
                if (manager) manager.sync();
              },
            });
          } else {
            items.push({
              label: '독에 고정',
              onSelect: function () {
                dock.setIds(dock.getIds().concat([id]));
                D.saveDockIds(storage, dock.getIds());
                D.saveRecents(storage, D.loadRecents(storage).filter(function (x) { return x !== id; }));
                if (manager) manager.sync();
              },
            });
          }
          MN.show({ x: ev.clientX, y: ev.clientY, items: items });
        },
        onRemove: function (id) {
          D.saveDockIds(storage, dock.getIds());
          if (manager) manager.sync();
        },
        onReorder: function (ids) { D.saveDockIds(storage, ids); },
        onOpenSettings: function (ev) {
          if (settingsMenu) settingsMenu.toggle(ev.currentTarget);
        },
        onOpenTrash: function () { if (manager) manager.openFinderTrash(); },
        onTrashContextMenu: function (ev) { showTrashMenu(ev.clientX, ev.clientY); },
      });
    }

    function showTrashMenu(x, y) {
      if (!MN || !manager) return;
      var items = [
        { label: 'Finder에서 휴지통 열기', onSelect: function () { manager.openFinderTrash(); } },
      ];
      var local = icons ? icons.getTrashCount() : 0;
      if (local > 0 || driveTrashCount > 0) {
        items.push({ label: '휴지통 비우기', danger: true, onSelect: emptyTrash });
      }
      MN.show({ x: x, y: y, items: items });
    }

    function emptyTrash() {
      if (!window.confirm('휴지통을 비울까요? 되돌릴 수 없어요.')) return;
      if (icons) icons.purgeAllTrash();
      purgeDriveTrash().then(function () {
        driveTrashCount = 0;
        if (manager) { manager.broadcastIconTrashChanged(); manager.sync(); }
      });
    }

    function purgeDriveTrash() {
      // Drive 휴지통: 폴더 전부 + 폴더 경유가 아닌 파일만 순차 삭제
      return fetch('/api/drive/trash')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          var payload = (data && (data.data || data)) || {};
          var chain = Promise.resolve();
          (payload.folders || []).forEach(function (f) {
            chain = chain.then(function () {
              return fetch('/api/drive/folders/' + encodeURIComponent(f.id), { method: 'DELETE' }).catch(function (e) { console.warn('휴지통 폴더 비우기 실패:', e); });
            });
          });
          (payload.files || []).filter(function (f) { return !f.via_folder; }).forEach(function (f) {
            chain = chain.then(function () {
              return fetch('/api/drive/files/' + encodeURIComponent(f.id), { method: 'DELETE' }).catch(function (e) { console.warn('휴지통 파일 비우기 실패:', e); });
            });
          });
          return chain;
        })
        .catch(function (e) { /* Drive 비우기 실패가 로컬 비우기를 막지 않는다 */ console.warn('Drive 휴지통 비우기 실패 — 로컬 비우기는 계속한다:', e); });
    }

    function refreshDriveTrashCount() {
      fetch('/api/drive/trash')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          var payload = (data && (data.data || data)) || {};
          driveTrashCount = (payload.folders || []).length + (payload.files || []).length;
          if (manager) manager.sync();
        })
        .catch(function (e) { /* 개수 확인 실패는 배지만 비운다 */ console.warn('휴지통 개수 확인 실패:', e); });
    }

    // 아이콘 API는 매니저 생성 뒤에 생기므로 참조 프록시로 주입한다 (순환 해소)
    var iconsRef = { current: null };
    var iconsApiProxy = {
      restoreFromTrash: function (pred) {
        if (iconsRef.current) iconsRef.current.restoreFromTrash(pred);
      },
    };

    buildDock();

    manager = W.createManager({
      root: root,
      taskbar: taskbar,
      stateApi: S,
      storage: storage,
      getViewport: getViewport,
      state: state,
      appActionsEl: actionsEl,
      appTitleEl: appTitleEl,
      assistantEl: assistantEl,
      dockApi: D,
      getDockIds: function () { return dock ? dock.getIds() : []; },
      renderDock: renderDock,
      subchat: subchat,
      iconsApi: iconsApiProxy,
      purgeIconTrash: function (id) {
        if (iconsRef.current) {
          iconsRef.current.purgeFromTrash(function (it) { return it.id === id; });
        }
      },
    });

    icons = I.createIcons({
      layer: iconsLayer,
      storage: storage,
      tiles: T,
      fileIcons: FI,
      titleOf: function (id) {
        var m = S.findModule(id);
        return m ? m.title : id;
      },
      onOpen: function (item) {
        if (!manager) return;
        if (item.kind === 'file') manager.openFileInFinder(item);
        else if (item.id === 'mission') manager.toggleMission();
        else manager.openModule(item.id);
      },
      onContextMenu: function (item, ev, selectedItems) {
        if (!MN || !manager) return;
        var targets = selectedItems && selectedItems.length ? selectedItems : [item];
        var items = [
          { label: '열기', onSelect: function () { targets.forEach(function (t) {
              if (t.kind === 'file') manager.openFileInFinder(t);
              else manager.openModule(t.id);
            }); } },
        ];
        if (item.kind === 'app') {
          items.push({
            label: '독에 추가',
            onSelect: function () {
              if (dock && dock.getIds().indexOf(item.id) < 0) {
                dock.setIds(dock.getIds().concat([item.id]));
                D.saveDockIds(storage, dock.getIds());
              }
              manager.sync();
            },
          });
        }
        items.push({
          label: '휴지통으로 이동', danger: true,
          onSelect: function () { icons.trashItems(targets); manager.sync(); },
        });
        MN.show({ x: ev.clientX, y: ev.clientY, items: items });
      },
      onDropCheck: function (ev, group) {
        var t = document.elementFromPoint(ev.clientX, ev.clientY);
        var trashEl = t && t.closest ? t.closest('.dt-dock-trash') : null;
        if (!trashEl) return false;
        icons.trashItems(group);
        if (manager) manager.sync();
        return true;
      },
      onChange: function () { if (manager) manager.sync(); },
    });
    iconsRef.current = icons;
    icons.render();
    manager.sync();
    refreshDriveTrashCount();

    // 러버밴드 선택: 표면(배경 레이어) 빈 곳에서 시작할 때만
    surface.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      var t = ev.target;
      var onBandSurface = t === surface || t === iconsLayer || t === wallpaperLayer ||
        (t.classList && t.classList.contains('dt-wallpaper-img'));
      if (!onBandSurface) return;
      var rect = surface.getBoundingClientRect();
      var startX = ev.clientX - rect.left, startY = ev.clientY - rect.top;
      var band = null;
      var moved = false;
      function onMove(e2) {
        var x = e2.clientX - rect.left, y = e2.clientY - rect.top;
        if (!moved && Math.hypot(x - startX, y - startY) < 4) return;
        moved = true;
        if (!band) {
          band = document.createElement('div');
          band.className = 'dt-select-band';
          surface.appendChild(band);
        }
        var box = {
          x: Math.min(startX, x), y: Math.min(startY, y),
          w: Math.abs(x - startX), h: Math.abs(y - startY),
        };
        band.style.left = box.x + 'px';
        band.style.top = box.y + 'px';
        band.style.width = box.w + 'px';
        band.style.height = box.h + 'px';
        icons.selectInRect(box);
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (band && band.parentNode) band.parentNode.removeChild(band);
        if (!moved) icons.clearSelection();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    if (WG && widgetsLayer) {
      WG.createWidgets({ layer: widgetsLayer, storage: storage }).render();
    }

    if (WP && wallpaperLayer) {
      wallpaperApi = WP.createWallpaper({ layer: wallpaperLayer, captionEl: captionEl });
      wallpaperApi.start();
    }

    // 동적 모듈: 시스템 폴더(앱)를 모듈로 등록하고 독·아이콘을 다시 그린다
    fetch('/api/finder/system-folders')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var payload = (data && (data.data || data)) || {};
        var folders = payload.folders || payload.systemFolders || [];
        var changed = false;
        folders.forEach(function (f) {
          if (!f || !f.drive_url || !f.name) return;
          if (['메모', '일정', '할 일'].indexOf(f.name) >= 0) return; // 기본 모듈과 중복 제외
          var id = 'app-' + f.id;
          if (!S.findModule(id)) {
            S.registerModule({
              id: id, title: f.name, url: f.drive_url,
              defW: 1000, defH: 680, color: '#a5c8f0', icon: 'layout-grid', dynamic: true,
            });
            changed = true;
          }
        });
        if (changed) { buildDock(); manager.sync(); icons.render(); }
      })
      .catch(function (e) { /* 동적 모듈 실패는 기본 모듈로 계속 */ console.warn('동적 모듈 로드 실패 — 기본 모듈로 계속한다:', e); });

    // 상단바: 설정 메뉴(기어·독 설정 공용), 프로필 아바타 = 비서 패널 토글.
    // 데스크톱 전환은 설정 메뉴의 '데스크톱 ▸' 하위메뉴가 담당한다.
    var SM = window.MyHubDesktopSettingsMenu;
    if (SM) {
      settingsMenu = SM.create({
        manager: manager,
        storage: storage,
        refreshWallpaper: function () { if (wallpaperApi) wallpaperApi.start(); },
      });
    }
    var gear = document.getElementById('dt-gear');
    if (gear) gear.addEventListener('click', function () { if (settingsMenu) settingsMenu.toggle(gear); });
    var profile = document.getElementById('dt-profile');
    if (profile && subchat) profile.addEventListener('click', function () { subchat.toggle(); });
    if (assistantEl && subchat) {
      assistantEl.addEventListener('click', function (ev) {
        // 프록시 아바타가 없을 때만 패널 토글 (있으면 실버튼 클릭이 위임됨)
        if (!assistantEl.querySelector('.dt-bar-assistant-btn')) { ev.stopPropagation(); subchat.toggle(); }
      }, true);
    }

    // 전체화면·최대화 독 peek: 하단 6px 핫존
    document.addEventListener('pointermove', function (ev) {
      if (!taskbar.classList.contains('dt-autohide')) return;
      taskbar.classList.toggle('dt-peek', ev.clientY >= window.innerHeight - 6);
    });

    var clockEl = document.getElementById('dt-clock');
    function tickClock() {
      if (!clockEl) return;
      try {
        clockEl.textContent = new Intl.DateTimeFormat('ko-KR', {
          month: 'short', day: 'numeric', weekday: 'short',
          hour: 'numeric', minute: '2-digit',
        }).format(new Date());
      } catch (e) { clockEl.textContent = ''; }
    }
    tickClock();
    setInterval(tickClock, 20000);

    window.addEventListener('resize', function () { manager.sync(); });

    // 로딩 표면 해제: 첫 렌더 후 페이드 아웃
    var loading = document.getElementById('dt-loading');
    if (loading) {
      requestAnimationFrame(function () {
        loading.classList.add('is-done');
        setTimeout(function () { if (loading.parentNode) loading.parentNode.removeChild(loading); }, 450);
      });
    }

    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) { console.debug('셸 아이콘 실패:', e); } }

    return { manager: manager, icons: icons, subchat: subchat };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})();
