# MyHub

필요할 때마다 기능을 하나씩 붙이는 내 웹 서비스. Cloudflare 무료 티어 기반.

- **백엔드**: Cloudflare Workers (Hono)
- **DB**: Cloudflare D1 (SQLite) — 메모/메타데이터
- **파일 저장소**: Cloudflare KV (오브젝트 스토리지) — 파일 본체는 KV에, DB에는 정보만
  (무료 1GB, 파일당 25MB, 카드 불필요. 나중에 카드 등록하면 R2로 교체 가능 — `FILES` 바인딩만 갈아끼우면 됨)
- **검색**: SQLite FTS5 전문검색 + LIKE 폴백 (한국어 대응)
- **프론트**: Workers Static Assets (`public/`)

## 구조

```
myhub/
├── src/
│   ├── index.ts          # 앱 진입점, 모듈 자동 장착
│   ├── modules.ts        # 모듈 등록소 (여기에 한 줄씩 추가)
│   ├── types.ts          # Env 타입
│   └── modules/
│       └── memo/         # 예제 모듈: 메모
│           └── routes.ts # /api/memo/* API
├── public/
│   ├── index.html        # 대시보드 (모듈 목록)
│   └── memo.html         # 메모 UI
├── migrations/
│   └── 0001_init.sql     # D1 스키마
└── wrangler.toml
```

## 새 기능(모듈) 추가하는 법

1. `src/modules/memo/` 폴더를 복사해서 `src/modules/기능명/` 만들기 → `routes.ts` 수정
2. `src/modules.ts` 배열에 한 줄 등록:
   ```ts
   { id: 'todo', name: '할 일', desc: '...', path: '/todo.html', app: todoApp },
   ```
3. `public/기능명.html` UI 만들기
4. 필요하면 `migrations/`에 SQL 추가 후 `npm run db:migrate`

## 로컬 실행

```bash
npm install
npm run dev
```

## 배포 (최초 1회)

1. Cloudflare 계정 생성 (https://dash.cloudflare.com/sign-up, 이메일만, 카드 불필요)
2. `npx wrangler login` (브라우저에서 승인)
3. D1 생성: `npx wrangler d1 create myhub-db`
   → 출력된 `database_id`를 `wrangler.toml`에 입력
4. 스키마 적용: `npm run db:migrate`
5. 배포: `npm run deploy`
   → `https://myhub.<계정>.workers.dev` 주소 발급됨

## 비공개로 쓰기

- Cloudflare Access로 workers.dev 주소에 로그인 제한 걸기 (무료 50명까지)
- 나중에 회원가입 기능이 필요하면 Supabase Auth / Clerk 붙이거나 직접 구현
