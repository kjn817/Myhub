// Pure-JS unified diff (LCS 기반) — 의존성 없음, Workers 번들용
// bolt.diy의 diff 뷰 + ACP의 diff first-class 개념을 참고

/**
 * 두 텍스트의 unified diff를 생성한다.
 * @param oldText 변경 전
 * @param newText 변경 후
 * @param filePath 표시용 파일 경로
 * @param context hunk당 전후 문맥 줄 수
 * @returns unified diff 문자열. 변경 없으면 ''.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  filePath = 'file',
  context = 3,
): string {
  if (oldText === newText) return ''

  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length

  // 크기 제한: 셀이 너무 많으면 diff 생략 (메모리 보호)
  if (n * m > 4_000_000) {
    return `--- ${filePath}\n+++ ${filePath}\n@@ 파일이 너무 커서 diff 생략 (old ${n}줄 → new ${m}줄) @@\n`
  }

  // LCS DP 테이블
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  // 역추적 → op 리스트
  type Op = { t: ' ' | '-' | '+'; line: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ t: '-', line: a[i] })
      i++
    } else {
      ops.push({ t: '+', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] })
  while (j < m) ops.push({ t: '+', line: b[j++] })

  // 변경점 주변 hunk 범위 계산
  const ranges: [number, number][] = []
  ops.forEach((op, k) => {
    if (op.t === ' ') return
    const s = Math.max(0, k - context)
    const e = Math.min(ops.length, k + context + 1)
    const last = ranges[ranges.length - 1]
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e)
    } else {
      ranges.push([s, e])
    }
  })
  if (ranges.length === 0) return ''

  let out = `--- ${filePath}\n+++ ${filePath}\n`
  for (const [s, e] of ranges) {
    // hunk 시작점의 old/new 줄번호 계산
    let oldLine = 0
    let newLine = 0
    for (let k = 0; k < s; k++) {
      if (ops[k].t !== '+') oldLine++
      if (ops[k].t !== '-') newLine++
    }
    let hOld = 0
    let hNew = 0
    const body: string[] = []
    for (let k = s; k < e; k++) {
      const op = ops[k]
      body.push(op.t + op.line)
      if (op.t !== '+') hOld++
      if (op.t !== '-') hNew++
    }
    out += `@@ -${oldLine + 1},${hOld} +${newLine + 1},${hNew} @@\n`
    out += body.join('\n') + '\n'
  }
  return out
}
