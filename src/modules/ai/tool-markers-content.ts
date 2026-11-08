// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 (내용 계열): 미디어·검색·메모·페이지·파일검색 마커
import { parseMemoSearchMarkers, parseMemoGetMarkers, parseMemoCreateMarkers, parseMemoUpdateMarkers, parseMemoDeleteMarkers, executeMemoSearch, executeMemoGet, executeMemoCreate, executeMemoUpdate, executeMemoDelete } from '../../services/memo-tools'
import { processSearchMarker } from '../../services/memo-response'
import { normalizeSearchMarkers } from '../../lib/search-marker'
import { sanitizeToolOutput } from '../../lib/context-sandbox'
import { externalWebSearch } from './web-search'
import { guardSearchQuery } from '../../services/privacy-gateway'
import { readPage } from '../browse/assistant-read'
import { executeFileSearch } from '../drive/search'
import { recordMarkerToolExecution } from '../../services/tool-ledger'
import { getImageProviderState, decideImageEmission, logImageUrlIssued, buildPollinationsImageUrl, UNKNOWN_IMAGE_STATE } from '../../services/image-gen'
import { searchGithubRepos } from '../../services/github-search'
import type { ToolMarkerContext } from './tool-marker-context'

// [IMG:]/[GITHUB:]/[SEARCH:] 마커 처리
export async function processMediaSearchMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, images, searchReplacementSources } = ctx
  let text = ctx.text
  const imgMatches = [...text.matchAll(/\[IMG:\s*([^\]]+)\]/gi)]
  const imgDecision = imgMatches.length > 0 ? decideImageEmission(await getImageProviderState(env).catch(() => UNKNOWN_IMAGE_STATE)) : null
  for (const match of imgMatches) {
    const p = match[1].trim()
    if (!p) {
      text = text.replace(match[0], '')
      continue
    }
    if (imgDecision && !imgDecision.emit) {
      console.error('image_emission_blocked', { reason: imgDecision.reason, surface: 'marker' })
      text = text.replace(match[0], `\n(${imgDecision.message})\n`)
      continue
    }
    logImageUrlIssued(p, 'marker')
    images.push({ url: buildPollinationsImageUrl(p), prompt: p })
    text = text.replace(match[0], '')
  }

  // [GITHUB: query] → GitHub 검색 결과로 치환
  const ghMatches = [...text.matchAll(/\[GITHUB:\s*([^\]]+)\]/gi)]
  for (const match of ghMatches) {
    const query = match[1].trim()
    const res = await searchGithubRepos(env, query)
    if (res.ok) {
      const items = res.items.slice(0, 5).map(
        (r) => `- [${sanitizeToolOutput(String(r.full_name || ''))}](${r.html_url}) ⭐ ${r.stargazers_count} - ${sanitizeToolOutput(String(r.description || ''))}`
      ).join('\n')
      text = text.replace(match[0], `\n\nGitHub 검색 (${query}):\n${items}\n`)
    } else if (res.reason === 'rate_limited') {
      text = text.replace(match[0], `\n(GitHub 검색 실패: ${query} — API 사용량 한도 초과)\n`)
    } else {
      text = text.replace(match[0], `\n(GitHub 검색 실패: ${query})\n`)
    }
  }

  // 비표준 검색 마커를 표준형 [SEARCH:]로 정규화 (모델이 잘못된 형식 출력 시 대응)
  text = normalizeSearchMarkers(text)
  // [SEARCH: query] → 웹검색 결과로 치환
  const searchMatches = [...text.matchAll(/\[SEARCH:\s*([^\]]+)\]/gi)]
  for (const match of searchMatches) {
    const query = match[1].trim()
    const extItems = await externalWebSearch(env, query)
    if (extItems.length > 0) {
      const items = extItems.map((it) => `- [${sanitizeToolOutput(String(it.title || ''))}](${it.url})`).join('\n')
      text = text.replace(match[0], `\n\n웹검색 (${query}):\n${items}\n`)
      for (const it of extItems) searchReplacementSources.push({ title: it.title || it.url, url: it.url })
      continue
    }
    if (guardSearchQuery(query) === null) {
      text = text.replace(match[0], `\n(웹검색 결과 없음: ${query})\n`)
      continue
    }
    // DuckDuckGo 폴백
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
  // 보안: 메모 마커가 있으면 SEARCH/PAGE 차단 (유출 방지)
  const hasMemoMarkers = /\[MEMO_(SEARCH|GET)\]/i.test(text)
  if (hasMemoMarkers) {
    text = text.replace(
      /\[(?:SEARCH|PAGE):\s*([^\]]+)\]|\[PAGE\]\s*([^\]]+?)\s*\[\/PAGE\]/gi,
      '\n(보안: 메모 조회와 웹검색을 동시에 사용할 수 없습니다)\n'
    )
  }

  const memoSearchMarkers = parseMemoSearchMarkers(text)
  for (const marker of memoSearchMarkers) {
    const gate = await authorizeTool('MEMO_SEARCH', { query: marker.query }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await executeMemoSearch(env, marker.query)
    await recordMarkerToolExecution(ctx, {
      toolName: 'memo_search',
      mode: 'read',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { query: marker.query },
      resultData: res.data,
    })
    text = processSearchMarker(text, marker, res, sanitizeInserted)
  }

  const memoCreateMarkers = parseMemoCreateMarkers(text)
  for (const marker of memoCreateMarkers) {
    const gate = await authorizeTool('MEMO_CREATE', { text: marker.text }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await executeMemoCreate(env, marker.text)
    const ledger = await recordMarkerToolExecution(ctx, {
      toolName: 'memo_create',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { text: marker.text },
      resultData: res.data,
    })
    if (res.success && ledger.recorded) {
      text = text.replace(marker.full, `메모를 생성했습니다.`)
    } else if (res.success) {
      text = text.replace(marker.full, `메모 생성을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 메모 목록에서 확인해 주세요.`)
    } else {
      text = text.replace(marker.full, `메모 생성 실패: ${res.error}`)
    }
  }

  // 파싱되지 않은 [MEMO_CREATE] 마커는 원본 노출 방지 — 실패 안내로 대체
  text = text.replace(/\[MEMO_CREATE\][\s\S]*?\[\/MEMO_CREATE\]/gi, '메모 생성에 실패했습니다. (형식을 이해하지 못했습니다)')

  const memoUpdateMarkers = parseMemoUpdateMarkers(text)
  for (const marker of memoUpdateMarkers) {
    const gate = await authorizeTool('MEMO_UPDATE', { id: marker.id, text: marker.text }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await executeMemoUpdate(env, marker.id, marker.text)
    const ledger = await recordMarkerToolExecution(ctx, {
      toolName: 'memo_update',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { id: marker.id, text: marker.text },
      resultData: res.data,
    })
    if (res.success && ledger.recorded) {
      text = text.replace(marker.full, `메모를 수정했습니다.`)
    } else if (res.success) {
      text = text.replace(marker.full, `메모 ${marker.id} 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 메모에서 확인해 주세요.`)
    } else {
      text = text.replace(marker.full, `메모 수정 실패: ${res.error}`)
    }
  }

  const memoDeleteMarkers = parseMemoDeleteMarkers(text)
  for (const marker of memoDeleteMarkers) {
    const gate = await authorizeTool('MEMO_DELETE', { id: marker.id }, marker.full)
    if (!gate.allowed) {
      text = text.replace(marker.full, gate.message)
      if (gate.request) approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await executeMemoDelete(env, marker.id)
    const ledger = await recordMarkerToolExecution(ctx, {
      toolName: 'memo_delete',
      mode: 'write',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { id: marker.id },
      resultData: res.data,
    })
    if (res.success && ledger.recorded) {
      text = text.replace(marker.full, `메모를 삭제했습니다.`)
    } else if (res.success) {
      text = text.replace(marker.full, `메모 ${marker.id} 삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 메모 목록에서 확인해 주세요.`)
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
    const ledgerStartedAt = Date.now()
    const res = await executeMemoGet(env, marker.id)
    await recordMarkerToolExecution(ctx, {
      toolName: 'memo_get',
      mode: 'read',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.error,
      args: { id: marker.id },
      resultData: res.data,
    })
    if (res.success && res.data) {
      const m: any = res.data
      text = text.replace(marker.full, `\n\n메모:\n제목: ${sanitizeInserted(m.title)}\n내용:\n${sanitizeInserted(m.content)}\n`)
    } else {
      text = text.replace(marker.full, `\n(메모를 찾을 수 없음)\n`)
    }
  }
  ctx.text = text
}

export const PAGE_READ_FAILURE: Record<string, string> = {
  invalid_url: '주소 형식이 올바르지 않아 열지 못했습니다',
  blocked_host: '내부 주소는 열 수 없습니다',
  not_configured: '브라우저 도구가 아직 설정되지 않았습니다',
  quota: '오늘의 브라우저 사용 한도를 다 썼습니다',
  upstream: '브라우저 세션을 만들지 못했습니다',
  connect: '브라우저에 연결하지 못했습니다',
  navigate: '페이지를 열지 못했습니다',
  extract: '본문을 읽어내지 못했습니다',
  empty: '본문 텍스트를 찾지 못했습니다',
  timeout: '페이지가 시간 안에 다 뜨지 않았습니다',
}

const MAX_PAGE_READS_PER_RESPONSE = 2
const PAGE_MARKER_RE = /\[PAGE:\s*([^\]]+)\]|\[PAGE\]\s*([^\]]+?)\s*\[\/PAGE\]/gi
const FILE_SEARCH_MARKER_RE = /\[FILE_SEARCH:\s*([^\]]+)\]|\[FILE_SEARCH\]\s*([^\]]+?)\s*\[\/FILE_SEARCH\]/gi
const MAX_FILE_SEARCHES_PER_RESPONSE = 2

