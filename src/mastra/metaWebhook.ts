import { registerApiRoute } from '@mastra/core/server';

// Webhook verification for Meta
registerApiRoute('/webhook', {
  method: 'GET',
  handler: async (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    // Only return the challenge when it's a string (avoid passing undefined)
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN && typeof challenge === 'string') {
      return c.text(challenge, 200);
    }
    return c.text('Forbidden', 403);
  },
});

// Webhook POST for Meta (survey response handling)
registerApiRoute('/webhook', {
  method: 'POST',
  handler: async (c) => {
    const body = await c.req.json().catch(() => null);
    // TODO: Parse and store survey responses as needed
    // Example: store in DB or log
    console.log('Meta webhook POST received:', JSON.stringify(body));
    return c.json({ status: 'received' });
  },
});
