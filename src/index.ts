import { Hono } from 'hono'
import type { Env } from './types'
import { modules } from './modules'
import { authApp, verifySessionForEnv } from './modules/auth/routes'
import { handleScheduled, handleCronJobs, handleSleepConsolidation, handleGoogleSync, handleLogPrune, handleDecryptHealth } from './scheduled'
import { CONFIG } from './config'

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string; stepUpUntil: number } }>()

// 헬스체크 (인증 불필요)
app.get('/api/health', (c) => c.json({ ok: true, app: c.env.APP_NAME }))

// 인증 라우트
app.route('/api/auth', authApp)

// 인증 미들웨어 (정적 파일과 auth 제외)
// NOTE: 이 미들웨어보다 앞에 등록된 라우트는 인증 없이 공개된다.
// 새 라우트를 추가할 때는 반드시 이 미들웨어 뒤에 둘 것.
app.use(async (c, next) => {
  const path = c.req.path.split('?')[0]
  // 인증 불필요 경로
  // - /api/channel/webhook/: 세션 쿠키가 아니라 CHANNEL_WEBHOOK_SECRET 공유
  //   시크릿으로 인증 (채널 라우트에서 검증, 미설정 시 503 비활성화)
  if (path === '/login.html' || path.startsWith('/api/auth/') || path === '/api/health' ||
      path.startsWith('/api/channel/webhook/') ||
      // MCP 엔드포인트 (POST /api/mcp): MCP 클라이언트는 세션 쿠키를 못 보내므로
      // 전역 미들웨어를 우회하고 모듈 안에서 인증한다 (세션 쿠키 또는 Bearer
      // MCP 토큰 — routes.ts의 authenticateMcpRequest). 정확한 경로만 허용한다:
      // 토큰 관리(/api/mcp/tokens*)는 여기서 걸러져 아래 세션 검사를 받는다.
      path === '/api/mcp' ||
      path === '/manifest.json' || path === '/icon-192.png' || path === '/icon-512.png' ||
      path === '/wallpaper.webp' ||
      // PWA 아이콘·시작 이미지 (미인증 상태의 홈 화면 추가·실행에서도 필요)
      // 2026-10-28 audit P-1: ASSETS 이관으로 새로 서빙되는 파일이라 allowlist에 추가
      path === '/apple-touch-icon.png' || path.startsWith('/splash/') ||
      path === '/js/login.js' || path === '/js/login-visual.js' || path === '/css/login.css' ||
      path === '/vendor/lucide/lucide.min.js') { // 로그인 페이지용 에셋 (미인증 상태에서도 필요)
    return next()
  }
  // 정적 에셋 중 로그인 페이지용은 허용 (CSS/JS는 보호됨)
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (m) {
    // 세션 버전까지 대조한다 — 로그아웃·PIN 재발급 후 구 토큰은 여기서 차단된다.
    const session = await verifySessionForEnv(c.env, m[1])
    if (session) {
      c.set('userEmail', session.email)
      // 보호 메모 step-up 창 (트랙 2): 게이트가 c.get('stepUpUntil')로 판정한다.
      c.set('stepUpUntil', session.suUntil ?? 0)
      return next()
    }
  }
  // API는 401, 페이지는 로그인으로 리다이렉트
  if (path.startsWith('/api/')) {
    return c.json({ ok: false, error: '인증 필요' }, 401)
  }
  return c.redirect('/login.html', 302)
})

// deploy_full.py가 정적 파일 라우트를 여기에 삽입 (반드시 인증 미들웨어 뒤에 위치)
// [STATIC_INJECT]