// [PAGE:] 마커 처리 — 원격 브라우저로 본문을 읽어 치환
export async function processPageMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, authorizeTool, sanitizeInserted, searchReplacementSources } = ctx
  let text = ctx.text
  const matches = [...text.matchAll(PAGE_MARKER_RE)]
  let used = 0
  for (const match of matches) {
    const url = (match[1] ?? match[2]).trim()
    if (used >= MAX_PAGE_READS_PER_RESPONSE) {
      text = text.replace(match[0], '\n(페이지 읽기는 한 번에 최대 2개까지 가능합니다)\n')
      continue
    }
    used += 1
    const gate = await authorizeTool('PAGE', { url }, match[0])
    if (!gate.allowed) {
      text = text.replace(match[0], gate.message)
      if (gate.request) ctx.approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await readPage(env, url)
    await recordMarkerToolExecution(ctx, {
      toolName: 'page_read',
      mode: 'read',
      startedAt: ledgerStartedAt,
      success: res.ok,
      error: res.ok ? undefined : res.error,
      args: { url },
      resultData: res.ok ? { url: res.url } : undefined,
    })
    if (res.ok) {
      const body = sanitizeInserted(res.text)
      const titleLine = res.title ? `${sanitizeInserted(res.title)}\n` : ''
      text = text.replace(
        match[0],
        `\n\n웹페이지 본문 (${res.url}):\n${titleLine}${body}${res.truncated ? '\n(본문이 길어 앞부분만 가져왔습니다)' : ''}\n`
      )
      searchReplacementSources.push({ title: res.title || res.url, url: res.url })
    } else {
      text = text.replace(match[0], `\n(페이지 읽기 실패: ${url} — ${PAGE_READ_FAILURE[res.error]})\n`)
    }
  }
  ctx.text = text
}

