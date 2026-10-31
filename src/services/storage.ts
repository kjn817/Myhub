// MyHub 공용 스토리지 서비스
// 파일 본체는 Cloudinary(무료 25GB, 카드 불필요)에, 메타데이터만 D1에 저장 → DB가 커지지 않음.
// 모든 모듈은 이 서비스를 통해서만 파일을 올리고 지운다.
// 다른 스토리지로 갈아끼우려면 아래 cloudinary* 함수만 교체하면 됨.
import type { Env } from '../types'

export interface CloudUploadResult {
  public_id: string
  secure_url: string
  resource_type: string
  bytes: number
}

// Cloudinary 서명: 파라미터를 알파벳 순으로 이어붙이고 api_secret을 더해 SHA-1
async function cloudSign(params: Record<string, string>, apiSecret: string): Promise<string> {
  const str =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + apiSecret
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 파일 업로드 (서명 방식 — api_secret은 Worker secret에만 존재, 코드/클라이언트에 노출 안 됨)
export async function storageUpload(env: Env, file: File, folder = 'myhub'): Promise<CloudUploadResult> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const params = { folder, timestamp }
  const signature = await cloudSign(params, env.CLOUDINARY_API_SECRET)
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('api_key', env.CLOUDINARY_API_KEY)
  form.append('timestamp', timestamp)
  form.append('folder', folder)
  form.append('signature', signature)
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
    { method: 'POST', body: form }
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Cloudinary upload failed: ${res.status} ${t.slice(0, 200)}`)
  }
  return (await res.json()) as CloudUploadResult
}

// 파일 삭제 (Cloudinary에 없어도 D1 정리는 계속 진행)
// 반환값으로 성공 여부를 알린다 (2026-10-30, D-1): 이 함수는 throw하지
// 않으므로(메모 삭제 등 정리 경로가 스토리지 실패로 중단되면 안 됨),
// 교체 전 객체를 파괴하는 호출자(첨부 잠금/해제)는 false를 받으면
// console.error + 응답 warning으로 표면화해야 한다 — 침묵 금지.
// 성공 판정은 HTTP 200이 아니라 응답 본문 result === 'ok' 일 때만 한다:
// resource_type 불일치 등은 200 + {"result":"not found"} 로 오며, 이를
// 성공으로 오인하면 잠금 직후에도 구 URL이 (CDN 캐시로) 평문을 서빙한다.
// invalidate=true 로 CDN 캐시까지 무효화한다 (서명 대상에 포함).
export async function storageDestroy(
  env: Env,
  public_id: string,
  resource_type: string
): Promise<boolean> {
  try {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const params = { invalidate: 'true', public_id, timestamp }
    const signature = await cloudSign(params, env.CLOUDINARY_API_SECRET)
    const form = new FormData()
    form.append('public_id', public_id)
    form.append('api_key', env.CLOUDINARY_API_KEY)
    form.append('timestamp', timestamp)
    form.append('invalidate', 'true')
    form.append('signature', signature)
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resource_type}/destroy`,
      { method: 'POST', body: form }
    )
    if (!res.ok) {
      console.error('storageDestroy failed:', { public_id, resource_type, status: res.status })
      return false
    }
    const body = (await res.json().catch(() => null)) as { result?: string } | null
    if (body?.result !== 'ok') {
      console.error('storageDestroy not ok:', {
        public_id,
        resource_type,
        result: body?.result ?? null,
      })
      return false
    }
    return true
  } catch (e) {
    console.error('storageDestroy failed:', { public_id, resource_type, e })
    return false
  }
}

// 이미지 썸네일 URL (원본은 그대로 두고 너비 600px로 축소한 CDN 버전)
export function thumbUrl(cloudName: string, publicId: string): string {
  return `https://res.cloudinary.com/${cloudName}/image/upload/w_600,c_limit,q_auto,f_auto/${publicId}`
}
