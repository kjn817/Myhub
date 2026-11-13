// 이미지 붙여넣기 → 엔진 삽입 완주 검증 (F-L2 통합, 5-3).
// 스텁 엔진(라우트 가로챔)이 ready·exec-result 프로토콜만 말하고
// 실제 WASM은 뜨지 않는다 — 호스트의 붙여넣기 경로(가로채기 →
// fileToBase64 → exec insert.picture → 결과 수신)를 실브라우저에서
// 끝까지 탄다.
// 단언:
//  1) deck: office.html에서 호스트를 만들고 스텁 엔진 ready 뒤
//     iframe 문서에 PNG 붙여넣기를 디스패치하면, 스텁이
//     insert.picture exec를 받고 base64가 PNG 바이트와 같으며,
//     붙여넣기 오류 콜백이 오지 않는다.
//  2) sheet: sheet.html(브리지 자동 부팅)에서 문서에 PNG 붙여넣기를
//     디스패치하면, 스텁이 insert.picture exec를 받고 브리지가
//     myhub-sheet:paste-image ok:true를 부모에 보고한다.
//  3) 두 서면 모두 공개 API의 붙여넣기 헬퍼가 코어와 동일 참조다.
//  4) 두 서면 모두 페이지 오류가 없다.
// 카나리아: pasteImageFile이 files를 못 읽으면 1)·2)가, 코어 위임이
// 빠지면 3)이 실패한다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 투명 PNG (67바이트) — FileReader가 읽어 base64로 바꿀 실물 바이트.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function stubEngineHtml(prefix) {
  return (
    '<!DOCTYPE html><html><body><script>\n' +
    'window.__execs = [];\n' +
    'window.__readyPosted = false;\n' +
    "window.parent.postMessage({ type: '" +
    prefix +
    ":ready', version: 'stub-1' }, '*');\n" +
    'window.__readyPosted = true;\n' +
    "window.addEventListener('message', function (e) {\n" +
    '  var d = e.data || {};\n' +
    "  if (d.type === '" +
    prefix +
    ":exec') {\n" +
    '    window.__execs.push(d);\n' +
    "    window.parent.postMessage({ type: '" +
    prefix +
    ":exec-result', tag: d.tag, results: [{ ok: true }] }, '*');\n" +
    '  }\n' +
    '});\n' +
    '</scr' +
    'ipt></body></html>'
  );
}

