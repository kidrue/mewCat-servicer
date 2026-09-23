import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'mewcat-smoke-'));
const environment = {
  ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1',
  DATABASE_URL: `file:${relative(process.cwd(), join(directory, 'smoke.db')).replaceAll('\\', '/')}`,
  KEYS_FILE: join(directory, 'server-keys.json'),
  SILICONFLOW_API_KEY: 'smoke-placeholder-never-used', SILICONFLOW_MODEL: 'smoke-placeholder-never-used',
};

async function command(args, expectedCode = 0) {
  const child = spawn(process.execPath, args, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', (part) => { output += part; });
  const [code] = await once(child, 'exit');
  assert.equal(code, expectedCode, `Command failed: ${args[0]}\n${output}`);
  return output;
}

let service;
try {
  await command([resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy']);
  await command([resolve('dist/scripts/admin.js'), 'keys']);
  const original = await readFile(environment.KEYS_FILE, 'utf8');
  await command([resolve('dist/scripts/admin.js'), 'keys'], 1);
  assert.equal(await readFile(environment.KEYS_FILE, 'utf8'), original, 'Existing keys must not be overwritten');
  await command([resolve('dist/scripts/admin.js'), 'clients']);
  await command([resolve('dist/scripts/admin.js'), 'cleanup']);

  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  service = spawn(process.execPath, [resolve('dist/src/server.js')], { env: { ...environment, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  service.stdout.on('data', (part) => { logs += part; });
  service.stderr.on('data', (part) => { logs += part; });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* process is starting */ }
    if (service.exitCode !== null) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(ready, `Server did not start: ${logs}`);
  // 使用真正构建出的客户端通过本地 TCP 请求完成注册和用量查询。
  const { TranslationClient } = await import('../dist/client/index.js');
  const client = await TranslationClient.connect({ baseUrl });
  const clientId = await client.register('smoke-extension');
  assert.match(clientId, /^[0-9a-f-]{36}$/);
  assert.equal((await client.usage()).usedCharacters, 0);
  await command([resolve('dist/scripts/admin.js'), 'revoke', clientId]);
  await assert.rejects(client.usage(), (error) => error.code === 'CLIENT_REVOKED');
  console.log('Smoke passed: relative database URL, migrations, key protection, compiled server, TCP registration/usage/revocation. No paid API called.');
} finally {
  if (service && service.exitCode === null) {
    const exited = once(service, 'exit');
    service.kill();
    await exited;
  }
  // directory 只来自本脚本 mkdtemp，绝不使用用户传入的路径删除。
  await rm(directory, { recursive: true, force: true });
}
