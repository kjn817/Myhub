// 스튜디오 CodeMirror 지연 로딩 검증: 페이지 load 시점에는 CodeMirror 요청이
// 나가지 않고, 코드 탭 클릭 후에 동적 import()로 7개 자산이 로딩돼 에디터가
// 동작하는지 확인한다.
// (2026-11-13 성능 5라운드의 가드: 232KB를 load 경로에서 빼고 첫 코드 파일
// 열기 때만 받는다. 스크립트는 동적 import()로만 — 태그 생성은 CSP 인벤토리
// 테스트에 걸린다.)
// 원본: .scratch/perf5/probe-studio-editor.cjs + .scratch/perf4/probe-cm-import.cjs
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const PROJECT = { id: 7, title: '테스트 앱', type: 'html', status: 'draft', created_at: '2026-11-13 00:00:00' };

function artifactBody(sub) {
  if (sub === '' || sub === '/') return { data: [] };
  if (sub === '/drafts') return { ok: true, data: [PROJECT] };
  if (sub === '/jobs') return { ok: true, data: [] };
  if (sub.startsWith('/chats')) return { ok: true, data: [] };
  if (sub === '/7') return { ok: true, data: { ...PROJECT, row_revision: 1 } };
  if (sub === '/7/versions') return { ok: true, data: { versions: [{ id: 1, version_no: 1 }], draft_version_id: 1, published_version_id: null } };
  if (sub === '/7/versions/1') return { ok: true, data: { html_content: '<h1>테스트</h1>\n<p>한글 내용</p>' } };
  if (sub === '/7/versions/1/files') return { ok: true, data: [{ file_path: 'index.html', content: '<h1>테스트</h1>\n<p>한글 내용</p>' }] };
  return { ok: true, data: [] };
}

// CodeMirror 7개 자산 (CSS 2 + 코어 1 + 모드 4).
const CM_FILES = [
  'codemirror.min.css', 'material.min.css', 'codemirror.min.js',
  'xml.min.js', 'javascript.min.js', 'css.min.js', 'htmlmixed.min.js',
];

runScenario('studio-editor', async (t) => {
  const { base } = await t.server({
    onApi: async ({ path }) => {
      if (path.startsWith('/api/artifact')) {
        return { body: artifactBody(path.replace('/api/artifact', '')) };
      }
      return null;
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1440, height: 900 }, { locale: 'ko-KR' });
  const errors = attachErrorCollector(page);
  const cmRequests = [];
  page.on('request', (r) => {
    if (r.url().includes('/vendor/codemirror/')) cmRequests.push(r.url().split('/').pop());
  });

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.evaluate(() => window.MyHubDesktop.openModule('studio'));
  const frameEl = await page.waitForSelector('.dt-frame[src*="agent.html"]', { timeout: 10000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForLoadState('load', { timeout: 30000 });

  // 코드 탭 클릭 전에는 CodeMirror 요청이 0건이어야 한다 (지연 로딩의 본질).
  assertEq(cmRequests.length, 0, `스튜디오 load 시점에 CodeMirror 요청이 나가면 안 된다 (요청: ${cmRequests.join(',')})`);

  await frame.waitForSelector('.sb-item', { timeout: 10000 });
  await frame.click('.sb-item');
  await frame.waitForSelector('#tabCode', { timeout: 10000 });
  const t1 = Date.now();
  await frame.click('#tabCode');
  await frame.waitForSelector('.CodeMirror', { timeout: 20000 });
  const editorMs = Date.now() - t1;

  // 7개 자산이 전부 로딩됐는지 (파일명 집합으로 확인 — 순서가 아니라 자산 목록).
  const got = [...new Set(cmRequests)].sort();
  const want = [...CM_FILES].sort();
  assertEq(JSON.stringify(got), JSON.stringify(want), `CodeMirror 7개 자산이 전부 로딩되어야 한다 (실제: ${got.join(',')})`);

  // 에디터가 실제로 동작하는지: 인스턴스에서 파일 내용을 읽는다.
  const value = await frame.evaluate(() => {
    const el = document.querySelector('.CodeMirror');
    return el && el.CodeMirror ? el.CodeMirror.getValue() : null;
  });
  assert(value !== null, 'CodeMirror 인스턴스를 찾을 수 없다');
  assert(value.includes('테스트'), `에디터에 파일 내용이 보여야 한다 (실제: ${JSON.stringify((value || '').slice(0, 60))})`);
  console.log(`  editor ready in ${editorMs}ms, cm requests: ${cmRequests.length}`);
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
