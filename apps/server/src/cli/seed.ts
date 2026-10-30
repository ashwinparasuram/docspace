/**
 * Creates a demo workspace: an admin account, an organization, a published product-docs space
 * and an API reference space generated from a bundled OpenAPI spec.
 */
import { runMigrations } from '../migrate.js';
import { exec, insert, one, pool } from '../db.js';
import { hashPassword } from '../auth/session.js';
import { createSpaceWithDefaults } from '../routes/spaces.js';
import { createPage, getMainBranch } from '../content/pages.js';
import { deref, overviewDoc, parseSpec, specToPages } from '../content/openapi.js';
import { reindexSpace } from '../search/indexer.js';
import { logger } from '../logger.js';
import { uuid } from '../util.js';
import { DEMO_SPEC } from './demo-spec.js';

const email = process.env.SEED_EMAIL || 'admin';
const password = process.env.SEED_PASSWORD || 'password';

async function main() {
  await runMigrations();
  let user = await one('SELECT * FROM users WHERE email=?', [email]);
  if (!user) {
    const id = uuid();
    await insert('users', { id, email, name: 'Admin', password_hash: await hashPassword(password), is_admin: 1 });
    user = { id };
    logger.info(`Created admin user ${email} / ${password}`);
  }
  if (await one("SELECT id FROM organizations WHERE slug='acme'")) {
    logger.info('Demo organization already exists; nothing to do');
    return;
  }
  const orgId = uuid();
  await insert('organizations', { id: orgId, name: 'Acme Inc.', slug: 'acme', settings: {} });
  await insert('org_members', { org_id: orgId, user_id: user.id, role: 'owner' });

  const product = await createSpaceWithDefaults(orgId, user.id, { name: 'Product Docs', description: 'Everything you need to use Acme.', template: 'product' });
  await exec("UPDATE spaces SET published=1, visibility='public', theme=? WHERE id=?", [
    JSON.stringify({ primaryColor: '#2557d6', headerLinks: [{ label: 'API reference', url: '/s/acme/api' }] }),
    product.id,
  ]);

  const api = await createSpaceWithDefaults(orgId, user.id, { name: 'API', description: 'REST API reference.', template: 'api' });
  await exec("UPDATE spaces SET published=1, visibility='public', theme=? WHERE id=?", [JSON.stringify({ primaryColor: '#0f766e' }), api.id]);
  const spec = parseSpec(DEMO_SPEC);
  const specId = uuid();
  await insert('openapi_specs', { id: specId, space_id: api.id, name: spec.info.title, spec, api_version: spec.info.version });
  const main = await getMainBranch(api.id);
  const group = await createPage({ spaceId: api.id, branchId: main!.id, title: 'API reference', kind: 'group', userId: user.id });
  await createPage({ spaceId: api.id, branchId: main!.id, title: 'Reference overview', parentStableId: group.stableId, content: overviewDoc(spec), userId: user.id });
  for (const p of specToPages(specId, deref(spec))) {
    await createPage({ spaceId: api.id, branchId: main!.id, title: p.title, parentStableId: group.stableId, kind: 'api', description: p.description, content: p.doc, userId: user.id });
  }
  await reindexSpace(product.id);
  await reindexSpace(api.id);
  logger.info('Demo content created: /s/acme/product-docs and /s/acme/api');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Seed failed', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