export function drivePathLabel(sanitize: (s: string) => string, path: Array<{ name: string }>): string {
  return ['보관함', ...path.map((s) => sanitize(s.name))].join(' › ')
}

// [FILE_SEARCH:] 마커 처리 — 파인더 전역 검색 (노바 전용 권한은 authorizeTool이 강제)
export async function processFileSearchMarkers(ctx: ToolMarkerContext): Promise<void> {
  const { env, authorizeTool, sanitizeInserted } = ctx
  let text = ctx.text
  const matches = [...text.matchAll(FILE_SEARCH_MARKER_RE)]
  let used = 0
  for (const match of matches) {
    const query = (match[1] ?? match[2]).trim()
    if (used >= MAX_FILE_SEARCHES_PER_RESPONSE) {
      text = text.replace(match[0], '\n(파일 검색은 한 번에 최대 2개까지 가능합니다)\n')
      continue
    }
    used += 1
    const gate = await authorizeTool('FILE_SEARCH', { query }, match[0])
    if (!gate.allowed) {
      text = text.replace(match[0], gate.message)
      if (gate.request) ctx.approvalRequests.push(gate.request)
      continue
    }
    const ledgerStartedAt = Date.now()
    const res = await executeFileSearch(env, query)
    await recordMarkerToolExecution(ctx, {
      toolName: 'file_search',
      mode: 'read',
      startedAt: ledgerStartedAt,
      success: res.success,
      error: res.success ? undefined : 'file_search_failed',
      args: { query },
      resultData: res.success ? { total: res.data.total } : undefined,
    })
    if (!res.success) {
      text = text.replace(match[0], `\n(파일 검색 실패: ${sanitizeInserted(query)})\n`)
      continue
    }
    const { folders, files, total, truncated } = res.data
    if (total === 0) {
      text = text.replace(match[0], `\n(파일 검색 결과 없음: "${sanitizeInserted(query)}")\n`)
      continue
    }
    const lines = [
      ...folders.map(
        (f) => `- [폴더] ${sanitizeInserted(f.name)} — ${drivePathLabel(sanitizeInserted, f.path)}`
      ),
      ...files.map(
        (f) => `- ${sanitizeInserted(f.filename)} — ${drivePathLabel(sanitizeInserted, f.path)}`
      ),
    ]
    const shown = folders.length + files.length
    text = text.replace(
      match[0],
      `\n\n파일 검색 (${sanitizeInserted(query)}): ${total}건${truncated ? ` 중 최근 ${shown}건` : ''}\n${lines.join('\n')}\n`
    )
    if (files.length === 1 && folders.length === 0) {
      const only = files[0]
      ctx.uiActions.push({
        uiAction: 'finder_reveal_file',
        fileId: only.id,
        folderId: only.folder_id,
        path: only.path,
      })
    } else {
      ctx.uiActions.push({ uiAction: 'finder_search', query })
    }
  }
  text = text.replace(/\[(?:\/)?FILE_SEARCH(?::[^\]]*)?\]/gi, '(파일 검색에 실패했습니다)')
  ctx.text = text
}
