/// <reference types="jest" />
/**
 * 메모 표면 — 운영 원본(a2702ca4) 표기 계약 (2026-11-11 A/B 대조 복원)
 *
 * 배경: 데스크톱 계열 A/B 대조(~/workspace/surface-ab-20261111/
 * catalog-desktop.md)에서 메모 창의 발산 2건이 확정됐다.
 * - 상단 메뉴 두 번째 라벨이 전사본(prod-pull memo-bundle.js의
 *   window.MyHubMenus 정의)·운영 화면 모두 '보기'인데 트리만
 *   '보여줄'로 돼 있었다.
 * - 검색 input placeholder가 운영 표기 '메모 · 파일명 검색 ( / )'
 *   (공백 1개)인데 트리 memo.html에 공백 2개로 들어가 있었다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - pane.js 소스와 빌드 산출물 memo-bundle.js 양쪽에서 보기 메뉴
 *   라벨이 '보기'이고 '보여줄' 라벨이 없어야 한다 (번들 드리프트 포함).
 * - memo.html의 #q placeholder가 운영 표기와 글자 단위로 같아야 한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('메모 상단 메뉴 라벨 (원본: 보기)', () => {
  const pane = read('public/js/memo/pane.js')
  const bundle = read('public/js/memo-bundle.js')

  it('소스 pane.js의 보기 메뉴 라벨은 보여줄이 아니라 보기다', () => {
    expect(pane).toContain("label: '보기'")
    expect(pane).not.toContain("label: '보여줄'")
  })

  it('빌드된 memo-bundle.js도 같은 라벨을 싣는다 (소스-번들 동기)', () => {
    expect(bundle).toContain("label: '보기'")
    expect(bundle).not.toContain("label: '보여줄'")
  })
})

describe('메모 검색 placeholder (원본 표기)', () => {
  const html = read('public/memo.html')

  it('공백 1개짜리 운영 표기와 정확히 일치한다', () => {
    expect(html).toContain('placeholder="메모 · 파일명 검색 ( / )"')
    expect(html).not.toContain('메모 · 파일명 검색  (')
  })
})
