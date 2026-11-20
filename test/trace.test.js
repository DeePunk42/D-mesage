import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.D_MESSAGE_DATA_DIR = mkdtempSync(join(tmpdir(), 'd-message-test-'));
const { onRequest, onResponse } = await import('../capture.hooks.js');
const { storage, dataDir } = await import('../store.js');
// Bun shares modules across test files; never let tests reach the real history.
if (dataDir !== process.env.D_MESSAGE_DATA_DIR) throw Error('Tests resolved the real data directory.');
const { startService } = await import('../service.js');
const { readReply } = await import('../replay.js');
const seen = [];
const mock = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(r) {
    const path = new URL(r.url).pathname;
    if (path === '/v1/magpie/agent-models')
      return Response.json({ agents: { claude: { model: 'mock' } } });
    if (path === '/v1/magpie/usage/requests')
      return Response.json({
        agents: [{ id: 'claude' }, { id: 'codex' }, { id: 'tracefork' }, { id: 'd-message' }],
      });
    const b = await r.json();
    seen.push({ name: r.headers.get('User-Agent'), body: b });
    return Response.json({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: b.messages.at(-1).content },
          finish_reason: 'stop',
        },
      ],
      model: b.model,
    });
  },
});
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop(true);
const uiKey = crypto.randomUUID();
const service = startService({ port, uiKey }, { upstream: mock.url.href });
const api = async (path, body) => {
  const r = await fetch(service.url + 'api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + uiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return [r.status, await r.json()];
};
afterAll(() => {
  service.stop(true);
  mock.stop(true);
  storage().close();
  rmSync(process.env.D_MESSAGE_DATA_DIR, { recursive: true, force: true });
});
test('two concurrent calls survive stop, individual runs retain the exact draft sent', async () => {
  expect((await fetch(service.url + 'api/list')).status).toBe(401);
  const base = { model: 'mock', messages: [{ role: 'user', content: 'original' }], stream: false };
  const ctx = () => ({
    origin: 'local',
    agent: 'alpha-client',
    protocol: 'chat',
    session: '',
    state: {},
  });
  await onRequest(base, { ...ctx(), agent: 'z-client' });
  await onRequest(base, ctx());
  const scope = (await api('capture-scope'))[1];
  expect(scope.scope).toEqual({ agents: ['alpha-client'] });
  expect(scope.choices.agents).toEqual(['alpha-client', 'claude', 'codex', 'z-client']);
  expect((await api('list'))[1].calls).toHaveLength(0);
  await api('recording', { enabled: true });
  const a = ctx(),
    b = ctx();
  await Promise.all([
    onRequest(base, a),
    onRequest(base, b),
    onRequest(base, { ...ctx(), agent: 'other-client' }),
    onRequest(base, { ...ctx(), origin: 'remote' }),
  ]);
  await api('recording', { enabled: false });
  await onResponse({ choices: [] }, { ...b, success: false });
  await onResponse({ choices: [{ message: { content: 'observed' } }] }, { ...a, success: true });
  const calls = (await api('list'))[1].calls;
  expect(calls).toHaveLength(2);
  expect(calls.find((x) => x.id === b.state.traceId).status).toBe('incomplete');
  expect(calls[0].last_role).toBe('user');
  expect(calls[0].last_preview).toBe('original');
  const edited = structuredClone(base);
  const snapshots = [];
  for (const content of ['one', 'two', 'two']) {
    edited.messages[0].content = content;
    const [code, { id }] = await api('send/' + a.state.traceId, { body: edited });
    expect(code).toBe(202);
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await api('snapshot/' + id))[1];
      if (row.status !== 'running') break;
      await Bun.sleep(10);
    }
    expect(row.status).toBe('complete');
    snapshots.push(id);
    expect(JSON.parse(row.reply).choices[0].message.content).toBe(content);
  }
  const call = (await api('calls/' + a.state.traceId))[1];
  expect(JSON.parse(call.request)).toEqual(base);
  expect(JSON.parse((await api('snapshot/' + snapshots[0]))[1].request).messages[0].content).toBe(
    'one',
  );
  expect((await api('runs/' + call.id))[1].runs).toHaveLength(3);
  const history = (await api('list?type=repeater'))[1];
  expect(history.total).toBe(3);
  expect(history.calls.map((r) => r.id)).toEqual([...snapshots].reverse());
  expect(history.calls.every((r) => r.entry_type === 'repeater' && r.call_id === call.id)).toBe(
    true,
  );
  expect(history.calls.map((r) => r.last_preview)).toEqual(['two', 'two', 'one']);
  expect((await api('list?type=repeater&q=two&offset=1'))[1].calls.map((r) => r.id)).toEqual([
    snapshots[1],
  ]);
  expect((await api('list?type=capture'))[1].total).toBe(2);
  expect((await api('list'))[1].total).toBe(5);
  const detail = (await api('snapshot/' + snapshots[2]))[1];
  expect(detail.call_seq).toBe(call.seq);
  expect(detail.seq).toBe(history.calls[0].seq);
  expect(JSON.parse(detail.reply).choices[0].message.content).toBe('two');
  expect(seen).toHaveLength(3);
  // A pre-upgrade baseline points at the original call even when its experiment has edits.
  const legacy = crypto.randomUUID(),
    oldRun = crypto.randomUUID();
  storage()
    .query('INSERT INTO experiments VALUES(?,?,?,?)')
    .run(legacy, call.id, 1, JSON.stringify(edited));
  storage()
    .query(
      "INSERT INTO runs(id,experiment_id,kind,started,status,owner) VALUES(?,?,'baseline',1,'complete',1)",
    )
    .run(oldRun, legacy);
  expect(JSON.parse((await api('snapshot/' + oldRun))[1].request)).toEqual(base);
  expect((await api('list?type=repeater&q=original'))[1].calls[0].id).toBe(oldRun);
  expect(seen.every((r) => r.name === 'd-message/1')).toBe(true);
});
test('split SSE tool arguments and usage, reject incomplete stream', async () => {
  const lines = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'one', function: { name: 'format', arguments: '{"x":' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [], usage: { total_tokens: 12 } },
  ]
    .map((x) => 'data: ' + JSON.stringify(x) + '\r\n\r\n')
    .join('');
  const response = (text) =>
    new Response(
      new ReadableStream({
        start(c) {
          const b = new TextEncoder().encode(text);
          for (let i = 0; i < b.length; i += 13) c.enqueue(b.slice(i, i + 13));
          c.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  const got = await readReply(response(lines + 'data: [DONE]\r\n\r\n'));
  expect(got.choices[0].message.tool_calls[0].function.arguments).toBe('{"x":1}');
  expect(got.usage.total_tokens).toBe(12);
  await expect(readReply(response(lines))).rejects.toThrow('interrupted');
});
test('wire role and multipart previews preserve structure and literal JSON text', async () => {
  const { messagePreview, addPart, pairingWarning } = await import('../ui/messages.js');
  const m = { role: 'tool', tool_call_id: '1', content: '{"note":"ordinary text"}', extra: true };
  addPart(m, 0, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } });
  expect(messagePreview(m)).toBe('2 blocks · Image');
  expect(m.content[1]).toEqual({ type: 'text', text: '{"note":"ordinary text"}' });
  const a = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: '1', type: 'function', function: { name: 'format', arguments: '{}' } }],
  };
  expect(messagePreview(a)).toBe('Call format');
  expect(pairingWarning([a, m])).toBe('');
  expect(pairingWarning([m])).toContain('Message 1');
  expect(pairingWarning([a])).toContain('Message 1');
});

