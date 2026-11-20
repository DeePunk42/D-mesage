import { expect, test } from 'bun:test';
import { mkdtempSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshHost } from '../dsh-host.js';

test('existing-host authorization binds a private grant to its origin and verifies RPC identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'd-message-test-grant-'));
  const file = join(dir, 'dsh-host.key');
  const newHost = () => dshHost(async () => server.url.origin, file);
  const host = newHost();
  const calls = [];
  let denied = false;
  let wrongId = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (
        path === '/launch' ||
        (path === '/' && new URL(req.url).searchParams.get('token') === 'test-token')
      )
        return new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth-test=grant; HttpOnly; Path=/', location: '/' },
        });
      if (req.headers.get('cookie') !== 'dsh-auth-test=grant' || denied)
        return new Response(null, { status: 401 });
      const event = await req.json();
      calls.push(event);
      expect(path).toBe('/api/' + event.method);
      return Response.json({
        type: 'server-response',
        rpcId: wrongId ? 'other' : event.rpcId,
        result: { ok: true, value: { items: [] } },
      });
    },
  });
  try {
    await expect(host.connect({ url: 'https://example.com', cookie: 'a=b' })).rejects.toThrow(
      'local',
    );
    expect(await host.connect({ url: new URL('/launch', server.url).href })).toEqual({
      connected: true,
      origin: server.url.origin,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = newHost();
    expect((await restored.settings()).connected).toBe(true);
    await expect(
      restored.connect({ url: server.url.href, cookie: 'dsh-auth-test=invalid' }),
    ).rejects.toThrow('401');
    expect((await restored.settings()).connected).toBe(true);
    expect((await newHost().settings()).connected).toBe(true);
    expect(JSON.stringify(await restored.settings())).not.toContain('dsh-auth');
    expect(calls[0].payload.args).toEqual({ _request: {} });
    wrongId = true;
    await expect(host.client().fork({ sessionId: 'example', atSeq: 1 })).rejects.toThrow('Invalid');
    wrongId = false;
    denied = true;
    await expect(host.client().fork({ sessionId: 'example', atSeq: 1 })).rejects.toThrow('401');
    expect(host.status().connected).toBe(false);
    denied = false;
    await host.connect({ url: server.url.href, cookie: 'dsh-auth-test=grant' });
    expect(host.disconnect()).toEqual({ connected: false, origin: '' });
    expect(existsSync(file)).toBe(false);
    expect((await newHost().settings()).connected).toBe(false);
    expect((await host.settings()).detectedOrigin).toBe(server.url.origin);
    expect((await host.connect({ credential: 'test-token' })).connected).toBe(true);
    host.disconnect();
    await expect(
      host.connect({ url: 'http://127.0.0.1:9', credential: new URL('/launch', server.url).href }),
    ).rejects.toThrow('different Host');
    expect(
      (await host.connect({ credential: new URL('/launch', server.url).href })).connected,
    ).toBe(true);
    host.disconnect();
    await expect(dshHost(async () => '').connect({ credential: 'test-token' })).rejects.toThrow(
      'identify',
    );
    expect(() => host.client()).toThrow('Settings');
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
