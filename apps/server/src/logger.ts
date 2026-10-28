type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = order[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
const asJson = process.env.LOG_FORMAT === 'json';

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < minLevel) return;
  const time = new Date().toISOString();
  if (asJson) {
    process.stdout.write(JSON.stringify({ time, level, msg, ...meta }) + '\n');
    return;
  }
  const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
