/// <reference types="jest" />
/**
 * 보안 회귀 (GPT P0-③, 트랙 3): git 추적 파일에 잠긴 메모 평문이 없어야 한다.
 *
 * 배경: backups/prod-20261013-predeploy/ (사고 당시 스냅샷)에는 잠긴 메모
 * 4건이 평문으로 들어 있었고, 그 디렉터리가 git에 추적되고 있었다.
 * 저장소가 공개 원격을 갖고 있으므로, 전체 히스토리가 push되는 순간
 * 평문이 공개될 수 있는 잠재 누출 경로였다.
 *
 * 이 테스트의 성질:
 * - 추적 중인 backups/ 파일이 0개여야 한다 (파일 자체는 로컬에 남아 있어도 됨).
 * - 추적 중인 모든 *.json을 파싱해 is_locked가 켜진 객체의 text가
 *   ENC:/ENC2: 접두가 아니면 위반으로 센다.
 * - 탐지기 자체는 합성 픽스처로 검증한다 (평문 잠김=위반 검출, 암호문=통과).
 *   탐지기가 깨지면 픽스처 단언이 실패한다.
 */
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '../..')

export function findPlaintextLockedMemos(node: unknown, out: string[] = [], trail = '$'): string[] {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findPlaintextLockedMemos(v, out, `${trail}[${i}]`))
  } else if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    const locked = rec.is_locked === 1 || rec.is_locked === true
    if (locked && typeof rec.text === 'string') {
      if (!rec.text.startsWith('ENC:') && !rec.text.startsWith('ENC2:')) {
        out.push(trail)
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      findPlaintextLockedMemos(v, out, `${trail}.${k}`)
    }
  }
  return out
}

function gitLsFiles(pattern?: string): string[] {
  const out = execSync(`git ls-files ${pattern ?? ''}`, { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

describe('탐지기 카나리아 (합성 픽스처)', () => {
  test('평문 잠긴 메모는 검출하고, 암호문 잠긴 메모·미잠금 평문은 통과시킨다', () => {
    const fixture = [
      { id: 1, is_locked: 1, text: 'synthetic-plaintext-secret' },
      { id: 2, is_locked: 1, text: 'ENC:AAAA' },
      { id: 3, is_locked: 1, text: 'ENC2:BBBB' },
      { id: 4, is_locked: 0, text: 'ordinary memo' },
      { nested: { id: 5, is_locked: true, text: 'another-plaintext' } },
    ]
    const hits = findPlaintextLockedMemos(fixture)
    expect(hits).toHaveLength(2)
  })
})

describe('git 추적 파일 전수 스캔', () => {
  test('backups/ 아래 추적 파일이 없다', () => {
    expect(gitLsFiles('backups/')).toEqual([])
  })

  test('.gitignore가 backups/를 포함한다 (재추적 방지)', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(ignore.split('\n').map((l) => l.trim())).toContain('backups/')
  })

  test('추적 중인 JSON 어디에도 평문 잠긴 메모가 없다', () => {
    const trackedJson = gitLsFiles().filter((f) => f.endsWith('.json'))
    const violations: string[] = []
    for (const rel of trackedJson) {
      const full = path.join(REPO_ROOT, rel)
      let parsed: unknown
      try {
        parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch {
        continue // JSON이 아닌 .json(주석 포함 등)은 파싱 대상에서 제외
      }
      for (const hit of findPlaintextLockedMemos(parsed)) {
        violations.push(`${rel}:${hit}`)
      }
    }
    expect(violations).toEqual([])
  })
})
