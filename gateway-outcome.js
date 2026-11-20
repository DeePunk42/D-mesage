const windowMs = 1000;
const retryDelays = [0, 150, 400, 1000, 2500, 5000];
const observationWindow = 16 * 60_000;
const text = (value) => ['string', 'number'].includes(typeof value) ? String(value).slice(0, 8192) : undefined;

function failure(message, facts) {
  return { status: 'failed', failure: { message, ...facts } };
}

function errorReason(type, message) {
  return /^(?:content_filter|content_policy_violation|safety_filter|policy_violation)$/.test(type || '') ||
    /\b(?:refused this request|safety filter|flagged for possible cybersecurity risk)\b/i.test(message || '')
    ? 'rejected' : 'error';
}

export function protocolFailure(reply) {
  const error = reply?.error ?? (reply?.type === 'error' ? reply : null);
  if (!error) return null;
  const message = text(error.message ?? (typeof error === 'string' ? error : undefined));
  const code = text(error.code), type = text(error.type);
  if (!message && !code && (!type || type === 'error')) return null;
  return failure(message || code || type, { code, type, reason: errorReason(code || type, message), requestId: text(reply.request_id) });
}

function gatewayResult(row) {
  const http = Number.isInteger(row.status) && row.status > 0 ? row.status : undefined;
  const message = text(row.err), type = text(row.err_type);
  const facts = {
    http, type, provider: text(row.provider),
    requestId: text(row.rid) || message?.match(/\brequest_id:\s*([\w.-]+)/i)?.[1],
  };
  if (http === 499 && (type === 'agent_canceled' || /agent cancel(?:l)?ed the request/i.test(message || '')))
    return { status: 'canceled', failure: { ...facts, reason: 'canceled', message: message || 'The agent canceled the request.' } };
  if (http >= 400 || message || type || row.rejected || row.status === 0) {
    return failure(message || type || (http ? `Gateway returned HTTP ${http}.` : 'No HTTP response was recorded.'), {
      ...facts, reason: row.rejected ? 'rejected' : errorReason(type, message),
      code: message?.match(/^(?:[\w.-]+:\s+)?([a-z][a-z_]+_error):/)?.[1],
    });
  }
  if (http >= 200 && http < 300)
    return { status: 'complete', ended: Date.parse(row.t) + (Number.isFinite(row.ms) ? row.ms : 0) };
  return null;
}

function groupAlias(group, alias) {
  return typeof alias === 'string' && alias.startsWith('auto/') &&
    group === 'group/auto-' + alias.slice(5).replaceAll('.', '-');
}

function fits(call, row) {
  return row.agent === call.agent && (!call.session || [row.session, row.native_session].includes(call.session)) &&
    Math.abs(Date.parse(row.t) - call.started) <= windowMs &&
    (!row.req || !call.model || row.req === call.model || groupAlias(call.model, row.req) || groupAlias(row.req, call.model)) &&
    (!row.ep || row.ep.split(/\s*→\s*/)[0] === call.endpoint);
}

function dayOf(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

async function readRows(upstream, filters, signal) {
  const url = new URL('/v1/magpie/usage/requests', upstream);
  url.search = new URLSearchParams({ period: 'all', computer: 'this', limit: '200', ...filters });
  const result = [];
  for (let offset = 0; offset < 4000;) {
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) throw Error('Usage lookup unavailable');
    const page = await response.json();
    if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.total)) throw Error('Invalid usage page');
    result.push(...page.rows);
    offset += page.rows.length;
    if (offset >= page.total) return result;
    if (!page.rows.length) break;
  }
  throw Error('Incomplete usage results');
}

