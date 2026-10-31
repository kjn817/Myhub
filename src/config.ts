// MyHub 기반 설정 — 하드코딩된 식별자는 여기 하나에만 둔다.
export const CONFIG = {
  cfAccountId: '59e749ed2e9cdb8b0bf70d47227968a1',
  d1DatabaseId: '0dd871c5-3d1c-4cea-bfbe-3e258f477106',
  workerName: 'myhub',
  // Cloudinary Free 플랜 공식 한도 (API가 limit을 반환하지 않을 때 폴백)
  cloudinaryFreeLimitBytes: 25 * 1024 * 1024 * 1024,
  // D1 Free 플랜 한도
  d1FreeLimitBytes: 5 * 1024 * 1024 * 1024,
} as const
