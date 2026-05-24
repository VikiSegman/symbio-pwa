exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { uid } = JSON.parse(event.body || '{}');
    const ownerUID = (process.env.OWNER_UUID || '').trim();
    const isOwner = ownerUID.length > 0 && uid === ownerUID;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ isOwner })
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ isOwner: false })
    };
  }
};
