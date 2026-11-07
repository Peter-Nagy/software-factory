import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushFor, sendNtfy } from '../src/push.ts';

test('push: questions buzz, alerts break through, news only when asked for; the dashboard link rides along', () => {
  const o = { publicUrl: 'https://mini.tail.ts.net:4777', info: false };
  assert.deepEqual(pushFor('question', 'app#5 (PR #9) needs your sign-off:\nProtected files:\n- factory.yaml', o), {
    title: 'Needs you: app#5 (PR #9) needs your sign-off:', body: 'Protected files:\n- factory.yaml', priority: 4, tags: ['raising_hand'], click: 'https://mini.tail.ts.net:4777',
  });
  assert.equal(pushFor('alert', 'Backup failed: disk full', o)!.priority, 5);
  assert.equal(pushFor('alert', 'Backup failed: disk full', o)!.body, 'Backup failed: disk full');
  assert.equal(pushFor('info', 'Merged app#5', o), null);
  assert.equal(pushFor('info', 'Merged app#5', { ...o, info: true })!.priority, 2);
  const long = pushFor('alert', 'x'.repeat(200), o)!;
  assert.equal(long.title.length, 88);
  assert.equal(long.body, 'x'.repeat(200));
});

test('push: one POST per message to the topic, with ntfy headers; errors surface', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  await sendNtfy('https://ntfy.sh/', 'factory-abc 123', { title: 'Hi\nthere', body: 'Body', priority: 4, tags: ['a', 'b'], click: null }, fake);
  assert.equal(calls[0]!.url, 'https://ntfy.sh/factory-abc%20123');
  assert.deepEqual(calls[0]!.init.headers, { 'X-Title': 'Hi there', 'X-Priority': '4', 'X-Tags': 'a,b', 'Content-Type': 'text/plain; charset=utf-8' });
  const failing = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(sendNtfy('https://ntfy.sh', 't', { title: 'x', body: 'y', priority: 3, tags: [], click: null }, failing), /429/);
});
