import { endpointFor } from './ui/protocols.js';
import { requestPreview } from './ui/messages.js';
import { finalPreview } from './ui/response-items.js';
import { sessionRowId } from './ui/session-graph.js';
import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { protocolFailure } from './gateway-outcome.js';

export const outcomeEvents = new EventTarget();

function defaultDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'D-message');
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'D-message');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'D-message');
}
export const dataDir = process.env.D_MESSAGE_DATA_DIR || defaultDataDir();
let shared;

export function isReplayAgent(id) {
  return /^(?:d-message|tracefork)$/i.test(id);
}

export function storage() {
  if (shared) return shared;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'traces.sqlite');
  const db = new Database(file, { create: true, strict: true });
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_options(kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,value));
    CREATE TABLE IF NOT EXISTS calls(
      id TEXT PRIMARY KEY, session TEXT NOT NULL, model TEXT NOT NULL, started INTEGER NOT NULL,
      ended INTEGER, status TEXT NOT NULL, request TEXT NOT NULL, reply TEXT, owner INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_time ON calls(started DESC);
    CREATE TABLE IF NOT EXISTS experiments(
      id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id), created INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS experiments_call ON experiments(call_id,created DESC);
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), kind TEXT NOT NULL,
      started INTEGER NOT NULL, ended INTEGER, status TEXT NOT NULL, reply TEXT, error TEXT, owner INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_chats(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,target TEXT NOT NULL,
      state TEXT NOT NULL,base TEXT NOT NULL,workdir TEXT NOT NULL,marker TEXT NOT NULL,error TEXT,
      access_key TEXT,native_id TEXT,owner INTEGER,approved_command TEXT,tool_receipt TEXT);
    CREATE TABLE IF NOT EXISTS dsh_dispatches(
      id TEXT PRIMARY KEY,call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,origin TEXT NOT NULL,plan TEXT NOT NULL,child TEXT,state TEXT NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS codex_dispatches(
      id TEXT PRIMARY KEY,call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,digest TEXT NOT NULL,
      stage TEXT NOT NULL,input TEXT NOT NULL,child TEXT);
    CREATE TABLE IF NOT EXISTS replay_jobs(
      run_id TEXT PRIMARY KEY, destination TEXT NOT NULL, owner INTEGER);
    CREATE INDEX IF NOT EXISTS replay_jobs_owner ON replay_jobs(owner);
    CREATE TABLE IF NOT EXISTS repeater_tabs(
      id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id), source_ref TEXT NOT NULL,
      name TEXT NOT NULL, closed INTEGER, revision TEXT NOT NULL, state TEXT NOT NULL,
      selected_run TEXT NOT NULL DEFAULT 'original', run_view TEXT);
    CREATE INDEX IF NOT EXISTS tabs_source ON repeater_tabs(source_ref);
    CREATE TABLE IF NOT EXISTS repeat_keys(request_key TEXT PRIMARY KEY, source_ref TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id));
    CREATE TABLE IF NOT EXISTS call_chain(
      call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE, version INTEGER NOT NULL, chain BLOB NOT NULL);
    PRAGMA foreign_keys=ON;`);
  db.transaction(() => {
    if (!db.query('PRAGMA table_info(repeater_tabs)').all().some((column) => column.name === 'run_view'))
      db.exec('ALTER TABLE repeater_tabs ADD COLUMN run_view TEXT');
    const chatColumns = db.query('PRAGMA table_info(agent_chats)').all().map(c => c.name);
    for (const [name, type] of [['access_key','TEXT'], ['native_id','TEXT'], ['owner','INTEGER'], ['approved_command','TEXT'], ['tool_receipt','TEXT']]) {
      if (!chatColumns.includes(name)) db.exec('ALTER TABLE agent_chats ADD COLUMN ' + name + ' ' + type);
    }
    db.exec('CREATE INDEX IF NOT EXISTS agent_chats_run ON agent_chats(run_id, target)');
    const columns = db
      .query('PRAGMA table_info(calls)')
      .all()
      .map((c) => c.name);
    if (!columns.includes('protocol'))
      db.exec("ALTER TABLE calls ADD COLUMN protocol TEXT NOT NULL DEFAULT 'chat'");
    if (!columns.includes('endpoint'))
      db.exec("ALTER TABLE calls ADD COLUMN endpoint TEXT NOT NULL DEFAULT '/v1/chat/completions'");
    if (!columns.includes('agent')) db.exec('ALTER TABLE calls ADD COLUMN agent TEXT');
    if (!columns.includes('failure')) db.exec('ALTER TABLE calls ADD COLUMN failure TEXT');
    db.exec("CREATE INDEX IF NOT EXISTS calls_checking ON calls(started) WHERE status IN ('checking','checking_unknown')");
    db.exec('CREATE INDEX IF NOT EXISTS calls_thread ON calls(agent, session, started)');
    db.exec("CREATE INDEX IF NOT EXISTS calls_pending ON calls(started,owner) WHERE status='pending'");
    if (!columns.includes('last_role')) db.exec('ALTER TABLE calls ADD COLUMN last_role TEXT');
    if (!columns.includes('last_preview'))
      db.exec('ALTER TABLE calls ADD COLUMN last_preview TEXT');
    const runColumns = db
      .query('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name);
    if (!runColumns.includes('tab_id'))
      db.exec(
        'ALTER TABLE runs ADD COLUMN tab_id TEXT REFERENCES repeater_tabs(id) ON DELETE SET NULL',
      );
    if (!runColumns.includes('failure')) db.exec('ALTER TABLE runs ADD COLUMN failure TEXT');
    if (!runColumns.includes('model')) db.exec('ALTER TABLE runs ADD COLUMN model TEXT');
    db.exec("CREATE INDEX IF NOT EXISTS runs_inflight ON runs(owner) WHERE status='running'");
    db.exec('CREATE INDEX IF NOT EXISTS runs_tab ON runs(tab_id, started)');
    if (!runColumns.includes('last_role')) db.exec('ALTER TABLE runs ADD COLUMN last_role TEXT');
    if (!runColumns.includes('last_preview'))
      db.exec('ALTER TABLE runs ADD COLUMN last_preview TEXT');
    for (const [table, names] of [['calls', columns], ['runs', runColumns]]) {
      if (!names.includes('final_preview')) db.exec('ALTER TABLE ' + table + ' ADD COLUMN final_preview TEXT');
      if (!names.includes('preview_version')) db.exec('ALTER TABLE ' + table + ' ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 0');
      db.exec('CREATE INDEX IF NOT EXISTS ' + table + '_old_previews ON ' + table + '(preview_version) WHERE preview_version=0');
    }
    // Trace metadata stays in small covering indexes, apart from the wire bodies.
    db.exec(`CREATE INDEX IF NOT EXISTS calls_list ON calls(
        id,session,agent,model,protocol,started,ended,status,preview_version,endpoint,
        last_role,last_preview,final_preview,octet_length(request));
      CREATE INDEX IF NOT EXISTS runs_list ON runs(
        id,experiment_id,kind,started,ended,status,model,preview_version,last_role,last_preview,final_preview);
      CREATE INDEX IF NOT EXISTS experiments_list ON experiments(id,call_id,octet_length(body));
      CREATE INDEX IF NOT EXISTS calls_session_title ON calls(agent,session,started,last_preview)
        WHERE last_role='user' AND last_preview<>'' AND substr(last_preview,1,1)<>'<';`);
  }).immediate();
  shared = db;
  return db;
}

// Decode historical bodies outside the writer transaction. A completion racing the
// backfill keeps its own response preview and the row is retried on the next pass.
export function backfillPreviews(limit = 12, db = storage()) {
  let remaining = limit;
  for (const table of ['calls', 'runs']) {
    const rows = db.query(table === 'calls'
      ? 'SELECT id,protocol,request,reply,ended FROM calls WHERE preview_version=0 ORDER BY rowid DESC LIMIT ?'
      : `SELECT r.id,c.protocol,CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request,
          r.reply,r.ended FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
          WHERE r.preview_version=0 ORDER BY r.rowid DESC LIMIT ?`).all(remaining);
    const updates = rows.map(row => {
      const summary = requestPreview(row.protocol, JSON.parse(row.request));
      return [summary.role, summary.text, finalPreview(JSON.parse(row.reply)), row.id, row.ended];
    });
    if (updates.length) {
      const update = db.query('UPDATE ' + table + ' SET last_role=?,last_preview=?,final_preview=?,preview_version=1 WHERE id=? AND ended IS ? AND preview_version=0');
      db.transaction(() => { for (const values of updates) update.run(...values); }).immediate();
    }
    remaining -= rows.length;
    if (!remaining) break;
  }
  return limit - remaining;
}

export function clearedThrough(db) {
  return Number(
    db.query("SELECT value FROM settings WHERE key='cleared_cursor'").get()?.value || 0,
  );
}
export function captureCursor(db) {
  return Math.max(
    clearedThrough(db),
    db.query('SELECT COALESCE(MAX(rowid),0) AS n FROM calls').get().n,
  );
}

const splitKeys = new Set(['trace-flat', 'trace-session', 'session-tree', 'repeater-wide', 'repeater-stacked']);
const detailTabs = new Set(['Request', 'Reply', 'History']);
const legacyDetailTabs = new Map([
  ['This turn', { tab: 'Request' }],
  ['Messages', { tab: 'History' }],
  ['Full JSON', { tab: 'Request', requestRaw: true }],
  ['Response', { tab: 'Reply' }],
]);
const splitPrefix = 'ui_split:';
const tabPrefix = 'ui_detail_tab:';
const tabKey = ({ agent, session }) => tabPrefix + sessionRowId(agent, session);

export function layoutPreferences(db) {
  const rows = db.query("SELECT key,value FROM settings WHERE key GLOB 'ui_split:*'").all();
  return Object.fromEntries(rows.map(({ key, value }) => [key.slice(splitPrefix.length), Number(value)]));
}

export function sessionDetailView(db, row) {
  if (!row.session) return;
  const saved = db.query('SELECT value FROM settings WHERE key=?').get(tabKey(row))?.value;
  if (saved) return legacyDetailTabs.get(saved) ?? JSON.parse(saved);
}

export function saveViewPreference(db, preference) {
  const save = db.query('INSERT OR REPLACE INTO settings VALUES (?,?)');
  if (splitKeys.has(preference?.split)) {
    const { split, percent } = preference;
    if (!Number.isFinite(percent) || percent < 25 || percent > 75)
      throw Error('Invalid pane size.');
    save.run(splitPrefix + split, String(percent));
    return {};
  }
  const { record, tab, requestRaw, replyRaw } = preference ?? {};
  if (typeof record !== 'string' || !detailTabs.has(tab) ||
      typeof requestRaw !== 'boolean' || typeof replyRaw !== 'boolean')
    throw Error('Invalid view preference.');
  return db.transaction(() => {
    const row = db.query(`SELECT agent,session FROM calls WHERE id=?
      UNION ALL
      SELECT c.agent,c.session FROM runs r JOIN experiments e ON e.id=r.experiment_id
      JOIN calls c ON c.id=e.call_id WHERE r.id=? LIMIT 1`).get(record, record);
    if (!row?.session) throw Error('This record has no session.');
    save.run(tabKey(row), JSON.stringify({ tab, requestRaw, replyRaw }));
    return {};
  }).immediate();
}

export function clearHistory(db) {
  return db
    .transaction(() => {
      const cursor = captureCursor(db);
      db.query("DELETE FROM settings WHERE key='repeater_active'").run();
      db.query("DELETE FROM settings WHERE key GLOB 'ui_detail_tab:*'").run();
      db.exec(
        'DELETE FROM replay_jobs WHERE owner IS NULL; DELETE FROM repeat_keys; DELETE FROM runs; DELETE FROM repeater_tabs; DELETE FROM experiments; DELETE FROM call_chain; DELETE FROM calls;',
      );
      db.query("INSERT OR REPLACE INTO settings VALUES ('cleared_cursor',?)").run(String(cursor));
      return { clearedThrough: cursor };
    })
    .immediate();
}
export function recording(db = storage()) {
  return db.query("SELECT value FROM settings WHERE key='recording'").get()?.value === '1';
}
const agentChoices =
  `SELECT DISTINCT choice.value FROM capture_options choice
   WHERE choice.kind IN ('connected_agent','history_agent','manual_agent')
     AND NOT EXISTS(SELECT 1 FROM capture_options hidden
       WHERE hidden.kind='hidden_agent' AND hidden.value=choice.value)
   ORDER BY choice.value`;
export function captureChoices(db) {
  return {
    agents: db
      .query(agentChoices)
      .all()
      .map((r) => r.value),
  };
}
export function captureScope(db, pinDefault = false) {
  const saved = db.query("SELECT value FROM settings WHERE key='capture_scope'").get();
  if (saved) return { agents: JSON.parse(saved.value).agents };
  const first = db.query(agentChoices + ' LIMIT 1').get();
  const scope = { agents: first ? [first.value] : [] };
  // Caller holds a write transaction when pinning the first available client.
  if (pinDefault && first) saveScope(db, scope);
  return scope;
}
export function saveScope(db, scope) {
  db.query("INSERT OR REPLACE INTO settings VALUES ('capture_scope',?)").run(JSON.stringify(scope));
}
export function editCaptureChoices(db, add, remove) {
  const insert = db.query('INSERT OR IGNORE INTO capture_options(kind,value) VALUES(?,?)');
  const deleteChoice = db.query('DELETE FROM capture_options WHERE kind=? AND value=?');
  for (const id of add) {
    deleteChoice.run('hidden_agent', id);
    insert.run('manual_agent', id);
  }
  for (const id of remove) {
    deleteChoice.run('manual_agent', id);
    insert.run('hidden_agent', id);
  }
}
export function setRecording(enabled, db = storage()) {
  if (enabled) captureScope(db, true);
  db.query("INSERT OR REPLACE INTO settings VALUES ('recording',?)").run(enabled ? '1' : '0');
}
export function startCall(body, session, agent, protocol = 'chat', path) {
  const db = storage();
  return db
    .transaction(() => {
      const model = body.model || '';
      if (!recording(db)) return null;
      const scope = captureScope(db, true);
      if (scope.agents !== 'all' && !scope.agents.includes(agent)) return null;
      const id = crypto.randomUUID(),
        last = requestPreview(protocol, body);
      db.query(
        `INSERT INTO calls(rowid,id,session,agent,model,started,status,request,owner,last_role,last_preview,protocol,endpoint,preview_version)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,1)`,
      ).run(
        captureCursor(db) + 1,
        id,
        session || '',
        agent,
        model,
        Date.now(),
        JSON.stringify(body),
        process.pid,
        last.role,
        last.text,
        protocol,
        endpointFor(protocol, path),
      );
      return id;
    })
    .immediate();
}
export function endCall(id, reply, success, protocol = 'chat') {
  const direct = protocolFailure(reply);
  let status;
  if (direct) status = 'failed';
  else if (protocol === 'responses' && reply?.status === 'incomplete') status = 'incomplete';
  else if (success === false || reply?.status === 'failed') status = 'checking';
  else status = success === true ? 'complete' : 'checking_unknown';
  const updated = storage()
    .query(
      `UPDATE calls SET ended=?,status=?,reply=?,final_preview=?,failure=? WHERE id=? AND
        (status IN ('pending','checking_unknown','unconfirmed') OR
        (reply IS NULL AND (status='complete' OR (status IN ('incomplete','failed','canceled') AND ended IS NULL))))`,
    )
    .run(Date.now(), status, reply == null ? null : JSON.stringify(reply), finalPreview(reply),
      direct ? JSON.stringify(direct.failure) : null, id);
  if (updated.changes && status.startsWith('checking')) outcomeEvents.dispatchEvent(new Event('checking'));
}

export function checkLegacyOutcome(db, id) {
  if (db.query("UPDATE calls SET status='checking_unknown' WHERE id=? AND status='incomplete' AND reply IS NULL")
    .run(id).changes) outcomeEvents.dispatchEvent(new Event('checking'));
}

export function reconcile() {
  const db = storage();
  for (const { owner } of db
    .query("SELECT DISTINCT owner FROM calls WHERE status='pending'")
    .all()) {
    if (ownerExited(owner))
      db.query("UPDATE calls SET status='checking_unknown' WHERE status='pending' AND owner=?").run(
        owner,
      );
  }
  reconcileReplays(db);
}

function ownerExited(owner) {
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export function reconcileReplays(db) {
  const owners = db
    .query(
      `SELECT owner FROM replay_jobs WHERE owner IS NOT NULL
    UNION SELECT owner FROM runs WHERE status='running'`,
    )
    .all();
  for (const { owner } of owners) {
    if (!ownerExited(owner)) continue;
    db.transaction(() => {
      db.query(
        "UPDATE runs SET status='interrupted',ended=?,error=? WHERE status='running' AND owner=?",
      ).run(Date.now(), 'Replay host stopped before the response was saved.', owner);
      db.query('DELETE FROM replay_jobs WHERE owner=?').run(owner);
    }).immediate();
  }
}
