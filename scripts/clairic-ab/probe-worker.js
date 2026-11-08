// Clairic A/B probe Worker (SCRATCH — delete after the run).
// No D1, no secrets, no production data. Only runs Workers AI extraction
// on synthetic memos posted to /run. Auth is a throwaway header key
// generated at deploy time (see scripts/clairic-ab/probe_deploy.py);
// the key lives in /tmp only and is never committed.

const FIELDS = {
  person: { type: 'text', instructions: 'Name of a person mentioned in the memo' },
  event_date: { type: 'date', instructions: 'Date of the main event or appointment, ISO format' },
  event_time: { type: 'time', instructions: 'Time of the main event or appointment, 24-hour format' },
  amount: { type: 'number', decimals: 0, instructions: 'Amount of money mentioned, as a plain number' },
  task: { type: 'text', instructions: 'The to-do or task mentioned in the memo' },
  place: { type: 'text', instructions: 'Place or location mentioned in the memo' },
};

const SYSTEM =
  'Extract the requested fields from the memo and return ONLY a JSON object ' +
  'with keys person, event_date, event_time, amount, task, place. ' +
  'Use null for any field not present in the memo. ' +
  'event_date as YYYY-MM-DD, event_time as HH:MM in 24-hour format, ' +
  'amount as a plain number without currency symbols or commas. ' +
  'person/task/place as short strings copied from the memo. ' +
  'Do not add explanations, markdown, or extra keys.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      if (request.headers.get('x-clairic-probe') !== PROBE_KEY) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const { arm, memo, context } = await request.json();
      const t0 = Date.now();
      try {
        if (arm === 'clairic') {
          const r = await env.AI.run('@cf/cloudflare/clairic', {
            model: 'clairic',
            state: `${context}\n${memo.text}`,
            fields: FIELDS,
          });
          return Response.json({
            arm, memo_id: memo.id, lang: memo.lang,
            latency_ms: Date.now() - t0,
            answers: r.answers, usage: r.usage, truncated: r.truncated,
          });
        }
        if (arm === 'llm' || arm === 'llm-fast') {
          const model = arm === 'llm' ? '@cf/zai-org/glm-4.7-flash' : '@cf/meta/llama-3.1-8b-instruct-fp8';
          const r = await env.AI.run(model, {
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: `${context}\nMemo: ${memo.text}` },
            ],
            temperature: 0,
            max_tokens: arm === 'llm' ? 2000 : 400,
          });
          // GLM-4.7-flash returns an OpenAI-compatible chat completion
          // (choices[0].message.content), not {response}. It is a thinking
          // model: most completion tokens are reasoning, not answer text.
          // Llama returns {response}.
          const text = r.response ?? r.choices?.[0]?.message?.content ?? '';
          return Response.json({
            arm, memo_id: memo.id, lang: memo.lang,
            latency_ms: Date.now() - t0,
            raw_response: text, usage: r.usage,
          });
        }
        return Response.json({ error: 'unknown arm' }, { status: 400 });
      } catch (e) {
        return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 502 });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
