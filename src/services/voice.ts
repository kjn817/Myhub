/**
 * 음성 인터페이스 서비스 — Workers AI 음성 파이프라인 (진짜 비서 3단계 h트랙)
 *
 * STT: @cf/openai/whisper-large-v3-turbo (46.63 neurons/오디오 분)
 * TTS: @cf/myshell-ai/melotts (18.63 neurons/오디오 분, 다국어 — 한국어 'kr' 지원)
 * 무료 티어: 계정당 10,000 neurons/일 공유 (00:00 UTC 리셋, 초과 시 Free 플랜은 실패)
 *   → 60초 음성 왕복(STT 60초 + TTS 약 30초 분량) ≈ 56 neurons.
 *   → 기본 일일 상한 100회면 약 5,600 neurons로, 다른 Workers AI 용도
 *     (Clef 라우터·요약 등)와 합쳐도 무료 티어 안에 들어간다.
 * 출처: Cloudflare Workers AI Pricing 문서 (2026-10-26 확인)
 *   https://developers.cloudflare.com/workers-ai/platform/pricing/
 *
 * 개인정보 경계:
 * - 음성 오디오는 어디에도 저장하지 않는다. 메모리에만 두고 Workers AI 호출 후 버린다.
 * - 전사 텍스트는 사용자가 직접 입력한 텍스트와 동일하게 취급한다.
 *   잠긴 메모에는 닿지 않으며, 메모 잠금 정책을 우회하는 경로가 없다
 *   (이 모듈은 메모를 읽지도 쓰지도 않는다).
 * - TTS 입력은 비서 응답 텍스트(공개 응답)만 받는다. 잠긴 메모 내용은
 *   애초에 비서 응답에 포함되지 않으므로(정책 경계) 음성 경로로도 새지 않는다.
 *
 * iOS PWA 제약 (실기기 미검증 — docs/voice-interface.md 참조):
 * - MediaRecorder는 iOS Safari 14.5+ / PWA(standalone)에서 동작하나,
 *   반드시 사용자 제스처(버튼 탭)에서 시작해야 하고, mimeType은 audio/mp4(AAC)만
 *   지원한다. 'audio/webm'을 강제하면 MediaRecorder 생성 자체가 실패한다.
 * - 오디오 재생도 사용자 제스처(재생 버튼 탭)에서만 허용된다. 자동 재생 금지.
 * - 무음 스위치가 켜져 있으면 <audio> 재생이 들리지 않을 수 있다.
 */

import type { Env } from '../types'

// Cloudflare AI Gateway 통합 관측성 (트랙 B2, 2026-10-26) — Workers AI 호출에 gateway 옵션
import { AI_GATEWAY_OPTIONS } from './ai-gateway'
import { classifyLevel, TokenVault } from './privacy-engine'

// ---------------------------------------------------------------------------
// 모델·한도 상수 (Cloudflare Workers AI Pricing 문서 기준, 2026-10-26)
// ---------------------------------------------------------------------------

/** STT 모델 — Whisper large-v3-turbo */
export const VOICE_STT_MODEL = '@cf/openai/whisper-large-v3-turbo'
/** TTS 모델 — MeloTTS (다국어, 한국어 지원) */
export const VOICE_TTS_MODEL = '@cf/myshell-ai/melotts'
/** STT 단가: neurons / 오디오 분 */
export const VOICE_STT_NEURONS_PER_MIN = 46.63
/** TTS 단가: neurons / 오디오 분 */
export const VOICE_TTS_NEURONS_PER_MIN = 18.63
/** 무료 티어 일일 뉴런 (계정 공유) */
export const VOICE_FREE_DAILY_NEURONS = 10_000

/** 음성 입력 길이 상한 (초) — 60초를 넘기면 413 */
export const VOICE_MAX_AUDIO_SECONDS = 60
/** 음성 입력 크기 상한 (바이트) — 60초 AAC(약 1MB)에 여유를 둔 하드 게이트 */
export const VOICE_MAX_AUDIO_BYTES = 2 * 1024 * 1024
/** TTS 모델 입력 상한 (자) — MeloTTS 입력 제한(1024자) 안쪽으로 둔다 */
export const VOICE_MAX_TTS_CHARS = 1000
/** TTS API 입력 자체의 남용 방지 상한 (자) — 이 이상은 400 */
export const VOICE_MAX_TTS_INPUT_CHARS = 5000
/** 일일 음성 요청 상한 기본값 (STT+TTS 합산) */
export const VOICE_DEFAULT_DAILY_LIMIT = 100
/** 일일 사용량 KV 키 TTL (초) — 2일이면 자정 경계에서도 안전 */
export const VOICE_USAGE_TTL_SECONDS = 2 * 24 * 3600

/** Whisper가 받는 오디오 컨테이너 (MediaRecorder 산출물 기준) */
export const VOICE_ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/aac',
])

