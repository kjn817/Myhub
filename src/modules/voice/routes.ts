// 음성 인터페이스 모듈 — STT/TTS API (진짜 비서 3단계 h트랙)
// POST /api/voice/transcribe — 녹음 오디오 → 전사 텍스트 (Whisper)
// POST /api/voice/synthesize — 비서 응답 텍스트 → 오디오 (MeloTTS)
// GET  /api/voice/status    — 모델·한도·오늘 사용량
//
// - 인증은 전역 미들웨어(index.ts)가 담당한다. 이 모듈은 인증 뒤에 마운트된다.
// - 오디오는 어디에도 저장하지 않는다. 요청 처리 중 메모리에만 존재한다.
// - 전사 텍스트는 사용자가 직접 입력한 텍스트와 동일하게 취급해 기존
//   /api/ai/chat 경로로 전달한다. 잠긴 메모에는 닿지 않는다.
// - 실제 Workers AI 호출은 하지 않고(테스트는 모의 응답), 한도 초과 시
//   Free 플랜 실패 전에 429로 차단하고 텍스트 입력 폴백을 안내한다.
import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  VOICE_STT_MODEL,
  VOICE_TTS_MODEL,
  VOICE_STT_NEURONS_PER_MIN,
  VOICE_TTS_NEURONS_PER_MIN,
  VOICE_FREE_DAILY_NEURONS,
  VOICE_MAX_AUDIO_SECONDS,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_TTS_CHARS,
  VOICE_MAX_TTS_INPUT_CHARS,
  VOICE_DEFAULT_DAILY_LIMIT,
  VoiceError,
  validateAudioUpload,
  estimateSttNeurons,
  estimateTtsNeurons,
  transcribeAudio,
  synthesizeSpeech,
  checkVoiceQuota,
  recordVoiceUsage,
  getVoiceUsage,
  resolveDailyLimit,
} from '../../services/voice'

export const voiceApp = new Hono<{ Bindings: Env }>()

// POST /api/voice/transcribe — multipart/form-data { audio: File, durationSeconds? }
voiceApp.post('/transcribe', async (c) => {
  if (!c.env.AI) {
    return c.json({ ok: false, error: 'VOICE_UNAVAILABLE', message: '음성 기능이 아직 켜지지 않았습니다. 텍스트로 입력해주세요.' }, 503)
  }
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ ok: false, error: 'BAD_REQUEST', message: '오디오를 전송하지 못했습니다. 다시 녹음해주세요.' }, 400)
  }
  const file = form.get('audio')
  if (!file || typeof file === 'string') {
    return c.json({ ok: false, error: 'NO_AUDIO', message: '녹음된 오디오가 없습니다.' }, 400)
  }
  const durationRaw = form.get('durationSeconds')
  const durationSeconds = durationRaw !== null && durationRaw !== undefined
    ? Number(durationRaw)
    : undefined
  const bytes = new Uint8Array(await file.arrayBuffer())
  const invalid = validateAudioUpload(bytes, file.type || '', durationSeconds)
  if (invalid) {
    const status = invalid.includes('너무 큽니다') || invalid.includes('초까지만') ? 413 : 400
    return c.json({ ok: false, error: 'AUDIO_TOO_LONG', message: invalid }, status)
  }
  const limit = await resolveDailyLimit(c.env)
  const quota = await checkVoiceQuota(c.env.KV, limit)
  if (!quota.allowed) {
    return c.json({
      ok: false,
      error: 'VOICE_DAILY_LIMIT',
      message: `오늘 음성 사용량(${limit}회)을 다 썼습니다. 내일 다시 사용하거나 텍스트로 입력해주세요.`,
      used: quota.used,
      limit: quota.limit,
    }, 429)
  }
  try {
    const { text } = await transcribeAudio(c.env.AI as any, bytes)
    await recordVoiceUsage(c.env.KV, 'stt')
    // 오디오는 여기서 버려진다 — bytes는 이 핸들러 스코프를 벗어나지 않는다.
    return c.json({
      ok: true,
      text,
      seconds: durationSeconds ?? null,
      neuronsEstimate: durationSeconds ? estimateSttNeurons(durationSeconds) : null,
    })
  } catch (e: any) {
    // 원시 프로바이더 에러는 그대로 노출하지 않는다. 서비스가 만든
    // VoiceError(사용자용 문장)만 전달하고, 나머지는 고정 폴백 안내.
    const message = e instanceof VoiceError
      ? e.message
      : '음성 인식에 실패했습니다. 텍스트로 입력해주세요.'
    return c.json({ ok: false, error: 'STT_FAILED', message }, 502)
  }
})

