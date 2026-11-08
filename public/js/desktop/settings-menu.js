/* MyHub 데스크톱 설정 메뉴 — 상단바 기어·독 설정 공용 드롭다운.
 *
 * 원본 기준: 흰 둥근 드롭다운에 데스크톱 열기·데이터 백업·암호화 키 교체·
 * Google 연동·배경 ▸·앱 관리·창 질감 전환·데스크톱 ▸·로그아웃(빨간 글씨).
 * 데스크톱 전환은 별도 개요 화면 없이 이 메뉴의 '데스크톱 ▸' 하위메뉴가
 * 담당한다 (체크 = 현재 데스크톱, '데스크톱 추가'로 새 스페이스).
 * 배경은 '오늘의 사진' 단일 경로가 정본이라 하위메뉴는 현재 배경 표시와
 * 새로고침만 둔다.
 *
 * 노출: window.MyHubDesktopSettingsMenu.create({ manager, storage, refreshWallpaper })
 */
(function () {
  'use strict';

  var MATERIAL_KEY = 'myhub.desktop.material.v1';

  function create(deps) {
    var doc = document;
    var manager = deps.manager;
    var storage = deps.storage;
    var menuEl = null;
    var subEl = null;
    var modalEl = null;
    var subTimer = null;

    // 창 질감 저장값 복원
    try {
      if (storage && storage.getItem(MATERIAL_KEY) === 'solid') {
        doc.body.classList.add('dt-material-solid');
      }
    } catch (e) { console.debug('창 질감 복원 실패:', e); }

    function closeSub() {
      if (subTimer) { clearTimeout(subTimer); subTimer = null; }
      if (subEl && subEl.parentNode) subEl.parentNode.removeChild(subEl);
      subEl = null;
    }
    function close() {
      closeSub();
      if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      menuEl = null;
      doc.removeEventListener('pointerdown', onDocDown, true);
      doc.removeEventListener('keydown', onKey, true);
    }
    function onDocDown(ev) {
      if (modalEl) return;
      if (menuEl && !menuEl.contains(ev.target) && (!subEl || !subEl.contains(ev.target))) close();
    }
    function onKey(ev) { if (ev.key === 'Escape') { if (!modalEl) close(); } }

    function el(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function makeItem(item) {
      var b = el('button', 'myhub-settings-item' + (item.danger ? ' myhub-settings-item-danger' : ''));
      b.type = 'button';
      if (item.checked) b.appendChild(el('span', 'myhub-settings-check', '✓'));
      else if (item.checkSlot) b.appendChild(el('span', 'myhub-settings-check', ''));
      b.appendChild(el('span', null, item.label));
      if (item.submenu) b.appendChild(el('span', 'myhub-settings-arrow', '▸'));
      if (item.disabled) b.disabled = true;
      b.addEventListener('mouseenter', function () {
        if (item.submenu) openSub(b, item.submenu);
        else {
          if (subTimer) clearTimeout(subTimer);
          subTimer = setTimeout(closeSub, 250);
        }
      });
      b.addEventListener('click', function () {
        if (item.submenu) { openSub(b, item.submenu); return; }
        close();
        if (item.onSelect) item.onSelect();
      });
      return b;
    }

    function openSub(anchorItem, items) {
      if (subTimer) { clearTimeout(subTimer); subTimer = null; }
      closeSub();
      subEl = el('div', 'myhub-settings-menu myhub-settings-sub');
      items.forEach(function (it) {
        if (it.separator) { subEl.appendChild(el('div', 'myhub-settings-sep')); return; }
        subEl.appendChild(makeItem(it));
      });
      doc.body.appendChild(subEl);
      var ir = anchorItem.getBoundingClientRect();
      var mr = menuEl.getBoundingClientRect();
      var w = subEl.offsetWidth;
      var left = mr.left - w - 4;
      if (left < 8) left = mr.right + 4;
      subEl.style.left = left + 'px';
      var top = Math.min(ir.top, window.innerHeight - subEl.offsetHeight - 8);
      subEl.style.top = Math.max(8, top) + 'px';
    }

    function spaceItems() {
      var st = manager.getState();
      var items = st.spaces.map(function (s, idx) {
        return {
          label: '데스크톱 ' + (idx + 1),
          checked: s.id === st.activeSpaceId,
          checkSlot: true,
          onSelect: function () { manager.setActiveSpace(s.id); },
        };
      });
      items.push({ separator: true });
      items.push({
        label: '데스크톱 추가',
        onSelect: function () {
          manager.addSpace();
          var st2 = manager.getState();
          var last = st2.spaces[st2.spaces.length - 1];
          if (last) manager.setActiveSpace(last.id);
        },
      });
      return items;
    }

    function mainItems() {
      return [
        {
          label: '데스크톱 열기',
          onSelect: function () {
            var st = manager.getState();
            st.windows.forEach(function (w) {
              if (w.space === st.activeSpaceId && !w.minimized) manager.minimizeWindow(w.id);
            });
          },
        },
        { label: '데이터 백업', onSelect: function () { manager.openModule('backup'); } },
        { label: '암호화 키 교체', onSelect: openKeyModal },
        { label: 'Google 연동', onSelect: openGoogleModal },
        {
          label: '배경', submenu: [
            { label: '오늘의 사진', checked: true, checkSlot: true, onSelect: function () {} },
            {
              label: '사진 새로고침',
              onSelect: function () { if (deps.refreshWallpaper) deps.refreshWallpaper(); },
            },
          ],
        },
        { label: '앱 관리', onSelect: function () { manager.openModule('studio'); } },
        {
          label: '창 질감 전환',
          onSelect: function () {
            var solid = doc.body.classList.toggle('dt-material-solid');
            try { if (storage) storage.setItem(MATERIAL_KEY, solid ? 'solid' : 'glass'); }
            catch (e) { console.debug('창 질감 저장 실패:', e); }
          },
        },
        { label: '데스크톱', submenu: spaceItems() },
        { separator: true },
        {
          label: '로그아웃', danger: true,
          onSelect: function () {
            fetch('/api/auth/logout', { method: 'POST' })
              .catch(function (e) { console.warn('로그아웃 요청 실패 — 로그인 화면으로 이동한다:', e); })
              .then(function () { window.location.href = '/login.html'; });
          },
        },
      ];
    }

    function showModal(build) {
      closeModal();
      modalEl = el('div', 'myhub-settings-modal-back');
      var box = el('div', 'myhub-settings-modal');
      modalEl.appendChild(box);
      modalEl.addEventListener('pointerdown', function (ev) { if (ev.target === modalEl) closeModal(); });
      doc.body.appendChild(modalEl);
      build(box);
    }
    function closeModal() {
      if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
      modalEl = null;
    }
    function modalButtons(box, primaryLabel, onPrimary) {
      var row = el('div', 'myhub-settings-modal-row');
      var cancel = el('button', null, '취소');
      cancel.type = 'button';
      cancel.addEventListener('click', closeModal);
      row.appendChild(cancel);
      if (primaryLabel) {
        var primary = el('button', 'myhub-settings-primary', primaryLabel);
        primary.type = 'button';
        primary.addEventListener('click', function () { onPrimary(primary); });
        row.appendChild(primary);
      }
      box.appendChild(row);
    }

    function openKeyModal() {
      showModal(function (box) {
        box.appendChild(el('h3', null, '암호화 키 교체'));
        box.appendChild(el('p', null, '새 암호화 키를 입력하세요. 저장된 데이터가 새 키로 다시 암호화됩니다.'));
        var k1 = el('input'); k1.type = 'password'; k1.placeholder = '새 암호화 키'; k1.autocomplete = 'new-password';
        var k2 = el('input'); k2.type = 'password'; k2.placeholder = '새 키 확인'; k2.autocomplete = 'new-password';
        var msg = el('p', null, '');
        box.appendChild(k1); box.appendChild(k2); box.appendChild(msg);
        modalButtons(box, '교체', function (btn) {
          if (!k1.value || k1.value !== k2.value) { msg.textContent = '키가 비어 있거나 서로 달라요.'; return; }
          btn.disabled = true;
          msg.textContent = '교체 중…';
          fetch('/api/key-rotation/rotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newKey: k1.value, newKeyConfirm: k2.value }),
          }).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (out) {
              if (out.ok) { msg.textContent = '암호화 키를 교체했어요.'; btn.textContent = '완료'; btn.onclick = closeModal; }
              else { msg.textContent = '교체에 실패했어요. ' + ((out.j && out.j.error) || ''); btn.disabled = false; }
            })
            .catch(function (e) { msg.textContent = '교체에 실패했어요.'; btn.disabled = false; console.warn('키 교체 실패:', e); });
        });
      });
    }

    function openGoogleModal() {
      showModal(function (box) {
        box.appendChild(el('h3', null, 'Google 연동'));
        var msg = el('p', null, '상태를 확인하는 중…');
        box.appendChild(msg);
        modalButtons(box, null, null);
        fetch('/api/google/status')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var d = (j && (j.data || j)) || {};
            if (d.connected || d.status === 'active') {
              msg.textContent = '연결됨' + (d.email ? ' — ' + d.email : '') + '. 일정이 이 계정과 동기화됩니다.';
            } else {
              msg.textContent = '아직 연결되지 않았어요. 연결은 일정 앱의 설정 메뉴에서도 할 수 있어요.';
            }
          })
          .catch(function (e) { msg.textContent = '상태를 확인하지 못했어요.'; console.warn('Google 상태 확인 실패:', e); });
      });
    }

    function toggle(anchor) {
      if (menuEl) { close(); return; }
      menuEl = el('div', 'myhub-settings-menu');
      menuEl.setAttribute('role', 'menu');
      mainItems().forEach(function (it) {
        if (it.separator) { menuEl.appendChild(el('div', 'myhub-settings-sep')); return; }
        menuEl.appendChild(makeItem(it));
      });
      doc.body.appendChild(menuEl);
      var r = anchor.getBoundingClientRect();
      var w = menuEl.offsetWidth;
      var h = menuEl.offsetHeight;
      var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      menuEl.style.left = left + 'px';
      menuEl.style.top = top + 'px';
      doc.addEventListener('pointerdown', onDocDown, true);
      doc.addEventListener('keydown', onKey, true);
    }

    return { toggle: toggle, close: close };
  }

  var api = { create: create };
  if (typeof window !== 'undefined') window.MyHubDesktopSettingsMenu = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubDesktopSettingsMenu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