export async function lookupOutcome(call, readPeers, upstream, signal) {
  const days = new Set([dayOf(call.started - windowMs), dayOf(call.started + windowMs)]);
  const rows = [];
  for (const day of days) {
    rows.push(...await readRows(upstream, { day, agent: call.agent, ...(call.session && { q: call.session }) }, signal));
  }
  const candidates = rows.filter(row => !row.source && !row.kind && fits(call, row));
  if (!candidates.length) return { miss: 'No matching Magpie request was found.' };
  const routes = new Set(candidates.map(row => row.route_id));
  const peers = readPeers();
  if (routes.size !== 1 || candidates.some(row => peers.some(peer => peer.id !== call.id && fits(peer, row))))
    return { miss: 'Could not uniquely match this trace to a Magpie request.' };
  let finals = candidates.filter(row => !row.handed_on);
  if (candidates.some(row => row.handed_on) && candidates[0].route_id) {
    const route = candidates[0].route_id;
    finals = (await readRows(upstream, { route: String(route) }, signal))
      .filter(row => row.route_id === route && !row.source && !row.handed_on);
  }
  if (finals.length !== 1 || (!candidates[0].route_id && candidates.length !== 1))
    return { miss: 'Could not uniquely identify the final Magpie request outcome.' };
  const result = gatewayResult(finals[0]);
  if (call.status === 'checking' && result?.status === 'complete')
    return { miss: 'The capture reported failure, but the matching gateway record reports success.' };
  return result || { miss: 'Magpie recorded no final status for the matching request.' };
}

export function outcomeWorker(db, upstream) {
  const controller = new AbortController();
  const active = new Set(), later = new Map();
  const metadata = 'id,agent,session,model,endpoint,started,ended,status';
  const waiting = db.query(`SELECT ${metadata} FROM calls WHERE status IN ('checking','checking_unknown') ORDER BY started LIMIT 16`);
  const slow = db.query(`SELECT ${metadata} FROM calls WHERE status='pending' AND started<=? ORDER BY started`);
  const nearby = db.query(`SELECT ${metadata} FROM calls WHERE agent=? AND started BETWEEN ? AND ?`);
  const finish = db.query(`UPDATE calls SET status=?,failure=?,ended=coalesce(ended,?)
    WHERE id=? AND status=? AND ended IS ?`);
  async function resolve(call) {
    let miss;
    const pending = call.status === 'pending';
    const deadline = AbortSignal.timeout(10000);
    const signal = AbortSignal.any([deadline, controller.signal]);
    for (const delay of retryDelays) {
      if (delay) await Bun.sleep(delay);
      if (signal.aborted) break;
      try {
        const peers = () => nearby.all(call.agent, call.started - 2 * windowMs, call.started + 2 * windowMs);
        const result = await lookupOutcome(call, peers, upstream, signal);
        if (controller.signal.aborted) return;
        if (result.status) {
          finish.run(result.status, result.failure ? JSON.stringify(result.failure) : null,
            result.ended ?? call.ended, call.id, call.status, call.ended);
          return;
        }
        miss = result.miss;
      } catch {
        miss ??= 'Could not read the Magpie request ledger to match this trace.';
      }
      if (pending) break;
    }
    if (controller.signal.aborted) return;
    const age = Date.now() - call.started;
    if (pending && age < observationWindow) {
      later.set(call.id, Date.now() + Math.min(30_000, observationWindow - age));
      return;
    }
    finish.run(call.status === 'checking' ? 'failed' : 'unconfirmed',
      JSON.stringify({ reason: 'unmatched', message: miss || 'No matching Magpie request was found.' }),
      call.ended, call.id, call.status, call.ended);
  }
  function tick() {
    if (controller.signal.aborted || active.size >= 4) return;
    const now = Date.now();
    for (const [id, when] of later) if (when <= now) later.delete(id);
    for (const call of [...waiting.all(), ...slow.all(now - 120_000)]) {
      if (active.has(call.id) || (call.status === 'pending' && later.has(call.id))) continue;
      active.add(call.id);
      void resolve(call).catch(error => console.error('D-message: outcome lookup failed', error.message))
        .finally(() => active.delete(call.id));
      if (active.size >= 4) break;
    }
  }
  return { tick, stop: () => controller.abort() };
}