test('HTTP MCP controls ports, snapshots, atomic patches and idempotent single-inference runs', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const freePort = () => {
    const p = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const n = p.port;
    p.stop(true);
    return n;
  };
  const allocated = freePort();
  const [, info] = await api('settings/mcp', { enabled: true, port: allocated });
  expect(info.listening).toBe(true);
  const token = (await api('settings/mcp/token', {}))[1].token;
  expect((await fetch(info.url)).status).toBe(401);
  expect(
    (
      await fetch(info.url, {
        method: 'POST',
        headers: { Origin: 'https://unrelated.example', Authorization: 'Bearer ' + token },
      })
    ).status,
  ).toBe(403);
  const client = new Client({ name: 'd-message-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  const call = (name, args) => client.callTool({ name, arguments: args });
  const result = async (name, args) => {
    const r = await call(name, args);
    if (r.isError) throw Error(r.content[0].text);
    return r.structuredContent;
  };
  try {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'trace_edit',
      'trace_get',
      'trace_list',
      'trace_record',
      'trace_repeat',
    ]);
    const scope = { agents: ['alpha', 'beta'] };
    const configured = await result('trace_record', { action: 'configure', scope });
    expect(configured.recording).toBe(false);
    storage()
      .query("UPDATE settings SET value=? WHERE key='capture_scope'")
      .run(JSON.stringify({ ...scope, models: ['one'] }));
    const status = await result('trace_record', { action: 'status' });
    expect(status.choices.agents).toContain('codex');
    expect(status.choices).not.toHaveProperty('models');
    expect(status.scope).toEqual(scope);
    expect((await api('capture-scope'))[1].scope).toEqual(scope);
    const { cursor: beforeScope } = await result('trace_record', { action: 'start' });
    async function observe(agent, model, origin = 'local', protocol = 'chat') {
      const ctx = { agent, origin, protocol, state: {}, session: 'scope' };
      await onRequest({ model, messages: [] }, ctx);
      return ctx;
    }
    const accepted = await observe('beta', 'one');
    expect(accepted.state.traceId).toBeTruthy();
    expect((await observe('alpha', 'different-model')).state.traceId).toBeTruthy();
    expect((await observe('gamma', 'two')).state.traceId).toBeUndefined();
    expect((await api('capture-scope', { agents: 'all' }))[0]).toBe(200);
    expect((await observe('D-message', 'one')).state.traceId).toBeUndefined();
    expect((await observe('tracefork', 'one')).state.traceId).toBeUndefined();
    expect((await observe('outside', 'one', 'remote')).state.traceId).toBeUndefined();
    expect(
      (await observe('other-protocol', 'one', 'local', 'responses')).state.traceId,
    ).toBeUndefined();
    expect((await observe('gamma', 'missing', 'magpie-key')).state.traceId).toBeTruthy();
    const filtered = await result('trace_list', { after: beforeScope });
    expect(filtered.traces.map((r) => r.agent)).toEqual(['beta', 'alpha', 'gamma']);
    expect((await result('trace_get', { ref: filtered.traces[0].ref })).value.agent).toBe('beta');
    expect(
      (await call('trace_record', { action: 'start', scope: { agents: [] } })).isError,
    ).toBe(true);
    const reset = await result('trace_record', {
      action: 'start',
      scope: { agents: ['alpha-client'] },
    });
    expect(reset.scope.agents).toEqual(['alpha-client']);
    await result('trace_record', { action: 'stop' });
    await onResponse({ choices: [] }, { ...accepted, success: true });
    expect((await api('calls/' + accepted.state.traceId))[1].status).toBe('complete');
    const { cursor } = await result('trace_record', { action: 'start' });
    const ctx = {
      origin: 'local',
      agent: 'alpha-client',
      protocol: 'chat',
      session: 'mcp-test',
      state: {},
    };
    const body = {
      model: 'mock',
      messages: [{ role: 'user', content: 'hello', attributes: { 'a/b~c': 7 } }],
      stream: false,
    };
    await onRequest(body, ctx);
    await result('trace_record', { action: 'stop' });
    await onResponse({ choices: [{ message: { content: 'ok' } }] }, { ...ctx, success: true });
    const page = await result('trace_list', { after: cursor, session: 'mcp-test' });
    expect(page.traces).toHaveLength(1);
    expect((await result('trace_list', { after: page.cursor })).traces).toHaveLength(0);
    const ref = page.traces[0].ref;
    expect(
      (await result('trace_get', { ref, view: 'request', path: '/messages/0/attributes/a~1b~0c' }))
        .value,
    ).toBe(7);
    const ops = [
      { op: 'test', path: '/messages/0/role', value: 'user' },
      { op: 'replace', path: '/messages/0/content', value: 'changed' },
      { op: 'add', path: '/messages/-', value: { role: 'user', content: 'next' } },
      { op: 'remove', path: '/messages/0/attributes' },
    ];
    const count = () => storage().query('SELECT COUNT(*) n FROM experiments').get().n;
    const before = count();
    expect(
      (
        await call('trace_edit', {
          ref,
          ops: [...ops, { op: 'test', path: '/messages/0/content', value: 'wrong' }],
        })
      ).isError,
    ).toBe(true);
    expect(count()).toBe(before);
    const draft = (await result('trace_edit', { ref, ops })).draft_ref;
    expect((await result('trace_get', { ref, view: 'request' })).value).toEqual(body);
    const previousCalls = seen.length;
    const args = { ref: draft, request_key: 'case-1' };
    const [a, b] = await Promise.all([result('trace_repeat', args), result('trace_repeat', args)]);
    expect(a.run_ref).toBe(b.run_ref);
    expect((await call('trace_repeat', { ...args, ref })).isError).toBe(true);
    let record;
    for (let i = 0; i < 50; i++) {
      record = await result('trace_get', { ref: a.run_ref, view: 'response' });
      if (record.status === 'complete') break;
      await Bun.sleep(10);
    }
    expect(record.value.choices[0].message.content).toBe('next');
    expect(seen.length - previousCalls).toBe(1);
    expect(
      (await api('runs/' + ref.slice(6)))[1].runs.some((r) => r.id === a.run_ref.slice(4)),
    ).toBe(true);
    expect((await api('settings/mcp', { enabled: true, port }))[0]).toBe(400);
    expect((await result('trace_record', { action: 'status' })).recording).toBe(false);
  } finally {
    await client.close();
  }
  const newPort = freePort();
  const moved = (await api('settings/mcp', { enabled: true, port: newPort }))[1];
  expect(moved.port).toBe(newPort);
  expect((await fetch(moved.url)).status).toBe(401);
  await expect(fetch(info.url)).rejects.toThrow();
  await service.stop(true);
  const restarted = startService({ port, uiKey });
  try {
    expect((await api('settings/mcp'))[1].listening).toBe(true);
    expect((await fetch(moved.url)).status).toBe(401);
    await api('settings/mcp', { enabled: false, port: newPort });
    await expect(fetch(moved.url)).rejects.toThrow();
  } finally {
    await restarted.stop(true);
  }
});

