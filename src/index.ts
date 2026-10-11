import { Hono } from 'hono'
import type { Env } from './types'
import { modules } from './modules'
import { authApp, verifySession } from './modules/auth/routes'
import { pushApp } from './modules/push/routes'
import { handleScheduled } from './scheduled'
import { CONFIG } from './config'

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>()

// 헬스체크 (인증 불필요)
app.get('/api/health', (c) => c.json({ ok: true, app: c.env.APP_NAME }))

// 인증 라우트
app.route('/api/auth', authApp)

// 인증 미들웨어 (정적 파일과 auth 제외)
// NOTE: 이 미들웨어보다 앞에 등록된 라우트는 인증 없이 공개된다.
// 새 라우트를 추가할 때는 반드시 이 미들웨어 뒤에 둘 것.
app.use(async (c, next) => {
  const path = c.req.path
  // 인증 불필요 경로
  if (path === '/login.html' || path.startsWith('/api/auth/') || path === '/api/health' ||
      path === '/manifest.json' || path === '/icon-192.png' || path === '/icon-512.png' ||
      path === '/wallpaper.webp') {
    return next()
  }
  // 정적 에셋 중 로그인 페이지용은 허용 (CSS/JS는 보호됨)
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (m) {
    const email = await verifySession(m[1], c.env.SESSION_SECRET)
    if (email) {
      c.set('userEmail', email)
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
      try {
        const r = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM "${t.name}"`).first<{ n: number }>()
        totalRows += r?.n ?? 0
      } catch {}
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
            { headers: { 'Authorization': `Bearer ${c.env.CF_D1_TOKEN}` } }
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
            { headers: { 'Authorization': `Basic ${auth}` } }
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
        plan: clResult.plan || null,
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
for (const m of modules) {
  app.route(`/api/${m.id}`, m.app)
}

// Web Push 구독 관리 (대시보드 아이콘 없이 /api/push 로 직접 장착)
app.route('/api/push', pushApp)

// 정적 에셋 서빙 (인증 미들웨어 통과 후, 모든 API 라우트 뒤에 위치)
// run_worker_first=true이므로 모든 요청이 Worker를 먼저 통과함.
// 인증된 사용자 또는 공개 경로에 대해서만 ASSETS에서 파일을 서빙.
// 공개 경로: /login.html, /manifest.json, 아이콘, wallpaper (미들웨어 allowlist와 일치)
app.get('/*', async (c) => {
  const url = new URL(c.req.url)
  let pathname = url.pathname
  // / → /index.html 매핑
  if (pathname === '/') pathname = '/index.html'

  try {
    const assetUrl = new URL(pathname, url.origin)
    const res = await c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw))
    // HTML 페이지는 캐시 방지 (민감한 UI 상태 포함 가능)
    if (pathname.endsWith('.html')) {
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    return res
  } catch {
    return c.notFound()
  }
})

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(env)
  },
}

