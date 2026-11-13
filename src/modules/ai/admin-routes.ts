// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// AI 모듈 관리성 라우트: 기록·대화·기억·설정·사용량·검색 등 (aiApp에 '/'로 마운트)
import { Hono } from 'hono'
import type { Env } from '../../types'
import { aiChat, PERSONAS, MODELS, getSetting, setSetting, buildSystemPrompt, type TaskPolicy, type ProviderId } from '../../services/ai'
import { buildSearchFollowUpPrompt, validateItemSources, dedupeSources, filterFreshSources, isNewsQuery, resolveNewsIntent, noFreshNewsText, mergeSearchSources } from '../../lib/news-summary'
import { newRootTrace, childSpan, isValidTraceId } from '../../lib/trace'
import { listRecentTraces, getTraceSpans } from '../../services/trace-viewer'
import { externalWebSearch } from './web-search'
import { guardSearchQuery } from '../../services/privacy-gateway'
import { getAiMetrics, parseMetricsDays } from '../../services/ai-metrics'
import { overrideProviderForCapability } from '../../services/expert-registry'
import { validateAiSetting, BUDGET_SETTING_NOTE } from '../../services/ai-settings-spec'
import { parseConversationListParams, CONVERSATION_PREVIEW_CHARS } from '../../lib/conversation-list'
import { revealTextOrPlaceholder, isStorageEncryptionEnabled } from '../../services/storage-protection'

export const aiAdminApp = new Hono<{ Bindings: Env }>()

aiAdminApp.get('/history', async (c) => {
  const personaId = c.req.query('personaId') || 'concierge'
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, role, content, model, created_at FROM ai_chats WHERE persona_id = ? ORDER BY id DESC LIMIT 50'
    ).bind(personaId).all<{ id: number; role: string; content: string; model: string | null; created_at: string }>()
    // 저장 암호화(storage-protection)된 본문은 복호해 돌려준다 — 실패 시
    // 원문(암호문) 대신 플레이스홀더 (운영 번들 계약).
    const messages: Array<{ id: number; role: string; content: string; model: string | null; created_at: string }> = []
    for (const m of (results || []).reverse()) {
      messages.push({ ...m, content: await revealTextOrPlaceholder(c.env, m.content) })
    }
    return c.json({ ok: true, messages })
  } catch {
    return c.json({ ok: true, messages: [] })
  }
})

