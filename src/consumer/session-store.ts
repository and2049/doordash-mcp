import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const cookieSchema = z.object({
  name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
  expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});
const storageSchema = z.object({
  cookies: z.array(cookieSchema),
  origins: z.array(z.object({
    origin: z.string().url(),
    localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
  })),
});
const sessionSchema = z.object({
  version: z.literal(1), savedAt: z.string().datetime(), storage: storageSchema, accountId: z.string().min(1).max(100).optional(),
});
export type ConsumerSession = z.infer<typeof sessionSchema>;

export function sessionPath(): string {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('Consumer session storage currently requires Windows.');
  }
  return join(process.env.LOCALAPPDATA, 'doordash-mcp', 'consumer-session.dpapi');
}

function doorDashHost(host: string): boolean {
  const normalized = host.replace(/^\./, '').toLowerCase();
  return normalized === 'doordash.com' || normalized.endsWith('.doordash.com');
}

export function prepareSession(storage: unknown): ConsumerSession {
  const parsed = storageSchema.parse(storage);
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    storage: {
      cookies: parsed.cookies.filter((cookie) => doorDashHost(cookie.domain)),
      origins: parsed.origins.filter(({ origin }) => {
        const url = new URL(origin);
        return url.protocol === 'https:' && doorDashHost(url.hostname);
      }),
    },
  };
}

export async function protectSession(input: Buffer, decrypt = false): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('DPAPI requires Windows.');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error('Windows could not protect or restore the consumer session.'));
      else resolve(Buffer.from(stdout.trim(), 'base64'));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input.toString('base64'));
  });
}

export async function saveSession(storage: unknown, path = sessionPath(), accountId?: string): Promise<void> {
  try {
    const session = sessionSchema.parse({ ...prepareSession(storage), accountId });
    const encrypted = await protectSession(Buffer.from(JSON.stringify(session)));
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  } catch {
    throw new Error('Could not securely save the consumer session. Existing saved state was retained if replacement failed.');
  }
}

export async function loadSession(path = sessionPath()): Promise<ConsumerSession | null> {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error('Could not read the saved consumer session.', { cause: error });
  }
  try {
    const plain = await protectSession(encrypted, true);
    return sessionSchema.parse(JSON.parse(plain.toString('utf8')) as unknown);
  } catch {
    throw new Error('Could not restore the saved consumer session. Reconnect using the same Windows user or disconnect to remove it.');
  }
}

export async function deleteSession(path = sessionPath()): Promise<void> {
  await rm(path, { force: true });
}
