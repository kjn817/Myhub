/**
 * 음성 인터페이스 테스트 — STT·TTS 변환 로직(모의 Workers AI 응답),
 * API 엔드포인트 통합, 길이·한도 검증.
 * 실제 Workers AI 호출 없음. 운영 D1·배포에 닿지 않는다.
 */
import { voiceApp } from '../src/modules/voice/routes'
import {
  VOICE_STT_MODEL,
  VOICE_TTS_MODEL,
  VOICE_MAX_AUDIO_SECONDS,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_TTS_CHARS,
  VOICE_DEFAULT_DAILY_LIMIT,
  detectTtsLang,
  stripForTts,
  validateAudioUpload,
  estimateSttNeurons,
  estimateTtsNeurons,
  sniffAudioContentType,
  normalizeAudioResult,
  transcribeAudio,
  synthesizeSpeech,
  getVoiceUsage,
  checkVoiceQuota,
  recordVoiceUsage,
  resolveDailyLimit,
} from '../src/services/voice'

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

// RIFF 헤더를 가진 가짜 wav 바이트
function fakeWavBytes(n = 100): Uint8Array {
  const b = new Uint8Array(n)
  b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46 // RIFF
  b[8] = 0x57; b[9] = 0x41; b[10] = 0x56; b[11] = 0x45 // WAVE
  return b
}

