// 오피스 부팅 로딩 플로우 검증 (2026-11-13 사용자 지시로 바뀐 플로우).
// 새 플로우: 부팅 로딩 화면(#officeBootLoading, 정적 마크업·스크립트 실행 전
// 표시)이 첫 화면이고, 진행 막대(#officeProgress)는 존재하지 않으며, 첫 문서가
// 열리면(성공·실패 모두) 부팅 로딩이 사라진다.
// 단언:
//  1) 파일 열기 중 #officeProgress 요소가 한 번도 존재하지 않는다.
//  2) #officeBootLoading이 보였다가 사라진다 (보인 적 없으면 공허한 통과라 실패).
// 구 단언(막대+원형 로딩 겹침 샘플링)은 진행 막대 삭제로 무효가 됐다 —
// 막대 요소 자체가 없어 겹침이 구조적으로 불가능해졌기 때문이다.
// 원본: .scratch/perf4/probe-desktop-open-file.cjs의 더블클릭 흐름.
'use strict';

const { runScenario, waitForDesktop, assert } = require('./harness.cjs');

const FILES = [
  { id: 101, filename: '2026 서울특별시 공모휴.pdf', mime: 'application/pdf', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
  { id: 102, filename: '1.서울특별시청 부설주차장.hwp', mime: 'application/x-hwp', folder_id: 1, size: 23456, created_at: '2026-11-13T00:00:00Z', version: 1 },
];

async function sampleOfficeState(page) {
  return page.evaluate(() => {
    const officeFrame = document.querySelector('.dt-frame[src*="office.html"]');
    if (!officeFrame) return null;
    try {
      const d = officeFrame.contentDocument;
      const bar = d.getElementById('officeProgress');
      const boot = d.getElementById('officeBootLoading');
      let bootVisible = false;
      if (boot && !boot.hidden) {
        const r = boot.getBoundingClientRect();
        bootVisible = r.width > 0 && r.height > 0;
      }
      return { progressExists: !!bar, bootVisible };
    } catch (e) { return null; }
  });
}

runScenario('office-loading-overlap', async (t) => {
  const { base } = await t.server({ driveFiles: FILES });
  const browser = await t.browser();
  const { page } = await t.newPage(browser);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 15000 });
  await page.waitForTimeout(800);

  await page.locator('.dt-desk-icon.is-file[data-file-id="102"]').dblclick();

  // 100ms 간격으로 6초간 샘플링: 부팅 로딩이 보였다가 사라지는지,
  // 진행 막대 요소가 한 번도 존재하지 않는지.
  let sawBootVisible = false;
  let bootGoneAfterSeen = false;
  let sawProgress = false;
  let sawFrame = false;
  const timeline = [];
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const st = await sampleOfficeState(page);
    if (!st) { timeline.push(`${(i + 1) * 100}ms:--`); continue; }
    sawFrame = true;
    if (st.progressExists) sawProgress = true;
    if (st.bootVisible) sawBootVisible = true;
    else if (sawBootVisible) bootGoneAfterSeen = true;
    timeline.push(`${(i + 1) * 100}ms:${st.progressExists ? 'P' : '-'}${st.bootVisible ? 'B' : '-'}`);
  }
  console.log(`  timeline (P=#officeProgress 존재, B=부팅 로딩 표시): ${timeline.join(' ')}`);

  // 전제: 오피스 창이 실제로 열렸어야 샘플링이 의미를 갖는다.
  assert(sawFrame, '오피스 창 iframe이 한 번도 나타나지 않았다');
  const office = await page.$('.dt-frame[src*="office.html?app=hangul"]');
  assert(office, '한글 오피스 창이 열리지 않았다');
  // 1) 진행 막대 요소는 존재 자체가 없어야 한다.
  assert(!sawProgress, '진행 막대(#officeProgress) 요소가 열기 중에 존재했다 — 새 플로우에서는 삭제된 요소다');
  // 2) 부팅 로딩이 보였다가 사라져야 한다.
  assert(sawBootVisible, '부팅 로딩(#officeBootLoading)이 한 번도 보이지 않았다 — 첫 화면이 안 뜨는 것일 수 있다');
  assert(bootGoneAfterSeen, '부팅 로딩이 보였다가 사라지지 않았다 — 첫 문서가 열려도 로딩 화면이 남아 있다');
});
