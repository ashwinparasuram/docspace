#!/usr/bin/env node
/**
 * End-to-end API smoke test against a running instance (default http://localhost:4000).
 * Requires the demo data from `npm run seed`. Usage: node scripts/smoke-test.mjs [baseUrl]
 */
const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const email = process.env.SEED_EMAIL || 'admin@docspace.local';
const password = process.env.SEED_PASSWORD || 'ChangeMe123';
let cookie = '';
let failures = 0;

async function call(method, path, body, raw = false) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'docspace', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof data === 'object' ? data.error : data.slice(0, 200)}`);
  return data;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`DocSpace smoke test → ${base}\n`);
let space, main, branchId, cr, page;

await step('health', async () => (await call('GET', '/healthz')).db && 'db ok');
await step('login', async () => {
  await call('POST', '/api/auth/login', { email, password });
  const me = await call('GET', '/api/auth/me');
  assert(me.user?.email === email, 'not logged in');
  return me.user.name;
});
await step('list spaces', async () => {
  const spaces = await call('GET', '/api/orgs/acme/spaces');
  space = await call('GET', `/api/spaces/${spaces.find((s) => s.slug === 'product-docs').id}`);
  main = space.branches.find((b) => b.is_main);
  return `${spaces.length} spaces`;
});
await step('page tree', async () => {
  const tree = await call('GET', `/api/spaces/${space.id}/branches/${main.id}/tree`);
  page = tree.pages.find((p) => p.title === 'Getting started').children[0];
  return `${tree.pages.length} root pages`;
});
await step('create change request + branch', async () => {
  const res = await call('POST', `/api/spaces/${space.id}/change-requests`, { title: `Smoke test ${Date.now()}`, description: 'Automated' });
  cr = res;
  branchId = res.branchId;
  return `#${res.number}`;
});
let branchPage;
await step('edit page in branch', async () => {
  const tree = await call('GET', `/api/spaces/${space.id}/branches/${branchId}/tree`);
  branchPage = tree.pages.find((p) => p.title === 'Getting started').children.find((c) => c.stableId === page.stableId);
  await call('PUT', `/api/pages/${branchPage.id}/content`, { markdown: `## Smoke test\n\nEdited at ${new Date().toISOString()} in a branch.`, mode: 'append' });
  const changes = await call('GET', `/api/spaces/${space.id}/branches/${branchId}/changes`);
  assert(changes.length === 1 && changes[0].type === 'modified', 'expected one modified page');
  return 'diff detected';
});
await step('new page in branch', async () => {
  await call('POST', `/api/spaces/${space.id}/branches/${branchId}/pages`, { title: 'Smoke page', markdown: '# Hello\n\n> [!TIP]\n> Works' });
});
await step('change request detail with diff', async () => {
  const d = await call('GET', `/api/spaces/${space.id}/change-requests/${cr.number}`);
  assert(d.changes.length === 2, `expected 2 changes, got ${d.changes.length}`);
  assert(d.changes.some((c) => c.diff.some((x) => x.added)), 'no added lines');
  return `${d.changes.length} changes`;
});
await step('comment on change request', async () => {
  const d = await call('GET', `/api/spaces/${space.id}/change-requests/${cr.number}`);
  await call('POST', `/api/spaces/${space.id}/comments`, { body: 'Looks good', crId: d.id });
});
await step('review (comment)', async () => call('POST', `/api/spaces/${space.id}/change-requests/${cr.number}/reviews`, { state: 'commented', body: 'Reviewed' }) && 'ok');
await step('mark ready + merge', async () => {
  await call('PATCH', `/api/spaces/${space.id}/change-requests/${cr.number}`, { status: 'open' });
  const res = await call('POST', `/api/spaces/${space.id}/change-requests/${cr.number}/merge`, {});
  return `${res.merged} merged`;
});
await step('main updated + published', async () => {
  await new Promise((r) => setTimeout(r, 500));
  const md = await (await call('GET', `/s/acme/product-docs/getting-started/${page.slug}.md`, undefined, true)).text();
  assert(md.includes('Smoke test'), 'merged content not on published site');
  const tree = await call('GET', `/api/spaces/${space.id}/branches/${main.id}/tree`);
  const smoke = tree.pages.filter((p) => p.title === 'Smoke page');
  for (const s of smoke) await call('DELETE', `/api/pages/${s.id}`);
  return 'published markdown contains merged text';
});
await step('version history', async () => {
  const mainPage = (await call('GET', `/api/spaces/${space.id}/branches/${main.id}/tree`)).pages.find((p) => p.title === 'Getting started').children.find((c) => c.stableId === page.stableId);
  await call('POST', `/api/pages/${mainPage.id}/versions`, { message: 'smoke checkpoint' });
  const versions = await call('GET', `/api/pages/${mainPage.id}/versions`);
  assert(versions.length > 0, 'no versions');
  const v = await call('GET', `/api/pages/${mainPage.id}/versions/${versions[versions.length - 1].id}`);
  assert(Array.isArray(v.diff), 'no diff');
  return `${versions.length} versions`;
});
await step('page comments', async () => {
  const c = await call('POST', `/api/spaces/${space.id}/comments`, { body: 'Inline note', pageStableId: page.stableId, branchId: main.id, quote: 'quoted' });
  await call('POST', `/api/spaces/${space.id}/comments/threads/${c.threadId}/resolve`, { resolved: true });
  return 'created + resolved';
});
await step('quality report', async () => `avg ${(await call('GET', `/api/spaces/${space.id}/quality`)).averageScore}`);
await step('public search', async () => `${(await call('GET', `/api/public/sites/${space.id}/search?q=install`)).results.length} hits`);
await step('feedback', async () => call('POST', `/api/public/sites/${space.id}/feedback`, { pageId: page.stableId, rating: -1, comment: 'smoke' }) && 'ok');
await step('AI agent markdown fetch', async () => {
  const res = await fetch(`${base}/s/acme/product-docs/llms.txt`, { headers: { 'user-agent': 'ClaudeBot/1.0' } });
  assert(res.ok, 'llms.txt failed');
});
await step('analytics', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const a = await call('GET', `/api/spaces/${space.id}/analytics?days=7`);
  return `${a.totals.pageviews} views, ${a.totals.ai_agent_requests} AI-agent requests`;
});
await step('content gaps', async () => `${(await call('GET', `/api/spaces/${space.id}/gaps?days=30`)).suggestedTopics.length} topics`);
await step('webhook create + test', async () => {
  const wh = await call('POST', '/api/orgs/acme/webhooks', { url: `${base}/healthz`, events: ['*'] });
  const r = await call('POST', `/api/orgs/acme/webhooks/${wh.id}/test`);
  await call('DELETE', `/api/orgs/acme/webhooks/${wh.id}`);
  return `ping ${r.code}`;
});
await step('audit log', async () => `${(await call('GET', '/api/orgs/acme/audit')).length} entries`);
await step('admin stats', async () => {
  const s = await call('GET', '/api/admin/stats');
  return `${s.counts.users} users, cache=${s.health.cache.kind}`;
});
await step('redirect after move', async () => {
  const redirects = await call('GET', `/api/spaces/${space.id}/redirects`);
  return `${redirects.length} redirects`;
});

console.log(failures ? `\n${failures} step(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
