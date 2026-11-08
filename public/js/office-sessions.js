/* MyHub 오피스 비서 세션 — 앱별 스냅샷 조립·연산 적용 어댑터.
 *
 * 복원 근거 (운영 기록·엔진 소스 대조):
 * - 패널 비서(office-assistant)는 이 세션을 통해 문서를 읽고 연산을 적용한다.
 *   서버 계약은 POST /api/ai/office/instruct {app, fileName, instruction,
 *   snapshot} → {reply, ops, validationErrors} (services/office-ai).
 * - Excel: GridCraft exec의 sheet.read {range, formulas} → {values}를 서버
 *   SheetSnapshot {cells:[{v|f}]}로 변환한다 (엔진 cmd/inspect.rs 정본).
 * - PowerPoint: file.info + 슬라이드별 slide.inspect 조립 (최대 50장, 텍스트
 *   400자 절단, 빈 자리표시자도 text:"" 명시 — D-36 정본). 적용은 deckcraft
 *   exec 패스스루 + 대상 슬라이드가 다르면 slide.go 삽입 + 적용 전후 스냅샷
 *   대조 검증(verifySlideApply — D-38 정본: 엔진 ok만으로 성공을 세지 않는다).
 * - PDF: pdf-lib 바이트 경로 (엔진 표면이 아니라 보관함 바이트를 고쳐 다시
 *   연다). 미저장 문서·미저장 변경이 있으면 applyOps 최상단에서 정확한
 *   사유로 사전 실패한다 (D-36 저장 경계 가드). overlay_text는 래스터
 *   이미지 방식 (표준 폰트에 한글 글리프가 없어 캔버스로 그려 붙인다).
 * - 한글: Studio SDK의 applyTextCommand는 문단별 SHA-256 fence를 요구해
 *   비서 연산에 부적합 → @rhwp/core 바이트 경로가 본선 (2026-11-03 정본).
 *   현재 바이트를 export해 HwpDocument로 연산을 적용하고 스튜디오에 다시
 *   싣는다. 스냅샷은 kordoc readText 마크다운.
 *
 * 노출: window.MyHubOfficeSessions
 */
