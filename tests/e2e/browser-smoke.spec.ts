/**
 * 브라우저 Smoke 테스트
 * Playwright 1.64.0용
 * 
 * 실행: npx playwright test tests/e2e/browser-smoke.spec.ts
 */
import { test, expect } from '@playwright/test';

test.describe('브라우저 Smoke 테스트', () => {
  test('Chromium 실행 및 기본 DOM 조작', async ({ page, browser }) => {
    // 브라우저 버전 확인
    const version = browser.version();
    console.log(`브라우저 버전: ${version}`);
    expect(version).toBeTruthy();

    // 기본 페이지 로드
    await page.setContent('<h1 id="title">Smoke Test</h1><div id="content">Hello</div>');
    
    // DOM 요소 조회
    const title = await page.textContent('#title');
    expect(title).toBe('Smoke Test');
    
    // JavaScript 실행
    const result = await page.evaluate(() => {
      document.getElementById('content').textContent = 'Modified';
      return document.getElementById('content').textContent;
    });
    expect(result).toBe('Modified');
    
    console.log('Smoke 테스트 PASS');
  });
});
