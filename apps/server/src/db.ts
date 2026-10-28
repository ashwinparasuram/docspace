import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';

export const pool: Pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  multipleStatements: false,
});

type Executor = Pool | PoolConnection;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

export async function query<T = Row>(sql: string, params: unknown[] = [], conn: Executor = pool): Promise<T[]> {
  const [rows] = await conn.query(sql, params);
  return rows as T[];
}

export async function one<T = Row>(sql: string, params: unknown[] = [], conn: Executor = pool): Promise<T | null> {
  const rows = await query<T>(sql, params, conn);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: unknown[] = [], conn: Executor = pool): Promise<ResultSetHeader> {
  const [res] = await conn.query(sql, params);
  return res as ResultSetHeader;
}

export async function tx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Insert a row from an object. Values that are plain objects/arrays are JSON-encoded. */
export async function insert(table: string, data: Row, conn: Executor = pool): Promise<ResultSetHeader> {
  const keys = Object.keys(data);
  const values = keys.map((k) => encodeValue(data[k]));
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return exec(sql, values, conn);
}

export async function update(table: string, where: Row, data: Row, conn: Executor = pool): Promise<ResultSetHeader> {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return { affectedRows: 0 } as ResultSetHeader;
  const wk = Object.keys(where);
  const sql = `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE ${wk.map((k) => `\`${k}\`=?`).join(' AND ')}`;
  return exec(sql, [...keys.map((k) => encodeValue(data[k])), ...wk.map((k) => where[k])], conn);
}

function encodeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || v instanceof Date || Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Parse a JSON column. MySQL JSON columns arrive parsed, MariaDB/LONGTEXT arrive as strings. */
export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
