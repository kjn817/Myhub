/**
 * 메모 저장 버튼 E2E 테스트 (Playwright)
 *
 * 실행: npx playwright test tests/e2e/memo-save.spec.ts
 * 필요: Playwright Chromium 브라우저 설치
 *
 * 주의: 이 테스트는 실제 브라우저에서 실행되어야 함.
 * jsdom에서는 실제 마우스 이벤트를 재현할 수 없음.
 */

import { test, expect } from '@playwright/test';

// 스테이징 URL (운영에서는 실행 금지)
const STAGING_URL = 'https://myhub-staging.myhub-app.workers.dev';

test.describe('메모 저장 버튼', () => {
  test.beforeEach(async ({ page }) => {
    // 콘솔 오류 수집
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('CONSOLE ERROR:', msg.text());
      }
    });
    page.on('pageerror', err => {
      console.log('PAGE ERROR:', err.message);
    });
  });

  test('저장 버튼 클릭 시 저장 함수가 호출됨', async ({ page }) => {
    // 인증된 세션이 필요 - 수동으로 로그인한 상태의 브라우저 사용
    // 또는 스테이징 테스트 계정으로 로그인

    await page.goto(`${STAGING_URL}/memo.html`);

    // 메모 목록 로딩 대기
    await page.waitForSelector('.memo-item', { timeout: 10000 });

    // 첫 번째 메모 클릭하여 편집창 열기
    await page.click('.memo-item:first-child');

    // 편집 버튼 클릭
    await page.click('[data-act="edit"]');

    // 본문 수정
    const editor = page.locator('.pane-edit [contenteditable]');
    await editor.fill('E2E 테스트 수정 ' + Date.now());

    // 이벤트 계측: 실제 클릭 전 리스너 등록
    await page.evaluate(() => {
      (window as any).__events = [];
      const btn = document.querySelector('[data-act="save"]');
      if (btn) {
        ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'].forEach(evt => {
          btn.addEventListener(evt, () => {
            (window as any).__events.push(evt);
          });
        });
      }
    });

    // API 요청 감시
    const saveRequest = page.waitForRequest(req =>
      req.url().includes('/api/memo/') && req.method() === 'PUT',
      { timeout: 10000 }
    ).catch(() => null);

    // 실제 마우스 클릭 (programmatic click이 아님)
    await page.click('[data-act="save"]');

    // 이벤트 발생 순서 확인
    const events = await page.evaluate(() => (window as any).__events || []);
    console.log('이벤트 순서:', events);

    // click 이벤트가 발생했는지 확인
    expect(events).toContain('click');

    // API 요청이 발생했는지 확인
    const req = await saveRequest;
    expect(req).not.toBeNull();

    if (req) {
      const resp = await req.response();
      expect(resp?.status()).toBe(200);
    }
  });

  test('Ctrl+Enter로 저장됨', async ({ page }) => {
    await page.goto(`${STAGING_URL}/memo.html`);
    await page.waitForSelector('.memo-item', { timeout: 10000 });
    await page.click('.memo-item:first-child');
    await page.click('[data-act="edit"]');

    const editor = page.locator('.pane-edit [contenteditable]');
    await editor.fill('Ctrl+Enter 테스트 ' + Date.now());

    // Ctrl+Enter 키 입력
    await page.keyboard.press('Control+Enter');

    // 저장 확인 (토스트 메시지 또는 목록 갱신)
    // 실제 구현에 따라 조정 필요
    await page.waitForTimeout(2000);
  });

  test('저장 중 중복 클릭 방지', async ({ page }) => {
    // 저장 버튼을 빠르게 2회 클릭해도 API 요청은 1회만 발생해야 함
    // 구현 필요
  });
});
