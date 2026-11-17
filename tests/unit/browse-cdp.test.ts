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
 * - 뷰포트 영구 override (2026-11-16 QA 12차): /viewport는 직접 CDP가
 *   아니라 사이드카 영구 override 매니저(/control/viewport) 경유다.
 *   직접 CDP는 세션을 닫으면 override가 풀려 렌더러가 1918로
 *   되돌아가고, 풀스크린 토글 재동기화는 QA 9·10·11·12차에서 네 번
 *   불합격했다. navigateSession의 인라인 뷰포트 set만 남는다 (이동
 *   시점 1회 적용, 사이드카 영구 override가 뒤를 잇는다).
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
 * - 리사이즈 경합 회귀 (2026-11-16 QA 7차, applyViewportToSession 삭제
 *   시 함께 제거됨): 낡은 1.5 override가 남은 탭은 의도(DSF 1.0)와
 *   불일치로 판정돼 DSF 1.0으로 다시 걸렸다. 옛 후보-DSF 방식은 낡은
 *   배율을 후보로 삼아 자기 일치를 이뤄 고정을 안 했다.
 * - 사이드카 상태 빠른 경로 (2026-11-17 P0): fetchSidecarBrowserState가
 *   GET /control/state를 1회 fetch로 읽어 BrowserState를 돌려준다.
 *   직접 CDP 경로(폴링 1회당 순차 왕복 ~8회, 약 1.5초) 대신 1왕복
 *   (약 0.25초)으로 상태를 얻는다. 구 사이드카(404)·네트워크 실패·
 *   깨진 응답이면 null을 돌려 호출자가 직접 CDP 방식으로 폴백하게 한다.
 * - evaluate 통합 (2026-11-17 P1): getBrowserState는 visibility 평가와
 *   URL 읽기 평가를 나누지 않고 프로브 식(visibility·url·title 병합)
 *   1회로 읽는다 (직접 CDP 경로 5왕복 → 4왕복, 약 170ms 절감).
 *   프로브가 url·title을 못 주면(XML 문서·타임아웃·깨진 응답) 별도
 *   평가로 읽는 폴백이 있어 동작이 동일하다.
 * 카나리아: 단계 보고(stage)나 폴백 조건을 깨면 해당 테스트가 실패한다.
 */
import { fetchSidecarBrowserState, getBrowserState, goBackSession, goForwardSession, navigateSession, REMOTE_DISPLAY_SCALE, wsToHttpUrl, type CdpSocket } from '../../src/modules/browse/cdp'

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

/** 병합 프로브 응답: visibility·url·title을 한 번의 평가로 돌려준다
 *  (2026-11-17 P1 evaluate 통합 — 실제 Chromium의 프로브 결과 모양). */
function probeResult(
  visibility: 'visible' | 'hidden',
  url = 'https://example.com',
  title = 't',
): { result: { result: { type: string; value: string } } } {
  return { result: { result: { type: 'string', value: JSON.stringify({ visibility, url, title }) } } }
}

function happyHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
  if (msg.method === 'Target.getTargets') {
    emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }, { type: 'browser' }] } })
  } else if (msg.method === 'Target.attachToTarget') {
    emit({ id: msg.id, result: { sessionId: 'sess-1' } })
  } else if (msg.method === 'Runtime.evaluate') {
    // 활성 탭 식별용 프로브 평가 — 단일 탭은 visible이다.
    emit({ id: msg.id, ...probeResult('visible') })
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
        emit({ id: msg.id, ...probeResult('visible') })
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
        // 영구 탭만 visible, 팝업은 hidden이다 (병합 프로브로 답한다).
        const vis = String(msg.sessionId ?? '').endsWith('page-1') ? 'visible' : 'hidden'
        emit({ id: msg.id, ...probeResult(vis as 'visible' | 'hidden') })
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
          emit({ id: msg.id, ...probeResult((vis ?? 'hidden') as 'visible' | 'hidden') })
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
      // 활성 탭 식별용 프로브 평가만 온다 (DSF 측정은 QA 7차에 폐지).
      emit({ id: msg.id, ...probeResult('visible') })
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
        emit({ id: msg.id, ...probeResult('visible') })
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

describe('getBrowserState — 원격 현재 상태 읽기 (2026-11-15 밤)', () => {
  function stateHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
    if (msg.method === 'Target.getTargets') {
      emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
    } else if (msg.method === 'Target.attachToTarget') {
      emit({ id: msg.id, result: { sessionId: 'sess-1' } })
    } else if (msg.method === 'Runtime.evaluate') {
      // 병합 프로브 식에는 visibility·url·title을 한 번에 답한다.
      // 별도 URL 읽기 식(프로브 폴백)이 오면 URL JSON으로 답한다.
      if (String(msg.params?.expression ?? '').includes('visibilityState')) {
        emit({
          id: msg.id,
          ...probeResult('visible', 'https://news.naver.com/article/123', '뉴스 기사 제목'),
        })
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
    // P1 통합: visibility 평가와 URL 읽기 평가가 프로브 1회로 합쳐졌다
    // (옛날에는 Runtime.evaluate가 2회 나갔다 — 1왕복 절감).
    expect(sock.sent.map((m) => m.method)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
      'Page.getNavigationHistory',
    ])
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals).toHaveLength(1)
    expect(evals[0].params.expression).toContain('visibilityState')
    expect(evals[0].params.expression).toContain('location.href')
    expect(evals[0].params.expression).toContain('document.title')
    expect(sock.closed).toBe(true)
  })

  test('프로브에 title이 없으면(XML 문서) 별도 평가로 읽어 같은 결과를 돌려준다', async () => {
    // 프로브는 visible인데 title이 빠졌다 — page가 null이 돼 별도
    // 평가가 나가야 한다. 별도 평가가 없으면 url이 있어도 null이 된다.
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        if (String(msg.params?.expression ?? '').includes('visibilityState')) {
          emit({
            id: msg.id,
            result: { result: { type: 'string', value: JSON.stringify({ visibility: 'visible', url: 'https://example.com/feed.xml' }) } },
          })
        } else {
          emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: 'https://example.com/feed.xml', title: '피드' }) } } })
        }
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, result: { currentIndex: 0, entries: [{ id: 1 }] } })
      }
    })
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({
      url: 'https://example.com/feed.xml',
      title: '피드',
      canGoBack: false,
      canGoForward: false,
    })
    expect(sock.sent.filter((m) => m.method === 'Runtime.evaluate')).toHaveLength(2)
  })

  test('프로브가 깨지면 첫 탭으로 폴백해 별도 평가로 읽는다', async () => {
    // 프로브 응답이 깨진 JSON이면 visibility를 못 읽어 첫 탭 폴백이
    // 되고, page가 없어 별도 평가가 나간다 — 별도 평가가 성공하면
    // 상태는 정상으로 읽힌다.
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        if (String(msg.params?.expression ?? '').includes('visibilityState')) {
          emit({ id: msg.id, result: { result: { type: 'string', value: '{{{깨진 프로브' } } })
        } else {
          emit({ id: msg.id, result: { result: { type: 'string', value: JSON.stringify({ url: 'https://example.com', title: 't' }) } } })
        }
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, result: { currentIndex: 0, entries: [{ id: 1 }] } })
      }
    })
    const r = await getBrowserState(WS_URL, async () => sock as CdpSocket)
    expect(r).toEqual({ url: 'https://example.com', title: 't', canGoBack: false, canGoForward: false })
    expect(sock.sent.filter((m) => m.method === 'Runtime.evaluate')).toHaveLength(2)
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
            emit({ id: msg.id, ...probeResult('visible', 'https://example.com', 't') })
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
        // 활성 탭 식별용 프로브 평가에 visible로 답한다 (무응답이면
        // 타깃당 1.5초 제한까지 기다려 테스트가 느려진다).
        emit({ id: msg.id, ...probeResult('visible') })
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
            // 병합 프로브로 답한다 — 해당 탭의 visibility와 URL을 함께.
            emit({ id: msg.id, ...probeResult(tab.visibility as 'visible' | 'hidden', tab.url, 't') })
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
    // 프로브는 두 탭을 순서대로 스캔하고, 히스토리는 visible 탭의
    // 세션으로 간다 (첫 타깃이 아니다). URL은 page-2 프로브에서 왔다.
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals.map((m) => m.sessionId)).toEqual(['sess-page-1', 'sess-page-2'])
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
    // 두 탭을 스캔한 뒤 첫 탭 프로브의 URL을 쓴다 (별도 평가 없음).
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals.map((m) => m.sessionId)).toEqual(['sess-page-1', 'sess-page-2'])
    const hist = sock.sent.find((m) => m.method === 'Page.getNavigationHistory')
    expect(hist?.sessionId).toBe('sess-page-1')
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
    const evals = sock.sent.filter((m) => m.method === 'Runtime.evaluate')
    expect(evals.map((m) => m.sessionId)).toEqual(['sess-page-1', 'sess-page-2'])
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
      else if (msg.method === 'Runtime.evaluate') emit({ id: msg.id, ...probeResult('visible') })
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

