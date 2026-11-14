/**
 * AI 도구 마커 파싱 공용 헬퍼 (B-L4, 5-7).
 *
 * artifact·cron·google·memo·schedule·todo 도구 파일에 흩어져 있던
 * parse*Markers의 동일 구조(정규식 exec 루프 + JSON 파싱 + 검증·매핑 +
 * 턴당 상한)를 한 곳으로 모은다.
 *
 * 보존하는 계약:
 * - 정규식 자체는 건드리지 않는다 — 각 파서가 자신의 정규식을 그대로 넘긴다.
 * - JSON 파싱 실패·매퍼 실패는 무시하고 다음 매치로 간다 (원본의 try/catch와 동일).
 * - 상한 검사는 매 매치마다 수행한다 (푸시 여부와 무관 — 원본과 동일).
 * - map이 null/undefined를 반환하면 건너뛴다 (원본의 `continue`·조건 불충족과 동일).
 * - out을 넘기면 여러 정규식의 결과를 하나의 상한으로 합친다
 *   (artifact·schedule·todo의 다중 마커 함수와 동일).
 */

/**
 * 정규식 매치를 순서대로 매핑한다. JSON을 파싱하지 않는 마커용
 * (예: [CRON_LIST] — 본문이 비어 있다).
 */
export function parseRawMarkers<T>(
  text: string,
  re: RegExp,
  map: (full: string, inner: string) => T | null | undefined,
  max: number,
  out: T[] = [],
): T[] {
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    try {
      const mapped = map(m[0], m[1])
      if (mapped !== null && mapped !== undefined) out.push(mapped)
    } catch {
      // 깨진 본문·매퍼 실패는 무시 (호출자가 남은 마커를 실패 안내로 대체)
    }
    if (out.length >= max) break
  }
  return out
}

/**
 * 정규식 매치의 본문을 JSON으로 파싱한 뒤 매핑한다.
 * JSON 파싱 실패는 무시하고 다음 매치로 간다.
 */
export function parseJsonMarkers<T>(
  text: string,
  re: RegExp,
  map: (data: any, full: string) => T | null | undefined,
  max: number,
  out: T[] = [],
): T[] {
  return parseRawMarkers(
    text,
    re,
    (full, inner) => {
      const data = JSON.parse(inner.trim())
      return map(data, full)
    },
    max,
    out,
  )
}
