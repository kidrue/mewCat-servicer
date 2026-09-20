import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, type Store } from '../src/store.js';

describe('持久化防滥用', () => {
  let store: Store;
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mewcat-store-'));
    store = createStore(`file:${join(directory, 'test.db').replaceAll('\\', '/')}`);
    const sql = await readFile(resolve('prisma/migrations/20260920000000_init/migration.sql'), 'utf8');
    for (const statement of sql.split(';').filter((part) => part.trim())) {
      await store.db.$executeRawUnsafe(statement);
    }
  });
  afterEach(async () => {
    await store?.db.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function register() {
    const token = await store.issueInvitation(3600);
    return store.registerClient(token, '测试扩展', { kty: 'EC', crv: 'P-256', x: crypto.randomUUID(), y: 'test' }, { kty: 'RSA', n: 'test', e: 'AQAB' });
  }

  it('一次性邀请码的并发注册只能成功一次，数据库不保存邀请码原文', async () => {
    const token = await store.issueInvitation(3600);
    const attempts = await Promise.allSettled([1, 2].map((index) => store.registerClient(token, 'extension', { kty: 'EC', crv: 'P-256', x: `device-${index}`, y: 'test' }, { kty: 'RSA', n: 'test', e: 'AQAB' })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.db.client.count()).toBe(1);
    expect(JSON.stringify(await store.db.invitation.findMany())).not.toContain(token);
  });

  it('响应丢失后，持有原密钥和邀请码的设备可找回 ID，不能换响应公钥或恢复已撤销身份', async () => {
    const token = await store.issueInvitation(3600);
    const signing = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
    const encryption = { kty: 'RSA', n: 'n', e: 'AQAB' };
    const registered = await store.registerClient(token, 'extension', signing, encryption);
    expect((await store.registerClient(token, 'extension', signing, encryption)).id).toBe(registered.id);
    expect(await store.db.client.count()).toBe(1);
    await expect(store.registerClient(token, 'extension', signing, { ...encryption, n: 'different' })).rejects.toMatchObject({ code: 'CLIENT_EXISTS' });
    await store.revokeClient(registered.id);
    await expect(store.registerClient(token, 'extension', signing, encryption)).rejects.toMatchObject({ code: 'CLIENT_REVOKED' });
  });

  it('拒绝过期邀请码，拒绝已撤销设备的请求', async () => {
    const token = await store.issueInvitation(3600, 1_000);
    await expect(store.registerClient(token, 'old', { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, { kty: 'RSA', n: 'n', e: 'AQAB' })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    const client = await register();
    await store.revokeClient(client.id);
    await expect(store.consumeNonce(client.id, crypto.randomUUID(), Date.now() + 600_000)).rejects.toMatchObject({ code: 'CLIENT_REVOKED' });
  });

  it('并发重放只允许一个请求，记录在整个有效时间窗口内保留', async () => {
    const client = await register();
    const now = Date.now();
    const nonce = crypto.randomUUID();
    const attempts = await Promise.allSettled([1, 2, 3].map(() => store.consumeNonce(client.id, nonce, now + 600_000)));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await store.cleanup(now + 300_001);
    await expect(store.consumeNonce(client.id, nonce, now + 600_000)).rejects.toMatchObject({ code: 'REPLAY_DETECTED' });
    await store.cleanup(now + 600_001);
    expect(await store.db.nonce.count()).toBe(0);
  });

  it('并发额度扣减不超额，某一维超额时所有维度整体回滚', async () => {
    const attempts = await Promise.allSettled([1, 2, 3, 4, 5].map(() => store.consumeBuckets([
      { key: 'device', amount: 1, limit: 10, expiresAt: new Date(Date.now() + 60_000) },
      { key: 'global', amount: 1, limit: 2, expiresAt: new Date(Date.now() + 60_000) },
    ])));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect((await store.db.usageBucket.findUniqueOrThrow({ where: { key: 'device' } })).used).toBe(2);
    expect((await store.db.usageBucket.findUniqueOrThrow({ where: { key: 'global' } })).used).toBe(2);
  });
});
