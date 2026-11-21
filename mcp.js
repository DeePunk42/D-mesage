import { bindWhenFree } from './startup.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { version } from './package.json' with { type: 'json' };
import { storage } from './store.js';
import { configureCaptureScope, scopeEditSchema } from './trace-api.js';
import { readTrace, findTraces } from './mcp-traces.js';
import {
  openTab,
  repeaterTab,
  sendModel,
  cancelRun,
  agentOptions,
  sendAgent,
  dispatchStatus,
} from './mcp-repeater.js';

const reference = (kind) =>
  z.string().regex(new RegExp(`^(${kind}):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`));
const ref = reference('trace|run'),
  runRef = reference('run'),
  tabRef = reference('tab');
const key = z.string().trim().min(1).max(200);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chunks = {
  char_offset: position.optional(),
  max_chars: z.number().int().min(256).max(64000).optional(),
};
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

function toolsFor(services) {
  const mcp = new McpServer({ name: 'd-message', title: 'D-message', version });
  function tool(name, description, inputSchema, fn, readOnly = false) {
    mcp.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: name === 'repeater_send_agent' },
      },
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
    'recording',
    'Read status, configure client choices or start/stop capture. Start returns the current capture cursor.',
    { action: z.enum(['start', 'stop', 'status', 'configure']), scope: scopeEditSchema.optional() },
    ({ action, scope }) => {
      if (action === 'configure') return configureCaptureScope(scope);
      if (scope?.add.length || scope?.remove.length)
        throw Error('Use configure to change client choices.');
      return services.captureState(action, scope ? { agents: scope.agents } : undefined);
    },
  );
  tool(
    'trace_find',
    'Browse captures and replays, or search request:, response: and tool:. after_capture follows new captures; use trace_read for existing records.',
    {
      after_capture: position.optional(),
      group_by: z.enum(['record', 'session']).optional(),
      kind: z.enum(['capture', 'replay']).optional(),
      agent: key.optional(),
      session_id: z.string().max(2048).optional(),
      status: key.optional(),
      number: position.optional(),
      since: position.optional(),
      until: position.optional(),
      query: z.string().max(4096).optional(),
      offset: position.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      hit_offset: position.optional(),
      hit_limit: z.number().int().min(1).max(20).optional(),
    },
    (args) => findTraces(args, services),
    true,
  );
  tool(
    'trace_read',
    'Read metadata, wire JSON, message pages or local recovered output. path is a JSON Pointer. Continue large JSON fragments with next_char_offset.',
    {
      ref,
      view: z
        .enum(['summary', 'request', 'response', 'messages', 'turn', 'recovered_output'])
        .optional(),
      path: path.optional(),
      before: position.optional(),
      wait_ms: z.number().int().min(0).max(5000).optional(),
      ...chunks,
    },
    (args) => readTrace(args, services),
    true,
  );
  tool(
    'session_tree',
    'Page through the session tree, newest first. Use next as before.',
    {
      agent: key,
      session_id: z.string().min(1).max(2048),
      active_only: z.boolean().optional(),
      before: z.string().uuid().optional(),
    },
    async ({ agent, session_id, active_only, before }) => {
      const page = await services.sessionPages.find({
        agent,
        session: session_id,
        activeOnly: active_only,
        before,
        paged: true,
      });
      return {
        ...page,
        session_title: (await services.titleFor(agent, session_id)) || null,
        nodes: page.nodes.map((n) => ({
          ...n,
          ref: (n.entry_type === 'repeater' ? 'run:' : 'trace:') + n.id,
          parent_ref: n.parent ? 'trace:' + n.parent : null,
        })),
      };
    },
    true,
  );
  tool(
    'repeater_open',
    'Open a shared persistent Repeater tab from a capture or run. duplicate starts a separate experiment.',
    { source_ref: ref, duplicate: z.boolean().optional() },
    openTab,
  );
  tool(
    'repeater_tab',
    'List tabs, inspect draft/changes/runs, or atomically edit the current draft using JSON Patch and its revision.',
    {
      action: z.enum(['list', 'read', 'edit']),
      tab_ref: tabRef.optional(),
      view: z.enum(['draft', 'changes', 'runs']).optional(),
      revision: key.optional(),
      ops: z.array(op).min(1).max(128).optional(),
      ...chunks,
    },
    repeaterTab,
  );
  tool(
    'repeater_models',
    'List Magpie models and provider groups for model replay.',
    {},
    services.models,
    true,
  );
  tool(
    'repeater_send_model',
    'Send one inference only. idempotent by request_key. Returns run_ref; native agent tools are not executed.',
    { tab_ref: tabRef, revision: key, request_key: key, model: key.optional() },
    (args) => sendModel(args, services.upstream),
  );
  tool(
    'repeater_cancel',
    'Cancel a queued model run. Returns canceled=false if already started or ended.',
    { run_ref: runRef },
    cancelRun,
  );
  tool(
    'repeater_agent_options',
    'Check native agent targets, mode, availability and any required local review without starting an agent.',
    { tab_ref: tabRef, revision: key, mode: z.enum(['resend_prompt','continue_from_reply']).optional(),
      run_ref: runRef.optional() },
    (args) => agentOptions(args, services.chats),
    true,
  );
  tool(
    'repeater_send_agent',
    'Deliver to a native agent which can execute tools. Codex/DSH resend the draft prompt; Claude continues a selected saved reply. A delivery receipt is not task completion.',
    {
      tab_ref: tabRef,
      revision: key.optional(),
      run_ref: runRef.optional(),
      request_key: key,
      target_agent: z.enum(['codex', 'dsh', 'claude']),
      mode: z.enum(['resend_prompt', 'continue_from_reply']).default('resend_prompt'),
    },
    (args) => sendAgent(args, services.chats, services.confirmFile || confirmLocalRead),
  );
  tool(
    'repeater_dispatch_status',
    'Read the delivery receipt and native session ID for an agent dispatch.',
    { dispatch_ref: reference('dispatch') },
    dispatchStatus,
    true,
  );
  return mcp;
}

async function confirmLocalRead(path) {
  if (process.platform !== 'darwin') return false;
  const script =
    'on run argv\n display dialog ("Allow Claude Code to read this file?" & return & item 1 of argv) with title "D-message" buttons {"Cancel", "Allow"} default button "Cancel" cancel button "Cancel" giving up after 45\n return button returned of result\nend run';
  const child = Bun.spawn(['/usr/bin/osascript', '-e', script, '--', path], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return (await child.exited) === 0 && (await new Response(child.stdout).text()).trim() === 'Allow';
}

export class McpListener {
  constructor(uiKey, services) {
    this.services = services;
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
      fetch: async (req, server) => {
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
        server.timeout(req, 0);
        const mcp = toolsFor(this.services);
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
