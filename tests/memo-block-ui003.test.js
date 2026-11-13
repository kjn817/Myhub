/**
 * @jest-environment jsdom
 */
/**
 * UI-003 + 트랙 D 클라이언트 검증 (실제 배송 파일 public/js/memo/*.js).
 *
 * 성질:
 * 1. 블록 잠금 버튼은 더 이상 하드코딩 비활성화돼 있지 않고, lock-block API를
 *    호출하는 실제 핸들러를 가진다. (버튼이 disabled면 이 테스트는 실패한다)
 * 2. 잠긴 블록 플레이스홀더는 직렬화 시 [LOCKED_BLOCK:<id>] 마커가 되고,
 *    플레이스홀더의 표시 텍스트(비밀 길이 안내문)는 본문에 새지 않는다.
 *    (비밀 평문이 memos.text에 남지 않게 하는 핵심 성질 — md.js 함수를
 *    실제로 실행해 검증한다)
 * 3. 마커는 렌더링 시 data-block-id를 가진 플레이스홀더로 복원된다
 *    (복원되지 않으면 저장 후 해제할 방법이 없다).
 * 4. 잠긴 첨부파일의 표시·다운로드 경로는 원본(암호문) Cloudinary URL이 아니라
 *    복호화 서빙 경로(/api/memo/files/<id>/content)를 쓴다.
 * 5. 블록 해제는 step-up 경로(fetchLockWithPin / requestUnlockBlock)를 통한다.
 * 6. restoreSel은 stale Range를 그대로 addRange하지 않고 clone+연결성 검증을 한다.
 * 7. 블록 해제의 확인 관문은 네이티브 confirm()이 아니라 커스텀 모달
 *    (window._confirmAction)이다 — 네이티브 다이얼로그는 자동화 브라우저가
 *    자동 닫기 때문에, 관문으로 쓰면 해제 흐름이 무반응으로 죽는다
 *    (2026-10-30 브라우저 후속 QA에서 실측된 결함). 배송 파일의 실제 함수
 *    본문을 잘라 jsdom에서 실행해, 자동 닫기(false) 환경에서도 확인 모달 →
 *    PIN step-up → 복호문 복원이 완주함을 본다.
 * 8. 기존 메모 편집(pane)에도 파일 첨부 진입점이 있다 (컴포저 #files 대응물).
 *
 * 한계: 7번은 openPane 전체 구동이 아니라 해제 함수 본문의 실행이다
 * (보기 모드의 클릭 바인딩 루프 자체는 5번의 정적 단언으로 고정한다).
 * marked/DOMPurify는 로드하지 않는다 — 플레이스홀더 마크업은 실함수
 * lockedBlockMarkerToHtml의 산출물을 그대로 쓰며, 운영 렌더에서도
 * class·data-block-id가 sanitize를 통과해 남는 것은 별도 재현으로 확인했다.
 *
 * 실행: npx jest tests/memo-block-ui003.test.js
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const TOOLBAR = read('public/js/memo/toolbar.js');
const MD = read('public/js/memo/md.js');
const PANE = read('public/js/memo/pane.js');
const LIST = read('public/js/memo/list.js');
const UTILS = read('public/js/memo/utils.js');
const CORE = read('public/js/memo/editor-core.js');
const BUNDLE = read('public/js/memo-bundle.js');

/** md.js의 순수 함수들을 실제로 로드한다 (상위 레벨은 함수 선언만 있다). */
function loadMd() {
  const names = ['escMd', 'escapeBlockStart', 'inlineNodeToMd', 'inlineToMd',
    'blockNodeToMd', 'blockOrInline', 'lockedBlockMarkerToHtml',
    'fileDisplayUrl', 'fileFullUrl', 'listToMd', 'tableToMd'];
  const factory = new Function(
    MD + '\nreturn {' + names.map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(',') + '};'
  );
  return factory();
}

/** 최소 가짜 DOM 노드 (md.js 직렬화가 쓰는 API만 구현). */
function fakeEl(tag, opts = {}) {
  const attrs = opts.attrs || {};
  return {
    nodeType: 1,
    tagName: tag,
    childNodes: opts.children || [],
    children: (opts.children || []).filter((c) => c.nodeType === 1),
    classList: { contains: (c) => (opts.classes || []).includes(c) },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    style: {},
  };
}
const fakeText = (t) => ({ nodeType: 3, textContent: t });

