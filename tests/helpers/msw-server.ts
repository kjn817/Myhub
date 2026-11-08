/**
 * MSW(HTTP 레벨 API 모킹) 테스트 헬퍼 (2026-10-27, MSW v2 — docs/msw-20261027.md)
 *
 * `global.fetch = jest.fn()` 대신 실제 fetch 호출 형태(URL·메소드·헤더·바디)를
 * 그대로 유지한 채 응답만 가로채는 패턴. 핸들러 안에서 요청을 검사하므로
 * 호출 자체의 오류(잘못된 파라미터·빠진 헤더)를 테스트가 잡는다.
 *
 * 사용법 (테스트 파일 상단):
 *   import { createMswServer, http, HttpResponse } from './helpers/msw-server'
 *   const server = createMswServer(
 *     http.post('https://api.exa.ai/search', async ({ request }) => {
 *       const body = (await request.json()) as any
 *       expect(body.category).toBe('news') // 핸들러 안의 요청 검사 단언
 *       return HttpResponse.json({ results: [] })
 *     }),
 *   )
 *   // 테스트 안에서 핸들러 교체: server.use(http.post(...))
 *
 * 주의:
 * - `onUnhandledRequest: 'error'` — 핸들러가 없는 URL로 fetch가 나가면
 *   테스트가 실패한다. 프로덕션 코드가 예상 밖 URL을 부르는 것을 잡는
 *   것이 목적이다. 의도적으로 다른 URL을 부르는 테스트는 해당 핸들러를
 *   추가하거나 `server.use()`로 등록할 것.
 * - MSW는 전역 fetch를 가로챈다. `jest.spyOn(global, 'fetch')`로
 *   fetch를 통째로 교체하는 테스트와 같은 파일에 섞지 말 것.
 *   (fetch를 주입받는 함수는 fetchFn 인자로 목을 넘기는 기존 방식을 유지한다.)
 * - Jest 설정: ESM 전용 전이 의존성(rettime·until-async·@open-draft)은
 *   jest.config.js의 transform에서 ts-jest로 CJS 변환한다.
 *   MSW v3는 ESM 전용이라 이 저장소의 CJS Jest 환경에서 쓸 수 없어 v2를 쓴다.
 */
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { RequestHandler } from 'msw'

export { http, HttpResponse }
export type { RequestHandler }

/**
 * 핸들러들로 MSW 서버를 만들고 Jest 생명주기에 연결한다.
 * - beforeAll: listen (핸들러 없는 요청은 에러)
 * - afterEach: resetHandlers (테스트 간 핸들러 교체 격리)
 * - afterAll: close
 */
export function createMswServer(...handlers: RequestHandler[]) {
  const server = setupServer(...handlers)
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  return server
}
