/* MyHub 시트 ↔ GridCraft 번역 어댑터.
 *
 * 배선 근거 (엔진 소스 apps/gridcraft-web/src/host.rs 정본):
 * 호스트는 엔진과 gridcraft:* postMessage 프로토콜로만 말한다.
 * - 열기: gridcraft:open {name, bytes}
 * - 저장 요청: gridcraft:request-save → gridcraft:save {name, bytes} |
 *   gridcraft:save-failed {error} (sheet.html이 담당)
 * - 연산: gridcraft:exec {tag, commands: [{id, params}]} — 엔진 명령 레이어를
 *   그대로 쓴다. 명령 id·파라미터는 엔진 카탈로그(crates/engine/src/cmd)가 정본:
 *   cell.set {cell, input}, range.setValues {range, values},
 *   home.bold {range, on}, home.fillColor {range, color},
 *   home.numberFormat {range, code},
 *   data.sort {range, header, keys: [{column, order}]},
 *   edit.undo / edit.redo / edit.find {}
 * - 폰트: gridcraft:fonts {fonts: [{family, bytes}]} — 페이스 바이트가 있어야
 *   등록된다 (family 이름만으로는 엔진이 건너뛴다).
 *
 * 이 어댑터는 패널·호스트 연산(myhub:office-op의 action)을 exec 명령으로
 * 번역한다. 입력 형태는 셋을 모두 받는다:
 * - 서버 검증 연산 (services/office-ops의 SheetOp): {type: 'set_cell'|'set_range'|
 *   'insert_table'|'sort_range'|'format_range', ...} 또는 {ops: [...]} 묶음
 * - 호스트 도구 연산: {op: 'undo'|'redo'|'find'}
 * - 구 형태: {op: 'set_cell', col, row, value} / {op: 'set_range', range:{c0,r0,c1,r1},
 *   values} / {op: 'insert_table', range:{...}, values, header} /
 *   {op: 'sort_range', range:{...}, col, direction} / {op: 'format_range', ...}
 *
 * xlsx 손실 가드 inspectXlsxLosses: 매크로(vbaProject.bin)는 기본 보기 전용 +
 * 배너/veil, 차트(xl/charts)·이미지(xl/media)는 열기 전 고지 대상.
 *
 * 노출: window.MyHubSheetGridcraft
 */
