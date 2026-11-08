/**
 * 뉴스 요약 브리핑 생성 — 자연어 cron 'news-summary' 액션의 실행기
 *
 * - 뉴스 소스 체인(네이버 → 언론사 직접 RSS → Google News RSS → Tavily → Exa) → 요약 모델 1회 호출
 *   → 항목별 출처 결정적 검증 (채팅 경로의 [SEARCH:] 2차 호출과 같은 재료·같은 검증)
 * - 메모를 일절 읽지 않으므로 잠금 정책과 무관하다.
 * - Exa만 쓰면 오래된 기사가 "오늘 뉴스"로 새는 것이 실측됨 (2026-10-26).
 * - 키가 하나도 없어도 RSS는 동작하므로, 키 미설정은 더 이상 사유 문장이 아니다.
 *   체인 결과가 없으면 일시적 실패로 취급해 예외를 던진다 (호출자가 다음 틱 재시도).
 * - 일시적 실패(검색·모델 오류)는 예외로 던져 호출자가 다음 틱에 재시도하게 한다.
 * - 요약 호출은 백그라운드 전용: personaId를 주지 않아 Function Calling이
 *   붙지 않으므로 모델은 텍스트로만 답하고 도구 실행이 일어날 수 없다.
 */

import {
  validateItemSources,
  NEWS_CATEGORY_GUIDE,
  NEWS_ITEM_FORMAT_INSTRUCTION,
  type SearchSource,
} from '../lib/news-summary'
import { fetchNewsSources } from './news-sources'
import './privacy-gateway'
import { parseRequestedNewsCount, withNewsTimelinessNotice } from '../lib/news-answer'

export class NewsSearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NewsSearchError'
  }
}

export interface NewsSummarizeFn {
  (items: SearchSource[]): Promise<string>
}

export interface GenerateNewsSummaryOpts {
  /** 테스트·호출자 주입용 요약기 (미지정 시 aiChat 경유 기본 요약기) */
  summarize?: NewsSummarizeFn
  /** Exa 검색어 (기본 '오늘 주요 뉴스') */
  query?: string
}

const NEWS_RESULT_COUNT = 5

function buildNewsContext(items: SearchSource[]): string {
  return items
    .map((r, i) => {
      const highlights = ((r as any).highlights || []).join(' ')
      const dateLine = r.publishedDate ? `\n   날짜: ${String(r.publishedDate).slice(0, 10)}` : ''
      return `${i + 1}. ${r.title || '제목 없음'}\n   URL: ${r.url}${dateLine}${highlights ? `\n   내용: ${highlights}` : ''}`
    })
    .join('\n')
}

/** 기본 요약기: aiChat 1회 호출 (personaId 없음 → FC 도구 미부착). */
async function summarizeNewsWithModel(
  env: any,
  items: SearchSource[],
): Promise<string> {
  const { aiChat } = await import('./ai')
  const searchContext = buildNewsContext(items)
  const result = await aiChat(
    env,
    {
      capability: 'summarize',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      // 예약 경로의 유일한 AI 호출 지점 (③-A): ExecutionContext를 만들지
      // 않는 persona 없는 capability 호출이며, origin은 'scheduled'로
      // 명시한다 — 향후 FC 도구가 붙어도 쓰기는 fail-closed로 막힌다.
      origin: 'scheduled',
    },
    [
      {
        role: 'system',
        content:
          '너는 MyHub의 뉴스 요약 비서야. 주어진 검색 결과만으로 오늘 주요 뉴스를 한국어로 정리해. ' +
          '도구를 호출하지 않고 텍스트로만 답해. 검색 결과에 없는 내용은 지어내지 마.',
      },
      {
        role: 'user',
        content: `오늘 주요 뉴스 검색 결과:
${searchContext}

${NEWS_ITEM_FORMAT_INSTRUCTION}

${NEWS_CATEGORY_GUIDE}`,
      },
    ],
  )
  const text = (result?.text || '').trim()
  if (!text) throw new NewsSearchError('뉴스 요약 실패: 모델 응답 없음')
  return text
}

/**
 * 뉴스 요약 브리핑 본문 생성.
 * - 소스 체인 결과가 없으면 NewsSearchError (호출자가 다음 틱 재시도).
 * - 요약 실패도 NewsSearchError.
 */
export async function generateNewsSummary(
  env: { EXA_API_KEY?: string } & Record<string, any>,
  opts: GenerateNewsSummaryOpts = {},
): Promise<string> {
  // 뉴스 소스 체인(네이버 → 언론사 직접 RSS → Google News RSS → Tavily → Exa) + 하드 필터.
  // Exa만 쓰면 오래된 기사가 "오늘 뉴스"로 새는 것이 실측됨 (2026-10-26).
  const queryText = opts.query ?? '오늘 주요 뉴스'
  const chain = await fetchNewsSources(env, queryText, {
    targetCount: parseRequestedNewsCount(queryText, NEWS_RESULT_COUNT),
  })
  const items = chain.items
  if (items.length === 0) {
    throw new NewsSearchError('뉴스 검색 실패: 검색 결과가 없습니다')
  }
  const summarize = opts.summarize ?? ((it: SearchSource[]) => summarizeNewsWithModel(env, it))
  const text = await summarize(items)
  if (!text || !text.trim()) {
    throw new NewsSearchError('뉴스 요약 실패: 모델 응답 없음')
  }
  // 항목별 출처 결정적 검증 (지어낸 URL 제거·중복 교체·누락 보강)
  const validated = validateItemSources(text, items)
  return withNewsTimelinessNotice(validated, items)
}
