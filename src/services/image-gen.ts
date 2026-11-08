export const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai/prompt/'
export const IMAGE_PROVIDER_STATE_KEY = 'image.pollinations.v1'

export interface ImageProviderState {
  status: string
  httpStatus: number | null
  checkedAt: string | null
  detail: string
}

export const UNKNOWN_IMAGE_STATE: ImageProviderState = {
  status: 'unknown',
  httpStatus: null,
  checkedAt: null,
  detail: 'probe_not_run',
}

export type ImageEmissionDecision =
  | { emit: true }
  | { emit: false; reason: string; message: string }

export function buildPollinationsImageUrl(prompt: string): string {
  return `${POLLINATIONS_IMAGE_BASE}${encodeURIComponent(prompt)}?nologo=true`
}

export function logImageUrlIssued(prompt: string, surface: string): void {
  console.log('image_url_issued_unverified', {
    provider: 'pollinations',
    surface,
    promptLength: typeof prompt === 'string' ? prompt.length : 0,
  })
}

export async function getImageProviderState(env: { DB: D1Database }): Promise<ImageProviderState> {
  try {
    const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?')
      .bind(IMAGE_PROVIDER_STATE_KEY)
      .first<{ value: string }>()
    if (!row?.value) return UNKNOWN_IMAGE_STATE
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed.status !== 'string') return UNKNOWN_IMAGE_STATE
    return parsed as ImageProviderState
  } catch {
    return UNKNOWN_IMAGE_STATE
  }
}

export function decideImageEmission(state: ImageProviderState): ImageEmissionDecision {
  if (state.status === 'paywalled') {
    return {
      emit: false,
      reason: 'paywalled',
      message: '이미지 생성을 할 수 없습니다: 이미지 프로바이더(Pollinations)가 유료 전환(402)으로 확인됐습니다. 대체 프로바이더 연결이 필요합니다.',
    }
  }
  if (state.status === 'error') {
    return {
      emit: false,
      reason: 'provider_error',
      message: `이미지 생성을 할 수 없습니다: 이미지 프로바이더 상태 확인에서 오류가 기록됐습니다 (${state.detail}).`,
    }
  }
  return { emit: true }
}
