/**
 * MEMO-001: 이중 선택 영역 복원 재현 테스트
 * Playwright 1.64.0용
 * 
 * 실행: npx playwright test tests/e2e/memo-lock.spec.ts
 */
import { test, expect } from '@playwright/test';

test.describe('MEMO-001: 선택 영역 복원', () => {
  test.beforeEach(async ({ page }) => {
    // 테스트 페이지 설정 (실제 memo-bundle.js 사용 시 URL 변경)
    await page.setContent(`
      <div id="editor" contenteditable="true" style="min-height:100px;border:1px solid #ccc;padding:10px;">
        테스트 텍스트입니다. 선택 영역 복원을 테스트합니다.
      </div>
      <div id="result"></div>
      <script>
        window.selectionChangeCount = 0;
        window.restoreSelCount = 0;
        document.addEventListener('selectionchange', () => {
          window.selectionChangeCount++;
          if (window.selectionChangeCount > 100) {
            throw new Error('selectionchange 무한 루프!');
          }
        });
        window.restoreSel = function(range) {
          window.restoreSelCount++;
          const editor = document.getElementById('editor');
          editor.focus();
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range.cloneRange());
        };
      </script>
    `);
  });

  test('TEST-01: restoreSel 1회', async ({ page }) => {
    const result = await page.evaluate(() => {
      const editor = document.getElementById('editor');
      const range = document.createRange();
      range.selectNodeContents(editor);
      window.selectionChangeCount = 0;
      window.restoreSel(range.cloneRange());
      return {
        restoreCalls: window.restoreSelCount,
        changeCount: window.selectionChangeCount,
      };
    });
    
    console.log(`restoreSel: ${result.restoreCalls}회, selectionchange: ${result.changeCount}회`);
    expect(result.changeCount).toBeLessThan(10);
  });

  test('TEST-04: restoreSel 2회 (이중 복원)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const editor = document.getElementById('editor');
      const range = document.createRange();
      range.selectNodeContents(editor);
      const saved = range.cloneRange();
      window.selectionChangeCount = 0;
      window.restoreSelCount = 0;
      // btn() 래퍼 + 잠금 핸들러 이중 호출 시뮬레이션
      window.restoreSel(saved);
      window.restoreSel(saved);
      return {
        restoreCalls: window.restoreSelCount,
        changeCount: window.selectionChangeCount,
      };
    });
    
    console.log(`이중 복원 - restoreSel: ${result.restoreCalls}회, selectionchange: ${result.changeCount}회`);
    // 이중 복원 시에도 이벤트가 폭증하지 않아야 함
    expect(result.changeCount).toBeLessThan(20);
  });
});