test('a new plugin host recovers page and MCP listeners after an overlapping restart', async () => {
  const plugin = (await import('../plugin.js')).default;
  const hold = () =>
    Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('previous host') });
  const previousPage = hold(),
    previousMcp = hold();
  const config = { enabled: true, port: previousMcp.port },
    pagePort = previousPage.port;
  const db = storage(),
    key = 'mcp';
  const saved = db.query('SELECT value FROM settings WHERE key=?').get(key)?.value;
  db.query('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(config));
  const headers = { Authorization: 'Bearer ' + uiKey };
  try {
    await plugin.server({}, { port: pagePort, pageHostPort: pagePort, uiKey });
    await previousPage.stop(true);
    const statusUrl = 'http://127.0.0.1:' + pagePort + '/api/settings/mcp';
    async function waitFor(wantListening) {
      for (let i = 0; i < 160; i++) {
        try {
          const r = await fetch(statusUrl, { headers });
          if (r.ok && (await r.json()).listening === wantListening) return;
        } catch {}
        await Bun.sleep(25);
      }
      throw Error('Timed out waiting for listener handover');
    }
    await waitFor(false);
    await previousMcp.stop(true);
    await waitFor(true);
    expect((await fetch('http://127.0.0.1:' + config.port + '/mcp')).status).toBe(401);
    await fetch(statusUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, enabled: false }),
    });
  } finally {
    await previousPage.stop(true);
    await previousMcp.stop(true);
    if (saved !== undefined) db.query('UPDATE settings SET value=? WHERE key=?').run(saved, key);
    else db.query('DELETE FROM settings WHERE key=?').run(key);
  }
});

