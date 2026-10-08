const { createHmac, randomUUID } = require('node:crypto');

async function main() {
  const secret = process.env.DEMO_SECRET;
  if (!secret || secret.length < 32) throw new Error('DEMO_SECRET required (32+ characters)');
  const eventId = randomUUID();
  const body = JSON.stringify({ eventId, orderId: randomUUID(), kind: 'order.paid' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret)
    .update(timestamp).update('.').update(body).digest('hex');

  const response = await fetch('http://127.0.0.1:3000/webhooks/demo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-event-id': eventId,
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': 'sha256=' + signature,
    },
    body,
  });
  console.log(response.status, await response.text());
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
