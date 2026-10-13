import { describe, expect, test, vi } from 'vitest';

import { runCreateFolder } from '../../src/cli/googleCreateFolder.js';

const ENV: NodeJS.ProcessEnv = {
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'super-secret-value',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'super-refresh-token',
};

function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('runCreateFolder', () => {
  test('creates the folder with the given name and prints its id, never a secret', async () => {
    const out = capture();
    const createFolder = vi.fn((_name: string) => Promise.resolve('folder-xyz'));

    const code = await runCreateFolder(['my', 'folder'], {
      env: ENV,
      createDrive: () => ({ createFolder }),
    });
    out.restore();

    expect(code).toBe(0);
    expect(createFolder).toHaveBeenCalledWith('my folder');
    const text = out.lines.join('');
    expect(text).toContain('folder-xyz');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('super-refresh-token');
  });

  test('refuses to run without a folder name (no clinic name is hard-coded)', async () => {
    const out = capture();
    const createFolder = vi.fn((_name: string) => Promise.resolve('x'));

    const code = await runCreateFolder([], { env: ENV, createDrive: () => ({ createFolder }) });
    out.restore();

    expect(code).toBe(1);
    expect(createFolder).not.toHaveBeenCalled();
  });

  test('names the missing variables instead of failing obscurely', async () => {
    const out = capture();

    const code = await runCreateFolder(['x'], {
      env: { GOOGLE_OAUTH_CLIENT_ID: 'cid' },
      createDrive: () => ({ createFolder: vi.fn((_name: string) => Promise.resolve('x')) }),
    });
    out.restore();

    expect(code).toBe(1);
    expect(out.lines.join('')).toMatch(/GOOGLE_OAUTH_CLIENT_SECRET.*GOOGLE_OAUTH_REFRESH_TOKEN/);
  });
});
