import { validRequest } from './ui/protocols.js';
import { startCall, endCall, isReplayAgent } from './store.js';

export async function onRequest(body, ctx) {
  if (!['local', 'magpie-key'].includes(ctx.origin) || !validRequest(ctx.protocol, body)) return;
  const agent = ctx.agent?.trim();
  if (!agent || isReplayAgent(agent)) return;
  const id = startCall(body, ctx.session, agent, ctx.protocol, ctx.path);
  if (id) ctx.state.traceId = id;
}

export async function onResponse(reply, ctx) {
  if (ctx.state.traceId) endCall(ctx.state.traceId, reply, ctx.success, ctx.protocol);
}
