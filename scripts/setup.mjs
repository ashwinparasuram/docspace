#!/usr/bin/env node
/**
 * First-time setup: writes .env from .env.example with a fresh APP_SECRET and the values you pass.
 *   node scripts/setup.mjs --db-user=root --db-password=secret --app-url=http://docs.lan:4000
 * Re-running never overwrites an existing .env unless --force is given.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'];
  }),
);
const envPath = join(root, '.env');
if (existsSync(envPath) && !args.force) {
  console.log('.env already exists — leaving it untouched (use --force to regenerate).');
  process.exit(0);
}

const map = {
  'app-url': 'APP_URL',
  port: 'PORT',
  'db-host': 'DB_HOST',
  'db-port': 'DB_PORT',
  'db-user': 'DB_USER',
  'db-password': 'DB_PASSWORD',
  'db-name': 'DB_NAME',
  'redis-url': 'REDIS_URL',
  'ai-provider': 'AI_PROVIDER',
  'ai-base-url': 'AI_BASE_URL',
  'ai-chat-model': 'AI_CHAT_MODEL',
  'ai-embed-model': 'AI_EMBED_MODEL',
  env: 'NODE_ENV',
};

let text = readFileSync(join(root, '.env.example'), 'utf8');
const set = (key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
};
set('APP_SECRET', randomBytes(32).toString('base64url'));
for (const [flag, key] of Object.entries(map)) if (args[flag] !== undefined) set(key, args[flag]);
writeFileSync(envPath, text);
console.log(`Wrote ${envPath}. Next steps:\n  npm run build\n  npm run migrate\n  npm start`);
