/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 뷰포트 측정 — hidden iframe 회귀 (2026-11-12)
 *
 * 사용자 실화면 지적: 최대화한 브라우저 창에서 네이버가 1.5배쯤 확대돼
 * 양쪽이 잘려 보인다. 100%면 일반 브라우저처럼 보여야 한다.
 * 원인: enterLive()가 뷰포트를 #bwLiveFrame 자기 자신에서 재는데, 시작
 * 중에는 iframe이 hidden(display:none)이라 rect가 항상 0x0이다. 그래서
 * 뷰포트가 서버에 한 번도 전달되지 않았고, 원격은 기본 1280x720으로 뜬
 * 채 최대화 iframe에 맞춰 확대돼 보였다. 2026-11-12에 넣은 "iframe 크기
 * 전송" 기능은 처음부터 동작하지 않은 셈이다.
 * 수정: iframe이 꽉 채우는 .bw-stage(부모, 항상 보임) 크기를 잰다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - iframe이 hidden(0x0)이어도 stage 크기가 liveStart에 뷰포트로 전달된다.
 * - stage 크기를 못 재면 iframe 자기 rect로 폴백한다.
 * - 둘 다 0x0이면 뷰포트 없이 시작한다 (서버 기본값).
 * 카나리아: 이 테스트는 수정 전 코드에서 실패한다 (iframe만 재서 null).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function stubRect(el: any, width: number, height: number): void {
  el.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}

function setupFixture(stageSize: { w: number; h: number }, frameSize: { w: number; h: number }): void {
  const doc = getDoc()
  doc.body.innerHTML = `
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome"></div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-pill" id="bwPill" hidden>
        <span id="bwLiveMsg"></span><span id="bwLiveTime"></span>
        <button type="button" id="bwLiveEnd">종료</button>
      </div>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
      <div class="bw-starting" id="bwStarting" hidden></div>
    </div>
  `
  stubRect(doc.getElementById('bwStage'), stageSize.w, stageSize.h)
  stubRect(doc.getElementById('bwLiveFrame'), frameSize.w, frameSize.h)
}

function loadLive(): any {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', LIVE_JS)(win, doc)
  return win.MyHubBrowserLive
}

describe('browser-live viewport 측정', () => {
  test('iframe이 hidden(0x0)이어도 stage 크기를 뷰포트로 보낸다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const api = loadLive()
    const calls: Array<{ url: string | null; viewport: unknown }> = []
    const live = api.createLive({
      doc: getDoc(),
      liveStart: (url: string | null, viewport: unknown) => {
        calls.push({ url, viewport })
        return Promise.resolve({
          status: 200,
          body: { ok: true, viewUrl: 'https://live.example/view', expiresAt: Date.now() + 120000 },
        })
      },
      liveStop: () => Promise.resolve(),
      onChange: () => undefined,
    })
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].viewport).toEqual({ width: 1920, height: 1000 })
    live.endLive(false)
  })

  test('stage 크기를 못 재면 iframe rect로 폴백한다', async () => {
    setupFixture({ w: 0, h: 0 }, { w: 1280, h: 720 })
    const api = loadLive()
    const calls: Array<{ url: string | null; viewport: unknown }> = []
    const live = api.createLive({
      doc: getDoc(),
      liveStart: (url: string | null, viewport: unknown) => {
        calls.push({ url, viewport })
        return Promise.resolve({
          status: 200,
          body: { ok: true, viewUrl: 'https://live.example/view', expiresAt: Date.now() + 120000 },
        })
      },
      liveStop: () => Promise.resolve(),
      onChange: () => undefined,
    })
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls[0].viewport).toEqual({ width: 1280, height: 720 })
    live.endLive(false)
  })

  test('둘 다 0x0이면 뷰포트 없이 시작한다', async () => {
    setupFixture({ w: 0, h: 0 }, { w: 0, h: 0 })
    const api = loadLive()
    const calls: Array<{ url: string | null; viewport: unknown }> = []
    const live = api.createLive({
      doc: getDoc(),
      liveStart: (url: string | null, viewport: unknown) => {
        calls.push({ url, viewport })
        return Promise.resolve({
          status: 200,
          body: { ok: true, viewUrl: 'https://live.example/view', expiresAt: Date.now() + 120000 },
        })
      },
      liveStop: () => Promise.resolve(),
      onChange: () => undefined,
    })
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls[0].viewport).toBeNull()
    live.endLive(false)
  })
})
