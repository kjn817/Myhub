/// <reference types="jest" />
/**
 * S2-3: GET /api/ai/tools는 거짓 정보를 주지 않는다.
 *
 * 핵심 성질:
 * ① tools는 실제 FC 경로의 레지스트리(공유 팩토리)에서 읽은 목록이다 —
 *    간이 레지스트리의 빈 배열이 아니다.
 * ② 간이 레지스트리 상태는 별도 필드로 정직하게 노출한다 (현재 비어 있음).
 * ③ 엔드포인트의 tools와 공유 팩토리의 목록이 어긋나지 않는다 (드리프트 방지).
 * 카나리아: 엔드포인트가 간이 레지스트리를 다시 읽게 되돌리면 ①·③이 실패한다.
 */
import { Hono } from 'hono'
import { aiAdminApp } from '../../src/modules/ai/admin-routes'
import { createFCToolRegistry } from '../../src/ai/tools/fc-registry'

describe('GET /api/ai/tools — 디버그 엔드포인트 정직성', () => {
  const app = new Hono()
  app.route('/', aiAdminApp)
  // 팩토리는 DB를 실행기 클로저에만 캡처하고 목록 조회 때는 쓰지 않으므로
  // 더미 DB로 충분하다.
  const env = { DB: {} }

  test('tools는 실제 FC 레지스트리의 도구 목록이다 (빈 배열이 아니다)', async () => {
    const res = await app.request('/tools', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.tools).toContain('search_memo')
    expect(body.tools.length).toBeGreaterThan(0)
  })

  test('간이 레지스트리 상태는 별도 필드로 노출되고 현재 비어 있다', async () => {
    const res = await app.request('/tools', { method: 'GET' }, env)
    const body = (await res.json()) as any
    expect(body.legacySimpleRegistryTools).toEqual([])
  })

  test('엔드포인트의 tools와 공유 팩토리 목록이 일치한다', async () => {
    const res = await app.request('/tools', { method: 'GET' }, env)
    const body = (await res.json()) as any
    const factoryNames = createFCToolRegistry(env.DB as any)
      .list()
      .map((t) => t.name)
    expect(body.tools).toEqual(factoryNames)
  })
})
