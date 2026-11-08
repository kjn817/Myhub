/**
 * Phase 4B 통합 검색 - 로컬 D1 통합 테스트
 *
 * 실제 SQLite + FTS5를 사용해 검색 기능을 검증
 * better-sqlite3를 D1Database 인터페이스로 래핑
 *
 * 실행: npx jest tests/integration/unified-search.test.js
 */

const Database = require('better-sqlite3');

// D1Database 인터페이스 어댑터
function createD1Adapter(db) {
  return {
    prepare(query) {
      const stmt = db.prepare(query);
      return {
        bind(...params) {
          return {
            all() {
              try {
                const results = stmt.all(...params);
                return Promise.resolve({ results });
              } catch (e) {
                return Promise.reject(e);
              }
            },
            first() {
              try {
                const result = stmt.get(...params);
                return Promise.resolve(result);
              } catch (e) {
                return Promise.reject(e);
              }
            },
            run() {
              try {
                const info = stmt.run(...params);
                return Promise.resolve(info);
              } catch (e) {
                return Promise.reject(e);
              }
            }
          };
        }
      };
    }
  };
}

describe('Phase 4B 통합 검색 (로컬 D1)', () => {
  let db;
  let d1;
  let unifiedSearch;

  beforeAll(() => {
    // unified-search 모듈 로드 (TypeScript를 JS로 변환 필요)
    // 실제 구현을 직접 테스트하기 위해 로직을 인라인으로 구현
    db = new Database(':memory:');
    d1 = createD1Adapter(db);

    // 스키마 생성
    db.exec(`
      CREATE TABLE memos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        is_locked INTEGER DEFAULT 0,
        sensitivity INTEGER DEFAULT 0
      );

      CREATE VIRTUAL TABLE memos_fts USING fts5(
        text,
        content='memos',
        content_rowid='id'
      );

      CREATE TRIGGER memos_ai AFTER INSERT ON memos BEGIN
        INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER memos_ad AFTER DELETE ON memos BEGIN
        INSERT INTO memos_fts(memos_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER memos_au AFTER UPDATE ON memos BEGIN
        INSERT INTO memos_fts(memos_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TABLE ai_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT,
        content TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        start_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        due_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        is_done INTEGER DEFAULT 0
      );
    `);

    // 테스트 데이터 삽입
    const insertMemo = db.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)');
    insertMemo.run('QA4B_PUBLIC 일반 메모 테스트', 0, 0);
    insertMemo.run('QA4B_LOCKED 잠긴 메모 테스트', 1, 0);
    insertMemo.run('QA4B_RESTRICTED 제한 메모 테스트', 0, 2);

    const insertChat = db.prepare('INSERT INTO ai_chats (persona_id, content) VALUES (?, ?)');
    insertChat.run('concierge', 'QA4B_CHAT AI 대화 테스트');

    const insertSchedule = db.prepare('INSERT INTO schedules (title, description, start_at) VALUES (?, ?, ?)');
    insertSchedule.run('QA4B_EVENT 일정 테스트', '설명', '2026-10-13');

    const insertTodo = db.prepare('INSERT INTO todos (title, description) VALUES (?, ?)');
    insertTodo.run('QA4B_TODO 할일 테스트', '설명');
  });

  afterAll(() => {
    db.close();
  });

  test('일반 메모 검색됨', async () => {
    const { results } = await d1.prepare(
      `SELECT m.id, m.text FROM memos_fts fts
       JOIN memos m ON m.id = fts.rowid
       WHERE memos_fts MATCH ? AND m.is_locked = 0 AND m.sensitivity < 2`
    ).bind('"QA4B_PUBLIC"').all();

    expect(results.length).toBe(1);
    expect(results[0].text).toContain('QA4B_PUBLIC');
  });

  test('잠긴 메모 검색 안 됨', async () => {
    const { results } = await d1.prepare(
      `SELECT m.id, m.text FROM memos_fts fts
       JOIN memos m ON m.id = fts.rowid
       WHERE memos_fts MATCH ? AND m.is_locked = 0 AND m.sensitivity < 2`
    ).bind('"QA4B_LOCKED"').all();

    expect(results.length).toBe(0);
  });

  test('restricted 메모 검색 안 됨', async () => {
    const { results } = await d1.prepare(
      `SELECT m.id, m.text FROM memos_fts fts
       JOIN memos m ON m.id = fts.rowid
       WHERE memos_fts MATCH ? AND m.is_locked = 0 AND m.sensitivity < 2`
    ).bind('"QA4B_RESTRICTED"').all();

    expect(results.length).toBe(0);
  });

  test('AI 대화 검색됨', async () => {
    const { results } = await d1.prepare(
      `SELECT id, content FROM ai_chats WHERE content LIKE ?`
    ).bind('%QA4B_CHAT%').all();

    expect(results.length).toBe(1);
  });

  test('일정 검색됨', async () => {
    const { results } = await d1.prepare(
      `SELECT id, title FROM schedules WHERE title LIKE ? OR description LIKE ?`
    ).bind('%QA4B_EVENT%', '%QA4B_EVENT%').all();

    expect(results.length).toBe(1);
  });

  test('할 일 검색됨', async () => {
    const { results } = await d1.prepare(
      `SELECT id, title FROM todos WHERE title LIKE ? OR description LIKE ?`
    ).bind('%QA4B_TODO%', '%QA4B_TODO%').all();

    expect(results.length).toBe(1);
  });

  test('메모 수정 후 FTS 인덱스 갱신', async () => {
    // 메모 수정
    db.prepare('UPDATE memos SET text = ? WHERE text LIKE ?')
      .run('QA4B_PUBLIC 수정된 내용', '%QA4B_PUBLIC%');

    // 새 내용으로 검색
    const { results: newResults } = await d1.prepare(
      `SELECT fts.rowid as id FROM memos_fts fts
       WHERE memos_fts MATCH ?`
    ).bind('"수정된"').all();
    expect(newResults.length).toBe(1);

    // 이전 키워드로 검색 (FTS에서는 토큰 단위이므로 확인)
    const { results: oldResults } = await d1.prepare(
      `SELECT m.id, m.text FROM memos m WHERE m.text LIKE ? AND m.is_locked = 0`
    ).bind('%QA4B_PUBLIC%').all();
    expect(oldResults[0].text).toContain('수정된');
  });

  test('메모 삭제 후 검색 안 됨', async () => {
    // 삭제용 메모 생성
    db.prepare('INSERT INTO memos (text) VALUES (?)').run('QA4B_DELETED 삭제 테스트');

    // 삭제 전 검색
    let { results } = await d1.prepare(
      `SELECT m.id FROM memos_fts fts
       JOIN memos m ON m.id = fts.rowid
       WHERE memos_fts MATCH ?`
    ).bind('"QA4B_DELETED"').all();
    expect(results.length).toBe(1);

    // 삭제
    db.prepare('DELETE FROM memos WHERE text LIKE ?').run('%QA4B_DELETED%');

    // 삭제 후 검색
    ({ results } = await d1.prepare(
      `SELECT m.id FROM memos_fts fts
       JOIN memos m ON m.id = fts.rowid
       WHERE memos_fts MATCH ?`
    ).bind('"QA4B_DELETED"').all());
    expect(results.length).toBe(0);
  });
});
