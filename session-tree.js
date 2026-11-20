import { storage } from './store.js';
import { buildShape, requestChain } from './session-chain.js';
import { activeBranch } from './ui/session-graph.js';

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
  const body = db.query('SELECT request FROM calls WHERE id=?');
  const save = db.query('INSERT OR REPLACE INTO call_chain(call_id,version,chain) VALUES(?,?,?)');
  // Read one wire body at a time and hold only the compact chains for the write.
  const chains = rows.map((row) => {
    let chain;
    try {
      chain = requestChain(row.protocol, JSON.parse(body.get(row.id).request));
    } catch {
      chain = null;
    }
    return [row.id, new Uint8Array((chain ?? new BigUint64Array(0)).buffer)];
  });
  db.transaction(() => {
    for (const [id, chain] of chains) save.run(id, CHAIN_VERSION, chain);
  }).immediate();
}

const missing = `FROM calls c LEFT JOIN call_chain k ON k.call_id=c.id
  WHERE c.session<>'' AND (k.version IS NULL OR k.version<>${CHAIN_VERSION})`;

// Search runs with a read-only database. Use the tree's prefix rule, including for
// sessions whose chains have not been built by opening the tree yet.
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

const pageSize = 40;
export function sessionTree(agent, session, db = storage(), options = {}) {
  if (!treeThread(agent, session)) throw Error('This request has no session ID.');
  const pending = db
    .query(`SELECT c.id,c.protocol ${missing} AND c.agent=? AND c.session=?`)
    .all(agent, session);
  if (pending.length) storeChains(db, pending);
  const calls = db
    .query(
      `SELECT c.id,c.rowid AS seq,c.started
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
    parentSeq: shape.nodes[i].parent == null ? null : calls[shape.nodes[i].parent].seq,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size) {
    const runs = db
      .query(
        `SELECT r.id,r.rowid AS seq,e.call_id AS parent,r.started
         FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
         WHERE c.agent=? AND c.session=? ORDER BY r.started,r.rowid`,
      )
      .all(agent, session);
    for (const run of runs) {
      const parent = byId.get(run.parent);
      if (!parent) continue;
      const node = { entry_type: 'repeater', kind: 'replay', parentSeq: parent.seq, ...run };
      nodes.push(node);
      byId.set(node.id, node);
    }
  }
  const capture = db.query(`SELECT ended,status,model,last_role,last_preview,final_preview
    FROM calls WHERE id=?`);
  const replay = db.query(`SELECT r.ended,r.status,coalesce(r.model,c.model) AS model,
    r.last_role,r.last_preview,r.final_preview FROM runs r JOIN experiments e ON e.id=r.experiment_id
    JOIN calls c ON c.id=e.call_id WHERE r.id=?`);
  const hydrate = (node) => ({
    ...node,
    ...(node.entry_type === 'capture' ? capture : replay).get(node.id),
  });
  if (options.focus) {
    const node = byId.get(options.focus);
    return { node: node ? hydrate(node) : null };
  }
  if (!options.paged) return { agent, session, nodes: nodes.map(hydrate) };

  nodes.sort((a, b) => b.started - a.started ||
    (a.entry_type === b.entry_type ? b.seq - a.seq : a.entry_type === 'repeater' ? -1 : 1));
  const active = activeBranch(nodes);
  const visible = options.activeOnly ? nodes.filter((node) => active.has(node.id)) : nodes;
  const cursor = options.before ? visible.findIndex((node) => node.id === options.before) : -1;
  const start = cursor + 1;
  const page = visible.slice(start, start + pageSize);
  return {
    agent, session,
    nodes: page.map((node) => ({ ...hydrate(node), active: active.has(node.id) })),
    next: start + page.length < visible.length ? page.at(-1).id : null,
  };
}
