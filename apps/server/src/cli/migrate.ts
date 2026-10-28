import { runMigrations } from '../migrate.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';

runMigrations()
  .then(async () => {
    logger.info('Migrations complete');
    await pool.end();
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Migration failed', { error: (err as Error).message });
    process.exit(1);
  });
