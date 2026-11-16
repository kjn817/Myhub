/// <reference types="jest" />
/**
 * src/modules/browse/cdp.ts — CDP 내비게이션 상태기계 성질 테스트 (C3).
 *
 * 고정하는 성질:
 * - URL 변환: wss→https, ws→http, 그 외는 그대로.
 * - 연결 실패(예외·null)는 stage='connect'로 구분되고, 소켓이 열리면
 *   getTargets → attach → navigate 순서로 메시지가 나가며 sessionId가
 *   navigate에만 실린다.
 * - 단계별 실패는 실패한 단계 이름으로 돌아온다 (targets/attach 폴백은
 *   세션 없는 직접 navigate로 이어지고, 그 실패는 원래 단계로 보고된다).
 * - 응답이 없으면 timeoutMs 안에 현재 단계로 종료하고 소켓은 닫힌다.
 * - 키오스크 모드(2026-11-14): 이동 시 영구 탭 외의 페이지 타깃(팝업 창)을
 *   닫아 MyHub 주소창을 탈출구로 만든다. 영구 탭은 닫지 않는다.
 * - DSF 고정 (2026-11-16 QA 7차): 뷰포트 override의 DSF는 항상 1.0
 *   (REMOTE_DISPLAY_SCALE) — 사이드카가 scaling_dpi를 96으로 고정해
 *   출력 scale이 항상 1.0이다. 실측에서 DSF를 역산하는 옛 방식은
 *   리사이즈 중 옛 디스플레이 크기 ÷ 새 스테이지로 1.5 같은 잘못된
 *   배율을 만들고, 그 배율이 후보가 돼 자기 일치를 이뤄 고정이 안
 *   됐다 (창은 안 줄고 내용만 1.5배로 커져 넘침).
 * - 전 탭 뷰포트 적용 (2026-11-15 밤): applyViewportToSession은 모든
 *   페이지 타깃에 같은 override를 걸고, 한 타깃이 실패해도 나머지는
 *   계속 적용하며 applied/total로 보고한다 (첫 타깃만 걸던 기존 코드는
 *   세션 복원된 탭에 안 닿아 탭마다 크기가 달랐다).
 * - getBrowserState/goBackSession/goForwardSession (2026-11-15 밤):
 *   원격의 실제 URL·제목·뒤로/앞으로 가능 여부를 읽고, 뒤로/앞으로를
 *   원격 기록에 지시한다. 실패 시 상태는 null, 이동은 단계 보고.
 *   (2026-11-16 QA 2차: Page.goBack/goForward는 Chromium 156에 없어
 *   'wasn't found' 에러만 돌려줬다 — 이동은 getNavigationHistory로
 *   엔트리 id를 읽어 Page.navigateToHistoryEntry로 한다. 갈 곳이
 *   없으면 stage='no-history'로 구분한다.)
 * - 활성 탭 선택 (2026-11-16 QA 1차): 상태·뒤로/앞으로는 첫 타깃이
 *   아니라 document.visibilityState가 'visible'인 탭을 본다. 첫
 *   타깃은 동결된 백그라운드 탭일 수 있어 evaluate가 타임아웃돼
 *   /state가 매번 502가 됐다. visible이 없으면 첫 타깃으로 폴백하고,
 *   응답 없는 탭의 평가는 타깃당 제한(1.5초) 뒤에 건너뛴다.
 * - 활성 탭 이동 (2026-11-16 QA 4차): navigateSession도 첫 타깃이
 *   아니라 visible 탭을 이동시킨다. 첫 타깃 이동은 숨은 DuckDuckGo
 *   탭을 이동시키고 보던 naver.com 탭을 닫아버려 뒤로가기가
 *   naver.com이 아니라 DuckDuckGo로 갔다. 이동시킨 탭 외의 페이지
 *   타깃은 닫는다 (원격 단일 탭 설계 유지).
 * - 적용 후 검증 (2026-11-16 QA 1차): applyViewportToSession은
 *   override 적용 후 실측(innerWidth·innerHeight·devicePixelRatio)을
 *   의도와 비교하고, 안 맞으면 1회 재시도한다. 재시도 후에도 안
 *   맞으면 ok=false + verified로 보고한다. 읽기 실패는 미검증으로
 *   두고 적용 실패로 보지 않는다.
 * - 읽기 우선·건드리지 않기 (2026-11-16 QA 2차): 전 탭이 이미 의도와
 *   일치하면 set도 clear도 하지 않고 끝낸다 (주기 재적용이 올바른
 *   탭을 깜빡이게 하면 안 된다). 불일치 탭이 있을 때만 불일치 탭에
 *   의도 뷰포트를 적용한다 (set이 기존 override를 대체하므로 clear
 *   불필요, 디스플레이 재측정 없음 — QA 7차).
 * - 리사이즈 경합 회귀 (2026-11-16 QA 7차): 낡은 1.5 override가 남은
 *   탭은 의도(DSF 1.0)와 불일치로 판정돼 DSF 1.0으로 다시 걸린다.
 *   옛 후보-DSF 방식은 낡은 배율을 후보로 삼아 자기 일치를 이뤄
 *   고정을 안 했다.
 * 카나리아: 단계 보고(stage)나 폴백 조건을 깨면 해당 테스트가 실패한다.
 */
import { applyViewportToSession, getBrowserState, goBackSession, goForwardSession, navigateSession, REMOTE_DISPLAY_SCALE, wsToHttpUrl, type CdpSocket } from '../../src/modules/browse/cdp'

type Listener = (ev: { data: unknown }) => void

class FakeSocket implements CdpSocket {
  sent: Array<Record<string, any>> = []
  closed = false
  throwOnSend = false
  throwOnClose = false
  private listeners: Listener[] = []
  constructor(private handler: (msg: Record<string, any>, emit: (m: unknown) => void, raw: (s: string) => void) => void) {}
  send(data: string): void {
    if (this.throwOnSend) throw new Error('send boom')
    const msg = JSON.parse(data) as Record<string, any>
    this.sent.push(msg)
    this.handler(msg, (m) => this.emit(m), (s) => this.emitRaw(s))
  }
  private emit(m: unknown): void {
    this.emitRaw(JSON.stringify(m))
  }
  private emitRaw(s: string): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l({ data: s })
    })
  }
  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.push(listener)
  }
  close(): void {
    if (this.throwOnClose) throw new Error('close boom')
    this.closed = true
  }
}

const WS_URL = 'wss://browser.example/devtools/browser/abc'
const TARGET = 'https://example.com/page'

function happyHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
  if (msg.method === 'Target.getTargets') {
    emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }, { type: 'browser' }] } })
  } else if (msg.method === 'Target.attachToTarget') {
    emit({ id: msg.id, result: { sessionId: 'sess-1' } })
  } else if (msg.method === 'Runtime.evaluate') {
    // 활성 탭 식별용 visibility 평가 — 단일 탭은 visible이다.
    emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
  } else if (msg.method === 'Page.navigate') {
    emit({ id: msg.id, result: {} })
  }
}

