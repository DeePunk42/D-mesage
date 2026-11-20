// The bundled Electron runtime provides the installed DSH modules and native ABI.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const packages = resolve(
  dirname(process.execPath),
  '../Resources/app.asar/dsh/node_modules/@deepseek-ai',
);
const load = (name) => import(pathToFileURL(resolve(packages, name)).href);
const { runProfile } = await load('dsh/lib/profile-boot.js');
const { loadLayeredEnv } = await load('dsh-app-boot/lib/index.js');

export async function openDshChat({ openBrowser = true } = {}) {
  const { ctx, shutdown } = await runProfile({
    profile: 'web',
    environment: loadLayeredEnv('dsh'),
    args: ['--host', '127.0.0.1', '--port', '0', ...(openBrowser ? [] : ['--no-open'])],
    patchFiles: [process.env.D_MESSAGE_AGENT_PATCH],
  });
  try {
    const stamp = resolve(process.env.DSH_HOME, 'continued-session');
    if (process.env.D_MESSAGE_AGENT_RESUME === '1')
      return { sessionId: readFileSync(stamp, 'utf8'), ctx, shutdown };
    const { workspace } = await ctx.workspaceController.create({ path: process.cwd() });
    const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id });
    writeFileSync(stamp, sessionId, { mode: 0o600 });
    await ctx.sessionController.prompt(
      {
        sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: process.env.D_MESSAGE_AGENT_MARKER }],
      },
      new AbortController().signal,
    );
    return { sessionId, ctx, shutdown };
  } catch (e) {
    await shutdown.shutdown(1);
    throw e;
  }
}
if (import.meta.main) {
  const { sessionId } = await openDshChat();
  console.log('D-message session:', sessionId);
}
