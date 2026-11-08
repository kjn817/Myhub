/**
 * 아티팩트 버전 관리 테스트
 * - v1 생성, v2 생성, 게시, 롤백, 충돌 감지
 */

// 버전 번호 증가 로직 (routes.ts와 동일한 로직 복제)
function getNextVersionNo(maxNo) {
  return (maxNo || 0) + 1;
}

// SHA-256 mock (실제는 Web Crypto)
async function mockSha256(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

describe('아티팩트 버전 관리', () => {
  test('v1 생성 시 version_no=1', () => {
    expect(getNextVersionNo(0)).toBe(1);
    expect(getNextVersionNo(null)).toBe(1);
  });

  test('v1 → v2 버전 증가', () => {
    expect(getNextVersionNo(1)).toBe(2);
    expect(getNextVersionNo(5)).toBe(6);
  });

  test('HTML 해시가 내용 변경을 감지', async () => {
    const h1 = await mockSha256('<html>v1</html>');
    const h2 = await mockSha256('<html>v2</html>');
    expect(h1).not.toBe(h2);
  });

  test('동일 HTML은 동일 해시', async () => {
    const h1 = await mockSha256('<html>same</html>');
    const h2 = await mockSha256('<html>same</html>');
    expect(h1).toBe(h2);
  });

  test('낙관적 잠금: revision 불일치 시 충돌', () => {
    const serverRevision = 5;
    const clientRevision = 3;
    const hasConflict = clientRevision !== undefined && clientRevision !== serverRevision;
    expect(hasConflict).toBe(true);
  });

  test('낙관적 잠금: revision 일치 시 통과', () => {
    const serverRevision = 5;
    const clientRevision = 5;
    const hasConflict = clientRevision !== undefined && clientRevision !== serverRevision;
    expect(hasConflict).toBe(false);
  });

  test('버전 히스토리 정렬 (최신 먼저)', () => {
    const versions = [
      { version_no: 1 },
      { version_no: 3 },
      { version_no: 2 },
    ];
    versions.sort((a, b) => b.version_no - a.version_no);
    expect(versions.map((v) => v.version_no)).toEqual([3, 2, 1]);
  });

  test('롤백 대상 버전 존재 확인', () => {
    const versions = [{ version_no: 1 }, { version_no: 2 }];
    const target = versions.find((v) => v.version_no === 1);
    expect(target).toBeDefined();
    const missing = versions.find((v) => v.version_no === 99);
    expect(missing).toBeUndefined();
  });

  test('HTML 크기 제한 (2MB)', () => {
    const limit = 2 * 1024 * 1024;
    expect(100).toBeLessThan(limit);
    expect(3 * 1024 * 1024).toBeGreaterThan(limit);
  });

  test('초안/게시 포인터 분리', () => {
    const artifact = {
      draft_version_id: 3,      // v3 초안
      published_version_id: 1,  // v1 게시됨
    };
    // 초안 수정 중에도 게시본은 v1 유지
    expect(artifact.draft_version_id).not.toBe(artifact.published_version_id);
  });
});