describe('wsToHttpUrl', () => {
  test('wss는 https로, ws는 http로 바뀌고 나머지는 그대로다', () => {
    expect(wsToHttpUrl('wss://h.example/x?y=1')).toBe('https://h.example/x?y=1')
    expect(wsToHttpUrl('ws://h.example/x')).toBe('http://h.example/x')
    expect(wsToHttpUrl('https://h.example/x')).toBe('https://h.example/x')
    expect(wsToHttpUrl('wss://h.example')).not.toContain('wss:')
  })
})

describe('navigateSession — 정상 경로', () => {
  test('getTargets→attach→visibility→navigate 순서, sessionId는 navigate에만 실리고 소켓이 닫힌다', async () => {
    const sock = new FakeSocket(happyHandler)
    let gotHeaders: Record<string, string> | undefined
    const connect = async (_url: string, headers?: Record<string, string>) => {
      gotHeaders = headers
      return sock as CdpSocket
    }
    const r = await navigateSession(WS_URL, TARGET, connect, { headers: { Authorization: 'Bearer t' } })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(gotHeaders).toEqual({ Authorization: 'Bearer t' })
    // attach 뒤에 활성 탭 식별용 visibility 평가가 나간다 (2026-11-16 QA 4차).
    expect(sock.sent.map((m) => m.method)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
      'Page.navigate',
    ])
    expect(sock.sent[1].params).toEqual({ targetId: 'page-1', flatten: true })
    expect(sock.sent[2].params.expression).toContain('visibilityState')
    expect(sock.sent[2].sessionId).toBe('sess-1')
    expect(sock.sent[3].params).toEqual({ url: TARGET })
    expect(sock.sent[3].sessionId).toBe('sess-1')
    expect(sock.sent[0].sessionId).toBeUndefined()
    expect(sock.closed).toBe(true)
  })

  test('page 타입이 없으면 첫 타깃으로 attach한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'service_worker', targetId: 'sw-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 's' } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r.ok).toBe(true)
    expect(sock.sent[1].params.targetId).toBe('sw-1')
  })

  test('깨진 JSON 메시지는 무시하고 이후 정상 응답으로 완료한다', async () => {
    const sock = new FakeSocket((msg, emit, raw) => {
      if (msg.method === 'Target.getTargets') {
        raw('{{{not json')
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 's' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
  })

  test('close가 던져도 결과는 정상으로 돌아온다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.throwOnClose = true
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
  })
})

describe('navigateSession — 키오스크 팝업 정리 (2026-11-14)', () => {
  test('영구 탭 외의 페이지 타깃은 이동 전에 닫고, 영구 탭은 닫지 않는다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [
          { type: 'page', targetId: 'page-1' },
          { type: 'page', targetId: 'popup-1' },
          { type: 'page', targetId: 'popup-2' },
          { type: 'service_worker', targetId: 'sw-1' },
        ] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: `sess-${msg.params.targetId}` } })
      } else if (msg.method === 'Runtime.evaluate') {
        // 영구 탭만 visible, 팝업은 hidden이다.
        const vis = String(msg.sessionId ?? '').endsWith('page-1') ? 'visible' : 'hidden'
        emit({ id: msg.id, result: { result: { type: 'string', value: vis } } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
      // closeTarget 응답은 없어도 된다 (발사 후 망각)
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const closes = sock.sent.filter((m) => m.method === 'Target.closeTarget')
    expect(closes.map((m) => m.params.targetId).sort()).toEqual(['popup-1', 'popup-2'])
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')
    expect(nav?.sessionId).toBe('sess-page-1')
    // 닫기는 스캔(attach) 뒤에 나가지만 navigate보다는 먼저 나간다.
    const closeIdx = sock.sent.findIndex((m) => m.method === 'Target.closeTarget')
    const navIdx = sock.sent.findIndex((m) => m.method === 'Page.navigate')
    expect(closeIdx).toBeGreaterThan(-1)
    expect(closeIdx).toBeLessThan(navIdx)
  })

  test('페이지 타깃이 하나면 closeTarget을 보내지 않는다', async () => {
    const sock = new FakeSocket(happyHandler)
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(sock.sent.some((m) => m.method === 'Target.closeTarget')).toBe(false)
  })
})

describe('navigateSession — 활성 탭 이동 (2026-11-16 QA 4차)', () => {
  // 첫 타깃을 이동시키던 기존 코드는 숨은 DuckDuckGo 탭을 이동시키고
  // 보던 naver.com 탭을 닫아버려 뒤로가기가 naver.com이 아니라
  // DuckDuckGo로 갔다. 이동 대상은 visible 탭이어야 한다.
  function makeNavigateHandler(pages: Array<{ targetId: string; visibility: 'visible' | 'hidden' | 'error' }>): (msg: Record<string, any>, emit: (m: unknown) => void) => void {
    const bySession: Record<string, 'visible' | 'hidden' | 'error'> = {}
    for (const p of pages) bySession[`sess-${p.targetId}`] = p.visibility
    return (msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: pages.map((p) => ({ type: 'page', targetId: p.targetId })) } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: `sess-${msg.params.targetId}` } })
      } else if (msg.method === 'Runtime.evaluate') {
        const vis = bySession[String(msg.sessionId ?? '')]
        if (vis === 'error') {
          emit({ id: msg.id, error: { message: 'eval denied' } })
        } else {
          emit({ id: msg.id, result: { result: { type: 'string', value: vis ?? 'hidden' } } })
        }
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
      // closeTarget 응답은 없어도 된다 (발사 후 망각)
    }
  }

  test('첫 탭이 hidden이고 두 번째가 visible이면 두 번째 탭을 이동시키고 첫 탭을 닫는다', async () => {
    const sock = new FakeSocket(makeNavigateHandler([
      { targetId: 'page-1', visibility: 'hidden' },
      { targetId: 'page-2', visibility: 'visible' },
    ]))
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')
    expect(nav?.sessionId).toBe('sess-page-2')
    expect(nav?.params).toEqual({ url: TARGET })
    const closes = sock.sent.filter((m) => m.method === 'Target.closeTarget')
    expect(closes.map((m) => m.params.targetId)).toEqual(['page-1'])
    const closeIdx = sock.sent.findIndex((m) => m.method === 'Target.closeTarget')
    const navIdx = sock.sent.findIndex((m) => m.method === 'Page.navigate')
    expect(closeIdx).toBeLessThan(navIdx)
  })

  test('전부 hidden이면 첫 탭으로 폴백해 이동시키고 나머지를 닫는다', async () => {
    const sock = new FakeSocket(makeNavigateHandler([
      { targetId: 'page-1', visibility: 'hidden' },
      { targetId: 'page-2', visibility: 'hidden' },
    ]))
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')
    expect(nav?.sessionId).toBe('sess-page-1')
    const closes = sock.sent.filter((m) => m.method === 'Target.closeTarget')
    expect(closes.map((m) => m.params.targetId)).toEqual(['page-2'])
  })

  test('탭이 하나면 그 탭을 이동시키고 닫기를 보내지 않는다', async () => {
    const sock = new FakeSocket(makeNavigateHandler([
      { targetId: 'page-1', visibility: 'visible' },
    ]))
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')
    expect(nav?.sessionId).toBe('sess-page-1')
    expect(sock.sent.some((m) => m.method === 'Target.closeTarget')).toBe(false)
  })

  test('첫 탭의 visibility 평가가 실패해도 visible인 두 번째 탭을 이동시킨다', async () => {
    const sock = new FakeSocket(makeNavigateHandler([
      { targetId: 'page-1', visibility: 'error' },
      { targetId: 'page-2', visibility: 'visible' },
    ]))
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')
    expect(nav?.sessionId).toBe('sess-page-2')
    const closes = sock.sent.filter((m) => m.method === 'Target.closeTarget')
    expect(closes.map((m) => m.params.targetId)).toEqual(['page-1'])
  })
})

