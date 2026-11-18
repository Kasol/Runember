import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { DingTalkStreamChannel } from '../src/dingtalk-stream.js';

async function socketServer(t: TestContext) {
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, autoPong: false,
    verifyClient: ({ req }) => req.url !== '/reject-upgrade',
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    const closed = once(server, 'close');
    for (const client of server.clients) client.terminate();
    server.close();
    await closed;
  });
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

const gateway = () => Response.json({ endpoint: 'wss://example.invalid/stream', ticket: 'test-ticket' });
const config = {
  clientId: 'test', clientSecret: 'test',
  allowedSenderIds: ['operator'], allowedConversationIds: ['allowed'],
};

test('ACKs each DingTalk delivery and processes each robot message once', { timeout: 10_000 }, async t => {
  const { server, url } = await socketServer(t);
  const acknowledgements: Array<{ code: number; headers: { messageId: string }; data: string }> = [];
  let replies = 0;
  const actions: string[] = [];
  let languageCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/gateway/connections/open')) return gateway();
    replies++;
    return Response.json({ errcode: 0 });
  });

  const channel = new DingTalkStreamChannel(config, () => new WebSocket(url), (_text, conversation, sender) => {
    languageCalls++;
    assert.equal(conversation, 'allowed');
    assert.equal(sender, 'operator');
    return 'en';
  });
  t.after(() => channel.stop());
  const connecting = once(server, 'connection');
  await channel.start(async action => {
    actions.push(action.type);
    assert.equal(action.language, 'en');
    return { ok: true, message: 'test reply' };
  });
  const [peer] = await connecting as [WebSocket];

  async function deliver(callbackId: string, msgId?: string, sender = 'operator', conversation = 'allowed'): Promise<void> {
    const acknowledgement = once(peer, 'message');
    peer.send(JSON.stringify({
      specVersion: '1.0',
      type: 'CALLBACK',
      headers: {
        appId: 'test', connectionId: 'test', contentType: 'application/json',
        messageId: callbackId, time: '0', topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgId, senderStaffId: sender, conversationId: conversation,
        text: { content: '状态' }, sessionWebhook: 'https://example.invalid/reply',
      }),
    }));
    const [frame] = await acknowledgement;
    acknowledgements.push(JSON.parse(frame.toString()));
  }

  await deliver('delivery-1', 'message-1');
  await deliver('delivery-2', 'message-1');
  await deliver('delivery-3', 'message-2');
  await deliver('delivery-4');
  await deliver('delivery-4');
  await deliver('delivery-5', 'unauthorized-sender', 'guest');
  await deliver('delivery-6', 'unauthorized-conversation', 'operator', 'other');

  assert.deepEqual(actions, ['status', 'status', 'status']);
  assert.equal(languageCalls, 3);
  assert.deepEqual(acknowledgements.map(frame => frame.headers.messageId),
    ['delivery-1', 'delivery-2', 'delivery-3', 'delivery-4', 'delivery-4', 'delivery-5', 'delivery-6']);
  assert.ok(acknowledgements.every(frame => frame.code === 200 && frame.data === '{"response":{}}'));
  assert.equal(replies, 5);
});

test('a missed pong reconnects once even if the next handshake fails', { timeout: 10_000 }, async t => {
  const { server, url } = await socketServer(t);
  const setInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => setInterval(callback, 60));
  t.mock.method(globalThis, 'fetch', async () => gateway());
  let attempts = 0;
  const channel = new DingTalkStreamChannel(config, () => {
    attempts++;
    return new WebSocket(attempts === 2 ? `${url}/reject-upgrade` : url);
  });
  t.after(() => channel.stop());
  const firstConnection = once(server, 'connection');
  await channel.start(async () => ({ ok: true, message: '' }));
  const [first] = await firstConnection as [WebSocket];
  const reconnecting = once(server, 'connection');
  await once(first, 'ping');
  const [second] = await reconnecting as [WebSocket];
  assert.equal(attempts, 3);
  assert.equal(server.clients.size, 1);
  const closed = once(second, 'close');
  channel.stop();
  await closed;
});
