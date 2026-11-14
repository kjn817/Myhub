/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F-L9 chat.js 내부 중복 추출 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - createMsgGroup 공유: 연속 메시지가 같은 그룹으로 묶이고(버블 2개),
 *   발신자가 바뀌면 새 그룹이 된다. loadMore(prependMsg) 경로도 같은
 *   그룹 구조(아바타+발신자명+버블)로 앞에 붙는다.
 * - postAiChat 공유: 전송하면 /api/ai/chat에 personaId·conversationId·
 *   최근 20개 메시지를 보내고, 답변 본문이 렌더된다.
 * - 구조: createMsgGroup·postAiChat 정의 각 1개, 호출처 각 2곳.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const doc: any = (globalThis as any).document
const win: any = (globalThis as any).window
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf-8')
const TEXT_UTILS_JS = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'common', 'text-utils.js'),
  'utf-8',
)
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf-8')

const PERSONAS = [{ id: 'concierge', name: '루미', avatar: '/avatars/lumi-128.webp' }]

async function flush(times = 15) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

function loadChat(requests: any[], roomHistory: any, chatReply: any) {
  const bodyHtml = CHAT_HTML.split('<body>')[1].split('</body>')[0]
  doc.body.innerHTML = bodyHtml
  const fetchStub = async (url: any, opts?: any) => {
    const u = String(url)
    requests.push({ url: u, body: opts?.body })
    if (u.startsWith('/api/ai/personas')) {
      return { ok: true, json: async () => PERSONAS }
    }
    if (u.startsWith('/api/ai/conversations')) {
      return {
        ok: true,
        json: async () => ({ ok: true, conversations: [], hasMore: false }),
      }
    }
    if (u.startsWith('/api/ai/room-history')) {
      return { ok: true, json: async () => roomHistory(u) }
    }
    if (u.startsWith('/api/ai/chat')) {
      return { ok: true, status: 200, json: async () => chatReply }
    }
    if (u.startsWith('/api/ai/feedback/')) {
      return { ok: true, json: async () => ({ ok: true, feedback: null }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  win.eval(TEXT_UTILS_JS)
  const loader = new Function(
    'window',
    'document',
    'fetch',
    'marked',
    'DOMPurify',
    'hljs',
    'confirm',
    CHAT_JS,
  )
  loader(
    win,
    doc,
    fetchStub,
    { setOptions: () => {}, parse: (t: string) => t },
    { sanitize: (t: string) => t },
    { highlightElement: () => {} },
    () => true,
  )
}

describe('F-L9 createMsgGroup 공유 (addMsg·prependMsg)', () => {
  let requests: any[]

  beforeEach(async () => {
    requests = []
    loadChat(
      requests,
      (u: string) => {
        if (u.includes('before=')) {
          return {
            ok: true,
            messages: [
              {
                id: 0,
                role: 'assistant',
                content: '예전 답변',
                persona_id: 'concierge',
                model: 'm',
              },
            ],
            hasMore: false,
          }
        }
        return {
          ok: true,
          messages: [
            {
              id: 1,
              role: 'assistant',
              content: '첫 답변',
              persona_id: 'concierge',
              model: 'm',
            },
            {
              id: 2,
              role: 'assistant',
              content: '둘째 답변',
              persona_id: 'concierge',
              model: 'm',
            },
            { id: 3, role: 'user', content: '내 질문', persona_id: null, model: '' },
          ],
          hasMore: true,
        }
      },
      { ok: true, text: '응답', model: 'm', messageId: 99 },
    )
    await flush()
  })

  test('연속 같은 발신자는 한 그룹·버블 2개, 발신자 변경 시 새 그룹', () => {
    const groups = doc.querySelectorAll('#msgs .msg-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].querySelectorAll('.bubble')).toHaveLength(2)
    expect(groups[0].querySelector('.sender')?.textContent).toBe('루미')
    expect(groups[0].querySelector('.avatar')).not.toBeNull()
    expect(groups[1].classList.contains('mine')).toBe(true)
    expect(groups[1].querySelectorAll('.bubble')).toHaveLength(1)
    expect(groups[1].querySelector('.bubble')?.textContent).toContain('내 질문')
  })

  test('loadMore(prependMsg)도 같은 그룹 구조로 앞에 붙는다', async () => {
    const wrap = doc.getElementById('msgs')
    wrap.scrollTop = 0
    wrap.dispatchEvent(new win.Event('scroll'))
    await flush()
    const groups = doc.querySelectorAll('#msgs .msg-group')
    expect(groups).toHaveLength(3)
    const first = groups[0]
    expect(first.querySelector('.sender')?.textContent).toBe('루미')
    expect(first.querySelector('.bubble')?.textContent).toContain('예전 답변')
    expect(
      requests.some((r: any) => r.url.includes('/api/ai/room-history?limit=30&before=1')),
    ).toBe(true)
  })
})

describe('F-L9 postAiChat 공유 (전송)', () => {
  let requests: any[]

  beforeEach(async () => {
    requests = []
    loadChat(
      requests,
      () => ({ ok: true, messages: [], hasMore: false }),
      { ok: true, text: '안녕하세요', model: 'gemini-3.5-flash-lite', messageId: 99 },
    )
    await flush()
  })

  test('전송하면 /api/ai/chat에 personaId·최근 메시지를 보내고 답변이 렌더된다', async () => {
    const input = doc.getElementById('input')
    input.value = '안녕'
    doc.getElementById('send').click()
    await flush(20)
    const chatReq = requests.filter((r: any) => r.url === '/api/ai/chat')
    expect(chatReq).toHaveLength(1)
    const body = JSON.parse(chatReq[0].body)
    expect(body.personaId).toBe('concierge')
    expect(body.conversationId).toBeNull()
    expect(body.messages).toEqual([{ role: 'user', content: '안녕' }])
    const bubbles = doc.querySelectorAll('#msgs .msg-group .bubble')
    expect(bubbles[bubbles.length - 1]?.textContent).toContain('안녕하세요')
  })
})

describe('F-L9 구조', () => {
  test('createMsgGroup·postAiChat 정의 각 1개·호출처 각 2곳', () => {
    expect(CHAT_JS.match(/function createMsgGroup\(isMine, personaId, persona\)/g))
      .toHaveLength(1)
    expect(CHAT_JS.match(/createMsgGroup\(isMine, personaId, persona\)/g)).toHaveLength(
      3,
    ) // 정의 1 + 호출 2
    expect(CHAT_JS.match(/async function postAiChat\(personaId, reqState\)/g)).toHaveLength(
      1,
    )
    expect(CHAT_JS.match(/await postAiChat\(personaId, reqState\)/g)).toHaveLength(2)
  })
})
