/**
 * Track A (2026-10-29) — 플레이크 실패 자동 기록 리포터.
 *
 * 목적: 전수 실행에서 "1건만 실패하고 재실행하면 통과"하는 미특정 플레이크가
 * 발생했을 때, 실패 테스트 이름·메시지·실행 조건이 자동으로 파일에 남게 한다.
 * 기존에는 터미널 출력이 사라지면 실패 테스트명을 복원할 방법이 없었다.
 *
 * 동작:
 * - 실패가 있는 스위트만 골라 reports/flake-failures.jsonl 에 JSONL로 append.
 *   (reports/는 .gitignore 대상이라 저장소를 오염시키지 않는다.)
 * - 성공 실행에서는 아무것도 쓰지 않는다.
 * - 기록 실패(디스크 오류 등)가 테스트 실행 자체를 깨지 않도록 전부 try/catch.
 * - 시크릿·메모 본문이 섞일 수 있는 실패 메시지는 200자로 절단하고,
 *   값 자체가 아니라 테스트명·스위트 경로·조건 기록이 목적이다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

class FlakeFailureReporter {
  constructor(globalConfig) {
    this._globalConfig = globalConfig || {};
    this._failures = [];
  }

  onTestResult(_test, testResult) {
    try {
      if (!testResult) return;
      const failed = (testResult.testResults || []).filter(
        (r) => r.status === 'failed',
      );
      // 스위트 자체가 로드 실패한 경우(testResults 비어 있고 failureMessage 존재)
      if (failed.length === 0 && testResult.numFailingTests > 0) {
        this._failures.push({
          suite: testResult.testFilePath,
          test: '(suite failed to run)',
          messages: [String(testResult.failureMessage || '').slice(0, 200)],
        });
        return;
      }
      for (const r of failed) {
        this._failures.push({
          suite: testResult.testFilePath,
          test: r.fullName || r.title,
          messages: (r.failureMessages || []).map((m) =>
            String(m).replace(/\s+/g, ' ').slice(0, 200),
          ),
        });
      }
    } catch {
      /* 리포터 오류가 실행을 깨면 안 된다 */
    }
  }

  onRunComplete() {
    try {
      if (this._failures.length === 0) return;
      const dir = path.join(process.cwd(), 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const record = {
        at: new Date().toISOString(),
        pid: process.pid,
        node: process.version,
        maxWorkers: this._globalConfig.maxWorkers,
        ci: !!process.env.CI,
        loadavg: os.loadavg(),
        failures: this._failures,
      };
      fs.appendFileSync(
        path.join(dir, 'flake-failures.jsonl'),
        JSON.stringify(record) + '\n',
      );
    } catch {
      /* 기록 실패는 무시 — 본 실행 결과가 우선 */
    }
  }
}

module.exports = FlakeFailureReporter;