function mockAI(impl?: (model: string, input: any) => any) {
  const calls: Array<{ model: string; input: any }> = []
  const ai = {
    calls,
    run: jest.fn(async (model: string, input: any) => {
      calls.push({ model, input })
      if (impl) return impl(model, input)
      if (model === VOICE_STT_MODEL) return { text: '안녕하세요', word_count: 1, words: [] }
      if (model === VOICE_TTS_MODEL) return fakeWavBytes()
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

async function call(env: any, path: string, init?: RequestInit) {
  return voiceApp.request(path, init, env)
}

describe('detectTtsLang', () => {
  test('한글 포함 → kr', () => {
    expect(detectTtsLang('안녕하세요')).toBe('kr')
    expect(detectTtsLang('Hello 안녕')).toBe('kr')
  })
  test('영어만 → en', () => {
    expect(detectTtsLang('Hello world')).toBe('en')
  })
})

describe('stripForTts', () => {
  test('마크다운 링크·코드·HTML을 평문으로 정리', () => {
    const out = stripForTts('자세한 내용은 [공식 문서](https://example.com)를 참고하세요. `코드`와\n```js\nconst x = 1\n```\n<b>굵은 글</b>입니다.')
    expect(out).toBe('자세한 내용은 공식 문서를 참고하세요. 코드와 굵은 글입니다.')
    expect(out).not.toContain('https://')
    expect(out).not.toContain('```')
  })
  test('1000자 상한에서 문장 경계로 자른다', () => {
    const long = '첫 문장입니다. ' + '가'.repeat(1500)
    const out = stripForTts(long)
    expect(out.length).toBeLessThanOrEqual(VOICE_MAX_TTS_CHARS)
    expect(out).toBe('첫 문장입니다.')
  })
  test('문장 종결이 없으면 상한에서 그대로 자른다', () => {
    const out = stripForTts('가'.repeat(1500))
    expect(out.length).toBe(VOICE_MAX_TTS_CHARS)
  })
})

describe('validateAudioUpload', () => {
  test('정상: mp4 60초 이내', () => {
    expect(validateAudioUpload(new Uint8Array(1000), 'audio/mp4', 30)).toBeNull()
  })
  test('정상: mimeType이 비어 있어도 크기 게이트로 통과', () => {
    expect(validateAudioUpload(new Uint8Array(1000), '', 10)).toBeNull()
  })
  test('빈 오디오 거부', () => {
    expect(validateAudioUpload(new Uint8Array(0), 'audio/mp4')).toMatch(/비어/)
  })
  test('2MB 초과 거부', () => {
    expect(validateAudioUpload(new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1), 'audio/mp4'))
      .toMatch(/너무 큽니다/)
  })
  test('지원하지 않는 형식 거부', () => {
    expect(validateAudioUpload(new Uint8Array(100), 'audio/flac')).toMatch(/지원하지 않는/)
  })
  test('60초 초과 거부', () => {
    expect(validateAudioUpload(new Uint8Array(100), 'audio/mp4', 61)).toMatch(/60초/)
    expect(validateAudioUpload(new Uint8Array(100), 'audio/mp4', VOICE_MAX_AUDIO_SECONDS)).toBeNull()
  })
})

describe('비용 추산', () => {
  test('STT 60초 = 47 neurons (46.63 올림)', () => {
    expect(estimateSttNeurons(60)).toBe(47)
    expect(estimateSttNeurons(30)).toBe(24)
  })
  test('TTS 750자 ≈ 19 neurons (18.63 올림)', () => {
    expect(estimateTtsNeurons(750)).toBe(19)
  })
  test('60초 왕복(STT 60초 + TTS 30초 분량)은 무료 티어의 1% 미만', () => {
    const roundTrip = estimateSttNeurons(60) + estimateTtsNeurons(375)
    expect(roundTrip).toBeLessThan(100)
  })
})

describe('sniffAudioContentType', () => {
  test('RIFF → wav, ID3 → mpeg, ftyp → mp4, OggS → ogg', () => {
    expect(sniffAudioContentType(fakeWavBytes())).toBe('audio/wav')
    expect(sniffAudioContentType(new Uint8Array([0x49, 0x44, 0x33, 0x00]))).toBe('audio/mpeg')
    const mp4 = new Uint8Array(12); mp4[4] = 0x66; mp4[5] = 0x74; mp4[6] = 0x79; mp4[7] = 0x70
    expect(sniffAudioContentType(mp4)).toBe('audio/mp4')
    expect(sniffAudioContentType(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe('audio/ogg')
  })
  test('알 수 없으면 wav 기본값', () => {
    expect(sniffAudioContentType(new Uint8Array([1, 2, 3]))).toBe('audio/wav')
  })
})

describe('normalizeAudioResult', () => {
  test('Uint8Array·ArrayBuffer·배열 그대로 통과', async () => {
    const b = fakeWavBytes(10)
    expect(await normalizeAudioResult(b)).toEqual(b)
    expect(await normalizeAudioResult(b.buffer)).toEqual(b)
    expect(await normalizeAudioResult([...b])).toEqual(b)
  })
  test('ReadableStream을 합쳐서 반환', async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close() },
    })
    expect(await normalizeAudioResult(stream)).toEqual(new Uint8Array([1, 2, 3]))
  })
  test('{ audio: [...] } 형태도 처리', async () => {
    expect(await normalizeAudioResult({ audio: [1, 2] })).toEqual(new Uint8Array([1, 2]))
  })
  test('해석 불가 결과는 에러', async () => {
    await expect(normalizeAudioResult({})).rejects.toThrow()
    await expect(normalizeAudioResult(null)).rejects.toThrow()
  })
})

describe('transcribeAudio / synthesizeSpeech (모의 Workers AI)', () => {
  test('STT: whisper-large-v3-turbo 호출, 텍스트 반환', async () => {
    const ai = mockAI()
    const { text } = await transcribeAudio(ai as any, new Uint8Array([1, 2, 3]))
    expect(text).toBe('안녕하세요')
    expect(ai.calls[0].model).toBe(VOICE_STT_MODEL)
    expect(ai.calls[0].input.audio).toEqual([1, 2, 3])
  })
  test('STT: 빈 전사 결과는 에러 (무음·인식 실패)', async () => {
    const ai = mockAI(() => ({ text: '   ' }))
    await expect(transcribeAudio(ai as any, new Uint8Array([1]))).rejects.toThrow(/인식하지 못했습니다/)
  })
  test('TTS: melotts 호출, 한국어면 lang=kr, 마크다운 정리 후 전달', async () => {
    const ai = mockAI()
    const r = await synthesizeSpeech(ai as any, '자세한 내용은 [문서](https://example.com)를 보세요.')
    expect(r.lang).toBe('kr')
    expect(r.contentType).toBe('audio/wav')
    expect(r.audio.length).toBeGreaterThan(0)
    expect(ai.calls[0].model).toBe(VOICE_TTS_MODEL)
    expect(ai.calls[0].input.lang).toBe('kr')
    expect(ai.calls[0].input.prompt).not.toContain('https://')
  })
  test('TTS: 영어면 lang=en', async () => {
    const ai = mockAI()
    const r = await synthesizeSpeech(ai as any, 'Hello world')
    expect(r.lang).toBe('en')
    expect(ai.calls[0].input.lang).toBe('en')
  })
  test('TTS: 읽을 내용 없음은 에러', async () => {
    const ai = mockAI()
    await expect(synthesizeSpeech(ai as any, '   ')).rejects.toThrow()
    expect(ai.run).not.toHaveBeenCalled()
  })
})

describe('일일 사용량 (KV 카운터)', () => {
  test('초기 0 → 기록 시 stt/total 증가, 오디오·텍스트는 KV에 저장되지 않음', async () => {
    const kv = fakeKV()
    expect(await getVoiceUsage(kv as any)).toEqual({ stt: 0, tts: 0, total: 0 })
    await recordVoiceUsage(kv as any, 'stt')
    await recordVoiceUsage(kv as any, 'tts')
    expect(await getVoiceUsage(kv as any)).toEqual({ stt: 1, tts: 1, total: 2 })
    expect(kv.store.size).toBe(1)
    expect([...kv.store.keys()][0]).toMatch(/^voice:usage:\d{4}-\d{2}-\d{2}$/)
  })
  test('상한 도달 시 차단, 미만이면 허용', async () => {
    const kv = fakeKV()
    await recordVoiceUsage(kv as any, 'stt')
    expect(await checkVoiceQuota(kv as any, 2)).toMatchObject({ allowed: true, used: 1, remaining: 1 })
    await recordVoiceUsage(kv as any, 'stt')
    expect(await checkVoiceQuota(kv as any, 2)).toMatchObject({ allowed: false, used: 2, remaining: 0 })
  })
  test('resolveDailyLimit 우선순위: ai_settings > 환경변수 > 기본값 100', async () => {
    const { env } = makeEnv({ settings: { 'voice.daily_limit': '5' }, dailyLimit: '7' })
    expect(await resolveDailyLimit(env)).toBe(5)
    const { env: env2 } = makeEnv({ dailyLimit: '7' })
    expect(await resolveDailyLimit(env2)).toBe(7)
    const { env: env3 } = makeEnv({})
    expect(await resolveDailyLimit(env3)).toBe(VOICE_DEFAULT_DAILY_LIMIT)
    const { env: env4 } = makeEnv({ settings: { 'voice.daily_limit': 'abc' }, dailyLimit: '0' })
    expect(await resolveDailyLimit(env4)).toBe(VOICE_DEFAULT_DAILY_LIMIT)
  })
})

describe('GET /status', () => {
  test('모델·한도·오늘 사용량 반환', async () => {
    const { env } = makeEnv({})
    const res = await call(env, '/status')
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.ok).toBe(true)
    expect(d.enabled).toBe(true)
    expect(d.sttModel).toBe(VOICE_STT_MODEL)
    expect(d.ttsModel).toBe(VOICE_TTS_MODEL)
    expect(d.limits.maxAudioSeconds).toBe(60)
    expect(d.limits.dailyLimit).toBe(100)
    expect(d.today).toEqual({ stt: 0, tts: 0, total: 0, remaining: 100 })
  })
})

