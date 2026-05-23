// netlify/functions/config.js
// Serves public Supabase config safely from env vars
// No secrets exposed — anon key is public-safe but kept server-side for clean architecture

exports.handler = async () => ({
    statusCode: 200,
    headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
          supabaseUrl: process.env.SUPABASE_URL,
          supabaseAnon: process.env.SUPABASE_ANON_KEY
    })
});
