/**
 * 채널·cron·음성 라우트 커버리지 보강 (그룹 E)
 * - channel: 핸들러 미연결 503 assistant_unavailable, 핸들러 일반 에러 500 (메시지 200자 절단)
 * - cron: 4개 db_error 500 경로, 설명 폴백(파싱 불가 nl_text), id 형식 오류, nl_text 길이·본문 파싱 실패
 * - voice: formData/JSON 파싱 실패 400, durationSeconds 없음/0, 오디오 검증 400 분기,
 *   VoiceError 원문 전달(STT/TTS), status의 AI 미연결 분기
 */
import { channelApp } from '../../src/modules/channel/routes'
import {
  setAssistantHandler,
  getAssistantHandler,
} from '../../src/services/channel-gateway'
import { cronApp } from '../../src/modules/cron/routes'
import { voiceApp } from '../../src/modules/voice/routes'
import { FakeD1, asD1 } from '../fake-d1'
import {
  VOICE_STT_MODEL,
  VOICE_TTS_MODEL,
  VoiceError,
  getVoiceUsage,
} from '../../src/services/voice'

const SECRET = 'test-webhook-secret'

// ---------------------------------------------------------------------------
// 채널
// ---------------------------------------------------------------------------

function makeMockDb(): any {
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue({ results: [] }),
        run: jest.fn().mockResolvedValue({}),
      }),
    }),
  }
}

