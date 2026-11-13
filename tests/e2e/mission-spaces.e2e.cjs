// 미션 컨트롤 macOS 스페이스 바 (2026-11-13 사용자 지시 — 맥 캡처 기준).
// - 상단바는 미션 중에도 보이고 클릭 가능하다 (맥은 메뉴바를 숨기지만
//   MyHub 상단바는 사라지지 않는다 — 밝은 채로 남아야 한다).
// - 스페이스 바는 상단 전체를 차지하는 밴드(구분선 포함)이고,
//   이름이 썸네일 아래에, + 버튼이 밴드 우상단에 있다.
//   (이름을 위로 올렸던 시도는 맥 캡처 오독이었다 — 2026-11-13 정정.)
// - 창을 + 버튼에 드래그하면 새 데스크톱이 생기고 그 창이 이동한다.
// - 미션 중 바탕화면 아이콘·위젯이 숨겨진다.
// - 스프레드 창이 밴드와 겹치지 않는다.
// - 최대화한 창의 winrect도 썸네일 가장자리에 닿지 않는다 (5% 여유).
// - 빈 데스크톱 문구는 스프레드 영역 중앙에 뜬다 (좌측 하단 아님).
// 카나리아: 구현 전 코드에서는 이름이 썸네일 위, 밴드 없이 카드만
// 떠 있고 + 버튼이 스트립 기준이라 이 시나리오가 실패한다. winrect
// 여유·빈 문구 중앙 배치도 구현 전 코드에서 실패한다.
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq, assertNear } = require('./harness.cjs');

