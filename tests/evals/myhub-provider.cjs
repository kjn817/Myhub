// MyHub /api/ai/chat용 promptfoo 커스텀 프로바이더.
//
// promptfoo에서 참조: file://./myhub-provider.cjs
// 인증: MYHUB_SESSION_COOKIE 환경변수 (PIN 로그인 후 받은 myhub_session 쿠키 값).
//   전체 Cookie 헤더 값 또는 토큰 값만 둘 다 허용한다.
//   이 파일은 라이브 호출을 "수행"만 할 뿐, OTP 발급·로그인을 하지 않는다.
//   쿠키는 run-eval.sh가 환경변수/인자로 받아 이 프로바이더에 전달한다.
//
// 반환 output = 비서 응답 text + "\n\n[SOURCES]\n<url...>" (출처 URL 날짜도
// 어설션이 검사할 수 있게). assertions.cjs가 [SOURCES]까지 통째로 검사한다.

'use strict';

const DEFAULT_BASE_URL = 'https://myhub.myhub-app.workers.dev';

function normalizeCookie(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v.includes('myhub_session=')) return v;
  return `myhub_session=${v}`;
}

class MyHubProvider {
  constructor(options) {
    this.options = options || {};
  }

  id() {
    return 'myhub-api';
  }

  async callApi(prompt, context) {
    const baseUrl = (process.env.MYHUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    const cookie = normalizeCookie(process.env.MYHUB_SESSION_COOKIE || '');
    if (!cookie) {
      return {
        error:
          'MYHUB_SESSION_COOKIE is not set. PIN 로그인 후 myhub_session 쿠키 값을 환경변수로 넘기세요. ' +
          '자세한 방법: tests/evals/README.md',
      };
    }
    const vars = (context && context.vars) || {};
    const personaId = vars.personaId || 'keeper';
    const timeoutMs = Number(process.env.MYHUB_EVAL_TIMEOUT_MS || 120000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          personaId,
          messages: [{ role: 'user', content: String(prompt) }],
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        return { error: `MyHub /api/ai/chat timeout after ${timeoutMs}ms` };
      }
      return { error: `MyHub /api/ai/chat fetch failed: ${e && e.message ? e.message : String(e)}` };
    }
    clearTimeout(timer);

    let data = null;
    try {
      data = await res.json();
    } catch {
      return { error: `MyHub /api/ai/chat returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok || !data || data.ok === false) {
      return {
        error: `MyHub /api/ai/chat HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`,
      };
    }
    const text = data.text || data.response || '';
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const urls = sources.map((s) => (s && s.url ? s.url : '')).filter(Boolean);
    const output =
      urls.length > 0 ? `${text}\n\n[SOURCES]\n${urls.join('\n')}` : text;
    return {
      output,
      metadata: {
        personaId,
        provider: data.provider || null,
        model: data.model || null,
        promptVersion: data.promptVersion || null,
        sourceCount: urls.length,
      },
    };
  }
}

module.exports = MyHubProvider;
