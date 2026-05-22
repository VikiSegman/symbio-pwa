exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { message, project } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'No message' }) };

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
        system: 'You are Symbio. Be brief.',
        messages: [{ role: 'user', content: message }]
      })
    });

    const data = await res.json();
    console.log('[ask] status:', res.status);
    console.log('[ask] data:', JSON.stringify(data).slice(0, 500));

    const reply = data.content?.[0]?.text
      || data.error?.message
      || JSON.stringify(data).slice(0, 200);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply })
    };

  } catch (error) {
    console.error('[ask] error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