describe('navigateSession — 뷰포트 (2026-11-12 원격 화면 짤림 수정)', () => {
  function viewportHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
    if (msg.method === 'Target.getTargets') {
      emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
    } else if (msg.method === 'Target.attachToTarget') {
      emit({ id: msg.id, result: { sessionId: 'sess-1' } })
    } else if (msg.method === 'Runtime.evaluate') {
      // 활성 탭 식별용 visibility 평가만 온다 (DSF 측정은 QA 7차에 폐지).
      emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
    } else if (msg.method === 'Emulation.setDeviceMetricsOverride') {
      emit({ id: msg.id, result: {} })
    } else if (msg.method === 'Page.navigate') {
      emit({ id: msg.id, result: {} })
    }
  }

  test('viewport가 주어지면 attach 후 DSF 1.0으로 뷰포트를 맞추고 이동한다 (측정·clear 없음)', async () => {
    const sock = new FakeSocket(viewportHandler)
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, {
      viewport: { width: 1680, height: 967 },
    })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const methods = sock.sent.map((m) => m.method)
    // attach 뒤에 활성 탭 식별용 visibility 평가가 먼저 나간다 (2026-11-16 QA 4차).
    // DSF 측정(screen.width 평가)·clear는 QA 7차에 폐지 — 리사이즈 중
    // 옛 디스플레이 크기를 읽어 잘못된 배율을 만들었다.
    expect(methods).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
      'Emulation.setDeviceMetricsOverride',
      'Page.navigate',
    ])
    const vp = sock.sent.find((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    // DSF는 REMOTE_DISPLAY_SCALE(1.0) 고정 — 사이드카 DPI 고정으로
    // 출력 scale이 항상 1.0이다.
    expect(vp.params).toEqual({ width: 1680, height: 967, deviceScaleFactor: REMOTE_DISPLAY_SCALE, mobile: false })
    expect(REMOTE_DISPLAY_SCALE).toBe(1)
    expect(vp.sessionId).toBe('sess-1')
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals).toHaveLength(1)
    expect(evals[0].params.expression).toContain('visibilityState')
  })

  test('viewport가 없으면 뷰포트 명령 없이 바로 이동한다', async () => {
    const sock = new FakeSocket(happyHandler)
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    // Emulation 명령은 나가지 않는다 (visibility 평가는 활성 탭 식별용이라 나간다).
    expect(sock.sent.map((m) => m.method)).not.toContain('Emulation.setDeviceMetricsOverride')
    expect(sock.sent.map((m) => m.method)).not.toContain('Emulation.clearDeviceMetricsOverride')
    expect(sock.sent.map((m) => m.method)).toContain('Page.navigate')
  })

  test('뷰포트 설정이 실패해도 이동은 진행한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      } else if (msg.method === 'Emulation.setDeviceMetricsOverride') {
        emit({ id: msg.id, error: { message: 'nope' } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, {
      viewport: { width: 1440, height: 860 },
    })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(sock.sent.map((m) => m.method)).toContain('Page.navigate')
  })
})

describe('REMOTE_DISPLAY_SCALE — 원격 출력 배율 (2026-11-16 QA 7차)', () => {
  test('사이드카 DPI 고정으로 출력 scale이 1.0이므로 DSF는 항상 1', () => {
    expect(REMOTE_DISPLAY_SCALE).toBe(1)
  })
})

/**
 * 뷰포트 적용 시뮬레이션 핸들러 팩토리. 세션별 마지막 override를
 * 기억해 검증 evaluate에 그 값을 돌려준다 (제대로 적용된 탭은 실측이
 * 의도와 일치한다). verify 동작을 바꿔 불일치·읽기 실패를 흉내낸다.
 * - 'match': 실측이 마지막 override와 일치한다 (정상 적용).
 * - 'mismatch-then-match': 첫 실측은 자연 상태(2940×1692@dpr1)처럼
 *   의도와 다르고, 재시도(2번째 set) 이후에는 일치한다.
 * - 'always-mismatch': 실측이 계속 자연 상태다 (재시도해도 안 맞음).
 * - 'read-error': 검증 읽기가 오류를 돌려준다 (확인 불가).
 * verifyBySession으로 세션별 동작을 따로 정할 수 있다.
 * initialOverrides는 이미 override가 걸린 탭을 흉내낸다 (이전 적용분이
 * 남아 있는 탭 — set 전에도 그 값을 실측으로 돌려준다).
 * natural은 override가 없는 탭의 자연 실측이다 (없으면 {w: 0, h: 0, d: 1}).
 */
type VerifyBehavior = 'match' | 'mismatch-then-match' | 'always-mismatch' | 'read-error'

