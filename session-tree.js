import { storage } from './store.js';
import { buildShape, requestChain } from './session-chain.js';

export const CHAIN_VERSION = 3;

// A session ID groups requests into one tree, whichever client sent it.
export function treeThread(_agent, session) {
  return !!session;
}

function readChain(blob) {
  const bytes = new Uint8Array(blob);
  return new BigUint64Array(bytes.slice().buffer, 0, bytes.byteLength / 8);
}

function storeChains(db, rows) {
  const save = db.query('INSERT OR REPLACE INTO call_chain(call_id,version,chain) VALUES(?,?,?)');
  for (const row of rows) {
    let chain;
    try {
      chain = requestChain(row.protocol, JSON.parse(row.request));
    } catch {
      chain = null;
    }
    save.run(row.id, CHAIN_VERSION, new Uint8Array((chain ?? new BigUint64Array(0)).buffer));
  }
  return rows.length;
}

const missing = `FROM calls c LEFT JOIN call_chain k ON k.call_id=c.id
  WHERE c.session<>'' AND (k.version IS NULL OR k.version<>${CHAIN_VERSION})`;

// Background backfill: a small batch per tick keeps the page service responsive.
export function backfillChains(limit = 20, db = storage()) {
  const rows = db.query(`SELECT c.id,c.protocol,c.request ${missing} LIMIT ?`).all(limit);
  return rows.length ? db.transaction(() => storeChains(db, rows))() : 0;
}

// Search runs with a read-only database. Use the tree's prefix rule, including for
// new captures whose background chain backfill has not reached them yet.
export function searchTurnBounds(db, agent, session) {
  const rows = db.query(`SELECT c.id,k.chain FROM calls c LEFT JOIN call_chain k
    ON k.call_id=c.id AND k.version=? WHERE c.agent=? AND c.session=? ORDER BY c.started,c.rowid`)
    .all(CHAIN_VERSION, agent, session);
  const missing = db.query('SELECT protocol,request FROM calls WHERE id=?');
  const nodes = buildShape(rows.map(row => {
    if (row.chain) return readChain(row.chain);
    const {protocol, request} = missing.get(row.id);
    return requestChain(protocol, JSON.parse(request)) ?? new BigUint64Array(0);
  }));
  return new Map(rows.map((row, i) => [row.id, nodes[i].parent == null ? undefined : nodes[i].kept]));
}

const cache = new Map();

export function sessionTree(agent, session, db = storage()) {
  if (!treeThread(agent, session)) throw Error('This request has no session ID.');
  const pending = db
    .query(`SELECT c.id,c.protocol,c.request ${missing} AND c.agent=? AND c.session=?`)
    .all(agent, session);
  if (pending.length) db.transaction(() => storeChains(db, pending))();
  const calls = db
    .query(
      `SELECT c.id,c.rowid AS seq,c.started,c.ended,c.status,c.model,c.last_role,c.last_preview,c.final_preview
       FROM calls c JOIN call_chain k ON k.call_id=c.id WHERE c.agent=? AND c.session=? ORDER BY c.started,c.rowid`,
    )
    .all(agent, session);
  const key = agent + ':' + session;
  const signature = calls.length + ':' + (calls.at(-1)?.seq ?? 0);
  let shape = cache.get(key);
  if (shape?.signature !== signature) {
    const chains = db
      .query(
        `SELECT k.chain FROM calls c JOIN call_chain k ON k.call_id=c.id
         WHERE c.agent=? AND c.session=? ORDER BY c.started,c.rowid`,
      )
      .all(agent, session)
      .map((row) => readChain(row.chain));
    shape = { signature, nodes: buildShape(chains) };
    cache.set(key, shape);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  const nodes = calls.map((call, i) => ({
    entry_type: 'capture',
    ...call,
    ...shape.nodes[i],
    parent: shape.nodes[i].parent == null ? null : calls[shape.nodes[i].parent].id,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size) {
    const runs = db
      .query(
        `SELECT r.id,r.rowid AS seq,e.call_id AS parent,r.started,r.ended,r.status,coalesce(r.model,c.model) AS model,
          r.last_role,r.last_preview,r.final_preview FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
         WHERE c.agent=? AND c.session=? ORDER BY r.started,r.rowid`,
      )
      .all(agent, session);
    for (const run of runs)
      if (ids.has(run.parent)) nodes.push({ entry_type: 'repeater', kind: 'replay', ...run });
  }
  return { agent, session, nodes };
}
