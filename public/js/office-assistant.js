/* MyHub 오피스 비서 — 노바 패널 + instruct 파이프라인 (원본 설계 복원).
 *
 * 정본 복원 (일일 기록 2026-11-02~03 + 운영 번들 서버 계약 이중 대조):
 * 이 모듈이 #officeAssistantBtn(노바 아바타 버튼)과 패널을 소유한다. 셸
 * (windows.js)이 이 버튼을 상단바 AI 슬롯에 프록시한다.
 *
 * 대화 흐름은 범용 채팅이 아니다: 지시 → 세션 스냅샷(office-sessions.js) →
 * POST /api/ai/office/instruct {app, fileName, instruction, snapshot} →
 * 서버가 {reply, ops, validationErrors}를 돌려주면 세션이 확인된 연산자
 * 문법(ops)만 문서에 적용한다. 결과 합성은 실패를 먼저 보여주고(연산별
 * 실패 + 서버 validationErrors), 실패가 하나라도 있으면 답변 아래에
 * "적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요"를 고지한다
 * (D-36/D-38 정본). reply는 적용 전에 쓰인 글이라 실패를 숨기면 안 된다.
 *
 * '메모로 만들기': /api/ai/office/memos에서 고른 메모를 문서로 만든다.
 * - excel: /from-memo ops 경로 (새 문서를 열고 ops 적용)
 * - hangul: /from-memo-doc 마크다운 → kordoc markdownToHwpx 바이트 경로가
 *   1차 (엔진 ops 왕복보다 결정적 — D-35 정본)
 * - slide·pdf: 버튼 자체를 숨긴다 (원본 기록: 슬라이드는 메모 변환 없음).
 *
 * 노출: window.MyHubOfficeAssistant { attach, composeResult }
 */