function makeViewportHandler(opts: {
  pages?: string[]
  verify?: VerifyBehavior
  verifyBySession?: Record<string, VerifyBehavior>
  attachFail?: string
  setFailSession?: string
  initialOverrides?: Record<string, { width: number; height: number; deviceScaleFactor: number }>
  natural?: { w: number; h: number; d: number }
} = {}): (msg: Record<string, any>, emit: (m: unknown) => void) => void {
  const pages = opts.pages ?? ['page-1']
  const verify = opts.verify ?? 'match'
  const overrides: Record<string, { width: number; height: number; deviceScaleFactor: number }> = {}
  const setCounts: Record<string, number> = {}
  return (msg, emit) => {
    if (msg.method === 'Target.getTargets') {
      emit({ id: msg.id, result: { targetInfos: [
        ...pages.map((t) => ({ type: 'page', targetId: t })),
        { type: 'service_worker', targetId: 'sw-1' },
      ] } })
    } else if (msg.method === 'Target.attachToTarget') {
      if (opts.attachFail && msg.params.targetId === opts.attachFail) {
        emit({ id: msg.id, error: { message: 'attach denied' } })
      } else {
        emit({ id: msg.id, result: { sessionId: `sess-${msg.params.targetId}` } })
      }
    } else if (msg.method === 'Emulation.clearDeviceMetricsOverride') {
      emit({ id: msg.id, result: {} })
    } else if (msg.method === 'Runtime.evaluate') {
      const expr = String(msg.params?.expression ?? '')
      // readAppliedViewport(innerWidth)만 온다 — screen.width 측정은
      // QA 7차에 폐지됐다.
      if (expr.includes('innerWidth')) {
        // 검증 읽기: 세션별 마지막 override와 비교해 답한다.
        const sid = String(msg.sessionId ?? '')
        const behavior = opts.verifyBySession?.[sid] ?? verify
        if (behavior === 'read-error') {
          emit({ id: msg.id, error: { message: 'eval denied' } })
          return
        }
        const n = setCounts[sid] ?? 0
        if (behavior === 'always-mismatch' || (behavior === 'mismatch-then-match' && n < 2)) {
          emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ w: 2940, h: 1692, d: 1 }) } } })
        } else {
          const ov = overrides[sid] ?? opts.initialOverrides?.[sid]
          const m = ov
            ? { w: ov.width, h: ov.height, d: ov.deviceScaleFactor }
            : (opts.natural ?? { w: 0, h: 0, d: 1 })
          emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify(m) } } })
        }
      } else {
        emit({ id: msg.id, error: { message: 'unexpected evaluate' } })
      }
    } else if (msg.method === 'Emulation.setDeviceMetricsOverride') {
      const sid = String(msg.sessionId ?? '')
      setCounts[sid] = (setCounts[sid] ?? 0) + 1
      overrides[sid] = msg.params
      if (opts.setFailSession && sid === opts.setFailSession) {
        emit({ id: msg.id, error: { message: 'nope' } })
      } else {
        emit({ id: msg.id, result: {} })
      }
    } else if (msg.method === 'Browser.getWindowForTarget') {
      emit({ id: msg.id, result: { windowId: 42, bounds: { width: 1470, height: 850, windowState: 'fullscreen' } } })
    } else if (msg.method === 'Browser.setWindowBounds') {
      emit({ id: msg.id, result: {} })
    }
  }
}

describe('applyViewportToSession — 이동 없는 뷰포트 적용 (2026-11-15 세션 복원 뒤 절반 크기 수정)', () => {
  test('getTargets→attach→1단계 읽기→뷰포트→검증 순서로 가고 이동은 보내지 않으며 소켓이 닫힌다', async () => {
    const sock = new FakeSocket(makeViewportHandler())
    const r = await applyViewportToSession(WS_URL, { width: 1470, height: 850 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 1, total: 1, verified: 1 })
    // 지우기·권위 측정은 QA 7차에 폐지 — set이 기존 override를
    // 대체하고 DSF는 1.0 고정이다. 3단계 렌더러 재동기화는 QA 8차
    // 복원 결함 수정 — 풀스크린→일반→풀스크린 토글로 렌더러가
    // 실제 창 크기를 다시 읽게 한다 (QA 9차: 풀스크린 재걸기만으론
    // no-op으로 무시돼 안 먹힘).
    expect(sock.sent.map((m) => m.method)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate', // 1단계 읽기 (현재 실측)
      'Emulation.setDeviceMetricsOverride',
      'Runtime.evaluate', // 검증 읽기
      'Browser.getWindowForTarget', // 3단계 렌더러 재동기화
      'Browser.setWindowBounds', // 풀스크린 해제 (일반 상태로)
      'Browser.setWindowBounds', // 풀스크린 복귀
    ])
    const vp = sock.sent.find((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    // DSF는 REMOTE_DISPLAY_SCALE(1.0) 고정 (QA 7차).
    expect(vp.params).toEqual({ width: 1470, height: 850, deviceScaleFactor: 1, mobile: false })
    expect(vp.sessionId).toBe('sess-page-1')
    // 첫 evaluate는 1단계 읽기, 마지막은 검증 읽기 (둘 다 innerWidth).
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals).toHaveLength(2)
    expect(evals[0].params.expression).toContain('innerWidth')
    expect(evals[1].params.expression).toContain('innerWidth')
    expect(sock.closed).toBe(true)
  })

  test('connect가 null을 돌려주거나 던지면 stage=connect', async () => {
    const r1 = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => null)
    expect(r1).toEqual({ ok: false, stage: 'connect', applied: 0, total: 0, verified: 0 })
    const r2 = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => {
      throw new Error('boom')
    })
    expect(r2).toEqual({ ok: false, stage: 'connect', applied: 0, total: 0, verified: 0 })
  })

  test('리스너 등록이 던지면 stage=connect이고 타이머가 남지 않는다', async () => {
    // navigateSession과 같은 고아 타이머 구멍 — executor throw 전에
    // 타이머가 만들어지면 5초간 워커를 붙잡는다 (2026-11-15).
    jest.useFakeTimers()
    try {
      const before = jest.getTimerCount()
      const sock = new FakeSocket(makeViewportHandler())
      sock.addEventListener = () => { throw new Error('no listeners') }
      const r = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => sock as CdpSocket)
      expect(r).toEqual({ ok: false, stage: 'connect', applied: 0, total: 0, verified: 0 })
      expect(jest.getTimerCount()).toBe(before)
    } finally {
      jest.useRealTimers()
    }
  })

  test('페이지 타깃이 없으면 stage=targets로 보고하고 attach를 보내지 않는다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'browser' }] } })
      }
    })
    const r = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'targets', applied: 0, total: 0, verified: 0 })
    expect(sock.sent.map((m) => m.method)).toEqual(['Target.getTargets'])
  })

  test('attach가 실패하면 stage=attach로 보고한다', async () => {
    const sock = new FakeSocket(makeViewportHandler({ attachFail: 'page-1' }))
    const r = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'attach', applied: 0, total: 1, verified: 0 })
  })

  test('뷰포트 명령이 실패하면 stage=viewport로 보고한다', async () => {
    const sock = new FakeSocket(makeViewportHandler({ setFailSession: 'sess-page-1' }))
    const r = await applyViewportToSession(WS_URL, { width: 100, height: 100 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'viewport', applied: 0, total: 1, verified: 0 })
  })
})

