export interface Env {
  DB: D1Database
  KV: KVNamespace
  ASSETS: Fetcher // Static Assets 바인딩 (run_worker_first=true 시 Worker에서 서빙)
  AI?: any // Workers AI 바인딩 (deploy_full.py에서 주입)
  CLOUDINARY_CLOUD_NAME: string
  CLOUDINARY_API_KEY: string
  CLOUDINARY_API_SECRET: string
  RESEND_API_KEY: string
  SESSION_SECRET: string
  CF_D1_TOKEN?: string
  APP_NAME: string
  ENVIRONMENT?: string // 'staging' 또는 'production' (기본값: production)
  STAGING_ALLOWED_EMAILS?: string // 스테이징 테스트 이메일 (쉼표 구분)
  // AI 비서 키 풀 (Worker secrets)
  GEMINI_API_KEY_1?: string
  GEMINI_API_KEY_2?: string
  GEMINI_API_KEY_3?: string
  GEMINI_API_KEY_4?: string
  GROQ_API_KEY_1?: string
  GROQ_API_KEY_2?: string
  GROQ_API_KEY_3?: string
  GROQ_API_KEY_4?: string
  GEMINI_RELAY_URL?: string // Deno Deploy 릴레이 URL
  GEMINI_RELAY_SECRET?: string // 릴레이 인증 키
  // Web Push (일정 알림) — VAPID
  VAPID_PRIVATE_KEY?: string // EC P-256 개인키 JWK JSON (사용자가 직접 생성해 secret 등록)
  VAPID_SUBJECT?: string // 예: mailto:kimjn00003@naver.com
  EXA_API_KEY?: string // Exa 웹검색 API 키
  MEMO_ENCRYPTION_KEY?: string // 메모 AES-GCM 암호화 키
}
