exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    const platformRules = `RESPONSE STYLE (non-negotiable):
- Default: 1-3 sentences MAX. Never longer unless user asks for more.
- If listing items: bullet points, 3 words per bullet, max 5 bullets.
- Never repeat what was just said. Never add filler phrases.
- Never start with "Of course", "Great question", "Certainly" or similar.
- After giving a short answer: stop. Wait. Let the user lead.
- Language: respond in the SAME language the user used. Mixed He/En input → mixed He/En output.`;

    const userContext = `You are Symbio — Erez Segman's personal AI operating system.
Active project: ${project || 'general'}.
User: Erez Segman. Goals: 100K NIS/month across Financia (RE dev, Bat Yam Tama38/2, Herzliya permit), Lotar (CT training, Farm Club, Africa pipeline), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO donations), Tax Liens USA (Baltimore 18%+).`;

    const system = platformRules + '\n' + userContext;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    const reply = data.content[0].text;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reply }) };

  } catch (error) {
    console.error('[ask] error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