describe('fetchSidecarBrowserState — 사이드카 상태 빠른 경로 (2026-11-17 P0)', () => {
  const URL = 'https://203.0.113.7:8081/control/state'
  const HEADERS = { 'x-origin-secret': 'origin-secret', 'x-cdp-secret': 'cdp-secret' }
  const GOOD = { ok: true, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: true, canGoForward: false }

  function fakeFetch(body: unknown, ok = true, status = 200) {
    const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string> } }> = []
    const fn = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({ url, init })
      return { ok, status, json: async () => body }
    }
    return { fn, calls }
  }

  test('정상 응답이면 1회 GET으로 BrowserState를 돌려주고 시크릿 헤더를 보낸다', async () => {
    const { fn, calls } = fakeFetch(GOOD)
    const r = await fetchSidecarBrowserState(URL, HEADERS, fn)
    expect(r).toEqual({ url: 'https://www.naver.com/', title: 'NAVER', canGoBack: true, canGoForward: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL)
    expect(calls[0].init?.method).toBe('GET')
    expect(calls[0].init?.headers).toEqual(HEADERS)
  })

  test('구 사이드카(404)·502면 null — 호출자가 직접 CDP로 폴백한다', async () => {
    const { fn: f404 } = fakeFetch({ error: 'not_found' }, false, 404)
    await expect(fetchSidecarBrowserState(URL, HEADERS, f404)).resolves.toBeNull()
    const { fn: f502 } = fakeFetch({ error: 'browser_state' }, false, 502)
    await expect(fetchSidecarBrowserState(URL, HEADERS, f502)).resolves.toBeNull()
  })

  test('fetch가 던지거나 JSON이 깨지면 null', async () => {
    const throwing = async () => { throw new Error('unreachable') }
    await expect(fetchSidecarBrowserState(URL, HEADERS, throwing)).resolves.toBeNull()
    const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    await expect(fetchSidecarBrowserState(URL, HEADERS, badJson)).resolves.toBeNull()
  })

  test('ok가 아니거나 필드가 깨졌으면 null (타입 검증)', async () => {
    const cases: unknown[] = [
      null,
      { ok: false, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: true, canGoForward: false },
      { ok: true, url: 123, title: 'NAVER', canGoBack: true, canGoForward: false },
      { ok: true, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: 'yes', canGoForward: false },
      { ok: true, url: 'https://www.naver.com/', title: 'NAVER' },
    ]
    for (const body of cases) {
      const { fn } = fakeFetch(body)
      await expect(fetchSidecarBrowserState(URL, HEADERS, fn)).resolves.toBeNull()
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
