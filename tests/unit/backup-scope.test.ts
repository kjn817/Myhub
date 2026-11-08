/**
 * 백업 범위 분류 강제 테스트 (P0, 2026-10-29)
 *
 * 성질: migrations/*.sql이 만드는 실제 테이블은 전부
 * BACKUP_TABLES(백업) 또는 BACKUP_EXCLUDED_TABLES(사유 있는 제외) 중
 * 정확히 하나에 속해야 한다. 새 마이그레이션이 테이블을 추가했는데
 * 분류하지 않으면 이 테스트가 실패한다 — 백업 범위의 조용한 누락 방지.
 *
 * 카나리아: BACKUP_TABLES에서 테이블 하나를 빼거나, 분류되지 않은
 * CREATE TABLE을 마이그레이션에 추가하면 실패해야 한다.
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { BACKUP_TABLES, BACKUP_EXCLUDED_TABLES } from '../../src/modules/backup/routes'

function migrationTables(): string[] {
  const dir = path.join(__dirname, '..', '..', 'migrations')
  const names = new Set<string>()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) names.add(m[1])
  }
  return [...names].sort()
}

describe('백업 범위 분류', () => {
  const tables = migrationTables()
  const included = new Set(BACKUP_TABLES)
  const excluded = new Set(Object.keys(BACKUP_EXCLUDED_TABLES))

  test('마이그레이션 테이블이 실제로 수집된다 (수집 실패 시 무의미한 통과 방지)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(50)
    expect(tables).toContain('memos')
    expect(tables).toContain('ai_settings')
  })

  test('모든 마이그레이션 테이블이 포함/제외 중 하나에 분류되어 있다', () => {
    const unclassified = tables.filter((t) => !included.has(t) && !excluded.has(t))
    expect(unclassified).toEqual([])
  })

  test('포함과 제외가 겹치지 않는다', () => {
    const overlap = BACKUP_TABLES.filter((t) => excluded.has(t))
    expect(overlap).toEqual([])
  })

  test('제외에는 실제 테이블만 있고 사유가 비어 있지 않다', () => {
    for (const [table, reason] of Object.entries(BACKUP_EXCLUDED_TABLES)) {
      expect(tables).toContain(table)
      expect(reason.trim().length).toBeGreaterThan(0)
    }
  })

  test('FTS 가상 테이블은 백업 대상이 아니다 (마이그레이션+트리거로 재생성)', () => {
    for (const t of BACKUP_TABLES) {
      expect(t).not.toMatch(/_fts(_|$)/)
    }
  })

  test('핵심 사용자 데이터 테이블은 반드시 포함된다', () => {
    for (const t of [
      'memos',
      'schedules',
      'todos',
      'files',
      'ai_settings',
      'user_cron_jobs',
      'memory_pages',
    ]) {
      expect(included.has(t)).toBe(true)
    }
  })

  test('휘발성·보안 테이블은 반드시 제외된다', () => {
    for (const t of ['otp_codes', 'rate_limits', 'session_versions', 'auth_pins']) {
      expect(excluded.has(t)).toBe(true)
      expect(included.has(t)).toBe(false)
    }
  })

  test('auth_pins 제외 사유는 오프라인 추측 연쇄와 OTP 재설정 절차를 담는다', () => {
    // 카나리아: auth_pins를 다시 포함시키거나, 사유를 빈약하게 바꾸면 실패한다.
    // 단순 개수 일치가 아니라 제외 근거 자체가 유지되는지를 강제한다.
    const reason = BACKUP_EXCLUDED_TABLES['auth_pins'] ?? ''
    expect(reason).toContain('오프라인')
    expect(reason).toContain('OTP')
    expect(reason).toContain('재설정')
  })

  test('백업 범위는 포함 35개·제외 24개이다', () => {
    expect(BACKUP_TABLES).toHaveLength(35)
    expect(Object.keys(BACKUP_EXCLUDED_TABLES)).toHaveLength(24)
  })
})