/** TTS 분당 예상 문자 수 (한국어 낭독 속도 근사치 — 비용 추산용) */
const TTS_CHARS_PER_AUDIO_MIN = 750

// ---------------------------------------------------------------------------
// 순수 헬퍼
// ---------------------------------------------------------------------------

/** 한국어 포함 여부로 TTS 언어 결정 (MeloTTS lang 코드: 'kr' | 'en') */
export function detectTtsLang(text: string): 'kr' | 'en' {
  return /[\uAC00-\uD7AF]/.test(text) ? 'kr' : 'en'
}

/**
 * 비서 응답 텍스트를 TTS 입력용 평문으로 정리한다.
 * - 마크다운 링크 [표시](url) → 표시, 이미지·코드펜스·헤딩 기호 제거
 * - HTML 태그 제거, 공백 정리
 * - 상한을 넘기면 문장 경계에서 자른다 (말 중간에 끊기지 않게)
 */
export function stripForTts(text: string): string {
  let t = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 이미지 → 대체 텍스트
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크 → 표시 텍스트
    .replace(/```[\s\S]*?```/g, ' ') // 코드 블록 제거
    .replace(/`([^`]*)`/g, '$1') // 인라인 코드 → 내용
    .replace(/^#{1,6}\s+/gm, '') // 헤딩 기호
    .replace(/<[^>]+>/g, '') // HTML 태그 (반드시 '>' 제거보다 먼저)
    .replace(/[*_~>|]/g, '') // 강조·취소선·인용 기호
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > VOICE_MAX_TTS_CHARS) {
    const cut = t.slice(0, VOICE_MAX_TTS_CHARS)
    // 마지막 문장 종결(. ! ? 。) 뒤에서 자르고, 없으면 그대로 자른다
    const m = cut.match(/^(.*[.!?。])\s[^.!?。]*$/)
    t = (m ? m[1] : cut).trim()
  }
  return t
}

/** 업로드 오디오 검증 — 문제 있으면 에러 메시지, 없으면 null */
export function validateAudioUpload(
  bytes: Uint8Array,
  mimeType: string,
  durationSeconds?: number,
): string | null {
  if (!bytes || bytes.length === 0) return '오디오가 비어 있습니다.'
  if (bytes.length > VOICE_MAX_AUDIO_BYTES) {
    return `오디오가 너무 큽니다. ${VOICE_MAX_AUDIO_SECONDS}초 이내로 녹음해주세요.`
  }
  // mimeType이 비어 있으면(MediaRecorder 기본값) 통과 — 크기 게이트가 하드 제한이다
  if (mimeType) {
    const base = mimeType.split(';')[0].trim().toLowerCase()
    if (!VOICE_ALLOWED_AUDIO_TYPES.has(base)) {
      return `지원하지 않는 오디오 형식입니다. (${base})`
    }
  }
  if (durationSeconds !== undefined) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return '녹음 길이를 확인할 수 없습니다.'
    }
    if (durationSeconds > VOICE_MAX_AUDIO_SECONDS) {
      return `녹음은 ${VOICE_MAX_AUDIO_SECONDS}초까지만 가능합니다.`
    }
  }
  return null
}

/** STT 예상 뉴런 (초 단위) */
export function estimateSttNeurons(seconds: number): number {
  return Math.ceil((seconds / 60) * VOICE_STT_NEURONS_PER_MIN)
}

/** TTS 예상 뉴런 (문자 수 기준, 낭독 속도 근사) */
export function estimateTtsNeurons(chars: number): number {
  const minutes = chars / TTS_CHARS_PER_AUDIO_MIN
  return Math.ceil(minutes * VOICE_TTS_NEURONS_PER_MIN)
}

/**
 * 오디오 바이트 앞부분으로 컨테이너를 판별해 Content-Type을 정한다.
 * MeloTTS 반환값이 wav인지 mp3인지 런타임에 달라질 수 있어 매직 바이트로 판별한다.
 */
export function sniffAudioContentType(bytes: Uint8Array): string {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'audio/wav' // RIFF....WAVE
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg' // ID3
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg' // MP3 프레임 싱크
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'audio/mp4' // ....ftyp
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'audio/ogg' // OggS
  }
  return 'audio/wav' // 기본값: MeloTTS 기본 출력
}

// ---------------------------------------------------------------------------
// Workers AI 호출
// ---------------------------------------------------------------------------

export type VoiceAI = { run: (model: string, input: any, options?: any) => Promise<any> }

/** 서비스가 의도적으로 만드는 사용자용 에러 — 라우트는 메시지를 그대로 전달한다. */
export class VoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** STT — 오디오 바이트 → 전사 텍스트 (저장 없음, 메모리에서만 처리) */
export async function transcribeAudio(
  ai: VoiceAI,
  audioBytes: Uint8Array,
): Promise<{ text: string }> {
  const result = await ai.run(VOICE_STT_MODEL, { audio: [...audioBytes] }, AI_GATEWAY_OPTIONS)
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  if (!text) throw new VoiceError('음성을 인식하지 못했습니다. 다시 말씀해주세요.')
  return { text }
}

/** Workers AI가 반환하는 오디오를 Uint8Array로 정규화한다. */
export async function normalizeAudioResult(result: any): Promise<Uint8Array> {
  if (!result) throw new VoiceError('음성 합성에 실패했습니다.')
  if (result instanceof Uint8Array) return result
  if (result instanceof ArrayBuffer) return new Uint8Array(result)
  if (Array.isArray(result)) return new Uint8Array(result)
  // ReadableStream (Workers AI 바인딩이 오디오 모델에 대해 반환하는 형태)
  if (typeof result.getReader === 'function') {
    const reader = result.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value))
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }
  if (Array.isArray(result.audio)) return new Uint8Array(result.audio)
  if (typeof result.audio === 'string') {
    // base64 인코딩 오디오 (방어적 처리)
    const bin = atob(result.audio)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  throw new VoiceError('음성 합성 결과를 해석할 수 없습니다.')
}

/** TTS — 비서 응답 텍스트 → 오디오 바이트 */
export async function synthesizeSpeech(
  ai: VoiceAI,
  text: string,
): Promise<{ audio: Uint8Array; lang: 'kr' | 'en'; chars: number; contentType: string; privacyRedacted: boolean }> {
  if (classifyLevel({ text }).level >= 3) {
    throw new VoiceError('민감한 내용이 포함되어 음성으로 읽을 수 없습니다.')
  }
  const stripped = stripForTts(text)
  if (!stripped) throw new VoiceError('음성으로 읽을 내용이 없습니다.')
  const vault = new TokenVault()
  const sanitized = vault.sanitize(stripped)
  const privacyRedacted = sanitized.findings.some((f) => f.level >= 2)
  const plain = sanitized.text
  const lang = detectTtsLang(plain)
  const result = await ai.run(VOICE_TTS_MODEL, { prompt: plain, lang }, AI_GATEWAY_OPTIONS)
  const audio = await normalizeAudioResult(result)
  if (audio.length === 0) throw new VoiceError('음성 합성에 실패했습니다.')
  return { audio, lang, chars: plain.length, contentType: sniffAudioContentType(audio), privacyRedacted }
}

// ---------------------------------------------------------------------------
// 일일 사용량 (KV 카운터 — D1 쓰기 없음, 오디오·텍스트 저장 없음)
// ---------------------------------------------------------------------------

export type VoiceUsage = { stt: number; tts: number; total: number }

export function voiceUsageKey(date = new Date()): string {
  const day = date.toISOString().slice(0, 10) // UTC 날짜 (뉴런 리셋 기준과 동일)
  return `voice:usage:${day}`
}

export async function getVoiceUsage(kv: KVNamespace): Promise<VoiceUsage> {
  try {
    const raw = await kv.get(voiceUsageKey())
    if (!raw) return { stt: 0, tts: 0, total: 0 }
    const parsed = JSON.parse(raw) as Partial<VoiceUsage>
    return {
      stt: Number(parsed.stt) || 0,
      tts: Number(parsed.tts) || 0,
      total: Number(parsed.total) || 0,
    }
  } catch {
    return { stt: 0, tts: 0, total: 0 }
  }
}

export async function checkVoiceQuota(
  kv: KVNamespace,
  limit: number,
): Promise<{ allowed: boolean; used: number; remaining: number; limit: number }> {
  const usage = await getVoiceUsage(kv)
  return {
    allowed: usage.total < limit,
    used: usage.total,
    remaining: Math.max(0, limit - usage.total),
    limit,
  }
}

/** 음성 요청 1건을 카운터에 기록한다 (단일 사용자 전제 — 동시성 경합은 무시). */
export async function recordVoiceUsage(kv: KVNamespace, kind: 'stt' | 'tts'): Promise<VoiceUsage> {
  const usage = await getVoiceUsage(kv)
  usage[kind] += 1
  usage.total += 1
  await kv.put(voiceUsageKey(), JSON.stringify(usage), { expirationTtl: VOICE_USAGE_TTL_SECONDS })
  return usage
}

/**
 * 일일 상한 결정 — 우선순위: ai_settings(voice.daily_limit) > 환경변수
 * VOICE_DAILY_LIMIT > 기본값 100. ai.ts 전체를 import하지 않기 위해
 * ai_settings SELECT만 직접 수행한다 (getSetting과 동일 쿼리).
 */
export async function resolveDailyLimit(env: Env): Promise<number> {
  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?')
        .bind('voice.daily_limit')
        .first<{ value: string }>()
      const n = row ? parseInt(row.value, 10) : NaN
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    // D1 조회 실패 시 환경변수·기본값으로 폴백
  }
  const fromEnv = parseInt(env.VOICE_DAILY_LIMIT || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return VOICE_DEFAULT_DAILY_LIMIT
}