// 대화방 목록 — 페이지네이션 + 미리보기 절단 (계약: src/lib/conversation-list.ts)
// 기본 최근 50건, last_msg는 미리보기 40자만. hasMore/nextOffset으로 이어보기 가능.
aiAdminApp.get('/conversations', async (c) => {
  const { limit, offset } = parseConversationListParams(c.req.query('limit'), c.req.query('offset'))
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT cv.id, cv.title, cv.updated_at,
        (SELECT content FROM ai_chats WHERE conversation_id = cv.id ORDER BY id DESC LIMIT 1) as last_content
       FROM ai_conversations cv ORDER BY cv.updated_at DESC, cv.id DESC LIMIT ? OFFSET ?`
    ).bind(limit + 1, offset).all<{ id: number; title: string; updated_at: string; last_content: string | null; last_msg?: string | null }>()
    // 미리보기 절단은 복호 뒤에 한다 — 암호문을 substr로 자르면 복호가 깨져
    // 목록에 암호문/플레이스홀더가 새는 사고가 된다 (운영 번들 계약).
    const rows: Array<{ id: number; title: string; updated_at: string; last_msg: string | null }> = []
    for (const r of results || []) {
      const raw = r.last_content ?? r.last_msg ?? null
      rows.push({
        id: r.id,
        title: r.title,
        updated_at: r.updated_at,
        last_msg: raw == null ? null : (await revealTextOrPlaceholder(c.env, String(raw))).slice(0, CONVERSATION_PREVIEW_CHARS),
      })
    }
    const hasMore = rows.length > limit
    return c.json({
      ok: true,
      conversations: hasMore ? rows.slice(0, limit) : rows,
      hasMore,
      limit,
      offset,
      nextOffset: hasMore ? offset + limit : null,
    })
  } catch {
    return c.json({ ok: true, conversations: [], hasMore: false, limit, offset, nextOffset: null })
  }
})

// 81차: 활성 대화 ID 조회 (위젯 새로고침 시 복구용)
// 서버가 발급한 ID를 명시적으로 관리, 자동 추측 폐기
aiAdminApp.get('/conversations/active', async (c) => {
  const personaId = c.req.query('personaId') || 'concierge'
  try {
    // 최근 메모 활동이 있는 대화를 활성으로 간주
    // (사용자별 격리는 향후 인증 연동 시 강화)
    const recent = await c.env.DB.prepare(
      `SELECT conversation_id FROM memo_conversation_context
       WHERE updated_at > datetime('now', '-24 hours')
       ORDER BY updated_at DESC LIMIT 1`
    ).first() as any
    if (recent?.conversation_id) {
      const exists = await c.env.DB.prepare(
        'SELECT 1 FROM ai_conversations WHERE id = ?'
      ).bind(recent.conversation_id).first()
      if (exists) {
        return c.json({ ok: true, conversationId: Number(recent.conversation_id) })
      }
    }
    return c.json({ ok: true, conversationId: null })
  } catch {
    return c.json({ ok: true, conversationId: null })
  }
})

// 새 대화방 생성
aiAdminApp.post('/conversations', async (c) => {
  try {
    const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
    const now = new Date().toISOString()
    const r = await c.env.DB.prepare(
      'INSERT INTO ai_conversations (title, created_at, updated_at) VALUES (?, ?, ?)'
    ).bind(body.title || '새 대화', now, now).run()
    return c.json({ ok: true, id: r.meta.last_row_id })
  } catch (e) {
    return c.json({ ok: false, error: String(e).slice(0, 100) }, 500)
  }
})

// 대화방 삭제
aiAdminApp.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const stmts = [
      c.env.DB.prepare('DELETE FROM ai_chats WHERE conversation_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM ai_conversations WHERE id = ?').bind(id),
    ]
    if (await isStorageEncryptionEnabled(c.env.DB)) {
      stmts.push(
        c.env.DB.prepare('DELETE FROM tool_approval_requests WHERE conversation_id = ?').bind(id)
      )
    }
    await c.env.DB.batch(stmts)
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 500)
  }
})

// 메모리 저장
aiAdminApp.post('/memory', async (c) => {
  const body = await c.req.json<{ category?: string; key?: string; value?: string }>().catch(() => ({} as { category?: string; key?: string; value?: string }))
  if (!body.key || !body.value) return c.json({ ok: false, error: 'key/value 필요' }, 400)
  try {
    const now = new Date().toISOString()
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM ai_memory WHERE key = ?').bind(body.key),
      c.env.DB.prepare(
        'INSERT INTO ai_memory (category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(body.category || 'fact', body.key, body.value, now, now),
    ])
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: String(e).slice(0, 100) }, 500)
  }
})

// 메모리 조회
aiAdminApp.get('/memory', async (c) => {
  const category = c.req.query('category')
  const key = c.req.query('key')
  try {
    let sql = 'SELECT category, key, value, updated_at FROM ai_memory'
    const params: any[] = []
    const conds: string[] = []
    if (category) { conds.push('category = ?'); params.push(category) }
    if (key) { conds.push('key LIKE ?'); params.push(`%${key}%`) }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ')
    sql += ' ORDER BY updated_at DESC LIMIT 50'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all()
    return c.json({ ok: true, memories: results || [] })
  } catch {
    return c.json({ ok: true, memories: [] })
  }
})

// 메모리 삭제
aiAdminApp.delete('/memory/:key', async (c) => {
  const key = c.req.param('key')
  try {
    await c.env.DB.prepare('DELETE FROM ai_memory WHERE key = ?').bind(key).run()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 500)
  }
})

// 등록된 도구 목록 (디버깅용)
// tools는 실제 FC 경로의 레지스트리(공유 팩토리)에서 읽는다. 간이 레지스트리
// (services/tools.ts)는 D2 미결로 비어 있어 tools: []라는 거짓 정보를 주던
// 것을 별도 필드로 분리했다 — 죽은 도구 시스템을 되살리는 것이 아니다.
aiAdminApp.get('/tools', async (c) => {
  const { createFCToolRegistry } = await import('../../ai/tools/fc-registry')
  const { getToolDefinitions } = await import('../../services/tools')
  return c.json({
    ok: true,
    tools: createFCToolRegistry(c.env.DB).list().map((t) => t.name),
    legacySimpleRegistryTools: getToolDefinitions().map((t) => t.name),
  })
})

// 통합 방 히스토리 (모든 비서, 시간순, 페이지네이션)
aiAdminApp.get('/room-history', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') || '30', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30
  const conversationId = c.req.query('conversationId') || '1'
  const before = c.req.query('before') // 이 ID보다 오래된 메시지
  try {
    let sql = 'SELECT id, persona_id, role, content, model, created_at FROM ai_chats WHERE conversation_id = ?'
    const params: any[] = [parseInt(conversationId)]
    if (before) {
      sql += ' AND id < ?'
      params.push(parseInt(before))
    }
    sql += ' ORDER BY id DESC LIMIT ?'
    params.push(limit)
    const { results } = await c.env.DB.prepare(sql).bind(...params)
      .all<{ id: number; persona_id: string; role: string; content: string; model: string | null; created_at: string }>()
    const msgs: Array<{ id: number; persona_id: string; role: string; content: string; model: string | null; created_at: string }> = []
    for (const m of (results || []).reverse()) {
      msgs.push({ ...m, content: await revealTextOrPlaceholder(c.env, m.content) })
    }
    return c.json({ ok: true, messages: msgs, hasMore: (results || []).length === limit })
  } catch {
    return c.json({ ok: true, messages: [], hasMore: false })
  }
})

// 사용 가능 모델 목록
aiAdminApp.get('/models', (c) => {
  return c.json({ ok: true, models: MODELS.filter((m) => m.status === 'active') })
})

// 설정 조회/저장
aiAdminApp.get('/settings', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT key, value FROM ai_settings').all<{ key: string; value: string }>()
    const out: Record<string, string> = {}
    for (const r of results || []) out[r.key] = r.value
    return c.json({ ok: true, settings: out })
  } catch {
    return c.json({ ok: true, settings: {} })
  }
})

aiAdminApp.post('/settings', async (c) => {
  const body = await c.req.json<{ key?: string; value?: string }>().catch(() => ({} as { key?: string; value?: string }))
  if (!body.key || typeof body.value !== 'string') return c.json({ ok: false, error: 'invalid' }, 400)
  // 허용 키·값 검증은 ai-settings-spec의 단일 판정으로 한다 (키 종류별 규칙:
  // model.*/budget.*/불리언/열거/전용 키 — 여기가 유일한 진입 판정이다).
  const validation = validateAiSetting(body.key, body.value, c.env)
  if (!validation.ok) {
    return c.json({ ok: false, error: validation.error || 'invalid key' }, 400)
  }
  // 비서별 프로바이더 고정 검증 (2026-10-13): 모델은 해당 프로바이더 내에서만 변경 가능
  // 2026-10-30 수정: 에코=Workers AI (NVIDIA Trial 약관 판정으로 운영 경로 제외).
  // NVIDIA 모델은 레지스트리에서 전부 비활성이라, 아래 provider 대조와
  // status='active' 대조 양쪽에서 어떤 capability로도 저장할 수 없다.
  if (body.key.startsWith('model.') && body.value !== '') {
    const expectedProvider = overrideProviderForCapability(body.key.slice('model.'.length))
    if (expectedProvider) {
      const model = MODELS.find((m) => m.id === body.value)
      if (!model) {
        return c.json({ ok: false, error: 'unknown model' }, 400)
      }
      if (model.provider !== expectedProvider) {
        return c.json({ ok: false, error: `provider fixed to ${expectedProvider}` }, 400)
      }
      // 잠재 경로 하드닝 (2026-10-30): deprecated 등 비활성 모델은 저장 거부.
      // GET /models가 active만 노출하고 selectModel도 active만 통과시키므로,
      // 비활성 모델이 설정에 저장되면 조용히 무시/폴백되는 표기≠동작 상태가 된다.
      if (model.status !== 'active') {
        return c.json({ ok: false, error: `model not active: ${model.status}` }, 400)
      }
    }
  }
  try {
    if (body.value === '') {
      await c.env.DB.prepare('DELETE FROM ai_settings WHERE key = ?').bind(body.key).run()
    } else {
      await setSetting(c.env.DB, body.key, body.value)
    }
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: 'db error' }, 500)
  }
})

// 쿼터 현황 (오늘 사용량 + 설정된 예산)
aiAdminApp.get('/quota', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT provider,
              COUNT(*) as requests,
              SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as ok,
              SUM(input_tokens) as in_tok,
              SUM(output_tokens) as out_tok
       FROM ai_usage WHERE created_at >= date('now', '-1 day')
       GROUP BY provider`
    ).all<{ provider: string; requests: number; ok: number; in_tok: number; out_tok: number }>()
    const { results: settings } = await c.env.DB.prepare(
      "SELECT key, value FROM ai_settings WHERE key LIKE 'budget.%'"
    ).all<{ key: string; value: string }>()
    const budgets: Record<string, number> = {}
    for (const s of settings || []) {
      const n = parseInt(s.value, 10)
      if (!isNaN(n)) budgets[s.key.replace('budget.', '')] = n
    }
    return c.json({ ok: true, usage: results || [], budgets, budgetEnforced: false, budgetNote: BUDGET_SETTING_NOTE })
  } catch {
    return c.json({ ok: true, usage: [], budgets: {}, budgetEnforced: false, budgetNote: BUDGET_SETTING_NOTE })
  }
})

