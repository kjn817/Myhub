/**
 * HTML 메타 태그 추출 공용 헬퍼 (B-L9, 5-7).
 *
 * article-date.ts와 news-enrich.ts가 각각 들고 있던 getAttr·metaContent를
 * 한 곳으로 모은다. getAttr는 바이트 동일, metaContent는 content 후처리만
 * 다르다(article-date는 원본 그대로, news-enrich는 엔티티 디코드 + trim) —
 * transform 인자로 그 차이를 보존한다.
 */

/** 태그 문자열에서 속성 값을 뽑는다 (따옴표 필수, 대소문자 무시). */
export function getAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? m[1] : undefined
}

/**
 * <meta property|name="..."> 에서 content를 찾는다.
 * transform이 있으면 content에 적용한 값을 반환한다.
 */
export function metaContent(
  html: string,
  attr: string,
  value: string,
  transform?: (content: string) => string,
): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) || []
  const want = value.toLowerCase()
  for (const tag of tags) {
    const v = getAttr(tag, attr)
    if (v && v.toLowerCase() === want) {
      const content = getAttr(tag, 'content')
      if (content) return transform ? transform(content) : content
    }
  }
  return undefined
}
