// MyHub 기본 도구들 - 레지스트리에 등록
// 새 도구 추가 시 registerBuiltinTools() 안에 registerTool() 추가

import { registerTool } from './tools'

export function registerBuiltinTools() {
// 지오코딩
registerTool(
  {
    name: 'geocode',
    description: '장소 이름을 위도/경도로 변환',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '장소 이름 (예: 서울)' },
      },
      required: ['query'],
    },
  },
  async (args) => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.query)}&count=1&language=ko&format=json`
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const d = (await r.json()) as any
    if (!d.results?.[0]) return { ok: false, error: 'not found' }
    return {
      ok: true,
      data: {
        name: d.results[0].name,
        latitude: d.results[0].latitude,
        longitude: d.results[0].longitude,
      },
    }
  }
)

// 날씨
registerTool(
  {
    name: 'get_weather',
    description: '현재 날씨 조회',
    parameters: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: '위도' },
        longitude: { type: 'number', description: '경도' },
        location_name: { type: 'string', description: '위치 이름' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  async (args) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,weather_code,relative_humidity_2m&timezone=auto`
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const d = (await r.json()) as any
    return {
      ok: true,
      data: {
        location: args.location_name,
        temperature: d.current?.temperature_2m,
        humidity: d.current?.relative_humidity_2m,
        weather_code: d.current?.weather_code,
      },
    }
  }
)

// GitHub 검색
registerTool(
  {
    name: 'github_search',
    description: 'GitHub에서 저장소/코드/이슈 검색',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어' },
        type: { type: 'string', description: 'repositories, code, issues (기본: repositories)' },
      },
      required: ['query'],
    },
  },
  async (args) => {
    const t = args.type || 'repositories'
    const url = `https://api.github.com/search/${t}?q=${encodeURIComponent(args.query)}&per_page=5`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'MyHub', Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    })
    const d = (await r.json()) as any
    return {
      ok: true,
      data: {
        total: d.total_count,
        items: (d.items || []).slice(0, 5).map((item: any) => ({
          name: item.full_name || item.name,
          url: item.html_url,
          description: item.description?.slice(0, 200),
          stars: item.stargazers_count,
        })),
      },
    }
  }
)

// 이미지 생성
registerTool(
  {
    name: 'generate_image',
    description: '텍스트로 이미지 생성',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '이미지 설명 (영어)' },
      },
      required: ['prompt'],
    },
  },
  async (args) => {
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(args.prompt)}?nologo=true`
    return { ok: true, data: { image_url: imageUrl, prompt: args.prompt } }
  }
)

// 웹 검색
registerTool(
  {
    name: 'web_search',
    description: 'MUST USE for news, current events, weather, or ANY real-time information. NEVER answer from training data for current info. Returns real search results with titles, URLs, snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어' },
        count: { type: 'number', description: '결과 수 (기본 5)' },
      },
      required: ['query'],
    },
  },
  async (args) => {
    const count = Math.min(args.count || 5, 10)
    try {
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
      )
      if (!res.ok) return { ok: false, error: '검색 실패' }
      const html = await res.text()
      const results: any[] = []
      const regex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>(.*?)</g
      let m
      while ((m = regex.exec(html)) !== null && results.length < count) {
        results.push({
          title: m[2].replace(/<[^>]+>/g, ''),
          url: m[1],
          snippet: m[3].replace(/<[^>]+>/g, ''),
        })
      }
      return { ok: true, data: { query: args.query, results } }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 100) }
    }
  }
)
}
