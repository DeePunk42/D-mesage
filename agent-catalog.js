import { isReplayAgent, storage } from './store.js';

// The page and MCP share a refresh. Capture hooks only consult SQLite.
export function gatewayAgents(upstream) {
  let inFlight;
  let nextRefresh = 0;
  async function read(path, select) {
    const response = await fetch(new URL(path, upstream), {
      redirect: 'error',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw Error('Magpie ' + response.status);
    const ids = select(await response.json());
    return new Set(
      ids.filter((id) => typeof id === 'string' && id && !isReplayAgent(id)),
    );
  }
  async function refresh() {
    const [connected, history] = await Promise.allSettled([
      read('/v1/magpie/agent-models', (data) => {
        if (!data.agents || typeof data.agents !== 'object' || Array.isArray(data.agents))
          throw Error('Missing agent list.');
        return Object.keys(data.agents);
      }),
      read('/v1/magpie/usage/requests?period=all&computer=this&via=through&limit=1', (data) =>
        data.agents.map((agent) => agent.id),
      ),
    ]);
    const db = storage();
    db.transaction(() => {
      for (const [kind, result] of [
        ['connected_agent', connected],
        ['history_agent', history],
      ]) {
        if (result.status !== 'fulfilled') continue;
        db.query('DELETE FROM capture_options WHERE kind=?').run(kind);
        const insert = db.query('INSERT INTO capture_options(kind,value) VALUES(?,?)');
        for (const id of result.value) insert.run(kind, id);
      }
    }).immediate();
    nextRefresh =
      Date.now() +
      (connected.status === 'fulfilled' && history.status === 'fulfilled' ? 60000 : 10000);
  }
  return () => {
    if (Date.now() < nextRefresh) return;
    return (inFlight ??= refresh().finally(() => {
      inFlight = null;
    }));
  };
}
