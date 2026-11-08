# GPT 자문 요청: NVIDIA "Worker local total request limit reached (99/32)" 명확화

## 웹/커뮤니티 조사 결과

### 1. "Worker local"의 의미
**동시 작업자(Worker Concurrency) 한도**임. 분당 40회(RPM)와는 별개의 제한.

- "NVIDIA NIM | Worker concurrency (no headers) | SSE `ResourceExhausted` / `Worker.*limit` mid-stream" [1]
- "NVIDIA NIM returns mid-stream SSE error chunks when upstream capacity is hit" [1]

### 2. "(99/32)"의 의미
**현재 요청 수 / 사용 가능한 워커 수**. 예시:
- `(74/32)` - 74개 요청이 32개 워커에 몰림 [1]
- `(16/16)` - 16개 요청이 16개 워커에 몰림 [2]
- `(1843/16)` - 1843개 요청이 16개 워커에 몰림 [3]
- `(99/32)` - 99개 요청이 32개 워커에 몰림 (우리 케이스)

즉, NVIDIA 서버가 일시적으로 과부하 상태.

### 3. 해결 방법: 재시도 (키 교체 아님)
- "transient pool saturation, key is healthy" [4]
- "retried after 0.8s pause" [4]
- "Nvidia 系免费模型不能因一次 200+error 就永久除名，只能标「间歇过载、重试可用」" [3]
  (NVIDIA 무료 모델은 한 번의 200+error로 영구 제외하면 안 됨. "간헐적 과부하, 재시도 가능"으로 표시해야 함)

**키는 정상이므로 교체하지 말고, 0.8~30초 쉬었다가 재시도해야 함.**

### 4. NVIDIA NIM 무료 티어 한도 (확인됨)
- 분당 40회 (RPM) per key [5][6]
- 일일/월간 토큰 한도 없음 ("no daily token cap") [6]
- 예전 1,000 크레딧 제도는 폐지됨 [7]

## Muse의 오수정 내용

"503 ResourceExhausted도 429처럼 60초 쿨다운"으로 수정했으나, 이는 잘못됨.
- 503 Worker local은 일시적 과부하라 키를 쉬게 하면 안 됨
- 올바른 처리: 쿨다운 없이 0.8초 대기 후 재시도
- 위 내용으로 원복 완료 (커밋 4620798)

## 질문

1. MyHub의 재시도 로직이 503 Worker local을 올바르게 처리하는가?
   (현재: 즉시 실패 → 사용자에게 "AI 타임아웃" 표시)
2. 0.8초 대기 후 재시도하는 로직을 어디에 추가해야 하는가?
   (job-processor? ai.ts의 callNVIDIA?)
3. 99/32 같은 극단적 과부하 시에는 얼마나 대기해야 하는가?

## 참고 자료
[1] https://github.com/syntheticautonomicmind/clio/blob/HEAD/AGENTS.md
[2] https://github.com/shelra/shelracode/blob/HEAD/research/lanes/06-free-inference.md
[3] https://github.com/amidaidai/ami-hermes/blob/HEAD/hermes/skills/devops/model-routing-validation/SKILL.md
[4] https://github.com/autcir/openvidia
[5] https://www.mejba.me/blog/free-claude-code-proxy-nvidia-openrouter-ollama
[6] https://freellm.net/providers/nvidia-nim
[7] https://github.com/peter123023/awesome-free-llm-api/commit/71da1015bc77e46fc7a828d1eae6da8fdf9d6253
