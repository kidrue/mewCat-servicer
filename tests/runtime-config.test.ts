import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

async function fixture(current: string, incoming: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mewcat-runtime-config-'));
  directories.push(directory);
  const envPath = join(directory, '.env');
  const runtimePath = join(directory, 'runtime.env');
  await writeFile(envPath, current, 'utf8');
  await writeFile(runtimePath, incoming, 'utf8');
  return { envPath, runtimePath };
}

function runUpdater(envPath: string, runtimePath: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/update-runtime-env.ts', envPath, runtimePath],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('生产运行时配置更新', () => {
  it('原子替换允许的上游配置并保留其他环境变量', async () => {
    const { envPath, runtimePath } = await fixture(
      'DATABASE_URL=file:/app/data/mewcat.db\nSILICONFLOW_API_KEY=old-key\nSILICONFLOW_BASE_URL=https://api.deepseek.com\nSILICONFLOW_MODEL=deepseek-flash\n',
      'SILICONFLOW_API_KEY=sk-new-key\nSILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1\nSILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash\n',
    );

    const result = runUpdater(envPath, runtimePath);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(await readFile(envPath, 'utf8')).toBe(
      'DATABASE_URL=file:/app/data/mewcat.db\nSILICONFLOW_API_KEY=sk-new-key\nSILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1\nSILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash\n',
    );
  });

  it('拒绝未知配置且不改写原文件', async () => {
    const original =
      'SILICONFLOW_API_KEY=old-key\nSILICONFLOW_MODEL=old-model\n';
    const { envPath, runtimePath } = await fixture(
      original,
      'SILICONFLOW_API_KEY=new-key\nUNEXPECTED_SECRET=leak\nSILICONFLOW_MODEL=new-model\n',
    );

    const result = runUpdater(envPath, runtimePath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('不允许的运行时配置');
    expect(await readFile(envPath, 'utf8')).toBe(original);
  });

  it('拒绝带 UTF-8 BOM 的 API key 且不改写原文件', async () => {
    const original = 'SILICONFLOW_API_KEY=sk-old-key\n';
    const { envPath, runtimePath } = await fixture(
      original,
      'SILICONFLOW_API_KEY=\ufeffsk-new-key\nSILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1\nSILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash\n',
    );

    const result = runUpdater(envPath, runtimePath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SILICONFLOW_API_KEY 格式无效');
    expect(await readFile(envPath, 'utf8')).toBe(original);
  });
});
