// 채널 게이트웨이 모듈: 메시지 채널(웹훅 등) 인바운드 진입점
// POST /api/channel/webhook/:channelId — 외부 채널 메시지 수신 → 비서 응답 반환
// GET  /api/channel/channels — 등록된 채널 목록
//
// 인증: 웹훅 경로는 세션 쿠키가 아니라 CHANNEL_WEBHOOK_SECRET 공유 시크릿으로
// 인증한다 (src/index.ts 미들웨어에서 /api/channel/webhook/ 경로를 면제).
// 시크릿 미설정 시 503으로 채널 비활성화 (fail-closed).
// AI 호출은 게이트웨이의 핸들러 포트 경유 (src/modules.ts에서 연결).
import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  listChannels,
  getChannel,
  handleChannelMessage,
  verifyWebhookSecret,
  logChannelMessage,
} from '../../services/channel-gateway'

export const channelApp = new Hono<{ Bindings: Env }>()

channelApp.get('/channels', (c) => {
  return c.json({
    ok: true,
    channels: listChannels().map((ch) => ({
      id: ch.id,
      displayName: ch.displayName,
      supportsOutbound: ch.supportsOutbound,
    })),
  })
})

channelApp.post('/webhook/:channelId', async (c) => {
  const payload = await c.req.json().catch(() => null)
  const auth = verifyWebhookSecret(
    c.env,
    c.req.header('Authorization'),
    (payload as any)?.secret ?? null,
  )
  if (auth === 'disabled') {
    return c.json(
      {
        ok: false,
        error: 'webhook_disabled',
        message: 'CHANNEL_WEBHOOK_SECRET 미설정 — 웹훅 채널 비활성화. Cloudflare 대시보드 → Workers → myhub → 설정 → 변수 및 시크릿에 CHANNEL_WEBHOOK_SECRET을 등록하고 재배포하세요 (자세한 절차: docs/channel-webhook.md)',
      },
      503,
    )
  }
  if (auth === 'unauthorized') {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  const channelId = c.req.param('channelId')
  if (!getChannel(channelId)) {
    return c.json({ ok: false, error: 'unknown_channel' }, 404)
  }
  try {
    const { message, replyText } = await handleChannelMessage(c.env, channelId, payload)
    // 감사 로그 (best-effort — 0048 미적용 DB에서도 동작 유지)
    await logChannelMessage(c.env.DB, {
      channel: channelId,
      senderId: message.senderId,
      personaId: message.personaId,
      direction: 'inbound',
      text: message.text,
    })
    await logChannelMessage(c.env.DB, {
      channel: channelId,
      senderId: message.senderId,
      personaId: message.personaId,
      direction: 'outbound',
      text: replyText,
    })
    return c.json({ ok: true, channel: channelId, senderId: message.senderId, reply: replyText })
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (msg.startsWith('invalid channel payload')) {
      return c.json({ ok: false, error: 'invalid_payload' }, 400)
    }
    if (msg.startsWith('assistant handler')) {
      return c.json({ ok: false, error: 'assistant_unavailable' }, 503)
    }
    return c.json({ ok: false, error: 'channel_error', message: msg.slice(0, 200) }, 500)
  }
})

channelApp.get('/webhook/:channelId', (c) =>
  c.json({ ok: false, error: 'method_not_allowed' }, 405),
)