// 시스템 정보 (인증 필요) - Cloudflare API로 정확한 D1 크기 조회, KV에 10분 캐시
app.get('/api/system', async (c) => {
  try {
    // KV 캐시 확인 (10분)
    const cached = await c.env.KV.get('system:stats', 'json').catch(() => null) as any
    if (cached && cached.cached_at && Date.now() - cached.cached_at < 10 * 60 * 1000) {
      return c.json({ ...cached, from_cache: true })
    }

    const tables = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all<{ name: string }>()
    let totalRows = 0
    const tableNames: string[] = []
    for (const t of tables.results || []) {
      tableNames.push(t.name)
    }
    // §6 #6: 60개 테이블 순차 COUNT(*)를 DB.batch() 1회로 병렬화한다.
    // batch는 한 문장이라도 실패하면 전체가 실패하므로, 실패 시에는
    // 기존 순차 카운트로 폴백해 단일 테이블 오류가 전체를 망치지 않게 한다.
    try {
      const countResults = await c.env.DB.batch(
        tableNames.map((name) => c.env.DB.prepare(`SELECT COUNT(*) as n FROM "${name}"`))
      )
      for (const r of countResults) {
        totalRows += (r as any)?.results?.[0]?.n ?? 0
      }
    } catch {
      for (const name of tableNames) {
        try {
          const r = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM "${name}"`).first<{ n: number }>()
          totalRows += r?.n ?? 0
        } catch {}
      }
    }
    const memos = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>().catch(() => null)
    const files = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM files WHERE url IS NOT NULL"
    ).first<{ n: number; s: number }>().catch(() => null)

    // Cloudflare API와 Cloudinary API 병렬 호출
    const [d1Result, clResult] = await Promise.all([
      // D1 정확한 크기
      (async () => {
        if (!c.env.CF_D1_TOKEN) return null
        try {
          const apiRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cfAccountId}/d1/database/${CONFIG.d1DatabaseId}`,
            { headers: { 'Authorization': `Bearer ${c.env.CF_D1_TOKEN}` }, signal: AbortSignal.timeout(5000) }
          )
          const apiData = await apiRes.json() as any
          if (apiData.success && apiData.result?.file_size) {
            return { size: apiData.result.file_size, source: 'cloudflare-api' }
          }
        } catch {}
        return null
      })(),
      // Cloudinary 정확한 사용량
      (async () => {
        if (!c.env.CLOUDINARY_CLOUD_NAME || !c.env.CLOUDINARY_API_KEY || !c.env.CLOUDINARY_API_SECRET) return null
        try {
          const auth = btoa(`${c.env.CLOUDINARY_API_KEY}:${c.env.CLOUDINARY_API_SECRET}`)
          const clRes = await fetch(
            `https://api.cloudinary.com/v1_1/${c.env.CLOUDINARY_CLOUD_NAME}/usage`,
            { headers: { 'Authorization': `Basic ${auth}` }, signal: AbortSignal.timeout(5000) }
          )
          const clData = await clRes.json() as any
          if (clData.storage?.usage !== undefined) {
            return {
              used: clData.storage.usage,
              limit: clData.storage.limit || CONFIG.cloudinaryFreeLimitBytes,
              plan: clData.plan || 'Free',
              source: 'cloudinary-api',
            }
          }
        } catch {}
        return null
      })(),
    ])

    let d1SizeBytes = 0
    let d1SizeSource = 'estimate'
    if (d1Result) {
      d1SizeBytes = d1Result.size
      d1SizeSource = d1Result.source
    } else {
      const memoBytes = await c.env.DB.prepare(
        "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) AS s FROM memos"
      ).first<{ s: number }>().catch(() => null)
      d1SizeBytes = (memoBytes?.s ?? 0) + totalRows * 500
    }

    let cloudinaryUsage = null
    let cloudinarySource = 'db-sum'
    if (clResult) {
      cloudinaryUsage = {
        used_bytes: clResult.used,
        limit_bytes: clResult.limit,
        used_mb: (clResult.used / 1024 / 1024).toFixed(2),
        // clResult.plan은 위 IIFE에서 항상 truthy('Free' 폴백) — || null 분기는 도달 불가
        plan: (clResult.plan || null),
      }
      cloudinarySource = clResult.source
    }

    const result = {
      ok: true,
      cached_at: Date.now(),
      d1: {
        size_bytes: d1SizeBytes,
        size_mb: (d1SizeBytes / 1024 / 1024).toFixed(2),
        size_source: d1SizeSource,
        tables: tableNames,
        total_rows: totalRows,
        limit_bytes: CONFIG.d1FreeLimitBytes,
      },
      memos: memos?.n ?? 0,
      files: { count: files?.n ?? 0, bytes: files?.s ?? 0 },
      cloudinary: cloudinaryUsage,
      cloudinary_source: cloudinarySource,
      worker: { name: CONFIG.workerName, runtime: 'Cloudflare Workers' },
      kv: { namespace: 'myhub-kv' },
    }

    // KV에 캐시 (10분)
    await c.env.KV.put('system:stats', JSON.stringify(result), { expirationTtl: 600 }).catch(() => {})

    return c.json(result)
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500)
  }
})

// 등록된 모듈 목록 (대시보드에서 사용) — hidden 모듈은 제외
app.get('/api/modules', (c) =>
  c.json(modules.filter((m) => !m.hidden).map((m) => ({ id: m.id, name: m.name, desc: m.desc, path: m.path })))
)

