/**
 * 뉴스 소스 체인 실런타임 테스트 (트랙 C7, 2-7절).
 *
 * Jest mock이 검증하지 못하는 것 — 실제 workerd 타이머·fetch 의미에서의
 * 동작을 확인한다:
 * - 시간 예산: 소스 하나가 hang에 빠져도 체인 전체 deadline(기본 20초)
 *   안에 끝나야 한다. 2026-10-26 실측 `/api/ai/websearch` 502 timeout의
 *   원인(RSS 15초 + Exa 15초 순차 실행이 30초 edge 제한 초과)이 재발하지
 *   않는지, `AbortSignal`을 무시하는 hang에도 `withTimeout` race가 먹히는지
 *   확인한다.
 * - 신선도 하드 필터: 오래된 기사·날짜 없는 기사가 체인에서 실제로
 *   걸러지는지 (Exa 가짜 publishedDate 대응 가드 포함 경로).
 *
 * 네트워크 실측이 아니다 — fetch는 주입(stub)으로 대체한다. miniflare는
 * 로컬 시뮬레이터라 실제 egress(Google News RSS 503, Exa 응답)는 재현하지
 * 못한다. 라이브 평가는 promptfoo 하네스(`tests/evals/`)가 담당한다.
 */
import { describe, expect, it } from 'vitest'
import { fetchNewsSources } from '../../src/services/news-sources'

// 고정 "지금": 2026-10-26 09:30 KST. 뉴스 창은 어제~오늘(10-25 ~ 10-26)이다.
const NOW = new Date('2026-10-26T00:30:00.000Z')

function naverResponse(items: Array<Record<string, string>>): Response {
  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

const EMPTY_RSS = new Response('<rss version="2.0"><channel></channel></rss>', {
  headers: { 'Content-Type': 'application/rss+xml' },
})

describe('news chain (miniflare)', () => {
  it('hang에 빠진 소스가 있어도 전체 deadline 안에 끝나고 timedOut을 기록한다', async () => {
    const hangForever = (): Promise<Response> => new Promise(() => {})
    const started = Date.now()
    const result = await fetchNewsSources(
      {},
      '오늘 한국 주요 뉴스',
      {
        fetchFn: hangForever as typeof fetch,
        now: NOW,
        totalTimeoutMs: 2000,
      },
    )
    const elapsed = Date.now() - started
    // 30초 edge 제한의 1/6도 안 되는 시간 안에 끝나야 한다.
    expect(elapsed).toBeLessThan(5000)
    expect(result.timedOut).toBe(true)
    // 남은 레그는 시도하지 않고 정직하게 기록한다.
    const bySource = new Map(result.statuses.map((s) => [s.source, s]))
    expect(bySource.get('press-rss')?.error).toBe('news leg timeout: press-rss')
    expect(bySource.get('gnews-rss')?.ok).toBe(false)
    expect(bySource.get('tavily')?.error).toBe('chain deadline exceeded')
    expect(bySource.get('exa')?.error).toBe('chain deadline exceeded')
    expect(result.items).toEqual([])
  })

  it('오래된 기사·날짜 없는 기사는 걸러지고 오늘 기사만 남는다', async () => {
    // HUB 호출에 실린 헤더를 기록한다 — env 값이 HUB 헤더명으로 전달되는지가 성질이다.
    let naverHeaders: Headers | null = null
    const stubFetch = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.includes('naverapihub.apigw.ntruss.com')) {
        naverHeaders = new Headers(init?.headers)
        return naverResponse([
          {
            title: '<b>신선</b>한 오늘 뉴스',
            originallink: 'https://example.com/news/fresh-1',
            link: 'https://example.com/news/fresh-1',
            pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900',
          },
          {
            title: '2025년 1월 오래된 뉴스',
            originallink: 'https://example.com/news/stale-1',
            link: 'https://example.com/news/stale-1',
            pubDate: 'Sun, 19 Jan 2025 10:00:00 +0900',
          },
          {
            title: '날짜 없는 뉴스',
            originallink: 'https://example.com/news/dateless-1',
            link: 'https://example.com/news/dateless-1',
          },
        ])
      }
      if (input.includes('news.google.com')) return EMPTY_RSS
      if (
        input.includes('yna.co.kr') ||
        input.includes('hankyung.com') ||
        input.includes('mk.co.kr')
      )
        return EMPTY_RSS
      throw new Error(`unexpected fetch: ${input}`)
    }
    const result = await fetchNewsSources(
      { NAVER_CLIENT_ID: 'test-id', NAVER_CLIENT_SECRET: 'test-secret' },
      '오늘 한국 주요 뉴스',
      { fetchFn: stubFetch as typeof fetch, now: NOW, verifyArticles: false },
    )
    expect(result.timedOut).toBeUndefined()
    expect(result.items).toHaveLength(1)
    expect(result.items[0].url).toBe('https://example.com/news/fresh-1')
    expect(result.items[0].source).toBe('naver')
    // HUB 헤더로 env 키가 전달되고 구 헤더는 보내지 않는다 (이관 — 2026-10-28)
    expect(naverHeaders).not.toBeNull()
    expect(naverHeaders!.get('X-NCP-APIGW-API-KEY-ID')).toBe('test-id')
    expect(naverHeaders!.get('X-NCP-APIGW-API-KEY')).toBe('test-secret')
    expect(naverHeaders!.get('X-Naver-Client-Id')).toBeNull()
    expect(naverHeaders!.get('X-Naver-Client-Secret')).toBeNull()
    const naver = result.statuses.find((s) => s.source === 'naver')
    expect(naver).toMatchObject({ ok: true, fetched: 3, kept: 1 })
    const press = result.statuses.find((s) => s.source === 'press-rss')
    expect(press).toMatchObject({ ok: true, fetched: 0, kept: 0 })
  })
})
