// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 프롬프트/컨텍스트 조립 헬퍼: 메모 검색 의도 감지·비서별 정책·날짜 주입
import { aiChat, PERSONAS, MODELS, getSetting, setSetting, buildSystemPrompt, type TaskPolicy, type ProviderId } from '../../services/ai'
import { resolvePersonaProvider } from '../../services/provider-registry'

// Phase 3D: 메모 검색 의도 감지 (keeper v1 서버 주도 검색용)
// - 결정적 파싱: 키워드 기반, LLM 호출 없음
// - 메모 생성/수정/삭제 요청은 읽기 의도와 구분
export function detectMemoSearchIntent(text: string): { hasIntent: boolean; query: string } {
  const t = text.trim()
  if (!t) return { hasIntent: false, query: '' }

  // 메모 쓰기 의도 (검색 아님) - 제외
  if (/메모\s*(작성|생성|만들|추가|저장)/i.test(t) && !/요약|정리|찾|검색|보여/i.test(t)) {
    return { hasIntent: false, query: '' }
  }

  // 메모 검색/요약 의도 패턴
  const patterns = [
    // 패턴 1: "테스트 메모를 요약해줘" → query="테스트"
    /(.+?)\s*메모를?\s*(요약|정리|찾아|검색|보여|알려)/i,
    // 패턴 2: "테스트에 대한 메모" → query="테스트"
    /(.+?)\s*(에|에 대한|관련)\s*메모/i,
  ]

  for (const p of patterns) {
    const m = t.match(p)
    if (m) {
      let query = (m[1] || '').trim()
      // 불용어 제거
      query = query.replace(/^(그|저|이)\s+/, '').trim()
      // 조사 제거 (예: "테스트를" → "테스트")
      query = query.replace(/(을|를|이|가|은|는)$/, '').trim()
      if (query.length > 0 && query.length <= 50) {
        // "요약", "정리" 같은 동작 동사는 쿼리로 사용하지 않음
        if (/^(요약|정리|검색|찾기)$/i.test(query)) {
          return { hasIntent: false, query: '' }
        }
        return { hasIntent: true, query }
      }
    }
  }

  // "메모 요약해줘" (검색어 없음) → 의도 없음
  // 광범위한 무차별 검색 방지
  return { hasIntent: false, query: '' }
}

// 비서별 기본 정책
export const PERSONA_POLICY: Record<string, TaskPolicy> = {
  concierge: { capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', useSearch: true },
  keeper: { capability: 'summarize', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', useSearch: true },
  builder: { capability: 'code', privacy: 'external-ok', latency: 'background', quality: 'high', useSearch: true },
  scheduler: { capability: 'schedule', privacy: 'external-ok', latency: 'interactive', quality: 'balanced', useSearch: false },
}

// 비서별 전용 프로바이더 고정 (2026-10-15 사용자 확정, 2026-10-21 코드 반영)
// - 루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq (2026-10-30: 에코 nvidia → workers-ai)
// - 프로바이더 간 폴백 없음 (selectModel의 providerPin으로 강제)
// - 핀 정의의 단일 진실 원천은 전문가 레지스트리(src/services/expert-registry.ts)의
//   EXPERTS이다. 프로바이더 플러그인 레지스트리(src/services/provider-registry.ts)의
//   PERSONA_PROVIDER_PIN은 그 파생 뷰이며, 아래 providerPin은
//   resolvePersonaProvider(파생 뷰 경유)로 조회한다 (하드코딩 중복 금지).

// 시스템 프롬프트의 날짜 플레이스홀더를 실제 날짜로 치환
export function injectDates(prompt: string): string {
  const now = new Date()
  // KST 기준
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const today = fmt(kst)
  const tomorrowDate = new Date(kst.getTime() + 24 * 60 * 60 * 1000)
  const dayAfterDate = new Date(kst.getTime() + 2 * 24 * 60 * 60 * 1000)
  const tomorrow = fmt(tomorrowDate)
  const dayAfter = fmt(dayAfterDate)
  const weekdays = ['일', '월', '화', '수', '목', '금', '토']
  const koFmt = (d: Date) => {
    const ds = fmt(d)
    return `${ds.slice(0, 4)}년 ${Number(ds.slice(5, 7))}월 ${Number(ds.slice(8, 10))}일 ${weekdays[d.getUTCDay()]}요일`
  }
  const todayKo = koFmt(kst)
  const tomorrowKo = koFmt(tomorrowDate)
  const dayAfterKo = koFmt(dayAfterDate)
  
  // 다음주 토요일 계산 (다음주 = 이번주 일요일 이후)
  const dayOfWeek = kst.getUTCDay() // 0=일, 6=토
  const daysUntilNextSat = (6 - dayOfWeek + 7) % 7 + 7 // 다음주 토요일까지
  // 만약 오늘이 토요일이면 다음주 토요일은 7일 후
  const nextSatDate = new Date(kst.getTime() + daysUntilNextSat * 24 * 60 * 60 * 1000)
  const nextSat = fmt(nextSatDate)
  const nextSatKo = koFmt(nextSatDate)
  
  // 다음주 일요일
  const nextSunDate = new Date(nextSatDate.getTime() + 24 * 60 * 60 * 1000)
  const nextSunKo = koFmt(nextSunDate)
  
  return prompt
    .replaceAll('{{TODAY}}', today)
    .replaceAll('{{TOMORROW}}', tomorrow)
    .replaceAll('{{DAY_AFTER}}', dayAfter)
    .replaceAll('{{TODAY_KO}}', todayKo)
    .replaceAll('{{TOMORROW_KO}}', tomorrowKo)
    .replaceAll('{{DAY_AFTER_KO}}', dayAfterKo)
    .replaceAll('{{NEXT_SAT}}', nextSat)
    .replaceAll('{{NEXT_SAT_KO}}', nextSatKo)
    .replaceAll('{{NEXT_SUN_KO}}', nextSunKo)
}

// AI 응답의 도구 마커 후처리
// options.approvedScopeKeys: 승인 응답으로 재실행할 때의 일회성 허용 범위
// (단건 승인은 이 집합으로만 허용되며, 저장된 단건 승인을 자동 허용 근거로 쓰지 않음)