test('pretty view decodes JSON layers without changing source text', async () => {
  const { presentation } = await import('../ui/messages.js');
  const original = JSON.stringify(JSON.stringify({ city: '北京', n: 12 }));
  expect(presentation(original)).toEqual({ data: { city: '北京', n: 12 } });
  expect(presentation(String.raw`hello "world"\nnext`)).toEqual({ text: 'hello "world"\nnext' });
  const path = String.raw`C:\temp\notes`;
  expect(presentation(path)).toEqual({ text: path });
  expect(presentation('{broken')).toEqual({ text: '{broken' });
});

test('pretty text edits preserve untouched encodings and JSON token spelling', async () => {
  const { prettyEditorText } = await import('../ui/messages.js');
  const source = ' \t{ "n":90071992547409931234,"v":"old","v":1e+40 } ';
  const wire = JSON.stringify(JSON.stringify(source));
  const edit = prettyEditorText(wire);
  expect(edit.text).toContain('\n  "n": 90071992547409931234');
  expect(edit.encode(edit.text)).toBe(wire);
  expect(edit.encode(edit.text.replace('old', 'new'))).toBe(
    JSON.stringify(JSON.stringify(source.replace('old', 'new'))),
  );
  const mixed = String.raw`hello "user"\nline \u4e2d` + '\r\nend';
  const lines = prettyEditorText(mixed);
  expect(lines.text).toBe('hello "user"\nline 中\nend');
  expect(lines.encode(lines.text.replace('line', '文本'))).toBe(mixed.replace('line', '文本'));
  const plain = prettyEditorText('C:\\temp\\notes');
  expect(plain.encode(plain.text + '!')).toBe('C:\\temp\\notes!');
});

test('clear requires confirmation and preserves capture scope and polling cursors', async () => {
  const { recordState, editTrace, listTraces } = await import('../trace-api.js');
  const server = startService({ port, uiKey }, { upstream: mock.url.href, restoreMcp: false });
  try {
    const scope = { agents: ['clear-test'] };
    recordState('start', scope);
    const ctx = { origin: 'local', protocol: 'chat', agent: 'clear-test', state: {} };
    const body = { model: 'mock', messages: [{ role: 'user', content: 'test' }] };
    await onRequest(body, ctx);
    const callId = ctx.state.traceId;
    const { draft_ref } = editTrace({ ref: 'trace:' + callId, ops: [] });
    const before = recordState('status');
    const [denied] = await api('history/clear', { confirmed: false });
    expect(denied).toBe(400);
    expect((await api('calls/' + callId))[0]).toBe(200);
    expect(
      (
        await fetch(server.url + 'api/history/clear', {
          method: 'POST',
          body: '{"confirmed":true}',
        })
      ).status,
    ).toBe(401);
    const [status, cleared] = await api('history/clear', { confirmed: true });
    expect(status).toBe(200);
    expect(cleared.clearedThrough).toBe(before.cursor);
    expect((await api('snapshot/' + draft_ref.slice(6)))[0]).toBe(404);
    await onResponse({ choices: [] }, { ...ctx, success: true });
    expect((await api('list'))[1].total).toBe(0);
    expect(recordState('status')).toMatchObject({ cursor: before.cursor, recording: true, scope });
    const next = { ...ctx, state: {} };
    await onRequest(body, next);
    const events = listTraces({ after: before.cursor });
    expect(events.traces.map((r) => r.ref)).toEqual(['trace:' + next.state.traceId]);
    expect(events.cursor).toBeGreaterThan(before.cursor);
  } finally {
    await server.stop(true);
  }
});

