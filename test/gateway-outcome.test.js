import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { lookupOutcome, outcomeWorker, protocolFailure } from '../gateway-outcome.js';

const started = Date.now();
const call = { id: 'capture', agent: 'codex', session: 'thread', model: 'model', endpoint: '/v1/responses', started };
const row = { agent: call.agent, session: call.session, req: call.model, ep: call.endpoint,
  t: new Date(started).toISOString(), route_id: 10, status: 200, ms: 120 };
let ledger = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const url = new URL(req.url);
  expect(url.pathname).toBe('/v1/magpie/usage/requests');
  const route = url.searchParams.get('route');
  const rows = route ? ledger.filter(item => item.route_id === Number(route)) : ledger;
  return Response.json({ rows, total: rows.length });
} });
afterAll(() => server.stop(true));
const lookup = (patch = {}, peers = []) => lookupOutcome({ ...call, ...patch }, () => peers, server.url, new AbortController().signal);

test('maps final gateway signals independently of transport success', async () => {
  for (const [fields, expected] of [
    [{ provider: 'codex', err: 'This content was flagged for possible cybersecurity risk.', err_type: 'invalid_request' },
      { status: 'failed', failure: { reason: 'rejected', http: 200, provider: 'codex', type: 'invalid_request' } }],
    [{ provider: 'kiro', err: 'model_error: An unexpected error occurred.' },
      { status: 'failed', failure: { reason: 'error', code: 'model_error' } }],
    [{ provider: 'deepseek', status: 400, err_type: 'invalid_request_error', err: 'Invalid temperature (request_id: abc-1)' },
      { status: 'failed', failure: { provider: 'deepseek', http: 400, requestId: 'abc-1' } }],
    [{ status: 499, err_type: 'agent_canceled' }, { status: 'canceled' }],
    [{ status: 0, err: 'context deadline exceeded' }, { status: 'failed', failure: { message: 'context deadline exceeded' } }],
    [{ status: 403, rejected: true }, { status: 'failed', failure: { reason: 'rejected' } }],
  ]) {
    ledger = [{ ...row, ...fields }];
    expect(await lookup()).toMatchObject(expected);
  }
  expect(protocolFailure({ type: 'error', error: { type: 'permission_error', message: 'Denied' } }))
    .toMatchObject({ status: 'failed', failure: { type: 'permission_error', message: 'Denied' } });
});

test('requires uniqueness in both directions and uses the final route attempt', async () => {
  ledger = [{ ...row, status: 503, handed_on: true }, { ...row, t: new Date(started + 4000).toISOString() }];
  expect(await lookup()).toMatchObject({ status: 'complete' });
  ledger.pop();
  expect(await lookup()).toHaveProperty('miss');
  ledger = [{ ...row, status: 403 }, { ...row, route_id: 11, status: 200 }];
  expect(await lookup({ status: 'checking' })).toHaveProperty('miss');
  ledger.pop();
  expect(await lookup({ session: '' }, [{ ...call, session: '', id: 'other', started: started + 10 }])).toHaveProperty('miss');
  expect(await lookup({ session: 'different' })).toHaveProperty('miss');
  ledger = [{ ...row, req: 'auto/gpt-6.2-sol', status: 400 }];
  expect(await lookup({ model: 'group/auto-gpt-6-2-sol' })).toMatchObject({ status: 'failed' });
});

test('persisted checks survive restart, preserve uncertainty and accept late authoritative writes', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE calls(id TEXT,agent TEXT,session TEXT,model TEXT,endpoint TEXT,started INTEGER,ended INTEGER,status TEXT,failure TEXT)');
  const put = db.query('INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,NULL)');
  const putCall = (id, state, at, end) => put.run(id, call.agent, id, call.model, call.endpoint, at, end, state);
  putCall('failure', 'checking', started, started + 100);
  putCall('orphan', 'checking_unknown', started, null);
  putCall('late', 'checking_unknown', started, null);
  putCall('stream', 'pending', started - 125_000, null);
  ledger = [];
  const worker = outcomeWorker(db, server.url);
  try {
    worker.tick();
    db.query("UPDATE calls SET status='complete',ended=? WHERE id='late'").run(started + 110);
    await Bun.sleep(180);
    ledger = [{ ...row, session: 'failure', err: 'Denied', status: 403 }];
    await Bun.sleep(1100);
    expect(db.query("SELECT status,json_extract(failure,'$.http') AS http FROM calls WHERE id='failure'").get())
      .toEqual({ status: 'failed', http: 403 });
    await Bun.sleep(8300);
    expect(db.query("SELECT status,json_extract(failure,'$.reason') AS reason FROM calls WHERE id='orphan'").get())
      .toEqual({ status: 'unconfirmed', reason: 'unmatched' });
    expect(db.query("SELECT status,failure FROM calls WHERE id='late'").get()).toEqual({ status: 'complete', failure: null });
    expect(db.query("SELECT status FROM calls WHERE id='stream'").get().status).toBe('pending');
    ledger = [{ ...row, session: 'orphan', ms: 14500 }];
    worker.tick();
    await Bun.sleep(100);
    expect(db.query("SELECT status FROM calls WHERE id='orphan'").get().status).toBe('unconfirmed');
  } finally {
    worker.stop();
    db.close();
  }
}, 15000);