// 일일 사용량 요약 (대시보드용)
aiAdminApp.get('/usage', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT provider, COUNT(*) as n, SUM(latency_ms) as ms,
              SUM(CASE WHEN outcome='rate_limited' THEN 1 ELSE 0 END) as limited
       FROM ai_usage WHERE created_at >= date('now', '-1 day')
       GROUP BY provider`
    ).all<{ provider: string; n: number; ms: number; limited: number }>()
    return c.json({ ok: true, usage: results || [] })
  } catch {
    return c.json({ ok: true, usage: [] })
  }
})

// 트레이스 목록 (트랙 C2+C3 — OTEL 스팬, D1만 조회, 외부 전송 없음)
// GET /api/ai/traces?limit=20 → 최근 트레이스 요약 (최신순)
aiAdminApp.get('/traces', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20', 10)
    const traces = await listRecentTraces(c.env.DB, Number.isNaN(limit) ? 20 : limit)
    return c.json({ ok: true, traces })
  } catch {
    return c.json({ ok: true, traces: [] })
  }
})

// 트레이스 상세 — 한 트레이스의 스팬 목록 (타임라인 렌더링용)
// GET /api/ai/traces/:traceId → 스팬 (종료 시각순, depth 포함)
aiAdminApp.get('/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId')
  if (!isValidTraceId(traceId)) {
    return c.json({ ok: false, error: 'invalid_trace_id' }, 400)
  }
  try {
    const spans = await getTraceSpans(c.env.DB, traceId)
    return c.json({ ok: true, traceId, spans })
  } catch {
    return c.json({ ok: true, traceId, spans: [] })
  }
})

aiAdminApp.get('/websearch', async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json({ ok: false, error: 'q 필요' }, 400)
  if (guardSearchQuery(q) === null) return c.json({ ok: true, items: [] })
  const toItems = (rs: { title: string; url: string }[]) =>
    rs.map((r) => ({ title: r.title, url: r.url, snippet: '' }))
  // 뉴스 질의: 소스 체인(Exa 기반, 전체 20초 deadline)으로 직접 간다.
  if (isNewsQuery(q)) {
    try {
      const items = await externalWebSearch(c.env, q)
      return c.json({ ok: true, items: toItems(items) })
    } catch (e: any) {
      return c.json({ ok: false, error: String(e?.message || e).slice(0, 100) }, 502)
    }
  }
  try {
    // DuckDuckGo HTML 검색 (간단한 파싱)
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) {
      // DDG 거절 → 체인 폴백, 폴백도 비면 원래 상태로 502
      const fallback = await externalWebSearch(c.env, q)
      if (fallback.length > 0) return c.json({ ok: true, items: toItems(fallback) })
      return c.json({ ok: false, error: `search ${res.status}` }, 502)
    }
    const html = await res.text()
    // 결과 파싱: <a class="result__a" href="...">제목</a>
    const items: { title: string; url: string; snippet: string }[] = []
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && items.length < 8) {
      let url = m[1]
      // DuckDuckGo 리디렉트 URL 처리: //duckduckgo.com/l/?uddg=<encoded>
      const uddg = url.match(/[?&]uddg=([^&]+)/)
      if (uddg) {
        try { url = decodeURIComponent(uddg[1]) } catch { /* 무시 */ }
      }
      if (url.startsWith('//')) url = 'https:' + url
      const title = m[2].replace(/<[^>]+>/g, '').trim()
      if (title && url.startsWith('http')) {
        items.push({ title, url, snippet: '' })
      }
    }
    if (items.length > 0) return c.json({ ok: true, items })
    // DDG 빈 결과 → 체인 폴백
    const fallback = await externalWebSearch(c.env, q)
    return c.json({ ok: true, items: toItems(fallback) })
  } catch (e: any) {
    // DDG 실패 → 체인 폴백, 폴백도 비면 원래 에러로 502
    try {
      const fallback = await externalWebSearch(c.env, q)
      if (fallback.length > 0) return c.json({ ok: true, items: toItems(fallback) })
    } catch { /* 원래 에러 유지 */ }
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 100) }, 502)
  }
})

// GitHub 저장소 검색 (인증 없이, rate limit 있음)
aiAdminApp.get('/github', async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json({ ok: false, error: 'q 필요' }, 400)
  if (guardSearchQuery(q) === null) return c.json({ ok: true, items: [] })
  try {
    const res = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`,
      { headers: { 'User-Agent': 'MyHub', 'Accept': 'application/vnd.github.v3+json' }, signal: AbortSignal.timeout(15000) }
    )
    if (!res.ok) return c.json({ ok: false, error: `github ${res.status}` }, 502)
    const data = (await res.json()) as any
    const items = (data.items || []).map((r: any) => ({
      name: r.full_name,
      desc: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
      lang: r.language,
    }))
    return c.json({ ok: true, items })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e).slice(0, 100) }, 502)
  }
})