// 각 모듈의 라우트를 /api/<모듈id> 밑에 장착
// (push 포함 — modules.ts의 hidden 항목이라 대시보드에는 안 뜬다)
for (const m of modules) {
  app.route(`/api/${m.id}`, m.app)
}

// 정적 에셋 서빙 (인증 미들웨어 통과 후, 모든 API 라우트 뒤에 위치)
// run_worker_first=true이므로 모든 요청이 Worker를 먼저 통과함.
// 인증된 사용자 또는 공개 경로에 대해서만 ASSETS에서 파일을 서빙.
// 공개 경로: /login.html, /manifest.json, 아이콘, wallpaper (미들웨어 allowlist와 일치)
// 전제: assets config html_handling='none' (기본 auto-trailing-slash는
// /login.html → 307 → /login으로 보내 무인증 리다이렉트 루프를 만든다.
// deploy_full.py ASSETS_CONFIG와 wrangler.toml [assets]가 함께 관리한다.)
//
// 2026-10-28 audit P-1: 정적 파일·이미지의 유일한 서빙 경로. 번들에 base64
// 인라인을 두지 않으므로, ASSETS 바인딩이 없는 버전에서는 정적 파일이 전부
// 503이 된다 — 바인딩 누락을 조용한 404로 숨기지 않기 위한 의도된 동작이다.
// (배포 스크립트가 assets 업로드 + 바인딩을 함께 넣지 않으면 배포 검증이
//  실패해 자동 롤백된다.)
const LOGIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
// CSP 단계 적용 (2026-11-01, docs/security-csp-20261101.md):
// 전수 실측 — 인라인 <script> 블록 13개·속성형 인라인 핸들러 67곳이 11개
// 페이지에 남아 있어 전 페이지 script-src enforce는 페이지를 깨뜨린다.
// script-src와 무관하게 안전한 지시자만 전 페이지에 적용한다:
// object/base/form은 전 페이지·전 서빙 JS에서 사용처 0건임을 grep으로 확인.
const GENERAL_HTML_CSP =
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
// 파일럿 enforce는 /desktop.html만: 인라인 스크립트 0·속성형 핸들러 0·
// <style> 블록 0 (실측). 자기 출처 + lucide CDN 외 스크립트 실행을 차단한다.
// - style-src-attr 'unsafe-inline': 정적 style 속성 1곳(브랜드 로고 img) 때문.
//   <style> 요소는 style-src-elem 'self'로 별도 차단한다.
// - frame-src 'self': 모듈 페이지를 동일 출처 iframe 창으로 띄우는 구조.
// - script-src-attr 'none': desktop·nav·desktop/*.js 전부 addEventListener와
//   프로퍼티 할당만 사용 (속성형 핸들러 문자열 0건 실측).
const DESKTOP_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
// 페이지별 enforce CSP (인라인 스크립트·속성형 핸들러가 없는 페이지부터 순차 적용)
const KEY_ROTATION_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const BACKUP_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const TRACE_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const OFFLINE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
const CHAT_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https://image.pollinations.ai https://res.cloudinary.com; font-src 'self'; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const FINDER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; media-src 'self' blob:; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const OFFICE_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; media-src 'self' blob:; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const SCHEDULE_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const TODO_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const BROWSER_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' https:; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
const SHEET_CSP =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
// 버전 관리 정적 에셋의 캐시 정책 (구 인라인 라우트와 동일)
const STATIC_IMMUTABLE_CC = 'public, max-age=31536000, immutable'
app.get('/*', async (c) => {
  const url = new URL(c.req.url)
  let pathname = url.pathname
  // / → /desktop.html 매핑 (데스크톱 셸이 진입점)
  if (pathname === '/') pathname = '/desktop.html'

  // ASSETS 바인딩이 없으면 에셋을 서빙할 방법이 없다 — 404로 위장하지 않는다.
  if (!c.env.ASSETS) {
    return c.text('Static assets unavailable (ASSETS binding missing)', 503)
  }
  const assetPathname = pathname
  try {
    const assetUrl = new URL(assetPathname, url.origin)
    const assetReq = new Request(assetUrl.toString(), c.req.raw)
    const res = await c.env.ASSETS.fetch(assetReq)
    const headers = new Headers(res.headers)
    // 보안 헤더 (트랙 3, 2026-10-31): 전 에셋 MIME 스니핑 차단.
    headers.set('X-Content-Type-Options', 'nosniff')
    // HTML 페이지는 캐시 방지 (민감한 UI 상태 포함 가능)
    if (pathname.endsWith('.html')) {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      headers.set('Referrer-Policy', 'same-origin')
      // 로그인 페이지는 인라인 라우트 시절과 동일한 엄격 CSP 유지
      if (pathname === '/login.html') headers.set('Content-Security-Policy', LOGIN_CSP)
      // 데스크톱 셸은 인라인 스크립트가 없어 파일럿으로 전면 enforce
      else if (pathname === '/desktop.html') headers.set('Content-Security-Policy', DESKTOP_CSP)
      else if (pathname === '/key-rotation.html') headers.set('Content-Security-Policy', KEY_ROTATION_CSP)
      else if (pathname === '/backup.html') headers.set('Content-Security-Policy', BACKUP_CSP)
      else if (pathname === '/trace.html') headers.set('Content-Security-Policy', TRACE_CSP)
      else if (pathname === '/offline.html') headers.set('Content-Security-Policy', OFFLINE_CSP)
      else if (pathname === '/chat.html') headers.set('Content-Security-Policy', CHAT_CSP)
      else if (pathname === '/finder.html') headers.set('Content-Security-Policy', FINDER_CSP)
      else if (pathname === '/office.html') headers.set('Content-Security-Policy', OFFICE_CSP)
      else if (pathname === '/schedule.html') headers.set('Content-Security-Policy', SCHEDULE_CSP)
      else if (pathname === '/todo.html') headers.set('Content-Security-Policy', TODO_CSP)
      else if (pathname === '/browser.html') headers.set('Content-Security-Policy', BROWSER_CSP)
      else if (pathname === '/sheet.html') headers.set('Content-Security-Policy', SHEET_CSP)
      // 그 외 인증 페이지들은 인라인 스크립트·속성형 핸들러를 쓰므로
      // script-src는 걸 수 없지만, 사용처 0건인 object/base/form과
      // 프레이밍(동일 출처 iframe 허용·교차 출처 클릭재킹 차단)은 제한한다.
      else headers.set('Content-Security-Policy', GENERAL_HTML_CSP)
    } else if (res.ok) {
      // JS/CSS/이미지/매니페스트: 배포 시 ?v= 버전이 붙으므로 장기 immutable 캐시.
      // ASSETS가 주는 헤더에 의존하지 않고 Worker가 직접 명시한다
      // (배포 검증이 /manifest.json의 immutable 헤더를 요구한다).
      // 404 등 오류 응답에는 붙이지 않는다 (오류 캐싱 방지).
      headers.set('Cache-Control', STATIC_IMMUTABLE_CC)
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch {
    return c.notFound()
  }
})


export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(env)
    // 자연어 cron 작업 (아침 브리핑 등) — 리마인더와 분리된 핸들러
    await handleCronJobs(env)
    // 수면 통합 (장기 기억 정리, 매일 03:00 KST 1회) — Push 설정과 무관
    await handleSleepConsolidation(env)
    // Google 동기화 (Gmail·캘린더 pull, 30분에 1회) — 미연동 시 no-op
    await handleGoogleSync(env)
    // 로그 정리 (오래된 실행 로그 prune)
    await handleLogPrune(env)
    // 복호화 헬스 점검 (암호화 키 상태 주기 확인)
    await handleDecryptHealth(env)
  },
  // Artifact 작업 Queue Consumer (백그라운드 AI 실행, 최대 15분)
  async queue(batch: MessageBatch<{ jobId: number }>, env: Env): Promise<void> {
    const { processArtifactJob } = await import('./modules/artifact/job-processor')
    for (const msg of batch.messages) {
      const { jobId } = msg.body
      try {
        const claimed = await processArtifactJob(env, jobId)
        if (claimed === 'done' || claimed === 'failed' || claimed === 'notfound' || claimed === 'awaiting_input') {
          msg.ack()
        } else {
          // busy: 나중에 재시도
          msg.retry({ delaySeconds: 30 })
        }
      } catch (e) {
        // 예상치 못한 오류: failed로 기록 후 ack
        try {
          await env.DB.prepare(
            `UPDATE artifact_jobs SET status='failed', error=?, seen=0, updated_at=datetime('now') WHERE id=?`
          ).bind('Consumer 오류: ' + ((e as Error).message || 'unknown'), jobId).run()
        } catch {}
        msg.ack()
      }
    }
  },
}

