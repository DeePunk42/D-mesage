import { storage } from './store.js';
import { patchRequest, snapshot } from './trace-api.js';
import { tabRequest } from './repeater-tabs.js';
import { validRequest } from './ui/protocols.js';
import { launch, cancelQueuedRun } from './replay.js';
import { requestPatch } from './request-diff.js';
import { boundedValue } from './mcp-traces.js';

function tabInfo(row) {
  return {
    tab_ref: 'tab:' + row.id,
    source_ref: row.source_ref,
    name: row.name,
    revision: row.revision,
    closed: row.closed !== null,
  };
}
function tabFor(args, checkRevision = true) {
  const row = storage()
    .query(
      `SELECT t.*,c.protocol,c.endpoint,c.model FROM repeater_tabs t
    JOIN calls c ON c.id=t.call_id WHERE t.id=?`,
    )
    .get(args.tab_ref?.slice(4) ?? '');
  if (!row || row.closed !== null) throw Error('Tab not open.');
  if (checkRevision && args.revision !== row.revision)
    throw Error('revision_conflict: current revision ' + row.revision);
  row.state = JSON.parse(row.state);
  return row;
}
export function openTab({ source_ref, duplicate }) {
  const db = storage();
  return db
    .transaction(() => {
      const open = db
        .query(
          'SELECT id,name,revision,source_ref,closed FROM repeater_tabs WHERE source_ref=? AND closed IS NULL',
        )
        .all(source_ref);
      if (open.length > 1 && !duplicate) return { choices: open.map(tabInfo) };
      return tabInfo(tabRequest('open', { ref: source_ref, duplicate }).tab);
    })
    .immediate();
}
export function repeaterTab(args) {
  const db = storage();
  if (args.action === 'list')
    return {
      tabs: db
        .query('SELECT id,name,revision,closed,source_ref FROM repeater_tabs ORDER BY rowid')
        .all()
        .map(tabInfo),
    };
  return db
    .transaction(() => {
      const tab = tabFor(args, args.action === 'edit');
      if (args.action === 'edit') {
        if (!args.ops?.length) throw Error('Provide patch operations.');
        if (tab.state.field?.error) throw Error('Resolve the unfinished page edit first.');
        const draft = patchRequest(tab.state.draft, args.ops);
        if (
          !validRequest(tab.protocol, draft) ||
          typeof draft.model !== 'string' ||
          !draft.model.trim() ||
          (tab.protocol !== 'responses' &&
            draft.messages.some((m) => !m || typeof m.role !== 'string'))
        )
          throw Error('Invalid native request.');
        tab.revision = crypto.randomUUID();
        db.query('UPDATE repeater_tabs SET state=?,revision=? WHERE id=?').run(
          JSON.stringify({ ...tab.state, draft, field: null, dirty: true }),
          tab.revision,
          tab.id,
        );
        return tabInfo(tab);
      }
      if (args.view === 'runs') {
        const runs = db
          .query('SELECT id,model,status,started FROM runs WHERE tab_id=? ORDER BY started DESC')
          .all(tab.id);
        return {
          ...tabInfo(tab),
          ...boundedValue(
            {
              runs: runs.map(({ id, ...r }) => ({ ...r, run_ref: 'run:' + id })),
              dispatches: tabDispatches(db, tab.id),
            },
            args,
          ),
        };
      }
      if (args.view === 'changes') {
        const hunks = requestPatch(
          snapshot(tab.source_ref).request,
          JSON.stringify(tab.state.draft),
        );
        const diff = hunks.length
          ? [
              '--- a/request.json',
              '+++ b/request.json',
              ...hunks.flatMap((h) => [
                `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
                ...h.lines,
              ]),
            ].join('\n')
          : '';
        return { ...tabInfo(tab), ...boundedValue(diff, args) };
      }
      return { ...tabInfo(tab), ...boundedValue(tab.state.draft, args) };
    })
    .immediate();
}
export function sendModel(args, upstream) {
  const db = storage();
  const prior = db
    .query('SELECT source_ref,run_id FROM repeat_keys WHERE request_key=?')
    .get(args.request_key);
  let id;
  if (prior) {
    const saved = prior.source_ref.startsWith('[') ? JSON.parse(prior.source_ref) : [];
    if (
      saved[0] !== args.tab_ref ||
      saved[1] !== args.revision ||
      (args.model ?? saved[2]) !== saved[3]
    )
      throw Error('idempotency_conflict');
    id = prior.run_id;
  } else {
    const tab = tabFor(args);
    if (tab.state.field?.error) throw Error('Correct the unfinished field before sending.');
    const model = args.model ?? tab.state.draft.model;
    const signature = JSON.stringify([args.tab_ref, args.revision, tab.state.draft.model, model]);
    id = launch(
      {
        id: tab.call_id,
        tabId: tab.id,
        revision: tab.revision,
        protocol: tab.protocol,
        endpoint: tab.endpoint,
      },
      { ...tab.state.draft, model },
      upstream,
      { key: args.request_key, ref: signature },
    );
  }
  return { run_ref: 'run:' + id, ...db.query('SELECT model,status FROM runs WHERE id=?').get(id) };
}
export function cancelRun({ run_ref }) {
  const db = storage(),
    id = run_ref.slice(4);
  return db
    .transaction(() => {
      const row = db.query('SELECT status FROM runs WHERE id=?').get(id);
      if (!row) throw Error('Run not found.');
      if (row.status === 'queued')
        return { run_ref, canceled: true, status: cancelQueuedRun(db, id).status };
      return { run_ref, canceled: false, status: row.status };
    })
    .immediate();
}
const legacyReply = args => args.mode === 'continue_from_reply' && args.target_agent === 'claude' && !!args.run_ref;
function dispatchSource(tab, run) {
  if (!run) return 'capture/' + tab.call_id;
  const id = run.slice(4);
  if (
    !storage()
      .query(
        "SELECT 1 FROM runs WHERE id=? AND kind='send' AND status='complete' AND (tab_id=? OR ?=?)",
      )
      .get(id, tab.id, tab.source_ref, run)
  )
    throw Error('Select a completed run belonging to this tab.');
  return id;
}
export async function agentOptions(args, chats) {
  const legacy = args.mode === 'continue_from_reply' && !!args.run_ref;
  const tab = tabFor(args),
    source = dispatchSource(tab, legacy ? args.run_ref : undefined);
  const options = await chats().options(source, legacy ? undefined : tab.state.draft, args.mode);
  return {
    ...tabInfo(tab),
    original_agent: options.original,
    targets: options.targets.map(({ id, reason }) => ({
      target_agent: id,
      mode: legacy && id === 'claude' ? 'continue_from_reply' : 'resend_prompt',
      available: !reason,
      reason: reason || null,
      ...(legacy && id === 'claude' && options.read && { review_file: options.read }),
    })),
  };
}
function dispatchRow(db, id) {
  const row = db
    .query(
      `SELECT t.id,t.tab_id,t.target,t.mode,t.signature,t.state AS submission,t.error,b.source_ref,
    t.owner,h.job AS claude_job,coalesce(h.child,c.child,d.child,a.native_id) AS session_id,c.stage,d.state AS dsh_state,a.state AS chat_state,
    a.tool_receipt,coalesce(t.error,d.error,a.error) AS detail,t.created FROM tab_dispatches t
    JOIN repeater_tabs b ON b.id=t.tab_id LEFT JOIN claude_dispatches h ON h.id=t.id LEFT JOIN codex_dispatches c ON c.id=t.id LEFT JOIN dsh_dispatches d ON d.id=t.id
    LEFT JOIN agent_chats a ON a.id=t.id WHERE t.id=?`,
    )
    .get(id);
  if (!row) throw Error('Dispatch not found.');
  let state = ['queued', 'opened'].includes(row.stage)
    ? 'queued'
    : row.dsh_state === 'delivered'
      ? 'accepted'
      : row.chat_state ||
        (row.error ? row.submission : row.stage || row.dsh_state || row.submission);
  if (
    row.submission === 'submitting' &&
    !['queued', 'accepted', 'delivered', 'failed'].includes(state)
  ) {
    try {
      if (row.owner) process.kill(row.owner, 0);
      else state = 'unconfirmed';
    } catch (error) {
      if (error.code === 'ESRCH') state = 'unconfirmed';
    }
  }
  const [, , , binding, run] = JSON.parse(row.signature);
  const linked =
    row.session_id &&
    db
      .query(
        `SELECT id FROM calls WHERE agent=? AND session=? AND started>=?
    ORDER BY started DESC,rowid DESC LIMIT 1`,
      )
      .get(row.target, row.session_id, row.created);
  return {
    dispatch_ref: 'dispatch:' + id,
    tab_ref: 'tab:' + row.tab_id,
    target_agent: row.target,
    mode: row.mode,
    source_ref: row.source_ref,
    ...(row.mode === 'resend_prompt' ? { revision: binding, run_ref: run } : { run_ref: binding }),
    ...(linked && { latest_trace_ref: 'trace:' + linked.id }),
    state,
    session_id: row.session_id,
    ...(row.claude_job && {job:row.claude_job}),
    tool_receipt: row.tool_receipt,
    error: row.detail,
    created: row.created,
  };
}
export const dispatchStatus = ({ dispatch_ref }) => dispatchRow(storage(), dispatch_ref.slice(9));
export function tabDispatches(db, id) {
  return db
    .query('SELECT id FROM tab_dispatches WHERE tab_id=? ORDER BY created DESC')
    .all(id)
    .map((row) => dispatchRow(db, row.id));
}
export async function sendAgent(args, chats, confirmFile) {
  const db = storage();
  const direct = args.mode === 'resend_prompt';
  if ((direct ? !args.revision : !legacyReply(args)))
    throw Error('The target, mode and source do not match.');
  const signature = JSON.stringify([
    args.tab_ref,
    args.target_agent,
    args.mode,
    direct ? args.revision : args.run_ref,
    direct ? (args.run_ref ?? null) : null,
  ]);
  function existing() {
    const prior = db
      .query('SELECT id,signature FROM tab_dispatches WHERE request_key=?')
      .get(args.request_key);
    if (prior && prior.signature !== signature) throw Error('idempotency_conflict');
    return prior?.id;
  }
  const prior = existing();
  if (prior) return dispatchRow(db, prior);
  const tab = tabFor(args, direct),
    source = dispatchSource(tab, legacyReply(args) ? args.run_ref : undefined);
  if (direct && tab.state.field?.error) throw Error('Correct the unfinished field before sending.');
  const service = chats(),
    options = await service.options(source, legacyReply(args) ? undefined : tab.state.draft, args.mode);
  const target = options.targets.find((t) => t.id === args.target_agent);
  if (!target || target.reason) throw Error(target?.reason || 'Agent unavailable for this source.');
  if (!direct && options.read && !(await confirmFile(options.read)))
    throw Error('File review required in Repeater.');
  const id = crypto.randomUUID();
  const claimed = db
    .transaction(() => {
      const previous = existing();
      if (previous) return previous;
      tabFor(args, direct);
      db.query(
        `INSERT INTO tab_dispatches(id,tab_id,request_key,signature,target,mode,state,created,owner)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        tab.id,
        args.request_key,
        signature,
        args.target_agent,
        args.mode,
        'submitting',
        Date.now(),
        process.pid,
      );
      return id;
    })
    .immediate();
  if (claimed !== id) return dispatchRow(db, claimed);
  try {
    const result = await service.start(source, {
      target: args.target_agent,
      key: id,
      mode: args.mode,
      ...(direct ? { request: tab.state.draft } : { approvedFile: options.read }),
    });
    db.query('UPDATE tab_dispatches SET state=? WHERE id=?').run(result.state, id);
  } catch (error) {
    const hasNativeRecord = db
      .query(
        `SELECT 1 FROM dsh_dispatches WHERE id=?
      UNION ALL SELECT 1 FROM codex_dispatches WHERE id=? UNION ALL SELECT 1 FROM agent_chats WHERE id=?
      UNION ALL SELECT 1 FROM claude_dispatches WHERE id=? LIMIT 1`,
      )
      .get(id, id, id, id);
    db.query('UPDATE tab_dispatches SET state=?,error=? WHERE id=?').run(
      hasNativeRecord && !error.refused && !error.rpcError ? 'unconfirmed' : 'failed',
      error.message,
      id,
    );
  }
  return dispatchRow(db, id);
}