(function () {
  'use strict';

  var KIND_BY_APP = { excel: 'excel', hangul: 'hangul', pdf: 'pdf', powerpoint: 'slide' };

  var EXAMPLES = {
    excel: ['합계 열을 추가해줘', '1행을 굵게 해줘', '금액 큰 순으로 정렬해줘'],
    hangul: ['맨 아래에 총무팀 문단을 추가해줘', "'검토 요망'을 '검토 완료'로 바꿔줘"],
    pdf: ['2페이지를 회전해줘', '1페이지를 삭제해줘', '1쪽에 검토 완료 표시를 넣어줘'],
    slide: ["제목을 '분기 보고'로 바꿔줘", '새 슬라이드를 추가해줘'],
  };

  var OP_LABELS = {
    set_cell: '셀 입력', set_formula: '수식 입력', fill_range: '범위 채우기',
    insert_rows: '행 삽입', insert_cols: '열 삽입', delete_rows: '행 삭제', delete_cols: '열 삭제',
    set_style: '서식', set_col_width: '열 너비', rename_sheet: '시트 이름',
    add_sheet: '시트 추가', delete_sheet: '시트 삭제', merge_cells: '셀 병합',
    sort_range: '정렬', set_freeze: '틀 고정', set_number_format: '표시 형식',
    append_paragraphs: '문단 추가', replace_text: '텍스트 바꾸기', insert_table: '표 삽입',
    rotate_page: '페이지 회전', delete_page: '페이지 삭제', extract_pages: '페이지 추출',
    overlay_text: '텍스트 덧쓰기',
    'slide.new': '슬라이드 추가', 'text.set': '텍스트 설정', 'text.replace': '텍스트 바꾸기',
    'insert.textBox': '텍스트 상자 삽입',
  };

  function opLabel(op) {
    if (!op) return '연산';
    var key = op.type || op.id || '';
    return OP_LABELS[key] || key || '연산';
  }

  /**
   * 결과 합성 (순수 함수 — 테스트 대상). 실패가 먼저, 그 다음 답변, 실패가
   * 있으면 끝에는 "적용 전 작성" 고지. validationErrors도 실패로 표면화한다.
   */
  function composeResult(data, results) {
    data = data || {};
    results = results || [];
    var failed = results.filter(function (r) { return !r.ok; });
    var applied = results.length - failed.length;
    var validationErrors = Array.isArray(data.validationErrors) ? data.validationErrors : [];
    var lines = [];
    if (failed.length || validationErrors.length) {
      lines.push('적용하지 못한 항목이 있어요:');
      validationErrors.forEach(function (e) { lines.push('- ' + e); });
      failed.forEach(function (f) {
        lines.push('- ' + opLabel(f.op) + (f.error ? ': ' + f.error : ''));
      });
      if (applied > 0) lines.push('(' + applied + '개 연산은 적용했어요)');
    }
    if (data.reply) lines.push(data.reply);
    if ((failed.length || validationErrors.length) && data.reply) {
      lines.push('※ 위 답변은 적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요.');
    }
    if (!lines.length) lines.push(applied > 0 ? '적용했어요.' : '처리했어요.');
    return lines.join('\n');
  }

  function attach(opts) {
    var host = opts.host;         // office.js 상태 접근자 모음
    var session = opts.session;   // office-sessions 세션 (없으면 안내만)
    var state = host.getState();
    var kind = KIND_BY_APP[state.app] || null;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'officeAssistantBtn';
    btn.className = 'g-icon-btn';
    btn.title = '노바에게 문서 작업 시키기';
    btn.setAttribute('aria-label', '노바 비서 열기');
    btn.innerHTML = '<img class="aw-avatar-img" src="/avatars/nova.webp" alt="">';
    var nav = document.querySelector('.g-nav');
    if (nav) nav.appendChild(btn);

    var panel = document.createElement('section');
    panel.id = 'oaPanel';
    panel.className = 'oa-panel';
    panel.setAttribute('aria-label', '노바 문서 비서');
    panel.innerHTML =
      '<div class="oa-head">' +
        '<img class="aw-avatar-img" src="/avatars/nova.webp" alt="">' +
        '<div class="oa-head-text"><strong>노바</strong><span>문서 비서</span></div>' +
        '<button type="button" class="oa-close" aria-label="닫기">×</button>' +
      '</div>' +
      '<div class="oa-msgs" id="oaMsgs"></div>' +
      '<div class="oa-memo-list" id="oaMemoList" hidden></div>' +
      '<div class="oa-foot">' +
        (kind === 'excel' || kind === 'hangul'
          ? '<button type="button" class="oa-memo-btn" id="oaMemoBtn">메모로 만들기</button>'
          : '') +
        '<div class="oa-input-row">' +
          '<input type="text" id="oaInput" placeholder="문서로 할 일을 적어주세요" autocomplete="off">' +
          '<button type="button" id="oaSend">보내기</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);
    var msgs = panel.querySelector('#oaMsgs');
    var input = panel.querySelector('#oaInput');
    var memoList = panel.querySelector('#oaMemoList');
    var busy = false;

    function addMsg(role, text) {
      var div = document.createElement('div');
      div.className = 'oa-msg ' + role;
      div.textContent = text;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }
    function setOpen(open) {
      panel.classList.toggle('open', open);
      if (open) input.focus();
    }
    btn.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
    panel.querySelector('.oa-close').addEventListener('click', function () { setOpen(false); });

    var examples = EXAMPLES[state.app] || [];
    if (examples.length) {
      addMsg('assistant', '이 문서로 할 일을 말씀해 주세요. 예: ' + examples.join(' · '));
    } else {
      addMsg('assistant', '이 문서로 할 일을 말씀해 주세요.');
    }

    function runInstruction(text) {
      if (busy || !text) return Promise.resolve();
      busy = true;
      addMsg('user', text);
      var thinking = addMsg('assistant', '작업 중이에요…');
      var finish = function (msg) {
        thinking.textContent = msg;
        msgs.scrollTop = msgs.scrollHeight;
        busy = false;
      };
      if (!kind || !session) {
        finish('이 앱에서는 아직 문서 비서를 쓸 수 없어요.');
        return Promise.resolve();
      }
      var st = host.getState();
      // snapshot()이 동기적으로 던지면(세션 배선 결함 등) busy가 영원히
      // 풀리지 않아 패널이 "작업 중"에 고정된다 — 반드시 체인 안에서
      // 호출해 어떤 예외도 아래 catch → finish로 표면화한다 (F6 가드).
      var doSnapshot = Promise.resolve().then(function () {
        return session.snapshot ? session.snapshot() : null;
      });
      return doSnapshot.catch(function () { return null; }).then(function (snapshot) {
        return fetch('/api/ai/office/instruct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app: kind,
            fileName: st.fileName,
            instruction: text,
            snapshot: snapshot,
          }),
        });
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad response' }; }).then(function (data) {
          if (!r.ok || !data || data.ok !== true) {
            var code = data && data.error;
            finish(
              code === 'ai_not_configured' ? 'AI가 아직 설정되지 않았어요.'
              : code === 'instruction_required' || code === 'empty_instruction' ? '지시가 비어 있어요.'
              : '비서 호출에 실패했어요. 잠시 뒤 다시 시도해 주세요.'
            );
            return null;
          }
          var ops = Array.isArray(data.ops) ? data.ops : [];
          if (!ops.length) {
            finish(composeResult(data, []));
            return null;
          }
          return Promise.resolve().then(function () { return session.applyOps(ops); }).then(function (results) {
            finish(composeResult(data, results || []));
            return null;
          });
        });
      }).catch(function () {
        finish('비서 호출에 실패했어요. 네트워크를 확인해 주세요.');
      });
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      runInstruction(text);
    }
    panel.querySelector('#oaSend').addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
    });

    /* ---- 메모로 만들기 ---- */
    var memoBtn = panel.querySelector('#oaMemoBtn');
    if (memoBtn) {
      memoBtn.addEventListener('click', function () {
        if (busy) return;
        memoList.hidden = !memoList.hidden;
        if (memoList.hidden || memoList.dataset.loaded) return;
        memoList.dataset.loaded = '1';
        memoList.innerHTML = '<div class="oa-memo-empty">메모를 불러오는 중…</div>';
        fetch('/api/ai/office/memos?q=')
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var memos = (data && data.memos) || [];
            if (!memos.length) {
              memoList.innerHTML = '<div class="oa-memo-empty">변환할 메모가 없어요.</div>';
              return;
            }
            memoList.innerHTML = '';
            memos.forEach(function (m) {
              var b = document.createElement('button');
              b.type = 'button';
              b.className = 'oa-memo-item';
              b.textContent = m.title || '제목 없음';
              b.addEventListener('click', function () { fromMemo(m); });
              memoList.appendChild(b);
            });
          })
          .catch(function () {
            memoList.innerHTML = '<div class="oa-memo-empty">메모를 불러오지 못했어요.</div>';
          });
      });
    }

    function fromMemo(memo) {
      if (busy) return;
      busy = true;
      memoList.hidden = true;
      var thinking = addMsg('assistant', '메모를 문서로 만드는 중이에요…');
      var finish = function (msg) { thinking.textContent = msg; busy = false; };
      if (kind === 'hangul') {
        // 한글은 마크다운→hwpx 바이트 경로가 1차 (D-35 정본).
        fetch('/api/ai/office/from-memo-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memoId: memo.id }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
          .then(function (res) {
            if (!res.ok || !res.data || res.data.ok !== true || !res.data.markdown) {
              finish('문서를 만들지 못했어요. 다시 시도해 주세요.');
              return null;
            }
            var title = res.data.title || memo.title || '새 문서';
            var name = title.replace(/[\\/:*?"<>|]/g, '').trim() + '.hwpx';
            return host.kordoc().then(function (kordoc) {
              return Promise.resolve(kordoc.markdownToHwpx(res.data.markdown, title)).then(function (bytes) {
                var blob = new Blob([bytes], { type: 'application/octet-stream' });
                return host.officeFetch().createFile(name, blob);
              }).then(function (created) {
                return host.openFile(created.id, name).then(function () {
                  finish('"' + title + '" 문서를 만들었어요.');
                });
              });
            });
          })
          .catch(function () { finish('문서를 만들지 못했어요. 다시 시도해 주세요.'); });
        return;
      }
      // excel: /from-memo ops → 새 문서에 적용
      fetch('/api/ai/office/from-memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoId: memo.id, target: 'excel' }),
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.data || res.data.ok !== true) {
            finish('문서를 만들지 못했어요. 다시 시도해 주세요.');
            return null;
          }
          var title = res.data.title || memo.title || '새 문서';
          var ops = Array.isArray(res.data.ops) ? res.data.ops : [];
          return host.newDocument().then(function () {
            return host.whenEngineReady();
          }).then(function () {
            host.setDocName(title.replace(/[\\/:*?"<>|]/g, '').trim() + '.xlsx');
            return session.applyOps(ops);
          }).then(function (results) {
            finish(composeResult({ reply: '"' + title + '" 문서를 만들었어요. 저장하면 보관함에 들어갑니다.' }, results || []));
          });
        })
        .catch(function () { finish('문서를 만들지 못했어요. 다시 시도해 주세요.'); });
    }

    return {
      open: function () { setOpen(true); },
      runInstruction: runInstruction,
    };
  }

  var api = { attach: attach, composeResult: composeResult, KIND_BY_APP: KIND_BY_APP };
  if (typeof window !== 'undefined') window.MyHubOfficeAssistant = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubOfficeAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
