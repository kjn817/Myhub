/**
 * 채널 게이트웨이 (OpenClaw 패턴 이식 — 트랙 5)
 *
 * 하나의 게이트웨이가 여러 메시지 채널을 플러그인으로 관리한다.
 * - ChannelPlugin: 채널별 인바운드 정규화(normalizeInbound) + 아웃바운드 전송(sendText)
 * - 게이트웨이는 전송 계층만 담당. AI 호출은 setAssistantHandler로 주입받는
 *   포트이며, 실제 핸들러는 모듈 레지스트리(src/modules.ts)에서 연결한다.
 *   (서비스가 모듈을 직접 import하지 않음 — 모듈 간 직접 import 금지 규칙 준수)
 * - 외부 서비스 의존 없이 동작하는 최소 채널로 범용 웹훅(webhook)을 내장한다.
 *   텔레그램 등 외부 채널은 이 인터페이스를 구현해 registerChannel로 추가하면 된다.
 *
 * 인증: 웹훅 경로는 세션 쿠키가 아니라 CHANNEL_WEBHOOK_SECRET 공유 시크릿으로
 * 인증한다. 시크릿 미설정 시 채널은 비활성화(fail-closed, 503).
 * 감사: 인바운드/아웃바운드는 channel_messages(마이그레이션 0048)에 기록한다.
 * 0048 미적용 DB에서도 게이트웨이 동작은 유지된다 (로그만 best-effort로 유실).
 */

import { isValidPersonaId } from '../ai/persona-registry'
import { MAX_TRUNCATED_USER_TEXT_CHARS } from '../lib/limits'

export interface ChannelMessage {
  /** 채널 플러그인 id ('webhook' 등) */
  channel: string
  /** 채널 내 대화 식별자 (발신자 기준) */
  channelId: string
  senderId: string
  text: string
  personaId?: string
  receivedAt: number
  raw?: unknown
}

export interface ChannelPlugin {
  id: string
  displayName: string
  /** 아웃바운드 전송 가능 여부 (웹훅은 인바운드 전용 → false) */
  supportsOutbound: boolean
  /** 외부 페이로드를 공통 ChannelMessage로 정규화 (무효면 null) */
  normalizeInbound(payload: unknown): ChannelMessage | null
  /** 아웃바운드 전송 (supportsOutbound=false면 미구현) */
  sendText?(target: string, text: string): Promise<void>
}

/** AI 핸들러 포트 — 모듈 레지스트리에서 callSingleAssistant를 연결한다 */
export type AssistantHandler = (
  env: any,
  personaId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
) => Promise<{ text: string }>

const channels = new Map<string, ChannelPlugin>()
let assistantHandler: AssistantHandler | null = null

export function registerChannel(plugin: ChannelPlugin, opts?: { replace?: boolean }): void {
  if (!plugin || !plugin.id) throw new Error('registerChannel: plugin.id required')
  if (typeof plugin.normalizeInbound !== 'function') {
    throw new Error(`registerChannel: plugin ${plugin.id} has no normalizeInbound()`)
  }
  if (channels.has(plugin.id) && !opts?.replace) {
    throw new Error(`registerChannel: channel already registered: ${plugin.id} (use { replace: true } to swap)`)
  }
  channels.set(plugin.id, plugin)
}

export function getChannel(id: string): ChannelPlugin | undefined {
  return channels.get(id)
}

export function listChannels(): ChannelPlugin[] {
  return [...channels.values()]
}

export function setAssistantHandler(fn: AssistantHandler | null): void {
  assistantHandler = fn
}

export function getAssistantHandler(): AssistantHandler | null {
  return assistantHandler
}

// ---------------------------------------------------------------------------
// 웹훅 채널 (내장 최소 채널 — 외부 서비스 의존 없음)
// 페이로드: { text: string, senderId?: string, personaId?: string }
// ---------------------------------------------------------------------------

export const webhookChannel: ChannelPlugin = {
  id: 'webhook',
  displayName: '범용 웹훅',
  supportsOutbound: false, // 인바운드 전용 — 응답은 HTTP 응답 본문으로 반환
  normalizeInbound(payload: unknown): ChannelMessage | null {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>
    if (typeof p.text !== 'string' || !p.text.trim()) return null
    const senderId = typeof p.senderId === 'string' && p.senderId.trim()
      ? p.senderId.trim().slice(0, 200)
      : 'webhook'
    const personaId = typeof p.personaId === 'string' && isValidPersonaId(p.personaId)
      ? p.personaId
      : undefined
    return {
      channel: 'webhook',
      channelId: senderId,
      senderId,
      text: p.text.slice(0, MAX_TRUNCATED_USER_TEXT_CHARS),
      personaId,
      receivedAt: Date.now(),
      raw: payload,
    }
  },
}

// 내장 채널 자동 등록 (import 시 1회)
registerChannel(webhookChannel)

// ---------------------------------------------------------------------------
// 인바운드 처리: 정규화 → AI 핸들러 → 응답 텍스트
// ---------------------------------------------------------------------------

export async function handleChannelMessage(
  env: any,
  channelId: string,
  payload: unknown,
): Promise<{ message: ChannelMessage; replyText: string }> {
  const channel = getChannel(channelId)
  if (!channel) throw new Error(`unknown channel: ${channelId}`)
  const message = channel.normalizeInbound(payload)
  if (!message) throw new Error('invalid channel payload')
  const handler = getAssistantHandler()
  if (!handler) throw new Error('assistant handler not configured')
  const personaId = message.personaId || 'concierge'
  const result = await handler(env, personaId, [{ role: 'user', content: message.text }])
  return { message, replyText: result?.text ?? '' }
}

// ---------------------------------------------------------------------------
// 웹훅 공유 시크릿 인증 (세션 쿠키 대신 사용)
// ---------------------------------------------------------------------------

/** 타이밍 공격 방지용 상수 시간 비교 */
export function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type WebhookAuthResult = 'ok' | 'disabled' | 'unauthorized'

/**
 * 웹훅 인증 판정
 * - 시크릿 미설정 → 'disabled' (채널 비활성화, fail-closed)
 * - Authorization: Bearer <secret> 또는 본문 secret 필드 중 하나라도 일치 → 'ok'
 */
export function verifyWebhookSecret(
  env: { CHANNEL_WEBHOOK_SECRET?: string },
  authHeader: string | null | undefined,
  bodySecret?: string | null | undefined,
): WebhookAuthResult {
  const configured = env.CHANNEL_WEBHOOK_SECRET
  if (!configured) return 'disabled'
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const candidate = bearer ?? (typeof bodySecret === 'string' ? bodySecret : null)
  if (!candidate) return 'unauthorized'
  return secretsEqual(candidate, configured) ? 'ok' : 'unauthorized'
}

// ---------------------------------------------------------------------------
// 감사 로그 (channel_messages — 마이그레이션 0048, best-effort)
// ---------------------------------------------------------------------------

export async function logChannelMessage(
  db: any,
  entry: {
    channel: string
    senderId: string
    personaId?: string
    direction: 'inbound' | 'outbound'
    text: string
  },
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO channel_messages (channel, sender_id, persona_id, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        entry.channel,
        entry.senderId,
        entry.personaId ?? null,
        entry.direction,
        entry.text.slice(0, 4000),
        new Date().toISOString(),
      )
      .run()
  } catch {
    // 0048 미적용 DB에서도 게이트웨이 동작 유지 — 감사 로그만 유실
  }
}
