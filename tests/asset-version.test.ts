/// <reference types="jest" />
/**
 * 에셋 버전 부착기 회귀 테스트 (2026-11-01 사고의 카나리아)
 *
 * 사고: deploy_full.py의 ?v= 재작성이 고정 파일 목록이라, 목록에 없던
 * 데스크톱 에셋(css/desktop.css·js/desktop/*)이 배포 후에도 브라우저의
 * 구버전 캐시로 실행됐다. 수정: scripts/asset-version.cjs의
 * createVersioner가 scripts/static-assets.json 집합 전체를 기준으로
 * ?v=를 붙인다 — 새 에셋은 매니페스트 등록만으로 자동 포함돼야 한다.
 *
 * 이 테스트가 검증하는 성질:
 * - 구 고정 목록에 없던 에셋에도 ?v=가 붙는다 (사고 재발 방지).
 * - 매니페스트 밖 경로는 건드리지 않는다.
 * - ?v= 이중 부착이 없다.
 * - 매니페스트에 파일을 추가하면 코드 변경 없이 부착 대상이 된다.
 * - deploy_full.py NODE_GEN이 실제로 createVersioner를 쓴다.
 */
import * as fs from 'fs'
import * as path from 'path'

// plain node require용 .cjs 모듈이다 (package.json "type": "module" 때문).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVersioner } = require('../scripts/asset-version.cjs')

const ROOT = path.resolve(__dirname, '..')
const ASSET_LIST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'),
)
const VER = 'testv123'

describe('createVersioner — 매니페스트 집합 전체 기준', () => {
  const ver = createVersioner(ASSET_LIST, VER)

  test('구 고정 목록에 없던 데스크톱 에셋에도 ?v=가 붙는다 (사고 카나리아)', () => {
    expect(ver('<link href="/css/desktop.css">')).toBe(
      '<link href="/css/desktop.css?v=testv123">',
    )
    expect(ver('<script src="/js/desktop/windows.js"></script>')).toBe(
      '<script src="/js/desktop/windows.js?v=testv123"></script>',
    )
    expect(ver('<script src="/js/desktop/state.js"></script>')).toBe(
      '<script src="/js/desktop/state.js?v=testv123"></script>',
    )
    expect(ver('<script src="/js/desktop/main.js"></script>')).toBe(
      '<script src="/js/desktop/main.js?v=testv123"></script>',
    )
  })

  test('공용 에셋(nav.js·shell.css·login 계열)에도 붙는다', () => {
    expect(ver('<script src="/nav.js"></script>')).toContain('/nav.js?v=testv123')
    expect(ver('<link href="/shell.css">')).toContain('/shell.css?v=testv123')
    expect(ver('<link href="/css/login.css">')).toContain('/css/login.css?v=testv123')
    expect(ver('<script src="/js/google-connect.js"></script>')).toContain(
      '/js/google-connect.js?v=testv123',
    )
    expect(ver('<script src="/js/trace.js"></script>')).toContain('/js/trace.js?v=testv123')
  })

  test('url() 참조와 따옴표 없는 참조에도 붙는다', () => {
    expect(ver('background: url(/wallpaper.webp)')).toBe(
      'background: url(/wallpaper.webp?v=testv123)',
    )
    expect(ver("background: url('/wallpaper.webp')")).toBe(
      "background: url('/wallpaper.webp?v=testv123')",
    )
  })

  test('매니페스트에 없는 경로에는 붙이지 않는다', () => {
    const html = '<script src="/js/not-registered.js"></script>'
    expect(ver(html)).toBe(html)
    const ext = '<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>'
    expect(ver(ext)).toBe(ext)
  })

  test('이미 ?v=가 붙은 참조는 이중으로 붙이지 않는다', () => {
    const html = '<script src="/js/chat.js?v=abc12345"></script>'
    expect(ver(html)).toBe(html)
  })

  test('매니페스트에 새 파일을 추가하면 코드 변경 없이 자동 포함된다', () => {
    const extended = {
      ...ASSET_LIST,
      files: [...ASSET_LIST.files, '/js/brand-new.js'],
    }
    const ver2 = createVersioner(extended, VER)
    expect(ver2('<script src="/js/brand-new.js"></script>')).toBe(
      '<script src="/js/brand-new.js?v=testv123"></script>',
    )
    // 기존 버전 함수에는 포함되지 않는다 (집합이 기준이라는 대조)
    expect(ver('<script src="/js/brand-new.js"></script>')).toBe(
      '<script src="/js/brand-new.js"></script>',
    )
  })
})

describe('deploy_full.py NODE_GEN 배선', () => {
  const deploy = fs.readFileSync(path.join(ROOT, 'deploy_full.py'), 'utf-8')

  test('NODE_GEN이 asset-version.cjs의 createVersioner를 require해 쓴다', () => {
    expect(deploy).toContain('scripts/asset-version.cjs')
    expect(deploy).toContain('createVersioner')
  })

  test('옛 고정 목록 정규식이 남아 있지 않다', () => {
    expect(deploy).not.toContain('splash\\/[\\w-]+\\.png')
    expect(deploy).not.toContain('avatars\\/[\\w-]+\\.webp')
  })
})
