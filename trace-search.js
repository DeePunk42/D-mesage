import { Worker, parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { searchConditions, rankedHits, pointer } from './ui/search.js';
import { searchTurnBounds, sessionTree } from './session-tree.js';
import { groupRows } from './list-groups.js';

export function traceSearch(path, kind = 'search') {
  let worker;
  let sequence = 0;
  const pending = new Map();
  function stop(error = Error('Trace worker stopped.')) {
    worker?.terminate();
    worker = null;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }
  return {
    stop,
    find(options) {
      if (!worker) {
        worker = new Worker(new URL(import.meta.url), { workerData: { path, kind } });
        worker.on('error', stop);
        worker.on('message', ({ id, result, error }) => {
          const task = pending.get(id);
          if (!task) return;
          pending.delete(id);
          if (error) task.reject(Error(error));
          else task.resolve(result);
        });
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, options });
      });
    },
  };
}

if (parentPort && workerData?.path) {
  const buildsTree = workerData.kind === 'tree';
  const db = buildsTree ? new Database(workerData.path) : new Database(workerData.path, { readonly: true });
  if (buildsTree) db.exec('PRAGMA busy_timeout=1500; PRAGMA foreign_keys=ON;');
  const capture = db.query('SELECT request,reply FROM calls WHERE id=?');
  const replay =
    db.query(`SELECT CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request,r.reply
    FROM runs r JOIN experiments e ON r.experiment_id=e.id JOIN calls c ON c.id=e.call_id WHERE r.id=?`);
  const cache = new Map();
  parentPort.on('message', ({ id, options }) => {
    try {
      if (buildsTree) {
        const result = sessionTree(options.agent, options.session, db, options);
        parentPort.postMessage({ id, result });
        return;
      }
      const conditions = searchConditions(options.q);
      const cacheKey = JSON.stringify(conditions);
      if (!cache.has(cacheKey)) {
        if (cache.size >= 4) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, new Map());
      }
      const matches = cache.get(cacheKey);
      const result = db.transaction(() => {
        const matched = [];
        const sessions = new Map();
        const version = db.query("SELECT value FROM settings WHERE key='cleared_cursor'").get();
        const clearedThrough = Number(version?.value || 0);
        const rows = db.query(options.sql).iterate(...options.args);
        for (const row of rows) {
          if (!conditions.length) {
            matched.push(row);
            continue;
          }
          const stamp = row.status + '|' + row.ended;
          let match = matches.get(row.id);
          if (match?.stamp !== stamp) {
            const raw = (row.entry_type === 'capture' ? capture : replay).get(row.id);
            const request = JSON.parse(raw.request);
            const response = JSON.parse(raw.reply);
            let kept, hit = null;
            if (row.protocol === 'responses' && row.session && row.entry_type === 'capture') {
              const key = JSON.stringify([row.agent, row.session]);
              if (!sessions.has(key)) sessions.set(key, searchTurnBounds(db, row.agent, row.session));
              kept = sessions.get(key).get(row.id);
            }
            const found = conditions.every((query) => {
              const field = rankedHits(request, response, query, kept).next().value;
              if (field) {
                hit ??= { ...field, kept };
                return true;
              }
              return (
                query.scope === 'all' &&
                [row.agent, row.session, row.model, row.id, row.last_role, row.last_preview].some(
                  (value) => value?.toLowerCase().includes(query.needle),
                )
              );
            });
            match = { stamp, hit, found };
            matches.set(row.id, match);
          }
          if (!match.found) continue;
          matched.push({ ...row, hit: match.hit ?? null });
        }
        const entries = options.flat ? matched : groupRows(matched);
        const calls = entries.slice(options.offset, options.offset + (options.limit ?? 100));
        if (options.flat && options.hitLimit && conditions.length) for (const row of calls) {
          const raw = (row.entry_type === 'capture' ? capture : replay).get(row.id);
          const request = JSON.parse(raw.request), response = JSON.parse(raw.reply);
          row.hits = [];
          let index = 0;
          outer: for (const query of conditions) {
            for (const hit of rankedHits(request,response,query,row.hit?.kept)) {
              if (index++ < options.hitOffset) continue;
              if (row.hits.length === options.hitLimit) {
                row.next_hit_offset = index - 1;
                break outer;
              }
              row.hits.push({side:hit.side,path:hit.path.length ? pointer(hit.path) : '',preview:hit.preview});
            }
          }
        }
        return {
          calls,
          total: entries.length,
          clearedThrough,
          more: options.offset + calls.length < entries.length,
        };
      })();
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}
