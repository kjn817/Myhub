# MyHub 프로바이더별 모델 정리 (2026-10-15)

## Gemini

### Active (3개)
| 모델 ID | 품질 | 비고 |
|---------|------|------|
| gemini-3.5-flash-lite | fast | 1순위, 4키 전부 OK, 루미/노바용 |
| gemini-3.1-flash-lite | fast | 2순위, 4키 전부 OK |
| gemini-2.5-flash | fast | 키1만, Search grounding 전용 |

### Deprecated (4개)
- gemini-3.8-flash, 3.7-flash, 3.6-flash, 3.5-flash (2026-10-13 실측 전멸)

**담당 비서**: 루미 (일상대화), 노바 (코드/AI스튜디오)

---

## Groq

### Active (2개)
| 모델 ID | 품질 | 비고 |
|---------|------|------|
| openai/gpt-oss-120b | high | 캘리용, 현재 작동 중 |
| openai/gpt-oss-20b | fast | 백업용 |

### Deprecated (1개)
- llama-3.3-70b-versatile (2026-08-16 Groq 종료)

**담당 비서**: 캘리 (일정/할일) — 사용자 지시 "Groq는 캘리만"

---

## NVIDIA

### Active (7개) — 2026-10-15 사용자 실측 기준
| 모델 ID | 품질 | 크기 | 비고 |
|---------|------|------|------|
| nvidia/nemotron-3-ultra-550b-a55b | high | 55B active | 최대 크기, 에코용 (요약) |
| nvidia/nemotron-3-super-120b-a12b | high | 12B active |  |
| nvidia/nemotron-3.5-lightning-30b-a3b | balanced | 3B active | 에이전트용 |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning | balanced | 3B active | 추론 특화 |
| meta/muse-glimmer-30b | balanced | 30B | 멀티모달, 도구호출 |
| google/diffusiongemma-26b-a4b-it | fast | 26B | 가장 빠름 (0.47초) |
| openai/gpt-oss-20b | fast | 20B | Groq와 동일 ID, 다른 프로바이더 |

### 실패로 제거 (7개) — 2026-10-15 실측 FAIL
- moonshotai/kimi-k3, poolside/laguna-xs-2.1, deepseek-ai/deepseek-v4.1-flash
- z-ai/glm-5.3, z-ai/glm-5-3, z-ai/glm-5-3-flash, google/gemma-4-31b-it

**담당 비서**: 에코 (기록/요약) — nemotron-3-ultra-550b 사용 예정

---

## Workers AI

### Active (7개)
| 모델 ID | 품질 | 용도 |
|---------|------|------|
| @cf/cloudflare/clef-flash | fast | **라우터** (의도 분류, 9B, 39ms) |
| @cf/cloudflare/clef | high | 라우터 대안 (27B, 209ms) |
| @cf/meta/llama-3.3-70b-instruct-fp8-fast | high | 범용 (쿼터 이슈 있음) |
| @cf/mistralai/mistral-small-3.1-24b-instruct | balanced | 범용 |
| @cf/qwen/qwen3-30b-a3b-fp8 | balanced | 범용 |
| @cf/meta/llama-3.2-1b-instruct | fast | 초경량 |
| @cf/ibm-granite/granite-4.0-h-micro | fast | 초경량 |

**담당**: 
- Clef-flash: 상단 라우터 (4개 비서로 자동 분기)
- 나머지: 현재 미사용 (에코가 NVIDIA로 이동)

---

## 요약

| 프로바이더 | Active 모델 수 | 담당 비서 |
|-----------|---------------|-----------|
| Gemini | 3개 | 루미, 노바 |
| Groq | 2개 | 캘리 |
| NVIDIA | 7개 | 에코 |
| Workers AI | 7개 | 라우터 (Clef-flash) + 예비 |

**총 Active**: 19개 모델