test('persistent tabs isolate runs, reject stale saves and keep Trace history after draft deletion', async () => {
  const { tabRequest } = await import('../repeater-tabs.js');
  const { recordState } = await import('../trace-api.js');
  recordState('start', { agents: ['tabs-test'] });
  const ctx = { origin: 'local', protocol: 'chat', agent: 'tabs-test', state: {} };
  await onRequest({ model: 'mock', messages: [{ role: 'user', content: 'seed' }] }, ctx);
  const req = (act, args = {}) => tabRequest(act, args, mock.url.href);
  const ref = 'trace:' + ctx.state.traceId;
  const a = req('open', { ref }).tab;
  expect(req('open', { ref }).tab.id).toBe(a.id);
  const copy = req('duplicate', { id: a.id }).tab;
  expect(copy.id).not.toBe(a.id);
  const state = {
    ...copy.state,
    tab: 'Changes',
    draft: { model: 'alternate/model', messages: [{ role: 'user', content: 'second' }] },
  };
  const update = {
    id: copy.id,
    revision: crypto.randomUUID(),
    patches: [
      {
        base: copy.revision,
        at: 0,
        remove: JSON.stringify(copy.state).length,
        text: JSON.stringify(state),
      },
    ],
  };
  expect(req('save', update)).toEqual(req('save', update));
  expect(() => req('save', { ...update, revision: crypto.randomUUID() })).toThrow('another window');
  const diffArgs = { id: copy.id, draft: state.draft };
  const server = startService({ port, uiKey }, { upstream: mock.url.href, restoreMcp: false });
  let run;
  try {
    const unsent = await api('tabs/changes', diffArgs);
    expect(unsent[0]).toBe(200);
    expect(unsent[1].hunks[0].lines).toContain('-      "content": "seed"');
    run = req('send', { id: copy.id, revision: update.revision }).id;
    expect((await api('snapshot/' + run))[1].model).toBe('alternate/model');
    expect((await api('list?type=repeater'))[1].calls.find((r) => r.id === run).model).toBe('alternate/model');
    expect(await api('tabs/changes', { ...diffArgs, base: 'previous' })).toEqual(unsent);
  } finally {
    await server.stop(true);
  }
  expect(req('runs', { id: a.id }).runs).toHaveLength(0);
  expect(req('runs', { id: copy.id }).runs.map((x) => x.id)).toEqual([run]);
  expect(() => req('pick', { id: a.id, run })).toThrow();
  req('close', { id: copy.id });
  expect(req('workspace').tab.id).toBe(a.id);
  const reopened = req('select', { id: copy.id }).tab;
  expect(reopened.selected_run).toBe(run);
  expect(reopened.state).toEqual(state);
  expect(() => req('delete', { id: copy.id })).toThrow('Confirm');
  const after = req('delete', { id: copy.id, confirmed: true });
  expect(after.tabs.map((t) => t.id)).toContain(a.id);
  expect(storage().query('SELECT tab_id FROM runs WHERE id=?').get(run)).toEqual({ tab_id: null });
  for (
    let i = 0;
    i < 100 && storage().query('SELECT status FROM runs WHERE id=?').get(run).status === 'running';
    i++
  )
    await Bun.sleep(10);
  expect(seen.at(-1).body.model).toBe('alternate/model');
  expect(req('open', { ref: 'run:' + run }).tab.original_model).toBe('alternate/model');
});

