// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// build-kordoc.mjs 재구성 (2단계: 진입점)
// 원본 계약 (2026-11-03 기록):
//  - 1차(cbd45de2): parse 전용 번들, readText는 성공 시 { markdown } 반환
//  - 2차(a2ae7512): entry에 markdownToHwpx 추가, 산출 가드에 존재 검사
// 클라이언트 계약: office-assistant가 동적 import로 markdownToHwpx 사용,
// finder-format-hwp가 readText(buf, fileName)를 사용.
import { parse, markdownToHwpx } from 'kordoc';

export async function readText(input, _fileName) {
  const result = await parse(input, { ocr: false });
  if (!result || result.success !== true) {
    const reason = result && result.error ? String(result.error) : 'unknown';
    throw new Error(`kordoc parse failed: ${reason}`);
  }
  return { markdown: result.markdown };
}

export { markdownToHwpx, parse };
export default { readText, markdownToHwpx, parse };
