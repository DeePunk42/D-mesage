import { requestEntries, endpointFor } from './ui/protocols.js';
import { messagePreview } from './ui/messages.js';
import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    CREATE TABLE IF NOT EXISTS repeater_tabs(
      id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id), source_ref TEXT NOT NULL,
      name TEXT NOT NULL, closed INTEGER, revision TEXT NOT NULL, state TEXT NOT NULL,
      selected_run TEXT NOT NULL DEFAULT 'original');
    CREATE INDEX IF NOT EXISTS tabs_source ON repeater_tabs(source_ref);
    CREATE TABLE IF NOT EXISTS repeat_keys(request_key TEXT PRIMARY KEY, source_ref TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id));
    PRAGMA foreign_keys=ON;`);
  db.transaction(() => {
    const columns = db
      .query('PRAGMA table_info(calls)')
      .all()
      .map((c) => c.name);
    if (!columns.includes('protocol'))
      db.exec("ALTER TABLE calls ADD COLUMN protocol TEXT NOT NULL DEFAULT 'chat'");
    if (!columns.includes('endpoint'))
      db.exec("ALTER TABLE calls ADD COLUMN endpoint TEXT NOT NULL DEFAULT '/v1/chat/completions'");
    if (!columns.includes('agent')) db.exec('ALTER TABLE calls ADD COLUMN agent TEXT');
    if (!columns.includes('last_role')) db.exec('ALTER TABLE calls ADD COLUMN last_role TEXT');
    if (!columns.includes('last_preview'))
      db.exec('ALTER TABLE calls ADD COLUMN last_preview TEXT');
    const refreshPreviews = !db.query("SELECT 1 FROM settings WHERE key='preview_en_v1'").get();
    const update = db.query('UPDATE calls SET last_role=?,last_preview=? WHERE id=?');
    for (const row of db
      .query('SELECT id,request,protocol FROM calls WHERE last_role IS NULL OR ?')
      .iterate(Number(refreshPreviews))) {
      const msg = requestEntries(row.protocol, JSON.parse(row.request)).at(-1)?.message;
      update.run(msg?.role || '', messagePreview(msg), row.id);
    }
    const runColumns = db
      .query('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name);
    if (!runColumns.includes('tab_id'))
      db.exec(
        'ALTER TABLE runs ADD COLUMN tab_id TEXT REFERENCES repeater_tabs(id) ON DELETE SET NULL',
      );
    if (!runColumns.includes('model')) db.exec('ALTER TABLE runs ADD COLUMN model TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS runs_tab ON runs(tab_id, started)');
    if (!runColumns.includes('last_role')) db.exec('ALTER TABLE runs ADD COLUMN last_role TEXT');
    if (!runColumns.includes('last_preview'))
      db.exec('ALTER TABLE runs ADD COLUMN last_preview TEXT');
    const updateRun = db.query('UPDATE runs SET last_role=?,last_preview=? WHERE id=?');
    for (const row of db
      .query(
        `SELECT r.id,c.protocol,
      CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request
      FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
      WHERE r.last_role IS NULL OR ?`,
      )
      .iterate(Number(refreshPreviews))) {
      const msg = requestEntries(row.protocol, JSON.parse(row.request)).at(-1)?.message;
      updateRun.run(msg?.role || '', messagePreview(msg), row.id);
    }
    if (refreshPreviews) db.query("INSERT INTO settings VALUES ('preview_en_v1','1')").run();
  }).immediate();
  shared = db;
  return db;
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
export function clearHistory(db) {
  return db
    .transaction(() => {
      const cursor = captureCursor(db);
      db.query("DELETE FROM settings WHERE key='repeater_active'").run();
      db.exec(
        'DELETE FROM repeat_keys; DELETE FROM runs; DELETE FROM repeater_tabs; DELETE FROM experiments; DELETE FROM calls;',
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
  "SELECT DISTINCT value FROM capture_options WHERE kind IN ('agent','connected_agent','history_agent') ORDER BY value";
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
export function setRecording(enabled, db = storage()) {
  if (enabled) captureScope(db, true);
  db.query("INSERT OR REPLACE INTO settings VALUES ('recording',?)").run(enabled ? '1' : '0');
}
export function startCall(body, session, agent, protocol = 'chat', path) {
  const db = storage();
  return db
    .transaction(() => {
      const observe = db.query('INSERT OR IGNORE INTO capture_options(kind,value) VALUES(?,?)');
      observe.run('agent', agent);
      const model = body.model || '';
      if (!recording(db)) return null;
      const scope = captureScope(db, true);
      if (scope.agents !== 'all' && !scope.agents.includes(agent)) return null;
      const id = crypto.randomUUID(),
        last = requestEntries(protocol, body).at(-1)?.message;
      db.query(
        `INSERT INTO calls(rowid,id,session,agent,model,started,status,request,owner,last_role,last_preview,protocol,endpoint)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
      ).run(
        captureCursor(db) + 1,
        id,
        session || '',
        agent,
        model,
        Date.now(),
        JSON.stringify(body),
        process.pid,
        last?.role || '',
        messagePreview(last),
        protocol,
        endpointFor(protocol, path),
      );
      return id;
    })
    .immediate();
}
export function endCall(id, reply, success, protocol = 'chat') {
  const status =
    protocol === 'responses' && ['incomplete', 'failed'].includes(reply?.status)
      ? reply.status
      : success && reply
        ? 'complete'
        : 'incomplete';
  storage()
    .query(
      "UPDATE calls SET ended=?,status=?,reply=? WHERE id=? AND status IN ('pending','incomplete')",
    )
    .run(Date.now(), status, reply == null ? null : JSON.stringify(reply), id);
}

export function reconcile() {
  const db = storage();
  for (const table of ['calls', 'runs']) {
    const pending = table === 'calls' ? 'pending' : 'running';
    for (const row of db.query(`SELECT DISTINCT owner FROM ${table} WHERE status=?`).all(pending)) {
      try {
        process.kill(row.owner, 0);
      } catch (e) {
        if (e.code === 'ESRCH')
          db.query(`UPDATE ${table} SET status='incomplete' WHERE status=? AND owner=?`).run(
            pending,
            row.owner,
          );
      }
    }
  }
  // Magpie expires outstanding hook state after 15 minutes. A late callback can still finalize the row.
  db.query("UPDATE calls SET status='incomplete' WHERE status='pending' AND started<?").run(
    Date.now() - 16 * 60 * 1000,
  );
}