test('Responses and Messages retain their native bodies, routes and edited tab snapshots', async () => {
  const { recordState, snapshot, editTrace, repeatTrace } = await import('../trace-api.js');
  const { tabRequest } = await import('../repeater-tabs.js');
  const { requestEntries, responseMessages } = await import('../ui/protocols.js');
  const output = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  ];
  const nativeCalls = [];
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      nativeCalls.push({ path, body: await req.json(), headers: req.headers });
      return Response.json(
        path.endsWith('messages')
          ? {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
            }
          : { id: 'resp_test', object: 'response', status: 'completed', output },
      );
    },
  });
  const upstream = gateway.url.href + 'v1/chat/completions';
  recordState('start', { agents: ['codex', 'claude'] });
  try {
    for (const [agent, protocol, path, body] of [
      [
        'codex',
        'responses',
        '/backend-api/codex/responses',
        {
          model: 'fixture',
          instructions: 'Use the fixture',
          input: [
            { type: 'function_call', call_id: 'c', name: 'format', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c', output: 'ok' },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'original' }] },
          ],
          store: false,
        },
      ],
      [
        'claude',
        'anthropic',
        '/v1/messages',
        {
          model: 'fixture',
          max_tokens: 128,
          system: [{ type: 'text', text: 'Use the fixture', cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'c', name: 'format', input: {} }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'c', content: 'ok' },
                { type: 'text', text: 'original' },
              ],
            },
          ],
        },
      ],
      [
        'codex',
        'responses',
        '/v1/responses',
        { model: 'fixture', input: 'original', previous_response_id: 'resp_prior' },
      ],
    ]) {
      const ctx = { origin: 'local', agent, protocol, path, state: {} };
      await onRequest(body, ctx);
      const id = ctx.state.traceId,
        ref = 'trace:' + id,
        raw = snapshot(ref);
      expect(raw.protocol).toBe(protocol);
      expect(raw.endpoint).toBe(path);
      expect(JSON.parse(raw.request)).toEqual(body);
      const display = requestEntries(protocol, body);
      expect(display.at(-1).message.role).toBe('user');
      const tab = tabRequest('open', { ref }, upstream).tab;
      expect(tab.protocol).toBe(protocol);
      const edit = structuredClone(body);
      const key = protocol === 'responses' ? 'input' : 'messages';
      if (typeof edit[key] === 'string') edit[key] = 'edited';
      else edit[key].at(-1).content.at(-1).text = 'edited';
      const replayBody = { ...edit, model: 'alternate/native' };
      const state = { ...tab.state, draft: replayBody };
      const revision = crypto.randomUUID();
      tabRequest(
        'save',
        {
          id: tab.id,
          revision,
          patches: [
            {
              base: tab.revision,
              at: 0,
              remove: JSON.stringify(tab.state).length,
              text: JSON.stringify(state),
            },
          ],
        },
        upstream,
      );
      let run = tabRequest('send', { id: tab.id, revision }, upstream).id;
      async function completed(run) {
        for (let n = 0; n < 100; n++) {
          const s = snapshot('run:' + run);
          if (s.status !== 'running') {
            expect(s.status).toBe('complete');
            return JSON.parse(s.reply);
          }
          await Bun.sleep(10);
        }
        throw Error('Run timed out');
      }
      const reply = await completed(run);
      expect(responseMessages(protocol, reply)[0].content[0].text).toBe('done');
      expect(nativeCalls.at(-1).path).toBe(path);
      expect(nativeCalls.at(-1).body).toEqual(replayBody);
      if (protocol === 'anthropic')
        expect(nativeCalls.at(-1).headers.get('anthropic-version')).toBe('2023-06-01');
      const d = editTrace({ ref, ops: [{ op: 'replace', path: '/' + key, value: edit[key] }] });
      run = repeatTrace(
        { ref: d.draft_ref, request_key: crypto.randomUUID() },
        upstream,
      ).run_ref.slice(4);
      await completed(run);
      expect(nativeCalls.at(-1).body).toEqual(edit);
      expect(nativeCalls.at(-1).path).toBe(path);
    }
  } finally {
    await gateway.stop(true);
  }
});
test('native SSE preserves content, thinking, tool inputs, outcome and usage; rejects truncated streams', async () => {
  function stream(events) {
    const data = new TextEncoder().encode(
      events
        .map((e) => 'event: ' + e.type + '\r\ndata: ' + JSON.stringify(e) + '\r\n\r\n')
        .join(''),
    );
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < data.length; i += 9) c.enqueue(data.slice(i, i + 9));
          c.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  }
  const block = (i, b, ds) => [
    { type: 'content_block_start', index: i, content_block: b },
    ...ds.map((delta) => ({ type: 'content_block_delta', index: i, delta })),
    { type: 'content_block_stop', index: i },
  ];
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 6 },
      },
    },
    ...block(0, { type: 'thinking', thinking: '', signature: '' }, [
      { type: 'thinking_delta', thinking: 'idea' },
      { type: 'signature_delta', signature: 'sig' },
    ]),
    ...block(1, { type: 'text', text: '' }, [{ type: 'text_delta', text: '完成' }]),
    ...block(2, { type: 'tool_use', id: 'c', name: 'format', input: {} }, [
      { type: 'input_json_delta', partial_json: '{"n":' },
      { type: 'input_json_delta', partial_json: '2}' },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  const m = await readReply(stream(events), 'anthropic');
  expect(m.content.map((x) => x.type)).toEqual(['thinking', 'text', 'tool_use']);
  expect(m.content[0].signature).toBe('sig');
  expect(m.content[1].text).toBe('完成');
  expect(m.content[2].input).toEqual({ n: 2 });
  expect(m.usage).toEqual({ input_tokens: 6, output_tokens: 10 });
  await expect(readReply(stream(events.slice(0, -1)), 'anthropic')).rejects.toThrow('interrupted');
  const item = { type: 'function_call', call_id: 'c', name: 'format', arguments: '{"x":2}' };
  const done = { type: 'response.output_item.done', output_index: 0, item };
  const resp = await readReply(
    stream([
      done,
      { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item] } },
    ]),
    'responses',
  );
  expect(resp.output).toEqual([item]);
  await expect(readReply(stream([done]), 'responses')).rejects.toThrow('interrupted');
});

