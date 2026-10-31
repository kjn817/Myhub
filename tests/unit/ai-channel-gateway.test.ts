/// <reference types="jest" />
/**
 * 채널 게이트웨이 테스트 (OpenClaw 패턴 이식 — 트랙 5)
 * - 채널 플러그인 레지스트리 (등록/조회/교체)
 * - 범용 웹훅 채널 정규화 (외부 서비스 의존 없음)
 * - 공유 시크릿 인증 (미설정 시 fail-closed 503)
 * - 라우트 E2E (Hono app.request) — 인바운드 → 비서 핸들러 → 응답
 */

import {
  registerChannel,
  getChannel,
  listChannels,
  unregisterChannel,
  setAssistantHandler,
  getAssistantHandler,
  handleChannelMessage,
  verifyWebhookSecret,
  secretsEqual,
  webhookChannel,
  type ChannelPlugin,
} from '../../src/services/channel-gateway';
import { channelApp } from '../../src/modules/channel/routes';

const SECRET = 'test-webhook-secret';

function makeMockDb(): any {
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue({ results: [] }),
        run: jest.fn().mockResolvedValue({}),
      }),
    }),
  };
}

describe('채널 플러그인 레지스트리', () => {
  test('웹훅 채널이 기본 등록됨', () => {
    expect(getChannel('webhook')).toBe(webhookChannel);
    expect(listChannels().map((c) => c.id)).toContain('webhook');
    expect(webhookChannel.supportsOutbound).toBe(false); // 인바운드 전용
  });

  test('중복 등록은 거부, replace로 교체 가능 후 원복', () => {
    const dup: ChannelPlugin = {
      id: 'webhook',
      displayName: '중복',
      supportsOutbound: false,
      normalizeInbound: () => null,
    };
    expect(() => registerChannel(dup)).toThrow(/already registered/);
    registerChannel(dup, { replace: true });
    expect(getChannel('webhook')).toBe(dup);
    registerChannel(webhookChannel, { replace: true });
    expect(getChannel('webhook')).toBe(webhookChannel);
  });

  test('미등록 채널 해제(unregister)는 false, 재등록 가능', () => {
    expect(unregisterChannel('no-such-channel')).toBe(false);
    expect(unregisterChannel('webhook')).toBe(true);
    expect(getChannel('webhook')).toBeUndefined();
    registerChannel(webhookChannel);
    expect(getChannel('webhook')).toBe(webhookChannel);
  });
});

describe('웹훅 채널 정규화', () => {
  test('정상 페이로드 → ChannelMessage', () => {
    const m = webhookChannel.normalizeInbound({ text: '안녕', senderId: 'u1', personaId: 'keeper' });
    expect(m).toMatchObject({ channel: 'webhook', channelId: 'u1', senderId: 'u1', text: '안녕', personaId: 'keeper' });
  });

  test('senderId/personaId 생략 시 기본값 (webhook / 미지정)', () => {
    const m = webhookChannel.normalizeInbound({ text: 'hi' });
    expect(m).toMatchObject({ senderId: 'webhook', personaId: undefined });
  });

  test('무효 페이로드 → null (빈 텍스트·텍스트 없음·비객체)', () => {
    expect(webhookChannel.normalizeInbound({})).toBeNull();
    expect(webhookChannel.normalizeInbound({ text: '   ' })).toBeNull();
    expect(webhookChannel.normalizeInbound({ text: 123 })).toBeNull();
    expect(webhookChannel.normalizeInbound(null)).toBeNull();
    expect(webhookChannel.normalizeInbound('hi')).toBeNull();
  });

  test('알 수 없는 personaId는 버림 (concierge 기본값은 핸들러에서 적용)', () => {
    const m = webhookChannel.normalizeInbound({ text: 'hi', personaId: 'ghost' });
    expect(m?.personaId).toBeUndefined();
  });

  test('8000자 초과 텍스트는 절단', () => {
    const m = webhookChannel.normalizeInbound({ text: 'x'.repeat(9000) });
    expect(m?.text.length).toBe(8000);
  });
});

describe('공유 시크릿 인증', () => {
  test('secretsEqual: 일치/불일치/길이 다름', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });

  test('시크릿 미설정 → disabled (fail-closed)', () => {
    expect(verifyWebhookSecret({}, 'Bearer x')).toBe('disabled');
    expect(verifyWebhookSecret({ CHANNEL_WEBHOOK_SECRET: '' }, 'Bearer x')).toBe('disabled');
  });

  test('Bearer 일치 → ok, 불일치 → unauthorized, 없음 → unauthorized', () => {
    const env = { CHANNEL_WEBHOOK_SECRET: SECRET };
    expect(verifyWebhookSecret(env, `Bearer ${SECRET}`)).toBe('ok');
    expect(verifyWebhookSecret(env, 'Bearer wrong')).toBe('unauthorized');
    expect(verifyWebhookSecret(env, null)).toBe('unauthorized');
  });

  test('본문 secret 필드도 인정', () => {
    const env = { CHANNEL_WEBHOOK_SECRET: SECRET };
    expect(verifyWebhookSecret(env, null, SECRET)).toBe('ok');
    expect(verifyWebhookSecret(env, null, 'wrong')).toBe('unauthorized');
  });
});