describe('applyViewportToSession — 전 탭 적용 (2026-11-15 밤, 탭마다 크기 달랐던 문제)', () => {
  test('페이지 타깃이 여러 개면 전부 같은 override를 받는다 (DSF 1.0 고정)', async () => {
    const sock = new FakeSocket(makeViewportHandler({ pages: ['page-1', 'page-2'] }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 2, total: 2, verified: 2 })
    const vps = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(vps).toHaveLength(2)
    // 두 타깃 모두 DSF 1.0 (QA 7차: 실측 역산 폐지).
    expect(vps.map((m) => m.sessionId).sort()).toEqual(['sess-page-1', 'sess-page-2'])
    for (const vp of vps) {
      expect(vp.params).toEqual({ width: 1680, height: 967, deviceScaleFactor: 1, mobile: false })
    }
    // service_worker 타깃에는 attach하지 않는다.
    expect(sock.sent.filter((m) => m.method === 'Target.attachToTarget')).toHaveLength(2)
    // 1단계 읽기 탭마다 한 번 + 검증 읽기 탭마다 한 번 (측정 평가 없음).
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals).toHaveLength(4)
    expect(evals.filter((m) => String(m.params.expression).includes('screen.width'))).toHaveLength(0)
    expect(evals.filter((m) => String(m.params.expression).includes('innerWidth'))).toHaveLength(4)
    expect(sock.sent.filter((m) => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(0)
  })

  test('한 타깃의 attach가 실패해도 나머지는 적용하고 applied로 보고한다', async () => {
    const sock = new FakeSocket(makeViewportHandler({ pages: ['page-1', 'page-2'], attachFail: 'page-1' }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'attach', applied: 1, total: 2, verified: 1 })
    const vps = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(vps).toHaveLength(1)
    expect(vps[0].sessionId).toBe('sess-page-2')
    // 첫 타깃 attach가 실패했어도 두 번째 타깃에 DSF 1.0으로 적용한다.
    expect(vps[0].params.deviceScaleFactor).toBe(1)
  })

  test('한 타깃의 뷰포트가 실패해도 나머지는 적용하고 applied로 보고한다', async () => {
    const sock = new FakeSocket(makeViewportHandler({ pages: ['page-1', 'page-2'], setFailSession: 'sess-page-1' }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'viewport', applied: 1, total: 2, verified: 1 })
  })
})

describe('applyViewportToSession — 적용 후 검증 (2026-11-16 QA 1차)', () => {
  test('첫 실측 불일치 → 재시도 → 일치하면 verified=1, ok=true (set 2회)', async () => {
    const sock = new FakeSocket(makeViewportHandler({ verify: 'mismatch-then-match' }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 1, total: 1, verified: 1 })
    // 첫 적용 + 재시도 1회 = set 2회, innerWidth 읽기 3회 (1단계 읽기·
    // 불일치 확인·재확인).
    const sets = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(sets).toHaveLength(2)
    expect(sets[0].params).toEqual(sets[1].params)
    const verifyEvals = sock.sent.filter(
      (m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('innerWidth'),
    )
    expect(verifyEvals).toHaveLength(3)
  })

  test('재시도 후에도 불일치면 ok=false + verified=0, stage=viewport', async () => {
    const sock = new FakeSocket(makeViewportHandler({ verify: 'always-mismatch' }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'viewport', applied: 1, total: 1, verified: 0 })
    // 재시도는 1회만 한다 (무한 재시도 금지).
    expect(sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(2)
  })

  test('두 탭 중 한 탭만 불일치면 ok=false, verified=1 (불일치 탭만 재시도)', async () => {
    const sock = new FakeSocket(
      makeViewportHandler({ pages: ['page-1', 'page-2'], verifyBySession: { 'sess-page-2': 'always-mismatch' } }),
    )
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'viewport', applied: 2, total: 2, verified: 1 })
    const sets = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    // page-1은 1회, page-2는 첫 적용 + 재시도 = 2회.
    expect(sets.filter((m) => m.sessionId === 'sess-page-1')).toHaveLength(1)
    expect(sets.filter((m) => m.sessionId === 'sess-page-2')).toHaveLength(2)
  })

  test('검증 읽기 실패는 미검증이지만 ok=true다 (읽기 실패 ≠ 적용 실패, 재시도 없음)', async () => {
    const sock = new FakeSocket(makeViewportHandler({ verify: 'read-error' }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 1, total: 1, verified: 0 })
    // 읽기를 못 한 것은 불일치가 아니므로 재시도하지 않는다.
    expect(sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1)
  })
})

describe('applyViewportToSession — 읽기 우선·건드리지 않기 (2026-11-16 QA 2차)', () => {
  test('전 탭이 이미 의도와 일치하면 set도 clear도 없이 ok + applied·verified=전체', async () => {
    // 두 탭 모두 이전 적용분이 남아 있다 (주기 재적용의 정상 경로).
    const sock = new FakeSocket(
      makeViewportHandler({
        pages: ['page-1', 'page-2'],
        initialOverrides: {
          'sess-page-1': { width: 1680, height: 967, deviceScaleFactor: 1 },
          'sess-page-2': { width: 1680, height: 967, deviceScaleFactor: 1 },
        },
      }),
    )
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 2, total: 2, verified: 2 })
    // 올바른 탭은 건드리지 않는다 — set·clear 모두 0회, 읽기로만 끝난다.
    // 렌더러 재동기화도 안 건다 (이미 맞는 상태라 재동기화할 것이 없다).
    expect(sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    expect(sock.sent.filter((m) => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(0)
    expect(sock.sent.filter((m) => m.method === 'Browser.setWindowBounds')).toHaveLength(0)
    expect(sock.sent.filter((m) => m.method === 'Runtime.evaluate')).toHaveLength(2)
  })

  test('재동기화는 풀스크린→일반→풀스크린 토글이다 (QA 9차)', async () => {
    // 풀스크린만 다시 거는 것은 이미 풀스크린이면 no-op으로 무시돼
    // 안 먹힌다 (12:18 실측). 실제 상태 전환(일반 경유)이 필요하다.
    // 1차 호출은 크기를 넣어 일반 상태로 풀고, 2차 호출은
    // windowState만으로 풀스크린에 복귀한다 (크기+상태 동시 지정은
    // CDP가 -32602로 거부한다).
    const sock = new FakeSocket(makeViewportHandler())
    const r = await applyViewportToSession(WS_URL, { width: 1470, height: 850 }, async () => sock as CdpSocket)
    expect(r.ok).toBe(true)
    const bounds = sock.sent.filter((m) => m.method === 'Browser.setWindowBounds')
    expect(bounds).toHaveLength(2)
    expect(bounds[0].params).toEqual({ windowId: 42, bounds: { left: 0, top: 0, width: 1469, height: 849 } })
    expect(bounds[1].params).toEqual({ windowId: 42, bounds: { windowState: 'fullscreen' } })
    expect(bounds[0].sessionId).toBeUndefined() // 브라우저 레벨 호출이라 세션 없음
    expect(bounds[1].sessionId).toBeUndefined()
  })

  test('자연 상태가 이미 의도와 일치해도 건드리지 않는다 (override가 필요 없다)', async () => {
    // 자연 상태가 이미 스테이지 크기 × DSF 1.0이면 override를 걸어도
    // 같은 값이므로 건드릴 이유가 없다.
    const sock = new FakeSocket(makeViewportHandler({ natural: { w: 1680, h: 967, d: 1 } }))
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 1, total: 1, verified: 1 })
    expect(sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    expect(sock.sent.filter((m) => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(0)
  })

  test('한 탭만 불일치면(새 탭) 그 탭에만 적용하고, 일치 탭은 건드리지 않는다', async () => {
    // page-1은 적용済, page-2는 /viewport 이후에 생긴 새 탭(자연 상태).
    const sock = new FakeSocket(
      makeViewportHandler({
        pages: ['page-1', 'page-2'],
        initialOverrides: {
          'sess-page-1': { width: 1680, height: 967, deviceScaleFactor: 1 },
        },
      }),
    )
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 2, total: 2, verified: 2 })
    const sets = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(sets).toHaveLength(1)
    expect(sets[0].sessionId).toBe('sess-page-2')
    expect(sets[0].params).toEqual({ width: 1680, height: 967, deviceScaleFactor: 1, mobile: false })
    // clear는 나가지 않는다 — set이 기존 override를 대체한다 (QA 7차).
    expect(sock.sent.filter((m) => m.method === 'Emulation.clearDeviceMetricsOverride')).toHaveLength(0)
  })

  test('일치 탭이 있어도 불일치 탭의 적용 실패는 ok=false로 보고한다', async () => {
    const sock = new FakeSocket(
      makeViewportHandler({
        pages: ['page-1', 'page-2'],
        initialOverrides: {
          'sess-page-1': { width: 1680, height: 967, deviceScaleFactor: 1 },
        },
        setFailSession: 'sess-page-2',
      }),
    )
    const r = await applyViewportToSession(WS_URL, { width: 1680, height: 967 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'viewport', applied: 1, total: 2, verified: 1 })
  })

  test('낡은 1.5 override가 남은 탭은 DSF 1.0으로 다시 건다 (2026-11-16 QA 7차 회귀)', async () => {
    // 리사이즈 경합으로 남은 상태: 스테이지는 1280×800인데 override가
    // 옛 디스플레이 1920 ÷ 새 스테이지 1280 = 1.5로 박혀 있다. 크기만
    // 보면 일치하지만 DSF가 틀려 내용이 1.5배로 커져 넘친다.
    const sock = new FakeSocket(
      makeViewportHandler({
        initialOverrides: {
          'sess-page-1': { width: 1280, height: 800, deviceScaleFactor: 1.5 },
        },
      }),
    )
    const r = await applyViewportToSession(WS_URL, { width: 1280, height: 800 }, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok', applied: 1, total: 1, verified: 1 })
    const sets = sock.sent.filter((m) => m.method === 'Emulation.setDeviceMetricsOverride')
    expect(sets).toHaveLength(1)
    expect(sets[0].params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    // 옛 후보-DSF 방식은 실측(1280×1.5)÷1280 = 1.5를 후보로 삼아
    // 자기 일치를 이뤄 set을 0회 보내고 고정을 안 했다 — 이 테스트는
    // 그 구 코드에서 실패한다 (카나리아).
  })
})

describe('getBrowserState — 원격 현재 상태 읽기 (2026-11-15 밤)', () => {
  function stateHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
    if (msg.method === 'Target.getTargets') {
      emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
    } else if (msg.method === 'Target.attachToTarget') {
      emit({ id: msg.id, result: { sessionId: 'sess-1' } })
    } else if (msg.method === 'Runtime.evaluate') {
      // 활성 탭 식별용 visibility 평가와 URL 읽기 식을 구분해 답한다.
      if (String(msg.params?.expression ?? '').includes('visibilityState')) {
        emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      } else {
        emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: 'https://news.naver.com/article/123', title: '뉴스 기사 제목' }) } } })
      }
    } else if (msg.method === 'Page.getNavigationHistory') {
      emit({ id: msg.id, result: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } })
    }
  }

  test('URL·제목·뒤로/앞으로 가능 여부를 읽는다 (중간 인덱스면 둘 다 가능)', async () => {
    const sock = new FakeSocket(stateHandler)
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사 제목',
      canGoBack: true,
      canGoForward: true,
    })
    // visibility 평가가 URL 읽기보다 먼저 나간다 (활성 탭 식별).
    expect(sock.sent.map((m) => m.method)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Page.getNavigationHistory',
    ])
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals[0].params.expression).toContain('visibilityState')
    expect(evals[1].params.expression).toContain('location.href')
    expect(sock.closed).toBe(true)
  })

  test('첫 항목이면 뒤로 불가, 마지막 항목이면 앞으로 불가', async () => {
    const mk = (currentIndex: number) =>
      new FakeSocket((msg, emit) => {
        if (msg.method === 'Target.getTargets') {
          emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
        } else if (msg.method === 'Target.attachToTarget') {
          emit({ id: msg.id, result: { sessionId: 'sess-1' } })
        } else if (msg.method === 'Runtime.evaluate') {
          if (String(msg.params?.expression ?? '').includes('visibilityState')) {
            emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
          } else {
            emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: 'https://example.com', title: 't' }) } } })
          }
        } else if (msg.method === 'Page.getNavigationHistory') {
          emit({ id: msg.id, result: { currentIndex, entries: [{ id: 1 }, { id: 2 }] } })
        }
      })
    const first = await getBrowserState(WS_URL, async () => mk(0) as CdpSocket)
    expect(first).toEqual({ url: 'https://example.com', title: 't', canGoBack: false, canGoForward: true })
    const last = await getBrowserState(WS_URL, async () => mk(1) as CdpSocket)
    expect(last).toEqual({ url: 'https://example.com', title: 't', canGoBack: true, canGoForward: false })
  })

  test('타깃이 없거나 attach가 실패하면 null', async () => {
    const noTarget = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [] } })
    })
    await expect(getBrowserState(WS_URL, async () => noTarget as CdpSocket)).resolves.toBeNull()
    const noAttach = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, error: { message: 'nope' } })
      }
    })
    await expect(getBrowserState(WS_URL, async () => noAttach as CdpSocket)).resolves.toBeNull()
  })

  test('평가·히스토리 실패나 깨진 값이면 null', async () => {
    const evalFail = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, error: { message: 'nope' } })
      }
    })
    await expect(getBrowserState(WS_URL, async () => evalFail as CdpSocket)).resolves.toBeNull()
    const badJson = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, result: { result: { type: 'string', value: '{{{not json' } } })
      }
    })
    await expect(getBrowserState(WS_URL, async () => badJson as CdpSocket)).resolves.toBeNull()
    const histFail = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: 'https://example.com', title: 't' }) } } })
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, error: { message: 'nope' } })
      }
    })
    await expect(getBrowserState(WS_URL, async () => histFail as CdpSocket)).resolves.toBeNull()
  })

  test('connect 실패·타임아웃이면 null', async () => {
    await expect(getBrowserState(WS_URL, async () => null)).resolves.toBeNull()
    const silent = new FakeSocket(() => { /* 무응답 */ })
    await expect(
      getBrowserState(WS_URL, async () => silent as CdpSocket, { timeoutMs: 100 }),
    ).resolves.toBeNull()
    expect(silent.closed).toBe(true)
  })
})

