import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function desktopHostOrigin() {
  if (process.platform !== 'darwin') return '';
  try {
    const options = { timeout: 3000, maxBuffer: 4 * 1024 * 1024 };
    const { stdout } = await run('/bin/ps', ['-x', '-o', 'pid=,ppid=,comm='], options);
    const processes = new Map();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match?.[3].endsWith('/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'))
        processes.set(match[1], { parent: match[2], executable: match[3] });
    }
    const children = [...processes].filter(
      ([, p]) => processes.get(p.parent)?.executable === p.executable,
    );
    if (!children.length) return '';
    const { stdout: listeners } = await run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', children.map(([id]) => id).join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      options,
    );
    const origins = new Set(
      [...listeners.matchAll(/^n(127\.0\.0\.1:\d+)$/gm)].map((m) => 'http://' + m[1]),
    );
    return origins.size === 1 ? [...origins][0] : '';
  } catch {
    return '';
  }
}

function localHost(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error('Enter the URL of the running DSH Host.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Use a local DSH Host URL.');
  return url;
}
async function send(url, init) {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch {
    throw Error('The DSH Host could not be reached. Check the running instance and port.');
  }
}
export function dshHost(discover = desktopHostOrigin, file) {
  let active,
    verified = false,
    revision = 0;
  if (file) {
    try {
      const grant = JSON.parse(readFileSync(file, 'utf8'));
      if (
        localHost(grant.origin).origin === grant.origin &&
        typeof grant.cookie === 'string' &&
        grant.cookie
      )
        active = { origin: grant.origin, cookie: grant.cookie, manual: grant.manual === true };
    } catch (error) {
      if (error.code !== 'ENOENT')
        console.warn('D-message: unable to read the saved DSH credential.');
    }
  }
  function persist(connection) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomUUID();
    try {
      writeFileSync(tmp, JSON.stringify(connection), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  async function rpc(connection, method, args) {
    if (method !== 'list' && active !== connection)
      throw Object.assign(Error('The DSH Host connection changed. Reconnect in Settings.'), {
        refused: true,
      });
    const rpcId = crypto.randomUUID();
    const res = await send(connection.origin + '/api/session/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: connection.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'session/' + method,
        payload: { args },
      }),
    });
    if (res.status === 401 || res.status === 403) {
      if (active === connection) verified = false;
      throw Object.assign(
        Error('DSH denied access (' + res.status + '). Check the Host grant in Settings.'),
        { refused: true },
      );
    }
    if (!res.ok) throw Error('DSH ' + method + ' returned HTTP ' + res.status + '.');
    const body = await res.json().catch(() => null);
    if (
      body?.type !== 'server-response' ||
      body.rpcId !== rpcId ||
      typeof body.result?.ok !== 'boolean'
    )
      throw Error('Invalid DSH Host response.');
    if (!body.result.ok)
      throw Error(
        'DSH rejected ' + method + ' (' + String(body.result.error?.code || 'RPC error') + ').',
      );
    return body.result.value;
  }
  function status() {
    return { connected: !!active && verified, origin: active?.origin || '' };
  }
  return {
    status,
    async settings() {
      const connection = active;
      let error = '';
      if (connection) {
        try {
          const result = await rpc(connection, 'list', { _request: {} });
          if (!Array.isArray(result?.items)) throw Error('Invalid DSH session list.');
          if (active === connection) verified = true;
        } catch (e) {
          if (active === connection) {
            verified = false;
            error = e.message;
          }
        }
      }
      const detectedOrigin = await discover();
      return {
        ...status(),
        detectedOrigin,
        overrideOrigin: active?.manual ? active.origin : '',
        error,
      };
    },
    disconnect() {
      if (file) rmSync(file, { force: true });
      revision++;
      active = undefined;
      verified = false;
      return status();
    },
    async connect({ url: input, cookie, credential }) {
      const generation = ++revision;
      const manual = !!input && localHost(input).href === localHost(input).origin + '/';
      if (credential) {
        if (typeof credential !== 'string' || /[\r\n]/.test(credential))
          throw Error('Invalid Host credential.');
        if (/^https?:\/\//i.test(credential)) {
          const launch = localHost(credential);
          if (input && localHost(input).origin !== launch.origin)
            throw Error('The launch URL belongs to a different Host.');
          input = launch.href;
        } else if (credential.includes('=')) cookie = credential;
      }
      const address = input || (await discover());
      if (!address)
        throw Error(
          'Could not identify a single local DSH Host. Enter its origin or paste its authorized launch URL.',
        );
      const url = localHost(address);
      if (credential && !cookie && !/^https?:\/\//i.test(credential)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(credential) || url.pathname !== '/' || url.search)
          throw Error('Enter the launch token from this Host’s authorized URL.');
        url.searchParams.set('token', credential);
      }
      if (cookie) {
        if (
          url.pathname !== '/' ||
          url.search ||
          typeof cookie !== 'string' ||
          /[\r\n]/.test(cookie) ||
          !cookie.includes('=')
        )
          throw Error('Enter a Host origin and its Cookie header value.');
      } else {
        const res = await send(url.href, { method: 'GET' });
        cookie = res.headers.get('set-cookie')?.split(';')[0];
        await res.body?.cancel();
        if (res.status !== 303 || !cookie)
          throw Error(
            'The Host did not accept the launch URL. Supply a valid authorized URL or Host cookie.',
          );
      }
      const connection = { origin: url.origin, cookie, manual };
      const result = await rpc(connection, 'list', { _request: {} });
      if (!Array.isArray(result?.items)) throw Error('The Host returned an invalid session list.');
      if (generation !== revision) throw Error('Connection settings changed.');
      persist(connection);
      active = connection;
      verified = true;
      return status();
    },
    client() {
      const connection = active;
      if (!connection) throw Error('Connect the running DSH Host in Settings.');
      return {
        origin: connection.origin,
        fork: (request) => rpc(connection, 'fork', { request }),
        prompt: (request) => rpc(connection, 'prompt', { request }),
      };
    },
  };
}
