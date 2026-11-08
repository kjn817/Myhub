// P0-2: AI 스튜디오 전용 HTML 생성 (채팅 파이프라인 우회)
// - 검색, 도구, 후속 호출 없음
// - D1 원자적 예약으로 1요청=1호출 보장

import type { Env } from '../../types'
import { MODELS } from '../../services/ai'
import { inspectEgress, canUseRelay } from '../../services/privacy-gateway'
import { redactForLog } from '../../services/privacy-engine'
import { getLegacyMarkerTools, resolveRequestSensitivity } from '../../ai/legacy-privacy-guard'

export async function generateArtifactHtml(
  env: Env,
  jobId: number,
  leaseToken: string,
  workflowInstanceId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<{ html: string; model: string; keySlot: number }> {
  // P0-3: 필수 컨텍스트 검증
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error('INVALID_JOB_CONTEXT')
  }
  if (!leaseToken || !workflowInstanceId) {
    throw new Error('MISSING_EXECUTION_CONTEXT')
  }
  signal?.throwIfAborted()
  // Privacy 게이트: 프롬프트가 게이트웨이를 통과해야 프로바이더로 나간다
  let gateSensitivity
  try {
    gateSensitivity = resolveRequestSensitivity('builder', userPrompt, getLegacyMarkerTools('builder')).sensitivity
  } catch {
    gateSensitivity = 'personal'
  }
  const gate = inspectEgress({
    origin: 'artifact-generate-html',
    policy: { sensitivity: gateSensitivity },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })
  if (gate.action === 'block') {
    console.warn('privacy_gateway_blocked', { origin: 'artifact-generate-html', reasons: gate.reasons.join(',') })
    throw new Error('PRIVACY_BLOCKED')
  }
  if (gate.action === 'tokenized') {
    systemPrompt = gate.messages[0].content
    userPrompt = gate.messages[1].content
  }
  const gateLevel = gate.level
  // 전체 작업 타임아웃: 4분 (Workflow 5분보다 짧게)
  // AbortSignal.any 대신 수동으로 처리 (호환성)
  const overallTimeout = AbortSignal.timeout(240000)
  // 부모 시그널이 이미 abort되었으면 즉시 실패
  signal?.throwIfAborted()
  overallTimeout.throwIfAborted()
  // fetch에는 overallTimeout 사용 (4분)
  const combinedSignal = overallTimeout
  const db = env.DB

  // 1. 모델 결정 (D1 설정)
  const setting = await db.prepare(
    "SELECT value FROM ai_settings WHERE key='model.code'"
  ).first<{ value: string }>()
  const modelId = setting?.value || 'gemini-3.5-flash-lite'

  // P0-4: 모델 정책 검증 (공통 레지스트리)
  // 2026-10-15: 3개 프로바이더 지원 (gemini/groq/nvidia, workers-ai 제외)
  // 2026-10-30: NVIDIA 운영 제외 — 허용 목록에서 제거. NVIDIA 모델은
  // 레지스트리에서도 전부 비활성이라 위 status 검사로도 이미 거부된다
  // (이중 차단). 아래 nvidia 호출 분기는 보존 코드로 남겨 두되 도달 불가.
  const modelDef = MODELS.find(m => m.id === modelId)
  if (!modelDef) {
    throw new Error(`MODEL_NOT_REGISTERED: ${modelId}`)
  }
  if (modelDef.status !== 'active') {
    throw new Error(`MODEL_NOT_ACTIVE: ${modelId}`)
  }
  const allowedProviders = ['gemini', 'groq'];
  if (!allowedProviders.includes(modelDef.provider)) {
    throw new Error(`MODEL_PROVIDER_MISMATCH: ${modelId} is ${modelDef.provider}, expected one of ${allowedProviders.join('/')}`)
  }
  const provider = modelDef.provider;

  // 2. D1 원자적 예약 (필수)
  const attemptId = crypto.randomUUID()
  let reserved = null
  {
    // 단순화: UNIQUE(job_id)로 중복 방지, 상태 검사는 생략
    reserved = await db.prepare(`
    INSERT OR IGNORE INTO job_provider_attempts (
      provider_attempt_id, job_id, workflow_instance_id,
      attempt_no, provider, model, key_slot, state
    )
    VALUES (?, ?, ?, 1, ?, ?, 0, 'reserved')
    RETURNING provider_attempt_id
  `).bind(
    attemptId, jobId, workflowInstanceId, provider, modelId
  ).first<{ provider_attempt_id: string }>()
  }

  if (!reserved) {
    throw new Error('PROVIDER_ATTEMPT_ALREADY_RESERVED')
  }

  // 3. dispatching으로 상태 변경 (필수, 결과 검증)
  const dispatchResult = await db.prepare(`
    UPDATE job_provider_attempts
    SET state='dispatching', dispatch_started_at=CURRENT_TIMESTAMP
    WHERE provider_attempt_id=? AND state='reserved'
  `).bind(attemptId).run()
  if ((dispatchResult.meta?.changes ?? 0) === 0) {
    throw new Error('PROVIDER_DISPATCH_NOT_ALLOWED')
  }
  signal?.throwIfAborted()

  // 4. 프로바이더별 API 키 로드 (2026-10-15: 멀티 프로바이더 지원)
  const keys: string[] = []
  const keyPrefix = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'groq' ? 'GROQ_API_KEY' : 'NVIDIA_API_KEY';
  for (let i = 1; i <= 4; i++) {
    const k = (env as any)[`${keyPrefix}_${i}`] as string | undefined
    if (k) keys.push(k)
  }
  if (keys.length === 0) throw new Error(`NO_${provider.toUpperCase()}_KEYS`)

  const startTime = Date.now()
  // 키 로테이션은 재시도 루프 안에서 수행

  // 503 용량 오류 시 대기 후 재시도 (최대 10회, 5초 간격 + 지터)
  let res: Response | null = null
  let successKeySlot = 0
  const maxRetries = 12
  // 키별 상태 추적 (0=정상, 1=일시적 실패, 2=영구 실패)
  const keyHealth = new Array(keys.length).fill(0)
  const keyFailCount = new Array(keys.length).fill(0)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // 5초 고정 + ±30% 지터 (커뮤니티 권장)
      const baseMs = 5000
      const jitter = baseMs * 0.3 * (Math.random() * 2 - 1)
      const waitMs = Math.round(baseMs + jitter)
      await new Promise(r => setTimeout(r, waitMs))
    }
    // 키 로테이션: 건강한 키만 사용 (영구 실패 키 제외)
    let keySlot = attempt % keys.length
    let skipCount = 0
    while (keyHealth[keySlot] === 2 && skipCount < keys.length) {
      keySlot = (keySlot + 1) % keys.length
      skipCount++
    }
    // 모든 키가 영구 실패면 처음부터 다시 시도
    if (skipCount >= keys.length) {
      keySlot = attempt % keys.length
    }
    const key = keys[keySlot]
    console.log(`[generate-html] Attempt ${attempt}/${maxRetries}, keySlot=${keySlot}, health=${keyHealth[keySlot]}, model=${modelId}, provider=${provider}`)
    // 부모 시그널 체크 (Workflow 취소 등)
    signal?.throwIfAborted()
    try {
      const fetchStart = Date.now()
      // 2026-10-15: 멀티 프로바이더 지원 (gemini/groq/nvidia)
      let apiUrl: string;
      let requestBody: any;
      let requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      
      if (provider === 'gemini') {
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
        requestBody = {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
        };
      } else if (provider === 'groq') {
        apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
        requestHeaders['Authorization'] = `Bearer ${key}`;
        requestBody = {
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 8192,
        };
      } else { // nvidia
        apiUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
        requestHeaders['Authorization'] = `Bearer ${key}`;
        requestBody = {
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        };
      }
      
      const tryRes = await fetch(apiUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      })
      const headersMs = Date.now() - fetchStart
      // P1: 헤더 수신 시간 기록 (로깅용)
      if (attempt === 0) {
        console.log(`[generate-html] headers received in ${headersMs}ms, status=${tryRes.status}`)
      }
      // 400은 키 자체 문제 또는 요청 오류 (영구 실패)
      // 단, Gemini 지역 제한이면 릴레이 시도
      if (tryRes.status === 400 || tryRes.status === 403) {
        if (provider === 'gemini' && tryRes.status === 400) {
          const errText = await tryRes.text().catch(() => '');
          if (errText.includes('User location is not supported') && canUseRelay(gateLevel) && env.GEMINI_RELAY_URL && env.GEMINI_RELAY_SECRET) {
            console.log(`[generate-html] Gemini location blocked, trying relay...`);
            try {
              const relayRes = await fetch(env.GEMINI_RELAY_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Relay-Key': env.GEMINI_RELAY_SECRET,
                },
                body: JSON.stringify({
                  model: modelId,
                  key: key,
                  payload: requestBody,
                }),
                signal: combinedSignal,
              });
              const relayData = await relayRes.json() as any;
              if (!relayData.ok) {
                console.warn(`[generate-html] gemini_relay_failed kind=relay_error relayStatus=${relayData?.status ?? 'null'} httpStatus=${relayRes.status}`);
              }
              if (relayData.ok) {
                // 릴레이 응답을 tryRes 형태로 변환
                const gdata = typeof relayData.body === 'string' ? JSON.parse(relayData.body) : relayData.body;
                res = new Response(JSON.stringify(gdata), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                });
                successKeySlot = keySlot;
                keyHealth[keySlot] = 0;
                keyFailCount[keySlot] = 0;
                break;
              }
            } catch (relayErr) {
              console.warn(`[generate-html] gemini_relay_failed kind=transport error=${String(relayErr).slice(0, 120)}`);
            }
          }
        }
        keyHealth[keySlot] = 2
        console.log(`[generate-html] Key slot ${keySlot} marked as permanently failed (${tryRes.status})`)
        // 다음 키로 계속 시도
        continue
      }
      // 429는 rate limit - 재시도
      if (tryRes.status === 429) {
        console.log(`[generate-html] Key slot ${keySlot} rate limited (429), trying next key`)
        continue
      }
      // 500번대 오류가 아니면 성공, 루프 탈출
      if (tryRes.status < 500) {
        res = tryRes
        successKeySlot = keySlot
        // 성공 시 키 상태 복구
        keyHealth[keySlot] = 0
        keyFailCount[keySlot] = 0
        break
      }
      // 500번대 실패 시 키 실패 카운트 증가
      keyFailCount[keySlot]++
      if (keyFailCount[keySlot] >= 3) {
        keyHealth[keySlot] = 1  // 일시적 실패 (3회 연속)
        console.log(`[generate-html] Key slot ${keySlot} marked as temporarily unhealthy`)
      }
      // 500번대 오류는 재시도
      continue
    } catch (e) {
      // Abort나 네트워크 오류는 재시도 안 함
      throw e
    }
  }

  try {
    if (!res) throw new Error(`${provider} fetch failed after retries`)
    const elapsed = Date.now() - startTime

    // P0: HTTP 200이어도 본문에 에러가 있을 수 있음 (커뮤니티 발견)
    // 본문을 먼저 읽어서 검사
    const rawBody = await res.text().catch(() => '')
    const bodyLower = rawBody.toLowerCase()
    const hasErrorBody = bodyLower.includes('resourceexhausted') || 
                         (bodyLower.includes('"error"') && bodyLower.includes('worker local total request limit'))
    
    if (!res.ok || hasErrorBody) {
      const errBody = rawBody
      // failed로 기록
      await db.prepare(`
        UPDATE job_provider_attempts
        SET state='failed', finished_at=CURRENT_TIMESTAMP,
            http_status=?, elapsed_ms=?, error_detail=?
        WHERE provider_attempt_id=?
      `).bind(res.status, elapsed, redactForLog(errBody), attemptId).run()
      throw new Error(`${provider} ${res.status}: ${redactForLog(errBody, 200)}`)
    }

    let data: any
    try {
      data = JSON.parse(rawBody)
    } catch {
      throw new Error('gemini invalid JSON response')
    }
    // 디버깅: 응답 구조 로깅 (프로바이더별 형식)
    let rawContent: string;
    let finishReason: string | undefined;
    
    if (provider === 'gemini') {
      console.log(`[generate-html] Response structure: candidates=${data.candidates?.length}, usage=${JSON.stringify(data.usageMetadata)}`)
      const candidate = data.candidates?.[0]
      if (candidate) {
        console.log(`[generate-html] Candidate[0]: finishReason=${candidate.finishReason}, has_content=${!!candidate.content}`)
      }
      finishReason = candidate?.finishReason
      // Gemini 형식: candidates[0].content.parts[].text
      const parts = candidate?.content?.parts || []
      rawContent = parts.map((p: any) => p.text || '').join('')
    } else {
      // Groq/NVIDIA (OpenAI 형식): choices[0].message.content
      console.log(`[generate-html] Response structure: choices=${data.choices?.length}, usage=${JSON.stringify(data.usage)}`)
      const choice = data.choices?.[0]
      finishReason = choice?.finish_reason
      rawContent = choice?.message?.content || choice?.text || ''
    }
    
    if (typeof rawContent !== 'string') rawContent = String(rawContent || '')
    rawContent = gate.vault.desanitize(rawContent)
    
    // 디버깅: 응답 구조 로깅
    console.log(`[generate-html] Model=${modelId}, provider=${provider}, finish=${finishReason}, contentLen=${rawContent.length}`)
    
    const html = rawContent
    // 빈 응답이면 즉시 실패 (디버그 정보 포함)
    if (!html) {
      throw new Error(`EMPTY_RESPONSE: model=${modelId}, provider=${provider}, finish=${finishReason}`)
    }
    // 출력이 잘렸으면 경고
    if (finishReason === 'MAX_TOKENS' || finishReason === 'length') {
      console.log(`[generate-html] WARNING: output truncated (finishReason=${finishReason})`)
    }

    // completed로 기록 (실제 사용된 키 슬롯 포함)
    const usedKeySlot = successKeySlot
    await db.prepare(`
      UPDATE job_provider_attempts
      SET state='completed', finished_at=CURRENT_TIMESTAMP,
          http_status=200, elapsed_ms=?, key_slot=?
      WHERE provider_attempt_id=?
    `).bind(elapsed, usedKeySlot, attemptId).run()

    return { html, model: modelId, keySlot: usedKeySlot }
  } catch (e) {
    // 타임아웃 등 예외 시 failed로 기록
    const elapsed = Date.now() - startTime
    await db.prepare(`
      UPDATE job_provider_attempts
      SET state='failed', finished_at=CURRENT_TIMESTAMP,
          elapsed_ms=?, error_detail=?
      WHERE provider_attempt_id=? AND state='dispatching'
    `).bind(elapsed, redactForLog(String((e as Error).message)), attemptId).run().catch(() => {
    })
    throw e
  }
}
