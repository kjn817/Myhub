export interface Env {
  DB: D1Database
  KV: KVNamespace
  ARTIFACT_QUEUE: Queue
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
  DEV_ALLOWED_EMAILS?: string // 로컬 개발 테스트 이메일 (쉼표 구분)
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
  // 워크플로 엔진 이식 경로 (일정 알림 Cron) — 'true'면 handleScheduled가
  // 워크플로 엔진으로 위임. 기본 꺼짐. 운영 활성화는 마이그레이션 0050 적용 후
  // 승인 단계에서 deploy_full.py metadata bindings에 plain_text로 추가할 것
  // (deploy_full.py는 wrangler.toml [vars]를 동기화하지 않음 — 대시보드에서
  // 직접 설정한 값도 다음 배포에서 사라지므로 metadata 경유만 유효).
  WORKFLOW_REMINDER_ENABLED?: string
  VOICE_DAILY_LIMIT?: string // 음성 일일 요청 상한 (기본 100, ai_settings voice.daily_limit이 우선)
  EXA_API_KEY?: string // Exa 웹검색 API 키
  MEMO_ENCRYPTION_KEY?: string // 메모 AES-GCM 암호화 키
  CHANNEL_WEBHOOK_SECRET?: string // 채널 게이트웨이 웹훅 공유 시크릿 (미설정 시 웹훅 비활성화)
  // Google 연동 (Gmail·Calendar) — OAuth 클라이언트 (설계 docs/gmail-calendar-design.md §9-①)
  // 사용자가 Google Cloud 콘솔에서 직접 발급해 Worker secret으로 등록한다.
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // 결정 필요 (§9-②): 'true'면 캘린더 쓰기 scope(calendar.events) 동의 허용. 기본 false.
  GOOGLE_WRITE_ENABLED?: string
}
