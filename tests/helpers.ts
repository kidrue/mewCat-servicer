import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../src/store.js';

export async function testStore() {
  const directory = await mkdtemp(join(tmpdir(), 'mewcat-api-'));
  const store = createStore(`file:${join(directory, 'test.db').replaceAll('\\', '/')}`);
  const sql = await readFile(resolve('prisma/migrations/20260920000000_init/migration.sql'), 'utf8');
  for (const statement of sql.split(';').filter((part) => part.trim())) await store.db.$executeRawUnsafe(statement);
  return { store, async cleanup() { await store.db.$disconnect(); await rm(directory, { recursive: true, force: true }); } };
}
