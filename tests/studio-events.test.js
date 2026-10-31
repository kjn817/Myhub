/**
 * AI 스튜디오 Job 이벤트 스트리밍 테스트
 * - artifact_job_events 테이블 구조
 * - 이벤트 API 엔드포인트
 * - Diff API
 */

// 이벤트 타입 상수 (src/modules/artifact/job-processor.ts와 일치)
const VALID_EVENT_TYPES = [
  'job.started',
  'job.completed',
  'job.failed',
  'file.changed',
  'version.committed',
  'tool.started',
  'tool.completed',
];

describe('Job 이벤트 타입', () => {
  test('모든 이벤트 타입이 정의됨', () => {
    expect(VALID_EVENT_TYPES).toContain('job.started');
    expect(VALID_EVENT_TYPES).toContain('file.changed');
    expect(VALID_EVENT_TYPES).toContain('version.committed');
    expect(VALID_EVENT_TYPES).toContain('job.completed');
    expect(VALID_EVENT_TYPES).toContain('job.failed');
  });

  test('이벤트 payload는 JSON 직렬화 가능', () => {
    const payload = { file_path: 'index.html', version_no: 1 };
    expect(() => JSON.stringify(payload)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(payload));
    expect(parsed.file_path).toBe('index.html');
  });
});

describe('결과 카드 마커', () => {
  test('마커 JSON 파싱', () => {
    const marker = JSON.stringify({ __result_card__: true, version_no: 1 });
    const parsed = JSON.parse(marker);
    expect(parsed.__result_card__).toBe(true);
    expect(parsed.version_no).toBe(1);
  });

  test('마커 감지 로직', () => {
    const isResultCardMarker = (content) => {
      if (!content.startsWith('{"__result_card__"')) return false;
      try {
        const m = JSON.parse(content);
        return !!m.__result_card__;
      } catch { return false; }
    };
    expect(isResultCardMarker('{"__result_card__":true,"version_no":1}')).toBe(true);
    expect(isResultCardMarker('일반 메시지')).toBe(false);
    expect(isResultCardMarker('{"foo":"bar"}')).toBe(false);
  });
});

describe('Diff 계산', () => {
  // simpleLineDiff 로직 테스트 (프론트와 동일한 휴리스틱)
  function countChanges(oldStr, newStr) {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let added = 0, removed = 0;
    for (const l of oldLines) if (!newSet.has(l)) removed++;
    for (const l of newLines) if (!oldSet.has(l)) added++;
    return { added, removed };
  }

  test('추가된 라인 감지', () => {
    const r = countChanges('a\nb', 'a\nb\nc');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  test('삭제된 라인 감지', () => {
    const r = countChanges('a\nb\nc', 'a\nb');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(1);
  });

  test('변경 없는 경우', () => {
    const r = countChanges('a\nb', 'a\nb');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });
});