describe('channel routes — 핸들러 오류 분기', () => {
  let prevHandler: any

  beforeEach(() => {
    prevHandler = getAssistantHandler()
  })

  afterEach(() => {
    setAssistantHandler(prevHandler)
  })

  const envOf = (): any => ({ DB: makeMockDb(), CHANNEL_WEBHOOK_SECRET: SECRET })

  function webhookPost(body: unknown, headers: Record<string, string> = {}) {
    return channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}`, ...headers },
      body: JSON.stringify(body),
    }, envOf())
  }

  test('핸들러 미연결 → 503 assistant_unavailable', async () => {
    setAssistantHandler(null)
    const res = await webhookPost({ text: '안녕', senderId: 'u1' })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('assistant_unavailable')
  })

  test('핸들러 일반 에러 → 500 channel_error + 원문 메시지', async () => {
    setAssistantHandler(async () => { throw new Error('downstream boom') })
    const res = await webhookPost({ text: '안녕', senderId: 'u1' })
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.error).toBe('channel_error')
    expect(body.message).toBe('downstream boom')
  })

  test('핸들러 에러 메시지가 200자를 넘으면 200자로 절단', async () => {
    setAssistantHandler(async () => { throw new Error('e'.repeat(500)) })
    const res = await webhookPost({ text: '안녕', senderId: 'u1' })
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.message).toHaveLength(200)
  })

  test('핸들러가 Error가 아닌 값을 던져도 500 + 값 그대로 메시지', async () => {
    setAssistantHandler(async () => { throw 'plain string failure' })
    const res = await webhookPost({ text: '안녕', senderId: 'u1' })
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.error).toBe('channel_error')
    expect(body.message).toBe('plain string failure')
  })

  test('잘못된 JSON 본문 → payload null → 400 invalid_payload', async () => {
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: '{invalid json',
    }, envOf())
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('invalid_payload')
  })
})

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

/** prepare 호출 즉시 실패하는 DB (서비스 계층 db_error 경로) */
const throwingDb = {
  prepare() { throw new Error('db down') },
} as unknown as D1Database

async function cronCall(
  fakeOrDb: FakeD1 | D1Database,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const db = fakeOrDb instanceof FakeD1 ? asD1(fakeOrDb) : fakeOrDb
  const res = await cronApp.request(path, init, { DB: db } as any)
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('cron routes — db_error 500 경로', () => {
  test('생성 DB 실패 시 500 db_error', async () => {
    const created = await cronCall(throwingDb, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '매일 아침 8시에 브리핑해줘' }),
    })
    expect(created.status).toBe(500)
    expect(created.body.error).toBe('db_error')
  })
})

describe('cron routes — 입력 검증', () => {
  test('nl_text 500자 초과·공백만·본문 파싱 실패 → invalid_nl_text 400', async () => {
    const fake = new FakeD1()
    const tooLong = await cronCall(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '매일 아침 8시에 브리핑해줘 '.repeat(40) }),
    })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe('invalid_nl_text')
    expect(fake.tables.user_cron_jobs).toHaveLength(0)

    const blank = await cronCall(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nl_text: '   ' }),
    })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe('invalid_nl_text')

    const badJson = await cronCall(fake, '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })
    expect(badJson.status).toBe(400)
    expect(badJson.body.error).toBe('invalid_nl_text')
  })
})

// ---------------------------------------------------------------------------
// 음성
// ---------------------------------------------------------------------------

function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string, _opts?: any) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function stubDb(settings: Record<string, string> = {}) {
  return {
    prepare(_sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              const v = settings[args[0]]
              return v === undefined ? null : { value: v }
            },
          }
        },
      }
    },
  }
}

function mockAI(impl?: (model: string, input: any) => any) {
  const ai = {
    run: jest.fn(async (model: string, input: any) => {
      if (impl) return impl(model, input)
      if (model === VOICE_STT_MODEL) return { text: '안녕하세요', word_count: 1, words: [] }
      if (model === VOICE_TTS_MODEL) return new Uint8Array([0x52, 0x49, 0x46, 0x46])
      throw new Error('unknown model')
    }),
  }
  return ai
}

function makeEnv(opts: { ai?: any; dailyLimit?: string; settings?: Record<string, string> } = {}) {
  const kv = fakeKV()
  const env: any = {
    KV: kv,
    DB: stubDb(opts.settings ?? {}),
    AI: opts.ai === undefined ? mockAI() : opts.ai,
  }
  if (opts.dailyLimit !== undefined) env.VOICE_DAILY_LIMIT = opts.dailyLimit
  return { kv, env }
}

function audioForm(durationSeconds?: string) {
  const form = new FormData()
  form.append('audio', new File([new Uint8Array(1000)], 'voice.m4a', { type: 'audio/mp4' }))
  if (durationSeconds !== undefined) form.append('durationSeconds', durationSeconds)
  return form
}

describe('voice routes — 파싱 실패·duration·검증 분기', () => {
  test('POST /transcribe: multipart가 아닌 본문 → 400 BAD_REQUEST', async () => {
    const { env } = makeEnv({})
    const res = await voiceApp.request('/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'this is not multipart form data',
    }, env)
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('BAD_REQUEST')
  })

  test('POST /synthesize: 잘못된 JSON 본문 → 400 BAD_REQUEST', async () => {
    const { env } = makeEnv({})
    const res = await voiceApp.request('/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    }, env)
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('BAD_REQUEST')
  })

  test('POST /transcribe: durationSeconds 없음 → seconds·neuronsEstimate null', async () => {
    const { kv, env } = makeEnv({})
    const res = await voiceApp.request('/transcribe', { method: 'POST', body: audioForm() }, env)
    expect(res.status).toBe(200)
    const d = await res.json() as any
    expect(d.ok).toBe(true)
    expect(d.seconds).toBeNull()
    expect(d.neuronsEstimate).toBeNull()
    expect(await getVoiceUsage(kv as any)).toMatchObject({ stt: 1, total: 1 })
  })

  test('POST /transcribe: mimeType 없는 파일은 octet-stream으로 와서 400', async () => {
    // undici FormData는 타입 없는 파일을 application/octet-stream으로 직렬화한다
    const { env } = makeEnv({})
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(1000)], 'voice'))
    form.append('durationSeconds', '10')
    const res = await voiceApp.request('/transcribe', { method: 'POST', body: form }, env)
    expect(res.status).toBe(400)
    const d = await res.json() as any
    expect(d.error).toBe('AUDIO_TOO_LONG')
    expect(d.message).toMatch(/application\/octet-stream/)
  })

  test('POST /synthesize: 본문이 null·{}이면 NO_TEXT 400', async () => {
    const { env } = makeEnv({})
    for (const body of ['null', '{}']) {
      const res = await voiceApp.request('/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }, env)
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toBe('NO_TEXT')
    }
  })

  test('POST /transcribe: durationSeconds 0 → 400 (길이 확인 불가)', async () => {
    const { env } = makeEnv({})
    const res = await voiceApp.request('/transcribe', { method: 'POST', body: audioForm('0') }, env)
    expect(res.status).toBe(400)
    const d = await res.json() as any
    expect(d.error).toBe('AUDIO_TOO_LONG')
    expect(d.message).toMatch(/녹음 길이를 확인할 수 없습니다/)
  })

  test('POST /transcribe: 지원하지 않는 형식·빈 오디오 → 400 AUDIO_TOO_LONG', async () => {
    const { env } = makeEnv({})
    const flacForm = new FormData()
    flacForm.append('audio', new File([new Uint8Array(100)], 'voice.flac', { type: 'audio/flac' }))
    const flac = await voiceApp.request('/transcribe', { method: 'POST', body: flacForm }, env)
    expect(flac.status).toBe(400)
    const flacBody = await flac.json() as any
    expect(flacBody.error).toBe('AUDIO_TOO_LONG')
    expect(flacBody.message).toMatch(/지원하지 않는/)

    const emptyForm = new FormData()
    emptyForm.append('audio', new File([new Uint8Array(0)], 'voice.m4a', { type: 'audio/mp4' }))
    const empty = await voiceApp.request('/transcribe', { method: 'POST', body: emptyForm }, env)
    expect(empty.status).toBe(400)
    expect((await empty.json() as any).error).toBe('AUDIO_TOO_LONG')
  })

  test('POST /transcribe: STT VoiceError면 원문 메시지로 502', async () => {
    const { kv, env } = makeEnv({
      ai: mockAI(() => { throw new VoiceError('음성을 인식하지 못했습니다. 다시 녹음해주세요.') }),
    })
    const res = await voiceApp.request('/transcribe', { method: 'POST', body: audioForm('10') }, env)
    expect(res.status).toBe(502)
    const body = await res.json() as any
    expect(body.error).toBe('STT_FAILED')
    expect(body.message).toBe('음성을 인식하지 못했습니다. 다시 녹음해주세요.')
    expect(await getVoiceUsage(kv as any)).toMatchObject({ total: 0 })
  })

  test('POST /synthesize: TTS VoiceError면 원문 메시지로 502', async () => {
    const { kv, env } = makeEnv({
      ai: mockAI(() => { throw new VoiceError('음성 합성에 실패했습니다. 잠시 후 다시 시도해주세요.') }),
    })
    const res = await voiceApp.request('/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '안녕하세요' }),
    }, env)
    expect(res.status).toBe(502)
    const body = await res.json() as any
    expect(body.error).toBe('TTS_FAILED')
    expect(body.message).toBe('음성 합성에 실패했습니다. 잠시 후 다시 시도해주세요.')
    expect(await getVoiceUsage(kv as any)).toMatchObject({ total: 0 })
  })

  test('GET /status: AI 미연결이면 enabled false, 200 유지', async () => {
    const { env } = makeEnv({ ai: null })
    const res = await voiceApp.request('/status', {}, env)
    expect(res.status).toBe(200)
    const d = await res.json() as any
    expect(d.ok).toBe(true)
    expect(d.enabled).toBe(false)
    expect(d.today).toEqual({ stt: 0, tts: 0, total: 0, remaining: 100 })
  })
})
