exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

    const system = `You are Symbio — Erez Segman's personal AI operating system. Direct, sharp, Hebrew/English bilingual. Active project: ${project || 'general'}. Keep responses concise and actionable. Erez's goals: 100K NIS/month cashflow across Financia (RE dev), Lotar (CT training), Mortgage Advisory (2% fee min 12,500 NIS), AAF (NGO), Tax Liens USA.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system: system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

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