(function () {
  'use strict';

  var SLIDE_SNAPSHOT_MAX = 50;
  var SLIDE_TEXT_CAP = 400;
  var SHEET_SNAPSHOT_RANGE = 'A1:AD120';

  /* ---------- 순수 변환·검증 (테스트 대상) ---------- */

  function sheetCellFromValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.charAt(0) === '=') return { f: v };
    return { v: v };
  }

  function sheetSnapshotFromRead(result) {
    var values = (result && Array.isArray(result.values)) ? result.values : [];
    var cells = values.map(function (row) {
      return (Array.isArray(row) ? row : []).map(sheetCellFromValue);
    });
    return {
      range: (result && result.range) || SHEET_SNAPSHOT_RANGE,
      cells: cells,
      rowsCapped: cells.length >= 120,
      colsCapped: cells.some(function (row) { return row.length >= 30; }),
    };
  }

  function slideSnapshotFromInspects(info, inspects) {
    var slides = (inspects || []).map(function (ins) {
      return {
        index: ins.index,
        layout: ins.layout || null,
        title: ins.title || null,
        shapes: (ins.shapes || []).map(function (s) {
          return {
            id: s.id,
            kind: s.kind,
            placeholder: s.placeholder || null,
            text: String(s.text || '').slice(0, SLIDE_TEXT_CAP),
          };
        }),
      };
    });
    return { slideCount: info && typeof info.slides === 'number' ? info.slides : slides.length, slides: slides };
  }

  function shapeText(inspect, id) {
    var shapes = (inspect && inspect.shapes) || [];
    for (var i = 0; i < shapes.length; i++) {
      if (shapes[i].id === id) return String(shapes[i].text || '');
    }
    return null;
  }

  function anyShapeTextIncludes(inspect, needle) {
    var shapes = (inspect && inspect.shapes) || [];
    return shapes.some(function (s) { return String(s.text || '').indexOf(needle) >= 0; });
  }

  /** text.set 검증: 대상 도형의 텍스트가 의도한 값과 같아야 성공으로 센다. */
  function verifyTextSet(inspect, id, text) {
    return shapeText(inspect, id) === text;
  }

  /** insert.textBox 검증: 같은 텍스트를 가진 도형이 생겼어야 한다. */
  function verifyInsertTextBox(inspect, text) {
    return anyShapeTextIncludes(inspect, text);
  }

  /** text.replace 검증: 바뀐 문자열이 존재하고, 원래 문자열은 (바뀐 문자열에
   * 포함되는 경우를 빼면) 남아 있지 않아야 한다. */
  function verifyTextReplace(inspects, find, withText) {
    var hasWith = (inspects || []).some(function (ins) { return anyShapeTextIncludes(ins, withText); });
    if (!hasWith) return false;
    if (withText.indexOf(find) >= 0) return true;
    return !(inspects || []).some(function (ins) { return anyShapeTextIncludes(ins, find); });
  }

  /* ---------- 프레임 exec 채널 ---------- */

  /** deckcraft:exec 결과를 기다리는 채널 (PowerPoint 엔진 iframe 직접). */
  function makeDeckExec(frameGetter) {
    var seq = 0;
    var pending = {};
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var frame = frameGetter();
      if (!frame || ev.source !== frame.contentWindow) return;
      var d = ev.data;
      if (!d || d.type !== 'deckcraft:exec-result' || typeof d.tag !== 'string') return;
      var p = pending[d.tag];
      if (!p) return;
      delete pending[d.tag];
      clearTimeout(p.timer);
      p.resolve(d.results || []);
    });
    return function exec(commands) {
      return new Promise(function (resolve, reject) {
        var frame = frameGetter();
        if (!frame || !frame.contentWindow) { reject(new Error('엔진 없음')); return; }
        seq += 1;
        var tag = 'oa-exec-' + seq;
        var timer = setTimeout(function () {
          delete pending[tag];
          reject(new Error('엔진 응답 없음'));
        }, 20000);
        pending[tag] = { resolve: resolve, timer: timer };
        frame.contentWindow.postMessage({ type: 'deckcraft:exec', tag: tag, commands: commands }, window.location.origin);
      });
    };
  }

  /** sheet.html 래퍼를 거치는 GridCraft exec 채널 (myhub:sheet-exec). */
  function makeSheetExec(frameGetter) {
    var seq = 0;
    var pending = {};
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var frame = frameGetter();
      if (!frame || ev.source !== frame.contentWindow) return;
      var d = ev.data;
      if (!d || d.type !== 'myhub:sheet-exec-result' || typeof d.reqId !== 'number') return;
      var p = pending[d.reqId];
      if (!p) return;
      delete pending[d.reqId];
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.results || []);
    });
    return function exec(commands) {
      return new Promise(function (resolve, reject) {
        var frame = frameGetter();
        if (!frame || !frame.contentWindow) { reject(new Error('엔진 없음')); return; }
        seq += 1;
        var reqId = seq;
        var timer = setTimeout(function () {
          delete pending[reqId];
          reject(new Error('엔진 응답 없음'));
        }, 20000);
        pending[reqId] = { resolve: resolve, reject: reject, timer: timer };
        frame.contentWindow.postMessage({ type: 'myhub:sheet-exec', reqId: reqId, commands: commands }, window.location.origin);
      });
    };
  }

  function firstResult(results) {
    var r = (results || [])[0];
    if (!r) throw new Error('엔진 응답이 비어 있어요');
    if (r.ok === false) throw new Error(r.error || '엔진 연산 실패');
    return r.result;
  }

  /* ---------- Excel 세션 ---------- */

  function createExcelSession(host) {
    var exec = makeSheetExec(host.engineFrame);
    var G = window.MyHubSheetGridcraft;
    return {
      kind: 'excel',
      snapshot: function () {
        return exec([{ id: 'sheet.read', params: { range: SHEET_SNAPSHOT_RANGE, formulas: true } }])
          .then(function (results) { return sheetSnapshotFromRead(firstResult(results)); });
      },
      applyOps: function (ops) {
        // 연산별 명령 묶음을 한 번의 exec로 보내고, 결과는 명령 단위로
        // 돌려받아 연산 단위로 합산한다 (하나라도 실패하면 그 연산은 실패).
        var commands = [];
        var spans = [];
        (ops || []).forEach(function (op) {
          var cmds = G ? G.translate(op) : [];
          spans.push({ op: op, start: commands.length, count: cmds.length });
          cmds.forEach(function (c) { commands.push(c); });
        });
        if (!commands.length) {
          return Promise.resolve(spans.map(function (s) {
            return { op: s.op, ok: false, error: '엔진 명령으로 바꾸지 못했어요' };
          }));
        }
        return exec(commands).then(function (results) {
          return spans.map(function (s) {
            if (!s.count) return { op: s.op, ok: false, error: '엔진 명령으로 바꾸지 못했어요' };
            for (var i = 0; i < s.count; i++) {
              var r = results[s.start + i];
              if (!r || r.ok === false) {
                return { op: s.op, ok: false, error: (r && r.error) || '엔진 연산 실패' };
              }
            }
            return { op: s.op, ok: true };
          });
        }).catch(function (e) {
          return spans.map(function (s) { return { op: s.op, ok: false, error: String((e && e.message) || e) }; });
        });
      },
    };
  }

  /* ---------- PowerPoint 세션 ---------- */

  function createSlideSession(host) {
    var exec = makeDeckExec(host.engineFrame);
    var currentSlide = 0;

    function inspect(index) {
      return exec([{ id: 'slide.inspect', params: index == null ? {} : { index: index } }])
        .then(function (results) { return firstResult(results); });
    }
    function info() {
      return exec([{ id: 'file.info', params: {} }]).then(function (results) { return firstResult(results); });
    }
    function snapshot() {
      return info().then(function (inf) {
        var count = Math.min(typeof inf.slides === 'number' ? inf.slides : 0, SLIDE_SNAPSHOT_MAX);
        return inspect(null).then(function (cur) {
          if (cur && typeof cur.index === 'number') currentSlide = cur.index;
          var chain = Promise.resolve([]);
          var collect = function (acc, i) {
            if (i >= count) return Promise.resolve(acc);
            return inspect(i).then(function (ins) { acc.push(ins); return collect(acc, i + 1); });
          };
          return collect([], 0).then(function (inspects) {
            return slideSnapshotFromInspects(inf, inspects);
          });
        });
      });
    }
    function execOp(op) {
      var params = {};
      var src = op.params || {};
      Object.keys(src).forEach(function (k) { if (k !== 'slide') params[k] = src[k]; });
      return exec([{ id: op.id, params: params }]).then(function (results) {
        var r = (results || [])[0];
        if (!r || r.ok === false) throw new Error((r && r.error) || '엔진 연산 실패');
        return r.result;
      });
    }
    function applyOp(op) {
      var target = op.params && typeof op.params.slide === 'number' ? op.params.slide : null;
      var before = null;
      var go = Promise.resolve();
      if (target !== null && target !== currentSlide) {
        go = exec([{ id: 'slide.go', params: { index: target } }]).then(function (results) {
          var r = (results || [])[0];
          if (!r || r.ok === false) throw new Error((r && r.error) || '슬라이드 이동 실패');
          currentSlide = target;
        });
      }
      if (op.id === 'slide.new') {
        before = info().then(function (inf) { return typeof inf.slides === 'number' ? inf.slides : null; });
      }
      return go.then(function () { return before; }).then(function (beforeCount) {
        return execOp(op).then(function () {
          // 적용 전후 스냅샷 대조 검증 — 엔진의 ok만으로 성공을 세지 않는다.
          if (op.id === 'slide.new') {
            return info().then(function (inf) {
              var now = typeof inf.slides === 'number' ? inf.slides : null;
              if (beforeCount !== null && now !== null && now > beforeCount) return { op: op, ok: true };
              return { op: op, ok: false, error: '슬라이드 수가 늘지 않았어요' };
            });
          }
          if (op.id === 'text.set') {
            var idx = target !== null ? target : currentSlide;
            return inspect(idx).then(function (ins) {
              return verifyTextSet(ins, op.params.id, op.params.text)
                ? { op: op, ok: true }
                : { op: op, ok: false, error: '적용 후 문서에서 변경을 확인하지 못했어요' };
            });
          }
          if (op.id === 'insert.textBox') {
            var idx2 = target !== null ? target : currentSlide;
            return inspect(idx2).then(function (ins) {
              return verifyInsertTextBox(ins, op.params.text)
                ? { op: op, ok: true }
                : { op: op, ok: false, error: '적용 후 문서에서 텍스트 상자를 확인하지 못했어요' };
            });
          }
          if (op.id === 'text.replace') {
            return snapshot().then(function (snap) {
              var inspects = snap.slides.map(function (s) {
                return { shapes: s.shapes.map(function (sh) { return { text: sh.text }; }) };
              });
              return verifyTextReplace(inspects, op.params.text, op.params.with)
                ? { op: op, ok: true }
                : { op: op, ok: false, error: '적용 후 문서에서 바꾼 텍스트를 확인하지 못했어요' };
            });
          }
          return { op: op, ok: true };
        });
      }).catch(function (e) {
        return { op: op, ok: false, error: String((e && e.message) || e) };
      });
    }
    return {
      kind: 'slide',
      snapshot: snapshot,
      applyOps: function (ops) {
        var out = [];
        var chain = Promise.resolve();
        (ops || []).forEach(function (op) {
          chain = chain.then(function () { return applyOp(op); }).then(function (r) { out.push(r); });
        });
        return chain.then(function () { return out; });
      },
    };
  }

  /* ---------- PDF 세션 (pdf-lib 바이트 경로) ---------- */

  var PDF_SNAPSHOT_PAGE_CAP = 100;

  /** PDF 스냅샷 순수 조립 (테스트 대상): 페이지 수 + 페이지별 크기·회전 메타. */
  function pdfSnapshotFromMeta(pageCount, pages) {
    var list = (pages || []).slice(0, PDF_SNAPSHOT_PAGE_CAP);
    var capped = list.length >= PDF_SNAPSHOT_PAGE_CAP && pageCount > list.length;
    return { pageCount: pageCount, pages: list, pagesCapped: capped };
  }

  function pdfSnapshotFromDoc(doc) {
    var count = doc.getPageCount();
    var pages = [];
    var cap = Math.min(count, PDF_SNAPSHOT_PAGE_CAP);
    for (var i = 0; i < cap; i++) {
      var pg = doc.getPage(i);
      pages.push({
        page: i + 1,
        width: Math.round(pg.getWidth()),
        height: Math.round(pg.getHeight()),
        rotation: pg.getRotation().angle,
      });
    }
    return pdfSnapshotFromMeta(count, pages);
  }

  function createPdfSession(host) {
    /* host.officeFetch는 office.js 규약상 함수형 접근자다 (office-assistant의
     * 메모 경로도 host.officeFetch()로 호출한다). 세션 생성 시점에 평가하면
     * 미저장 문서에서도 Drive 접근자가 불리므로, 실제 파일을 읽고 쓸 때만
     * 평가한다. 재구축본이 이를 객체로 직접 받아 F.loadFile이 undefined가
     * 됐고, 저장된 문서의 snapshot에서 동기 TypeError가 터져 패널이 영원히
     * "작업 중"에 머물렀다 (F6 근본원인). */
    function drive() {
      var F = typeof host.officeFetch === 'function' ? host.officeFetch() : host.officeFetch;
      if (!F) throw new Error('파일 입출력이 준비되지 않았어요');
      return F;
    }
    function loadDoc() {
      var file = host.getFile();
      return drive().loadFile(file.id).then(function (out) {
        return out.blob.arrayBuffer();
      }).then(function (buf) {
        return window.PDFLib.PDFDocument.load(buf);
      });
    }
    function overlayImage(text, size) {
      // 래스터 방식: 캔버스에 글자를 그려 PNG로 붙인다 (한글 글리프 대응).
      var scale = 4;
      var fontPx = Math.max(8, size || 14) * scale;
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return Promise.reject(new Error('이 환경에서는 텍스트 덧쓰기를 지원하지 않아요'));
      ctx.font = '600 ' + fontPx + 'px sans-serif';
      var w = Math.ceil(ctx.measureText(text).width) + 8 * scale;
      canvas.width = w;
      canvas.height = Math.ceil(fontPx * 1.5);
      ctx = canvas.getContext('2d');
      ctx.font = '600 ' + fontPx + 'px sans-serif';
      ctx.fillStyle = '#d43a2f';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 4 * scale, canvas.height / 2);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('텍스트 이미지 생성 실패')); return; }
          blob.arrayBuffer().then(resolve, reject);
        }, 'image/png');
      }).then(function (png) {
        return { bytes: png, width: canvas.width / scale, height: canvas.height / scale };
      });
    }
    return {
      kind: 'pdf',
      snapshot: function () {
        var file = host.getFile();
        if (file && file.id) {
          return loadDoc().then(pdfSnapshotFromDoc).catch(function () { return { pageCount: null }; });
        }
        // 미저장 새 문서: 엔진이 보여 주는 기본 문서(blank.pdf — office.js가
        // 새 PDF로 엔진에 싣는 바로 그 바이트)의 메타를 실어 모델이 연산을
        // 만들 수 있게 한다. pageCount가 비면 모델이 "페이지 수를 알려 달라"는
        // 대화 막다른 길로 빠진다 (3차 운영 QA 결함 ③). 적용 자체는 아래
        // 저장 경계 가드가 정확한 사유로 막는다.
        if (!window.PDFLib) return Promise.resolve({ pageCount: null });
        return fetch('/templates/blank.pdf')
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { return window.PDFLib.PDFDocument.load(buf); })
          .then(pdfSnapshotFromDoc)
          .catch(function () { return { pageCount: null }; });
      },
      applyOps: function (ops) {
        var file = host.getFile();
        // 저장 경계 가드 (D-36): 미저장 문서·미저장 변경에서는 사전 실패.
        if (!file || !file.id) {
          return Promise.resolve((ops || []).map(function (op) {
            return { op: op, ok: false, error: '아직 저장되지 않은 문서예요. 먼저 파일 메뉴에서 저장한 뒤 다시 시도해 주세요.' };
          }));
        }
        if (host.isDirty()) {
          return Promise.resolve((ops || []).map(function (op) {
            return { op: op, ok: false, error: '편집기에 저장되지 않은 변경이 있어요. 먼저 저장한 뒤 다시 시도해 주세요.' };
          }));
        }
        return loadDoc().then(function (doc) {
          var results = [];
          var mutated = false;
          var chain = Promise.resolve();
          (ops || []).forEach(function (op) {
            chain = chain.then(function () {
              var PDFLib = window.PDFLib;
              if (op.type === 'rotate_page') {
                var page = doc.getPage(op.page - 1);
                var next = (page.getRotation().angle + 90) % 360;
                page.setRotation(PDFLib.degrees(next));
                mutated = true;
                results.push({ op: op, ok: true });
                return null;
              }
              if (op.type === 'delete_page') {
                if (doc.getPageCount() <= 1) {
                  results.push({ op: op, ok: false, error: '마지막 페이지는 삭제할 수 없어요' });
                  return null;
                }
                doc.removePage(op.page - 1);
                mutated = true;
                results.push({ op: op, ok: true });
                return null;
              }
              if (op.type === 'extract_pages') {
                return window.PDFLib.PDFDocument.create().then(function (nd) {
                  var idxs = [];
                  for (var i = op.from - 1; i <= op.to - 1 && i < doc.getPageCount(); i++) idxs.push(i);
                  return nd.copyPages(doc, idxs).then(function (copied) {
                    copied.forEach(function (p) { nd.addPage(p); });
                    return nd.save();
                  }).then(function (bytes) {
                    var name = String(file.name || '문서.pdf').replace(/\.pdf$/i, '') +
                      ' ' + op.from + '-' + op.to + '쪽.pdf';
                    var blob = new Blob([bytes], { type: 'application/pdf' });
                    return drive().createFile(name, blob).then(function () {
                      results.push({ op: op, ok: true });
                    });
                  });
                }).catch(function (e) {
                  results.push({ op: op, ok: false, error: String((e && e.message) || e) });
                });
              }
              if (op.type === 'overlay_text') {
                return overlayImage(op.text, op.size).then(function (img) {
                  return doc.embedPng(img.bytes).then(function (embedded) {
                    var pg = doc.getPage(op.page - 1);
                    var x = typeof op.x === 'number' ? op.x : 56;
                    var yTop = typeof op.y === 'number' ? op.y : 56;
                    pg.drawImage(embedded, {
                      x: x,
                      y: pg.getHeight() - yTop - img.height,
                      width: img.width,
                      height: img.height,
                    });
                    mutated = true;
                    results.push({ op: op, ok: true });
                  });
                }).catch(function (e) {
                  results.push({ op: op, ok: false, error: String((e && e.message) || e) });
                });
              }
              results.push({ op: op, ok: false, error: '지원하지 않는 연산이에요' });
              return null;
            });
          });
          return chain.then(function () {
            var applied = results.some(function (r) { return r.ok; });
            if (!mutated || !applied) return results;
            return doc.save().then(function (bytes) {
              var blob = new Blob([bytes], { type: 'application/pdf' });
              return drive().saveFile(file.id, blob, file.version, file.name).then(function (out) {
                if (out.conflict) {
                  return results.map(function (r) {
                    return r.ok ? { op: r.op, ok: false, error: '다른 곳에서 먼저 바뀐 파일이에요 (409)' } : r;
                  });
                }
                host.setFileVersion(out.version);
                host.reloadFile();
                return results;
              });
            }).catch(function (e) {
              return results.map(function (r) {
                return r.ok ? { op: r.op, ok: false, error: '저장에 실패했어요: ' + String((e && e.message) || e) } : r;
              });
            });
          });
        }).catch(function (e) {
          return (ops || []).map(function (op) {
            return { op: op, ok: false, error: String((e && e.message) || e) };
          });
        });
      },
    };
  }

  /* ---------- 한글 세션 (@rhwp/core 바이트 경로) ---------- */

  var rhwpPromise = null;
  function loadRhwpCore() {
    if (!rhwpPromise) {
      rhwpPromise = import('/vendor/rhwp/rhwp.js').then(function (mod) {
        var init = mod.default || mod.init;
        return Promise.resolve(init('/vendor/rhwp/rhwp_bg.wasm')).then(function () { return mod; });
      });
    }
    return rhwpPromise;
  }

  var kordocPromise = null;
  function loadKordoc() {
    if (!kordocPromise) {
      kordocPromise = import('/vendor/kordoc/kordoc.bundle.js').then(function (mod) {
        var api = mod.default || mod;
        return {
          readText: function (buf, name) {
            return Promise.resolve(api.readText(buf, name)).then(function (r) {
              return typeof r === 'string' ? r : (r && r.markdown) || '';
            });
          },
          markdownToHwpx: api.markdownToHwpx,
        };
      });
    }
    return kordocPromise;
  }

  function paragraphText(doc, sec, para) {
    var len = doc.getParagraphLength(sec, para);
    if (!len) return '';
    return doc.getTextRange(sec, para, 0, len) || '';
  }

  /** HwpDocument에 HwpOp 하나를 적용한다. 성공 시 true, 사유 있는 실패는 throw. */
  function applyHwpOp(doc, op) {
    var secCount = doc.getSectionCount();
    if (op.type === 'append_paragraphs') {
      var sec = secCount - 1;
      (op.paragraphs || []).forEach(function (text, i) {
        var count = doc.getParagraphCount(sec);
        var lastText = count > 0 ? paragraphText(doc, sec, count - 1) : '';
        if (i === 0 && count > 0 && lastText === '') {
          doc.insertText(sec, count - 1, 0, text);
        } else {
          doc.insertParagraph(sec, count);
          doc.insertText(sec, count, 0, text);
        }
      });
      return true;
    }
    if (op.type === 'replace_text') {
      for (var s = 0; s < secCount; s++) {
        var n = doc.getParagraphCount(s);
        for (var p = 0; p < n; p++) {
          var text = paragraphText(doc, s, p);
          var idx = text.indexOf(op.find);
          if (idx >= 0) {
            doc.deleteText(s, p, idx, op.find.length);
            if (op.replace) doc.insertText(s, p, idx, op.replace);
            return true;
          }
        }
      }
      throw new Error('바꿀 텍스트를 문서에서 찾지 못했어요');
    }
    if (op.type === 'insert_table') {
      var sec2 = secCount - 1;
      var at = doc.getParagraphCount(sec2);
      doc.insertParagraph(sec2, at);
      var created = JSON.parse(doc.createTable(sec2, at, 0, op.rows.length + 1, op.headers.length));
      if (!created || created.ok !== true) throw new Error('표를 만들지 못했어요');
      var allRows = [op.headers].concat(op.rows);
      allRows.forEach(function (row, r) {
        row.forEach(function (cell, c) {
          var v = String(cell == null ? '' : cell);
          if (v) doc.insertTextInCell(sec2, created.paraIdx, created.controlIdx, r * op.headers.length + c, 0, 0, v);
        });
      });
      return true;
    }
    throw new Error('지원하지 않는 연산이에요');
  }

  function createHangulSession(host) {
    function editorBytes() {
      var editor = host.hwpEditor();
      if (!editor) return Promise.reject(new Error('편집 엔진이 준비되지 않았어요'));
      return Promise.resolve(editor.exportHwpx());
    }
    return {
      kind: 'hangul',
      snapshot: function () {
        return editorBytes().then(function (bytes) {
          return loadKordoc().then(function (kordoc) {
            var file = host.getFile();
            return kordoc.readText(bytes, file ? file.name : '문서.hwpx');
          }).then(function (markdown) {
            return { text: String(markdown || '').slice(0, 12000) };
          });
        }).catch(function () { return null; });
      },
      applyOps: function (ops) {
        return editorBytes().then(function (bytes) {
          return loadRhwpCore().then(function (mod) {
            var doc = new mod.HwpDocument(new Uint8Array(bytes));
            var results = [];
            try {
              (ops || []).forEach(function (op) {
                try {
                  applyHwpOp(doc, op);
                  results.push({ op: op, ok: true });
                } catch (e) {
                  results.push({ op: op, ok: false, error: String((e && e.message) || e) });
                }
              });
              var applied = results.some(function (r) { return r.ok; });
              if (!applied) return results;
              var out = doc.exportHwpx();
              var editor = host.hwpEditor();
              if (!editor) throw new Error('편집 엔진이 준비되지 않았어요');
              var file = host.getFile();
              return Promise.resolve(editor.loadFile(out, file ? file.name : '문서.hwpx', { skipUnsavedGuard: true }))
                .then(function () {
                  host.markDirty();
                  return results;
                });
            } finally {
              if (doc && typeof doc.free === 'function') { try { doc.free(); } catch (e) { console.warn('[office] doc.free 해제 실패', e); } }
            }
          });
        }).catch(function (e) {
          return (ops || []).map(function (op) {
            return { op: op, ok: false, error: String((e && e.message) || e) };
          });
        });
      },
    };
  }

  function create(host) {
    switch (host.app) {
      case 'excel': return createExcelSession(host);
      case 'powerpoint': return createSlideSession(host);
      case 'pdf': return createPdfSession(host);
      case 'hangul': return createHangulSession(host);
      default: return null;
    }
  }

  var api = {
    create: create,
    sheetSnapshotFromRead: sheetSnapshotFromRead,
    slideSnapshotFromInspects: slideSnapshotFromInspects,
    verifyTextSet: verifyTextSet,
    verifyInsertTextBox: verifyInsertTextBox,
    verifyTextReplace: verifyTextReplace,
    pdfSnapshotFromMeta: pdfSnapshotFromMeta,
    applyHwpOp: applyHwpOp,
    paragraphText: paragraphText,
  };
  if (typeof window !== 'undefined') window.MyHubOfficeSessions = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeSessions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