describe('POST /transcribe', () => {
  function audioForm(durationSeconds?: number) {
    const form = new FormData()
    form.append('audio', new File([new Uint8Array(1000)], 'voice.m4a', { type: 'audio/mp4' }))
    if (durationSeconds !== undefined) form.append('durationSeconds', String(durationSeconds))
    return form
  }
  test('성공: 전사 텍스트 + 사용량 기록', async () => {
    const { kv, env } = makeEnv({})
    const res = await call(env, '/transcribe', { method: 'POST', body: audioForm(30) })
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.ok).toBe(true)
    expect(d.text).toBe('안녕하세요')
    expect(d.neuronsEstimate).toBe(24)
    expect(await getVoiceUsage(kv as any)).toMatchObject({ stt: 1, total: 1 })
  })
  test('오디오 없음 → 400', async () => {
    const { env } = makeEnv({})
    const res = await call(env, '/transcribe', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('NO_AUDIO')
  })
  test('61초 녹음 → 413', async () => {
    const { env } = makeEnv({})
    const res = await call(env, '/transcribe', { method: 'POST', body: audioForm(61) })
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('AUDIO_TOO_LONG')
  })
  test('일일 상한 초과 → 429 + 텍스트 폴백 안내, 사용량 미기록', async () => {
    const { kv, env } = makeEnv({ dailyLimit: '1' })
    expect((await call(env, '/transcribe', { method: 'POST', body: audioForm(10) })).status).toBe(200)
    const res = await call(env, '/transcribe', { method: 'POST', body: audioForm(10) })
    expect(res.status).toBe(429)
    const d = await res.json()
    expect(d.error).toBe('VOICE_DAILY_LIMIT')
    expect(d.message).toMatch(/텍스트로 입력/)
    expect(await getVoiceUsage(kv as any)).toMatchObject({ total: 1 })
  })
  test('AI 바인딩 없음 → 503 + 텍스트 폴백 안내', async () => {
    const { env } = makeEnv({ ai: null })
    const res = await call(env, '/transcribe', { method: 'POST', body: audioForm(10) })
    expect(res.status).toBe(503)
    expect((await res.json()).message).toMatch(/텍스트로 입력/)
  })
  test('STT 실패 → 502 + 폴백 안내, 사용량 미기록', async () => {
    const { kv, env } = makeEnv({ ai: mockAI(() => { throw new Error('boom') }) })
    const res = await call(env, '/transcribe', { method: 'POST', body: audioForm(10) })
    expect(res.status).toBe(502)
    expect((await res.json()).message).toMatch(/텍스트로 입력/)
    expect(await getVoiceUsage(kv as any)).toMatchObject({ total: 0 })
  })
})

