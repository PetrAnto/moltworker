import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createMockEnv } from '../test-utils';

/**
 * In-memory KV double matching just the surface cdp.ts uses
 * (get/put with expirationTtl). Records every put + lets tests
 * assert what was stored.
 */
function makeKV() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      if (opts?.expirationTtl !== undefined) ttls.set(key, opts.expirationTtl);
    }),
  } as unknown as KVNamespace;
  return { kv, store, ttls };
}

const MASTER = 'master-secret-abcdef0123456789';

describe('CDP discovery endpoints — session-token rotation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('/json/version mints a session token and keeps the master secret out of the WS URL when NEXUS_KV is bound', async () => {
    const { kv, store, ttls } = makeKV();
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      `http://example.com/cdp/json/version?secret=${encodeURIComponent(MASTER)}`,
      { method: 'GET' },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
        NEXUS_KV: kv,
      }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { webSocketDebuggerUrl: string };

    // The master secret no longer appears in the returned URL.
    expect(json.webSocketDebuggerUrl).not.toContain(MASTER);

    // The URL embeds a 32-hex-char session token.
    const m = json.webSocketDebuggerUrl.match(/secret=([0-9a-f]{32})/);
    expect(m).not.toBeNull();
    const token = m![1];

    // The token was persisted under cdp:session:<token> with the documented TTL.
    expect(store.has(`cdp:session:${token}`)).toBe(true);
    expect(ttls.get(`cdp:session:${token}`)).toBe(5 * 60);
  });

  it('mints a fresh token per discovery call (no token reuse)', async () => {
    const { kv } = makeKV();
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const env = createMockEnv({
      DEV_MODE: 'true',
      CDP_SECRET: MASTER,
      BROWSER: {} as Fetcher,
      NEXUS_KV: kv,
    });

    const a = (await (
      await app.request(
        `http://example.com/cdp/json/version?secret=${encodeURIComponent(MASTER)}`,
        { method: 'GET' },
        env,
      )
    ).json()) as { webSocketDebuggerUrl: string };
    const b = (await (
      await app.request(
        `http://example.com/cdp/json/version?secret=${encodeURIComponent(MASTER)}`,
        { method: 'GET' },
        env,
      )
    ).json()) as { webSocketDebuggerUrl: string };

    const tokA = a.webSocketDebuggerUrl.match(/secret=([0-9a-f]{32})/)![1];
    const tokB = b.webSocketDebuggerUrl.match(/secret=([0-9a-f]{32})/)![1];
    expect(tokA).not.toBe(tokB);
  });

  it('falls back to the master secret in the URL when NEXUS_KV is not bound (back-compat)', async () => {
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      `http://example.com/cdp/json/version?secret=${encodeURIComponent(MASTER)}`,
      { method: 'GET' },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
        // No NEXUS_KV bound — pre-Phase-2 deployments keep working.
      }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { webSocketDebuggerUrl: string };
    expect(json.webSocketDebuggerUrl).toContain(`secret=${encodeURIComponent(MASTER)}`);
  });

  it('rejects /json/version when the master secret is wrong', async () => {
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      'http://example.com/cdp/json/version?secret=wrong',
      { method: 'GET' },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
      }),
    );
    expect(response.status).toBe(401);
  });

  it('/json/list and /json apply the same session-token rotation', async () => {
    const { kv } = makeKV();
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const env = createMockEnv({
      DEV_MODE: 'true',
      CDP_SECRET: MASTER,
      BROWSER: {} as Fetcher,
      NEXUS_KV: kv,
    });

    for (const path of ['/cdp/json/list', '/cdp/json']) {
      const response = await app.request(
        `http://example.com${path}?secret=${encodeURIComponent(MASTER)}`,
        { method: 'GET' },
        env,
      );
      expect(response.status).toBe(200);
      const items = (await response.json()) as { webSocketDebuggerUrl: string }[];
      expect(items[0].webSocketDebuggerUrl).not.toContain(MASTER);
      expect(items[0].webSocketDebuggerUrl).toMatch(/secret=[0-9a-f]{32}/);
    }
  });
});

describe('CDP /cdp WS endpoint — auth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Without an Upgrade: websocket header, the endpoint returns a JSON
   * listing of supported methods (this is the existing behavior used as
   * a discovery aid). We exercise the WS-upgrade auth path by sending
   * the header so the secret check actually runs.
   */
  function wsHeaders() {
    return { Upgrade: 'websocket' };
  }

  it('rejects a connection with a missing secret (401)', async () => {
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      'http://example.com/cdp',
      { method: 'GET', headers: wsHeaders() },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
      }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects an unknown session token (401) when KV resolution fails', async () => {
    const { kv } = makeKV(); // empty — token will not resolve
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      `http://example.com/cdp?secret=${'a'.repeat(32)}`,
      { method: 'GET', headers: wsHeaders() },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
        NEXUS_KV: kv,
      }),
    );
    expect(response.status).toBe(401);
  });

  // The next two cases assert "auth passed" rather than 101 directly.
  // The WebSocket upgrade response uses `WebSocketPair`, a Cloudflare
  // Workers runtime API that isn't available in vitest's plain Node
  // env — so we get a 500 from the upgrade machinery rather than a
  // 101. The status we care about for this test is "not 401" (auth
  // didn't reject), which is what changes between the seeded-token
  // path and the empty-KV path.

  it('accepts a session token that resolves in KV', async () => {
    const { kv, store } = makeKV();
    // Pre-seed a token as if /json/version had minted it.
    const token = 'b'.repeat(32);
    store.set(`cdp:session:${token}`, JSON.stringify({ at: Date.now() }));

    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      `http://example.com/cdp?secret=${token}`,
      { method: 'GET', headers: wsHeaders() },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
        NEXUS_KV: kv,
      }),
    );
    expect(response.status).not.toBe(401);
  });

  it('still accepts the master secret directly (back-compat path)', async () => {
    const { cdp } = await import('./cdp');
    const app = new Hono<AppEnv>();
    app.route('/cdp', cdp);

    const response = await app.request(
      `http://example.com/cdp?secret=${encodeURIComponent(MASTER)}`,
      { method: 'GET', headers: wsHeaders() },
      createMockEnv({
        DEV_MODE: 'true',
        CDP_SECRET: MASTER,
        BROWSER: {} as Fetcher,
      }),
    );
    expect(response.status).not.toBe(401);
  });
});
