import { requestEntries, validRequest } from './ui/protocols.js';
import { storage, reconcile } from './store.js';
import { snapshot } from './trace-api.js';
import { launch } from './replay.js';

function setSetting(db, key, value) {
  db.query('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, value);
}
function workspace(db, defer = false) {
  const setting = (key) => db.query('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const view = setting('repeater_view') || 'trace';
  if (defer && view !== 'repeater') return { view, deferred: true };
  const tabs = db.query('SELECT id,name,source_ref,closed FROM repeater_tabs ORDER BY rowid').all();
  const active = setting('repeater_active');
  const id =
    tabs.find((t) => t.id === active && t.closed === null)?.id ??
    tabs.find((t) => t.closed === null)?.id;
  const tab =
    id &&
    db
      .query(
        `SELECT t.*, c.agent,c.protocol,c.endpoint,coalesce(r.model,c.model) AS original_model
         FROM repeater_tabs t JOIN calls c ON c.id=t.call_id
         LEFT JOIN runs r ON t.source_ref LIKE 'run:%' AND r.id=substr(t.source_ref,5) WHERE t.id=?`,
      )
      .get(id);
  if (tab) {
    tab.state = JSON.parse(tab.state);
    tab.run_view = JSON.parse(tab.run_view);
  }
  return { tabs, tab: tab || null, view };
}
function selectTab(db, id) {
  setSetting(db, 'repeater_active', id);
  setSetting(db, 'repeater_view', 'repeater');
}
function insertTab(db, callId, ref, name, state, runView = null) {
  const id = crypto.randomUUID();
  db.query(
    'INSERT INTO repeater_tabs(id,call_id,source_ref,name,state,revision,run_view) VALUES(?,?,?,?,?,?,?)',
  ).run(id, callId, ref, name, state, crypto.randomUUID(), runView);
  selectTab(db, id);
}
function openSource(db, ref) {
  if (typeof ref !== 'string' || !/^(trace|run):[a-f0-9-]{36}$/.test(ref))
    throw Error('Invalid source.');
  const existing = db
    .query(
      'SELECT id FROM repeater_tabs WHERE source_ref=? ORDER BY closed IS NULL DESC, closed DESC, rowid LIMIT 1',
    )
    .get(ref);
  if (existing) {
    db.query('UPDATE repeater_tabs SET closed=NULL WHERE id=?').run(existing.id);
    selectTab(db, existing.id);
    return;
  }
  const s = snapshot(ref);
  const draft = JSON.parse(s.request);
  const capture = ref.startsWith('trace:');
  const seq = db
    .query(
      capture
        ? 'SELECT rowid AS n FROM calls WHERE id=?'
        : 'SELECT rowid AS n FROM runs WHERE id=?',
    )
    .get(ref.split(':')[1]).n;
  const name = [(capture ? '#' : 'R') + seq, s.agent].filter(Boolean).join(' ');
  insertTab(
    db,
    s.call_id,
    ref,
    name,
    JSON.stringify({
      draft,
      open: [requestEntries(s.protocol, draft).length - 1],
      tab: 'Messages',
      field: null,
      dirty: false,
    }),
  );
}
function save(db, tab, args) {
  if (tab.closed !== null) throw Error('This tab was closed in another window.');
  if (typeof args.revision !== 'string' || !Array.isArray(args.patches))
    throw Error('Invalid draft update.');
  if (args.revision === tab.revision) return { revision: tab.revision };
  const p = args.patches.find((p) => p.base === tab.revision);
  if (!p)
    throw Error(
      'This tab changed in another window. Duplicate this draft to keep your local edits.',
    );
  if (
    !Number.isSafeInteger(p.at) ||
    !Number.isSafeInteger(p.remove) ||
    p.at < 0 ||
    p.remove < 0 ||
    p.at + p.remove > tab.state.length ||
    typeof p.text !== 'string'
  )
    throw Error('Invalid draft patch.');
  const next = tab.state.slice(0, p.at) + p.text + tab.state.slice(p.at + p.remove);
  checkState(JSON.parse(next), tab.protocol);
  db.query('UPDATE repeater_tabs SET revision=?,state=? WHERE id=?').run(
    args.revision,
    next,
    tab.id,
  );
  return { revision: args.revision };
}
function checkState(state, protocol) {
  if (
    !validRequest(protocol, state?.draft) ||
    (protocol !== 'responses' &&
      state.draft.messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) ||
    !Array.isArray(state.open) ||
    !state.open.every(Number.isInteger) ||
    (state.field != null &&
      (typeof state.field.key !== 'string' ||
        typeof state.field.text !== 'string' ||
        typeof state.field.error !== 'string' ||
        (state.field.prettySource != null && typeof state.field.prettySource !== 'string'))) ||
    (state.rTab !== undefined && !['Answer', 'Response JSON', 'Request snapshot', 'Changes'].includes(state.rTab)) ||
    !['Messages', 'Full JSON', 'Changes'].includes(state.tab)
  )
    throw Error('Invalid tab state.');
}
export function tabRequest(action, args, upstream) {
  const db = storage();
  if (action === 'workspace') return db.transaction(() => workspace(db, args.defer))();
  if (action === 'run-view') {
    if (!['Reply', 'Request snapshot'].includes(args.tab) || typeof args.raw !== 'boolean')
      throw Error('Invalid run view.');
    const view = JSON.stringify({ tab: args.tab, raw: args.raw });
    const result = db.query('UPDATE repeater_tabs SET run_view=? WHERE id=? AND closed IS NULL')
      .run(view, args.id);
    if (!result.changes) throw Error('Tab is no longer open.');
    return {};
  }
  if (action === 'runs') {
    reconcile();
    const runs = db
      .query(
        'SELECT id,rowid AS seq,started,status FROM runs WHERE tab_id=? ORDER BY started,rowid',
      )
      .all(args.id);
    const drafts = db
      .query(
        `SELECT e.id,e.created FROM experiments e JOIN repeater_tabs t ON t.call_id=e.call_id WHERE t.id=?
      AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.experiment_id=e.id) ORDER BY e.created`,
      )
      .all(args.id);
    return { runs, drafts };
  }
  if (action === 'send') {
    const tab = db
      .query(
        'SELECT t.*, c.model,c.protocol,c.endpoint FROM repeater_tabs t JOIN calls c ON c.id=t.call_id WHERE t.id=?',
      )
      .get(args.id);
    if (!tab || tab.closed !== null || tab.revision !== args.revision)
      throw Error('Save your current draft before sending.');
    const state = JSON.parse(tab.state);
    if (state.field?.error) throw Error('Correct the unfinished field before sending.');
    return {
      id: launch(
        {
          id: tab.call_id,
          model: tab.model,
          protocol: tab.protocol,
          endpoint: tab.endpoint,
          tabId: tab.id,
          revision: tab.revision,
        },
        state.draft,
        upstream,
      ),
    };
  }
  return db
    .transaction(() => {
      if (action === 'view') {
        if (!['trace', 'repeater', 'settings'].includes(args.view))
          throw Error('Invalid workspace.');
        setSetting(db, 'repeater_view', args.view);
        return {};
      }
      if (action === 'open') openSource(db, args.ref);
      else {
        const tab = db
          .query(
            'SELECT t.*, c.protocol,c.endpoint FROM repeater_tabs t JOIN calls c ON c.id=t.call_id WHERE t.id=?',
          )
          .get(args.id);
        if (!tab) throw Error('Tab no longer exists.');
        switch (action) {
          case 'save':
            return save(db, tab, args);
          case 'select':
            db.query('UPDATE repeater_tabs SET closed=NULL WHERE id=?').run(tab.id);
            selectTab(db, tab.id);
            break;
          case 'duplicate': {
            const state = args.state ?? JSON.parse(tab.state);
            checkState(state, tab.protocol);
            insertTab(db, tab.call_id, tab.source_ref, tab.name + ' copy', JSON.stringify(state), tab.run_view);
            break;
          }
          case 'rename': {
            const name = typeof args.name === 'string' && args.name.trim();
            if (!name || name.length > 100) throw Error('Use a name between 1 and 100 characters.');
            db.query('UPDATE repeater_tabs SET name=? WHERE id=?').run(name, tab.id);
            break;
          }
          case 'close':
            db.query('UPDATE repeater_tabs SET closed=? WHERE id=?').run(Date.now(), tab.id);
            break;
          case 'delete':
            if (args.confirmed !== true) throw Error('Confirm before deleting the draft.');
            db.query('DELETE FROM repeater_tabs WHERE id=?').run(tab.id);
            break;
          case 'pick': {
            if (
              args.run !== 'original' &&
              !db.query('SELECT 1 FROM runs WHERE id=? AND tab_id=?').get(args.run, tab.id) &&
              !db
                .query(
                  'SELECT 1 FROM experiments e WHERE id=? AND call_id=? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.experiment_id=e.id)',
                )
                .get(args.run, tab.call_id)
            )
              throw Error('This snapshot does not belong to this tab.');
            db.query('UPDATE repeater_tabs SET selected_run=? WHERE id=?').run(args.run, tab.id);
            return {};
          }
          default:
            throw Error('Unknown tab action.');
        }
      }
      const result = workspace(db);
      setSetting(db, 'repeater_active', result.tab?.id || '');
      return result;
    })
    .immediate();
}
