import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as loadDotEnv } from 'dotenv';
import { parseDoorDashWebhookEnvelope } from '../src/doordash/webhook-schema.js';

let failureMessage = 'Invalid arguments. Use --help for usage.';
try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:8080' },
      fixture: { type: 'string' },
      secret: { type: 'string' },
      'provider-delivery-id': { type: 'string' },
      loop: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run simulate:webhook -- [options]
  --url <base>                    Default: http://127.0.0.1:8080
  --fixture <path or name>        Default: all fixtures, sorted by filename
  --secret <value>                Override DOORDASH_WEBHOOK_BASIC_AUTH (full Authorization value)
  --provider-delivery-id <string> Override external_delivery_id
  --loop <seconds>                Repeat the fixture sequence after this delay
  --help                         Show this help`);
  } else {
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid base URL.');
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/webhooks/doordash/delivery-status`;
    const loopSeconds = values.loop === undefined ? null : Number(values.loop);
    if (loopSeconds !== null && (!Number.isFinite(loopSeconds) || loopSeconds <= 0 || loopSeconds > 2_147_483.647)) {
      throw new Error('Invalid loop interval.');
    }
    if (values['provider-delivery-id'] !== undefined && !values['provider-delivery-id'].trim()) {
      throw new Error('Invalid provider delivery ID.');
    }
    loadDotEnv({ quiet: true });
    const secret = values.secret ?? process.env.DOORDASH_WEBHOOK_BASIC_AUTH;
    failureMessage = 'No webhook secret configured. Set DOORDASH_WEBHOOK_BASIC_AUTH or pass --secret with the full Authorization value.';
    if (!secret?.trim()) throw new Error('Missing secret.');
    failureMessage = 'Invalid webhook Authorization value. Check DOORDASH_WEBHOOK_BASIC_AUTH or --secret.';
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: secret });
    const authorization = headers.get('Authorization')!;
    failureMessage = 'Unable to load webhook fixtures. Check --fixture and ensure each file contains a valid DoorDash JSON payload.';
    const directory = fileURLToPath(new URL('../fixtures/webhooks/', import.meta.url));
    let paths: string[];
    if (values.fixture !== undefined) {
      const name = values.fixture;
      if (!name.trim()) throw new Error('Empty fixture name.');
      const localPath = resolve(name);
      try {
        await readFile(localPath, 'utf8');
        paths = [localPath];
      } catch {
        paths = [join(directory, name.endsWith('.json') ? name : `${name}.json`)];
      }
    } else {
      paths = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort().map((name) => join(directory, name));
    }
    if (!paths.length) throw new Error('No fixtures found.');
    const fixtures: { name: string; body: string }[] = [];
    for (const path of paths) {
      const payload: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('Invalid fixture.');
      }
      const body = values['provider-delivery-id'] === undefined
        ? payload
        : { ...payload, external_delivery_id: values['provider-delivery-id'] };
      parseDoorDashWebhookEnvelope(body);
      fixtures.push({ name: basename(path), body: JSON.stringify(body) });
    }
    const sensitiveValues = [...new Set([secret, authorization, ...authorization.split(/\s+/).slice(1)])]
      .filter(Boolean).sort((a, b) => b.length - a.length);
    do {
      for (const fixture of fixtures) {
        const name = sensitiveValues.reduce((text, value) => text.replaceAll(value, '[REDACTED]'), fixture.name);
        try {
          const response = await fetch(url, {
            method: 'POST', headers, body: fixture.body, redirect: 'error', signal: AbortSignal.timeout(10_000),
          });
          const body = sensitiveValues.reduce((text, value) => text.replaceAll(value, '[REDACTED]'), await response.text());
          console.log(`${name}: HTTP ${response.status} ${body}`);
          if (!response.ok) process.exitCode = 1;
        } catch {
          console.error(`${name}: Connection error or request timeout. Check --url and ensure the local server is running.`);
          process.exitCode = 1;
        }
      }
      if (loopSeconds !== null) await setTimeout(loopSeconds * 1000);
    } while (loopSeconds !== null);
  }
} catch {
  console.error(failureMessage);
  process.exitCode = 1;
}