test('session tree API indexes requests by session ID and rejects requests without one', async () => {
  const { recordState } = await import('../trace-api.js');
  const { backfillChains } = await import('../session-tree.js');
  recordState('start', { agents: ['codex', 'claude', 'artex'] });
  const msg = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
  const turn = async (agent, protocol, session, body) => {
    const ctx = { origin: 'local', agent, protocol, session, state: {} };
    await onRequest(body, ctx);
    return ctx.state.traceId;
  };
  const base = [msg('developer', 'context'), msg('user', 'task')];
  const one = [...base, { ...msg('assistant', 'step'), id: 'msg_1' }];
  const first = await turn('codex', 'responses', 'tree-thread', { model: 'm', input: base });
  const next = await turn('codex', 'responses', 'tree-thread', {
    model: 'm',
    input: [...one, msg('user', 'more')],
  });
  const compacted = await turn('codex', 'responses', 'tree-thread', {
    model: 'm',
    input: [msg('developer', 'context'), msg('user', 'summary')],
  });
  await turn('artex', 'chat', '', { model: 'm', messages: [{ role: 'user', content: 'x' }] });
  recordState('stop');
  expect(backfillChains(50)).toBeGreaterThanOrEqual(3);
  const server = startService({ port, uiKey }, { upstream: mock.url.href, restoreMcp: false });
  try {
    const [code, tree] = await api('sessions/tree?agent=codex&session=tree-thread');
    expect(code).toBe(200);
    expect(tree.nodes.map((n) => [n.id, n.kind, n.parent, n.main])).toEqual([
      [first, 'root', null, true],
      [next, 'turn', first, true],
      [compacted, 'compacted', next, true],
    ]);
    expect((await api('sessions/tree?agent=artex&session='))[0]).toBe(400);
    const listed = (await api('list?type=capture'))[1].calls;
    const group = listed.find((r) => r.entry_type === 'session' && r.session === 'tree-thread');
    expect(group).toMatchObject({ agent: 'codex', requests: 3, title: 'task', status: 'pending' });
    expect(group.latest.id).toBe(compacted);
    expect(listed.some((r) => r.agent === 'artex' && r.entry_type === 'capture')).toBe(true);
    const found = (await api('list?q=' + encodeURIComponent('request:summary')))[1].calls;
    expect(found.filter((r) => r.session === 'tree-thread').map((r) => r.matches.map((m) => m.id))).toEqual([[compacted]]);
  } finally {
    await server.stop(true);
  }
});

