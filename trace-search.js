import { Worker, parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { searchConditions, searchHits } from './ui/search.js';
import { groupRows } from './list-groups.js';

export function traceSearch(path) {
  let worker;
  let sequence = 0;
  const pending = new Map();
  function stop() {
    worker?.terminate();
    worker = null;
    for (const task of pending.values()) task.reject(Error('Trace search stopped.'));
    pending.clear();
  }
  return {
    stop,
    find(options) {
      if (!worker) {
        worker = new Worker(new URL(import.meta.url), { workerData: { path } });
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
  const db = new Database(workerData.path, { readonly: true });
  const capture = db.query('SELECT request,reply FROM calls WHERE id=?');
  const replay =
    db.query(`SELECT CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request,r.reply
    FROM runs r JOIN experiments e ON r.experiment_id=e.id JOIN calls c ON c.id=e.call_id WHERE r.id=?`);
  const cache = new Map();
  parentPort.on('message', ({ id, options }) => {
    try {
      const conditions = searchConditions(options.q);
      const cacheKey = JSON.stringify(conditions);
      if (!cache.has(cacheKey)) {
        if (cache.size >= 4) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, new Map());
      }
      const matches = cache.get(cacheKey);
      const result = db.transaction(() => {
        const matched = [];
        const version = db.query("SELECT value FROM settings WHERE key='cleared_cursor'").get();
        const clearedThrough = Number(version?.value || 0);
        const rows = db.query(options.sql).iterate(...options.args);
        for (const row of rows) {
          const stamp = row.status + '|' + row.ended;
          let match = matches.get(row.id);
          if (match?.stamp !== stamp) {
            const parsed = {};
            let raw,
              hit = null;
            const found = conditions.every((query) => {
              for (const side of ['request', 'response']) {
                if (!['all', 'tool', side].includes(query.scope)) continue;
                raw ??= (row.entry_type === 'capture' ? capture : replay).get(row.id);
                if (!(side in parsed))
                  parsed[side] = JSON.parse(
                    (side === 'request' ? raw.request : raw.reply) ?? 'null',
                  );
                const field = searchHits(parsed[side], side, query).next().value;
                if (field) {
                  hit ??= field;
                  return true;
                }
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
        const entries = groupRows(matched);
        const calls = entries.slice(options.offset, options.offset + 100);
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
