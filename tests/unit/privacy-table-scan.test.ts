/// <reference types="jest" />
/**
 * src/services/privacy-table-scan.ts — 표 형태 텍스트의 비밀번호 열 스캔.
 *
 * 핵심 성질: ① 헤더 셀이 비밀번호 라벨(정확 일치 또는 허용 접미사)인
 * 열의 값만 PASSWORD(level 3) 구간으로 잡는다 ② 구간 좌표는 원본
 * 텍스트 기준이라 text.slice(start, end)가 비밀값 전체와 정확히
 * 같아야 한다 — 마스킹이 이 구간을 토큰으로 치환하므로 한 글자라도
 * 짧으면 비밀이 새어 나간다 ③ 플레이스홀더·라벨 자체·4자 미만 값은
 * 비밀이 아니다 ④ 표는 빈 줄이나 구분자 변경에서 끝나고, 그 뒤 행은
 * 이 표의 데이터로 취급하지 않는다.
 * 카나리아: 접미사 검사를 지우면 '비밀번호 확인' 테스트가, 따옴표
 * 처리를 지우면 따옴표 셀 테스트가, 플레이스홀더 집합을 비우면
 * 플레이스홀더 테스트가 실패한다.
 */
import { scanTablePasswords } from '../../src/services/privacy-table-scan'

const slices = (text: string) => scanTablePasswords(text).map((s) => text.slice(s.start, s.end))

describe('라벨 판정', () => {
  test('탭 구분 + 정확 라벨', () => {
    const text = '이름\t비밀번호\n김철수\tsecret123'
    const out = scanTablePasswords(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'PASSWORD', level: 3 })
    expect(text.slice(out[0].start, out[0].end)).toBe('secret123')
  })

  test('허용 접미사가 붙은 라벨(비밀번호 확인·password confirm)도 열로 인정한다', () => {
    expect(slices('이름,비밀번호 확인\n김철수,secret123')).toEqual(['secret123'])
    expect(slices('name,password confirm\nkim,secret123')).toEqual(['secret123'])
  })

  test('허용 목록에 없는 접미사(비밀번호 힌트)는 라벨이 아니다', () => {
    expect(scanTablePasswords('이름,비밀번호 힌트\n김철수,secret123')).toEqual([])
  })

  test('짧은 라벨(pw)은 정확 일치만 인정하고 접미사 확장은 하지 않는다', () => {
    expect(slices('이름,pw\n김철수,secret123')).toEqual(['secret123'])
    expect(scanTablePasswords('이름,pw 값\n김철수,secret123')).toEqual([])
  })

  test('대소문자를 무시한다 (PASSWORD 헤더)', () => {
    expect(slices('ID,PASSWORD\nkim,secret123')).toEqual(['secret123'])
  })

  test('빈 헤더 셀은 라벨이 아니지만 나머지 열은 정상 판정한다', () => {
    expect(slices(',비밀번호\n김철수,secret123')).toEqual(['secret123'])
  })

  test('셀이 1개뿐인 헤더는 표로 보지 않는다', () => {
    expect(scanTablePasswords('비밀번호  \nsecret123  ')).toEqual([])
  })
})

describe('구분자와 셀 분리', () => {
  test('공백 2개 이상 구분 표', () => {
    expect(slices('이름  비밀번호\n김철수  secret123')).toEqual(['secret123'])
  })

  test('따옴표 셀 안의 구분자는 셀을 나누지 않는다', () => {
    const text = '이름,비밀번호\n"김,철수",secret123'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('따옴표 안쪽 공백은 값에서 벗겨내고 좌표는 내용만 가리킨다', () => {
    const text = '이름,비밀번호\n김철수," secret123 "'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('따옴표 이스케이프("")가 든 값은 원본 구간 전체가 잡혀야 한다', () => {
    // 마스킹은 [start, end)를 치환한다 — 끝이 한 글자라도 짧으면 비밀의
    // 마지막 글자가 평문으로 남는다.
    const text = '이름,비밀번호\n김철수,"sec""ret123"'
    const out = scanTablePasswords(text)
    expect(out).toHaveLength(1)
    expect(text.slice(out[0].start, out[0].end)).toBe('sec""ret123')
  })

  test('CRLF 줄바꿈에서도 값에 \\r가 붙지 않는다', () => {
    const text = '이름,비밀번호\r\n김철수,secret123\r\n'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('값 안의 공백은(쉼표 구분) 값의 일부다', () => {
    expect(slices('이름,비밀번호\n김철수,my secret123')).toEqual(['my secret123'])
  })
})

describe('값 판정 — 잡지 않는 것', () => {
  test('4자 미만은 잡지 않고, 정확히 4자부터 잡는다', () => {
    expect(scanTablePasswords('이름,비밀번호\n김철수,ab1')).toEqual([])
    expect(slices('이름,비밀번호\n김철수,ab12')).toEqual(['ab12'])
  })

  test('플레이스홀더는 길이가 충분해도 비밀이 아니다', () => {
    expect(scanTablePasswords('이름,비밀번호\n김철수,해당없음')).toEqual([])
    expect(scanTablePasswords('이름,비밀번호\n김철수,null')).toEqual([])
    expect(scanTablePasswords('이름,비밀번호\n김철수,None')).toEqual([])
  })

  test('값 자리에 라벨 자체가 적혀 있으면 비밀이 아니다', () => {
    expect(scanTablePasswords('이름,비밀번호\n김철수,비밀번호')).toEqual([])
  })

  test('비밀번호 열보다 셀이 적은 행은 건너뛴다 (오류 없이)', () => {
    expect(scanTablePasswords('비고,이름,비밀번호\nx,김철수')).toEqual([])
  })
})

describe('표의 범위', () => {
  test('빈 줄에서 표가 끝나고 뒤 행은 데이터로 보지 않는다', () => {
    const text = '이름,비밀번호\n김철수,secret123\n\n이영희,hidden999'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('구분자가 바뀌는 줄에서 표가 끝난다', () => {
    const text = '이름\t비밀번호\n김철수\tsecret123\n이영희,hidden999'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('헤더만 있고 데이터 행이 없으면 빈 결과', () => {
    expect(scanTablePasswords('이름,비밀번호')).toEqual([])
  })

  test('앞에 일반 문장이 있어도 그 다음 표를 찾는다 (쉼표가 든 문장은 오탐하지 않는다)', () => {
    const text = '오늘의 명언, 그냥 문장\n이름,비밀번호\n김철수,secret123'
    expect(slices(text)).toEqual(['secret123'])
  })

  test('비밀번호 열이 여러 개면 모든 열·모든 행을 잡는다', () => {
    const text = '아이디,비밀번호,password\nkim,secret123,hidden999\nlee,abcd,x'
    expect(slices(text)).toEqual(['secret123', 'hidden999', 'abcd'])
  })
})
