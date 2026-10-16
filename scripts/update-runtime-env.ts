import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const allowedKeys = [
  'SILICONFLOW_API_KEY',
  'SILICONFLOW_BASE_URL',
  'SILICONFLOW_MODEL',
  'ALLOWED_ORIGINS',
] as const;
const allowedKeySet = new Set<string>(allowedKeys);

function parseRuntimeConfig(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (!allowedKeySet.has(key)) throw new Error(`不允许的运行时配置：${key}`);
    if (!value) throw new Error(`运行时配置不能为空：${key}`);
    if (values.has(key)) throw new Error(`运行时配置重复：${key}`);
    values.set(key, value);
  }
  for (const key of allowedKeys) {
    if (!values.has(key)) throw new Error(`缺少运行时配置：${key}`);
  }
  if (!/^sk-[A-Za-z0-9._-]+$/.test(values.get('SILICONFLOW_API_KEY')!)) {
    throw new Error('SILICONFLOW_API_KEY 格式无效');
  }
  const baseUrl = new URL(values.get('SILICONFLOW_BASE_URL')!);
  if (baseUrl.protocol !== 'https:')
    throw new Error('SILICONFLOW_BASE_URL 必须使用 HTTPS');
  const origins = values.get('ALLOWED_ORIGINS')!.split(',');
  if (
    origins.some(
      (origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin),
    )
  ) {
    throw new Error('ALLOWED_ORIGINS 格式无效');
  }
  return values;
}

function mergeConfig(current: string, runtime: Map<string, string>): string {
  const retained = current
    .split(/\r?\n/)
    .filter((line) => !allowedKeys.some((key) => line.startsWith(`${key}=`)))
    .filter((line, index, lines) => line !== '' || index < lines.length - 1);
  return `${[
    ...retained,
    ...allowedKeys.map((key) => `${key}=${runtime.get(key)}`),
  ].join('\n')}\n`;
}

async function main() {
  const [envPath, runtimePath] = process.argv.slice(2);
  if (!envPath || !runtimePath)
    throw new Error('用法：update-runtime-env <envPath> <runtimePath>');
  const [current, incoming] = await Promise.all([
    readFile(envPath, 'utf8'),
    readFile(runtimePath, 'utf8'),
  ]);
  const merged = mergeConfig(current, parseRuntimeConfig(incoming));
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, merged, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (process.platform === 'win32') {
      await writeFile(envPath, merged, { encoding: 'utf8', mode: 0o600 });
      await rm(temporaryPath, { force: true });
    } else {
      await rename(temporaryPath, envPath);
      await chmod(envPath, 0o600);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '更新运行时配置失败');
  process.exitCode = 1;
});
