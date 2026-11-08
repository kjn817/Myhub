/* MyHub 오피스 기억 — 최근 파일(최대 8개, 로컬)과 마지막 앱.
 *
 * 재구성 근거: 최근 파일은 로컬 저장만으로 유지한다 (서버 왕복 없음).
 *
 * 노출: window.MyHubOfficeMemory
 */
(function () {
  'use strict';

  var RECENTS_KEY = 'myhub.office.recents.v1';
  var LAST_APP_KEY = 'myhub.office.lastApp.v1';
  var MAX_RECENTS = 8;

  function loadRecents(storage) {
    try {
      var raw = JSON.parse((storage || localStorage).getItem(RECENTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (r) { return r && r.id && r.name; }).slice(0, MAX_RECENTS) : [];
    } catch (e) { return []; }
  }

  function pushRecent(storage, entry) {
    var store = storage || localStorage;
    var recents = loadRecents(store).filter(function (r) { return r.id !== entry.id; });
    recents.unshift({
      id: entry.id, name: entry.name, app: entry.app || null,
      at: entry.at || new Date().toISOString(),
    });
    recents = recents.slice(0, MAX_RECENTS);
    try { store.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch (e) { console.debug('최근 파일 저장 실패:', e); }
    return recents;
  }

  function getLastApp(storage) {
    try { return (storage || localStorage).getItem(LAST_APP_KEY) || null; } catch (e) { return null; }
  }

  function setLastApp(storage, app) {
    try { (storage || localStorage).setItem(LAST_APP_KEY, app); } catch (e) { console.debug('마지막 앱 저장 실패:', e); }
  }

  var api = {
    RECENTS_KEY: RECENTS_KEY, MAX_RECENTS: MAX_RECENTS,
    loadRecents: loadRecents, pushRecent: pushRecent,
    getLastApp: getLastApp, setLastApp: setLastApp,
  };
  if (typeof window !== 'undefined') window.MyHubOfficeMemory = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeMemory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