describe('UI-003: 블록 잠금 버튼 활성화', () => {
  test('버튼이 disabled로 하드코딩돼 있지 않고 비활성화 문구가 없다', () => {
    expect(TOOLBAR).not.toContain('오류로 비활성화됨');
    expect(TOOLBAR).not.toMatch(/lockBlockBtn\.disabled\s*=\s*true/);
    expect(BUNDLE).not.toContain('오류로 비활성화됨');
  });

  test('핸들러가 lock-block API를 실제로 호출한다', () => {
    expect(TOOLBAR).toContain("'/api/memo/' + memoId + '/lock-block'");
    expect(TOOLBAR).toContain('선택한 블록 잠금');
  });

  test('핸들러 순서: 저장(PUT) → lock-block → 마커 반영 PUT (D-3 fail-closed 연계)', () => {
    // 서버 lock-block은 저장된 본문에 없는 html을 거부하므로, 미저장 편집을
    // 먼저 저장하지 않으면 정상 흐름이 막힌다. 첫 PUT이 lock-block 호출보다
    // 앞에 있어야 한다.
    const lockIdx = TOOLBAR.indexOf("'/lock-block'");
    const firstPutIdx = TOOLBAR.indexOf("method: 'PUT'");
    expect(firstPutIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(firstPutIdx).toBeLessThan(lockIdx);
    expect(BUNDLE).toContain('block_not_in_text');
  });

  test('플레이스홀더는 div가 아닌 인라인 span + contenteditable=false다', () => {
    expect(TOOLBAR).toContain("document.createElement('span')");
    expect(TOOLBAR).toContain("placeholder.setAttribute('contenteditable', 'false')");
    expect(TOOLBAR).toContain("placeholder.setAttribute('data-block-id', data.blockId)");
  });

  test('해제는 step-up 공용 헬퍼(requestUnlockBlock → fetchLockWithPin)를 통한다', () => {
    expect(TOOLBAR).toContain('async function requestUnlockBlock');
    expect(TOOLBAR).toContain('fetchLockWithPin');
    expect(TOOLBAR).toContain('unlock-block/');
    expect(TOOLBAR).toContain('async function unlockLockedBlockEl');
    // 페인의 보기·편집 모드도 같은 해제 경로를 쓴다
    expect(PANE).toContain('requestUnlockBlock');
    expect(PANE).toContain('unlockLockedBlockEl');
  });

  test('unlock_pending(부분 성공)를 무경고 성공으로 처리하지 않는다 (트랙 C 연계)', () => {
    // 서버 폴백: 복호 성공 + locked_blocks 제거 실패 시 warning:'unlock_pending'.
    // 클라이언트가 이를 무시하면 마커가 평문으로 교체·저장돼 암호문이 고아가 된다.
    expect(TOOLBAR).toContain("warning === 'unlock_pending'");
    // requestUnlockBlock은 1회 자동 재시도하고, 그래도 남으면 호출자가 보류 처리
    const helper = TOOLBAR.slice(TOOLBAR.indexOf('async function requestUnlockBlock'),
      TOOLBAR.indexOf('async function unlockLockedBlockEl'));
    expect(helper).toContain('unlock_pending');
    expect(helper).toMatch(/await call\(\)/);
    // 에디터 해제: warning이면 플레이스홀더를 교체하지 않고 보류를 알린다
    const el = TOOLBAR.slice(TOOLBAR.indexOf('async function unlockLockedBlockEl'));
    expect(el.indexOf("data.warning === 'unlock_pending'")).toBeGreaterThan(-1);
    expect(el.indexOf("data.warning === 'unlock_pending'")).toBeLessThan(el.indexOf('el.replaceWith'));
    // 보기 모드 해제: warning이면 본문 PUT 전에 중단한다
    const view = PANE.slice(PANE.indexOf("data.warning === 'unlock_pending'"));
    expect(view.length).toBeGreaterThan(0);
    expect(PANE.indexOf("data.warning === 'unlock_pending'")).toBeLessThan(PANE.indexOf("method: 'PUT'"));
  });
});

describe('md.js 직렬화: 잠긴 블록 마커 (실함수 실행)', () => {
  const md = loadMd();

  test('잠긴 span 플레이스홀더 → [LOCKED_BLOCK:<id>] 마커, 표시 텍스트 누출 없음', () => {
    const span = fakeEl('SPAN', {
      classes: ['locked-block'],
      attrs: { 'data-block-id': 'blk_abc123' },
      children: [fakeText('잠긴 블록 (7자, 클릭하여 해제)')],
    });
    const out = md.inlineNodeToMd(span, {});
    expect(out).toBe('[LOCKED_BLOCK:blk_abc123]');
    expect(out).not.toContain('잠긴 블록');
  });

  test('일반 span은 기존대로 내부 텍스트를 직렬화한다 (마커 오발 방지)', () => {
    const span = fakeEl('SPAN', { children: [fakeText('일반 텍스트')] });
    expect(md.inlineNodeToMd(span, {})).toBe('일반 텍스트');
  });

  test('블록 레벨 잠긴 div도 마커로 직렬화된다', () => {
    const div = fakeEl('DIV', {
      classes: ['locked-block'],
      attrs: { 'data-block-id': 'blk_xyz9' },
      children: [fakeText('잠긴 블록')],
    });
    expect(md.blockNodeToMd(div)).toBe('[LOCKED_BLOCK:blk_xyz9]\n\n');
  });

  test('마커 → 플레이스홀더 HTML 복원 (data-block-id 보존)', () => {
    const html = md.lockedBlockMarkerToHtml('앞 [LOCKED_BLOCK:blk_abc123] 뒤');
    expect(html).toContain('data-block-id="blk_abc123"');
    expect(html).toContain('locked-block');
    expect(html).not.toContain('[LOCKED_BLOCK:');
    // 이스케이프된 마커도 복원된다
    const html2 = md.lockedBlockMarkerToHtml('\\[LOCKED_BLOCK:blk_esc1\\]');
    expect(html2).toContain('data-block-id="blk_esc1"');
  });
});

describe('잠긴 첨부파일 표시·다운로드 경로 (트랙 D)', () => {
  const md = loadMd();

  test('fileDisplayUrl/fileFullUrl: 잠긴 파일은 /content, 아니면 원본', () => {
    const locked = { is_locked: 1, thumb: 'https://cdn/thumb', url: 'https://cdn/enc.enc' };
    expect(md.fileDisplayUrl(locked, 42)).toBe('/api/memo/files/42/content');
    expect(md.fileFullUrl(locked, 42)).toBe('/api/memo/files/42/content');
    const plain = { is_locked: 0, thumb: 'https://cdn/thumb', url: 'https://cdn/orig' };
    expect(md.fileDisplayUrl(plain, 42)).toBe('https://cdn/thumb');
    expect(md.fileFullUrl(plain, 42)).toBe('https://cdn/orig');
  });

  // 5-2 F-L6 통합으로 다운로드 핸들러가 utils.js의 downloadMemoFile로
  // 이동했다 — /content 분기는 헬퍼가 갖고, pane/list는 헬퍼를 호출한다.
  // 동작 자체는 tests/f-l6-file-chip-download.test.ts가 실행으로 검증한다.
  test('pane/list의 비이미지 다운로드가 잠금 시 /content를 쓴다', () => {
    expect(UTILS).toContain("f.is_locked ? '/api/memo/files/' + f.id + '/content' : f.url");
    expect(PANE).toContain('downloadMemoFile(f)');
    expect(LIST).toContain('downloadMemoFile(f)');
    expect(LIST).toContain("f.is_locked ? '/api/memo/files/' + f.id + '/content' : (f.thumb || f.url)");
  });
});

describe('restoreSel 하드닝 (MEMO-001 가설 A 경로)', () => {
  test('저장 Range의 clone을 쓰고 연결성을 검증한다', () => {
    const m = CORE.match(/function restoreSel\(editor\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('cloneRange()');
    expect(m[0]).toContain('isConnected');
    expect(m[0]).not.toContain('sel.addRange(editor.savedRange)');
  });
});

describe('블록 해제 확인 관문: 커스텀 모달 고정 (정적)', () => {
  test('보기·편집 해제 진입점이 _confirmAction을 1차 관문으로 쓴다', () => {
    expect(PANE).toContain("await window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')");
    expect(TOOLBAR).toContain("await window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')");
    expect(BUNDLE).toContain("window._confirmAction('이 블록의 잠금을 해제할까요?', '해제')");
  });

  test('_confirmAction은 memo-confirm-overlay Promise 모달이고 _confirmDelete가 재사용한다', () => {
    expect(PANE).toContain('window._confirmAction = function');
    expect(PANE).toContain("overlay.className = 'memo-confirm-overlay'");
    expect(PANE).toContain("return window._confirmAction(msg, '삭제', true);");
    expect(BUNDLE).toContain('window._confirmAction = function');
  });

  test('기존 메모 편집(pane)에 파일 첨부 진입점이 있다 (부수 관찰 ① 누락 수정)', () => {
    expect(PANE).toContain("attachBtn.className = 'mini-file-btn'");
    expect(PANE).toContain("attachInput.type = 'file'");
    expect(PANE).toContain('handleEditorFiles(editor, attachInput.files)');
    expect(BUNDLE).toContain('handleEditorFiles(editor, attachInput.files)');
  });
});

describe('블록 해제 흐름 실행 (jsdom, 배송 함수 본문)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));

  /** pane.js·toolbar.js에서 해제 흐름의 실제 함수 본문들을 잘라 한 스코프로 로드한다. */
  function loadFlow({ fetchImpl, confirmImpl, alertImpl }) {
    const promptPin = PANE.slice(
      PANE.indexOf('window._promptPin = function'),
      PANE.indexOf('// 잠금 토글 fetch'));
    const fetchStart = PANE.indexOf('async function fetchLockWithPin');
    const fetchPin = PANE.slice(
      fetchStart,
      PANE.indexOf('// 커스텀 확인 모달', fetchStart));
    const s = PANE.indexOf('window._confirmAction = function');
    const tail = "return window._confirmAction(msg, '삭제', true);";
    const confirmModal = PANE.slice(s, PANE.indexOf(tail, s) + tail.length + 3);
    const toolbarTail = TOOLBAR.slice(TOOLBAR.indexOf('async function requestUnlockBlock'));
    expect(promptPin).toContain('_promptPin');
    expect(fetchPin).toContain('fetchLockWithPin');
    expect(confirmModal).toContain('_confirmAction');
    expect(toolbarTail).toContain('unlockLockedBlockEl');
    const factory = new Function('window', 'document', 'fetch', 'confirm', 'alert',
      [promptPin, fetchPin, confirmModal, toolbarTail].join('\n')
      + '\nreturn { unlockLockedBlockEl };');
    return factory(window, document, fetchImpl, confirmImpl, alertImpl);
  }

  function makeFetch(calls) {
    return async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      const res = (status, obj) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => obj,
        clone() { return res(status, obj); },
      });
      if (url.includes('/unlock-block/')) {
        if (!body || !body.pin) return res(403, { ok: false, code: 'PIN_REQUIRED' });
        if (body.pin === '123456') return res(200, { ok: true, html: '복호화된 비밀' });
        return res(403, { ok: false, code: 'PIN_INVALID' });
      }
      return res(200, { ok: true });
    };
  }

  function makeEditor() {
    const md = loadMd();
    document.body.innerHTML = '';
    const editor = document.createElement('div');
    editor.innerHTML = md.lockedBlockMarkerToHtml('앞 [LOCKED_BLOCK:blk_t1] 뒤');
    document.body.appendChild(editor);
    return editor;
  }

  test('네이티브 confirm 자동 닫기 환경에서도 확인 모달 → PIN step-up → 복원까지 완주한다', async () => {
    const editor = makeEditor();
    const span = editor.querySelector('.locked-block');
    expect(span).not.toBeNull();
    const calls = [];
    // 자동화 브라우저의 네이티브 다이얼로그 자동 닫기를 재현: 호출되면 false.
    // 구 코드에서는 이 값이 관문이 돼 모달도 fetch도 없이 흐름이 죽었다.
    const confirmSpy = jest.fn(() => false);
    const { unlockLockedBlockEl } = loadFlow({
      fetchImpl: makeFetch(calls), confirmImpl: confirmSpy, alertImpl: jest.fn(),
    });

    const done = unlockLockedBlockEl(span, 123);
    await tick();
    const overlay = document.querySelector('.memo-confirm-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('이 블록의 잠금을 해제할까요?');
    overlay.querySelector('.memo-confirm-yes').click();
    await tick(); await tick();

    const pinInput = document.querySelector('.myhub-stepup-pin-input');
    expect(pinInput).not.toBeNull();
    pinInput.value = '123456';
    pinInput.closest('.myhub-stepup-overlay').querySelector('.myhub-stepup-yes').click();
    await done;
    await tick();

    expect(editor.querySelector('.locked-block')).toBeNull();
    expect(editor.textContent).toContain('복호화된 비밀');
    const unlockCalls = calls.filter((c) => c.url.includes('/unlock-block/'));
    expect(unlockCalls.length).toBe(2);
    expect(unlockCalls[1].body.pin).toBe('123456');
    // 네이티브 confirm은 관문이 아니다 — 자동 닫기 값에 흐름이 좌우되지 않는다
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('확인 모달에서 취소하면 API를 부르지 않고 플레이스홀더를 유지한다', async () => {
    const editor = makeEditor();
    const span = editor.querySelector('.locked-block');
    const calls = [];
    const { unlockLockedBlockEl } = loadFlow({
      fetchImpl: makeFetch(calls), confirmImpl: jest.fn(() => false), alertImpl: jest.fn(),
    });
    const done = unlockLockedBlockEl(span, 123);
    await tick();
    const overlay = document.querySelector('.memo-confirm-overlay');
    expect(overlay).not.toBeNull();
    overlay.querySelector('.memo-confirm-no').click();
    await done;
    expect(calls.length).toBe(0);
    expect(editor.querySelector('.locked-block')).not.toBeNull();
  });
});
