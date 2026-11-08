/**
 * 스케줄/할일 AI 도구 마커 파싱 테스트
 * @jest-environment node
 *
 * src/services/schedule-tools.ts, todo-tools.ts를 esbuild로 번들한 뒤 테스트한다.
 */
const { execSync } = require('child_process');
const path = require('path');

const SCHED_BUNDLE = path.join(__dirname, 'sched-tools-bundle.cjs');
const TODO_BUNDLE = path.join(__dirname, 'todo-tools-bundle.cjs');

// 모듈 로드 전에 번들 생성 (require보다 먼저 실행)
execSync(`npx esbuild src/services/schedule-tools.ts --bundle --format=cjs --platform=node --outfile=${SCHED_BUNDLE}`, { cwd: __dirname, stdio: 'pipe' });
execSync(`npx esbuild src/services/todo-tools.ts --bundle --format=cjs --platform=node --outfile=${TODO_BUNDLE}`, { cwd: __dirname, stdio: 'pipe' });

const { parseScheduleMarkers } = require('./sched-tools-bundle.cjs');
const { parseTodoMarkers } = require('./todo-tools-bundle.cjs');

describe('parseScheduleMarkers', () => {
  test('SCHEDULE_CREATE 파싱', () => {
    const text = '일정 등록할게 [SCHEDULE_CREATE]{"title": "치과", "start_at": "2026-10-10T15:00:00"}[/SCHEDULE_CREATE]';
    const markers = parseScheduleMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('create');
    expect(markers[0].data.title).toBe('치과');
    expect(markers[0].data.start_at).toBe('2026-10-10T15:00:00');
  });

  test('SCHEDULE_LIST 파싱', () => {
    const text = '[SCHEDULE_LIST]{"from": "2026-10-09"}[/SCHEDULE_LIST]';
    const markers = parseScheduleMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('list');
  });

  test('잘못된 JSON은 무시', () => {
    const text = '[SCHEDULE_CREATE]{invalid}[/SCHEDULE_CREATE]';
    const markers = parseScheduleMarkers(text);
    expect(markers).toHaveLength(0);
  });

  test('제목 없는 CREATE는 무시', () => {
    const text = '[SCHEDULE_CREATE]{"start_at": "2026-10-10T15:00:00"}[/SCHEDULE_CREATE]';
    const markers = parseScheduleMarkers(text);
    expect(markers).toHaveLength(0);
  });
});

describe('parseTodoMarkers', () => {
  test('TODO_ADD 파싱', () => {
    const text = '[TODO_ADD]{"title": "우유 사기"}[/TODO_ADD]';
    const markers = parseTodoMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('add');
    expect(markers[0].data.title).toBe('우유 사기');
  });

  test('TODO_LIST 파싱', () => {
    const text = '[TODO_LIST]{"status": "pending"}[/TODO_LIST]';
    const markers = parseTodoMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('list');
  });

  test('TODO_DONE 파싱', () => {
    const text = '[TODO_DONE]{"id": 5}[/TODO_DONE]';
    const markers = parseTodoMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].action).toBe('done');
    expect(markers[0].data.id).toBe(5);
  });

  test('id 없는 DONE은 무시', () => {
    const text = '[TODO_DONE]{}[/TODO_DONE]';
    const markers = parseTodoMarkers(text);
    expect(markers).toHaveLength(0);
  });
});
