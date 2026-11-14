/// <reference types="jest" />
/**
 * src/modules.ts 단위 테스트 (모듈 레지스트리)
 * - 15개 모듈 등록 확인, id/필드 무결성, hidden 플래그, studio 빈 앱
 * - channel 모듈 추가 (트랙 5: 채널 게이트웨이)
 * - pptx 모듈 (아침 브리핑·주간 보고서 PPTX 내보내기) 포함
 * - cron 모듈 추가 (2026-10-26: 자연어 cron 자동화 관리 API)
 * - google 모듈 추가 (2026-10-26: Gmail·Google 캘린더 연동)
 * - voice 모듈 추가 (2026-10-26: 음성 입력·출력, h트랙)
 * - mcp 모듈 추가 (2026-10-28: MCP 서버, hidden — 트랙 1에서 등록하고
 *   이 테스트 갱신을 빠뜨려 3건이 실패했음을 테스트 트랙에서 수정)
 * - key-rotation 모듈 추가 (2026-10-31: 키 로테이션 관리 API, hidden — 트랙 4)
 * - drive(파일 보관함)·desktop(웹OS)·browse(원격 브라우저) 추가 (hidden)
 */
import { modules } from '../../src/modules'

describe('modules registry', () => {
  test('20개 모듈이 등록되어 있다', () => {
    expect(modules).toHaveLength(20)
  })

  test('예상 id가 모두 존재한다', () => {
    const ids = modules.map((m) => m.id)
    expect(ids).toEqual([
      'memo', 'drive', 'ai', 'schedule', 'todo', 'studio',
      'artifact', 'briefing', 'pptx', 'push', 'memory', 'backup', 'key-rotation', 'channel', 'cron', 'google', 'voice', 'mcp', 'desktop', 'browse',
    ])
  })

  test('id가 중복되지 않는다', () => {
    const ids = modules.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('모든 모듈이 필수 필드를 가진다', () => {
    for (const m of modules) {
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.name).toBe('string')
      expect(typeof m.desc).toBe('string')
      expect(typeof m.path).toBe('string')
      expect(m.app).toBeDefined()
      expect(typeof (m.app as any).request).toBe('function')
    }
  })

  test('hidden 모듈 15개가 제외 목록과 일치한다', () => {
    const hidden = modules.filter((m) => m.hidden).map((m) => m.id).sort()
    expect(hidden).toEqual(['artifact', 'backup', 'briefing', 'browse', 'channel', 'cron', 'desktop', 'drive', 'google', 'key-rotation', 'mcp', 'memory', 'pptx', 'push', 'voice'])
  })

  test('공개 모듈 5개가 대시보드에 표시된다', () => {
    const visible = modules.filter((m) => !m.hidden).map((m) => m.id).sort()
    expect(visible).toEqual(['ai', 'memo', 'schedule', 'studio', 'todo'])
  })

  test('studio 모듈은 빈 Hono 앱이다 (AI 스튜디오는 agent.html 정적 서빙)', () => {
    const studio = modules.find((m) => m.id === 'studio')!
    expect(studio.path).toBe('/agent.html')
    expect(studio.app).toBeDefined()
  })

  test('각 모듈의 path가 기대값과 일치한다', () => {
    const paths: Record<string, string> = Object.fromEntries(modules.map((m) => [m.id, m.path]))
    expect(paths.memo).toBe('/memo.html')
    expect(paths.ai).toBe('/chat.html')
    expect(paths.schedule).toBe('/schedule.html')
    expect(paths.todo).toBe('/todo.html')
    expect(paths.memory).toBe('/memory.html')
    expect(paths.backup).toBe('')
    expect(paths['key-rotation']).toBe('')
    expect(paths.pptx).toBe('')
    expect(paths.channel).toBe('')
    expect(paths.cron).toBe('')
    expect(paths.mcp).toBe('')
  })
})
