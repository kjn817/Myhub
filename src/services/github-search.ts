export interface GithubSearchEnv {
  GITHUB_TOKEN?: string
}

export type GithubSearchResult =
  | { ok: true; items: any[]; authenticated: boolean }
  | { ok: false; reason: 'transport' }
  | { ok: false; reason: 'rate_limited'; httpStatus: number }
  | { ok: false; reason: 'http_error'; httpStatus: number }

function githubRequestHeaders(env: GithubSearchEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'MyHub',
    Accept: 'application/vnd.github.v3+json',
  }
  const token = env?.GITHUB_TOKEN
  if (typeof token === 'string' && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }
  return headers
}

function buildGithubRepoSearchUrl(query: string, perPage: number = 5): string {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`
}

function isGithubRateLimited(httpStatus: number, headers: Headers): boolean {
  if (httpStatus !== 403 && httpStatus !== 429) return false
  const remaining = typeof headers?.get === 'function' ? headers.get('x-ratelimit-remaining') : undefined
  return remaining === '0' || remaining === null
}

export async function searchGithubRepos(
  env: GithubSearchEnv,
  query: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubSearchResult> {
  const headers = githubRequestHeaders(env)
  const authenticated = 'Authorization' in headers
  let res: Response
  try {
    res = await fetchFn(buildGithubRepoSearchUrl(query), {
      headers,
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    console.error('github_search_failed', { kind: 'transport', authenticated })
    return { ok: false, reason: 'transport' }
  }
  if (!res.ok) {
    if (isGithubRateLimited(res.status, res.headers)) {
      console.error('github_rate_limited', {
        httpStatus: res.status,
        authenticated,
        reset: res.headers.get('x-ratelimit-reset'),
      })
      return { ok: false, reason: 'rate_limited', httpStatus: res.status }
    }
    console.error('github_search_failed', { kind: 'http', httpStatus: res.status, authenticated })
    return { ok: false, reason: 'http_error', httpStatus: res.status }
  }
  const data: any = await res.json()
  return { ok: true, items: Array.isArray(data?.items) ? data.items : [], authenticated }
}
