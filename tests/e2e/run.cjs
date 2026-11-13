// 실브라우저 e2e 스위트 러너: tests/e2e/*.e2e.cjs를 순차 실행한다.
// (병렬이면 CPU 경합으로 타이밍·수치가 오염된다.)
// 사용법:
//   node tests/e2e/run.cjs            — 전수 실행
//   node tests/e2e/run.cjs <부분 문자열> — 이름이 일치하는 시나리오만 실행
//   npm run test:e2e
// 하나라도 실패하면 종료코드 1.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const PER_SCENARIO_TIMEOUT_MS = 300000;

const filter = process.argv[2] || '';
const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.e2e.cjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`실행할 시나리오가 없습니다 (필터: ${JSON.stringify(filter)})`);
  process.exit(2);
}

const results = [];
for (const file of files) {
  const name = file.replace(/\.e2e\.cjs$/, '');
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(HERE, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: PER_SCENARIO_TIMEOUT_MS,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ name, ok, ms, status: r.status, signal: r.signal || null, error: r.error ? String(r.error.message) : null });
  if (!ok) {
    console.error(`  [${name}] 종료코드 ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}${r.error ? ` — ${r.error.message}` : ''}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const total = results.reduce((s, r) => s + r.ms, 0);
console.log('');
console.log('=== e2e summary ===');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
}
console.log(`  ${passed}/${results.length} passed, total ${(total / 1000).toFixed(1)}s`);
process.exit(passed === results.length ? 0 : 1);
