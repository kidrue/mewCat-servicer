import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('生产 Compose 配置', () => {
  it('未显式配置来源时允许正式及本机开发扩展访问', async () => {
    const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');

    expect(compose).toContain(
      'ALLOWED_ORIGINS: "${ALLOWED_ORIGINS:-chrome-extension://dbginmjacelgagkfhjkhcbajnaalolfp,chrome-extension://hkmlfkldkaickokgmgongeimeikkeadb}"',
    );
  });
});
