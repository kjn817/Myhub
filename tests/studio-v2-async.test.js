/**
 * AI 스튜디오 v2 'Failed to fetch' 수정 계약 테스트
 * - POST /api/artifact/jobs: Queue 비동기 처리 (202 + jobId 즉시 반환)
 * - 에이전트 루프 전체 시간 예산 (wall-clock budget)
 * - modify 경로에서도 멀티파일 저장
 * - 프론트: callAiJob 즉시 반환 + pollJob 폴링
 *
 * 배경: 직접 모드(await processArtifactJob)는 HTTP 응답이 에이전트 완료까지
 * 블로킹되어 수 분간 유휴 상태가 되면 브라우저가 연결을 끊고
 * fetch()가 TypeError: Failed to fetch를 throw (2026-10-15 진단).
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const PUBLIC = path.join(__dirname, '..', 'public');

function read(p) {
  return fs.readFileSync(p, 'utf-8');
}

describe('POST /api/artifact/jobs 비동기 계약', () => {
  const routes = read(path.join(SRC, 'modules', 'artifact', 'routes.ts'));

  test('직접 모드 블로킹 호출이 제거됨', () => {
    // 라우트 핸들러에서 processArtifactJob을 await하면 안 됨
    // (Queue Consumer가 처리)
    const jobsHandler = routes.slice(
      routes.indexOf("artifactApp.post('/jobs'"),
      routes.indexOf('// 작업 상태 조회')
    );
    expect(jobsHandler).not.toMatch(/await\s+processArtifactJob/);
  });

  test('ARTIFACT_QUEUE로 전송 후 202 반환', () => {
    expect(routes).toMatch(/ARTIFACT_QUEUE\.send\(\{\s*jobId\s*\}\)/);
    expect(routes).toMatch(/return c\.json\(\{\s*ok:\s*true,\s*data:\s*\{\s*jobId\s*\}\s*\},\s*202\)/);
  });

  test('큐 전송 실패 시 job을 failed로 기록', () => {
    expect(routes).toMatch(/큐 전송 실패/);
  });
});

describe('에이전트 전체 시간 예산', () => {
  const agent = read(path.join(SRC, 'services', 'studio-agent.ts'));

  test('wallClockBudgetMs 옵션이 정의됨', () => {
    expect(agent).toMatch(/wallClockBudgetMs\?:\s*number/);
  });

  test('루프 시작 전 예산 체크', () => {
    expect(agent).toMatch(/WALL_CLOCK_BUDGET_MS/);
    expect(agent).toMatch(/Date\.now\(\)\s*-\s*loopStart\s*>\s*WALL_CLOCK_BUDGET_MS/);
  });

  test('예산 초과 시 정상 실패 반환 (AGENT_WALL_CLOCK_BUDGET)', () => {
    expect(agent).toMatch(/AGENT_WALL_CLOCK_BUDGET/);
    // 전송 kill 대신 JSON 오류 반환
    expect(agent).toMatch(/ok:\s*false/);
  });

  test('기본 예산 5분 (사용자 기준 "5분 넘으면 의미없지")', () => {
    expect(agent).toMatch(/5\s*\*\s*60\s*\*\s*1000/);
  });
});

describe('modify 경로 멀티파일 저장', () => {
  const processor = read(path.join(SRC, 'modules', 'artifact', 'job-processor.ts'));

  test('modify 분기에서도 saveWorkspaceToD1 호출', () => {
    // modify 분기 (} else if (job.kind === 'modify')) 내에 saveJobResult 연결 + saveWorkspaceToD1이 있어야 함
    const modifyBranch = processor.slice(
      processor.indexOf("} else if (job.kind === 'modify'"),
      processor.indexOf('// 4. 실패 기록')
    );
    expect(modifyBranch).toMatch(/saveJobResult\(env,\s*jobId/);
    expect(modifyBranch).toMatch(/saveWorkspaceToD1/);
  });
});

describe('프론트 비동기 폴링 계약', () => {
  const html = read(path.join(PUBLIC, 'agent.html'));

  test('callAiJob이 jobId를 즉시 반환', () => {
    const fn = html.slice(
      html.indexOf('async function callAiJob'),
      html.indexOf('// ===== 작업 단계 시각화')
    );
    // 전체 결과를 await하지 않음
    expect(fn).not.toMatch(/jr\.status === 'done'/);
    expect(fn).toMatch(/return \{\s*jobId:\s*jr\.data\.jobId\s*\}/);
  });

  test('sendChat이 pollJob으로 완료 대기', () => {
    expect(html).toMatch(/pollJob\(d\.jobId/);
  });

  test('pollJob이 완료/실패 콜백을 지원', () => {
    expect(html).toMatch(/async function pollJob\(jobId,\s*onDone,\s*onFailed\)/);
  });

  test('작업 중에는 중단 버튼 유지 (finally에서 복원 생략)', () => {
    expect(html).toMatch(/jobStarted/);
    expect(html).toMatch(/if \(!jobStarted\) resetSendButton\(\)/);
  });
});
