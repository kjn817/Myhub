// PIN step-up 모달 스타일 실브라우저 검증 (1단계 S1-2·S1-3).
// 단언:
//  1) 백업 페이지: #step-up-style이 LINK다 — link가 있으면 step-up.js는
//     인라인 <style> 주입을 건너뛰므로, CSP enforce 환경에서도 모달
//     스타일이 유지된다. link가 없으면 주입된 STYLE이 되고 enforce
//     페이지에서는 차단돼 무스타일 모달이 뜬다.
//  2) 백업·메모 PIN 모달의 확인 버튼이 파란색(rgb(0,122,255))이고
//     오버레이가 어둡다(rgba(0,0,0,0.5)) — 계산된 스타일로 직접 확인한다.
//     구 코드에서는 메모 버튼만 흰색이었다 (memo.css에 -yes 규칙 없음).
// 모달은 window._promptPin을 직접 호출해 띄운다 — 403 재현보다
// 스타일 판정에 집중하기 위한 것이며, step-up 재시도 흐름 자체는
// tests/backup-stepup-ui.test.ts(jsdom)가 검증한다.
'use strict';

const { runScenario, assert, assertEq, attachErrorCollector } = require('./harness.cjs');

async function openPinModal(page) {
  await page.waitForFunction(() => typeof window._promptPin === 'function', null, { timeout: 15000 });
  // _promptPin은 Promise를 돌려주므로 fire-and-forget으로 호출하고
  // 모달이 뜰 때까지 대기한다.
  await page.evaluate(() => { window._promptPin('테스트 PIN 입력'); });
  await page.waitForSelector('.myhub-stepup-yes', { timeout: 10000 });
}

async function modalStyles(page) {
  return page.evaluate(() => {
    const yes = document.querySelector('.myhub-stepup-yes');
    const overlay = document.querySelector('.myhub-stepup-overlay');
    const modal = document.querySelector('.myhub-stepup-modal');
    const r = modal ? modal.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      yesBg: yes ? getComputedStyle(yes).backgroundColor : null,
      overlayBg: overlay ? getComputedStyle(overlay).backgroundColor : null,
      modalVisible: r.width > 0 && r.height > 0,
      modalW: Math.round(r.width),
    };
  });
}

async function closeModal(page) {
  await page.click('.myhub-stepup-no');
  await page.waitForSelector('.myhub-stepup-overlay', { state: 'detached', timeout: 5000 });
}

runScenario('stepup-modal-styles', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();
  const { page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);

  // 1) 백업 페이지 — link로 선언된 step-up.css가 모달에 적용된다.
  await page.goto(`${base}/backup.html`, { waitUntil: 'domcontentloaded' });
  await openPinModal(page);
  const stepUpTag = await page.evaluate(() => {
    const el = document.getElementById('step-up-style');
    return el ? el.tagName : null;
  });
  assertEq(stepUpTag, 'LINK', '#step-up-style이 LINK가 아니다 — backup.html에 link가 없으면 step-up.js가 인라인 style을 주입한다');
  const backupStyles = await modalStyles(page);
  assert(backupStyles.modalVisible, '백업 PIN 모달이 보이지 않는다');
  assertEq(backupStyles.yesBg, 'rgb(0, 122, 255)', '백업 PIN 확인 버튼이 파란색이 아니다');
  assertEq(backupStyles.overlayBg, 'rgba(0, 0, 0, 0.5)', '백업 PIN 모달 오버레이가 어둡지 않다');
  console.log(`  backup modal: yesBg=${backupStyles.yesBg} overlayBg=${backupStyles.overlayBg} modalW=${backupStyles.modalW}`);
  await closeModal(page);

  // 2) 메모 페이지 — memo.css 사본의 -yes 규칙이 확인 버튼을 파랗게 한다.
  await page.goto(`${base}/memo.html`, { waitUntil: 'domcontentloaded' });
  await openPinModal(page);
  const memoStyles = await modalStyles(page);
  assert(memoStyles.modalVisible, '메모 PIN 모달이 보이지 않는다');
  assertEq(memoStyles.yesBg, 'rgb(0, 122, 255)', '메모 PIN 확인 버튼이 파란색이 아니다 — memo.css에 .myhub-stepup-yes 규칙이 없다');
  assertEq(memoStyles.overlayBg, 'rgba(0, 0, 0, 0.5)', '메모 PIN 모달 오버레이가 어둡지 않다');
  console.log(`  memo modal: yesBg=${memoStyles.yesBg} overlayBg=${memoStyles.overlayBg} modalW=${memoStyles.modalW}`);
  await closeModal(page);

  // 전제: 페이지 오류가 없어야 스타일 판정이 신뢰할 수 있다.
  // (httpErrors는 하네스 기본 로드에서도 404가 발생할 수 있어 단언하지 않는다.)
  assertEq(errors.pageErrors.length, 0, `페이지 오류 발생: ${errors.pageErrors.join(' | ')}`);
});