test('tabs and MCP share eight slots, queue snapshots in order and cancel only waiting runs', async () => {
  const { recordState, repeatTrace, snapshot } = await import('../trace-api.js');
  const arrived = [],
    held = new Map();
  let peak = 0;
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { messages } = await req.json();
      const id = req.headers.get('x-magpie-session').slice('replay-'.length);
      arrived.push(id);
      const fail = await new Promise((resolve) => held.set(id, resolve));
      held.delete(id);
      return fail
        ? Response.json({ error: { code: 'quota', type: 'rate_limit_error', message: 'Try later' } }, {
            status: 429, headers: { 'request-id': 'req-test', 'retry-after': '15' },
          })
        : Response.json({ choices: [{ message: messages.at(-1) }] });
    },
  });
  const upstream = gateway.url.href;
  const server = startService({ port, uiKey }, { upstream, restoreMcp: false });
  async function until(predicate) {
    for (let i = 0; i < 200; i++) {
      peak = Math.max(peak, held.size);
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw Error('Timed out waiting for replay queue');
  }
  try {
    recordState('start', { agents: ['replay-queue'] });
    const ctx = { origin: 'local', protocol: 'chat', agent: 'replay-queue', state: {} };
    await onRequest({ model: 'mock', messages: [{ role: 'user', content: 'original' }] }, ctx);
    const ref = 'trace:' + ctx.state.traceId;
    const tab = (await api('tabs/open', { ref }))[1].tab;
    const copy = (await api('tabs/duplicate', { id: tab.id }))[1].tab;
    const sendTab = async (t) => {
      const [status, run] = await api('tabs/send', { id: t.id, revision: t.revision });
      expect(status).toBe(200);
      return run.id;
    };
    const originals = [];
    for (let i = 0; i < 7; i++) originals.push(await sendTab(tab));
    originals.push(await sendTab(copy));
    await until(() => held.size === 8);
    const key = { ref, request_key: crypto.randomUUID() };
    const ninth = repeatTrace(key, upstream);
    expect(ninth.status).toBe('queued');
    expect(repeatTrace(key, upstream)).toEqual(ninth);
    const mcpId = ninth.run_ref.slice(4);
    const tenth = await sendTab(tab);
    const canceled = await sendTab(copy);
    expect((await api('cancel/' + canceled, {}))[1].status).toBe('canceled');
    expect((await api('cancel/' + originals[0], {}))[0]).toBe(400);
    const revision = crypto.randomUUID();
    const text = JSON.stringify(tab.state);
    const edited = {
      ...tab.state,
      draft: { ...tab.state.draft, messages: [{ role: 'user', content: 'edited' }] },
    };
    expect(
      (
        await api('tabs/save', {
          id: tab.id,
          revision,
          patches: [
            { base: tab.revision, at: 0, remove: text.length, text: JSON.stringify(edited) },
          ],
        })
      )[0],
    ).toBe(200);
    const last = await sendTab({ ...tab, revision });
    await api('tabs/pick', { id: tab.id, run: tenth });
    expect(arrived).toHaveLength(8);
    for (const [slot, next, fail] of [
      [6, mcpId, true],
      [2, tenth, false],
      [7, last, false],
    ]) {
      held.get(originals[slot])(fail);
      await until(() => held.has(next));
      expect(arrived.at(-1)).toBe(next);
    }
    for (const release of held.values()) release(false);
    await until(() => !storage().query('SELECT 1 FROM replay_jobs LIMIT 1').get());
    expect(peak).toBe(8);
    expect(arrived).not.toContain(canceled);
    const failed = (await api('snapshot/' + originals[6]))[1];
    expect(failed.status).toBe('failed');
    expect(failed.failure).toMatchObject({
      http: 429, code: 'quota', type: 'rate_limit_error', message: 'Try later',
      requestId: 'req-test', retryAfter: '15',
    });
    expect(JSON.parse(failed.failure.raw).error.code).toBe('quota');
    expect((await api('snapshot/' + last))[1].failure).toBeNull();
    for (const [id, content] of [
      [mcpId, 'original'],
      [tenth, 'original'],
      [last, 'edited'],
    ]) {
      const s = snapshot('run:' + id);
      expect(JSON.parse(s.request).messages.at(-1).content).toBe(content);
      expect(JSON.parse(s.reply).choices[0].message.content).toBe(content);
    }
    const restored = (await api('tabs/select', { id: tab.id }))[1].tab;
    expect(restored.selected_run).toBe(tenth);
    expect(restored.state.draft).toEqual(edited.draft);
    expect((await api('tabs/runs?id=' + copy.id))[1].runs.map((r) => r.id)).toEqual([
      originals[7],
      canceled,
    ]);
  } finally {
    for (const release of held.values()) release(false);
    await server.stop(true);
    await gateway.stop(true);
  }
});

test('replay failures keep protocol error codes and bound non-JSON gateway errors', async () => {
  const error = { type: 'overloaded_error', code: 'busy', message: 'Overloaded' };
  for (const protocol of ['chat', 'anthropic', 'responses']) {
    const event = protocol === 'responses' ? { type: 'error', code: error.code, message: error.message } : { type: 'error', error };
    const stream = new Response('data: ' + JSON.stringify(event) + '\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    for (const response of [Response.json({ error }), stream]) {
      const failure = await readReply(response, protocol).catch((e) => e);
      expect(failure.message).toBe('Overloaded');
      expect((failure.envelope.error ?? failure.envelope).code).toBe('busy');
    }
  }
  const failed = { status: 'failed', output: [], error };
  expect(await readReply(Response.json(failed), 'responses')).toEqual(failed);
  const large = await readReply(new Response('x'.repeat(9000), { status: 502 })).catch((e) => e);
  expect(large.raw.length).toBe(8192);
  expect(large.truncated).toBe(true);
});

test('old captures and replay snapshots gain independent summaries without rewriting wire bodies', async () => {
  const {backfillPreviews} = await import('../store.js');
  const db = storage();
  const id=crypto.randomUUID(), exp=crypto.randomUUID(), run=crypto.randomUUID();
  const body=(name)=>JSON.stringify({input:[{type:'function_call',call_id:'1',name},
    {type:'function_call_output',call_id:'1',output:'done'}]});
  const reply=JSON.stringify({output:[{role:'assistant',phase:'final_answer',content:[{text:'Ready'}]}]});
  db.query("INSERT INTO calls(id,session,model,started,status,request,reply,owner,protocol,last_preview) VALUES(?,'','m',0,'complete',?,?,0,'responses','stale')").run(id,body('one'),reply);
  db.query('INSERT INTO experiments VALUES(?,?,0,?)').run(exp,id,body('two'));
  db.query("INSERT INTO runs(id,experiment_id,kind,started,status,owner,reply) VALUES(?,?,'send',0,'complete',0,?)").run(run,exp,reply);
  while(backfillPreviews(2,db)) {}
  expect(db.query('SELECT request,reply,last_preview,final_preview FROM calls WHERE id=?').get(id))
    .toEqual({request:body('one'),reply,last_preview:'one · done',final_preview:'Ready'});
  expect(db.query('SELECT last_preview,final_preview FROM runs WHERE id=?').get(run))
    .toEqual({last_preview:'two · done',final_preview:'Ready'});
});