describe('POST /synthesize', () => {
  test('성공: 오디오 바이트 + no-store + 예상 뉴런 헤더', async () => {
    const { kv, env } = makeEnv({})
    const res = await call(env, '/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '안녕하세요' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/wav')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Voice-Lang')).toBe('kr')
    expect(res.headers.get('X-Voice-Neurons-Estimate')).toBeTruthy()
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect(buf[0]).toBe(0x52) // RIFF
    expect(await getVoiceUsage(kv as any)).toMatchObject({ tts: 1, total: 1 })
  })
  test('빈 텍스트 → 400, 5000자 초과 → 413', async () => {
    const { env } = makeEnv({})
    const empty = await call(env, '/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '  ' }),
    })
    expect(empty.status).toBe(400)
    const tooLong = await call(env, '/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '가'.repeat(5001) }),
    })
    expect(tooLong.status).toBe(413)
  })
  test('일일 상한 초과 → 429', async () => {
    const { env } = makeEnv({ dailyLimit: '1' })
    const body = JSON.stringify({ text: '안녕' })
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    expect((await call(env, '/synthesize', init)).status).toBe(200)
    expect((await call(env, '/synthesize', init)).status).toBe(429)
  })
  test('AI 바인딩 없음 → 503, TTS 실패 → 502', async () => {
    const { env } = makeEnv({ ai: null })
    const res = await call(env, '/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '안녕' }),
    })
    expect(res.status).toBe(503)
    const { env: env2 } = makeEnv({ ai: mockAI(() => { throw new Error('boom') }) })
    const res2 = await call(env2, '/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '안녕' }),
    })
    expect(res2.status).toBe(502)
  })
})
