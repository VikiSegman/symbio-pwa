// netlify/functions/paypal-config.js
// Returns PayPal client ID + plan IDs to frontend
// Credentials stay server-side — never in source code

exports.handler = async () => {
  return {
      statusCode: 200,
          headers: {
                'Content-Type': 'application/json',
                      'Access-Control-Allow-Origin': '*'
                          },
                              body: JSON.stringify({
                                    clientId: process.env.PAYPAL_CLIENT_ID,
                                          plans: {
                                                  starter:  process.env.PAYPAL_PLAN_STARTER,
                                                          personal: process.env.PAYPAL_PLAN_PERSONAL,
                                                                  pro:      process.env.PAYPAL_PLAN_PRO
                                                                        }
                                                                            })
                                                                              };
                                                                              };
