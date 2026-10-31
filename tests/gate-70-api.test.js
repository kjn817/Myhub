/**
 * 관문 테스트 70: API 에러 처리 — 실제 api() 함수 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * public/agent.html에 인라인으로 정의된 실제 `api()` 함수를 소스에서
 * 그대로 추출해(재구현이 아님) Node에서 실행하고, fetch를 스텁으로
 * 교체해 동작을 검증한다.
 *
 * 검증하는 성질 (agent.html의 api()):
 * - 정상 JSON이면 파싱 결과를 그대로 반환한다.
 * - JSON 파싱 실패 시 console.error로 기록하고 throw한다.
 * - 단, 응답 텍스트에 '404'나 'Not Found'가 있으면 조용히 throw만 한다
 *   (404는 정상 상황으로 취급 — console.error 없음).
 * - 요청은 '/api/artifact' + 경로로, Content-Type: application/json과 함께 간다.
 */
const fs = require('fs')
const path = require('path')

const AGENT_HTML = path.join(__dirname, '../public/agent.html')

// 소스에서 `async function api(p, o = {}) { ... }`를 중괄호 매칭으로 추출한다.
function extractApiFunction(src) {
  const start = src.indexOf('async function api(p, o = {}) {')
  if (start < 0) throw new Error('agent.html에서 api()를 찾지 못함')
  // 본문 여는 중괄호는 시그니처의 닫는 괄호 뒤에 있다 (o = {}의 중괄호가 아님)
  const sigEnd = src.indexOf(')', start)
  let depth = 0
  let i = src.indexOf('{', sigEnd)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('api()의 닫는 중괄호를 찾지 못함')
}

describe('관문 70: api() 에러 처리 (실제 함수 코드)', () => {
  let api
  let fetchCalls
  let realFetch
  let consoleErrorSpy

  beforeAll(() => {
    const src = fs.readFileSync(AGENT_HTML, 'utf8')
    const fnText = extractApiFunction(src)
    // api()는 전역 fetch/console만 쓰므로 그대로 eval해 실제 코드를 실행한다.
    api = eval(`(${fnText.replace(/^async function api/, 'async function')})`)
    realFetch = global.fetch
  })

  afterAll(() => {
    global.fetch = realFetch
  })

  beforeEach(() => {
    fetchCalls = []
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts })
      return fetchCalls._next()
    }
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  function stubFetch(text) {
    fetchCalls._next = async () => ({ text: async () => text })
  }

  test('정상 JSON이면 파싱 결과를 반환한다', async () => {
    stubFetch('{"ok":true,"data":{"jobId":7}}')
    const r = await api('/jobs/7')
    expect(r).toEqual({ ok: true, data: { jobId: 7 } })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/api/artifact/jobs/7')
    expect(fetchCalls[0].opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  test('JSON 파싱 실패 → console.error로 기록하고 throw한다', async () => {
    stubFetch('<html>Server Error</html>')
    await expect(api('/jobs/7')).rejects.toThrow(/서버 응답 오류/)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const args = consoleErrorSpy.mock.calls[0]
    expect(args[0]).toBe('API JSON 파싱 실패:')
    expect(args[1]).toBe('/jobs/7')
    expect(String(args[2])).toContain('Server Error')
  })

  test("응답에 '404'가 있으면 조용히 throw만 한다 (console.error 없음)", async () => {
    stubFetch('404 Not Found: /api/artifact/jobs/7')
    await expect(api('/jobs/7')).rejects.toThrow(/서버 응답 오류/)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  test("응답에 'Not Found'가 있으면 조용히 throw만 한다", async () => {
    stubFetch('Not Found')
    await expect(api('/jobs/7')).rejects.toThrow(/서버 응답 오류/)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  test('추가 옵션(method/body)이 fetch에 그대로 전달된다', async () => {
    stubFetch('{"ok":true}')
    await api('/jobs', { method: 'POST', body: '{"prompt":"hi"}' })
    expect(fetchCalls[0].opts.method).toBe('POST')
    expect(fetchCalls[0].opts.body).toBe('{"prompt":"hi"}')
  })
})