// POST /api/voice/synthesize — JSON { text, lang? } → 오디오 바이트
voiceApp.post('/synthesize', async (c) => {
  if (!c.env.AI) {
    return c.json({ ok: false, error: 'VOICE_UNAVAILABLE', message: '음성 기능이 아직 켜지지 않았습니다.' }, 503)
  }
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'BAD_REQUEST', message: '요청 본문을 읽을 수 없습니다.' }, 400)
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return c.json({ ok: false, error: 'NO_TEXT', message: '읽을 텍스트가 없습니다.' }, 400)
  }
  if (text.length > VOICE_MAX_TTS_INPUT_CHARS) {
    return c.json({ ok: false, error: 'TEXT_TOO_LONG', message: `읽을 텍스트는 ${VOICE_MAX_TTS_INPUT_CHARS}자까지만 가능합니다.` }, 413)
  }
  const limit = await resolveDailyLimit(c.env)
  const quota = await checkVoiceQuota(c.env.KV, limit)
  if (!quota.allowed) {
    return c.json({
      ok: false,
      error: 'VOICE_DAILY_LIMIT',
      message: `오늘 음성 사용량(${limit}회)을 다 썼습니다.`,
      used: quota.used,
      limit: quota.limit,
    }, 429)
  }
  try {
    const { audio, lang, chars, contentType } = await synthesizeSpeech(c.env.AI as any, text)
    await recordVoiceUsage(c.env.KV, 'tts')
    return new Response(audio as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(audio.length),
        'Cache-Control': 'no-store',
        'X-Voice-Lang': lang,
        'X-Voice-Chars': String(chars),
        'X-Voice-Neurons-Estimate': String(estimateTtsNeurons(chars)),
      },
    })
  } catch (e: any) {
    const message = e instanceof VoiceError ? e.message : '음성 합성에 실패했습니다.'
    return c.json({ ok: false, error: 'TTS_FAILED', message }, 502)
  }
})

// GET /api/voice/status — 모델·한도·오늘 사용량 (설정 화면·디버깅용)
voiceApp.get('/status', async (c) => {
  const limit = await resolveDailyLimit(c.env)
  const usage = await getVoiceUsage(c.env.KV)
  return c.json({
    ok: true,
    enabled: !!c.env.AI,
    sttModel: VOICE_STT_MODEL,
    ttsModel: VOICE_TTS_MODEL,
    limits: {
      maxAudioSeconds: VOICE_MAX_AUDIO_SECONDS,
      maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
      maxTtsChars: VOICE_MAX_TTS_CHARS,
      dailyLimit: limit,
      defaultDailyLimit: VOICE_DEFAULT_DAILY_LIMIT,
      freeDailyNeurons: VOICE_FREE_DAILY_NEURONS,
      sttNeuronsPerMin: VOICE_STT_NEURONS_PER_MIN,
      ttsNeuronsPerMin: VOICE_TTS_NEURONS_PER_MIN,
    },
    today: {
      stt: usage.stt,
      tts: usage.tts,
      total: usage.total,
      remaining: Math.max(0, limit - usage.total),
    },
    note: '음성 오디오는 저장하지 않습니다. 한도는 00:00 UTC에 리셋됩니다.',
  })
})
