import { createHash, randomBytes } from 'node:crypto';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { calculateJwkThumbprint, type JWK } from 'jose';
import { PrismaClient, Prisma } from './generated/prisma/client.js';
import { ApiError } from './errors.js';

export interface Bucket { key: string; amount: number; limit: number; expiresAt: Date }
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
type Tx = Prisma.TransactionClient;

async function consume(tx: Tx, buckets: Bucket[]) {
  for (const bucket of buckets) {
    if (!Number.isSafeInteger(bucket.amount) || bucket.amount <= 0 || !Number.isSafeInteger(bucket.limit) || bucket.limit < bucket.amount) {
      throw new ApiError(429, 'QUOTA_EXCEEDED', '已达到当前时段的使用限额');
    }
    await tx.usageBucket.upsert({ where: { key: bucket.key }, create: { key: bucket.key, used: 0, expiresAt: bucket.expiresAt }, update: {} });
    const result = await tx.usageBucket.updateMany({ where: { key: bucket.key, used: { lte: bucket.limit - bucket.amount } }, data: { used: { increment: bucket.amount } } });
    if (result.count !== 1) throw new ApiError(429, 'QUOTA_EXCEEDED', '已达到当前时段的使用限额');
  }
}

async function activeClient(tx: Tx, id: string) {
  const client = await tx.client.findUnique({ where: { id } });
  if (!client) throw new ApiError(401, 'UNAUTHORIZED', '客户端身份无效');
  if (client.revokedAt) throw new ApiError(403, 'CLIENT_REVOKED', '客户端已被停用');
  return client;
}

export class Store {
  readonly db: PrismaClient;
  // SQLite 部署使用单个进程。队列避免同连接上交叠事务；数据库条件更新仍负责额度约束。
  private writes: Promise<unknown> = Promise.resolve();
  constructor(url: string) {
    this.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  private atomic<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const result = this.writes.then(() => this.db.$transaction(work, { maxWait: 10_000, timeout: 10_000 }));
    this.writes = result.catch(() => undefined);
    return result;
  }
  async issueInvitation(ttlSeconds: number, now = Date.now()): Promise<string> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 30 * 86_400) throw new Error('邀请码有效期应为 1 秒至 30 天');
    const token = randomBytes(32).toString('base64url');
    await this.atomic((tx) => tx.invitation.create({ data: { tokenHash: hashToken(token), expiresAt: new Date(now + ttlSeconds * 1000) } }));
    return token;
  }
  async registerClient(token: string, name: string, signing: JWK, encryption: JWK) {
    const keyThumbprint = await calculateJwkThumbprint(signing);
    try {
      return await this.atomic(async (tx) => {
        const tokenHash = hashToken(token);
        const existing = await tx.client.findUnique({ where: { keyThumbprint } });
        if (existing) {
          if (existing.revokedAt) throw new ApiError(403, 'CLIENT_REVOKED', '客户端已被停用');
          if (existing.registrationTokenHash === tokenHash && await calculateJwkThumbprint(JSON.parse(existing.encryptionKey)) === await calculateJwkThumbprint(encryption)) return existing;
          throw new ApiError(409, 'CLIENT_EXISTS', '该设备密钥已注册，请使用原邀请码和密钥恢复');
        }
        const now = new Date();
        const claim = await tx.invitation.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
        if (claim.count !== 1) throw new ApiError(403, 'INVALID_INVITATION', '邀请码无效、过期或已使用');
        return tx.client.create({ data: { name, signingKey: JSON.stringify(signing), encryptionKey: JSON.stringify(encryption), keyThumbprint, registrationTokenHash: tokenHash } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'CLIENT_EXISTS', '该设备密钥已注册');
      throw error;
    }
  }
  async revokeClient(id: string): Promise<void> {
    await this.atomic(async (tx) => { await tx.client.update({ where: { id }, data: { revokedAt: new Date() } }); });
  }
  async consumeNonce(id: string, nonce: string, expiresAt: number): Promise<void> {
    try {
      await this.atomic(async (tx) => {
        await activeClient(tx, id);
        await tx.nonce.create({ data: { clientId: id, value: nonce, expiresAt: new Date(expiresAt) } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'REPLAY_DETECTED', '请求已处理，请勿重放');
      throw error;
    }
  }
  async consumeBuckets(buckets: Bucket[]): Promise<void> { await this.atomic((tx) => consume(tx, buckets)); }
  async reserveTranslation(clientId: string, characters: number, buckets: Bucket[]) {
    return this.atomic(async (tx) => {
      await activeClient(tx, clientId);
      await consume(tx, buckets);
      return tx.translationRequest.create({ data: { clientId, inputCharacters: characters } });
    });
  }
  async finishTranslation(id: string, status: 'success' | 'failed', promptTokens: number | null = null, completionTokens: number | null = null): Promise<void> {
    await this.atomic(async (tx) => { await tx.translationRequest.update({ where: { id }, data: { status, promptTokens, completionTokens } }); });
  }
  async used(key: string): Promise<number> { return (await this.db.usageBucket.findUnique({ where: { key } }))?.used ?? 0; }
  async cleanup(now = Date.now(), retentionDays = 30) {
    return this.atomic(async (tx) => ({
      nonces: (await tx.nonce.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count,
      buckets: (await tx.usageBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count,
      invitations: (await tx.invitation.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count,
      requests: (await tx.translationRequest.deleteMany({ where: { createdAt: { lt: new Date(now - retentionDays * 86_400_000) } } })).count,
    }));
  }
}
export const createStore = (url: string): Store => new Store(url);
