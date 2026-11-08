/**
 * 오늘 브리핑 모듈 유닛 테스트
 * @jest-environment node
 *
 * src/modules/briefing/routes.ts를 esbuild로 번들한 뒤 테스트한다.
 */
const { execSync } = require('child_process');
const path = require('path');
const BUNDLE = path.join(__dirname, 'briefing-bundle.cjs');
try {
  execSync('npx esbuild src/modules/briefing/routes.ts --bundle --format=cjs --platform=node --external:hono --outfile=' + BUNDLE, { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('esbuild failed', e.message);
}
const { briefingApp } = require('./briefing-bundle.cjs');

// ---- D1 모킹 ----
function mockDB(schedules, todos) {
  return {
    prepare(sql) {
      const self = this;
      return {
        _sql: sql,
        _params: [],
        bind(...params) { this._params = params; return this; },
        async all() {
          if (sql.includes('FROM schedules')) {
            // 라우트는 KST 범위 쿼리: start_at >= ? AND start_at < ? (파라미터 2개)
            const [start, end] = this._params;
            const rows = schedules.filter(
              (s) => s.start_at >= start && (!end || s.start_at < end) && s.status === 'active'
            );
            rows.sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
            return { results: rows };
          }
          if (sql.includes('FROM todos')) {
            const rows = todos
              .filter((t) => t.status === 'pending')
              .sort((a, b) => b.priority - a.priority || (a.id < b.id ? 1 : -1));
            return { results: rows.slice(0, 10) };
          }
          return { results: [] };
        },
      };
    },
  };
}

// Hono 앱을 직접 호출하기 위한 최소 컨텍스트
// (실제 마운트는 app.route('/api/briefing', briefingApp)이므로 여기서는 /today로 호출)
async function callToday(db) {
  const req = new Request('http://localhost/today');
  const res = await briefingApp.fetch(req, { DB: db });
  return { status: res.status, body: await res.json() };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('GET /api/briefing/today', () => {
  test('오늘 일정과 미완료 할일을 반환', async () => {
    const today = todayStr();
    const db = mockDB(
      [
        { id: 1, title: '치과', start_at: `${today}T15:00:00`, end_at: null, location: '강남', status: 'active' },
        { id: 2, title: '내일 회의', start_at: '2099-01-01T10:00:00', end_at: null, location: '', status: 'active' },
        { id: 3, title: '취소된 일정', start_at: `${today}T18:00:00`, end_at: null, location: '', status: 'cancelled' },
      ],
      [
        { id: 1, title: '우유 사기', due_at: null, priority: 2, status: 'pending' },
        { id: 2, title: '완료된 일', due_at: null, priority: 1, status: 'done' },
        { id: 3, title: '보고서', due_at: null, priority: 0, status: 'pending' },
      ]
    );
    const { status, body } = await callToday(db);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.date).toBe(today);
    // 오늘 active 일정만 1개
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].title).toBe('치과');
    // pending 할일만 2개, 우선순위 높은 순
    expect(body.todos).toHaveLength(2);
    expect(body.todos[0].title).toBe('우유 사기');
    expect(body.todos[0].priority).toBe(2);
    // counts에는 메모/기억 섹션도 포함됨 (라우트 변경 반영)
    expect(body.counts).toEqual({ schedules: 1, todos: 2, memos: 0, memories: 0 });
  });

  test('빈 결과도 정상 구조로 반환', async () => {
    const db = mockDB([], []);
    const { status, body } = await callToday(db);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.schedules).toEqual([]);
    expect(body.todos).toEqual([]);
    expect(body.counts).toEqual({ schedules: 0, todos: 0, memos: 0, memories: 0 });
    expect(typeof body.date).toBe('string');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(body.date)).toBe(true);
  });

  test('할일은 최대 10개까지만', async () => {
    const todos = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1, title: `할일 ${i + 1}`, due_at: null, priority: 1, status: 'pending',
    }));
    const db = mockDB([], todos);
    const { body } = await callToday(db);
    expect(body.todos).toHaveLength(10);
    expect(body.counts.todos).toBe(10);
  });

  test('일정은 시작 시간순으로 정렬', async () => {
    const today = todayStr();
    const db = mockDB(
      [
        { id: 1, title: '저녁 약속', start_at: `${today}T19:00:00`, end_at: null, location: '', status: 'active' },
        { id: 2, title: '아침 운동', start_at: `${today}T07:00:00`, end_at: null, location: '', status: 'active' },
        { id: 3, title: '점심', start_at: `${today}T12:00:00`, end_at: null, location: '', status: 'active' },
      ],
      []
    );
    const { body } = await callToday(db);
    expect(body.schedules.map((s) => s.title)).toEqual(['아침 운동', '점심', '저녁 약속']);
  });
});