(function () {
  'use strict';

  function colLetter(idx) {
    var s = '';
    var n = idx + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cellRef(col, row) { return colLetter(col) + String(row + 1); }

  function rangeRef(range) {
    return cellRef(range.c0, range.r0) + ':' + cellRef(range.c1, range.r1);
  }

  /** A1 셀 참조 파싱 → {col, row} (0-기반) | null */
  function parseA1Cell(ref) {
    var m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(ref || '').trim());
    if (!m) return null;
    var col = 0;
    var up = m[1].toUpperCase();
    for (var i = 0; i < up.length; i++) col = col * 26 + (up.charCodeAt(i) - 64);
    return { col: col - 1, row: Number(m[2]) - 1 };
  }

  /** A1 범위 파싱 → {c0, r0, c1, r1} (0-기반) | null */
  function parseA1Range(ref) {
    var parts = String(ref || '').trim().split(':');
    if (parts.length === 1) {
      var c = parseA1Cell(parts[0]);
      return c ? { c0: c.col, r0: c.row, c1: c.col, r1: c.row } : null;
    }
    if (parts.length !== 2) return null;
    var a = parseA1Cell(parts[0]);
    var b = parseA1Cell(parts[1]);
    if (!a || !b) return null;
    return {
      c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row),
      c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row),
    };
  }

  /** cell.set의 input 문자열로 변환 (사용자가 타이핑한 것과 같은 해석). */
  function scalarInput(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    return String(v);
  }

  /** SheetCellInput({value}|{formula})·스칼라 → cell.set input */
  function cellInputOf(op) {
    if (op && typeof op.formula === 'string') return op.formula;
    if (op && 'value' in op) return scalarInput(op.value);
    return '';
  }

  /** range.setValues용 원시 셀 값 (숫자는 숫자로 유지, 수식은 '=' 문자열). */
  function rawCell(v) {
    if (v && typeof v === 'object') {
      if (typeof v.formula === 'string') return v.formula;
      if ('value' in v) return v.value === undefined ? null : v.value;
      if (typeof v.f === 'string') return v.f.charAt(0) === '=' ? v.f : '=' + v.f;
      if ('v' in v) return v.v === undefined ? null : v.v;
      return null;
    }
    return v === undefined ? null : v;
  }

  function rawValues(values) {
    if (!Array.isArray(values)) return [];
    return values.map(function (row) {
      return (Array.isArray(row) ? row : [row]).map(rawCell);
    });
  }

  /**
   * 연산 1개 → 엔진 명령 목록 (순수 번역).
   * 입력 형태는 파일 상단 주석의 셋을 모두 받는다.
   */
  function translate(op) {
    if (!op || typeof op !== 'object') return [];
    var kind = op.type || op.op;
    switch (kind) {
      case 'undo':
        return [{ id: 'edit.undo', params: {} }];
      case 'redo':
        return [{ id: 'edit.redo', params: {} }];
      case 'find':
        return [{ id: 'edit.find', params: {} }];
      case 'set_cell': {
        if (typeof op.cell === 'string') {
          return [{ id: 'cell.set', params: { cell: op.cell, input: cellInputOf(op) } }];
        }
        // 구 형태 {col, row, value}
        if (typeof op.col === 'number' && typeof op.row === 'number') {
          return [{ id: 'cell.set', params: { cell: cellRef(op.col, op.row), input: scalarInput(op.value) } }];
        }
        return [];
      }
      case 'set_range': {
        if (typeof op.range === 'string') {
          return [{ id: 'range.setValues', params: { range: op.range, values: rawValues(op.values) } }];
        }
        if (op.range && typeof op.range === 'object') {
          return [{ id: 'range.setValues', params: { range: rangeRef(op.range), values: rawValues(op.values) } }];
        }
        return [];
      }
      case 'insert_table': {
        var values;
        var atRef;
        var headerRef = null;
        if (typeof op.at === 'string' && Array.isArray(op.headers)) {
          // 서버 형태 {at, headers, rows}
          values = [op.headers.slice()].concat(Array.isArray(op.rows) ? op.rows : []);
          atRef = op.at;
          var at = parseA1Cell(op.at);
          if (at && op.headers.length) {
            headerRef = cellRef(at.col, at.row) + ':' + cellRef(at.col + op.headers.length - 1, at.row);
          }
        } else if (op.range && typeof op.range === 'object' && Array.isArray(op.values)) {
          // 구 형태 {range:{...}, values, header}
          values = rawValues(op.values);
          atRef = rangeRef(op.range);
          if (op.header) headerRef = cellRef(op.range.c0, op.range.r0) + ':' + cellRef(op.range.c1, op.range.r0);
        } else {
          return [];
        }
        var msgs = [{ id: 'range.setValues', params: { range: atRef, values: values } }];
        if (headerRef) msgs.push({ id: 'home.bold', params: { range: headerRef, on: true } });
        return msgs;
      }
      case 'sort_range': {
        if (typeof op.range === 'string') {
          var parsed = parseA1Range(op.range);
          if (!parsed) return [];
          var by = typeof op.by === 'number' ? op.by : 0;
          return [{
            id: 'data.sort',
            params: {
              range: op.range,
              header: op.hasHeader === true,
              keys: [{ column: colLetter(parsed.c0 + by), order: op.order === 'desc' ? 'desc' : 'asc' }],
            },
          }];
        }
        if (op.range && typeof op.range === 'object') {
          // 구 형태 {range:{...}, col(절대 열), direction}
          return [{
            id: 'data.sort',
            params: {
              range: rangeRef(op.range),
              header: false,
              keys: [{ column: colLetter(op.col || 0), order: op.direction === 'desc' ? 'desc' : 'asc' }],
            },
          }];
        }
        return [];
      }
      case 'format_range': {
        var ref = null;
        if (typeof op.range === 'string') ref = op.range;
        else if (op.range && typeof op.range === 'object') ref = rangeRef(op.range);
        if (!ref) return [];
        var out = [];
        if (typeof op.bold === 'boolean') out.push({ id: 'home.bold', params: { range: ref, on: op.bold } });
        var color = typeof op.background === 'string' ? op.background : (typeof op.fill === 'string' ? op.fill : null);
        if (color) out.push({ id: 'home.fillColor', params: { range: ref, color: color } });
        if (op.numberFormat) out.push({ id: 'home.numberFormat', params: { range: ref, code: op.numberFormat } });
        return out;
      }
      default:
        return [];
    }
  }

  /** action(단일 연산 또는 {ops:[...]} 묶음) → 엔진 명령 목록 */
  function translateAction(action) {
    if (!action || typeof action !== 'object') return [];
    var ops = Array.isArray(action.ops) ? action.ops : [action];
    var out = [];
    ops.forEach(function (op) {
      translate(op).forEach(function (cmd) { out.push(cmd); });
    });
    return out;
  }

  /**
   * xlsx 손실 가드: 엔진이 보존하지 못하는 요소를 열기 전에 검사한다.
   * buf: ArrayBuffer. 반환: {macro, charts, media, readOnly}
   */
  function inspectXlsxLosses(buf) {
    var result = { macro: false, charts: 0, media: 0, readOnly: false };
    if (!window.JSZip) return Promise.resolve(result);
    return window.JSZip.loadAsync(buf).then(function (zip) {
      Object.keys(zip.files).forEach(function (name) {
        if (name === 'xl/vbaProject.bin') result.macro = true;
        if (/^xl\/charts\/chart\d+\.xml$/.test(name)) result.charts++;
        if (/^xl\/media\//.test(name) && !zip.files[name].dir) result.media++;
      });
      result.readOnly = result.macro; // 매크로 문서는 기본 보기 전용
      return result;
    }).catch(function () { return result; });
  }

  function attach(opts) {
    var engine = opts.engineFrame;
    var tagSeq = 0;
    var pendingExec = {}; // tag → {resolve, reject, timer}
    function postToEngine(msg) {
      if (engine && engine.contentWindow) {
        engine.contentWindow.postMessage(msg, window.location.origin);
      }
    }
    /** 연산 action을 gridcraft:exec 한 번으로 보낸다. 보낸 명령 수를 돌려준다. */
    function sendAction(action) {
      var commands = translateAction(action);
      if (!commands.length) return 0;
      tagSeq += 1;
      postToEngine({ type: 'gridcraft:exec', tag: 'myhub-' + tagSeq, commands: commands });
      return commands.length;
    }
    /**
     * 결과를 기다리는 exec (스냅샷 조회·패널 연산 적용 확인용).
     * commands: [{id, params}] → Promise<[{ok, result?, error?}]>
     */
    function exec(commands) {
      return new Promise(function (resolve, reject) {
        if (!commands || !commands.length) { resolve([]); return; }
        tagSeq += 1;
        var tag = 'myhub-exec-' + tagSeq;
        var timer = setTimeout(function () {
          delete pendingExec[tag];
          reject(new Error('엔진 응답 없음'));
        }, 20000);
        pendingExec[tag] = { resolve: resolve, reject: reject, timer: timer };
        postToEngine({ type: 'gridcraft:exec', tag: tag, commands: commands });
      });
    }
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'myhub-sheet:op') {
        sendAction(d.op || {});
      } else if (d.type === 'myhub-sheet:fonts' && Array.isArray(d.fonts)) {
        postToEngine({ type: 'gridcraft:fonts', fonts: d.fonts });
      } else if (d.type === 'gridcraft:exec-result' && typeof d.tag === 'string' && d.tag.indexOf('myhub-') === 0) {
        var pending = pendingExec[d.tag];
        if (pending) {
          delete pendingExec[d.tag];
          clearTimeout(pending.timer);
          pending.resolve(d.results || []);
          return;
        }
        (d.results || []).forEach(function (r) {
          if (r && r.ok === false) console.warn('엔진 연산 실패:', r.error);
        });
      }
    });
    return {
      send: sendAction,
      sendAction: sendAction,
      exec: exec,
      postFonts: function (fonts) { postToEngine({ type: 'gridcraft:fonts', fonts: fonts }); },
    };
  }

  var api = {
    colLetter: colLetter, cellRef: cellRef, rangeRef: rangeRef,
    parseA1Cell: parseA1Cell, parseA1Range: parseA1Range,
    translate: translate, translateAction: translateAction,
    inspectXlsxLosses: inspectXlsxLosses, attach: attach,
  };
  if (typeof window !== 'undefined') window.MyHubSheetGridcraft = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubSheetGridcraft = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
