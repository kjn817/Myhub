// 원격 상태 폴링·뒤로가기 검증: 라이브가 켜지면 GET /api/browse/state를
// 폴링해 원격의 실제 URL이 주소창에 반영되고, 뒤로 버튼이 POST
// /api/browse/back으로 원격 기록에 이동하는지 확인한다.
// (2026-11-15 밤 수정 가드: 셸 로컬 기록만 보던 주소창·뒤로가기는 원격 내
// 링크 이동을 몰라 주소가 naver.com에 고정되고 뒤로가기가 안 됐다.)
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

runScenario('browser-remote-state', async (t) => {
  let navigateCount = 0;
  let backCount = 0;
  let stateCount = 0;
  // 원격 상태: 처음에는 뉴스 기사(링크 이동 후), 뒤로가기 뒤에는 네이버.
  let remoteState = {
    ok: true,
    url: 'https://news.naver.com/article/123',
    title: '뉴스 기사',
    canGoBack: true,
    canGoForward: false,
  };
  const { base } = await t.server({
    onApi: async ({ method, path, body }) => {
      if (path === '/api/browse/navigate' && method === 'POST') {
        navigateCount += 1;
        return { body: { ok: true, nav: 'ok', navStage: 'ok' } };
      }
      if (path === '/api/browse/state' && method === 'GET') {
        stateCount += 1;
        return { body: remoteState };
      }
      if (path === '/api/browse/back' && method === 'POST') {
        backCount += 1;
        remoteState = {
          ok: true,
          url: 'https://www.naver.com',
          title: 'naver.com',
          canGoBack: false,
          canGoForward: true,
        };
        return { body: { ok: true, stage: 'ok' } };
      }
      if (path === '/api/browse/view/' && method === 'GET') {
        return { body: '<html><body>selkies stub</body></html>', contentType: 'text/html' };
      }
      return null;
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });

  // NAVER 즐겨찾기 클릭 → enterLive → navigate.
  await page.click('.bw-fav[data-url="https://www.naver.com"]');
  const navDeadline = Date.now() + 10000;
  while (navigateCount === 0 && Date.now() < navDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(navigateCount === 1, 'POST /api/browse/navigate가 10초 안에 오지 않았다');

  // 전제: 폴링이 시작돼야 한다 (즉시 1회 + 주기). 폴링이 안 나가면
  // 아래 주소 단언이 "바뀌지 않았다"로 실패해 원인을 가릴 수 있다.
  const pollDeadline = Date.now() + 10000;
  while (stateCount === 0 && Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(stateCount >= 1, 'GET /api/browse/state 폴링이 10초 안에 오지 않았다');

  // 폴링이 본 원격 URL(뉴스 기사)이 주소창에 반영된다 — 로컬 이동
  // 주소(naver.com)가 아니다.
  const readInput = () =>
    page.evaluate(() => document.getElementById('bwUrl').value);
  const urlDeadline = Date.now() + 10000;
  let inputValue = await readInput();
  while (inputValue !== 'https://news.naver.com/article/123' && Date.now() < urlDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    inputValue = await readInput();
  }
  assertEq(
    inputValue,
    'https://news.naver.com/article/123',
    `주소창이 원격 URL을 따라가야 한다 (실제: ${inputValue})`,
  );

  // 뒤로 버튼이 원격 canGoBack 기준으로 활성화된다 (로컬 기록은 1개뿐).
  const backDisabled = await page.evaluate(() => document.getElementById('bwBackBtn').disabled);
  assertEq(backDisabled, false, '원격 canGoBack=true인데 뒤로 버튼이 비활성이다');
  const fwdDisabled = await page.evaluate(() => document.getElementById('bwFwdBtn').disabled);
  assertEq(fwdDisabled, true, '원격 canGoForward=false인데 앞으로 버튼이 활성이다');

  // 뒤로 클릭 → POST /api/browse/back (로컬 navigate는 안 나간다).
  await page.click('#bwBackBtn');
  const backDeadline = Date.now() + 10000;
  while (backCount === 0 && Date.now() < backDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assertEq(backCount, 1, '뒤로 클릭이 POST /api/browse/back을 보내야 한다');
  assertEq(navigateCount, 1, '원격 뒤로가기인데 로컬 navigate가 나가면 안 된다');

  // 성공 후 즉시 다시 물어 주소가 네이버로 돌아온다.
  const backUrlDeadline = Date.now() + 10000;
  inputValue = await readInput();
  while (inputValue !== 'https://www.naver.com' && Date.now() < backUrlDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    inputValue = await readInput();
  }
  assertEq(inputValue, 'https://www.naver.com', `뒤로 간 뒤 주소가 네이버여야 한다 (실제: ${inputValue})`);
  const backDisabledAfter = await page.evaluate(() => document.getElementById('bwBackBtn').disabled);
  assertEq(backDisabledAfter, true, '뒤로 간 뒤에는 뒤로 버튼이 비활성이어야 한다');
  const fwdDisabledAfter = await page.evaluate(() => document.getElementById('bwFwdBtn').disabled);
  assertEq(fwdDisabledAfter, false, '뒤로 간 뒤에는 앞으로 버튼이 활성이어야 한다');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