describe('handleChannelMessage (게이트웨이 디스패치)', () => {
  const fakeHandler = jest.fn(async (_env: any, personaId: string, messages: any[]) => ({
    text: `[${personaId}] ${messages[0].content}에 대한 답`,
  }));
  let prevHandler: any;

  beforeEach(() => {
    prevHandler = getAssistantHandler();
    fakeHandler.mockClear();
    setAssistantHandler(fakeHandler);
  });

  afterEach(() => {
    setAssistantHandler(prevHandler);
  });

  test('웹훅 메시지 → 핸들러 호출 → 응답 텍스트 반환', async () => {
    const { message, replyText } = await handleChannelMessage(
      {}, 'webhook', { text: '안녕', senderId: 'u1', personaId: 'keeper' },
    );
    expect(message.channel).toBe('webhook');
    expect(fakeHandler).toHaveBeenCalledTimes(1);
    expect(fakeHandler.mock.calls[0][1]).toBe('keeper');
    expect(fakeHandler.mock.calls[0][2]).toEqual([{ role: 'user', content: '안녕' }]);
    expect(replyText).toBe('[keeper] 안녕에 대한 답');
  });

  test('personaId 없으면 concierge 기본값', async () => {
    await handleChannelMessage({}, 'webhook', { text: 'hi' });
    expect(fakeHandler.mock.calls[0][1]).toBe('concierge');
  });

  test('미등록 채널 → throw', async () => {
    await expect(handleChannelMessage({}, 'telegram', { text: 'hi' }))
      .rejects.toThrow('unknown channel: telegram');
    expect(fakeHandler).not.toHaveBeenCalled();
  });

  test('무효 페이로드 → throw (핸들러 미호출)', async () => {
    await expect(handleChannelMessage({}, 'webhook', {}))
      .rejects.toThrow('invalid channel payload');
    expect(fakeHandler).not.toHaveBeenCalled();
  });

  test('핸들러 미연결 → throw (fail-closed)', async () => {
    setAssistantHandler(null);
    await expect(handleChannelMessage({}, 'webhook', { text: 'hi' }))
      .rejects.toThrow('assistant handler not configured');
  });
});

describe('채널 라우트 (Hono app.request)', () => {
  const fakeHandler = jest.fn(async () => ({ text: '라우트 응답' }));
  let prevHandler: any;

  beforeEach(() => {
    prevHandler = getAssistantHandler();
    fakeHandler.mockClear();
    setAssistantHandler(fakeHandler);
  });

  afterEach(() => {
    setAssistantHandler(prevHandler);
  });

  const envOf = (withSecret = true): any => ({
    DB: makeMockDb(),
    ...(withSecret ? { CHANNEL_WEBHOOK_SECRET: SECRET } : {}),
  });

  test('GET /channels → 등록 채널 목록', async () => {
    const res = await channelApp.request('/channels', {}, envOf());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.channels.map((c: any) => c.id)).toContain('webhook');
  });

  test('POST /webhook/webhook + Bearer 시크릿 → 200 + reply + 감사 로그 시도', async () => {
    const db = makeMockDb();
    const env: any = { DB: db, CHANNEL_WEBHOOK_SECRET: SECRET };
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ text: '안녕', senderId: 'u1' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, channel: 'webhook', senderId: 'u1', reply: '라우트 응답' });
    expect(fakeHandler).toHaveBeenCalledTimes(1);
    // 감사 로그: inbound + outbound 2건 INSERT 시도 (0048 미적용 DB에서도 에러 없이 동작)
    const prepares = (db.prepare as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(prepares.filter((q) => q.includes('INSERT INTO channel_messages'))).toHaveLength(2);
  });

  test('본문 secret 필드로도 인증됨', async () => {
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', secret: SECRET }),
    }, envOf());
    expect(res.status).toBe(200);
  });

  test('잘못된 시크릿 → 401 (핸들러 미호출)', async () => {
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ text: 'hi' }),
    }, envOf());
    expect(res.status).toBe(401);
    expect(fakeHandler).not.toHaveBeenCalled();
  });

  test('시크릿 미설정 → 503 webhook_disabled (원인·등록 절차 안내 포함)', async () => {
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ text: 'hi' }),
    }, envOf(false));
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error).toBe('webhook_disabled');
    expect(body.message).toContain('CHANNEL_WEBHOOK_SECRET 미설정');
    expect(body.message).toContain('docs/channel-webhook.md');
    expect(fakeHandler).not.toHaveBeenCalled();
  });

  test('미등록 채널 → 404', async () => {
    const res = await channelApp.request('/webhook/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ text: 'hi' }),
    }, envOf());
    expect(res.status).toBe(404);
  });

  test('빈 본문 → 400 invalid_payload', async () => {
    const res = await channelApp.request('/webhook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({}),
    }, envOf());
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_payload');
  });

  test('GET /webhook/:channelId → 405', async () => {
    const res = await channelApp.request('/webhook/webhook', {}, envOf());
    expect(res.status).toBe(405);
  });
});
