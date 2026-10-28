import mysql from 'mysql2/promise';
import { config } from './config.js';
import { exec, query } from './db.js';
import { migrations } from './migrations.js';
import { logger } from './logger.js';

/** Create the database if it does not exist (requires CREATE privilege; ignored otherwise). */
export async function ensureDatabase(): Promise<void> {
  try {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.end();
  } catch (err) {
    logger.warn('Could not ensure database exists', { error: (err as Error).message });
  }
}

export async function runMigrations(): Promise<void> {
  await ensureDatabase();
  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(100) PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const applied = new Set((await query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    logger.info(`Applying migration ${m.id}`);
    for (const stmt of m.statements) await exec(stmt);
    await exec('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
  }
}
