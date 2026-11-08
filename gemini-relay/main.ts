// Gemini API 릴레이 (Deno Deploy용)
// Cloudflare Workers의 지역 제한 우회용

Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Key',
      },
    })
  }

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'POST only' }, { status: 405 })
  }

  // 간단한 인증 (무단 사용 방지)
  const relayKey = req.headers.get('X-Relay-Key')
  if (relayKey !== Deno.env.get('RELAY_SECRET')) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const { model, key, payload } = await req.json()

    if (!model || !key || !payload) {
      return Response.json({ ok: false, error: 'missing model/key/payload' }, { status: 400 })
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      }
    )

    const text = await res.text()

    return Response.json(
      { ok: res.ok, status: res.status, body: text.slice(0, 100000) },
      {
        headers: { 'Access-Control-Allow-Origin': '*' },
      }
    )
  } catch (e) {
    return Response.json(
      { ok: false, error: 'relay failed: ' + String((e as Error)?.message || e).slice(0, 200) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    )
  }
})
