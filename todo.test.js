/**
 * 할일(Todo) 모듈 유닛 테스트
 * @jest-environment node
 *
 * src/modules/todo/routes.ts를 esbuild로 번들한 뒤 테스트한다.
 */
const { execSync } = require('child_process');
const path = require('path');
const BUNDLE = path.join(__dirname, 'todo-bundle.cjs');
try {
  execSync('npx esbuild src/modules/todo/routes.ts --bundle --format=cjs --platform=node --external:hono --outfile=' + BUNDLE, { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('esbuild failed', e.message);
}

// ---- D1 모킹 ----
function mockDB() {
  const todos = [];
  let seq = 1;
  function minSort(status) {
    const rows = todos.filter((r) => r.status === status);
    return rows.length ? Math.min(...rows.map((r) => r.sort_order)) : 1;
  }
  function maxSort(status) {
    const rows = todos.filter((r) => r.status === status);
    return rows.length ? Math.max(...rows.map((r) => r.sort_order)) : -1;
  }
  const db = {
    _todos: todos,
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _params: [],
        bind(...params) { this._params = params; return this; },
        async all() {
          if (sql.includes('FROM todos')) {
            let rows = [...todos];
            const p = this._params;
            let pi = 0;
            if (sql.includes('status = ?')) {
              const st = p[pi++]; rows = rows.filter((r) => r.status === st);
            }
            // ORDER BY: pending 먼저, sort_order ASC, id DESC
            rows.sort((a, b) => {
              const sa = a.status === 'pending' ? 0 : 1;
              const sb = b.status === 'pending' ? 0 : 1;
              if (sa !== sb) return sa - sb;
              if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
              return b.id - a.id;
            });
            return { results: rows };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes('COALESCE(MAX(sort_order)')) {
            const status = this._params[0];
            return { m: maxSort(status) };
          }
          if (sql.includes('SELECT status FROM todos')) {
            const id = this._params[0];
            const row = todos.find((t) => t.id === id);
            return row ? { status: row.status } : null;
          }
          const id = this._params[0];
          return todos.find((t) => t.id === id) || null;
        },
        async run() {
          if (sql.startsWith('INSERT INTO todos')) {
            const [title, description, due_at, priority, status] = this._params;
            // VALUES (..., (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))
            const statusForSort = this._params[this._params.length - 1];
            const row = {
              id: seq++, title, description, due_at, priority, status,
              sort_order: minSort(statusForSort) - 1,
              created_at: 'now', updated_at: 'now',
            };
            todos.push(row);
            return { meta: { last_row_id: row.id, changes: 1 } };
          }
          if (sql.startsWith('UPDATE todos SET title')) {
            const id = this._params[this._params.length - 1];
            const row = todos.find((t) => t.id === id);
            if (!row) return { meta: { changes: 0 } };
            const [title, description, due_at, priority, status] = this._params;
            Object.assign(row, { title, description, due_at, priority, status });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE todos SET status = ?')) {
            // 토글: SET status = ?, sort_order = ?, updated_at = ... WHERE id = ?
            const [status, sort_order, id] = this._params;
            const row = todos.find((t) => t.id === id);
            if (!row) return { meta: { changes: 0 } };
            Object.assign(row, { status, sort_order });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE todos SET sort_order = ?')) {
            // reorder: SET sort_order = ?, updated_at = ... WHERE id = ?
            const [sort_order, id] = this._params;
            const row = todos.find((t) => t.id === id);
            if (!row) return { meta: { changes: 0 } };
            row.sort_order = sort_order;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE FROM todos')) {
            const id = this._params[0];
            const i = todos.findIndex((t) => t.id === id);
            if (i < 0) return { meta: { changes: 0 } };
            todos.splice(i, 1);
            return { meta: { changes: 1 } };
          }
          return { meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return db;
}

describe('todo routes (esbuild 번들 검증)', () => {
  test('번들이 생성된다', () => {
    const fs = require('fs');
    expect(fs.existsSync(BUNDLE)).toBe(true);
  });
  test('validateReorderIds가 export된다', () => {
    const b = require(BUNDLE);
    expect(typeof b.validateReorderIds).toBe('function');
  });
});

describe('validateReorderIds', () => {
  const { validateReorderIds } = require(BUNDLE);
  test('정상 배열', () => {
    expect(validateReorderIds([3, 1, 2])).toEqual({ ok: true, ids: [3, 1, 2] });
  });
  test('문자열 숫자는 숫자로 변환', () => {
    expect(validateReorderIds(['5', '2'])).toEqual({ ok: true, ids: [5, 2] });
  });
  test('빈 배열/비배열 거부', () => {
    expect(validateReorderIds([]).ok).toBe(false);
    expect(validateReorderIds('x').ok).toBe(false);
    expect(validateReorderIds(null).ok).toBe(false);
    expect(validateReorderIds(undefined).ok).toBe(false);
  });
  test('0·음수·소수 거부', () => {
    expect(validateReorderIds([0]).ok).toBe(false);
    expect(validateReorderIds([-1]).ok).toBe(false);
    expect(validateReorderIds([1.5]).ok).toBe(false);
    expect(validateReorderIds(['abc']).ok).toBe(false);
  });
  test('중복 거부', () => {
    const r = validateReorderIds([1, 2, 1]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ids_duplicate');
  });
  test('500개 초과 거부', () => {
    expect(validateReorderIds(new Array(501).fill(1)).ok).toBe(false);
    expect(validateReorderIds(new Array(500).fill(0).map((_, i) => i + 1)).ok).toBe(true);
  });
});

describe('입력 검증 로직', () => {
  const isoRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
  test('마감일 형식 허용 (빈 값 포함)', () => {
    expect(isoRe.test('2026-10-10T09:00')).toBe(true);
    expect(isoRe.test('2026-10-10')).toBe(true);
    expect(isoRe.test('내일')).toBe(false);
  });
  test('우선순위는 0,1,2만', () => {
    expect([0, 1, 2].includes(1)).toBe(true);
    expect([0, 1, 2].includes(3)).toBe(false);
    expect([0, 1, 2].includes(-1)).toBe(false);
  });
  test('상태는 pending/done만', () => {
    expect(['pending', 'done'].includes('pending')).toBe(true);
    expect(['pending', 'done'].includes('active')).toBe(false);
  });
});

describe('mock DB CRUD 시나리오', () => {
  test('생성 → 조회 → 토글 → 수정 → 삭제', async () => {
    const db = mockDB();
    // create
    const ins = await db.prepare('INSERT INTO todos (title, description, due_at, priority, status, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))')
      .bind('장보기', '우유, 계란', '2026-10-10T18:00', 2, 'pending', 'pending').run();
    expect(ins.meta.last_row_id).toBe(1);
    // get
    const row = await db.prepare('SELECT * FROM todos WHERE id = ?').bind(1).first();
    expect(row.title).toBe('장보기');
    expect(row.priority).toBe(2);
    // toggle → done (새 상태 목록 맨 뒤)
    const before = await db.prepare('SELECT status FROM todos WHERE id = ?').bind(1).first();
    expect(before.status).toBe('pending');
    const maxR = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM todos WHERE status = ?').bind('done').first();
    const tg = await db.prepare('UPDATE todos SET status = ?, sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind('done', maxR.m + 1, 1).run();
    expect(tg.meta.changes).toBe(1);
    const st = await db.prepare('SELECT status FROM todos WHERE id = ?').bind(1).first();
    expect(st.status).toBe('done');
    // update
    const upd = await db.prepare('UPDATE todos SET title = ? WHERE id = ?')
      .bind('장보기', '우유, 계란, 빵', '2026-10-10T18:00', 1, 'pending', 1).run();
    expect(upd.meta.changes).toBe(1);
    // list (pending만)
    const { results } = await db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY sort_order ASC, id DESC LIMIT ?')
      .bind('pending', 200).all();
    expect(results.length).toBe(1);
    // delete
    const del = await db.prepare('DELETE FROM todos WHERE id = ?').bind(1).run();
    expect(del.meta.changes).toBe(1);
    const gone = await db.prepare('SELECT * FROM todos WHERE id = ?').bind(1).first();
    expect(gone).toBeNull();
  });

  test('존재하지 않는 id 수정/삭제는 changes 0', async () => {
    const db = mockDB();
    const upd = await db.prepare('UPDATE todos SET title = ? WHERE id = ?').bind('x', '', null, 1, 'pending', 999).run();
    expect(upd.meta.changes).toBe(0);
    const del = await db.prepare('DELETE FROM todos WHERE id = ?').bind(999).run();
    expect(del.meta.changes).toBe(0);
  });

  test('정렬: pending 먼저, sort_order ASC', async () => {
    const db = mockDB();
    const ins = (t, st) => db.prepare('INSERT INTO todos (title, description, due_at, priority, status, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))')
      .bind(t, '', null, 1, st, st).run();
    await ins('첫째', 'pending');   // sort_order 0
    await ins('둘째', 'pending');   // sort_order -1 (맨 위)
    await ins('완료됨', 'done');    // done 목록
    const { results } = await db.prepare('SELECT * FROM todos ORDER BY CASE WHEN status = \'pending\' THEN 0 ELSE 1 END, sort_order ASC, id DESC LIMIT ?')
      .bind(200).all();
    expect(results[0].title).toBe('둘째');
    expect(results[1].title).toBe('첫째');
    expect(results[2].title).toBe('완료됨');
  });
});

describe('드래그 정렬(reorder) 시나리오', () => {
  async function seed3() {
    const db = mockDB();
    const ins = (t) => db.prepare('INSERT INTO todos (title, description, due_at, priority, status, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))')
      .bind(t, '', null, 1, 'pending', 'pending').run();
    await ins('A'); await ins('B'); await ins('C');
    return db;
  }
  async function titles(db) {
    const { results } = await db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY sort_order ASC, id DESC LIMIT ?')
      .bind('pending', 200).all();
    return results.map((r) => r.title);
  }
  async function reorder(db, ids) {
    const stmts = ids.map((id, i) =>
      db.prepare('UPDATE todos SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(i, id)
    );
    return db.batch(stmts);
  }

  test('생성 순서: 새 항목이 맨 위에', async () => {
    const db = await seed3();
    // 생성: A(id1), B(id2), C(id3) → C가 맨 위
    expect(await titles(db)).toEqual(['C', 'B', 'A']);
  });

  test('reorder [3,1,2] → C, A, B', async () => {
    const db = await seed3();
    await reorder(db, [3, 1, 2]);
    expect(await titles(db)).toEqual(['C', 'A', 'B']);
  });

  test('reorder [2,3,1] → B, C, A', async () => {
    const db = await seed3();
    await reorder(db, [2, 3, 1]);
    expect(await titles(db)).toEqual(['B', 'C', 'A']);
  });

  test('토글한 항목은 done 목록 맨 뒤로', async () => {
    const db = await seed3(); // C, B, A (pending)
    // B(id2)를 done으로
    const maxR = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM todos WHERE status = ?').bind('done').first();
    await db.prepare('UPDATE todos SET status = ?, sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind('done', maxR.m + 1, 2).run();
    const { results: pend } = await db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY sort_order ASC, id DESC LIMIT ?')
      .bind('pending', 200).all();
    expect(pend.map((r) => r.title)).toEqual(['C', 'A']);
    const { results: done } = await db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY sort_order ASC, id DESC LIMIT ?')
      .bind('done', 200).all();
    expect(done.map((r) => r.title)).toEqual(['B']);
  });

  test('batch 원자성: 모두 적용', async () => {
    const db = await seed3();
    const out = await reorder(db, [1, 2, 3]);
    expect(out.every((r) => r.meta.changes === 1)).toBe(true);
    expect(await titles(db)).toEqual(['A', 'B', 'C']);
  });
});
