import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { claudeDispatcher, claudeJobStatus } from '../claude-dispatch.js';

test('a fresh Claude capture dispatches only the saved request draft into a new background branch', async () => {
  const db = new Database(':memory:'),
    call = crypto.randomUUID(),
    session = crypto.randomUUID(),
    child = crypto.randomUUID(),
    key = crypto.randomUUID();
  db.exec(`CREATE TABLE calls(id TEXT,agent TEXT,protocol TEXT,session TEXT,request TEXT,started INTEGER);
 CREATE TABLE claude_dispatches(id TEXT PRIMARY KEY,call_id TEXT,digest TEXT,cwd TEXT,stage TEXT,child TEXT,job TEXT,prompt TEXT);`);
  const original = {
    model: 'model',
    messages: [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'reply A' },
      { role: 'user', content: 'old B' },
    ],
  };
  db.query('insert into calls values(?,?,?,?,?,0)').run(
    call,
    'claude',
    'anthropic',
    session,
    JSON.stringify(original),
  );
  const q = structuredClone(original);
  q.messages[2].content = ' edited B\n';
  const boundary = crypto.randomUUID(),
    jobs = [],
    forks = [];
  const dispatch = claudeDispatcher(db, {
    detect: () => '/fixture/claude',
    locateSource: async () => ({
      sessionId: session,
      boundary,
      cwd: '/fixture/project',
      original: 'old B',
    }),
    fork: async (id, opts) => {
      forks.push([id, opts.upToMessageId]);
      return { sessionId: child };
    },
    startJob: async (...args) => {
      jobs.push(args);
      return 'testjob';
    },
    jobSession: async () => child,
  });
  const row = {
    call_id: call,
    agent: 'claude',
    protocol: 'anthropic',
    session,
    request: JSON.stringify(original),
  };
  const send = () => dispatch(row, q, key);
  const [a, b] = await Promise.all([send(), send()]);
  expect(a).toEqual(b);
  expect(await send()).toEqual(a);
  expect(a.sessionId).toBe(child);
  expect(forks).toEqual([[session, boundary]]);
  expect(jobs).toEqual([['/fixture/claude', '/fixture/project', child, ' edited B\n']]);
  const receipt = await claudeJobStatus(
    db,
    key,
    () => '/fixture/claude',
    async () => ({
      sessionId: child,
      status: 'waiting',
      state: 'blocked',
      waitingFor: 'permission prompt',
    }),
  );
  expect(receipt).toEqual({
    job: 'testjob',
    sessionId: child,
    activity: 'approval',
    waitingFor: 'permission prompt',
  });
  await expect(dispatch(row, original, key)).rejects.toThrow('another draft');
  db.close();
});
