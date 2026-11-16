import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { DingTalkStreamChannel } from '../src/dingtalk-stream.js';

test('ACKs each DingTalk delivery and processes each robot message once', async t => {
  let client!: DWClient;
  const acknowledgements: Array<{ code: number; headers: { messageId: string }; data: string }> = [];
  const acknowledgementsAtReply: number[] = [];
  const actions: string[] = [];
  t.mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    client = this;
    this.connected = true;
    Object.assign(this, {
      socket: { send: (frame: string) => acknowledgements.push(JSON.parse(frame)), close() {} },
    });
  });
  t.mock.method(globalThis, 'fetch', async () => {
    acknowledgementsAtReply.push(acknowledgements.length);
    return Response.json({ errcode: 0 });
  });

  const channel = new DingTalkStreamChannel({
    clientId: 'test', clientSecret: 'test',
    allowedSenderIds: ['operator'], allowedConversationIds: ['allowed'],
  });
  await channel.start(async action => {
    actions.push(action.type);
    return { ok: true, message: 'test reply' };
  });

  function deliver(callbackId: string, msgId?: string, sender = 'operator', conversation = 'allowed'): void {
    client.onCallback({
      specVersion: '1.0',
      type: 'CALLBACK',
      headers: {
        appId: 'test', connectionId: 'test', contentType: 'application/json',
        messageId: callbackId, time: '0', topic: TOPIC_ROBOT,
      },
      data: JSON.stringify({
        msgId, senderStaffId: sender, conversationId: conversation,
        text: { content: '状态' }, sessionWebhook: 'https://example.invalid/reply',
      }),
    });
  }

  deliver('delivery-1', 'message-1');
  await setImmediate();
  deliver('delivery-2', 'message-1');
  deliver('delivery-3', 'message-2');
  await setImmediate();
  deliver('delivery-4');
  await setImmediate();
  deliver('delivery-4');
  await setImmediate();
  deliver('delivery-5', 'unauthorized-sender', 'guest');
  await setImmediate();
  deliver('delivery-6', 'unauthorized-conversation', 'operator', 'other');
  await setImmediate();

  assert.deepEqual(actions, ['status', 'status', 'status']);
  assert.deepEqual(acknowledgements.map(frame => frame.headers.messageId),
    ['delivery-1', 'delivery-2', 'delivery-3', 'delivery-4', 'delivery-4', 'delivery-5', 'delivery-6']);
  assert.ok(acknowledgements.every(frame => frame.code === 200 && frame.data === '{"response":{}}'));
  assert.deepEqual(acknowledgementsAtReply, [1, 3, 4, 6, 7]);
  channel.stop();
});
