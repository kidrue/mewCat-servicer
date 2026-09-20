import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createIdentity, publicKeys } from '../src/protocol.js';
import { testStore } from './helpers.js';

describe('入口资源保护', () => {
  let fixture: Awaited<ReturnType<typeof testStore>>;
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); await fixture?.cleanup(); });
  it('被限流的请求返回 429，默认不信任伪造的 X-Forwarded-For', async () => {
    fixture = await testStore();
    const identity = await createIdentity();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', SILICONFLOW_API_KEY: 'test', SILICONFLOW_MODEL: 'test', INGRESS_REQUESTS_PER_MINUTE: '1' }), store: fixture.store,
      keys: { identity, publicKeys: await publicKeys(identity, 'server'), ipHashSecret: 'salt' },
    });
    const first = await app.inject({ method: 'GET', url: '/v1/keys', headers: { 'x-forwarded-for': '192.0.2.1' } });
    const second = await app.inject({ method: 'GET', url: '/v1/keys', headers: { 'x-forwarded-for': '192.0.2.2' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
