# 음성 인터페이스 (h트랙, 2026-10-26)

Workers AI 음성 파이프라인으로 최소 동작하는 음성 입력·출력.

## 확인한 모델·한도 (Cloudflare Workers AI Pricing 문서, 2026-10-26)

| 항목 | 값 |
| --- | --- |
| STT | `@cf/openai/whisper-large-v3-turbo` — 46.63 neurons/오디오 분, 입력은 오디오 바이트 배열 `{ audio: [...] }`, 출력 `{ text, word_count, words }` |
| TTS | `@cf/myshell-ai/melotts` — 18.63 neurons/오디오 분, 입력 `{ prompt, lang }` (lang: `en`/`kr` 등), 출력은 오디오 바이트 |
| 무료 티어 | 계정당 **10,000 neurons/일 공유**, 00:00 UTC 리셋. Free 플랜은 초과 시 실패 (Paid는 $0.011/1,000 neurons 과금) |
| 피한 모델 | `@cf/deepgram/aura-1` (1,363.64 neurons/1k자 — MeloTTS의 약 70배), `@cf/deepgram/nova-3` (472.73 neurons/분) |

### 비용 추산

- 60초 음성 왕복(STT 60초 + TTS 약 30초 분량) ≈ 46.6 + 9.3 ≈ **56 neurons**
- 기본 일일 상한 100회 ≈ 5,600 neurons → Clef 라우터·요약 등 다른 Workers AI 용도와 합쳐도 무료 티어 안에 들어간다.
- 상한은 `ai_settings`의 `voice.daily_limit` > 환경변수 `VOICE_DAILY_LIMIT` > 기본값 100 순으로 결정한다.

## API

| 엔드포인트 | 설명 |
| --- | --- |
| `POST /api/voice/transcribe` | multipart `{ audio: File, durationSeconds? }` → `{ ok, text, seconds, neuronsEstimate }`. 오디오 저장 없음 |
| `POST /api/voice/synthesize` | JSON `{ text }` → 오디오 바이트 (`Content-Type`은 매직 바이트로 판별: wav/mp3/mp4/ogg). `Cache-Control: no-store` |
| `GET /api/voice/status` | 모델·한도·오늘 사용량 |

공통 안전장치: 녹음 **60초·2MB 상한** (초과 413), TTS 입력 **5,000자 상한** (모델에는 1,000자로 잘라 전달), 일일 요청 상한 초과 시 **429 + 텍스트 입력 폴백 안내**, AI 바인딩 없음 시 **503 + 텍스트 폴백 안내**.

## 파일

- `src/services/voice.ts` — STT/TTS 호출, 검증, 한도 계산, KV 일일 카운터 (D1 쓰기 없음)
- `src/modules/voice/routes.ts` — Hono 라우트 (`/api/voice`로 마운트, 인증은 전역 미들웨어)
- `public/js/voice.js` — MediaRecorder 녹음·전송, 말풍선 재생 버튼
- `public/chat.html` — 마이크 버튼(입력 바·랜딩) + `voice.js` 로드
- `public/css/chat.css` — `.icon-btn`, `.recording`, `.speak-btn`

## iOS PWA 제약 (실기기 미검증 — NOT TESTED)

- MediaRecorder는 iOS Safari 14.5+ / PWA(standalone)에서 동작하나, **mimeType은 `audio/mp4`(AAC)만** 지원한다. `audio/webm`을 강제하면 생성 자체가 실패하므로 `voice.js`는 `isTypeSupported`로 mp4 → webm/opus → 기본값 순으로 폴백한다.
- 녹음 시작과 오디오 재생은 반드시 **사용자 제스처(버튼 탭)** 안에서만 가능하다. 자동 재생·자동 녹음 없음.
- 무음 스위치가 켜져 있으면 `<audio>` 재생이 들리지 않을 수 있다 (기기 설정, 코드로 우회 불가).
- 기존 iOS 랜딩 키보드 문제와는 별개. 음성 버튼은 키보드와 무관하게 동작한다.

## 개인정보 경계

- 음성 오디오는 어디에도 저장하지 않는다 (D1·KV·R2·로그 전부 제외). 메모리에만 두고 호출 후 버린다.
- 전사 텍스트는 사용자가 직접 입력한 텍스트와 동일하게 취급해 기존 `/api/ai/chat` 경로로 전달한다. 이 모듈은 메모를 읽지도 쓰지도 않으므로 잠긴 메모를 우회하는 경로가 없다.
- TTS 입력은 비서 응답 텍스트만 받는다. 잠긴 메모 내용은 애초에 비서 응답에 포함되지 않는다.

## 참고 (코드 복사 없음)

- Leon의 음성 우선 설계(STT/TTS 클라우드·오프라인 선택), Agent Zero의 로컬 Whisper는 개념만 참고. MyHub는 Workers AI 바인딩 하나로 통일하고, 로컬 Whisper·외부 STT 서비스 도입은 하지 않는다.
- 실시간 스트리밍 STT(Deepgram nova-3 WebSocket, 836.36 neurons/분)는 비용 때문에 제외. 필요하면 별도 트랙에서 결정할 것.

## 다음 트랙에 넘길 사항 (결정 필요)

1. **실기기 검증**: iOS PWA에서 실제 녹음(mp4)→전사→재생 종단 테스트가 아직 없다. 사용자 실기기 확인 필요.
2. **MeloTTS 출력 포맷**: 문서상 반환이 오디오 바이트이나, 실제 Content-Type(wav vs mp3)은 라이브 호출로만 확정된다. 코드는 매직 바이트로 판별해 두 포맷 모두 재생되게 했다.
3. **Whisper 한국어 정확도**: 실측 전. 전사 품질이 낮으면 `word_count`·신뢰도 기반 재시도 안내를 추가할 것.
4. **자동 전송 여부**: 전사 후 바로 전송한다(핸즈프리 전제). 오인식 시 사용자가 다시 말해야 한다. 확인 후 전송으로 바꿀지는 사용 피드백으로 결정.
