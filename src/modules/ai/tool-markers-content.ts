// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 (내용 계열): 미디어·검색·메모 마커
import { parseMemoSearchMarkers, parseMemoGetMarkers, parseMemoCreateMarkers, parseMemoUpdateMarkers, parseMemoDeleteMarkers, executeMemoSearch, executeMemoGet, executeMemoCreate, executeMemoUpdate, executeMemoDelete } from '../../services/memo-tools'
import { processSearchMarker } from '../../services/memo-response'
import { normalizeSearchMarkers } from '../../lib/search-marker'
import { sanitizeToolOutput, sandboxToolOutput, wrapToolOutputForModel } from '../../lib/context-sandbox'
import type { ToolMarkerContext } from './tool-marker-context'
import { externalWebSearch } from './web-search'

// [IMG:]/[GITHUB:]/[SEARCH:] 마커 처리
export async function processMediaSearchMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, images, searchReplacementSources } = ctx
  let text = ctx.text
  // [IMG: prompt] → 이미지 수집 (프론트에서 렌더링)
  text = text.replace(/\[IMG:\s*([^\]]+)\]/gi, (m: string, prompt: string) => {
    const p = prompt.trim()
    if (p) {
      images.push({
        url: `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?nologo=true`,
        prompt: p,
      })
    }
    return '' // 마커 제거 (이미지는 별도 필드로 전달)
  })

  // [GITHUB: query] → GitHub 검색 결과로 치환
  const ghMatches = [...text.matchAll(/\[GITHUB:\s*([^\]]+)\]/gi)]
  for (const match of ghMatches) {
    const query = match[1].trim()
    try {
      const res = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`,
        { headers: { 'User-Agent': 'MyHub', 'Accept': 'application/vnd.github.v3+json' }, signal: AbortSignal.timeout(10000) }
      )
      if (res.ok) {
        const data = (await res.json()) as any
        // 외부 제목·설명에 심어진 마커가 후속 파서에서 실행되지 않도록 정제 (URL은 링크 유지)
        const items = (data.items || []).slice(0, 5).map((r: any) =>
          `- [${sanitizeToolOutput(String(r.full_name || ''))}](${r.html_url}) ⭐ ${r.stargazers_count} - ${sanitizeToolOutput(String(r.description || ''))}`
        ).join('\n')
        text = text.replace(match[0], `\n\nGitHub 검색 (${query}):\n${items}\n`)
      } else {
        text = text.replace(match[0], `\n(GitHub 검색 실패: ${query})\n`)
      }
    } catch {
      text = text.replace(match[0], `\n(GitHub 검색 실패: ${query})\n`)
    }
  }

  // 비표준 검색 마커를 표준형 [SEARCH:]로 정규화 (모델이 잘못된 형식 출력 시 대응)
  // 대응: [WEB_SEARCH]{json}[/WEB_SEARCH], [SEARCH]{json}[/SEARCH], [SEARCH]평문[/SEARCH]
  text = normalizeSearchMarkers(text)
  // [SEARCH: query] → 웹검색 결과로 치환 (Tavily → Exa → Serper → DuckDuckGo)
  // sources/text 일치 (2026-10-26 실측: 2차 호출이 sources를 설정한 뒤 여기서
  // 두 번째 [SEARCH:] 마커가 텍스트를 갈아엎으면 sources가 오래된 채로 남음 —
  // 실제 삽입한 항목을 모아 마지막에 sources를 재구성한다)
  const searchMatches = [...text.matchAll(/\[SEARCH:\s*([^\]]+)\]/gi)]
  for (const match of searchMatches) {
    const query = match[1].trim()
    // 1. 외부 API 시도 (Tavily → Exa → Serper)
    const extItems = await externalWebSearch(env, query)
    if (extItems.length > 0) {
      // 외부 검색 제목에 심어진 마커가 후속 파서에서 실행되지 않도록 정제 (URL은 링크 유지)
      const items = extItems.map((it) => `- [${sanitizeToolOutput(String(it.title || ''))}](${it.url})`).join('\n')
      text = text.replace(match[0], `\n\n웹검색 (${query}):\n${items}\n`)
      for (const it of extItems) searchReplacementSources.push({ title: it.title || it.url, url: it.url })
      continue
    }
    // 2. DuckDuckGo 폴백
    try {
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(15000),
        }
      )
      if (res.ok) {
        const html = await res.text()
        const items: string[] = []
        const ddgPairs: { title: string; url: string }[] = []
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis
        let sm: RegExpExecArray | null
        while ((sm = re.exec(html)) !== null && items.length < 5) {
          let url = sm[1]
          const uddg = url.match(/[?&]uddg=([^&]+)/)
          if (uddg) {
            try { url = decodeURIComponent(uddg[1]) } catch { /* 무시 */ }
          }
          if (url.startsWith('//')) url = 'https:' + url
          // 외부 제목에 심어진 마커가 후속 파서에서 실행되지 않도록 정제
          const title = sanitizeToolOutput(sm[2].replace(/<[^>]+>/g, '').trim())
          if (title && url.startsWith('http')) {
            items.push(`- [${title}](${url})`)
            ddgPairs.push({ title, url })
          }
        }
        if (items.length > 0) {
          text = text.replace(match[0], `\n\n웹검색 (${query}):\n${items.join('\n')}\n`)
          searchReplacementSources.push(...ddgPairs)
        } else {
          text = text.replace(match[0], `\n(웹검색 결과 없음: ${query})\n`)
        }
      } else {
        text = text.replace(match[0], `\n(웹검색 실패: ${query})\n`)
      }
    } catch {
      text = text.replace(match[0], `\n(웹검색 실패: ${query})\n`)
    }
  }


  text = text.trim()
  ctx.text = text
}

// [MEMO_*] 마커 처리
export async function processMemoMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, approvalRequests, authorizeTool, sanitizeInserted } = ctx
  let text = ctx.text
  // [MEMO_SEARCH] → 메모 검색 (잠금 정책 준수)
  // 보안: 메모 마커가 있으면 SEARCH 차단 (유출 방지)
  const hasMemoMarkers = /\[MEMO_(SEARCH|GET)\]/i.test(text)
  if (hasMemoMarkers) {
    text = text.replace(/\[SEARCH:\s*([^\]]+)\]/gi, '\n(보안: 메모 조회와 웹검색을 동시에 사용할 수 없습니다)\n')
  }

  const memoSearchMarkers = parseMemoSearchMarkers(text)
  for (const marker of memoSearchMarkers) {
    // 실행기 수준 권한 검사
    const gate = await authorizeTool('MEMO_SEARCH', { query: marker.query }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeMemoSearch(env, marker.query)
    // AI-004: 공유 응답 조립 함수 사용 (테스트와 프로덕션 일치)
    text = processSearchMarker(text, marker, res, sanitizeInserted)
  }

  // [MEMO_CREATE] → 메모 생성
  const memoCreateMarkers = parseMemoCreateMarkers(text)
  for (const marker of memoCreateMarkers) {
    const gate = await authorizeTool('MEMO_CREATE', { text: marker.text }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeMemoCreate(env, marker.text)
    if (res.success) {
      text = text.replace(marker.full, `메모를 생성했어 (id: ${res.data.id}).`)
    } else {
      text = text.replace(marker.full, `메모 생성 실패: ${res.error}`)
    }
  }

  // 파싱되지 않은 [MEMO_CREATE] 마커는 원본 노출 방지 — 실패 안내로 대체
  // (잘못된 JSON·지원하지 않는 형식·개수 제한(2개) 초과)
  text = text.replace(/\[MEMO_CREATE\][\s\S]*?\[\/MEMO_CREATE\]/gi, '메모 생성에 실패했습니다. (형식을 이해하지 못했어요)')

  // [MEMO_UPDATE] → 메모 수정
  const memoUpdateMarkers = parseMemoUpdateMarkers(text)
  for (const marker of memoUpdateMarkers) {
    const gate = await authorizeTool('MEMO_UPDATE', { id: marker.id, text: marker.text }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeMemoUpdate(env, marker.id, marker.text)
    if (res.success) {
      text = text.replace(marker.full, `메모 ${marker.id}를 수정했어.`)
    } else {
      text = text.replace(marker.full, `메모 수정 실패: ${res.error}`)
    }
  }

  // [MEMO_DELETE] → 메모 삭제
  const memoDeleteMarkers = parseMemoDeleteMarkers(text)
  for (const marker of memoDeleteMarkers) {
    const gate = await authorizeTool('MEMO_DELETE', { id: marker.id }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeMemoDelete(env, marker.id)
    if (res.success) {
      text = text.replace(marker.full, `메모 ${marker.id}를 삭제했어.`)
    } else {
      text = text.replace(marker.full, `메모 삭제 실패: ${res.error}`)
    }
  }

  const memoGetMarkers = parseMemoGetMarkers(text)
  for (const marker of memoGetMarkers) {
    const gate = await authorizeTool('MEMO_GET', { id: marker.id }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const res = await executeMemoGet(env, marker.id)
    if (res.success && res.data) {
      const m: any = res.data
      text = text.replace(marker.full, `\n\n메모:\n제목: ${sanitizeInserted(m.title)}\n내용:\n${sanitizeInserted(m.content)}\n`)
    } else {
      text = text.replace(marker.full, `\n(메모를 찾을 수 없음)\n`)
    }
  }
  ctx.text = text
}
