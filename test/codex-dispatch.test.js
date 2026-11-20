import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createContinuations } from '../continue-agent.js';
import { codexChange, codexForkPoint } from '../codex-dispatch.js';

const parent = crypto.randomUUID(),
  child = crypto.randomUUID(),
  a = crypto.randomUUID(),
  b = crypto.randomUUID();
const part = (text) => [{ type: 'text', text, text_elements: [] }];
const msg = (text) => ({ role: 'user', type: 'message', content: [{ type: 'input_text', text }] });
const request = {
  client_metadata: { thread_id: parent, turn_id: b },
  input: [msg('first'), msg('second'), msg('native runtime context')],
};
const row = {
  agent: 'codex',
  protocol: 'responses',
  session: parent,
  request: JSON.stringify(request),
};
const turns = [
  ['first', a],
  ['second', b],
].map(([text, id]) => ({
  id,
  users: [{ input: part(text), key: JSON.stringify([['text', text]]) }],
}));

test('Codex selects the edited request and forks before its owning turn', () => {
  for (const [index, turn] of [
    [0, a],
    [1, b],
    [2, b],
  ]) {
    const edited = structuredClone(request);
    edited.input[index] = msg('  changed\n');
    expect(codexForkPoint(codexChange(row, edited), turns, 0)).toEqual({
      beforeTurnId: turn,
      input: part('  changed\n'),
    });
  }
  expect(codexForkPoint(codexChange(row, request), turns, 0)).toEqual({
    beforeTurnId: b,
    input: part('second'),
  });
});

test('Codex request-only dispatch handles unsent drafts, ignores saved replies and retries desktop delivery once', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE calls(id TEXT,agent TEXT,protocol TEXT,session TEXT,request TEXT,started INTEGER);
    CREATE TABLE experiments(id TEXT,call_id TEXT,body TEXT); CREATE TABLE runs(id TEXT,kind TEXT,experiment_id TEXT,reply TEXT);
    CREATE TABLE codex_dispatches(id TEXT PRIMARY KEY,call_id TEXT,digest TEXT,stage TEXT,input TEXT,child TEXT);`);
  const call = crypto.randomUUID(),
    run = crypto.randomUUID(),
    key = crypto.randomUUID();
  const edited = structuredClone(request);
  edited.input[2] = msg('fresh question');
  db.query('INSERT INTO calls VALUES(?,?,?,?,?,0)').run(
    call,
    'codex',
    'responses',
    parent,
    JSON.stringify(request),
  );
  db.query('INSERT INTO experiments VALUES(?,?,?)').run('e', call, JSON.stringify(edited));
  db.query('INSERT INTO runs VALUES(?,?,?,?)').run(
    run,
    'send',
    'e',
    '{"output":[{"type":"function_call","name":"saved_reply_must_never_run"}]}',
  );
  let forks = 0,
    queues = 0,
    opened = 0,
    active = 0;
  const chats = createContinuations(db, {
    port: 0,
    uiKey: 'test',
    detect: () => '/codex',
    platform: 'darwin',
    launch: () => {
      throw Error('Unexpected Terminal launch');
    },
    openCodex: async (id) => {
      expect(active).toBe(0);
      expect(id).toBe(child);
      if (++opened === 1) throw Error('Unable to open app');
    },
    codexServer: async (exe, action) => {
      active++;
      try {
        return await action(async (method, args) => {
          if (method === 'thread/turns/list')
            return { data: [{ id: b, items: [{ type: 'userMessage', content: part('second') }] }] };
          if (method === 'thread/fork') {
            forks++;
            expect(args.beforeTurnId).toBe(b);
            return { thread: { id: child } };
          }
          if (method === 'thread/queue/add') {
            queues++;
            expect(args.input).toEqual(part('fresh question'));
            expect(args.threadId).toBe(child);
            return { queuedSubmission: { clientUserMessageId: args.clientUserMessageId } };
          }
          throw Error('Unexpected RPC: ' + method);
        });
      } finally {
        active--;
      }
    },
  });
  const send = () => chats.start(run, { target: 'codex', key });
  await expect(send()).rejects.toThrow('Unable to open app');
  const [x, y] = await Promise.all([send(), send()]);
  expect(x).toEqual(y);
  expect(await send()).toEqual(x);
  expect({ forks, queues, opened }).toEqual({ forks: 1, queues: 1, opened: 2 });
  await chats.start('capture/' + call, {
    target: 'codex',
    key: crypto.randomUUID(),
    request: edited,
  });
  expect(queues).toBe(2);
  db.close();
});
