exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const { message, project, uid } = body;

    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    const ownerUID = (process.env.OWNER_UID || '').trim();
    const isOwner = ownerUID.length > 0 && uid === ownerUID;

    const platformRules = `RESPONSE STYLE (non-negotiable):
- Default: 1-3 sentences MAX. Never longer unless user asks "explain more" or "expand".
- If listing items: bullet points, 3 words per bullet, max 5 bullets.
- Never repeat what was just said. Never add filler phrases.
- Never start with "Of course", "Great question", "Certainly" or similar.
- After giving a short answer: stop. Wait. Let the user lead.
- Language: respond in the SAME language the user used. Mixed He/En input -> mixed He/En output.
`;

    const userContext = isOwner
      ? \`You are Symbio – a personalized AI operating system for Erez Segman.
Active project: \${project || 'general'}.
Goals: 100K NIS/month across Financia (RE dev+fund, Bat Yam + Herzliya תמ"א projects), Lotar (CT training+farm club), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO donations), Tax Liens USA (18%+ annual yield).
Always prioritize cash flow, lead generation, and deal closure.\`
      : `You are Symbio – a helpful AI assistant. Answer concisely and helpfully.`;

    const system = platformRules + '\n' + userContext;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || \`API error \${res.status}\`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ reply: data.content[0].text })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message, reply: 'שגיאה: ' + e.message })
    };
  }
};
