// 파인더 뷰어 플러그인 모듈 — PPTX (finder-format-slide.js)
// 접근 실행 대관 최소: 리더 플러그 라이브러리는 장소소
// 자료로 확정된 등 없다(동봉 npm 패키지가 proprietary로 확인함) 것과
// 않고, JSZip+XML로 슬라이드별 텍스트와 이미지를 추출한다. "리더 수"
// 등계약이다 등서식 위치 배치를 포함하지 않은 것이다.
// 실측 실행 DeckCraft 전용 편집기(finder-deckcraft.js 브리지):
// 편집기는 안에 전용 ready가 확인된 뒤에만 앞으로 나오고, ready가
// 실패 없으면(위치이ailed) 리더 실행 그림으로 온다 (대관 보존,
// PdfCraft 통합과 같은 실행 계약). 접근 동안 미세 변경이 있으면
// 실행 반쯤 않고, 길 이가 dirty얼굴 등 최신 바이 트로
// 리더를 다시 그림 답한다.
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;
  // DeckCraft 호 스트 (finder-deckcraft.js) 가 없으면(구 로드
  // 순서) 테스트 리더 실행맡으로 (동작한다 대관보존).
  var deckCraft = typeof window !== 'undefined' ? window.MyHubFinderDeckCraft : null;

  var PPTX_MIME =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  var DECKCRAFT_NATIVE_MIME = 'application/vnd.storyteller.deckcraft+zip';
  // Drive 업로드 상한과 같은값 통합 (PdfCraft 파일 계약과 동일)
  var SAVE_LIMIT = 10 * 1024 * 1024;
  var READER_NOTE = '슬라이드 미리보기 등리더 수차례 서식 위치를 포함하지 않습니다';
  var DECK_NOTE = '전용 편집기 등 슬라이드를 직접 편집할 수 있습니다';

  // ---------- 클립보드 붙여넣기 (순수 헬퍼) ----------
  // 실행문서 삽입 붙여넣기 이미지를 확정 읽기 (호스트
  // finder-deckcraft.js와 같은 규칙 등 그림 파 일과 그림 넣기).
  function isFormFieldTarget(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function pasteImageFile(cd) {
    if (!cd) return null;
    var files = cd.files;
    if (files && files.length) {
      for (var i = 0; i < files.length; i++) {
        if (files[i] && String(files[i].type || '').indexOf('image/') === 0) return files[i];
      }
    }
    var items = cd.items;
    if (items) {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (
          it &&
          it.kind === 'file' &&
          String(it.type || '').indexOf('image/') === 0 &&
          typeof it.getAsFile === 'function'
        ) {
          var f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new window.FileReader();
      reader.onload = function () {
        var url = String(reader.result || '');
        var comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : '');
      };
      reader.onerror = function () {
        reject(reader.error || new Error('파일을 읽지 못했습니다'));
      };
      reader.readAsDataURL(file);
    });
  }

  function unescapeXml(s) {
    return String(s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // ---------- 문서 등 검색 (순수 헬퍼) ----------
  // 엔진 기록 (핀 61528c5, 필수 조사 찾기): 전용 조회 명 령은
  // 필요 없다 등 내부 있는 명령을 조합으로 푼다.
  // - text.find (crates/engine/src/cmd/find.rs): 쿼리 명령. 의
  //   슬라이드 위치 텍스트박스 등 표를 작업해 찾기 목록
  //   [{slide, shape(null = 노트), cell?, para, start, end}]를
  //   알려 (start/end준다 문단 등 문자 오프셋). 비서 replace-all의
  //   푸는와 text.replace같은 파일 같은 매핑(Opts)이다.
  // - slide.go {index} (cmd/slide.rs): 슬라이드 전환 (noundo).
  // - text.edit {id, at:[para,char], cell?, notes?} + text.select
  //   {anchor, caret} (cmd/text/): 위치 텍스트를 편집해 실패가 삭제
  //   텍스트 범위를 선택(슬라이드)한다. 엔진 자체 찾기 대화상자
  //   (ui-egui dialogs/find.rs)의 slide.go + edit.select(선 택)
  //   깊이 남으로, 텍스트 범위 선택을 엔진이 지원한 값인 강한
  //   피드. text.edit백이다 가 실패하는(위치: 노트 직접 실패
  //   않는 종류)에그 대화상자 안에서 같은 edit.select로 대변한다.
  // 찾기를 큰 값으로 답는 등: 처음 찾기(순환)기본값 이다.
  function findMatchKey(m) {
    if (!m) return '';
    return [
      m.slide,
      m.shape == null ? 'notes' : m.shape,
      Array.isArray(m.cell) ? m.cell.join(',') : '',
      m.para,
      m.start,
      m.end,
    ].join('|');
  }

  // 찾기 목록에서 prevKey 를다음 찾기를 고정 (생기면 처음으로 순환).
  // prevKey가 목록에 없으면(쿼리 변경등 편집) 첫 찾기부터이다.
  // 반환: {match, index, total} | null (찾기 없음)
  function nextFindMatch(matches, prevKey) {
    if (!Array.isArray(matches) || !matches.length) return null;
    var at = -1;
    if (prevKey) {
      for (var i = 0; i < matches.length; i++) {
        if (findMatchKey(matches[i]) === prevKey) {
          at = i;
          break;
        }
      }
    }
    var index = at >= 0 ? (at + 1) % matches.length : 0;
    return { match: matches[index], index: index, total: matches.length };
  }

  // 찾기 1건으로 이동하는 exec 배치: 슬라이드 전환 등 텍스트 편집
  // 진행(찾기 시작) 등 찾기 범위 선택. 배치 host.rs에서 순서대로
  // 실행하므로 등 번의 exec로 자연적으로 보인다.
  function buildFindNavCommands(m) {
    var cmds = [{ id: 'slide.go', params: { index: m.slide } }];
    var at = [m.para, m.start];
    if (m.shape == null) {
      // 노 트: shape null찾기 인 (find.rs노트 Loc 계약)
      cmds.push({ id: 'text.edit', params: { notes: true, at: at } });
    } else if (Array.isArray(m.cell)) {
      cmds.push({ id: 'text.edit', params: { id: m.shape, cell: m.cell, at: at } });
    } else {
      cmds.push({ id: 'text.edit', params: { id: m.shape, at: at } });
    }
    cmds.push({
      id: 'text.select',
      params: { anchor: [m.para, m.start], caret: [m.para, m.end] },
    });
    return cmds;
  }

  // 텍스트 편집 진행이 실패했을 때의 대변 배치: 엔진 자체 찾기
  // 대화상자와 같은 수(슬라이드 전환 + 위치 선택). 노트 찾기는
  // 선택된 위치가 없어 슬라이드 전환만이다.
  function buildFindFallbackCommands(m) {
    var cmds = [{ id: 'slide.go', params: { index: m.slide } }];
    if (m.shape != null) {
      cmds.push({ id: 'edit.select', params: { ids: [m.shape] } });
    }
    return cmds;
  }

  // ---------- 비서 열람 (순수 헬퍼) ----------
  // 비서 열 file.info(람은)로 끝나지 않게 문서를
  // 반쯤하면 자료표시 위치 id가 현재 텍스트가 있는 셈이다.
  // 에서는 slide.inspect가 위치별 {id, name, kind, placeholder,
  // text(빈칸 있을 때만 를), table.cells}알려 주므로, 세션
  // 열람은 inspect 결과를 등 모양으로 정규화해 조립한다. 빈칸
  // 있는 자료표시자는 text ""로 명시한다 (없음과 빈칸 있음의
  // 비서에게 다른 정보를 등 빈 자료표시자말로 text.set로 보낸).
  var SNAPSHOT_SLIDE_CAP = 50;
  var SNAPSHOT_TEXT_CAP = 400;

  function mapInspectShape(sh, shapeSlide, slideIndex) {
    if (!sh || typeof sh !== 'object') return null;
    var id = typeof sh.id === 'number' ? sh.id : null;
    if (id !== null && shapeSlide) shapeSlide[id] = slideIndex;
    var out = {
      id: id,
      text: typeof sh.text === 'string' ? sh.text.slice(0, SNAPSHOT_TEXT_CAP) : '',
    };
    if (typeof sh.name === 'string' && sh.name) out.name = sh.name;
    if (typeof sh.kind === 'string' && sh.kind) out.kind = sh.kind;
    out.placeholder = typeof sh.placeholder === 'string' ? sh.placeholder : null;
    if (sh.table && Array.isArray(sh.table.cells)) {
      out.cells = sh.table.cells.map(function (row) {
        return (Array.isArray(row) ? row : []).map(function (c) {
          return String(c == null ? '' : c).slice(0, SNAPSHOT_TEXT_CAP);
        });
      });
    }
    return out;
  }

  // 그림 자신이 흔들리며 넣습니다 등 엔진 text.set를 위치 갱신
  // (find_shape_mut)의 그림 흔들 갱신하므로 자신 id가 유효
  // 교체 대상이고, id가 지금까지 실패가 셈이다.
  function collectInspectShapes(list, out, shapeSlide, slideIndex) {
    (Array.isArray(list) ? list : []).forEach(function (sh) {
      var mapped = mapInspectShape(sh, shapeSlide, slideIndex);
      if (mapped) out.push(mapped);
      if (sh && Array.isArray(sh.children)) {
        collectInspectShapes(sh.children, out, shapeSlide, slideIndex);
      }
    });
  }

  function mapInspectSlide(detail, shapeSlide) {
    var d = detail && typeof detail === 'object' ? detail : {};
    var slideIndex = typeof d.index === 'number' ? d.index : 0;
    var shapes = [];
    collectInspectShapes(d.shapes, shapes, shapeSlide, slideIndex);
    var out = { index: slideIndex, shapes: shapes };
    if (typeof d.title === 'string' && d.title) out.title = d.title;
    if (typeof d.layout === 'string' && d.layout) out.layout = d.layout;
    if (typeof d.notes === 'string' && d.notes) {
      out.notes = d.notes.slice(0, SNAPSHOT_TEXT_CAP);
    }
    return out;
  }

  // ---------- 비서 연산 확장 (순수 헬퍼) ----------
  // text.set와insert.textBox에서 엔진에서 현재 슬라이드의 위치만
  // 푼다(edit_shapes가 선택 중 슬라이드를 본다). 그레이 파일
  // 슬라이드가 배치 있으면 마지막으로 알려진 현재 슬라이드의
  // 옆에 slide.go를 앞에 붙인다. 네비 게이션 opIndex -1명령으로
  // 표시한 결과 집계에서 연산 실패로 빼지 않는다. 파일 슬라이드
  // 결정: 연산의 slide 파라미터가 우선, 없으면 열람이 남긴
  // id가 지금까지 실패. slide.new이룬다 가단일 등 슬라이드로 선택한
  // 등꺼값을 등 있어 현재 위치를 않는다(다음 파일 연산 다시
  // 이동한다). 엔진의 빠져 명령에서 slide 를 뺀다
  // (엔진 명령의 파라미터가 아니다).
  function expandSlideCommands(ops, shapeSlide) {
    var expanded = [];
    var cur = null;
    (Array.isArray(ops) ? ops : []).forEach(function (op, opIndex) {
      var id = op && op.id;
      var params = (op && op.params) || {};
      var target = null;
      var cmdParams = null;
      if (id === 'text.set') {
        target =
          typeof params.slide === 'number'
            ? params.slide
            : shapeSlide && typeof shapeSlide[params.id] === 'number'
              ? shapeSlide[params.id]
              : null;
        cmdParams = { id: params.id, text: params.text };
        if (Array.isArray(params.cell)) cmdParams.cell = params.cell;
      } else if (id === 'insert.textBox') {
        target = typeof params.slide === 'number' ? params.slide : null;
        cmdParams = { text: params.text };
        if (Array.isArray(params.rect)) cmdParams.rect = params.rect;
      }
      if (cmdParams) {
        if (target !== null && target !== cur) {
          expanded.push({ cmd: { id: 'slide.go', params: { index: target } }, opIndex: -1 });
          cur = target;
        }
        expanded.push({ cmd: { id: id, params: cmdParams }, opIndex: opIndex });
        return;
      }
      expanded.push({ cmd: { id: id, params: params }, opIndex: opIndex });
      if (id === 'slide.new') cur = null;
    });
    return expanded;
  }

  // 확장한 명령 목록을 실행 결과를 원래 연산 단위로 접는다.
  // appliedIndexes는 적용 등 상태 검증(verifySlideApply)의 어떤
  // 연산이 성공으로 죽었는지 알기 위한 내부 정보다.
  function foldSlideResults(ops, expanded, results) {
    var applied = 0;
    var errors = [];
    var seen = {};
    var appliedIndexes = [];
    expanded.forEach(function (e, i) {
      if (e.opIndex < 0) return;
      seen[e.opIndex] = true;
      var r = results && results[i];
      if (r && r.ok) {
        applied += 1;
        appliedIndexes.push(e.opIndex);
      } else errors.push({ index: e.opIndex, message: (r && r.error) || '명령 실패' });
    });
    (Array.isArray(ops) ? ops : []).forEach(function (_op, opIndex) {
      if (!seen[opIndex]) errors.push({ index: opIndex, message: '명령 실패' });
    });
    return { applied: applied, errors: errors, appliedIndexes: appliedIndexes };
  }

  // ---------- 적용 등 엔진 상태 검증 (순수 헬퍼) ----------
  // exec의 ok가 "명 령 오류 없이"파하 였다 쓸리, 슬라 이드
  // 상 태가 만족 보장이. 아니다 선택 대상/마스크
  // insert.textBox가 슬라이드 우측 않게도 엔진 ok를 알려주고
  // (결과 editing 표시가 붙은 뿐이다), 종전 클라이언트는 ok만 넘겨
  // "적용"됐어로 보고했다 등 운영 크기 성공한 엔진 쪽 경로다.
  // 그레이 적용이후 열람으로 연산별 효과를 등 조합하고, 확인이
  // 않는 연산은 성공으로 빼지 않는다.
  // - text.set: 같 은(위치 를 텍스)트가 등 값과 같아 져야 한다.
  // - insert.textBox: 같은 텍스트의 위치 삽입 적용 아래로 늘어나야 한다.
  // - slide.new: 슬라이드 총수가 늘어나야 하고, 제목을 지정하면 그
  //   제목을 실제로 정해야 한다.
  // - text.replace: 적용 등 어디로든 찾을 말이 더는 없어 있어야 한다
  //   (바뀐 말이 찾을 말을 포함하면 등조건 무시해 exec 결과를 버린다).
  // - 그 밖의 통과 명령(보기 전환 등)상 태로 확 인한 alagasate만 없어
  //   exec 결과 대로 본다 applyOps로 오는 서버 검증 연 산의 4종류다.
  // before가 없으면(적용 등 열람 실패) 증가 등조건 필요한 연산은
  // 미명으로 실패 처리하고, after가 없으면 전부 미명이다.
  var VERIFY_FAIL_MESSAGE = '적용한 엔진 상태에서 확인하지 않았어요';

  function snapshotSlidesOf(snap) {
    return snap && Array.isArray(snap.slides) ? snap.slides : [];
  }
  function capSnapshotText(t) {
    return String(t == null ? '' : t).slice(0, SNAPSHOT_TEXT_CAP);
  }
  function shapeTextCounts(snap) {
    var counts = {};
    snapshotSlidesOf(snap).forEach(function (sl) {
      (Array.isArray(sl.shapes) ? sl.shapes : []).forEach(function (sh) {
        var t = sh && typeof sh.text === 'string' ? sh.text : '';
        if (t) counts[t] = (counts[t] || 0) + 1;
      });
    });
    return counts;
  }
  function slideTitleCount(snap, title) {
    return snapshotSlidesOf(snap).filter(function (sl) {
      return sl.title === title;
    }).length;
  }
  function confirmTextSet(after, p) {
    var want = capSnapshotText(p.text);
    var found = null;
    snapshotSlidesOf(after).forEach(function (sl) {
      (Array.isArray(sl.shapes) ? sl.shapes : []).forEach(function (sh) {
        if (sh && sh.id === p.id) found = sh;
      });
    });
    if (!found) return false;
    if (Array.isArray(p.cell)) {
      var row = found.cells && found.cells[p.cell[0]];
      return Array.isArray(row) && row[p.cell[1]] === want;
    }
    return found.text === want;
  }
  function snapshotContainsText(snap, needle) {
    if (!needle) return false;
    return snapshotSlidesOf(snap).some(function (sl) {
      if (typeof sl.notes === 'string' && sl.notes.indexOf(needle) >= 0) return true;
      return (Array.isArray(sl.shapes) ? sl.shapes : []).some(function (sh) {
        if (!sh) return false;
        if (typeof sh.text === 'string' && sh.text.indexOf(needle) >= 0) return true;
        if (Array.isArray(sh.cells)) {
          return sh.cells.some(function (row) {
            return (Array.isArray(row) ? row : []).some(function (c) {
              return typeof c === 'string' && c.indexOf(needle) >= 0;
            });
          });
        }
        return false;
      });
    });
  }

  function verifySlideApply(ops, folded, before, after) {
    var errors = (folded.errors || []).slice();
    var claimed = (folded.appliedIndexes || []).slice().sort(function (a, b) {
      return a - b;
    });
    if (!claimed.length) return { applied: folded.applied || 0, errors: errors };
    if (!after) {
      claimed.forEach(function (opIndex) {
        errors.push({ index: opIndex, message: VERIFY_FAIL_MESSAGE });
      });
      return { applied: 0, errors: errors };
    }
    var beforeCounts = shapeTextCounts(before);
    var afterCounts = shapeTextCounts(after);
    var consumed = {};
    var newSeen = 0;
    var applied = 0;
    claimed.forEach(function (opIndex) {
      var op = (Array.isArray(ops) ? ops : [])[opIndex] || {};
      var p = op.params || {};
      var ok = true;
      if (op.id === 'text.set') {
        ok = confirmTextSet(after, p);
      } else if (op.id === 'insert.textBox') {
        var key = capSnapshotText(p.text);
        var avail =
          (afterCounts[key] || 0) - (before ? beforeCounts[key] || 0 : 0) - (consumed[key] || 0);
        ok = !!before && avail >= 1;
        if (ok) consumed[key] = (consumed[key] || 0) + 1;
      } else if (op.id === 'slide.new') {
        newSeen += 1;
        var delta = before ? (after.slideCount || 0) - (before.slideCount || 0) : 0;
        ok = !!before && delta >= newSeen;
        if (ok && typeof p.title === 'string' && p.title) {
          ok =
            slideTitleCount(after, p.title) > slideTitleCount(before, p.title) ||
            (afterCounts[capSnapshotText(p.title)] || 0) >
              (beforeCounts[capSnapshotText(p.title)] || 0);
        }
      } else if (op.id === 'text.replace') {
        var withText = typeof p.with === 'string' ? p.with : '';
        ok =
          (typeof p.text === 'string' && p.text && withText.indexOf(p.text) >= 0) ||
          !snapshotContainsText(after, p.text);
      }
      if (ok) applied += 1;
      else errors.push({ index: opIndex, message: VERIFY_FAIL_MESSAGE });
    });
    return { applied: applied, errors: errors };
  }

  // 슬라이드 XML에서 문단(a:p)별 텍스트(a:t)를 뽑는다
  function extractSlideParagraphs(xml) {
    var paragraphs = [];
    var chunks = String(xml || '').split(/<\/a:p>/);
    chunks.forEach(function (chunk) {
      var parts = [];
      var re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      var m;
      while ((m = re.exec(chunk)) !== null) parts.push(unescapeXml(m[1]));
      var text = parts.join('');
      if (text.trim()) paragraphs.push(text);
    });
    return paragraphs;
  }

  // 슬라이드 XML에서 참조 이미지 관계 ID(r:embed)를 문서 순서로 뽑는다
  function extractBlipIds(xml) {
    var ids = [];
    var re = /<a:blip[^>]*r:embed="(rId\d+)"/g;
    var m;
    var s = String(xml || '');
    while ((m = re.exec(s)) !== null) ids.push(m[1]);
    return ids;
  }

  // rels XML에서 관계 ID 등 파일 경로(슬라이드 기준 상대경로)를 뽑는다
  function parseSlideRels(xml) {
    var map = {};
    var re = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
    var m;
    var s = String(xml || '');
    while ((m = re.exec(s)) !== null) map[m[1]] = m[2];
    // 속성 순서가 바뀌는 경우도 허용한다
    var re2 = /<Relationship[^>]*Target="([^"]+)"[^>]*Id="(rId\d+)"/g;
    while ((m = re2.exec(s)) !== null) {
      if (!map[m[2]]) map[m[2]] = m[1];
    }
    return map;
  }

  // 'ppt/slides/../media/image1.png' 같은 상대 참조를 zip 경로로 정규화한다
  function resolveZipPath(baseDir, target) {
    var parts = (baseDir + '/' + target).split('/');
    var out = [];
    parts.forEach(function (p) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    });
    return out.join('/');
  }

  // 항목 목록에서 슬라이드 XML만 숫자 순서로 고정
  function sortSlideNames(names) {
    return (names || [])
      .filter(function (n) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(n);
      })
      .sort(function (a, b) {
        var na = Number((a.match(/slide(\d+)\.xml$/) || [])[1] || 0);
        var nb = Number((b.match(/slide(\d+)\.xml$/) || [])[1] || 0);
        return na - nb;
      });
  }

  // 순 수: [{name, xml}] 추출 [{slide, paragraphs}] (단위 파싱 결과)
  function extractPptxSlides(entries) {
    var byName = {};
    (entries || []).forEach(function (e) {
      byName[e.name] = e.xml;
    });
    return sortSlideNames(Object.keys(byName)).map(function (name) {
      return {
        slide: Number((name.match(/slide(\d+)\.xml$/) || [])[1] || 0),
        paragraphs: extractSlideParagraphs(byName[name]),
      };
    });
  }

  function renderSlide(ctx, container, zip, name, index) {
    return zip.files[name].async('text').then(function (xml) {
      if (!ctx.isCurrent()) return;
      var card = ctx.doc.createElement('section');
      card.className = 'fv-slide';
      var head = ctx.doc.createElement('h3');
      head.className = 'fv-slide-title';
      head.textContent = '슬라이드 ' + (index + 1);
      card.appendChild(head);
      extractSlideParagraphs(xml).forEach(function (text) {
        var p = ctx.doc.createElement('p');
        p.className = 'fv-slide-text';
        p.textContent = text;
        card.appendChild(p);
      });
      container.appendChild(card);
      // 이미지의 슬라이드 관계(rels)를 따라 원본 순서대로 아래에 붙인
      var relsName = name.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      var relsFile = zip.files[relsName];
      if (!relsFile) return;
      return relsFile.async('text').then(function (relsXml) {
        if (!ctx.isCurrent()) return;
        var rels = parseSlideRels(relsXml);
        var ids = extractBlipIds(xml);
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () {
            var target = rels[id];
            if (!target) return;
            var zipPath = resolveZipPath('ppt/slides', target);
            var mediaFile = zip.files[zipPath];
            if (!mediaFile) return;
            return mediaFile.async('blob').then(function (blob) {
              if (!ctx.isCurrent()) return;
              var img = ctx.doc.createElement('img');
              img.className = 'fv-slide-img';
              img.alt = '';
              // 텍스트가 먼저 보이고 사진이 뒤쭉 판독한 (사진 많
              // 문서에서 본문을 사진이 맞히지 않게 등 2026-11-02 지정)
              img.loading = 'lazy';
              img.decoding = 'async';
              img.src = URL.createObjectURL(blob);
              card.appendChild(img);
            });
          });
        });
        return chain;
      });
    });
  }

  // 최소리더 바이트: 등 슬라이드 카드 목록 접근 (실행 대관 본체)
  function renderReader(ctx, container, buf) {
    return ctx
      .loadLib('jszip')
      .then(function (JSZip) {
        return JSZip.loadAsync(buf);
      })
      .then(function (zip) {
        if (!ctx.isCurrent()) return;
        var names = sortSlideNames(Object.keys(zip.files));
        if (!names.length) throw new Error('no slides');
        container.textContent = '';
        var chain = Promise.resolve();
        names.forEach(function (name, i) {
          chain = chain.then(function () {
            return renderSlide(ctx, container, zip, name, i);
          });
        });
        return chain;
      });
  }

  function handlePptx(ctx) {
    var isNew = !ctx.file.fileId;
    var doc = ctx.doc;
    ctx.clearBody();
    ctx.body.classList.add('fv-fill');
    var readerWrap = doc.createElement('div');
    readerWrap.className = 'fv-slide-reader';
    ctx.body.appendChild(readerWrap);

    var state = {
      surface: 'reader',
      deck: null,
      deckReady: false,
      dirty: false,
      saveWaiter: null,
      lastSavedBytes: null,
      // 문서 등 검색의 순환 상태: 마지막 질의와 마지막으로 이동한
      // 찾기 등. 질의가 바뀌면 처음부터, 같으면 다음 찾기로 간다.
      // findChain의 빠른 연속 입력에서 순서가 앞지 않게 직렬화한다.
      find: { query: null, key: null, chain: Promise.resolve() },
      // 비서 열람이 남긴 위치등 id 슬라이드 번호 지정 를. text.set
      // 적용 등 파일 슬라이드로 이동(slide.go)하는 근거 등 열람이
      // 갱신된 뒤에 다시 채워진다.
      shapeSlide: {},
    };

    // 엔진 내장 등 복원 (2026-11-06 실행 페): 이지 에서는
    // DeckCraft 자체의 등 피벗본을 그대로 이룬다 (finder-deckcraft의
    // 기본 URL 등를 notabs뺀 등 등 호스트 표시 와). 중 실행 등
    // 제목 중 빠른 실행뿐이다.
    var officeSurface = !!(
      ctx.minimalChrome &&
      typeof window !== 'undefined' &&
      window.MyHubOfficeTabs
    );
    // 제목 중 빠른 실행 가용성: 편집기(deck) 실행 내부 있을 때만
    // undo/redo/print를 올린 등 리더(읽기 전용)에서는 내린다.
    function publishQuick() {
      if (!officeSurface) return;
      var on = state.surface === 'deck' && !!state.deck && state.deckReady;
      window.MyHubOfficeTabs.setQuick('powerpoint', {
        undo: on,
        redo: on,
        print: on,
        search: on,
      });
    }

    // 문서 등 검색 1단계: text.find로 등 슬라이드를 작업 다음 찾기로
    // 이동한다 (순환). 모두 찾으면 상태로 알린 등 조용히 실패 금지
    // (시트 빠른 실행의 quick-result 와 같은 것).
    function findOnce(query) {
      if (!ctx.isCurrent() || !state.deck || !state.deckReady) {
        return Promise.resolve();
      }
      var prevKey = state.find.query === query ? state.find.key : null;
      return state.deck
        .exec([{ id: 'text.find', params: { text: query } }])
        .then(function (results) {
          if (!ctx.isCurrent() || !state.deck) return null;
          var r = results && results[0];
          if (!r || !r.ok || !Array.isArray(r.result)) {
            ctx.setStatus('검색을 실행하지 못했습니다');
            return null;
          }
          var pick = nextFindMatch(r.result, prevKey);
          state.find.query = query;
          if (!pick) {
            state.find.key = null;
            ctx.setStatus('문서에서 찾을 수 없습니다');
            return null;
          }
          state.find.key = findMatchKey(pick.match);
          var where =
            '문서에서 찾아봅니다 (' +
            (pick.index + 1) +
            '/' +
            pick.total +
            ', ' +
            (pick.match.slide + 1) +
            '번 슬라이드)';
          return state.deck.exec(buildFindNavCommands(pick.match)).then(function (nav) {
            if (!ctx.isCurrent()) return;
            var failed = !nav || nav.some(function (x) { return !x || !x.ok; });
            if (!failed) {
              ctx.setStatus(where);
              return;
            }
            // 텍 스트 편집 즈엯 등 하는(찾기 위치 종류)등 엔진
            // 자체 찾기 대화상자 수(위치 선택)로 대변한다 등
            // 슬라이드 이동 자체의 내부 우측으로 실패로 보내지 않는다.
            return state.deck
              .exec(buildFindFallbackCommands(pick.match))
              .then(function () {
                if (ctx.isCurrent()) ctx.setStatus(where);
              })
              .catch(function () {
                if (ctx.isCurrent()) ctx.setStatus(where);
              });
          });
        })
        .catch(function () {
          if (ctx.isCurrent()) ctx.setStatus('검색을 실행하지 못했습니다');
        });
    }

    if (officeSurface) {
      // 동작 배선 (엔진 기록 확정의): edit.undo/edit.redo집힌 명령이고
      // 인, 쇄가 app.print정한 경 로인 등 인 PDF쇄가
      // deckcraft:print로 차린 실행 시스템 인쇄 대화상자에 건다
      // (서정된 backstage 인쇄 페이지가 같은 실행으로 반영된다).
      // 문서 등 검색
      // text.find + slide.go + text.edit/text.select 조합으로 푼다
      // (문서 순수 헬퍼 주요 기록 근처 등 전용 명령 조합 불필요).
      window.MyHubOfficeTabs.onQuick('powerpoint', function (action, value) {
        if (!ctx.isCurrent() || !state.deck || !state.deckReady) return false;
        var swallow = function () {};
        if (action === 'undo') {
          state.deck.exec([{ id: 'edit.undo' }]).catch(swallow);
          return true;
        }
        if (action === 'redo') {
          state.deck.exec([{ id: 'edit.redo' }]).catch(swallow);
          return true;
        }
        if (action === 'print') {
          // 인쇄 정한 (이 실행 공통): 차 바 인쇄가 화면 버로 인쇄
          // 등 엔 app.print진이 인쇄 PDF를 deckcraft:print로 올리고,
          // 실행 통해 프레임으로 시스템 인쇄 대화상자에 건다 (아래
          // printPdfBytes). 정서정(레이아웃)의 엔진 backstage 인쇄
          // 페이지가 같은 자리에서 맞고, 그 페이지를 인쇄 실행과 같은
          // 채널로 전달한다. backstage를 여는 것은 인쇄 실행이 아니다.
          state.deck.exec([{ id: 'app.print', params: {} }]).catch(swallow);
          return true;
        }
        if (action === 'search') {
          var query = typeof value === 'string' ? value.trim() : '';
          if (!query) return true;
          // 연속 입력을 직렬화한 등 우선 찾기 이동 생략 안에
          // 다음 찾기가 순환 기본과(마지막 찾기)의 앉는다.
          state.find.chain = state.find.chain.then(
            function () { return findOnce(query); },
            function () { return findOnce(query); },
          );
          return true;
        }
        return false;
      });
    }

    // 열람의 = file.info + 조합파일 slide.inspect 슬라이드. file.info
    // 만 알려주는 최소은 비서에게 위치 텍스트 취보이 않아
    // "열람에 슬라이드 텍스트가 없다"로 제목 변경을 건너뜀다
    // (2026-11-07 운영 행위 결정인). inspect 의 차이 실패하면
    // 그 슬라이드만 빈 위치 목록으로 알고 넘어가 이룬다.
    // applyOps의 적용 이후 등조건 같은 조합을 이룬다.
    function takeSnapshot() {
      if (!state.deck || !state.deckReady) {
        return Promise.reject(new Error('편집기가 아직 준비되지 않았습니다'));
      }
      return state.deck.exec([{ id: 'file.info', params: {} }]).then(function (results) {
          var r = results && results[0];
          if (!r || !r.ok) {
            throw new Error((r && r.error) || '문서 정보를 읽지 못했습니다');
          }
          var info = r.result || {};
          var total = typeof info.slides === 'number' ? info.slides : 0;
          var count = Math.min(total, SNAPSHOT_SLIDE_CAP);
          var base = {
            title: typeof info.title === 'string' ? info.title : '',
            slideCount: total,
            dirty: !!info.dirty,
          };
          if (count <= 0) {
            state.shapeSlide = {};
            return Object.assign(base, { slides: [] });
          }
          var cmds = [];
          for (var i = 0; i < count; i++) {
            cmds.push({ id: 'slide.inspect', params: { index: i } });
          }
          return state.deck.exec(cmds).then(function (ires) {
            var shapeSlide = {};
            var slides = [];
            for (var k = 0; k < count; k++) {
              var ir = ires && ires[k];
              var detail = ir && ir.ok && ir.result ? ir.result : { index: k, shapes: [] };
              slides.push(mapInspectSlide(detail, shapeSlide));
            }
            state.shapeSlide = shapeSlide;
            var snap = Object.assign(base, { slides: slides });
            if (total > count) snap.truncated = true;
            return snap;
          });
        });
    }

    // 비서 세션 등록 등 시트와 같은 모양: 세션이 마지막으로 교체하고,
    // snapshot/applyOps과 DeckCraft exec 채(널 id 명령)를 푼다.
    session = {
      kind: 'slide',
      ctx: ctx,
      snapshot: takeSnapshot,
      // ops의명령 deck 기술자 그대로 [{id, params}] 이다 (시트 자체
      // 연산 파생 파일 엔진 명령 id를 푸는 것이 등 등의 등록 형식).
      // 등 text.set와insert.textBox현재 슬라이 드에서만 푸는 명령
      // 이라, 보낸 등 파일 슬라이드로의 이동(slide.go)의 확장한 일괄
      // 묶고 결과는 원래 연산 단위로 접는다 (expandSlideCommands).
      // 적용 확정 exec로 ok실패 하지 않는다 등 적용 이후 열람으로
      // 등조건 엔진 상태에서 확인한 연산만 성공으로 이룬다
      // (verifySlideApply 의 마스크/입력 파일 넣기 같은 거짓 성공 차단).
      applyOps: function (ops) {
        if (!state.deck || !state.deckReady) {
          return Promise.resolve({
            applied: 0,
            errors: [{ index: -1, message: '편집기가 아직 준비되지 않았습니다' }],
          });
        }
        var list = ops || [];
        if (!list.length) return Promise.resolve({ applied: 0, errors: [] });
        return takeSnapshot()
          .catch(function () {
            return null;
          })
          .then(function (before) {
            var expanded = expandSlideCommands(list, state.shapeSlide);
            var commands = expanded.map(function (e) {
              return e.cmd;
            });
            return state.deck
              .exec(commands)
              .then(function (results) {
                var folded = foldSlideResults(list, expanded, results);
                if (!folded.appliedIndexes.length) {
                  return { applied: folded.applied, errors: folded.errors };
                }
                return takeSnapshot().then(
                  function (after) {
                    return verifySlideApply(list, folded, before, after);
                  },
                  function () {
                    return verifySlideApply(list, folded, before, null);
                  },
                );
              })
              .catch(function (err) {
                return {
                  applied: 0,
                  errors: [{ index: -1, message: (err && err.message) || '편집기 응답이 없습니다' }],
                };
              });
          });
      },
    };

    function showDeck() {
      if (!state.deck) return;
      readerWrap.style.display = 'none';
      state.deck.frame.style.display = '';
      state.surface = 'deck';
      if (ctx.saveBtn) ctx.saveBtn.hidden = false; // 편집기 에서만 핵심 파일 버튼 노출
      ctx.setNote(DECK_NOTE);
      publishQuick();
    }

    function showReader() {
      if (state.deck) state.deck.frame.style.display = 'none';
      readerWrap.style.display = '';
      state.surface = 'reader';
      if (ctx.saveBtn) ctx.saveBtn.hidden = true; // 리더를 읽기 전용 (구 최소 리더 계약)
      publishQuick();
    }

    function stopDeck() {
      if (!state.deck) return;
      state.deck.destroy();
      state.deck = null;
      state.deckReady = false;
      publishQuick();
    }

    // 접근 상 태로 파한 때의: 마감은 리더 실행과, 반쯤
    // 담린 바이트가 있으면 리더를 최신 내용으로 다시 그림.
    function settleToReader() {
      showReader();
      ctx.setNote(READER_NOTE);
      var buf = state.lastSavedBytes;
      state.lastSavedBytes = null;
      if (buf) {
        renderReader(ctx, readerWrap, buf).catch(function () {
          return undefined; // 리더 플러그 실패 실행 전환은 되돌리지 않는다
        });
      } else if (!isNew) {
        ctx.fetchContent('buffer').then(function (fresh) {
          if (!ctx.isCurrent() || state.surface !== 'reader') return;
          renderReader(ctx, readerWrap, fresh).catch(function () {
            return undefined;
          });
        });
      }
    }

    // 코어 파일 버튼 실행 경: 로에 requestSave를 보내고
    // deckcraft:save(표가)까지 putContent실은 등 포함 한다.
    function saveViaDeck() {
      if (!state.deck || !state.deckReady) {
        ctx.setStatus('편집기가 아직 준비되지 않았습니다');
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        state.saveWaiter = function (ok) {
          resolve(ok);
        };
        if (!state.deck.requestSave()) {
          state.saveWaiter = null;
          resolve(false);
          return;
        }
        setTimeout(function () {
          if (state.saveWaiter) {
            state.saveWaiter = null;
            ctx.setStatus('편집기 응답이 없습니다');
            resolve(false);
          }
        }, 30000);
      });
    }

    function finishSaveWaiter(ok) {
      var w = state.saveWaiter;
      state.saveWaiter = null;
      if (w) w(ok);
    }

    // 인쇄 PDF를 통해 iframe로 이어 시스템 인쇄 대화상자에
    // 전달 한다 (인쇄 정한 등 시트의 printPdfBase64와 같은 방식).
    // 인쇄 바이트는 다운로드 파일어느 쪽으로도 있지 않는다. blob
    // URL가 인쇄가 실은 시간을 갖고 파손하고, 어떤 단계가 실패해도
    // 조용히 죽인 않고 상태로 알린다.
    function printPdfBytes(bytes) {
      try {
        if (!bytes) throw new Error('empty');
        var url = URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' }),
        );
        var pf = doc.createElement('iframe');
        pf.setAttribute('aria-hidden', 'true');
        pf.style.cssText =
          'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;';
        pf.addEventListener('load', function () {
          setTimeout(function () {
            try {
              if (pf.contentWindow) pf.contentWindow.print();
            } catch (e) {
              ctx.setStatus('인쇄를 시작하지 못했습니다');
            }
            setTimeout(function () {
              if (pf.parentNode) pf.parentNode.removeChild(pf);
              URL.revokeObjectURL(url);
            }, 60000);
          }, 250);
        });
        pf.src = url;
        doc.body.appendChild(pf);
      } catch (e) {
        ctx.setStatus('인쇄를 시작하지 못했습니다');
      }
    }

    // 내보(PDF내기 이미지)등 문서 길이가 아니 사용자가 등 안에
    // 요청은 다운로드 등 브라우저 다운로드로 그대로 넘긴다.
    function downloadExport(name, bytes) {
      try {
        var blob = new Blob([bytes]);
        var url = URL.createObjectURL(blob);
        var a = doc.createElement('a');
        a.href = url;
        a.download = name || 'export';
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 5000);
      } catch (e) {
        console.warn('내보내기 다운로드 실패:', e);
        ctx.setStatus('내보내기를 가져와서 못했습니다');
      }
    }

    // 엔 진의 파일 선택(deckcraft:request-open)위임의 파일 등 엔진
    // 요청 id로 알려준다. 실행 반쯤했거나 편집기가 죽었으면 핵심
    // 그림 버려 진다 등 그림의 등 문서가 실패가 않게.
    function answerDeckPick(request, name, bytes) {
      if (!ctx.isCurrent() || !state.deck || !bytes) return;
      state.deck.answerPick(request, name, bytes);
    }

    // 미디어타입 선택은 ctx의 전용 메시지 없어 루트
    // 이벤트로 올린다 (office가 목적별 일괄 아카로 건다 등 시트의
    // request-picture와 같은 루트 이벤트 계약). 파일이 없는
    // 실행에서는 조용히 생략한: OS 대화상자로 있는 것을 본다.
    function requestDeckMedia(purpose, request) {
      // 그림과 같은 루트 계약으로 purpose가같이 간다 (코어 requestMedia)
      ctx.requestMedia(purpose, function (name, bytes) {
        answerDeckPick(request, name, bytes);
      });
    }

    function startDeck() {
      if (state.deck || !deckCraft) return;
      var host = deckCraft.createHost({
        doc: doc,
        win: window,
        parentEl: ctx.body,
        name: ctx.file.name,
        // 엔진 내장 등 행인 등 실행 에서 그림으로 (이룬다 URL 기본
        // notabs를 뺀 호스트 URL를 의한다).
        onRequestOpen: function (purpose, request) {
          if (!ctx.isCurrent()) return;
          // 숨긴: 고정 발프의 호스트 숨긴 경로로 다시 이룬다 (시트의
          // 같은 계약 등 엔진의 등 등기록 포함하지 않는다).
          if (purpose === 'open') {
            ctx.requestOpen();
          } else if (purpose === 'picture') {
            ctx.requestPicture(function (name, bytes) {
              answerDeckPick(request, name, bytes);
            });
          } else {
            requestDeckMedia(purpose, request);
          }
        },
        onPrint: function (evt) {
          if (!ctx.isCurrent()) return;
          if (!evt || !evt.bytes) {
            ctx.setStatus('인쇄를 시작하지 못했습니다');
            return;
          }
          printPdfBytes(evt.bytes);
        },
        onReady: function () {
          if (!ctx.isCurrent()) {
            stopDeck();
            return;
          }
          state.deckReady = true;
          publishQuick();
          if (isNew) {
            // 등 발프의 호스트 모두가 빈 값으로 시작한다 등 등 바이트가
            // 없고, 작 업이 없으면 버로 편집기 실행 셈이다.
            if (!ctx.isFolded()) showDeck();
            return;
          }
          ctx.fetchContent('buffer').then(function (buf) {
            if (!ctx.isCurrent() || !state.deck) return;
            if (state.deck.open(ctx.file.name, buf) && !ctx.isFolded()) showDeck();
          });
        },
        onDirty: function (dirty) {
          if (!ctx.isCurrent()) return;
          state.dirty = dirty;
          if (dirty) {
            ctx.setStatus('담리지 않은 변경이 있습니다');
            ctx.markDirty();
          } else if (ctx.isFolded() && state.surface === 'deck') {
            // 작업 등 동안 길이가 얼굴 dirty가 되다 등 미째 등 리더
            // 실행 전환은 지금 수행한다 (변경 취소 방식).
            settleToReader();
          }
        },
        onSave: function (evt) {
          if (!ctx.isCurrent()) return;
          if (!evt || !evt.bytes) {
            ctx.setStatus('처음에 실패했습니다');
            finishSaveWaiter(false);
            return;
          }
          if (!evt.presentation) {
            downloadExport(evt.name, evt.bytes);
            return;
          }
          // E-5: 확장 자가 아니다 실제 바이트 형식으로 파일 값을
          // 확정. 한다 exec엔진 file.save/file.saveBytes의 사이버로
          // 형식을 .pptx 이름으로 발행한 등 있어, 이름만 이면 등 등
          // 없는 파 .pptx일을 로. 담 린것(request-save)경로의
          // 진짜 PPTX를 등 확정 그대로 통과한다. 확정 불능(unknown)의
          // 종전 동작을 유지 (한다 아래 형식까지 않기 위해).
          var actualFormat =
            typeof evt.format === 'string'
              ? evt.format
              : deckCraft && typeof deckCraft.sniffDeckFormat === 'function'
                ? deckCraft.sniffDeckFormat(evt.bytes)
                : 'unknown';
          var expectedFormat = /\.deckcraft$/i.test(evt.name || '')
            ? 'deckcraft'
            : 'pptx';
          if (actualFormat !== 'unknown' && actualFormat !== expectedFormat) {
            ctx.setStatus('파일 형식과 확장자가 맞지 않아 저장하지 않습니다');
            finishSaveWaiter(false);
            return;
          }
          if (evt.bytes.byteLength > SAVE_LIMIT) {
            ctx.setStatus('10MB를 초과한 저장할 수 없습니다');
            finishSaveWaiter(false);
            return;
          }
          var blob = new Blob([evt.bytes], {
            type: expectedFormat === 'deckcraft' ? DECKCRAFT_NATIVE_MIME : PPTX_MIME,
          });
          var done = function (ok) {
            if (ok) state.lastSavedBytes = evt.bytes;
            finishSaveWaiter(ok);
            if (ok && ctx.isFolded() && state.surface === 'deck' && !state.dirty) {
              settleToReader();
            }
          };
          // 등 안에 다른 이름으로 저장한 경우 등 지금 내부 파일이
          // 등이면 열려진 파일이 맞지므로 다른 이름 저장 흐름으로.
          if (evt.name && ctx.file.name && evt.name !== ctx.file.name) {
            ctx.saveAsContent(blob, evt.name).then(done);
          } else {
            ctx.putContent(blob).then(done);
          }
        },
        onSaveFailed: function () {
          if (!ctx.isCurrent()) return;
          ctx.setStatus('처음에 실패했습니다');
          finishSaveWaiter(false);
        },
        onPasteImageError: function () {
          if (!ctx.isCurrent()) return;
          ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
        },
        onFallback: function () {
          if (!ctx.isCurrent()) return;
          var wasDeck = state.surface === 'deck';
          stopDeck();
          if (wasDeck) {
            showReader();
            ctx.setNote('전용 편집기를 불러오지 못해 기본 리더로 표시합니다');
          } else if (isNew) {
            ctx.showMessage('프레젠테이션 편집기를 불러오지 못했습니다');
          } else if (!ctx.chromeFold) {
            // 접근이 없는 호스트(Finder)에서는 편집기가 기본 실행이라
            // 리더로 그 이유를 알린다. 접근 호스트에서 접근 차 주요
            // 경우엔 보듯 리더를 방해하지 않는다 (PdfCraft와 같은 것).
            ctx.setNote('전용 편집기를 불러오지 못해 기본 리더로 표시합니다');
          }
        },
      });
      if (!host) return;
      state.deck = host;
      // 준비기 간까지 리더 실행 주인공이다
      host.frame.style.display = 'none';
    }

    // 접근/찾기에 실행 맞춘 (접근 호스트에서만 하나가 있다)
    function syncSurfaceToFold() {
      if (!ctx.isCurrent()) return;
      if (ctx.isFolded()) {
        if (state.surface === 'deck' && !state.dirty) settleToReader();
        // dirty인 동안 편집기 실행 유지하는 등 dirty가 등리 등
        // onDirty/onSave가 전환은 마감한다.
      } else if (state.surface === 'reader' && state.deckReady) {
        showDeck();
      }
    }
    if (ctx.chromeFold) ctx.onFoldChange(syncSurfaceToFold);

    if (ctx.saveBtn) ctx.saveBtn.hidden = true; // 시작 실행 리더 등 편집기가 패널 showDeck에 건다
    ctx.setSaveHandler(saveViaDeck);

    // 실행 삽입 붙여넣기: 등 실행 문서에서 발생한 붙여넣기를 이미지
    // 파일은 편집기 exec로 직접 읽어넣는다. 엔진 iframe의 삽입이
    // 있으면 호스트(finder-deckcraft)가 엔진 문서에서 가로채므로
    // 경로는 겹치지 않는다. 리더 실행에서는 읽어넣지 않는다.
    var onWindowPaste = function (e) {
      if (!ctx.isCurrent()) {
        window.removeEventListener('paste', onWindowPaste, true);
        return;
      }
      if (state.surface !== 'deck' || !state.deckReady || !state.deck) return;
      if (isFormFieldTarget(e && e.target)) return;
      var f = pasteImageFile(e && e.clipboardData);
      if (!f) return;
      e.preventDefault();
      if (f.size > 32 * 1024 * 1024) {
        ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
        return;
      }
      fileToBase64(f).then(
        function (b64) {
          if (!ctx.isCurrent() || !state.deck) return null;
          return state.deck.exec([
            { id: 'insert.picture', params: { name: f.name || 'clipboard.png', data: b64 } },
          ]);
        },
        function () {
          if (ctx.isCurrent()) ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
          return null;
        },
      ).then(function (results) {
        if (!results) return;
        var r = results[0];
        if (!r || !r.ok) ctx.setStatus('붙여넣기 이미지를 넣지 못했습니다');
      });
    };
    window.addEventListener('paste', onWindowPaste, true);

    // 편집기는 안에 전용이 온 ready등 가 showDeck오면 실행 교체한다.
    startDeck();

    if (isNew) {
      ctx.setNote('등 프레젠테이션 등 저장할 등 위치의 이름을 정합한다');
      return Promise.resolve();
    }
    ctx.setNote(READER_NOTE);
    return ctx.fetchContent('buffer').then(function (buf) {
      if (!ctx.isCurrent()) return;
      return renderReader(ctx, readerWrap, buf);
    });
  }

  // DeckCraft 자체리본 자체 너비를 코어 플로우 에러리스트 접근(찾기
  // 판독)를 리본 전에 겹치지 않게 (사용 지정 2026-11-03: PPT에서
  // 접근 찾기 버튼을. 불필요하게 찾기 차 마크고, 편집기가 유일
  // 실행이라 엔진 로드 실패 등 대관 으로만 이룬다).
  handlePptx.ownsChrome = true;
  core.registerFormat('pptx', handlePptx);

  // 저 장 할 파 일 (이 름을, 입력 하 세요)
  var session = null;

  var api = {
    handlePptx: handlePptx,
    extractPptxSlides: extractPptxSlides,
    extractSlideParagraphs: extractSlideParagraphs,
    sortSlideNames: sortSlideNames,
    findMatchKey: findMatchKey,
    nextFindMatch: nextFindMatch,
    buildFindNavCommands: buildFindNavCommands,
    buildFindFallbackCommands: buildFindFallbackCommands,
    mapInspectSlide: mapInspectSlide,
    expandSlideCommands: expandSlideCommands,
    foldSlideResults: foldSlideResults,
    verifySlideApply: verifySlideApply,
    pasteImageFile: pasteImageFile,
    isFormFieldTarget: isFormFieldTarget,
    getSession: function () {
      return session && session.ctx.isCurrent() ? session : null;
    },
  };
  if (typeof window !== 'undefined') window.MyHubFinderFormatSlide = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