runScenario('paste-image', async (t) => {
  const { base } = await t.server({});
  const browser = await t.browser();

  // ── 1) deck: 호스트 생성 → ready → iframe 문서 붙여넣기 → exec 수신 ──
  {
    const { page } = await t.newPage(browser);
    const errors = attachErrorCollector(page);
    await page.route('**/vendor/deckcraft/index.html*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: stubEngineHtml('deckcraft'),
      }),
    );
    await page.goto(`${base}/office.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__deckReady = false;
      window.__deckPasteError = null;
      const mount = document.createElement('div');
      mount.id = 'e2e-deck-mount';
      document.body.appendChild(mount);
      window.__deckHost = window.MyHubFinderDeckCraft.createHost({
        doc: document,
        win: window,
        parentEl: mount,
        readyTimeoutMs: 15000,
        execTimeoutMs: 10000,
        onReady: () => {
          window.__deckReady = true;
        },
        onPasteImageError: (m) => {
          window.__deckPasteError = m;
        },
      });
    });
    await page.waitForFunction(() => window.__deckReady === true, { timeout: 15000 });
    // ready 직후 붙여넣기 리스너가 붙을 시간을 준다 (ready 콜백 안에서
    // tryAttachPaste가 돌지만, 디스패치 전 한 틱 여유를 둔다).
    await sleep(300);

    const intercepted = await page.evaluate(
      ({ pngBase64 }) => {
        const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        const fdoc = window.__deckHost.frame.contentDocument;
        const el = fdoc.body || fdoc.documentElement;
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      { pngBase64: PNG_BASE64 },
    );
    assert(intercepted, 'deck: 호스트가 붙여넣기를 가로채 preventDefault를 해야 한다');

    await page.waitForFunction(
      () => window.__deckHost.frame.contentWindow.__execs.length >= 1,
      { timeout: 15000 },
    );
    const deckExec = await page.evaluate(
      () => window.__deckHost.frame.contentWindow.__execs[0],
    );
    const deckPasteError = await page.evaluate(() => window.__deckPasteError);
    const deckIdentity = await page.evaluate(
      () =>
        window.MyHubFinderDeckCraft.pasteImageFile ===
          window.MyHubCraftClipboard.pasteImageFile &&
        window.MyHubFinderDeckCraft.isFormFieldTarget ===
          window.MyHubCraftClipboard.isFormFieldTarget &&
        window.MyHubFinderDeckCraft.normalizeBytes ===
          window.MyHubCraftClipboard.normalizeBytes,
    );
    console.log(
      `  deck: exec=${deckExec.commands[0].id} name=${deckExec.commands[0].params.name} b64len=${deckExec.commands[0].params.data.length}`,
    );
    assertEq(deckExec.type, 'deckcraft:exec', 'deck: 스텁이 받은 메시지는 exec여야 한다');
    assertEq(deckExec.commands[0].id, 'insert.picture', 'deck: exec 명령은 insert.picture여야 한다');
    assertEq(deckExec.commands[0].params.data, PNG_BASE64, 'deck: base64가 PNG 바이트와 같아야 한다');
    assertEq(deckExec.commands[0].params.name, 'clipboard.png', 'deck: 파일명이 전달돼야 한다');
    assertEq(deckPasteError, null, `deck: 붙여넣기 오류가 없어야 한다 (실제: ${deckPasteError})`);
    assert(deckIdentity, 'deck: 공개 API 헬퍼가 코어와 동일 참조여야 한다');
    assertEq(errors.pageErrors.length, 0, `deck 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
    await page.context().close();
  }

  // ── 2) sheet: 브리지 자동 부팅 → 문서 붙여넣기 → exec 수신 + ok 보고 ──
  {
    const { page } = await t.newPage(browser);
    const errors = attachErrorCollector(page);
    await page.route('**/vendor/gridcraft/index.html*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: stubEngineHtml('gridcraft'),
      }),
    );
    await page.goto(`${base}/sheet.html`, { waitUntil: 'domcontentloaded' });
    // 브리지가 ready를 받으면 loading을 숨기고 gcReady가 된다 — 스텁이
    // ready를 보냈다는 신호 + 처리 여유로 기다린다.
    await page.waitForFunction(
      () => {
        const frame = document.querySelector('#sheetApp iframe');
        return !!frame && !!frame.contentWindow && frame.contentWindow.__readyPosted === true;
      },
      { timeout: 15000 },
    );
    await sleep(500);
    await page.evaluate(() => {
      window.__pasteResults = [];
      window.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'myhub-sheet:paste-image') window.__pasteResults.push(d);
      });
    });

    const intercepted = await page.evaluate(
      ({ pngBase64 }) => {
        const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      { pngBase64: PNG_BASE64 },
    );
    assert(intercepted, 'sheet: 브리지가 붙여넣기를 가로채 preventDefault를 해야 한다');

    await page.waitForFunction(() => window.__pasteResults.length >= 1, { timeout: 15000 });
    const sheetExec = await page.evaluate(() => {
      const frame = document.querySelector('#sheetApp iframe');
      return frame.contentWindow.__execs[0];
    });
    const sheetResult = await page.evaluate(() => window.__pasteResults[0]);
    const sheetIdentity = await page.evaluate(
      () =>
        window.MyHubSheetGridcraft.pasteImageFile ===
          window.MyHubCraftClipboard.pasteImageFile &&
        window.MyHubSheetGridcraft.isFormFieldTarget ===
          window.MyHubCraftClipboard.isFormFieldTarget,
    );
    console.log(
      `  sheet: exec=${sheetExec.commands[0].id} mime=${sheetExec.commands[0].params.mime} b64len=${sheetExec.commands[0].params.base64.length} resultOk=${sheetResult.ok}`,
    );
    assertEq(sheetExec.type, 'gridcraft:exec', 'sheet: 스텁이 받은 메시지는 exec여야 한다');
    assertEq(sheetExec.commands[0].id, 'insert.picture', 'sheet: exec 명령은 insert.picture여야 한다');
    assertEq(sheetExec.commands[0].params.base64, PNG_BASE64, 'sheet: base64가 PNG 바이트와 같아야 한다');
    assertEq(sheetExec.commands[0].params.mime, 'image/png', 'sheet: mime이 전달돼야 한다');
    assertEq(sheetExec.commands[0].params.placement, 'overCells', 'sheet: placement가 overCells여야 한다');
    assertEq(sheetResult.ok, true, `sheet: 브리지가 ok:true를 보고해야 한다 (실제: ${JSON.stringify(sheetResult)})`);
    assert(sheetIdentity, 'sheet: 공개 API 헬퍼가 코어와 동일 참조여야 한다');
    assertEq(errors.pageErrors.length, 0, `sheet 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
    await page.context().close();
  }
});