describe('goBackSession/goForwardSession — 원격 뒤로/앞으로 (2026-11-15 밤, 2026-11-16 QA 2차 navigateToHistoryEntry 교체)', () => {
  // Page.goBack/goForward는 Chromium 156에 없어 'wasn't found' 에러만
  // 돌려준다 — 이동은 getNavigationHistory로 엔트리 id를 읽어
  // Page.navigateToHistoryEntry로 한다 (puppeteer와 같은 경로).
  function historyHandler(
    history: { currentIndex: number; entries: Array<{ id: number }> } | 'error' = {
      currentIndex: 1,
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
    },
    navigateError = false,
  ): (msg: Record<string, any>, emit: (m: unknown) => void) => void {
    return (msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        // 활성 탭 식별용 visibility 평가에 visible로 답한다 (무응답이면
        // 타깃당 1.5초 제한까지 기다려 테스트가 느려진다).
        emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      } else if (msg.method === 'Page.getNavigationHistory') {
        if (history === 'error') emit({ id: msg.id, error: { message: 'no history' } })
        else emit({ id: msg.id, result: history })
      } else if (msg.method === 'Page.navigateToHistoryEntry') {
        if (navigateError) emit({ id: msg.id, error: { message: 'cannot navigate' } })
        else emit({ id: msg.id, result: {} })
      }
    }
  }

  test('goBack은 currentIndex-1 엔트리 id로 navigateToHistoryEntry를 보내고 ok로 보고한다', async () => {
    const sock = new FakeSocket(historyHandler())
    const r = await goBackSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(nav).toBeDefined()
    expect(nav.params).toEqual({ entryId: 1 })
    expect(nav.sessionId).toBe('sess-1')
    // 존재하지 않는 Page.goBack을 보내면 안 된다 (Chromium 156 'wasn't found').
    expect(sock.sent.find((m) => m.method === 'Page.goBack')).toBeUndefined()
    expect(sock.closed).toBe(true)
  })

  test('goForward는 currentIndex+1 엔트리 id로 navigateToHistoryEntry를 보낸다', async () => {
    const sock = new FakeSocket(historyHandler())
    const r = await goForwardSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(nav).toBeDefined()
    expect(nav.params).toEqual({ entryId: 3 })
    expect(nav.sessionId).toBe('sess-1')
    expect(sock.sent.find((m) => m.method === 'Page.goForward')).toBeUndefined()
  })

  test('뒤로 갈 곳이 없으면(인덱스 0) navigate를 보내지 않고 stage=no-history', async () => {
    const sock = new FakeSocket(historyHandler({ currentIndex: 0, entries: [{ id: 1 }, { id: 2 }] }))
    const r = await goBackSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'no-history' })
    expect(sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')).toBeUndefined()
  })

  test('앞으로 갈 곳이 없으면(마지막 인덱스) navigate를 보내지 않고 stage=no-history', async () => {
    const sock = new FakeSocket(historyHandler({ currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] }))
    const r = await goForwardSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'no-history' })
    expect(sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')).toBeUndefined()
  })

  test('히스토리 읽기 실패는 stage=history', async () => {
    const sock = new FakeSocket(historyHandler('error'))
    const r = await goBackSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'history' })
  })

  test('navigateToHistoryEntry 실패는 stage=history', async () => {
    const sock = new FakeSocket(historyHandler(undefined, true))
    const r = await goBackSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'history' })
  })

  test('타깃 없음은 stage=targets, attach 실패는 stage=attach, connect 실패는 stage=connect', async () => {
    const noTarget = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [] } })
    })
    await expect(goBackSession(WS_URL, async () => noTarget as CdpSocket)).resolves.toEqual({
      ok: false,
      stage: 'targets',
    })
    const noAttach = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, error: { message: 'nope' } })
      }
    })
    await expect(goForwardSession(WS_URL, async () => noAttach as CdpSocket)).resolves.toEqual({
      ok: false,
      stage: 'attach',
    })
    await expect(goBackSession(WS_URL, async () => null)).resolves.toEqual({
      ok: false,
      stage: 'connect',
    })
  })
})

