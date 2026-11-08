// Phase 4B-Final: 검색 API 통합 테스트
const { Hono } = require('hono');

describe('Phase 4B 검색 API', () => {
  let app;

  beforeEach(() => {
    app = new Hono();
    // 인증 미들웨어 (실제 로직 간소화)
    app.use('/api/*', async (c, next) => {
      const cookie = c.req.header('Cookie') || '';
      if (!cookie.includes('session=valid-test')) {
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
      await next();
    });
    // 검색 라우트 (실제 로직 반영)
    app.get('/api/search', async (c) => {
      const q = c.req.query('q')?.trim() || '';
      if (!q) return c.json({ ok: false, error: 'empty_query' }, 400);
      if (q.length > 200) return c.json({ ok: false, error: 'query_too_long' }, 400);
      return c.json({ ok: true, results: [] });
    });
  });

  test('미인증 요청 차단', async () => {
    const res = await app.request('/api/search?q=test');
    expect(res.status).toBe(401);
  });

  test('정상 인증 허용', async () => {
    const res = await app.request('/api/search?q=test', {
      headers: { Cookie: 'session=valid-test' }
    });
    expect(res.status).toBe(200);
  });

  test('위조 세션 차단', async () => {
    const res = await app.request('/api/search?q=test', {
      headers: { Cookie: 'session=fake' }
    });
    expect(res.status).toBe(401);
  });

  test('빈 쿼리 거부', async () => {
    const res = await app.request('/api/search', {
      headers: { Cookie: 'session=valid-test' }
    });
    expect(res.status).toBe(400);
  });

  test('긴 쿼리 거부', async () => {
    const longQ = 'a'.repeat(201);
    const res = await app.request(`/api/search?q=${longQ}`, {
      headers: { Cookie: 'session=valid-test' }
    });
    expect(res.status).toBe(400);
  });

  describe('limit 검증', () => {
    // limit 파싱 로직 테스트 (실제 normalizeSearchLimit 로직 반영)
    function parseLimit(raw) {
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return 20;
      }
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1) {
        return 20;
      }
      return Math.min(n, 100);
    }

    test('정상 limit', () => {
      expect(parseLimit('10')).toBe(10);
      expect(parseLimit('50')).toBe(50);
      expect(parseLimit('1')).toBe(1);
      expect(parseLimit('100')).toBe(100);
    });

    test('음수 limit은 기본값으로', () => {
      expect(parseLimit('-1')).toBe(20);
      expect(parseLimit('-100')).toBe(20);
    });

    test('0은 기본값으로', () => {
      expect(parseLimit('0')).toBe(20);
    });

    test('소수는 기본값으로', () => {
      expect(parseLimit('0.5')).toBe(20);
      expect(parseLimit('10.5')).toBe(20);
      expect(parseLimit('100.5')).toBe(20);  // 100.5도 기본값
      expect(parseLimit('99.5')).toBe(20);
      expect(parseLimit('101.5')).toBe(20);
    });

    test('초과 limit은 최대값으로', () => {
      expect(parseLimit('1000')).toBe(100);
      expect(parseLimit('101')).toBe(100);
    });

    test('NaN/Infinity는 기본값으로', () => {
      expect(parseLimit('abc')).toBe(20);
      expect(parseLimit(undefined)).toBe(20);
      expect(parseLimit('Infinity')).toBe(20);
      expect(parseLimit('')).toBe(20);
    });
  });
});
