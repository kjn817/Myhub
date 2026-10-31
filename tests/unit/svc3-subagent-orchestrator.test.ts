/// <reference types="jest" />
/**
 * src/services/subagent-orchestrator.ts 테스트
 * DelegationManifest, 토폴로지 계획, 구조화 요약, 위임 검증
 */

import {
  createManifest,
  planTopology,
  createSummary,
  validateDelegation,
  type DelegationManifest,
} from '../../src/services/subagent-orchestrator';

describe('createManifest', () => {
  test('lumi 비서의 기본 제약을 포함한다', () => {
    const m = createManifest('메모를 검색해줘', 'lumi', 'req-1');
    expect(m.objective).toBe('메모를 검색해줘');
    expect(m.constraints).toContain('개인정보 마스킹 유지');
    expect(m.constraints).toContain('잠긴 메모 접근 금지');
    expect(m.maxTokens).toBe(4000);
    expect(m.allowedTools).toEqual([]);
    expect(m.parentRequestId).toBe('req-1');
  });

  test('echo 비서의 기본 제약', () => {
    const m = createManifest('요약해줘', 'echo', 'req-2');
    expect(m.constraints).toContain('요약은 원문 기반');
    expect(m.constraints).toContain('추측 금지');
  });

  test('nova 비서의 기본 제약', () => {
    const m = createManifest('앱을 만들어줘', 'nova', 'req-3');
    expect(m.constraints).toContain('생성 코드는 실행 가능해야 함');
    expect(m.constraints).toContain('보안 취약점 금지');
  });

  test('cali 비서의 기본 제약', () => {
    const m = createManifest('일정을 등록해줘', 'cali', 'req-4');
    expect(m.constraints).toContain('일정 중복 확인');
  });

  test('context를 전달하면 포함된다', () => {
    const m = createManifest('작업해줘', 'lumi', 'req-5', { foo: 'bar' });
    expect(m.context).toEqual({ foo: 'bar' });
  });

  test('context 기본값은 빈 객체', () => {
    const m = createManifest('작업해줘', 'lumi', 'req-6');
    expect(m.context).toEqual({});
  });

  test('알 수 없는 persona는 빈 제약', () => {
    const m = createManifest('작업해줘', 'unknown' as any, 'req-7');
    expect(m.constraints).toEqual([]);
  });
});

describe('planTopology', () => {
  test('단일 작업은 hub-and-spoke', () => {
    const plan = planTopology([{ persona: 'lumi', objective: '메모를 검색해줘' }], 'req-1');
    expect(plan.topology).toBe('hub-and-spoke');
    expect(plan.reason).toBe('단일 작업');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('task-0');
    expect(plan.tasks[0].dependsOn).toBeUndefined();
  });

  test('서로 다른 비서의 독립 작업은 parallel', () => {
    const plan = planTopology(
      [
        { persona: 'lumi', objective: '메모를 검색해줘' },
        { persona: 'cali', objective: '일정을 조회해줘' },
      ],
      'req-2'
    );
    expect(plan.topology).toBe('parallel');
    expect(plan.reason).toBe('독립 작업 병렬 실행');
    expect(plan.tasks).toHaveLength(2);
  });

  test('의존성 힌트 키워드가 있으면 sequential', () => {
    const plan = planTopology(
      [
        { persona: 'nova', objective: '앱을 만들어줘' },
        { persona: 'nova', objective: '완료 후 테스트해줘' },
      ],
      'req-3'
    );
    expect(plan.topology).toBe('sequential');
    expect(plan.reason).toBe('순서 의존성 감지');
    // sequential에서는 두 번째 작업이 첫 번째에 의존
    expect(plan.tasks[1].dependsOn).toEqual(['task-0']);
    expect(plan.tasks[0].dependsOn).toBeUndefined();
  });

  test('같은 비서 + 의존성 힌트 없음 → hub-and-spoke', () => {
    const plan = planTopology(
      [
        { persona: 'lumi', objective: '메모 A를 검색해줘' },
        { persona: 'lumi', objective: '메모 B를 검색해줘' },
      ],
      'req-4'
    );
    expect(plan.topology).toBe('hub-and-spoke');
    expect(plan.reason).toBe('중앙 오케스트레이션');
  });

  test('같은 비서 + 의존성 힌트 있음 → sequential', () => {
    const plan = planTopology(
      [
        { persona: 'lumi', objective: '메모를 찾아줘' },
        { persona: 'lumi', objective: '그 다음 요약해줘' },
      ],
      'req-5'
    );
    expect(plan.topology).toBe('sequential');
  });

  test('각 task에 manifest가 생성된다', () => {
    const plan = planTopology([{ persona: 'echo', objective: '요약해줘' }], 'req-parent');
    expect(plan.tasks[0].manifest.objective).toBe('요약해줘');
    expect(plan.tasks[0].manifest.parentRequestId).toBe('req-parent');
    expect(plan.tasks[0].persona).toBe('echo');
  });

  test('빈 작업 배열도 처리된다', () => {
    const plan = planTopology([], 'req-empty');
    expect(plan.tasks).toHaveLength(0);
  });
});

