/**
 * jest-flake-reporter.cjs 검증 (Track A, 2026-10-29)
 *
 * 성질: 실패한 테스트가 있으면 이름·스위트·실패 메시지가
 * reports/flake-failures.jsonl 에 기록되고, 실패가 없으면 파일이 생기지 않는다.
 * 리포터 기록 로직이 깨지면(예: onTestResult가 실패를 수집하지 않음) 이 테스트가 실패한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const Reporter = require('../jest-flake-reporter.cjs');

describe('jest-flake-reporter', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-reporter-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const failedResult = () => ({
    testFilePath: '/repo/tests/unit/some.test.ts',
    numFailingTests: 1,
    testResults: [
      { status: 'passed', fullName: 'suite passes', failureMessages: [] },
      {
        status: 'failed',
        fullName: 'suite flaky case',
        failureMessages: ['Error: expected 1 to be 2\n    at Object.<anonymous>'],
      },
    ],
  });

  test('실패 테스트가 있으면 이름·조건이 jsonl로 기록된다', () => {
    const r = new Reporter({ maxWorkers: 2 });
    r.onTestResult({}, failedResult(), {});
    r.onRunComplete();

    const file = path.join(tmpDir, 'reports', 'flake-failures.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.maxWorkers).toBe(2);
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].suite).toBe('/repo/tests/unit/some.test.ts');
    expect(rec.failures[0].test).toBe('suite flaky case');
    expect(rec.failures[0].messages[0]).toContain('expected 1 to be 2');
  });

  test('실패가 없으면 파일을 만들지 않는다', () => {
    const r = new Reporter({ maxWorkers: 2 });
    r.onTestResult(
      {},
      {
        testFilePath: '/repo/tests/unit/ok.test.ts',
        numFailingTests: 0,
        testResults: [{ status: 'passed', fullName: 'ok', failureMessages: [] }],
      },
      {},
    );
    r.onRunComplete();
    expect(fs.existsSync(path.join(tmpDir, 'reports'))).toBe(false);
  });

  test('스위트 로드 실패(testResults 없음)도 기록된다', () => {
    const r = new Reporter({});
    r.onTestResult(
      {},
      {
        testFilePath: '/repo/tests/unit/broken.test.ts',
        numFailingTests: 1,
        testResults: [],
        failureMessage: 'SyntaxError: boom',
      },
      {},
    );
    r.onRunComplete();
    const file = path.join(tmpDir, 'reports', 'flake-failures.jsonl');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(rec.failures[0].test).toBe('(suite failed to run)');
    expect(rec.failures[0].messages[0]).toContain('SyntaxError: boom');
  });
});