// 이미지 생성 (Pollinations, 무료)
aiAdminApp.post('/image', async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }))
  const prompt = (body.prompt || '').trim()
  if (!prompt) return c.json({ ok: false, error: 'prompt 필요' }, 400)
  if (prompt.length > 500) return c.json({ ok: false, error: 'prompt too long' }, 400)
  // Pollinations URL 생성 (실제 생성은 클라이언트가 이미지 로드 시)
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`
  return c.json({ ok: true, url, prompt })
})

// 디버그: 최근 에러 로그 (인증 필요)
aiAdminApp.get('/debug/errors', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT provider, model, capability, error, http_status, created_at
       FROM ai_error_log ORDER BY id DESC LIMIT 20`
    ).all()
    return c.json({ ok: true, errors: results || [] })
  } catch {
    return c.json({ ok: true, errors: [] })
  }
})

// 운영 지표 (GPT 재평가 P1 — 2026-10-30)
// GET /api/ai/metrics?days=14 (기본 14, 1~90 클램프)
// ai_usage·ai_error_log·tool_execution_audit·tool_approval_requests를
// 기간 내 집계한다. 산출 로직·정의·근사 고지는 src/services/ai-metrics.ts.
// 0065(engine·persona 컬럼) 미적용 DB에서도 unknown 버킷으로 동작한다.
aiAdminApp.get('/metrics', async (c) => {
  const days = parseMetricsDays(c.req.query('days'))
  try {
    const metrics = await getAiMetrics(c.env.DB, days)
    return c.json({ ok: true, ...metrics })
  } catch (e) {
    return c.json({ ok: false, error: String(e).slice(0, 100) }, 500)
  }
})