describe('attachActivePage — 활성 탭 선택 (2026-11-16 QA 1차)', () => {
  // 탭별 visibility를 흉내내는 상태 핸들러 팩토리. visibility가
  // 'error'면 평가 오류, 'silent'면 무응답(동결 탭)이다.
  function makeActiveHandler(pages: Array<{ targetId: string; visibility: 'visible' | 'hidden' | 'error' | 'silent'; url: string }>): (msg: Record<string, any>, emit: (m: unknown) => void) => void {
    const bySession: Record<string, { visibility: 'visible' | 'hidden' | 'error' | 'silent'; url: string }> = {}
    for (const p of pages) bySession[`sess-${p.targetId}`] = { visibility: p.visibility, url: p.url }
    return (msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: pages.map((p) => ({ type: 'page', targetId: p.targetId })) } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: `sess-${msg.params.targetId}` } })
      } else if (msg.method === 'Runtime.evaluate') {
        const sid = String(msg.sessionId ?? '')
        const tab = bySession[sid]
        if (String(msg.params?.expression ?? '').includes('visibilityState')) {
          if (!tab || tab.visibility === 'silent') return // 무응답 — 타깃당 제한까지 기다린다
          if (tab.visibility === 'error') {
            emit({ id: msg.id, error: { message: 'eval denied' } })
          } else {
            emit({ id: msg.id, result: { result: { type: 'string', value: tab.visibility } } })
          }
        } else {
          emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: tab?.url ?? 'https://example.com', title: 't' }) } } })
        }
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, result: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } })
      } else if (msg.method === 'Page.navigateToHistoryEntry') {
        emit({ id: msg.id, result: {} })
      }
    }
  }

  test('첫 타깃이 hidden이고 두 번째가 visible이면 두 번째 탭의 상태를 읽는다', async () => {
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'hidden', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'visible', url: 'https://news.naver.com/article/123' },
    ]))
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r?.url).toBe('https://news.naver.com/article/123')
    // URL 읽기·히스토리는 visible 탭의 세션으로 간다 (첫 타깃이 아니다).
    const urlEval = sock.sent.find(
      (m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('location.href'),
    )
    expect(urlEval?.sessionId).toBe('sess-page-2')
    const hist = sock.sent.find((m) => m.method === 'Page.getNavigationHistory')
    expect(hist?.sessionId).toBe('sess-page-2')
  })

  test('전부 hidden이면 첫 타깃으로 폴백한다', async () => {
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'hidden', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'hidden', url: 'https://news.naver.com/article/123' },
    ]))
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r?.url).toBe('https://www.naver.com')
    const urlEval = sock.sent.find(
      (m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('location.href'),
    )
    expect(urlEval?.sessionId).toBe('sess-page-1')
  })

  test('visibility 평가가 실패하면 첫 타깃으로 폴백한다', async () => {
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'error', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'hidden', url: 'https://news.naver.com/article/123' },
    ]))
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r?.url).toBe('https://www.naver.com')
  })

  test('visibility 평가가 응답 없는 탭(동결)은 건너뛰고 visible 탭을 선택한다', async () => {
    // 첫 탭이 동결돼 평가가 안 오면, 타깃당 제한(1.5초) 뒤에 두 번째
    // 탭으로 넘어간다 — 제한이 없으면 전체 타임아웃(5초)까지 붙잡혀
    // /state가 매번 502가 된다 (QA 1차의 실제 실패).
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'silent', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'visible', url: 'https://news.naver.com/article/123' },
    ]))
    const started = Date.now()
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r?.url).toBe('https://news.naver.com/article/123')
    const urlEval = sock.sent.find(
      (m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('location.href'),
    )
    expect(urlEval?.sessionId).toBe('sess-page-2')
    // 1.5초 제한으로 건너뛰므로 5초 전체 타임아웃보다 훨씬 빨리 끝난다.
    expect(Date.now() - started).toBeLessThan(4000)
  }, 10000)

  test('goBack은 visible 탭에 navigateToHistoryEntry(entryId 1)를 보낸다 (첫 타깃이 hidden이어도)', async () => {
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'hidden', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'visible', url: 'https://news.naver.com/article/123' },
    ]))
    const r = await goBackSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const back = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(back?.sessionId).toBe('sess-page-2')
    expect(back?.params).toEqual({ entryId: 1 })
  })

  test('goForward도 visible 탭을 대상으로 한다 (entryId 3)', async () => {
    const sock = new FakeSocket(makeActiveHandler([
      { targetId: 'page-1', visibility: 'hidden', url: 'https://www.naver.com' },
      { targetId: 'page-2', visibility: 'visible', url: 'https://news.naver.com/article/123' },
    ]))
    const r = await goForwardSession(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const fwd = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(fwd?.sessionId).toBe('sess-page-2')
    expect(fwd?.params).toEqual({ entryId: 3 })
  })
})

