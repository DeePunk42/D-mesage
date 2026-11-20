// Runs in a visible local terminal. Only the random launch ID is passed by the
// page; request content is never interpreted by a shell.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { storage, dataDir } from './store.js';
import { targetProtocol } from './continue-protocol.js';
import { agentExecutable, running } from './continue-agent.js';

export function nativeLaunch(chat, executable, stateDir) {
  const marker = chat.marker,
    localKey = chat.access_key;
  const env = {};
  if (chat.target === 'claude') {
    Object.assign(env, {
      ANTHROPIC_BASE_URL: chat.base,
      ANTHROPIC_API_KEY: localKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    return {
      cmd: [
        executable,
        '--bare',
        '--permission-mode',
        'default',
        ...(chat.native_id ? ['--resume', chat.native_id] : ['--session-id', chat.id]),
        '--model',
        chat.model,
        ...(chat.native_id ? [] : ['--', marker]),
      ],
      env,
    };
  }
  if (chat.target === 'codex') {
    const settings = {
      model_provider: 'dmessage',
      'model_providers.dmessage.name': 'D-message',
      'model_providers.dmessage.base_url': chat.base + '/v1',
      'model_providers.dmessage.wire_api': 'responses',
      'model_providers.dmessage.env_key': 'D_MESSAGE_LOCAL_KEY',
      'model_providers.dmessage.supports_websockets': false,
    };
    const args = Object.entries(settings).flatMap(([key, value]) => [
      '-c',
      key + '=' + JSON.stringify(value),
    ]);
    env.D_MESSAGE_LOCAL_KEY = localKey;
    return {
      cmd: [
        executable,
        ...args,
        '--model',
        chat.model,
        ...(chat.native_id ? ['resume', chat.native_id] : ['--', marker]),
      ],
      env,
    };
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Keep this route and web listener confined to the newly opened DSH profile.
  const patch = join(stateDir, 'route.json');
  const model = chat.model,
    protocol = targetProtocol(chat.target, chat.protocol);
  const config =
    protocol === 'chat'
      ? [
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                dmessage: {
                  api: 'openai-completions',
                  apiKeyEnv: 'D_MESSAGE_LOCAL_KEY',
                  baseURL: chat.base + '/v1',
                  models: [{ id: model, contextWindow: 131072 }],
                },
              },
            },
          },
          { id: 'agent-default-model', config: { provider: 'dmessage', model } },
        ]
      : [
          {
            id: 'agent-default-model',
            config: { provider: 'deepseek-official', model: 'deepseek-flash' },
          },
        ];
  config.push({ id: 'session-title-llm', disabled: true });
  writeFileSync(patch, JSON.stringify(config), { mode: 0o600 });
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: stateDir,
    DEEPSEEK_API_KEY: localKey,
    DEEPSEEK_BASE_URL: chat.base,
    D_MESSAGE_LOCAL_KEY: localKey,
    D_MESSAGE_AGENT_PATCH: patch,
    D_MESSAGE_AGENT_MARKER: marker,
    D_MESSAGE_AGENT_RESUME: chat.native_id ? '1' : '0',
  });
  return {
    cmd: [
      executable,
      '--expose-internals',
      fileURLToPath(new URL('./continue-dsh.mjs', import.meta.url)),
    ],
    env,
  };
}

async function main() {
  const db = storage(),
    id = process.argv[2];
  const chat = db
    .query(
      `SELECT a.*,r.rowid AS seq,coalesce(r.model,c.model) AS model,c.protocol FROM agent_chats a
    JOIN runs r ON r.id=a.run_id JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE a.id=?`,
    )
    .get(id);
  if (!chat || (chat.state !== 'opening' && !(chat.state === 'delivered' && chat.native_id)))
    throw Error('This launch is no longer available.');
  if (
    running(chat.owner) ||
    !db
      .query('UPDATE agent_chats SET owner=? WHERE id=? AND owner IS ?')
      .run(process.pid, id, chat.owner).changes
  )
    throw Error('This chat already has a running agent.');
  try {
    const executable = agentExecutable(chat.target, db);
    if (!executable) throw Error('The selected agent is unavailable.');
    const { cmd, env } = nativeLaunch(
      chat,
      executable,
      join(dataDir, 'agent-workspaces', id, 'profile'),
    );
    const childEnv = { ...process.env, ...env };
    // This session uses a private local model route instead of login credentials.
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ])
      delete childEnv[key];
    const child = Bun.spawn(cmd, {
      env: childEnv,
      cwd: chat.workdir,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exit = await child.exited;
    if (exit !== 0) throw Error('Agent exited with status ' + exit + '.');
    db.query(
      "UPDATE agent_chats SET state='failed',error='Agent closed before reading the answer.' WHERE id=? AND state='opening'",
    ).run(id);
  } catch (e) {
    db.query("UPDATE agent_chats SET state='failed',error=? WHERE id=? AND state='opening'").run(
      e.message,
      id,
    );
    throw e;
  } finally {
    db.query('UPDATE agent_chats SET owner=NULL WHERE id=? AND owner=?').run(id, process.pid);
  }
}
if (import.meta.main)
  main().catch((e) => {
    console.error('D-message:', e.message);
    process.exitCode = 1;
  });
