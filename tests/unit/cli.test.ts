import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = resolve('src/cli.ts');

it('prints help/login instructions and rejects unknown commands without starting MCP', async () => {
  expect((await exec(process.execPath, ['--import', 'tsx', cli, '--help'])).stdout).toContain('serve');
  const login = (await exec(process.execPath, ['--import', 'tsx', cli, 'login-help'])).stdout;
  expect(login).toContain('${env:ProgramFiles(x86)}');
  expect(login).toContain('--remote-debugging-address=127.0.0.1');
  expect(login).toContain('doordash-mcp attach');
  await expect(exec(process.execPath, ['--import', 'tsx', cli, 'not-a-command'])).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('UNKNOWN_COMMAND') });
  await expect(exec(process.execPath, ['--import', 'tsx', cli, 'serve', 'extra'])).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('INVALID_ARGUMENTS') });
});

it.skipIf(process.platform !== 'win32')('operates on the per-user data directory independently of install location', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dd-cli-test-'));
  const env = { ...process.env, LOCALAPPDATA: directory };
  const root = join(directory, 'doordash-mcp');
  try {
    const status = await exec(process.execPath, ['--import', 'tsx', cli, 'status'], { env });
    expect(JSON.parse(status.stdout)).toMatchObject({ session_saved: false, account_verified: false });
    await mkdir(join(root, 'chrome-profile'), { recursive: true });
    await writeFile(join(root, 'chrome-profile', 'test'), 'profile');
    await writeFile(join(root, 'consumer-session.dpapi'), 'synthetic-unreadable-snapshot');
    await mkdir(join(root, 'order-operations'));
    await writeFile(join(root, 'order-operations', 'test'), 'synthetic-journal');
    await exec(process.execPath, ['--import', 'tsx', cli, 'reset-profile'], { env });
    await expect(readFile(join(root, 'chrome-profile', 'test'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'consumer-session.dpapi'), 'utf8')).toBe('synthetic-unreadable-snapshot');
    await exec(process.execPath, ['--import', 'tsx', cli, 'disconnect'], { env });
    await expect(readFile(join(root, 'consumer-session.dpapi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'order-operations', 'test'), 'utf8')).toBe('synthetic-journal');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
