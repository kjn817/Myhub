// 오 피스 (office-assistant.js) 비서 등 AI 전체의
//
// 구조 (서브차트 등 숨긴 2단계, 2026-11-06): 세션 코어의 화면 슬라이더를
// 분리한다. 코어(createCore)지정 실행 메모로 만들기 초기화/발송인
// 데이터 흐름만 갖고, 결과는 emit 로만(say/findings/busy)내보 낸다.
// 드라이브가 등 가진다.
//   - 로컬 드라이브: 단독 페이지(window.parent === window)에서만 붙는
//     종전 전체 UI (#officeAssistant 단락 + 버튼 뷰어 + 플 로우
//     버튼). 등창 안에 있는 등 단락이 그 않는다.
//   - 브리지 드라이브: 등창 안에 있는 영역(myhub:assistant-declare,
//     flavor 'office')를 게시하고, 이 서브차트 단락이 보낸 명령
//     (myhub:assistant-office)를 코어로 실행한 결과를 알려준다. 메일
//     본인 선택한 등 창 안에만 온다 (새로 내보내지 않는다).
// 지정 등 서버(/api/ai/office) 검증한 연산 등 형식 세션 대변 으로
// 편집기에 적용한 등 결과를 정확하게 표시. 메모로 만들기(조회 규칙인
// 서버 ai-access 경계), 메일(초대 게이트 등 발송인 서버
// 본인 선택한 있어만 실행한다)를 여기서 시작한다.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var root = document.getElementById('officeAssistant');
  if (!root || !window.MyHubOffice) return;
  // Drive 파일 API 베이스 경로 (S5-4, 5-9) — constants.js 선행 로드.
  // 조기 반환 뒤에 둔다: 오피스 페이지가 아니면 조용히 나가는 기존 동작 유지.
  var constants =
    (typeof window !== 'undefined' && window.MyHubConstants) ||
    (typeof globalThis !== 'undefined' && globalThis.MyHubConstants) ||
    null;
  if (!constants) throw new Error('[office-assistant.js] constants.js가 먼저 로드되어야 합니다');
  var appKey = window.MyHubOffice.parseAppKey(window.location.search);
  var kind =
    appKey === 'excel'
      ? 'excel'
      : appKey === 'hangul'
        ? 'hangul'
        : appKey === 'pdf'
          ? 'pdf'
          : appKey === 'powerpoint'
            ? 'slide'
            : null;
  if (!kind) {
    // 담을한 형식 세션이 없는 등 등 비서를 붙이지 않고, 상단바
    // 진 행한 버튼과 함께 (치수는 클릭 등 없는 버튼 금지)
    var orphanBtn = document.getElementById('officeAssistantBtn');
    if (orphanBtn && orphanBtn.parentNode) orphanBtn.parentNode.removeChild(orphanBtn);
    return;
  }

  var doc = document;
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () {
        return null;
      }).then(function (json) {
        return { status: res.status, json: json };
      });
    });
  }
  function getJson(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (res) {
      return res.json();
    });
  }

  // 오피스 세션 코어 구분선
  // emit = { say(text), findings(list), busy(on, label) } 의 드라이브가
  // 가져와서 출력 아래이다. 코어는 DOM를 직접 맞지 않는다.
  function createCore() {
    var emit = {
      say: function () {},
      findings: function () {},
      busy: function () {},
    };
    var busyFlag = false;
    var mailDraft = null;

    function officeApp() {
      return window.MyHubOfficeApp || null;
    }
    function currentFile() {
      var inst = officeApp();
      var cur = inst && inst.getCurrent ? inst.getCurrent() : null;
      if (!cur) return null;
      // office.js에서 current를 보면 객체 {fileId, name, isNew} (fileId 0 = 새 문서)
      return { fileId: cur.fileId ? cur.fileId : null, name: cur.name || '' };
    }
    function getSession() {
      if (kind === 'excel') {
        return window.MyHubFinderFormatSheet ? window.MyHubFinderFormatSheet.getSession() : null;
      }
      if (kind === 'hangul') {
        return window.MyHubFinderFormatHwp && window.MyHubFinderFormatHwp.getSession
          ? window.MyHubFinderFormatHwp.getSession()
          : null;
      }
      if (kind === 'slide') {
        return window.MyHubFinderFormatSlide && window.MyHubFinderFormatSlide.getSession
          ? window.MyHubFinderFormatSlide.getSession()
          : null;
      }
      return window.MyHubFinderFormatPdf && window.MyHubFinderFormatPdf.getSession
        ? window.MyHubFinderFormatPdf.getSession()
        : null;
    }
    function collectSnapshot(session) {
      if (kind === 'excel' || kind === 'slide') return session.snapshot();
      if (kind === 'hangul') return session.readText();
      return Promise.resolve(session.getState ? session.getState() : null);
    }
    function setBusy(on, label) {
      busyFlag = on;
      emit.busy(on, label);
    }
    // 서버가 1차로 연산 블록을 측에서 분리하지만, 어떤 경로로든
    // 다시 마커가 측을 이면 사용자에게 보이지 않게 지는 이쪽
    // 방어. 완성 블록을 핵심으로 가지고, 닫히지 않는 블록은 오는
    // 마커 부분 끝까지 (않으면 연산 블록 계약 측에만 온다).
    var OPS_MARKER_RE = /\[\s*\/?\s*OFFICE_OPS\s*\]/i;
    function stripOpsResidue(text) {
      var out = String(text || '').replace(/\[OFFICE_OPS\][\s\S]*?\[\/OFFICE_OPS\]/gi, '');
      for (var i = 0; i < 4; i++) {
        var m = OPS_MARKER_RE.exec(out);
        if (!m) break;
        if (m[0].indexOf('/') >= 0) {
          out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
        } else {
          out = out.slice(0, m.index);
          break;
        }
      }
      return out.trim();
    }
    function applyReportText(result, fallbackMsg) {
      if (!result) return fallbackMsg || '적용 결과를 받지 못했어요.';
      var errs = result.errors || [];
      if (errs.length === 0) return '연산 ' + result.applied + '개를 적용했어요.';
      var first = errs[0] && errs[0].message ? errs[0].message : '알 수 없는 오류';
      return '연산 ' + result.applied + '개 적용, ' + errs.length + '개 실패했어요. (첫 실패: ' + first + ')';
    }
    function reportApply(result, fallbackMsg) {
      emit.say(applyReportText(result, fallbackMsg));
    }

    function runInstruction(instruction) {
      instruction = String(instruction || '').trim();
      if (!instruction || busyFlag) return Promise.resolve(false);
      var session = getSession();
      if (!session) {
        emit.say('먼저 문서를 열어 주세요. 문서가 열려 있어야 비서가 고칠 수 있어요.');
        return Promise.resolve(false);
      }
      var file = currentFile();
      setBusy(true, '비서가 작업 중이에요');
      emit.say('');
      emit.findings([]);
      var snapshotCapped = false;
      var replyText = '';
      // 결함 수정 (2026-11-09 재건 중 발견): collectSnapshot이 동기적으로
      // 던지면(세션 배선 결함 등) .catch에 닿지 못해 busy가 영원히 풀리지
      // 않았다. Promise.resolve() 경유로 동기 throw도 null로 접는다.
      return Promise.resolve()
        .then(function () {
          return collectSnapshot(session);
        })
        .catch(function () {
          return null;
        })
        .then(function (snapshot) {
          // E-4 고정: 시트 열람 엔진 캡(120행30열)을 우측하면 비서가
          // 본 범위가 전체가 아니란 사용자에게 결정적으로 알린다 (모델
          // 측만 마감지 않는다). 브리지 표시가 정한, 없으면 모양 확정.
          if (kind === 'excel' && snapshot && Array.isArray(snapshot.cells)) {
            snapshotCapped =
              snapshot.rowsCapped === true ||
              snapshot.colsCapped === true ||
              snapshot.cells.length >= 120 ||
              snapshot.cells.some(function (row) {
                return Array.isArray(row) && row.length >= 30;
              });
          }
          return postJson('/api/ai/office/instruct', {
            app: kind,
            fileName: file ? file.name : '',
            instruction: instruction,
            snapshot: snapshot || undefined,
          });
        })
        .then(function (r) {
          if (!r.json || !r.json.ok) {
            emit.say('비서 응답이 실패했어요. (' + ((r.json && r.json.error) || r.status) + ')');
            return null;
          }
          var rawReply = String(r.json.reply || '');
          var markerResidue = OPS_MARKER_RE.test(rawReply);
          replyText =
            stripOpsResidue(rawReply) +
            (snapshotCapped
              ? '\n\n비서는 현재 이 시트의 처음 120행 열까지만 30보고 답했어요 그. 범위 밖의 전체 데이터는 반영하지 않았습니다.'
              : '');
          emit.say(replyText);
          emit.findings(r.json.findings);
          if (!(r.json.ops && r.json.ops.length)) {
            // 모델의 변경을 시도하지마(검증에서 전부 단어조각 연산
            // 블록을 끊거나) 적용한 연산은 하나가 없는 등 성공 순서만
            // 남기면 거짓 성공을 남으로 실패를 먼저 보고한다.
            var serverErrors = Array.isArray(r.json.validationErrors) ? r.json.validationErrors : [];
            if (serverErrors.length || markerResidue) {
              var reason = serverErrors.length ? String(serverErrors[0]) : '연산 블록을 읽지 못했어요';
              emit.say(
                '요청한 변경을 적용하지 못했어요. (' + reason + ')' +
                  (replyText
                    ? '\n\n(비서 답변이 적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요)\n' + replyText
                    : ''),
              );
            }
            return null;
          }
          return session.applyOps(r.json.ops).then(function (result) {
            // 적용 보고 합성 (say의 마지막 노출한 화면이 차이므로
            // 합성본으로 다시 본다):
            // - 전부 성공: 종전 으로 비서 측에 보고를 이어 붙인.
            // - 실패가 앞으면 순서를 바꾼. 비서 측을 적용 전에
            //   과인 순서라 "있어"라고 말해줘 실제로는 등 의 등
            //   있다 등 실패 보고를 먼저 숨기고, 측을 적용 등 순서를
            //   밝힌 안에 붙으면 성공으로 확인하지 않는다 (운영에서
            //   "추가했어요" 안에 실패가 붙은 쏘인 거짓 성공 방어,
            //   2026-11-07).
            var report = applyReportText(result);
            var failed = !!(result && result.errors && result.errors.length);
            if (failed) {
              emit.say(
                report +
                  (replyText
                    ? '\n\n(비서 답변이 적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요)\n' + replyText
                    : ''),
              );
            } else {
              emit.say(replyText ? replyText + '\n' + report : report);
            }
          });
        })
        .catch(function () {
          emit.say('서버와 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
        })
        .then(function () {
          setBusy(false);
          return true;
        });
    }

    // 파일 메일 데이터 (기반) 파일
    function listMemos(q) {
      return getJson('/api/ai/office/memos?q=' + encodeURIComponent(q || '')).then(function (json) {
        return (json && json.memos) || [];
      });
    }
    function waitSession(prev, timeoutMs) {
      var started = Date.now();
      return new Promise(function (resolve) {
        (function tick() {
          var s = getSession();
          if (s && s !== prev) {
            resolve(s);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            resolve(s);
            return;
          }
          setTimeout(tick, 250);
        })();
      });
    }
    // 편집기가 실제로 답하는지 열람 정보로 증명한다 (시트 전용 등
    // readText/getState만 있는 세션의 바이트 경로인 준비 확인이 필요 없다).
    function waitEditorReady(session, timeoutMs) {
      if (!session || typeof session.snapshot !== 'function') return Promise.resolve(true);
      var started = Date.now();
      return new Promise(function (resolve) {
        (function tick() {
          session.snapshot().then(
            function () {
              resolve(true);
            },
            function () {
              if (Date.now() - started > timeoutMs) resolve(false);
              else setTimeout(tick, 700);
            },
          );
        })();
      });
    }
    // 동적 로딩 URL과 공용 헬퍼(asset-url.js)가 배포 버전을 붙인다
    // (N-06 등 버전 없는 URL과 immutable 캐시를 고정할 등 있다).
    // 헬퍼가 없는 환경(테스트 등)에서는 원본 URL 그림이다.
    function versionedAssetUrl(url) {
      var h = typeof window !== 'undefined' ? window.MyHubAssetUrl : null;
      return typeof h === 'function' ? h(url) : url;
    }
    // kordoc 지연 로딩 (뷰어 코어 loadLib와 같은 방식 등 무거운 번호이라
    // 공문서 생성 지정만 불러온다). 실패는 캐시하지 않는다.
    var kordocReady = null;
    function loadKordocGen() {
      if (kordocReady) return kordocReady;
      var p = import(versionedAssetUrl('/vendor/kordoc/kordoc.js'))
        .then(function () {
          var mod = typeof window !== 'undefined' ? window.__kordoc : undefined;
          if (!mod || typeof mod.markdownToHwpx !== 'function') {
            throw new Error('kordoc 생성 모듈 형태가 올바르지 않습니다');
          }
          return mod;
        })
        .catch(function (err) {
          if (kordocReady === p) kordocReady = null;
          throw err;
        });
      kordocReady = p;
      return p;
    }
    function todayLabel() {
      var d = new Date();
      function p2(n) { return (n < 10 ? '0' : '') + n; }
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    }

    // 한글 전용 1차 경로: 서버가 조회 경계를 지정한 구조화한 마크다운
    // 브라 kordoc우저 가(공문서 보고서) HWPX로 조립한 Drive에
    // 저장하고 버로 건다. 어느 단계가 실패하면 기존 ops 경로로 대변한다
    // (노트 catch에서 createFromMemoViaOps로 넘긴다).
    // hooks.closePanel의 로컬 드라이브 서브 패널 닫기(선택)등.
    function createFromMemoDoc(memoId, inst, hooks) {
      return postJson('/api/ai/office/from-memo-doc', { memoId: memoId }).then(function (r) {
        if (!r.json || !r.json.ok || !r.json.markdown) {
          throw new Error((r.json && r.json.error) || 'doc_failed');
        }
        var title = r.json.title || '문서';
        return loadKordocGen()
          .then(function (kordoc) {
            return kordoc.markdownToHwpx(r.json.markdown, { gongmun: { preset: '보고서' } });
          })
          .then(function (bytes) {
            var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            if (!u8.length || u8[0] !== 0x50 || u8[1] !== 0x4b) {
              throw new Error('생성한 문서 형식이 올바르지 않습니다');
            }
            var filename = title + ' ' + todayLabel() + '.hwpx';
            var form = new FormData();
            form.append('files', new File([u8], filename, { type: 'application/hwp+zip' }));
            return fetch(constants.DRIVE_FILES_API, { method: 'POST', body: form })
              .then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
              .then(function (up) {
                var saved = up.json && up.json.files && up.json.files[0];
                if (!up.res.ok || !saved || !saved.id) throw new Error('upload_failed');
                if (hooks && hooks.closePanel) hooks.closePanel();
                return Promise.resolve(
                  inst.openFile({ fileId: saved.id, name: saved.filename || filename, mime: 'application/hwp+zip', version: null }),
                ).then(function () {
                  emit.say('"' + title + '" 메모로 공문서를 만들어 저장했어요. (파일: ' + (saved.filename || filename) + ')');
                });
              });
          });
      });
    }
    function createFromMemoViaOps(memoId, inst, hooks) {
      return postJson('/api/ai/office/from-memo', { memoId: memoId, target: kind })
        .then(function (r) {
          if (!r.json || !r.json.ok) {
            emit.say('문서를 만들지 못했어요. (' + ((r.json && r.json.error) || r.status) + ')');
            return null;
          }
          var prev = getSession();
          if (hooks && hooks.closePanel) hooks.closePanel();
          return Promise.resolve(inst.newDocument()).then(function () {
            return waitSession(prev, 15000);
          }).then(function (session) {
            if (!session) {
              emit.say('이문서를 닫으면 편집기 연결이 끊겨 어떤 내용을 넣지 못했어요.');
              return null;
            }
            // 이 문서를 편집기(iframe)의 마지막 직후 아직 넣지 못할 등 있다 등
            // 연산 메시지의 리스너 없으면 유실하므로, 열람 정보는 성공한
            // 때까지 기다린 준비 증명에 안에 연산을 보낸다.
            return waitEditorReady(session, 25000).then(function (ready) {
              if (!ready) {
                emit.say('이 문서를 닫으면 편집 기가 준비되지 않아 내용을 넣지 못했어요.');
                return null;
              }
              return session.applyOps(r.json.ops || []).then(function (result) {
                if (result && result.applied > 0) {
                  emit.say(
                    '"' + (r.json.title || '메모') + '" 메모로 문서를 만들었어요. 연산 ' +
                      result.applied + '개를 적용했어요, 저장(Ctrl+S)단축키 등 위치의 이름을 정하세요.' +
                      (result.errors && result.errors.length
                        ? ' (실패 ' + result.errors.length + '개: ' + result.errors[0].message + ')'
                        : ''),
                  );
                } else {
                  reportApply(result, '이 문서를 더는 내용을 넣지 못했어요.');
                }
              });
            });
          });
        })
        .catch(function () {
          emit.say('문서 생성이 실패했어요.');
        });
    }
    function createFromMemo(memoId, hooks) {
      if (busyFlag) return Promise.resolve(false);
      var inst = officeApp();
      if (!inst) return Promise.resolve(false);
      setBusy(true, '메모로 문서를 만드는 중이에요');
      var first = kind === 'hangul' && typeof inst.openFile === 'function'
        ? createFromMemoDoc(memoId, inst, hooks).catch(function () { return createFromMemoViaOps(memoId, inst, hooks); })
        : createFromMemoViaOps(memoId, inst, hooks);
      return first.then(function () {
        setBusy(false);
        return true;
      });
    }

    // 초대 메일 (초대 등 본인 등 발송, 데이터) 파일
    // 초안 응답이 본인 선택한 코어 안에만 보고한다 등 드라이브(등 단락
    // 포함는)제목 본문만 보낸다.
    function draftMail(to, instruction) {
      var file = currentFile();
      if (!file || !file.fileId) {
        return Promise.reject(new Error('메일로 보내려면 먼저 열린 문서를 열어 주세요.'));
      }
      if (busyFlag) return Promise.reject(new Error('다른 작업이 진행 중이에요.'));
      setBusy(true, '초안을 고르는 중이에요');
      return postJson('/api/ai/office/mail/draft', {
        to: to,
        fileId: file.fileId,
        instruction: instruction || undefined,
      })
        .then(function (r) {
          if (!r.json || !r.json.ok) {
            throw new Error('초안을 만들지 못했어요. (' + ((r.json && r.json.error) || r.status) + ')');
          }
          mailDraft = { draft: r.json.draft, token: r.json.token, fileId: file.fileId };
          return { subject: r.json.draft.subject, body: r.json.draft.body };
        })
        .then(function (out) {
          setBusy(false);
          return out;
        })
        .catch(function (e) {
          setBusy(false);
          throw e;
        });
    }
    function sendMail() {
      if (!mailDraft || busyFlag) {
        return Promise.resolve({ ok: false, message: '발송할 초안이 없어요.' });
      }
      setBusy(true, '발송 중이에요');
      var held = mailDraft;
      return postJson('/api/ai/office/mail/send', {
        draft: held.draft,
        fileId: held.fileId,
        token: held.token,
        confirm: true,
      })
        .then(function (r2) {
          if (r2.json && r2.json.ok) {
            mailDraft = null;
            return { ok: true, message: '메일을 보냈어요. (전용 계정에서 발송)' };
          }
          return { ok: false, message: '발송하지 못했습니다: ' + ((r2.json && r2.json.error) || r2.status) };
        })
        .catch(function () {
          return { ok: false, message: '발송 중 연결이 끊겼어요.' };
        })
        .then(function (out) {
          setBusy(false);
          return out;
        });
    }

    return {
      kind: kind,
      setEmit: function (next) { emit = next || emit; },
      isBusy: function () { return busyFlag; },
      currentFile: currentFile,
      hasSession: function () { return !!getSession(); },
      runInstruction: runInstruction,
      listMemos: listMemos,
      createFromMemo: createFromMemo,
      draftMail: draftMail,
      sendMail: sendMail,
    };
  }

  var core = createCore();
  window.MyHubOfficeAssistantCore = core;

  // 오피스 브리지 드라이브 (등창 등 패널) 구분선
  if (window.parent !== window) {
    var origin = window.location.origin;
    function declare() {
      try {
        window.parent.postMessage(
          {
            type: 'myhub:assistant-declare',
            personaId: 'builder',
            personaName: '노바',
            avatar: '/avatars/nova-128.webp',
            flavor: 'office',
          },
          origin,
        );
      } catch (e) {
        console.warn('오피스 비서 선언 전송 실패:', e);
      }
    }
    function respond(reqId, payload) {
      var msg = { type: 'myhub:assistant-office-result', reqId: reqId };
      Object.keys(payload || {}).forEach(function (k) { msg[k] = payload[k]; });
      try {
        window.parent.postMessage(msg, origin);
      } catch (e) {
        console.warn('오피스 비서 결과 파싱 실패:', e);
      }
    }
    // 명령 1건 say/findings를 모아 결과로 알려주는 수집 emit.
    // say는 로컬 단락이 측 영역과 같은 남으로 등 마지막 노출한 온다.
    function collectingEmit(store) {
      return {
        say: function (t) { if (t) store.reply = String(t); },
        findings: function (list) { store.findings = list || []; },
        busy: function () {},
      };
    }
    window.addEventListener('message', function (e) {
      if (!e || e.origin !== origin) return;
      var d = e.data;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'myhub:assistant-hello') {
        declare();
        return;
      }
      if (d.type !== 'myhub:assistant-office' || !d.reqId) return;
      var store = { reply: '', findings: [] };
      if (d.cmd === 'instruct') {
        core.setEmit(collectingEmit(store));
        core.runInstruction(d.text || '').then(function () {
          respond(d.reqId, { ok: true, reply: store.reply, findings: store.findings });
        });
      } else if (d.cmd === 'memo-list') {
        core.listMemos(d.q || '').then(
          function (memos) {
            respond(d.reqId, {
              ok: true,
              memos: memos.map(function (m) { return { id: m.id, title: m.title || '' }; }),
            });
          },
          function () { respond(d.reqId, { ok: false, error: '메모를 불러오지 못했습니다.' }); },
        );
      } else if (d.cmd === 'memo-create') {
        core.setEmit(collectingEmit(store));
        core.createFromMemo(d.memoId).then(function () {
          respond(d.reqId, { ok: true, reply: store.reply });
        });
      } else if (d.cmd === 'mail-draft') {
        core.draftMail(String(d.to || ''), String(d.instruction || '')).then(
          function (draft) { respond(d.reqId, { ok: true, draft: draft }); },
          function (err) {
            respond(d.reqId, { ok: false, error: err && err.message ? err.message : '초안 생성이 실패했어요.' });
          },
        );
      } else if (d.cmd === 'mail-send') {
        core.sendMail().then(function (out) {
          respond(d.reqId, { ok: out.ok, message: out.message });
        });
      }
    });
    declare();
    return;
  }

  // 오피스 로컬 드라이브 (단독 페이지 전용 단락 UI) 구분선
  var title = el('span', 'oa-title', '노바 비서');
  var stateEl = el('span', 'oa-state', '');
  var head = el('div', 'oa-head');
  head.appendChild(title);
  head.appendChild(stateEl);
  var replyEl = el('div', 'oa-reply');
  replyEl.setAttribute('aria-live', 'polite');
  var findingsEl = el('ul', 'oa-findings');
  var input = el('input', 'oa-input');
  input.type = 'text';
  input.placeholder =
    kind === 'excel'
      ? '예: B2에 =SUM(B3:B9) 넣고 서식 만들어줘'
      : kind === 'hangul'
        ? '예: 첫 문단 아래 표의 너비 넣어줘'
        : kind === 'slide'
          ? '예: 모든 슬라이드에서 12%를 15%로 바꿔줘'
          : '예: 2페이지를 알려줘';
  var sendBtn = el('button', 'oa-btn oa-send', '질문하기');
  sendBtn.type = 'button';
  var memoBtn = el('button', 'oa-btn', '메모로 만들기');
  memoBtn.type = 'button';
  var mailBtn = el('button', 'oa-btn', '메일로 보내기');
  mailBtn.type = 'button';
  // 슬라이드 메모 생성이 아직 없다 (서버 from-memo target에서
  // excel/hangul만 받는) 등 만들 등 없는 버튼은 보이지 않게 한다.
  if (kind === 'slide') memoBtn.hidden = true;
  var row = el('div', 'oa-row');
  row.appendChild(input);
  row.appendChild(sendBtn);
  row.appendChild(memoBtn);
  row.appendChild(mailBtn);
  var panel = el('div', 'oa-panel');
  panel.hidden = true;
  root.appendChild(head);
  root.appendChild(replyEl);
  root.appendChild(findingsEl);
  root.appendChild(row);
  root.appendChild(panel);

  core.setEmit({
    say: function (text) { replyEl.textContent = text || ''; },
    findings: function (findings) {
      findingsEl.textContent = '';
      (findings || []).forEach(function (f) {
        var li = el('li', 'oa-finding oa-finding-' + (f.severity || 'info'), f.message);
        findingsEl.appendChild(li);
      });
    },
    busy: function (on, label) {
      sendBtn.disabled = on;
      memoBtn.disabled = on;
      mailBtn.disabled = on;
      stateEl.textContent = on ? label || '작업 중' : '';
    },
  });

  // 상단바 진입은: 단락이 기본 접근 넣고, 버튼은 화면 상단바
  // 아래로 완전히면 입력칸에 삽입이 간다.
  function togglePanel() {
    root.hidden = !root.hidden;
    var btn = doc.getElementById('officeAssistantBtn');
    if (btn) btn.setAttribute('aria-expanded', root.hidden ? 'false' : 'true');
    if (!root.hidden) {
      try {
        input.focus();
      } catch (e) {
        console.warn('비서 입력 삽입 실패:', e);
      }
    }
  }
  var toggleBtn = doc.getElementById('officeAssistantBtn');
  if (toggleBtn) {
    root.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.addEventListener('click', togglePanel);
  }
  // 내비 실행 대관: 문서가 이름 뷰어(fixed전체 화면)가 g-nav를
  // 어떤 상단바 버튼은 우측 등 없는 등 뷰어가 이름 있는 동안만
  // 포함해 작은 플로우 진입 버튼은 전용인 (등안에 있는 등 최이다).
  var viewerRoot = doc.getElementById('finderViewer');
  var floatBtn = el('button', 'office-assistant-float');
  floatBtn.type = 'button';
  floatBtn.setAttribute('aria-label', '노바 비서');
  floatBtn.innerHTML = '<img src="/avatars/nova-128.webp" alt="노바">';
  floatBtn.hidden = true;
  floatBtn.addEventListener('click', togglePanel);
  doc.body.appendChild(floatBtn);
  var syncFloat = function () {
    floatBtn.hidden = !viewerRoot || viewerRoot.hidden;
  };
  if (viewerRoot && typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncFloat).observe(viewerRoot, {
      attributes: true,
      attributeFilter: ['hidden'],
    });
  }
  syncFloat();
  if (window.lucide) window.lucide.createIcons();

  sendBtn.addEventListener('click', function () {
    core.runInstruction(input.value);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') core.runInstruction(input.value);
  });

  // 로컬 메모로 만들기 (로컬 패널) 파일
  function closePanel() {
    panel.hidden = true;
    panel.textContent = '';
  }
  function renderMemoPanel() {
    panel.hidden = false;
    panel.textContent = '';
    var search = el('input', 'oa-input');
    search.type = 'text';
    search.placeholder = '메모 검색 (비우면 최근 메모)';
    var list = el('div', 'oa-memo-list');
    panel.appendChild(search);
    panel.appendChild(list);
    function load(q) {
      list.textContent = '불러오는 중';
      core.listMemos(q)
        .then(function (memos) {
          list.textContent = '';
          if (!memos.length) {
            list.appendChild(el('div', 'oa-empty', '메모가 없어요. (잠긴 메모는 비서에게 보이지 않아요)'));
            return;
          }
          memos.forEach(function (m) {
            var item = el('button', 'oa-memo-item', m.title || '(제목 없음)');
            item.type = 'button';
            item.addEventListener('click', function () {
              core.createFromMemo(m.id, { closePanel: closePanel });
            });
            list.appendChild(item);
          });
        })
        .catch(function () {
          list.textContent = '메모를 불러오지 못했습니다.';
        });
    }
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        load(search.value.trim());
      }, 300);
    });
    load('');
    search.focus();
  }
  memoBtn.addEventListener('click', function () {
    if (panel.hidden) renderMemoPanel();
    else closePanel();
  });

  // 로컬 메일 (로컬 패널: 초대 등 본인 등 발송) 파일
  function renderMailPanel() {
    var file = core.currentFile();
    panel.hidden = false;
    panel.textContent = '';
    if (!file || !file.fileId) {
      panel.appendChild(el('div', 'oa-empty', '메일로 보내려면 먼저 열린 문서를 열어 주세요.'));
      return;
    }
    var to = el('input', 'oa-input');
    to.type = 'email';
    to.placeholder = '받는 사람 이메일';
    var hint = el('input', 'oa-input');
    hint.type = 'text';
    hint.placeholder = '본문을 참고할 내용 (선택 사항 메모의: 내용 대로 안내해줘)';
    var draftBtn = el('button', 'oa-btn', '초안 만들기');
    draftBtn.type = 'button';
    var view = el('div', 'oa-mail-view');
    panel.appendChild(to);
    panel.appendChild(hint);
    panel.appendChild(draftBtn);
    panel.appendChild(view);
    draftBtn.addEventListener('click', function () {
      var addr = to.value.trim();
      if (!addr) {
        view.textContent = '받는 사람을 입력해 주세요.';
        return;
      }
      core.draftMail(addr, hint.value.trim())
        .then(function (draft) {
          view.textContent = '';
          view.appendChild(el('div', 'oa-mail-line', '제목: ' + draft.subject));
          view.appendChild(el('div', 'oa-mail-body', draft.body));
          var send = el('button', 'oa-btn oa-send', '확인하고 발송');
          send.type = 'button';
          send.addEventListener('click', function () {
            if (core.isBusy()) return;
            core.sendMail().then(function (out) {
              view.textContent = out.message;
            });
          });
          view.appendChild(send);
        })
        .catch(function (err) {
          view.textContent = err && err.message ? err.message : '메일발송이 실패했어요 다시시도해주세요.';
        });
    });
  }
  mailBtn.addEventListener('click', function () {
    if (panel.hidden) renderMailPanel();
    else closePanel();
  });
})();
