import { McpListener } from './mcp.js';
import { timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  storage,
  recording,
  captureScope,
  clearedThrough,
  clearHistory,
  dataDir,
  reconcile,
} from './store.js';
import { gatewayAgents } from './agent-catalog.js';
import { recordState, snapshot } from './trace-api.js';
import { tabRequest } from './repeater-tabs.js';
import { launch } from './replay.js';
import { traceSearch } from './trace-search.js';
import { requestPatch } from './request-diff.js';
import { backfillChains, sessionTree } from './session-tree.js';
import { groupRows } from './list-groups.js';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), 'ui');
const digest = (v) => createHash('sha256').update(v).digest();
const assets = new Map([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/tab-save.js', 'tab-save.js'],
  ['/messages.js', 'messages.js'],
  ['/protocols.js', 'protocols.js'],
  ['/prompt-syntax.js', 'prompt-syntax.js'],
  ['/views.js', 'views.js'],
  ['/search.js', 'search.js'],
  ['/filter-box.js', 'filter-box.js'],
  ['/changes.js', 'changes.js'],
  ['/session-graph.js', 'session-graph.js'],
  ['/model-picker.js', 'model-picker.js'],
  ['/icons/codex.svg', 'icons/codex.svg'],
  ['/icons/claude.svg', 'icons/claude.svg'],
  ['/icons/dsh.svg', 'icons/dsh.svg'],
  ['/style.css', 'style.css'],
]);
for (const key of ['deepseek-color', 'openai', 'gemini-color', 'qwen-color', 'kimi', 'grok', 'mistral-color', 'zai', 'minimax-color']) {
  const file = `icons/${key}.svg`;
  assets.set('/' + file, file);
}
// Both branches return metadata only. A replay keeps its own ID, status and request preview.
const timeline = `WITH events AS (
  SELECT 'capture' AS entry_type, c.rowid AS seq, c.id, c.id AS call_id, c.rowid AS call_seq,
    c.session,c.agent,c.model,c.protocol,c.endpoint,c.started,c.ended,c.status,c.last_role,c.last_preview,octet_length(c.request) AS bytes
  FROM calls c
  UNION ALL
  SELECT 'repeater',r.rowid,r.id,c.id,c.rowid,c.session,c.agent,coalesce(r.model,c.model),c.protocol,c.endpoint,r.started,r.ended,r.status,
    CASE WHEN r.kind='baseline' THEN c.last_role ELSE r.last_role END,
    CASE WHEN r.kind='baseline' THEN c.last_preview ELSE r.last_preview END,
    CASE WHEN r.kind='baseline' THEN octet_length(c.request) ELSE octet_length(e.body) END
  FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
)`;
export function startService(options, overrides = {}) {
  const port = Number(options.port || 34891);
  const token = options.uiKey;
  if (!token || token.length < 32) return;
  const addr = process.env.MAGPIE_ADDR || '127.0.0.1:3425';
  const gatewayPort = new URL(addr.includes('://') ? addr : 'http://' + addr).port || '3425';
  const upstream = overrides.upstream || 'http://127.0.0.1:' + gatewayPort + '/v1/chat/completions';
  const keyHash = digest(token);
  // Keep reload tokens issued before the plugin rename valid until expiry.
  const reloadToken = (until) =>
    'reload.' +
    until +
    '.' +
    createHmac('sha256', token)
      .update('tracefork-ui-reload:' + until)
      .digest('base64url');
  const refreshAgents = gatewayAgents(upstream);
  async function captureState(action, scope) {
    if (action === 'status' || action === 'start') await refreshAgents();
    return recordState(action, scope);
  }
  const mcp = new McpListener(token, upstream, captureState);
  const search = traceSearch(resolve(dataDir, 'traces.sqlite'));
  // A title is the first user prompt that the main path went on from, so a
  // client's own side requests (titles, suggestions) never name the session.
  const titles = new Map();
  function sessionTitle(row, db) {
    const key = row.agent + '\u0000' + row.session,
      sig = row.requests + ':' + row.latest.seq;
    const cached = titles.get(key);
    if (cached?.sig === sig) return cached.title;
    let title = '';
    try {
      const prompt = sessionTree(row.agent ?? '', row.session, db).nodes.find(
        (n) =>
          n.main && n.children > 0 && n.last_role === 'user' && n.last_preview && !n.last_preview.startsWith('<'),
      );
      title = prompt?.last_preview ?? '';
    } catch {}
    title ||= row.latest.last_preview || '';
    titles.set(key, { sig, title });
    if (titles.size > 200) titles.delete(titles.keys().next().value);
    return title;
  }
  const backfill = setInterval(() => {
    try {
      backfillChains();
    } catch (error) {
      console.error('D-message: session index failed', error.message);
    }
  }, 1500);
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    idleTimeout: 30,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req) {
      let url = new URL(req.url);
      if (
        req.headers.get('host') !== '127.0.0.1:' + port &&
        req.headers.get('host') !== 'localhost:' + port
      )
        return new Response(null, { status: 403 });
      const origin = req.headers.get('origin');
      if (origin && origin !== 'null' && origin !== url.origin)
        return new Response(null, { status: 403 });
      const headers = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        Vary: 'Origin',
      };
      if (origin)
        Object.assign(headers, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        });
      const send = (obj, status = 200) => Response.json(obj, { status, headers });
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const file = Bun.file(resolve(ui, assets.get(url.pathname)));
        headers['Content-Security-Policy'] =
          "default-src 'none'; script-src 'self' " +
          url.origin +
          "; style-src 'self' " +
          url.origin +
          "; connect-src 'self' " +
          url.origin +
          "; img-src 'self' " +
          url.origin +
          "; base-uri 'none'; form-action 'none'";
        return new Response(file, { headers });
      }
      const auth = req.headers.get('authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const master = timingSafeEqual(digest(bearer), keyHash);
      if (!master) {
        const until = /^reload\.(\d{13})\.[\w-]{43}$/.exec(bearer)?.[1];
        if (
          !until ||
          Number(until) <= Date.now() ||
          !timingSafeEqual(digest(bearer), digest(reloadToken(until)))
        )
          return send({ error: 'Open D-message from the Magpie plugin page.' }, 401);
      }
      if (url.pathname === '/api/reload-token' && req.method === 'POST' && master)
        return send({ token: reloadToken(Date.now() + 12 * 60 * 60 * 1000) });
      const db = storage();
      try {
        if (req.method === 'GET' && url.pathname === '/api/sessions/tree')
          return send(
            sessionTree(url.searchParams.get('agent') || '', url.searchParams.get('session') || '', db),
          );
        if (req.method === 'GET' && url.pathname === '/api/models') {
          const res = await fetch(new URL('/v1/models', upstream), {
            headers: { Authorization: 'Bearer magpie-d-message' },
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return send({ error: 'Magpie model list returned HTTP ' + res.status }, 502);
          const { data } = await res.json();
          if (!Array.isArray(data)) return send({ error: 'Invalid Magpie model list.' }, 502);
          const models = data.filter((m) => typeof m?.id === 'string' && m.id).map((m) => {
            const name = m.display_name || m.name || m.id;
            const suffix = m.magpie_label?.startsWith(name + ' · ') && m.magpie_label.slice(name.length + 3);
            const group = /^(auto|group)\//.test(m.id) || suffix === 'routing group'
              ? 'Routing groups' : suffix || m.owned_by || 'Other';
            return { id: m.id, name, group };
          });
          return send({ models });
        }
        if (url.pathname.startsWith('/api/tabs/')) {
          const action = url.pathname.slice('/api/tabs/'.length);
          if (req.method === 'POST' && action === 'changes') {
            const { id: tabId, draft, raw } = await req.json();
            const tab = db.query('SELECT source_ref FROM repeater_tabs WHERE id=?').get(tabId);
            if (!tab) return send({ error: 'Tab not found.' }, 404);
            if (
              typeof raw !== 'string' &&
              (!draft || typeof draft !== 'object' || Array.isArray(draft))
            )
              return send({ error: 'Provide the current request draft.' }, 400);
            return send({
              hunks: requestPatch(
                snapshot(tab.source_ref).request,
                typeof raw === 'string' ? raw : JSON.stringify(draft),
                typeof raw === 'string',
              ),
            });
          }
          if (req.method === 'GET' && action === 'workspace')
            return send(tabRequest(action, {}, upstream));
          if (req.method === 'GET' && action === 'runs')
            return send(tabRequest(action, { id: url.searchParams.get('id') }, upstream));
          if (req.method === 'POST' && !['workspace', 'runs'].includes(action))
            return send(tabRequest(action, await req.json(), upstream));
          return send({ error: 'Method not allowed' }, 405);
        }
        if (url.pathname === '/api/capture-scope') {
          if (req.method === 'GET') return send(await captureState('status'));
          if (req.method === 'POST') return send(recordState('configure', await req.json()));
        }
        if (url.pathname === '/api/settings/mcp') {
          if (req.method === 'GET') return send(mcp.state());
          if (req.method === 'POST') return send(mcp.configure(await req.json()));
        }
        if (url.pathname === '/api/settings/mcp/token' && req.method === 'POST')
          return send({ token: mcp.token });
        if (url.pathname === '/api/history/clear' && req.method === 'POST') {
          if ((await req.json())?.confirmed !== true)
            return send({ error: 'Confirm before clearing trace history.' }, 400);
          return send(clearHistory(db));
        }
        if (url.pathname === '/api/list' && req.method === 'GET') {
          reconcile();
          const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0') || 0);
          const q = (url.searchParams.get('q') || '').trim();
          const status = url.searchParams.get('status') || '';
          const columns = new Map([
            ['seq', 'seq'],
            ['time', 'started'],
            ['model', 'model'],
            ['session', 'session'],
            ['status', 'status'],
            ['duration', '(ended-started)'],
            ['bytes', 'bytes'],
          ]);
          const order = columns.get(url.searchParams.get('sort')) || 'started';
          const direction = url.searchParams.get('asc') === '1' ? 'ASC' : 'DESC';
          const type = url.searchParams.get('type') || '';
          const where = "WHERE (?='' OR entry_type=?) AND (?='' OR status=?)";
          const args = [type, type, status, status];
          const sql = `${timeline} SELECT * FROM events ${where} ORDER BY ${order} ${direction},started DESC,entry_type DESC,seq DESC`;
          const page = q
            ? await search.find({ sql, args, q, offset })
            : db.transaction(() => {
                const entries = groupRows(db.query(sql).all(...args));
                return {
                  clearedThrough: clearedThrough(db),
                  calls: entries.slice(offset, offset + 100),
                  total: entries.length,
                };
              })();
          for (const row of page.calls)
            if (row.entry_type === 'session') row.title = sessionTitle(row, db);
          return send({
            recording: recording(db),
            scope: captureScope(db),
            ...page,
            more: offset + page.calls.length < page.total,
          });
        }
        if (url.pathname === '/api/recording' && req.method === 'GET')
          return send({
            recording: recording(db),
            scope: captureScope(db),
            clearedThrough: clearedThrough(db),
          });
        if (url.pathname === '/api/recording' && req.method === 'POST') {
          const { enabled } = await req.json();
          if (typeof enabled !== 'boolean') throw Error('Invalid recording state.');
          return send(await captureState(enabled ? 'start' : 'stop'));
        }
        const match = url.pathname.match(/^\/api\/(calls|runs|send|snapshot)\/([\da-f-]{36})$/);
        if (!match) return send({ error: 'Not found' }, 404);
        const [, action, id] = match;
        if (action === 'calls' && req.method === 'GET') {
          const call = db
            .query(
              "SELECT 'capture' AS entry_type,rowid AS seq,id,session,agent,model,protocol,endpoint,started,ended,status,request,reply FROM calls WHERE id=?",
            )
            .get(id);
          if (!call) return send({ error: 'Request not found' }, 404);
          return send(call);
        }
        if (action === 'runs' && req.method === 'GET') {
          reconcile();
          const runs = db
            .query(
              `SELECT r.id,r.rowid AS seq,r.kind,r.started,r.ended,r.status FROM runs r JOIN experiments e ON e.id=r.experiment_id WHERE e.call_id=? ORDER BY r.started,r.rowid`,
            )
            .all(id);
          const drafts = db
            .query(
              'SELECT e.id,e.created FROM experiments e WHERE e.call_id=? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.experiment_id=e.id) ORDER BY created',
            )
            .all(id);
          return send({ runs, drafts });
        }
        if (action === 'snapshot' && req.method === 'GET') {
          const row =
            db
              .query(
                `SELECT r.id,r.rowid AS seq,'repeater' AS entry_type,c.id AS call_id,c.rowid AS call_seq,
                  c.session,c.agent,coalesce(r.model,c.model) AS model,c.protocol,c.endpoint,r.kind,r.started,r.ended,r.status,r.reply,r.error,CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?`,
              )
              .get(id) ||
            db
              .query(
                "SELECT id,'draft' AS status,body AS request,NULL AS reply FROM experiments WHERE id=?",
              )
              .get(id);
          return row ? send(row) : send({ error: 'Record not found' }, 404);
        }
        if (action === 'send' && req.method === 'POST') {
          const call = db.query('SELECT id,model,protocol,endpoint FROM calls WHERE id=?').get(id);
          if (!call) return send({ error: 'Request not found' }, 404);
          const { body } = await req.json();
          return send({ id: launch(call, body, upstream) }, 202);
        }
        return send({ error: 'Method not allowed' }, 405);
      } catch (e) {
        return send({ error: e.message || 'Operation failed' }, 400);
      }
    },
  });
  if (overrides.restoreMcp !== false) mcp.restore();
  return {
    url: server.url,
    stop(force) {
      clearInterval(backfill);
      search.stop();
      mcp.stop(force);
      return server.stop(force);
    },
  };
}
