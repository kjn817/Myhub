/**
 * 데스크톱 워크스페이스 상태 모델 테스트 — public/js/desktop/state.js
 *
 * 설계: docs/desktop-workspace-design-20261030.md 5절(상태 모델)·12절(테스트 전략)
 * state.js는 순수 로직이라 DOM이 필요 없다. 파일을 텍스트로 읽어
 * fake window를 주입하는 UMD 로더로 평가해 MyHubDesktopState를 얻는다.
 *
 * 검증 성질:
 * - 직렬화 왕복 동등성, 저장→load 재현
 * - clamp 경계 (화면 밖·최소 미만·뷰포트 초과·뷰포트 축소 시 제목줄 48px 보장)
 * - z-order 단조 증가·싱글턴·최소화/닫기 후 activeId 재계산
 * - 깨진 입력에서도 throw 없이 빈 상태/부분 복구
 * - 전이 함수의 불변성 (깊은 동결 입력에도 throw 없음)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')

function loadState(): any {
  const fakeWindow: Record<string, any> = {}
  const loader = new Function('window', STATE_JS + '\nreturn window.MyHubDesktopState;')
  return loader(fakeWindow)
}

const S = loadState()
const VP = { w: 1440, h: 900 }

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    _map: map,
  }
}

function openSeveral() {
  let s = S.emptyState()
  s = S.openModule(s, 'memo', VP)
  s = S.openModule(s, 'schedule', VP)
  s = S.openModule(s, 'todo', VP)
  return s
}

function deepFreeze(obj: any): any {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) deepFreeze(obj[k])
    Object.freeze(obj)
  }
  return obj
}

describe('상수와 모듈 정의 (설계 4절)', () => {
  test('저장 키·버전·최소 크기·제목줄 그립 상수가 계약과 일치한다', () => {
    expect(S.STORAGE_KEY).toBe('myhub.desktop.v1')
    expect(S.VERSION).toBe(2)
    expect(S.MIN_W).toBe(300)
    expect(S.MIN_H).toBe(220)
    expect(S.TITLE_GRIP).toBe(48)
  })

  test('모듈 12종의 id·url·기본 크기·글리프가 설계 표와 일치한다', () => {
    expect(S.MODULES).toEqual([
      { id: 'finder', title: 'Finder', url: '/finder.html', defW: 920, defH: 620, glyph: 'folder' },
      { id: 'memo', title: '메모', url: '/memo.html', defW: 880, defH: 620, glyph: 'notebook-pen' },
      { id: 'schedule', title: '일정', url: '/schedule.html', defW: 880, defH: 620, glyph: 'calendar' },
      { id: 'todo', title: '할 일', url: '/todo.html', defW: 640, defH: 560, glyph: 'list-checks' },
      { id: 'chat', title: 'AI 채팅', url: '/chat.html', defW: 720, defH: 620, glyph: 'messages-square' },
      { id: 'browser', title: '브라우저', url: '/browser.html', defW: 1080, defH: 700, glyph: 'compass' },
      { id: 'excel', title: 'Excel', url: '/office.html?app=excel', defW: 1180, defH: 720, glyph: 'table' },
      { id: 'hangul', title: '한글 2020', url: '/office.html?app=hangul', defW: 1080, defH: 720, glyph: 'file-text' },
      { id: 'powerpoint', title: 'PowerPoint', url: '/office.html?app=powerpoint', defW: 1080, defH: 700, glyph: 'presentation' },
      { id: 'pdf', title: 'PDF', url: '/office.html?app=pdf', defW: 980, defH: 700, glyph: 'file' },
      { id: 'studio', title: 'AI 스튜디오', url: '/agent.html', defW: 1180, defH: 720, glyph: 'sparkles' },
      { id: 'backup', title: '백업', url: '/backup.html', defW: 880, defH: 640, glyph: 'archive' },
    ])
  })

  test('emptyState는 빈 창 목록·activeId null·zCounter 0·스페이스 1개다', () => {
    expect(S.emptyState()).toEqual({
      version: 2,
      windows: [],
      activeId: null,
      zCounter: 0,
      spaces: [{ id: 'space-1', name: '데스크톱 1' }],
      activeSpaceId: 'space-1',
      spaceCounter: 1,
    })
  })
})

describe('직렬화 왕복과 저장·복원', () => {
  test('serialize → parse 결과가 원본 상태와 동등하다', () => {
    const s = openSeveral()
    const restored = S.parse(S.serialize(s), VP)
    expect(restored).toEqual(s)
  })

  test('save → load로 저장된 배치가 그대로 재현된다', () => {
    const storage = makeStorage()
    let s = openSeveral()
    s = S.moveWindow(s, 'memo', 120, 80, VP)
    s = S.minimizeWindow(s, 'todo')
    S.save(storage, s)
    expect(storage._map.get(S.STORAGE_KEY)).toBe(S.serialize(s))
    const restored = S.load(storage, VP)
    expect(restored).toEqual(s)
  })

  test('저장된 항목이 없으면 load는 빈 상태를 반환한다', () => {
    expect(S.load(makeStorage(), VP)).toEqual(S.emptyState())
  })
})

describe('clampRect — 설계 5.4 경계', () => {
  test('화면 밖 좌표는 제목줄 48px이 남는 범위로 당겨진다', () => {
    const r = S.clampRect({ x: 5000, y: -300, w: 880, h: 620 }, VP)
    expect(r.x).toBe(VP.w - 48)
    expect(r.y).toBe(0)
    const left = S.clampRect({ x: -5000, y: 40, w: 880, h: 620 }, VP)
    expect(left.x).toBe(-(880 - 48))
  })

  test('최소 미만 크기는 최소 크기로, 뷰포트 초과 크기는 뷰포트로 잘린다', () => {
    const small = S.clampRect({ x: 0, y: 0, w: 100, h: 50 }, VP)
    expect(small.w).toBe(S.MIN_W)
    expect(small.h).toBe(S.MIN_H)
    const big = S.clampRect({ x: 0, y: 0, w: 9999, h: 9999 }, VP)
    expect(big.w).toBe(VP.w)
    expect(big.h).toBe(VP.h)
  })

  test('뷰포트가 저장 시점보다 줄어들어도 제목줄 48px이 보장된다', () => {
    // 큰 화면에서 오른쪽 아래에 둔 창을 작은 뷰포트로 복원하는 경우
    const smallVp = { w: 800, h: 600 }
    const r = S.clampRect({ x: 1300, y: 850, w: 880, h: 620 }, smallVp)
    expect(r.w).toBeLessThanOrEqual(smallVp.w)
    expect(r.h).toBeLessThanOrEqual(smallVp.h)
    // 제목줄이 닿을 수 있는 영역: 오른쪽 48px, 아래 48px이 뷰포트 안에 남는다
    expect(smallVp.w - r.x).toBeGreaterThanOrEqual(48)
    expect(smallVp.h - r.y).toBeGreaterThanOrEqual(48)
    expect(r.y).toBeGreaterThanOrEqual(0)
    // 왼쪽으로 밀린 창도 제목줄 오른쪽 끝 48px은 화면 안에 남는다
    expect(r.x + r.w).toBeGreaterThanOrEqual(48)
  })

  test('아래로 완전히 밀린 창도 제목줄이 닿는 위치로 돌아온다', () => {
    const r = S.clampRect({ x: 10, y: 99999, w: 400, h: 300 }, VP)
    expect(r.y).toBe(VP.h - 48)
  })
})

describe('열기·포커스 — z-order와 싱글턴', () => {
  test('열면 기본 크기로 추가되고 포커스(z=++zCounter, activeId)를 받는다', () => {
    const s = S.openModule(S.emptyState(), 'memo', VP)
    expect(s.windows).toHaveLength(1)
    const w = s.windows[0]
    expect(w).toMatchObject({ id: 'memo', module: 'memo', w: 880, h: 620, z: 1, minimized: false })
    expect(s.activeId).toBe('memo')
    expect(s.zCounter).toBe(1)
  })

  test('기본 위치는 뷰포트 중앙이고, 열린 창 수만큼 28px 계단 오프셋이 붙는다', () => {
    let s = S.emptyState()
    s = S.openModule(s, 'memo', VP)
    s = S.openModule(s, 'schedule', VP)
    const memo = s.windows.find((w: any) => w.id === 'memo')
    const sched = s.windows.find((w: any) => w.id === 'schedule')
    expect(memo.x).toBe((VP.w - 880) / 2)
    expect(memo.y).toBe((VP.h - 620) / 2)
    expect(sched.x).toBe(memo.x + 28)
    expect(sched.y).toBe(memo.y + 28)
  })

  test('같은 모듈을 다시 열면 창이 늘지 않고(싱글턴) 포커스만 이동한다', () => {
    let s = openSeveral()
    const before = s.zCounter
    s = S.openModule(s, 'memo', VP)
    expect(s.windows).toHaveLength(3)
    expect(s.activeId).toBe('memo')
    expect(s.zCounter).toBe(before + 1)
    expect(s.windows.find((w: any) => w.id === 'memo').z).toBe(s.zCounter)
  })

  test('최소화된 창을 다시 열면 최소화가 해제되고 포커스를 받는다', () => {
    let s = openSeveral()
    s = S.minimizeWindow(s, 'memo')
    expect(s.windows.find((w: any) => w.id === 'memo').minimized).toBe(true)
    s = S.openModule(s, 'memo', VP)
    expect(s.windows.find((w: any) => w.id === 'memo').minimized).toBe(false)
    expect(s.activeId).toBe('memo')
  })

  test('모르는 moduleId를 열면 상태가 그대로 반환된다', () => {
    const s = openSeveral()
    expect(S.openModule(s, 'nope', VP)).toBe(s)
  })

  test('포커스를 반복하면 z가 단조 증가하고 activeId가 마지막 포커스와 일치한다', () => {
    let s = openSeveral()
    const zs: number[] = []
    for (const id of ['memo', 'todo', 'schedule', 'memo']) {
      s = S.focusWindow(s, id)
      zs.push(s.windows.find((w: any) => w.id === id).z)
      expect(s.activeId).toBe(id)
      expect(s.zCounter).toBe(zs[zs.length - 1])
    }
    for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThan(zs[i - 1])
  })

  test('없는 창을 포커스하면 상태가 그대로 반환된다', () => {
    const s = openSeveral()
    expect(S.focusWindow(s, 'ghost')).toBe(s)
  })
})

describe('최소화·닫기 후 activeId 재계산', () => {
  test('활성 창을 최소화하면 남은 비최소화 창 중 z 최대인 창이 active가 된다', () => {
    let s = openSeveral() // z: memo1 < schedule2 < todo3, active=todo
    s = S.focusWindow(s, 'memo') // memo가 최상위·active
    s = S.minimizeWindow(s, 'memo')
    expect(s.activeId).toBe('todo')
  })

  test('비활성 창을 최소화해도 activeId는 바뀌지 않는다', () => {
    let s = openSeveral()
    s = S.minimizeWindow(s, 'memo')
    expect(s.activeId).toBe('todo')
  })

  test('모든 창을 최소화하면 activeId는 null이 된다', () => {
    let s = openSeveral()
    for (const id of ['memo', 'schedule', 'todo']) s = S.minimizeWindow(s, id)
    expect(s.activeId).toBeNull()
    expect(s.windows.every((w: any) => w.minimized)).toBe(true)
  })

  test('활성 창을 닫으면 다음 최상위 창이 active가 되고, 전부 닫으면 null이다', () => {
    let s = openSeveral()
    s = S.closeWindow(s, 'todo')
    expect(s.windows).toHaveLength(2)
    expect(s.activeId).toBe('schedule')
    s = S.closeWindow(s, 'schedule')
    s = S.closeWindow(s, 'memo')
    expect(s.windows).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })

  test('최소화된 창만 남기고 활성 창을 닫으면 activeId는 null이다', () => {
    let s = openSeveral()
    s = S.minimizeWindow(s, 'memo')
    s = S.minimizeWindow(s, 'schedule')
    s = S.closeWindow(s, 'todo') // active였던 창
    expect(s.activeId).toBeNull()
  })
})

describe('이동·리사이즈는 clamp를 거친다', () => {
  test('moveWindow는 좌표를 갱신하되 화면 밖으로 완전히 나가지 않는다', () => {
    let s = S.openModule(S.emptyState(), 'todo', VP)
    s = S.moveWindow(s, 'todo', 99999, -50, VP)
    const w = s.windows[0]
    expect(w.x).toBe(VP.w - 48)
    expect(w.y).toBe(0)
    expect(w.w).toBe(640) // 크기는 불변
  })

  test('resizeWindow는 rect 전체에 clamp를 적용한다', () => {
    let s = S.openModule(S.emptyState(), 'todo', VP)
    s = S.resizeWindow(s, 'todo', { x: -9999, y: 10, w: 10, h: 99999 }, VP)
    const w = s.windows[0]
    expect(w.w).toBe(S.MIN_W)
    expect(w.h).toBe(VP.h)
    expect(w.x).toBe(-(S.MIN_W - 48))
    expect(w.y).toBe(10)
  })

  test('없는 창에 대한 move/resize/minimize/close는 상태를 그대로 반환한다', () => {
    const s = openSeveral()
    expect(S.moveWindow(s, 'ghost', 0, 0, VP)).toBe(s)
    expect(S.resizeWindow(s, 'ghost', { x: 0, y: 0, w: 400, h: 300 }, VP)).toBe(s)
    expect(S.minimizeWindow(s, 'ghost')).toBe(s)
    expect(S.closeWindow(s, 'ghost')).toBe(s)
  })
})

describe('parse — 깨진 입력 복구 (throw 금지)', () => {
  test('잘못된 JSON이면 빈 상태를 반환한다', () => {
    expect(S.parse('{이건 아님', VP)).toEqual(S.emptyState())
    expect(S.parse('', VP)).toEqual(S.emptyState())
    expect(S.parse('null', VP)).toEqual(S.emptyState())
  })

  test('지원하지 않는 version(3)이면 빈 상태를 반환한다 (1·2는 마이그레이션 허용)', () => {
    const json = JSON.stringify({
      version: 3,
      windows: [{ id: 'memo', module: 'memo', x: 0, y: 0, w: 880, h: 620, z: 1, minimized: false }],
      activeId: 'memo',
      zCounter: 1,
    })
    expect(S.parse(json, VP)).toEqual(S.emptyState())
    // 구버전(1) 저장은 버려지지 않고 읽힌다
    const v1 = JSON.stringify({
      version: 1,
      windows: [{ id: 'memo', module: 'memo', x: 0, y: 0, w: 880, defH: 620, h: 620, z: 1, minimized: false }],
      activeId: 'memo',
      zCounter: 1,
    })
    expect(S.parse(v1, VP).windows).toHaveLength(1)
  })

  test('windows가 배열이 아니면 빈 배열로 취급한다', () => {
    const json = JSON.stringify({ version: 1, windows: '깨짐', activeId: 'memo', zCounter: 5 })
    const s = S.parse(json, VP)
    expect(s.windows).toEqual([])
    expect(s.activeId).toBeNull()
  })

  test('쓰레기 항목이 섞여 있어도 유효한 항목만 부분 복구된다', () => {
    const json = JSON.stringify({
      version: 1,
      windows: [
        { id: 'memo', module: 'memo', x: 40, y: 32, w: 880, h: 620, z: 3, minimized: false },
        { id: 'x', module: 'unknown-module', x: 0, y: 0, w: 400, h: 300, z: 9, minimized: false },
        { id: 'todo', module: 'todo', x: '숫자아님', y: 0, w: 640, h: 560, z: 4, minimized: false },
        null,
        42,
        { module: 'chat', x: 10, y: 10, w: 720, h: 620, z: 2, minimized: true },
      ],
      activeId: 'memo',
      zCounter: 3,
    })
    const s = S.parse(json, VP)
    expect(s.windows.map((w: any) => w.module)).toEqual(['memo', 'chat'])
    expect(s.activeId).toBe('memo')
    // 버려진 항목의 z(9)는 zCounter 보정에 영향을 주지 않고, 유효 최대 z(3) 이상을 유지한다
    expect(s.zCounter).toBe(3)
  })

  test('중복 module은 첫 항목만 유지된다', () => {
    const json = JSON.stringify({
      version: 1,
      windows: [
        { module: 'memo', x: 11, y: 12, w: 880, h: 620, z: 1, minimized: false },
        { module: 'memo', x: 99, y: 99, w: 400, h: 300, z: 2, minimized: false },
      ],
      activeId: 'memo',
      zCounter: 2,
    })
    const s = S.parse(json, VP)
    expect(s.windows).toHaveLength(1)
    expect(s.windows[0].x).toBe(11)
    expect(s.windows[0].y).toBe(12)
  })

  test('복원 시 모든 항목에 clamp가 다시 적용된다 (저장 후 뷰포트가 줄어든 경우)', () => {
    const json = JSON.stringify({
      version: 1,
      windows: [{ module: 'memo', x: 2000, y: 1500, w: 880, h: 620, z: 1, minimized: false }],
      activeId: 'memo',
      zCounter: 1,
    })
    const s = S.parse(json, { w: 1024, h: 700 })
    const w = s.windows[0]
    expect(w.x).toBe(1024 - 48)
    expect(w.y).toBe(700 - 48)
    expect(1024 - w.x).toBeGreaterThanOrEqual(48)
    expect(700 - w.y).toBeGreaterThanOrEqual(48)
  })

  test('zCounter가 최대 z보다 작으면 보정되고, activeId가 없는 창을 가리키면 재계산된다', () => {
    const json = JSON.stringify({
      version: 1,
      windows: [
        { module: 'memo', x: 0, y: 0, w: 880, h: 620, z: 7, minimized: false },
        { module: 'todo', x: 0, y: 0, w: 640, h: 560, z: 12, minimized: false },
      ],
      activeId: 'schedule', // 존재하지 않는 창
      zCounter: 1,
    })
    const s = S.parse(json, VP)
    expect(s.zCounter).toBe(12)
    expect(s.activeId).toBe('todo') // 비최소화 중 z 최대
  })

  test('어떤 입력에도 throw하지 않는다', () => {
    const inputs: any[] = [undefined, null, 0, {}, [], '[]', '"str"', '{"version":1,"windows":[{}]}']
    for (const input of inputs) {
      expect(() => S.parse(input as any, VP)).not.toThrow()
    }
  })
})

describe('불변성 — 전이 함수는 입력을 변형하지 않는다', () => {
  test('모든 전이를 적용해도 원본 상태가 깊은 수준에서 동일하게 유지된다', () => {
    const s = openSeveral()
    const snapshot = JSON.parse(JSON.stringify(s))
    S.openModule(s, 'chat', VP)
    S.openModule(s, 'memo', VP)
    S.focusWindow(s, 'memo')
    S.minimizeWindow(s, 'todo')
    S.closeWindow(s, 'schedule')
    S.moveWindow(s, 'memo', 0, 0, VP)
    S.resizeWindow(s, 'memo', { x: 1, y: 2, w: 400, h: 300 }, VP)
    expect(s).toEqual(snapshot)
  })

  test('깊은 동결된 입력을 넘겨도 throw하지 않고 새 객체를 반환한다', () => {
    const frozen = deepFreeze(openSeveral())
    let next: any
    expect(() => {
      next = S.focusWindow(frozen, 'memo')
      S.minimizeWindow(frozen, 'memo')
      S.closeWindow(frozen, 'memo')
      S.moveWindow(frozen, 'memo', 5, 5, VP)
      S.openModule(frozen, 'chat', VP)
    }).not.toThrow()
    expect(next).not.toBe(frozen)
    expect(next.windows).not.toBe(frozen.windows)
    expect(next.activeId).toBe('memo')
  })

  test('전이 결과의 창 객체는 원본 창 객체와 다른 참조다 (공유 변형 방지)', () => {
    const s = openSeveral()
    const next = S.focusWindow(s, 'memo')
    const before = s.windows.find((w: any) => w.id === 'memo')
    const after = next.windows.find((w: any) => w.id === 'memo')
    expect(after).not.toBe(before)
    expect(after.z).toBeGreaterThan(before.z)
  })
})
