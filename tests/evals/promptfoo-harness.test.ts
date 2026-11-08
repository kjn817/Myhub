/// <reference types="jest" />

// promptfoo CLI 배선 테스트 — 라이브 호출 없음 (mock 프로바이더 설정만 사용).
// - promptfooconfig.validate.yaml: 전 케이스 PASS → 종료 코드 0
// - promptfooconfig.validate-stale.yaml: 오래된 뉴스 픽스처 → 반드시 실패 (0이 아님)
// 환경변수 MYHUB_EVAL_SKIP_PROMPTFOO_CLI=1이면 건너뛴다.

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP = process.env.MYHUB_EVAL_SKIP_PROMPTFOO_CLI === '1';

function runPromptfoo(config: string) {
  const outFile = join(tmpdir(), `promptfoo-harness-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(
    'npx',
    ['promptfoo', 'eval', '--config', config, '--no-cache', '--output', outFile],
    { cwd: join(__dirname, '..', '..'), encoding: 'utf-8', timeout: 180000 },
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', outFile };
}

describe('promptfoo harness wiring (mock, no live calls)', () => {
  test('validate 설정: 전 케이스 PASS (종료 코드 0)', () => {
    if (SKIP) {
      console.log('MYHUB_EVAL_SKIP_PROMPTFOO_CLI=1 — skipped');
      return;
    }
    const r = runPromptfoo('tests/evals/promptfooconfig.validate.yaml');
    if (r.status !== 0) {
      console.log('STDOUT:', r.stdout.slice(-3000));
      console.log('STDERR:', r.stderr.slice(-3000));
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/6 passed|Tests passed|PASS/i);
  }, 200000);

  test('stale 음성 대조군: 오래된 뉴스는 반드시 FAIL (종료 코드 0이 아님)', () => {
    if (SKIP) {
      console.log('MYHUB_EVAL_SKIP_PROMPTFOO_CLI=1 — skipped');
      return;
    }
    const r = runPromptfoo('tests/evals/promptfooconfig.validate-stale.yaml');
    expect(r.status).not.toBe(0);
  }, 200000);
});