describe('createSummary', () => {
  test('처음 3줄을 요약으로 사용한다', () => {
    const s = createSummary('line1\nline2\nline3\nline4');
    expect(s.summary).toContain('line1');
    expect(s.summary).toContain('line2');
    expect(s.summary).toContain('line3');
  });

  test('maxLength로 잘린다', () => {
    const s = createSummary('a'.repeat(1000), 100);
    expect(s.summary.length).toBeLessThanOrEqual(100);
  });

  test('불릿 포인트를 keyPoints로 추출한다', () => {
    const s = createSummary('- point1\n- point2\n일반 텍스트');
    expect(s.keyPoints).toContain('- point1');
    expect(s.keyPoints).toContain('- point2');
  });

  test('콜론 포함 줄도 keyPoints로 추출', () => {
    const s = createSummary('결과: 성공\n일반');
    expect(s.keyPoints.some((k) => k.includes('결과:'))).toBe(true);
  });

  test('keyPoints는 최대 5개', () => {
    const s = createSummary('- a\n- b\n- c\n- d\n- e\n- f\n- g');
    expect(s.keyPoints.length).toBeLessThanOrEqual(5);
  });

  test('error 포함 시 success=false', () => {
    expect(createSummary('something error happened').success).toBe(false);
    expect(createSummary('ERROR occurred').success).toBe(false);
  });

  test('실패 포함 시 success=false', () => {
    expect(createSummary('작업 실패').success).toBe(false);
  });

  test('정상 결과는 success=true', () => {
    expect(createSummary('작업 완료').success).toBe(true);
  });

  test('빈 문자열도 처리된다', () => {
    const s = createSummary('');
    expect(s.summary).toBe('');
    expect(s.keyPoints).toEqual([]);
    expect(s.success).toBe(true);
  });

  test('빈 줄은 필터링된다', () => {
    const s = createSummary('line1\n\n\nline2');
    expect(s.summary).toContain('line1');
    expect(s.summary).toContain('line2');
  });
});

describe('validateDelegation', () => {
  const baseManifest = (): DelegationManifest => ({
    objective: '메모를 검색하고 요약해줘',
    constraints: [],
    maxTokens: 4000,
    allowedTools: [],
    context: {},
    parentRequestId: 'req-1',
  });

  test('정상 manifest는 위반 없음', () => {
    expect(validateDelegation(baseManifest())).toEqual([]);
  });

  test('목표가 10자 미만이면 위반', () => {
    const m = baseManifest();
    m.objective = '해줘';
    const v = validateDelegation(m);
    expect(v.some((x) => x.includes('10자'))).toBe(true);
  });

  test('목표가 비어있으면 위반', () => {
    const m = baseManifest();
    m.objective = '';
    const v = validateDelegation(m);
    expect(v.length).toBeGreaterThan(0);
  });

  test('"이것 고쳐" 패턴은 위반', () => {
    const m = baseManifest();
    m.objective = '이것 고쳐';
    const v = validateDelegation(m);
    expect(v.some((x) => x.includes('모호한'))).toBe(true);
  });

  test('"그것 해줘" 패턴은 위반', () => {
    const m = baseManifest();
    m.objective = '그것 해줘';
    const v = validateDelegation(m);
    expect(v.some((x) => x.includes('모호한'))).toBe(true);
  });

  test('컨텍스트 10000자 초과 시 위반', () => {
    const m = baseManifest();
    m.context = { big: 'x'.repeat(10001) };
    const v = validateDelegation(m);
    expect(v.some((x) => x.includes('컨텍스트 과다'))).toBe(true);
  });

  test('컨텍스트가 정확히 제한 내면 위반 없음', () => {
    const m = baseManifest();
    m.context = { small: 'x'.repeat(100) };
    expect(validateDelegation(m)).toEqual([]);
  });

  test('토큰 예산 8000 초과 시 위반', () => {
    const m = baseManifest();
    m.maxTokens = 9000;
    const v = validateDelegation(m);
    expect(v.some((x) => x.includes('토큰 예산'))).toBe(true);
  });

  test('토큰 예산 8000은 위반 없음', () => {
    const m = baseManifest();
    m.maxTokens = 8000;
    expect(validateDelegation(m)).toEqual([]);
  });

  test('여러 위반을 모두 반환한다', () => {
    const m = baseManifest();
    m.objective = '해줘';
    m.maxTokens = 9000;
    const v = validateDelegation(m);
    expect(v.length).toBeGreaterThanOrEqual(2);
  });
});
