import { bindWhenFree } from './startup.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { storage } from './store.js';
import { scopeSchema, listTraces, getTrace, editTrace, repeatTrace } from './trace-api.js';

const ref = z.string().regex(/^(trace|draft|run):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const path = z.string().max(4096);
const op = z.strictObject({
  op: z.enum(['test', 'add', 'remove', 'replace']),
  path,
  value: z.json().optional(),
});
const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
});
const reply = (data) => ({
  structuredContent: data,
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const digest = (s) => createHash('sha256').update(s).digest();

function toolsFor(upstream, captureState) {
  const mcp = new McpServer({ name: 'd-message', title: 'D-message', version: '1.4.1' });
  function tool(name, description, inputSchema, fn, readOnly = false) {
    mcp.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false } },
      async (args) => {
        try {
          return reply(await fn(args));
        } catch (e) {
          return {
            isError: true,
            content: [{ type: 'text', text: e.message || 'Tool call failed.' }],
          };
        }
      },
    );
  }
  tool(
    'trace_record',
    'Read capture status and available agents, start, stop, or configure the scope. Pass scope with configure or start. agents is "all" or a list of exact ctx.agent IDs.',
    { action: z.enum(['start', 'stop', 'status', 'configure']), scope: scopeSchema.optional() },
    (a) => captureState(a.action, a.scope),
  );
  tool(
    'trace_list',
    'List recorded calls after an exclusive numeric cursor, oldest first. Poll with the returned cursor.',
    {
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      session: z.string().max(2048).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    listTraces,
    true,
  );
  tool(
    'trace_get',
    'Read a trace, draft or run. Optional RFC 6901 pointer selects a field inside the selected view. Poll run refs for completion.',
    { ref, view: z.enum(['summary', 'request', 'response']).optional(), path: path.optional() },
    getTrace,
    true,
  );
  tool(
    'trace_edit',
    'Create an immutable draft with atomic RFC 6902 test/add/remove/replace operations on the request snapshot. Does not send a request.',
    { ref, ops: z.array(op).min(1).max(128) },
    editTrace,
  );
  tool(
    'trace_repeat',
    'Queue one inference through the configured gateway. Up to eight runs execute concurrently. No client function is executed. Retry using the same request_key and ref to retrieve the same run.',
    { ref, request_key: z.string().trim().min(1).max(200) },
    (args) => repeatTrace(args, upstream),
  );
  return mcp;
}

export class McpListener {
  constructor(uiKey, upstream, captureState) {
    this.upstream = upstream;
    this.captureState = captureState;
    // Keep the derivation label stable for credentials already copied into MCP clients.
    this.token = createHmac('sha256', uiKey).update('tracefork-local-mcp-v1').digest('base64url');
    this.keyHash = digest('Bearer ' + this.token);
    this.config = { enabled: false, port: 34892 };
    const saved = storage().query("SELECT value FROM settings WHERE key='mcp'").get();
    if (saved) this.config = settingsSchema.parse(JSON.parse(saved.value));
    this.listener = null;
    this.error = '';
  }
  state() {
    return {
      ...this.config,
      listening: !!this.listener,
      url: 'http://127.0.0.1:' + this.config.port + '/mcp',
      error: this.error || null,
    };
  }
  restore() {
    if (!this.config.enabled || this.listener || this.cancelRestore) return;
    try {
      this.cancelRestore = bindWhenFree(() => this.bind(this.config.port), {
        waiting: () => {
          this.error = 'The MCP port is busy. Waiting for it to become available.';
        },
        ready: (server) => {
          this.listener = server;
          this.error = '';
        },
        failed: (error) => {
          this.error = 'MCP startup failed: ' + (error.code || error.name);
        },
      });
    } catch (error) {
      this.error = 'MCP startup failed: ' + (error.code || error.name);
    }
  }
  stop(force = true) {
    if (this.cancelRestore) {
      this.cancelRestore();
      this.cancelRestore = null;
    } else this.listener?.stop(force);
    this.listener = null;
  }
  configure(input) {
    const config = settingsSchema.safeParse(input);
    if (!config.success)
      throw Error('Enter an integer port from 1024 to 65535 and an enabled state.');
    const next = config.data;
    let replacement = null;
    if (next.enabled && (!this.listener || next.port !== this.config.port)) {
      try {
        replacement = this.bind(next.port);
      } catch {
        throw Error('Port ' + next.port + ' is unavailable. Choose another port.');
      }
    }
    try {
      storage()
        .query("INSERT OR REPLACE INTO settings(key,value) VALUES('mcp',?)")
        .run(JSON.stringify(next));
    } catch (e) {
      replacement?.stop(true);
      throw e;
    }
    if (replacement || !next.enabled) {
      this.stop(true);
      this.listener = replacement;
    }
    this.config = next;
    this.error = '';
    return this.state();
  }
  bind(port) {
    const host = '127.0.0.1:' + port;
    return Bun.serve({
      hostname: '127.0.0.1',
      port,
      idleTimeout: 30,
      maxRequestBodySize: 8 * 1024 * 1024,
      fetch: async (req) => {
        if (![host, 'localhost:' + port].includes(req.headers.get('host')))
          return new Response(null, { status: 403 });
        const url = new URL(req.url),
          origin = req.headers.get('origin');
        if (origin && origin !== url.origin) return new Response(null, { status: 403 });
        if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
        if (!timingSafeEqual(digest(req.headers.get('authorization') || ''), this.keyHash))
          return new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="D-message"' },
          });
        if (req.method !== 'POST')
          return new Response(null, { status: 405, headers: { Allow: 'POST' } });
        const mcp = toolsFor(this.upstream, this.captureState);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await mcp.connect(transport);
          return await transport.handleRequest(req);
        } finally {
          await mcp.close();
        }
      },
    });
  }
}
