#!/usr/bin/env node
/**
 * Verifies published-site access control for every visibility mode, for anonymous visitors,
 * signed-in members, members using "view as visitor", password unlocks and share links.
 * Usage: node scripts/access-test.mjs [baseUrl]   (needs the demo data from `npm run seed`)
 */
const base = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const site = '/s/acme/api';
let failures = 0;

async function req(path, { cookie = '', method = 'GET', body, form } = {}) {
  const headers = { cookie, 'x-requested-with': 'docspace' };
  let payload;
  if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  }
  const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie?.() || [];
  return { status: res.status, text: await res.text(), cookies: setCookies.map((c) => c.split(';')[0]), cache: res.headers.get('cache-control') };
}

const merge = (...jars) => jars.flat().filter(Boolean).join('; ');

function expect(label, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const login = await req('/api/auth/login', { method: 'POST', body: { email: 'admin@docspace.local', password: 'ChangeMe123' } });
const member = login.cookies.join('; ');
const spaces = JSON.parse((await req('/api/orgs/acme/spaces', { cookie: member })).text);
const space = spaces.find((s) => s.slug === 'api');
const original = JSON.parse((await req(`/api/spaces/${space.id}`, { cookie: member })).text);

async function setMode(visibility, extra = {}) {
  const r = await req(`/api/spaces/${space.id}/publishing`, { cookie: member, method: 'PUT', body: { published: true, visibility, ...extra } });
  return JSON.parse(r.text);
}

console.log(`Access control test → ${base}${site}\n`);

for (const mode of ['public', 'unlisted']) {
  await setMode(mode);
  const anon = await req(site);
  expect(`${mode}: anonymous can read`, anon.status === 200, anon.status);
  expect(`${mode}: page revalidates (no max-age)`, !/max-age=[1-9]/.test(anon.cache || ''), anon.cache);
}

const { shareToken } = await setMode('password', { password: 'letmein123' });
let anon = await req(site);
expect('password: anonymous gets the password prompt', anon.status === 401 && anon.text.includes('password protected'), anon.status);
const wrong = await req(`${site}/_auth`, { method: 'POST', form: { password: 'nope', next: site } });
const wrongFollow = await req(site, { cookie: wrong.cookies.join('; ') });
expect('password: wrong password stays locked', wrongFollow.status === 401, wrongFollow.status);
const unlock = await req(`${site}/_auth`, { method: 'POST', form: { password: 'letmein123', next: site } });
const unlocked = unlock.cookies.join('; ');
expect('password: correct password unlocks', (await req(site, { cookie: unlocked })).status === 200, 'still locked');
const asMember = await req(site, { cookie: member });
expect('password: signed-in member can read, with a notice', asMember.status === 200 && asMember.text.includes('member-notice'), asMember.status);
const visitorMode = await req(`${site}?as=visitor`, { cookie: member });
expect('password: member "view as visitor" gets the prompt', visitorMode.status === 401, visitorMode.status);
const back = await req(`${site}?as=member`, { cookie: merge(member, visitorMode.cookies) });
expect('password: member can switch back', back.status === 200, back.status);

await setMode('members');
expect('members: old password cookie no longer works', (await req(site, { cookie: unlocked })).status === 401, 'stale cookie still grants access');
anon = await req(site);
expect('members: anonymous is asked to sign in', anon.status === 401 && anon.text.includes('Sign in'), anon.status);
expect('members: signed-in member can read', (await req(site, { cookie: member })).status === 200, 'denied');
const search = await req(`/api/public/sites/${space.id}/search?q=product`);
expect('members: public search API is blocked for anonymous', search.status === 404, search.status);
const md = await req(`${site}/llms.txt`);
expect('members: llms.txt is blocked for anonymous', md.status === 401, md.status);

await setMode('share');
anon = await req(site);
expect('share: anonymous without link gets 404', anon.status === 404, anon.status);
const viaLink = await req(`${site}?share=${shareToken}`);
expect('share: secret link grants access', viaLink.status === 200, viaLink.status);
expect('share: link sets a cookie for later visits', (await req(site, { cookie: viaLink.cookies.join('; ') })).status === 200, 'cookie not accepted');
expect('share: a bad link is rejected', (await req(`${site}?share=wrong`)).status === 404, 'accepted');

await req(`/api/spaces/${space.id}/publishing`, { cookie: member, method: 'PUT', body: { published: false, visibility: 'public' } });
expect('unpublished: anonymous gets 404', (await req(site)).status === 404, 'visible');
const preview = await req(site, { cookie: member });
expect('unpublished: member preview works, with a notice', preview.status === 200 && preview.text.includes('not published'), preview.status);

// Restore the original settings.
await req(`/api/spaces/${space.id}/publishing`, { cookie: member, method: 'PUT', body: { published: !!original.published, visibility: original.visibility === 'password' ? 'public' : original.visibility } });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll access checks passed');
process.exit(failures ? 1 : 0);
