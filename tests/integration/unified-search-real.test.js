/**
 * Phase 4B 통합 검색 - 실제 코드 호출 테스트
 *
 * 실제 src/services/unified-search.ts의 unifiedSearch 함수를 호출
 * better-sqlite3를 D1Database 인터페이스로 래핑
 *
 * 실행: npx jest tests/integration/unified-search-real.test.js
 */

const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// TypeScript 컴파일
const tsPath = path.join(__dirname, '../../src/services/unified-search.ts');
const jsPath = '/tmp/unified-search-test.cjs';
try {
  execSync(`npx esbuild ${tsPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`, {
    stdio: 'pipe'
  });
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}

const { unifiedSearch, normalizeSearchLimit } = require(jsPath);

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
            }
          };
        }
      };
    }
  };
}

describe('Phase 4B 실제 코드 통합 테스트', () => {
  let db;
  let d1;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);

    // 스키마 생성 (운영과 동일)
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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active'
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

    // 테스트 데이터
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

  test('실제 unifiedSearch로 일반 메모 검색', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_PUBLIC',
      types: ['memo']
    });

    expect(results.length).toBe(1);
    expect(results[0].source_type).toBe('memo');
    expect(results[0].title).toContain('QA4B_PUBLIC');
  });

  test('실제 unifiedSearch로 잠긴 메모 제외', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_LOCKED',
      types: ['memo']
    });

    expect(results.length).toBe(0);
  });

  test('실제 unifiedSearch로 restricted 메모 제외', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_RESTRICTED',
      types: ['memo']
    });

    expect(results.length).toBe(0);
  });

  test('실제 unifiedSearch로 AI 대화 검색', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_CHAT',
      types: ['chat']
    });

    expect(results.length).toBe(1);
    expect(results[0].source_type).toBe('chat');
  });

  test('실제 unifiedSearch로 일정 검색', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_EVENT',
      types: ['schedule']
    });

    expect(results.length).toBe(1);
    expect(results[0].source_type).toBe('schedule');
  });

  test('실제 unifiedSearch로 할 일 검색', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B_TODO',
      types: ['todo']
    });

    expect(results.length).toBe(1);
    expect(results[0].source_type).toBe('todo');
  });

  test('실제 unifiedSearch로 통합 검색', async () => {
    const results = await unifiedSearch(d1, {
      query: 'QA4B',
      types: ['memo', 'chat', 'schedule', 'todo']
    });

    // QA4B_PUBLIC, QA4B_CHAT, QA4B_EVENT, QA4B_TODO = 4건
    // QA4B_LOCKED, QA4B_RESTRICTED는 제외
    expect(results.length).toBe(4);
  });

  test('normalizeSearchLimit 실제 함수 테스트', () => {
    expect(normalizeSearchLimit('10')).toBe(10);
    expect(normalizeSearchLimit('-1')).toBe(20);
    expect(normalizeSearchLimit('0.5')).toBe(20);
    expect(normalizeSearchLimit('100.5')).toBe(20);
    expect(normalizeSearchLimit('1000')).toBe(100);
  });
});