describe('navigateSession — 연결·단계 실패', () => {
  test('connect가 null을 돌려주거나 던지면 stage=connect', async () => {
    await expect(navigateSession(WS_URL, TARGET, async () => null)).resolves.toEqual({ ok: false, stage: 'connect' })
    await expect(
      navigateSession(WS_URL, TARGET, async () => { throw new Error('ws down') }),
    ).resolves.toEqual({ ok: false, stage: 'connect' })
  })

  test('attach 이후 navigate가 오류면 stage=navigate', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      else if (msg.method === 'Target.attachToTarget') emit({ id: msg.id, result: { sessionId: 's' } })
      else if (msg.method === 'Runtime.evaluate') emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, error: { message: 'cannot navigate' } })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'navigate' })
  })

  test('getTargets 오류면 세션 없는 직접 navigate로 폴백하고 성공할 수 있다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, error: { message: 'no targets api' } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, result: {} })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')!
    expect(nav.sessionId).toBeUndefined()
    expect(nav.params).toEqual({ url: TARGET })
  })

  test('attach 실패 후 직접 navigate도 실패하면 stage=attach로 보고한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      else if (msg.method === 'Target.attachToTarget') emit({ id: msg.id, error: { message: 'attach denied' } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, error: { message: 'nav denied' } })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'attach' })
  })

  test('타깃이 끝내 없으면 재시도 후 직접 navigate로 폴백한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [] } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, result: {} })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, { timeoutMs: 8000 })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(sock.sent.filter((m) => m.method === 'Target.getTargets').length).toBe(4)
  }, 15000)

  test('타임아웃으로 끝난 뒤에는 예약된 재시도가 나가지 않는다 (재시도 타이머 누수 없음)', async () => {
    // 첫 getTargets가 빈 목록을 돌려줘 재시도(300ms)가 예약된 뒤,
    // 타임아웃(100ms)으로 끝나면 그 재시도는 취소돼야 한다 — 안 그러면
    // 끝난 뒤에도 getTargets가 계속 나가고 타이머가 이벤트 루프를 붙잡는다.
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [] } })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, { timeoutMs: 100 })
    expect(r).toEqual({ ok: false, stage: 'targets' })
    const countTargets = (): number => sock.sent.filter((m) => m.method === 'Target.getTargets').length
    expect(countTargets()).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(countTargets()).toBe(1)
  })

  test('응답이 없으면 timeoutMs 뒤 현재 단계(targets)로 종료하고 소켓을 닫는다', async () => {
    const sock = new FakeSocket(() => { /* 무응답 */ })
    const started = Date.now()
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, { timeoutMs: 120 })
    expect(r).toEqual({ ok: false, stage: 'targets' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(sock.closed).toBe(true)
  })

  test('send가 던지면 현재 단계로 실패한다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.throwOnSend = true
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'targets' })
  })

  test('리스너 등록 자체가 던지면 stage=connect로 변환된다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.addEventListener = () => { throw new Error('no listeners') }
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'connect' })
  })

  test('리스너 등록이 던져도 타이머가 남지 않는다 (고아 타이머 없음)', async () => {
    // executor가 동기 throw하면 Promise가 reject돼 finish가 안 불리는데,
    // 타임아웃 타이머가 그 전에 만들어지면 5초짜리 고아가 돼 jest 워커가
    // 1초 안에 안 죽고 'did not exit' 경고를 낸다 (2026-11-15 실측).
    jest.useFakeTimers()
    try {
      const before = jest.getTimerCount()
      const sock = new FakeSocket(happyHandler)
      sock.addEventListener = () => { throw new Error('no listeners') }
      const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
      expect(r).toEqual({ ok: false, stage: 'connect' })
      expect(jest.getTimerCount()).toBe(before)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('defaultCdpConnect — Workers fetch 경계', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  test('업그레이드 응답의 webSocket을 accept해 쓰고, URL은 https로 변환된다', async () => {
    const sock = new FakeSocket(happyHandler)
    let accepted = false
    ;(sock as any).accept = () => { accepted = true }
    let seenUrl = ''
    let seenHeaders: Record<string, string> | undefined
    global.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url)
      seenHeaders = init?.headers
      return { webSocket: sock }
    }) as unknown as typeof fetch
    const r = await navigateSession(WS_URL, TARGET, undefined, { headers: { Authorization: 'Bearer t' } })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(seenUrl).toBe('https://browser.example/devtools/browser/abc')
    expect(seenHeaders).toMatchObject({ Upgrade: 'websocket', Authorization: 'Bearer t' })
    expect(accepted).toBe(true)
  })

  test('업그레이드 응답에 webSocket이 없으면 connect 실패다', async () => {
    global.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const r = await navigateSession(WS_URL, TARGET)
    expect(r).toEqual({ ok: false, stage: 'connect' })
  })
})