runScenario('mission-spaces', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();
  const { page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);

  // 창 2개 + 스페이스 2개 (메모는 1번, 일정은 2번 스페이스).
  // 메모는 최대화한다 — 최대화한 창의 winrect가 썸네일 가장자리에
  // 닿으면 흰 네모 밑둥이 잘린 것처럼 보인다 (사용자 실화면 지적).
  await page.evaluate(() => {
    window.MyHubDesktop.openModule('memo');
    window.MyHubDesktop.openModule('schedule');
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const st = window.MyHubDesktop.getState();
    const memo = st.windows.find((w) => w.module === 'memo');
    if (memo) window.MyHubDesktop.toggleMaximize(memo.id);
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const st = window.MyHubDesktop.getState();
    const sched = st.windows.find((w) => w.module === 'schedule');
    window.MyHubDesktop.addSpace();
    const st2 = window.MyHubDesktop.getState();
    const second = st2.spaces[st2.spaces.length - 1];
    if (sched) window.MyHubDesktop.moveWindowToSpace(sched.id, second);
    window.MyHubDesktop.switchSpace(st2.spaces[0]);
  });
  await page.waitForTimeout(600);

  await page.evaluate(() => window.MyHubDesktop.toggleMission());
  await page.waitForTimeout(800);

  const m = await page.evaluate(() => {
    const out = { vp: { w: window.innerWidth, h: window.innerHeight } };
    const nav = document.querySelector('.g-nav');
    const nr = nav.getBoundingClientRect();
    out.topbar = { y: nr.y, h: nr.height, opacity: getComputedStyle(nav).opacity };
    const hit = document.elementFromPoint(100, 16);
    out.topbarHitInsideNav = !!(hit && hit.closest && hit.closest('.g-nav'));
    // 상단바 밝기: 미션 배경이 상단바 뒤를 덮으면 어두워진다.
    // 배경 요소의 top이 상단바 높이 이상이면 상단바 뒤는 배경화면 그대로다.
    const bg = document.querySelector('.dt-mission-bg');
    out.missionBgTop = bg ? bg.getBoundingClientRect().top : null;
    out.cards = Array.from(document.querySelectorAll('.dt-mission-card')).map((c) => {
      const name = c.querySelector('.dt-mission-name').getBoundingClientRect();
      const stage = c.querySelector('.dt-mission-stage').getBoundingClientRect();
      const rect = c.querySelector('.dt-mission-winrect');
      let winrect = null;
      if (rect) {
        const rr = rect.getBoundingClientRect();
        winrect = {
          // 썸네일 가장자리로부터의 여유 (전 방향).
          left: rr.left - stage.left, top: rr.top - stage.top,
          right: stage.right - rr.right, bottom: stage.bottom - rr.bottom,
          w: rr.width, h: rr.height,
        };
      }
      return {
        nameBottom: name.bottom, nameTop: name.top,
        stageTop: stage.top, stageBottom: stage.bottom,
        stageCenterY: stage.top + stage.height / 2,
        stageW: stage.width, stageH: stage.height,
        winrect,
      };
    });
    const strip = document.querySelector('.dt-mission-spaces');
    if (strip) {
      const sr = strip.getBoundingClientRect();
      const scs = getComputedStyle(strip);
      out.strip = {
        left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom,
        borderBottomWidth: scs.borderBottomWidth,
        backgroundColor: scs.backgroundColor,
      };
    }
    const add = document.querySelector('.dt-mission-add');
    const ar = add.getBoundingClientRect();
    out.add = { x: ar.x, y: ar.y, w: ar.width, h: ar.height, right: ar.right, centerY: ar.top + ar.height / 2 };
    const icons = document.querySelector('#dt-icons');
    const widgets = document.querySelector('#dt-widgets');
    out.iconsVisibility = icons ? getComputedStyle(icons).visibility : null;
    out.widgetsVisibility = widgets ? getComputedStyle(widgets).visibility : null;
    const spread = Array.from(document.querySelectorAll('.dt-window.dt-mission-win'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((r) => r.w > 0);
    out.spread = spread;
    out.bodyMissionOpen = document.body.classList.contains('dt-mission-open');
    return out;
  });

  // 1. 상단바: 보이고, 클릭 가능하고, 미션 배경이 그 뒤를 덮지 않는다.
  assertEq(m.topbar.y, 0, '상단바가 뷰포트 최상단에 있어야 한다');
  assert(m.topbarHitInsideNav, '상단바 중앙을 눌렀을 때 상단바 요소가 잡혀야 한다 (미션 오버레이에 가려지면 안 된다)');
  assert(m.missionBgTop !== null && m.missionBgTop >= m.topbar.h - 1,
    `미션 배경이 상단바 아래에서 시작해야 한다 (배경 top: ${m.missionBgTop}, 상단바 높이: ${m.topbar.h})`);

  // 2. 스페이스 바는 상단 전체를 차지하는 밴드다 (구분선 포함).
  assert(m.strip, '스페이스 밴드가 있어야 한다');
  assertNear(m.strip.left, 0, 1, '밴드가 좌측 끝에서 시작해야 한다');
  assertNear(m.strip.right, m.vp.w, 1, '밴드가 우측 끝까지 가야 한다');
  assertEq(m.strip.borderBottomWidth, '1px', '밴드 하단에 1px 구분선이 있어야 한다');
  assert(m.strip.backgroundColor !== 'rgba(0, 0, 0, 0)' && m.strip.backgroundColor !== 'transparent',
    `밴드에 배경 틴트가 있어야 한다 (배경: ${m.strip.backgroundColor})`);

  // 3. 이름이 썸네일 아래에 있다.
  assertEq(m.cards.length, 2, '스페이스 카드가 2개여야 한다');
  m.cards.forEach((c, i) => {
    assert(c.nameTop >= c.stageBottom - 1,
      `카드 ${i + 1}의 이름이 썸네일 아래에 있어야 한다 (이름 상단 ${c.nameTop}, 썸네일 하단 ${c.stageBottom})`);
  });

  // 4. + 버튼이 밴드 우상단에, 썸네일 세로 중앙에 있다.
  assert(m.add.right >= m.vp.w - 40,
    `+ 버튼이 우상단에 있어야 한다 (우측 끝 ${m.add.right}, 뷰포트 너비 ${m.vp.w})`);
  assertNear(m.add.centerY, m.cards[0].stageCenterY, 6,
    '+ 버튼 세로 중심이 썸네일 세로 중심과 일치해야 한다');

  // 5. 최대화한 창의 winrect도 썸네일 가장자리에 닿지 않는다.
  const wr = m.cards[0].winrect;
  assert(wr, '1번 카드에 최대화한 메모 창의 winrect가 있어야 한다');
  assert(wr.w > m.cards[0].stageW * 0.5, 'winrect가 썸네일의 절반보다 커야 한다 (사라지면 안 된다)');
  ['left', 'top', 'right', 'bottom'].forEach((side) => {
    assert(wr[side] >= 3,
      `winrect ${side}쪽 여유가 3px 이상이어야 한다 (실제: ${wr[side]}px) — 가장자리에 닿으면 밑둥이 잘린 것처럼 보인다`);
  });

  // 6. 스프레드 창이 밴드와 겹치지 않는다.
  assert(m.spread.length >= 1, '스프레드된 창이 1개 이상 있어야 한다');
  m.spread.forEach((w, i) => {
    assert(w.y >= m.strip.bottom - 2,
      `스프레드 창 ${i + 1}이 밴드 아래에 있어야 한다 (창 상단 ${w.y}, 밴드 하단 ${m.strip.bottom})`);
  });

  // 7. 미션 중 아이콘·위젯이 숨겨진다.
  assertEq(m.iconsVisibility, 'hidden', '미션 중 바탕화면 아이콘이 숨겨져야 한다');
  assertEq(m.widgetsVisibility, 'hidden', '미션 중 위젯이 숨겨져야 한다');
  assert(m.bodyMissionOpen, '미션 중 body에 dt-mission-open 클래스가 있어야 한다');

  // 8. 창을 + 버튼에 드래그하면 새 데스크톱이 생기고 그 창이 이동한다.
  const win = m.spread.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const fromX = win.x + win.w / 2;
  const fromY = win.y + 20;
  const toX = m.add.x + m.add.w / 2;
  const toY = m.add.y + m.add.h / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(fromX + (toX - fromX) * (i / steps), fromY + (toY - fromY) * (i / steps), { steps: 1 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(300);
  const hot = await page.evaluate(() => {
    const a = document.querySelector('.dt-mission-add');
    return a ? a.classList.contains('is-drop-hot') : null;
  });
  assert(hot === true, '+ 버튼 위에 창을 올려놨을 때 is-drop-hot이 켜져야 한다');
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const st = window.MyHubDesktop.getState();
    return {
      spaces: st.spaces.length,
      missionOpen: window.MyHubDesktop.isMissionOpen(),
      memoSpace: (st.windows.find((w) => w.module === 'memo') || {}).space,
      active: st.activeSpace,
    };
  });
  assertEq(after.spaces, 3, '드롭 후 스페이스가 3개가 되어야 한다');
  assert(after.missionOpen, '드롭 후 미션이 열린 채여야 한다');
  const st3 = await page.evaluate(() => window.MyHubDesktop.getState().spaces);
  assertEq(after.memoSpace, st3[st3.length - 1], '드래그한 메모 창이 새로 만든 데스크톱으로 이동해야 한다');

  // 9. 드롭 후 1번 데스크톱이 비면 빈 문구가 스프레드 영역 중앙에 뜬다.
  // (메모가 새 데스크톱으로 이동해 1번이 비었다 — 미션은 열린 채.)
  const empty = await page.evaluate(() => {
    const el = document.querySelector('.dt-mission-empty');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const root = document.getElementById('dt-root');
    const topOff = root ? root.getBoundingClientRect().top : 0;
    return {
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      vw: window.innerWidth, vh: window.innerHeight, topOff,
    };
  });
  assert(empty, '빈 데스크톱 문구가 있어야 한다');
  // 스프레드 영역: 상단 240(MISSION_AREA_TOP) ~ 하단 vh-topOff-96(독)-16.
  const spreadCenterY = (240 + (empty.vh - empty.topOff - 96 - 16)) / 2;
  assertNear(empty.cx, empty.vw / 2, 12, '빈 문구가 스프레드 영역 가로 중앙에 있어야 한다');
  assertNear(empty.cy, spreadCenterY, 12, '빈 문구가 스프레드 영역 세로 중앙에 있어야 한다');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
});
