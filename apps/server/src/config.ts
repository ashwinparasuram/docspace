import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// Repository root (apps/server/src|dist -> ../../..). Load root .env as a fallback.
export const repoRoot = resolve(here, '../../..');
if (existsSync(join(repoRoot, '.env'))) loadEnv({ path: join(repoRoot, '.env') });

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const appUrl = env('APP_URL', 'http://localhost:4000').replace(/\/$/, '');

export const config = {
  env: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV') === 'production',
  port: Number(env('PORT', '4000')),
  // Empty = all interfaces, IPv4 and IPv6 (so both 127.0.0.1 and ::1 "localhost" work).
  host: env('HOST', ''),
  appUrl,
  appHost: new URL(appUrl).host,
  secret: env('APP_SECRET', 'dev-insecure-secret-change-me'),
  trustProxy: bool('TRUST_PROXY', false),
  allowRegistration: bool('ALLOW_REGISTRATION', true),
  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', '3306')),
    user: env('DB_USER', 'docspace'),
    password: env('DB_PASSWORD', 'docspace'),
    database: env('DB_NAME', 'docspace'),
    connectionLimit: Number(env('DB_POOL', '15')),
  },
  // Empty REDIS_URL -> in-process memory cache/pubsub (single node only).
  redisUrl: env('REDIS_URL', ''),
  storage: {
    driver: env('STORAGE_DRIVER', 'local') as 'local' | 's3',
    localDir: resolve(repoRoot, env('STORAGE_DIR', 'data/uploads')),
    s3Endpoint: env('S3_ENDPOINT', ''),
    s3Region: env('S3_REGION', 'us-east-1'),
    s3Bucket: env('S3_BUCKET', 'docspace'),
    s3AccessKey: env('S3_ACCESS_KEY', ''),
    s3SecretKey: env('S3_SECRET_KEY', ''),
    maxUploadMb: Number(env('MAX_UPLOAD_MB', '50')),
  },
  ai: {
    // none | ollama | openai (any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, LocalAI...)
    provider: env('AI_PROVIDER', 'none') as 'none' | 'ollama' | 'openai',
    baseUrl: env('AI_BASE_URL', 'http://127.0.0.1:11434'),
    apiKey: env('AI_API_KEY', ''),
    chatModel: env('AI_CHAT_MODEL', 'llama3.2'),
    embedModel: env('AI_EMBED_MODEL', ''),
  },
  playgroundProxyAllowPrivate: bool('PLAYGROUND_PROXY_ALLOW_PRIVATE', false),
  webDist: resolve(repoRoot, 'apps/web/dist'),
  siteAssetsDir: join(here, 'site/assets'),
};

export type AppConfig = typeof config;
