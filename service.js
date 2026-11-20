import { dshHost } from './dsh-host.js';
import { outcomeWorker } from './gateway-outcome.js';
import { createContinuations, replayAgentSettings, setReplayAgentPath } from './continue-agent.js';
import { recoverCodexOutput } from './codex-reply.js';
import { sessionTitles } from './session-titles.js';
import { McpListener } from './mcp.js';
import { timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  storage,
  checkLegacyOutcome,
  outcomeEvents,
  backfillPreviews,
  recording,
  captureScope,
  clearedThrough,
  clearHistory,
  dataDir,
  layoutPreferences,
  saveViewPreference,
  sessionDetailView,
  reconcile,
} from './store.js';
import { gatewayAgents } from './agent-catalog.js';
import { configureCaptureScope, recordState, snapshot } from './trace-api.js';
import { tabRequest } from './repeater-tabs.js';
import { launch, drainReplays, cancelQueuedRun } from './replay.js';
import { traceSearch } from './trace-search.js';
import { requestPatch } from './request-diff.js';
import { listFilter, pageRows, timeline } from './list-groups.js';
import { requestHistory } from './ui/history-page.js';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), 'ui');
const digest = (v) => createHash('sha256').update(v).digest();
const assets = new Map([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/tab-save.js', 'tab-save.js'],
  ['/messages.js', 'messages.js'],
  ['/response-items.js', 'response-items.js'],
  ['/protocols.js', 'protocols.js'],
  ['/history-page.js', 'history-page.js'],
  ['/prompt-syntax.js', 'prompt-syntax.js'],
  ['/views.js', 'views.js'],
  ['/search.js', 'search.js'],
  ['/filter-box.js', 'filter-box.js'],
  ['/changes.js', 'changes.js'],
  ['/session-graph.js', 'session-graph.js'],
  ['/model-picker.js', 'model-picker.js'],
  ['/continue-picker.js', 'continue-picker.js'],
  ['/icons/codex.svg', 'icons/codex.svg'],
  ['/icons/claude.svg', 'icons/claude.svg'],
  ['/icons/dsh.svg', 'icons/dsh.svg'],
  ['/style.css', 'style.css'],
]);
for (const key of ['deepseek-color', 'openai', 'gemini-color', 'qwen-color', 'kimi', 'grok', 'mistral-color', 'zai', 'minimax-color']) {
  const file = `icons/${key}.svg`;
  assets.set('/' + file, file);
}
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
  const titleFor = sessionTitles();
  async function captureState(action, scope) {
    if (action === 'status' || action === 'start') await refreshAgents();
    return recordState(action, scope);
  }
  const host = dshHost(undefined, resolve(dataDir, 'dsh-host.key'));
  let continuations;
  const chats = () => (continuations ??= createContinuations(storage(), {
    port, upstream, uiKey: token, refreshAgents, host, ...overrides.continuations,
  }));
  const mcp = new McpListener(token, upstream, captureState);
  const search = traceSearch(resolve(dataDir, 'traces.sqlite'));
  const sessionPages = traceSearch(resolve(dataDir, 'traces.sqlite'), 'tree');
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
          "; img-src 'self' data: " +
          url.origin +
          "; base-uri 'none'; form-action 'none'";
        return new Response(file, { headers });
      }
      if (url.pathname.startsWith('/branch/')) {
        return chats().serve(req, url.pathname, () => server.timeout(req, 0));
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
        if (url.pathname === '/api/settings/replay') {
          if (req.method === 'GET') return send(['codex','claude'].map(id => replayAgentSettings(db, id)));
          if (req.method === 'POST') {
            const {id, path} = await req.json();
            return send(setReplayAgentPath(db, id, path));
          }
        }
        if (url.pathname === '/api/settings/dsh') {
          if (req.method === 'GET') return send(await host.settings());
          if (req.method === 'POST') {
            const config = await req.json();
            return send(config.disconnect ? host.disconnect() : await host.connect(config));
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/view-preferences')
          return send(saveViewPreference(db, await req.json()));
        if (req.method === 'GET' && url.pathname === '/api/sessions/tree')
          return send(await sessionPages.find({
            agent: url.searchParams.get('agent') || '',
            session: url.searchParams.get('session') || '',
            before: url.searchParams.get('before'),
            focus: url.searchParams.get('focus'),
            activeOnly: url.searchParams.get('active') === '1',
            paged: url.searchParams.has('page'),
          }));
        const chatStatus = /^\/api\/continue-status\/([\da-f-]{36})$/.exec(url.pathname);
        if (chatStatus && req.method === 'GET') {
          const row = db.query('SELECT state,error,tool_receipt AS toolReceipt FROM agent_chats WHERE id=?').get(chatStatus[1]);
          return row ? send(row) : send({ error: 'Chat no longer exists.' }, 404);
        }
        const chatMatch = /^\/api\/continue\/((?:capture\/)?[\da-f-]{36})$/.exec(url.pathname);
        if (chatMatch && req.method === 'GET') return send(await chats().options(chatMatch[1]));
        if (chatMatch && req.method === 'POST') {
          const args = await req.json();
          if (['dsh','codex'].includes(args.target)) server.timeout(req, 0);
          return send(await chats().start(chatMatch[1], args), 202);
        }
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
            return send({
              ...tabRequest(action, { defer: url.searchParams.get('defer') === '1' }, upstream),
              splits: layoutPreferences(db),
            });
          if (req.method === 'GET' && action === 'runs')
            return send(tabRequest(action, { id: url.searchParams.get('id') }, upstream));
          if (req.method === 'POST' && !['workspace', 'runs'].includes(action))
            return send(tabRequest(action, await req.json(), upstream));
          return send({ error: 'Method not allowed' }, 405);
        }
        if (url.pathname === '/api/capture-scope') {
          if (req.method === 'GET') return send(await captureState('status'));
          if (req.method === 'POST') return send(configureCaptureScope(await req.json()));
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
          const args = [type, type, status, status];
          const page = q
            ? await search.find({
                sql: `${timeline} SELECT * FROM events ${listFilter} ORDER BY ${order} ${direction},started DESC,entry_type DESC,seq DESC`,
                args, q, offset,
              })
            : db.transaction(() => ({
                clearedThrough: clearedThrough(db),
                ...pageRows(db, order, direction, args, offset),
              }))();
          const firstPrompt = db.query(`SELECT last_preview FROM calls
            WHERE agent IS ? AND session=? AND last_role='user' AND last_preview<>'' AND substr(last_preview,1,1)<>'<'
            ORDER BY started,rowid LIMIT 1`);
          const latestCapture = db.query(`SELECT rowid AS seq FROM calls WHERE agent IS ? AND session=?
            ORDER BY started DESC,rowid DESC LIMIT 1`);
          await Promise.all(page.calls.filter(row => row.entry_type === 'session').map(async row => {
            row.title = await titleFor(row.agent, row.session) ||
              firstPrompt.get(row.agent, row.session)?.last_preview || row.latest.last_preview || '';
            // A new capture can move the active branch without matching the list filter.
            if (q || type || status)
              row.activitySeq = latestCapture.get(row.agent, row.session)?.seq;
          }));
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
        const match = url.pathname.match(/^\/api\/(calls|runs|send|snapshot|cancel)\/([\da-f-]{36})$/);
        if (!match) return send({ error: 'Not found' }, 404);
        const [, action, id] = match;
        const part = url.searchParams.get('part') || '';
        if (part && !['meta', 'request', 'reply', 'history'].includes(part))
          return send({ error: 'Invalid record part.' }, 400);
        const includeRequest = part === '' || part === 'request' || part === 'history';
        const includeReply = part === '' || part === 'reply';
        const before = url.searchParams.get('before');
        const historyPage = (row) =>
          requestHistory(row.protocol, JSON.parse(row.request))(before === null ? undefined : Number(before));
        if (action === 'calls' && req.method === 'GET') {
          if (includeReply || part === 'meta') checkLegacyOutcome(db, id);
          const call = db
            .query(
              `SELECT 'capture' AS entry_type,rowid AS seq,id,session,agent,model,protocol,endpoint,started,ended,status
               ${includeRequest ? ',request' : ''}${includeReply ? ',reply,failure' : ''} FROM calls WHERE id=?`,
            )
            .get(id);
          if (!call) return send({ error: 'Request not found' }, 404);
          if (call.failure) call.failure = JSON.parse(call.failure);
          if (part === 'history') return send(historyPage(call));
          const recovered = includeReply ? await recoverCodexOutput(call) : [];
          return send({
            ...call,
            detail_view: sessionDetailView(db, call),
            ...(recovered.length ? { recovered_output: recovered } : {}),
          });
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
        if (action === 'cancel' && req.method === 'POST') return send(cancelQueuedRun(db, id));
        if (action === 'snapshot' && req.method === 'GET') {
          const row =
            db
              .query(
                `SELECT r.id,r.rowid AS seq,'repeater' AS entry_type,c.id AS call_id,c.rowid AS call_seq,
                  c.session,c.agent,coalesce(r.model,c.model) AS model,c.protocol,c.endpoint,r.kind,r.started,r.ended,r.status
                  ${includeReply ? ',r.reply,r.error,r.failure' : ''}
                  ${includeRequest ? ",CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request" : ''}
                  FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?`,
              )
              .get(id) ||
            db
              .query(
                `SELECT id,'draft' AS status${includeRequest ? ',body AS request' : ''}
                 ${includeReply ? ',NULL AS reply' : ''} FROM experiments WHERE id=?`,
              )
              .get(id);
          if (row?.failure) row.failure = JSON.parse(row.failure);
          if (row && part === 'history') return send(historyPage(row));
          return row
            ? send({ ...row, detail_view: sessionDetailView(db, row) })
            : send({ error: 'Record not found' }, 404);
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
  const outcomes = overrides.restoreMcp !== false ? outcomeWorker(storage(), upstream) : null;
  if (outcomes) outcomeEvents.addEventListener('checking', outcomes.tick);
  function resumeJobs() {
    reconcile();
    outcomes.tick();
    drainReplays(storage());
  }
  const backfill = setInterval(() => {
    try {
      if (outcomes) resumeJobs();
      backfillPreviews();
    } catch (error) {
      console.error('D-message: background processing failed', error.message);
    }
  }, 1500);
  if (outcomes) {
    resumeJobs();
    mcp.restore();
  }
  return {
    url: server.url,
    stop(force) {
      clearInterval(backfill);
      if (outcomes) {
        outcomeEvents.removeEventListener('checking', outcomes.tick);
        outcomes.stop();
      }
      search.stop();
      sessionPages.stop();
      mcp.stop(force);
      return server.stop(force);
    },
  };
}
