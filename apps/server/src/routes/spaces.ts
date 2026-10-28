import { Router } from 'express';
import multer from 'multer';
import { resolveTxt, resolveCname } from 'node:dns/promises';
import { z } from 'zod';
import { exec, insert, json, one, query, tx } from '../db.js';
import { hashPassword, requireAuth } from '../auth/session.js';
import { requireSpace, ROLES, canEditBranch, type SpaceSettings } from '../permissions.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { ah, badRequest, forbidden, notFound, parse, randomToken, slugify, uuid, HttpError } from '../util.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { createBranch, createPage, getMainBranch, updateBranchFromMain, branchChanges } from '../content/pages.js';
import { markdownToJson } from '../content/prosemirror.js';
import { TEMPLATES, type TemplatePage } from '../content/templates.js';
import { bumpContentVersion } from '../site/data.js';
import { invalidateSiteLookups } from '../site/routes.js';
import { parseSpec, deref, specToPages, overviewDoc } from '../content/openapi.js';
import { reindexSpace } from '../search/indexer.js';

export const spacesRouter = Router();
spacesRouter.use(requireAuth);

export async function createSpaceWithDefaults(orgId: string, userId: string, body: { name: string; description?: string; icon?: string; template?: string }) {
  let slug = slugify(body.name);
  if (await one('SELECT id FROM spaces WHERE org_id=? AND slug=?', [orgId, slug])) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const id = uuid();
  const branchId = uuid();
  await tx(async (conn) => {
    await insert(
      'spaces',
      {
        id,
        org_id: orgId,
        name: body.name,
        slug,
        description: body.description ?? null,
        icon: body.icon ?? null,
        visibility: 'public',
        published: 0,
        theme: {},
        seo: {},
        settings: { aiEnabled: true, feedbackEnabled: true, searchEnabled: true, llmsTxt: true, requireApprovals: 0 },
        created_by: userId,
      },
      conn,
    );
    await insert('branches', { id: branchId, space_id: id, name: 'main', is_main: 1, status: 'open', created_by: userId }, conn);
    await insert('space_permissions', { id: uuid(), space_id: id, subject_type: 'user', subject_id: userId, role: 'admin' }, conn);
    const pages = TEMPLATES[body.template || 'blank'] || TEMPLATES.blank;
    const addPages = async (list: TemplatePage[], parent: string | null) => {
      let pos = 1;
      for (const p of list) {
        const created = await createPage(
          {
            spaceId: id,
            branchId,
            title: p.title,
            kind: p.kind || 'doc',
            parentStableId: parent,
            position: pos++,
            description: p.description ?? null,
            icon: p.icon ?? null,
            linkUrl: p.linkUrl ?? null,
            content: p.markdown ? markdownToJson(p.markdown) : undefined,
            userId,
          },
          conn,
        );
        if (p.children) await addPages(p.children, created.stableId);
      }
    };
    await addPages(pages, null);
  });
  void reindexSpace(id).catch(() => {});
  return { id, slug, mainBranchId: branchId };
}

function publicSpace(space: any) {
  const { site_password_hash: _p, ...rest } = space;
  return {
    ...rest,
    has_password: !!space.site_password_hash,
    theme: json(space.theme, {}),
    seo: json(space.seo, {}),
    settings: json<SpaceSettings>(space.settings, {}),
  };
}

spacesRouter.get(
  '/:spaceId',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId);
    const org = await one('SELECT id, name, slug FROM organizations WHERE id=?', [space.org_id]);
    const branches = await query(
      `SELECT b.*, u.name AS created_by_name,
         (SELECT c.number FROM change_requests c WHERE c.branch_id=b.id ORDER BY c.created_at DESC LIMIT 1) AS cr_number
       FROM branches b LEFT JOIN users u ON u.id=b.created_by WHERE b.space_id=? AND (b.is_main=1 OR b.status='open') ORDER BY b.is_main DESC, b.created_at DESC`,
      [space.id],
    );
    const siteUrl = space.custom_domain && space.domain_verified ? `https://${space.custom_domain}` : `${config.appUrl}/s/${org!.slug}/${space.slug}`;
    res.json({
      ...publicSpace(space),
      role,
      org,
      siteUrl,
      branches: branches.map((b) => ({ ...b, is_main: !!b.is_main, canEdit: canEditBranch(space, b, role) })),
    });
  }),
);

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  settings: z
    .object({
      requireChangeRequests: z.boolean().optional(),
      requireApprovals: z.number().int().min(0).max(10).optional(),
      inheritOrgPermissions: z.boolean().optional(),
      aiEnabled: z.boolean().optional(),
      feedbackEnabled: z.boolean().optional(),
      searchEnabled: z.boolean().optional(),
      llmsTxt: z.boolean().optional(),
    })
    .optional(),
  theme: z
    .object({
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
      mode: z.enum(['auto', 'light', 'dark']).optional(),
      logoUrl: z.string().max(1024).optional(),
      faviconUrl: z.string().max(1024).optional(),
      font: z.enum(['Inter', 'Serif', 'Mono', 'Rounded']).optional(),
      headerLinks: z.array(z.object({ label: z.string().max(60), url: z.string().max(1024) })).max(8).optional(),
      footerText: z.string().max(500).optional(),
      showEditedAt: z.boolean().optional(),
      customCss: z.string().max(20000).optional(),
    })
    .optional(),
  seo: z
    .object({
      titleTemplate: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      ogImage: z.string().max(1024).optional(),
      noindex: z.boolean().optional(),
      language: z.string().max(10).optional(),
    })
    .optional(),
});

spacesRouter.patch(
  '/:spaceId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const body = parse(settingsSchema, req.body);
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    if (body.slug) {
      body.slug = slugify(body.slug);
      if (await one('SELECT id FROM spaces WHERE org_id=? AND slug=? AND id<>?', [space.org_id, body.slug, space.id])) throw badRequest('Another space already uses this URL');
    }
    const merge = (cur: unknown, patch: object | undefined) => (patch ? JSON.stringify({ ...json<object>(cur, {}), ...patch }) : undefined);
    await exec(
      `UPDATE spaces SET name=COALESCE(?, name), slug=COALESCE(?, slug), description=?, icon=?, settings=COALESCE(?, settings), theme=COALESCE(?, theme), seo=COALESCE(?, seo), updated_at=NOW(3) WHERE id=?`,
      [
        body.name ?? null,
        body.slug ?? null,
        body.description === undefined ? space.description : body.description,
        body.icon === undefined ? space.icon : body.icon,
        merge(space.settings, body.settings) ?? null,
        merge(space.theme, body.theme) ?? null,
        merge(space.seo, body.seo) ?? null,
        space.id,
      ],
    );
    await bumpContentVersion(space.id);
    await invalidateSiteLookups(space, org!.slug);
    await audit(req, space.org_id, 'space.updated', { type: 'space', id: space.id }, { fields: Object.keys(body) });
    void emit('space.updated', { orgId: space.org_id, spaceId: space.id }, { fields: Object.keys(body) });
    res.json({ ok: true });
  }),
);

spacesRouter.put(
  '/:spaceId/publishing',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const body = parse(
      z.object({
        published: z.boolean(),
        visibility: z.enum(['public', 'unlisted', 'password', 'share', 'members']),
        password: z.string().min(4).max(200).optional(),
        regenerateShareToken: z.boolean().optional(),
      }),
      req.body,
    );
    let passwordHash = space.site_password_hash;
    if (body.visibility === 'password') {
      if (body.password) passwordHash = await hashPassword(body.password);
      if (!passwordHash) throw badRequest('Set a password for password-protected sites');
    }
    let shareToken = space.share_token;
    if (!shareToken || body.regenerateShareToken) shareToken = randomToken(18);
    await exec('UPDATE spaces SET published=?, visibility=?, site_password_hash=?, share_token=?, updated_at=NOW(3) WHERE id=?', [body.published ? 1 : 0, body.visibility, passwordHash, shareToken, space.id]);
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    await bumpContentVersion(space.id);
    await invalidateSiteLookups(space, org!.slug);
    await audit(req, space.org_id, body.published ? 'space.published' : 'space.unpublished', { type: 'space', id: space.id }, { visibility: body.visibility });
    if (body.published && !space.published) void emit('space.published', { orgId: space.org_id, spaceId: space.id }, { visibility: body.visibility });
    res.json({ ok: true, shareToken });
  }),
);

spacesRouter.put(
  '/:spaceId/domain',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const { domain } = parse(z.object({ domain: z.string().trim().toLowerCase().max(253).nullable() }), req.body);
    if (domain && !/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) throw badRequest('Enter a valid domain like docs.example.com');
    if (domain && domain === config.appHost.split(':')[0]) throw badRequest('That domain is used by the app itself');
    if (domain && (await one('SELECT id FROM spaces WHERE custom_domain=? AND id<>?', [domain, space.id]))) throw badRequest('This domain is already connected to another space');
    const token = domain ? `docspace-verify=${randomToken(16)}` : null;
    await exec('UPDATE spaces SET custom_domain=?, domain_verified=0, domain_verify_token=? WHERE id=?', [domain, token, space.id]);
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    await invalidateSiteLookups(space, org!.slug);
    await audit(req, space.org_id, 'space.domain_changed', { type: 'space', id: space.id }, { domain });
    res.json({ ok: true, verifyToken: token, cnameTarget: config.appHost.split(':')[0] });
  }),
);

spacesRouter.post(
  '/:spaceId/domain/verify',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    if (!space.custom_domain) throw badRequest('No custom domain configured');
    const force = req.body?.force === true;
    if (force && !req.user!.is_admin) throw forbidden('Only instance administrators can skip DNS verification');
    let verified = force;
    const checks: string[] = [];
    if (!verified) {
      try {
        const txt = (await resolveTxt(`_docspace.${space.custom_domain}`)).flat();
        verified = txt.includes(space.domain_verify_token);
        checks.push(verified ? 'TXT record found' : `TXT records: ${txt.join(', ') || 'none'}`);
      } catch {
        checks.push('No TXT record at _docspace.' + space.custom_domain);
      }
    }
    if (!verified) {
      try {
        const cname = await resolveCname(space.custom_domain);
        verified = cname.some((c) => c.replace(/\.$/, '') === config.appHost.split(':')[0]);
        checks.push(`CNAME: ${cname.join(', ')}`);
      } catch {
        checks.push('No CNAME record');
      }
    }
    if (verified) {
      await exec('UPDATE spaces SET domain_verified=1 WHERE id=?', [space.id]);
      const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
      await invalidateSiteLookups(space, org!.slug);
      await audit(req, space.org_id, 'space.domain_verified', { type: 'space', id: space.id }, { domain: space.custom_domain, force });
    }
    res.json({ verified, checks });
  }),
);

spacesRouter.delete(
  '/:spaceId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    if (req.body?.confirm !== space.name) throw badRequest('Type the space name to confirm deletion');
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    const files = await query('SELECT storage_key FROM files WHERE space_id=?', [space.id]);
    await exec('DELETE FROM spaces WHERE id=?', [space.id]);
    await exec('DELETE FROM page_chunks WHERE space_id=?', [space.id]);
    await exec('DELETE FROM analytics_events WHERE space_id=?', [space.id]);
    await exec('DELETE FROM files WHERE space_id=?', [space.id]);
    for (const f of files) await storage.remove(f.storage_key).catch(() => {});
    await invalidateSiteLookups(space, org!.slug);
    await audit(req, space.org_id, 'space.deleted', { type: 'space', id: space.id }, { name: space.name });
    void emit('space.deleted', { orgId: space.org_id, spaceId: space.id }, { name: space.name });
    res.json({ ok: true });
  }),
);

// ---- Permissions ----------------------------------------------------------------------------

spacesRouter.get(
  '/:spaceId/permissions',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'reader');
    const rows = await query(
      `SELECT sp.*, COALESCE(u.name, t.name) AS name, u.email FROM space_permissions sp
       LEFT JOIN users u ON sp.subject_type='user' AND u.id=sp.subject_id
       LEFT JOIN teams t ON sp.subject_type='team' AND t.id=sp.subject_id WHERE sp.space_id=? ORDER BY sp.subject_type, name`,
      [space.id],
    );
    res.json(rows);
  }),
);

spacesRouter.put(
  '/:spaceId/permissions',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const body = parse(z.object({ subjectType: z.enum(['user', 'team']), subjectId: z.string().max(36), role: z.enum(ROLES).exclude(['owner']) }), req.body);
    const valid =
      body.subjectType === 'user'
        ? await one('SELECT 1 FROM org_members WHERE org_id=? AND user_id=?', [space.org_id, body.subjectId])
        : await one('SELECT 1 FROM teams WHERE org_id=? AND id=?', [space.org_id, body.subjectId]);
    if (!valid) throw badRequest('Unknown member or team');
    await exec(
      `INSERT INTO space_permissions (id, space_id, subject_type, subject_id, role) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)`,
      [uuid(), space.id, body.subjectType, body.subjectId, body.role],
    );
    await audit(req, space.org_id, 'space.permission_set', { type: 'space', id: space.id }, body);
    res.json({ ok: true });
  }),
);

spacesRouter.delete(
  '/:spaceId/permissions/:permId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    await exec('DELETE FROM space_permissions WHERE id=? AND space_id=?', [req.params.permId, space.id]);
    await audit(req, space.org_id, 'space.permission_removed', { type: 'space', id: space.id }, { permId: req.params.permId });
    res.json({ ok: true });
  }),
);

// ---- Branches -------------------------------------------------------------------------------

spacesRouter.post(
  '/:spaceId/branches',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const id = await createBranch(space.id, name, req.user!.id);
    await audit(req, space.org_id, 'branch.created', { type: 'branch', id }, { name });
    res.json({ id });
  }),
);

spacesRouter.get(
  '/:spaceId/branches/:branchId/changes',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const branch = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [req.params.branchId, space.id]);
    if (!branch) throw notFound('Branch');
    const changes = await branchChanges(branch.id);
    res.json(changes.map((c) => ({ stableId: c.stableId, title: c.title, type: c.type, conflict: c.conflict })));
  }),
);

spacesRouter.post(
  '/:spaceId/branches/:branchId/sync',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const branch = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [req.params.branchId, space.id]);
    if (!branch || branch.is_main) throw notFound('Branch');
    const updated = await updateBranchFromMain(branch.id);
    res.json({ updated });
  }),
);

spacesRouter.delete(
  '/:spaceId/branches/:branchId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const branch = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [req.params.branchId, space.id]);
    if (!branch || branch.is_main) throw notFound('Branch');
    await exec("UPDATE branches SET status='closed' WHERE id=?", [branch.id]);
    await exec("UPDATE change_requests SET status='closed', updated_at=NOW(3) WHERE branch_id=? AND status IN ('open','draft')", [branch.id]);
    await audit(req, space.org_id, 'branch.closed', { type: 'branch', id: branch.id });
    res.json({ ok: true });
  }),
);

// ---- Files ----------------------------------------------------------------------------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadMb * 1024 * 1024, files: 10 } });
const BLOCKED_TYPES = /^(text\/html|application\/xhtml|image\/svg\+xml|application\/javascript|text\/javascript)/i;

spacesRouter.post(
  '/:spaceId/files',
  upload.array('files', 10),
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) throw badRequest('No file uploaded');
    const out = [];
    for (const f of files) {
      const id = uuid();
      const safeName = f.originalname.replace(/[^\w.\-() ]+/g, '_').slice(0, 200) || 'file';
      const key = `${space.org_id}/${space.id}/${id}/${safeName}`;
      await storage.put(key, f.buffer, f.mimetype);
      await insert('files', { id, org_id: space.org_id, space_id: space.id, storage_key: key, filename: safeName, mime: f.mimetype, size: f.size, uploaded_by: req.user!.id });
      out.push({ id, url: `/files/${id}/${encodeURIComponent(safeName)}`, filename: safeName, mime: f.mimetype, size: f.size });
    }
    await audit(req, space.org_id, 'file.uploaded', { type: 'space', id: space.id }, { count: files.length });
    res.json(out);
  }),
);

spacesRouter.get(
  '/:spaceId/files',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const rows = await query('SELECT f.*, u.name AS uploaded_by_name FROM files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE f.space_id=? ORDER BY f.created_at DESC LIMIT 500', [space.id]);
    res.json(rows.map((r) => ({ ...r, url: `/files/${r.id}/${encodeURIComponent(r.filename)}` })));
  }),
);

spacesRouter.delete(
  '/:spaceId/files/:fileId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const f = await one('SELECT * FROM files WHERE id=? AND space_id=?', [req.params.fileId, space.id]);
    if (!f) throw notFound('File');
    await storage.remove(f.storage_key);
    await exec('DELETE FROM files WHERE id=?', [f.id]);
    res.json({ ok: true });
  }),
);

/** Files are served by unguessable capability URLs so published pages can embed them. */
export const filesRouter = Router();
filesRouter.get(
  '/:fileId/:name',
  ah(async (req, res) => {
    const f = await one('SELECT * FROM files WHERE id=?', [req.params.fileId]);
    if (!f) throw notFound('File');
    const obj = await storage.get(f.storage_key);
    if (!obj) throw notFound('File');
    const dangerous = BLOCKED_TYPES.test(f.mime);
    res.setHeader('Content-Type', dangerous ? 'application/octet-stream' : f.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${dangerous || !/^(image|video|audio)\/|^application\/pdf/.test(f.mime) ? 'attachment' : 'inline'}; filename="${f.filename.replace(/"/g, '')}"`);
    if (obj.size) res.setHeader('Content-Length', String(obj.size));
    obj.stream.pipe(res);
  }),
);

// ---- Redirects ------------------------------------------------------------------------------

spacesRouter.get(
  '/:spaceId/redirects',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    res.json(await query('SELECT * FROM redirects WHERE space_id=? ORDER BY automatic, source', [space.id]));
  }),
);

const redirectSchema = z.object({
  source: z.string().trim().min(1).max(1024).regex(/^\//, 'Source must start with /'),
  target: z.string().trim().min(1).max(2048),
  statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
});

spacesRouter.post(
  '/:spaceId/redirects',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const body = parse(redirectSchema, req.body);
    const id = uuid();
    await insert('redirects', { id, space_id: space.id, source: body.source, target: body.target, status_code: body.statusCode || 301, automatic: 0 });
    await audit(req, space.org_id, 'redirect.created', { type: 'space', id: space.id }, body);
    res.json({ id });
  }),
);

spacesRouter.delete(
  '/:spaceId/redirects/:id',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    await exec('DELETE FROM redirects WHERE id=? AND space_id=?', [req.params.id, space.id]);
    res.json({ ok: true });
  }),
);

// ---- OpenAPI ----------------------------------------------------------------------------------

spacesRouter.get(
  '/:spaceId/openapi',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const rows = await query('SELECT id, name, source_url, api_version, created_at, updated_at, spec FROM openapi_specs WHERE space_id=? ORDER BY name', [space.id]);
    res.json(
      rows.map(({ spec, ...r }) => {
        const s = json<any>(spec, {});
        const ops: { method: string; path: string; summary?: string }[] = [];
        for (const [p, item] of Object.entries<any>(s.paths || {})) for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) if (item?.[m]) ops.push({ method: m, path: p, summary: item[m].summary });
        return { ...r, title: s.info?.title, operations: ops };
      }),
    );
  }),
);

spacesRouter.post(
  '/:spaceId/openapi',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const body = parse(
      z.object({
        name: z.string().trim().max(200).optional(),
        text: z.string().max(10_000_000).optional(),
        url: z.string().url().max(2048).optional(),
        generatePages: z.boolean().optional(),
        branchId: z.string().max(36).optional(),
        specId: z.string().max(36).optional(),
      }),
      req.body,
    );
    let text = body.text;
    if (!text && body.url) {
      const r = await fetch(body.url, { signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
        throw badRequest(`Could not fetch spec: ${e.message}`);
      });
      if (!r.ok) throw badRequest(`Could not fetch spec: HTTP ${r.status}`);
      text = await r.text();
    }
    if (!text) throw badRequest('Provide the spec contents or a URL');
    const spec = parseSpec(text);
    const name = body.name || spec.info?.title || 'API';
    let specId = body.specId;
    if (specId) {
      const existing = await one('SELECT id FROM openapi_specs WHERE id=? AND space_id=?', [specId, space.id]);
      if (!existing) throw notFound('Spec');
      await exec('UPDATE openapi_specs SET name=?, spec=?, source_url=COALESCE(?, source_url), api_version=?, updated_at=NOW(3) WHERE id=?', [name, JSON.stringify(spec), body.url ?? null, spec.info?.version ?? null, specId]);
    } else {
      specId = uuid();
      await insert('openapi_specs', { id: specId, space_id: space.id, name, source_url: body.url ?? null, spec, api_version: spec.info?.version ?? null });
    }
    let pagesCreated = 0;
    if (body.generatePages !== false && !body.specId) {
      const branch = body.branchId ? await one('SELECT * FROM branches WHERE id=? AND space_id=?', [body.branchId, space.id]) : await getMainBranch(space.id);
      if (!branch) throw notFound('Branch');
      const role = (await requireSpace(req, space.id, 'editor')).role;
      if (!canEditBranch(space, branch, role)) throw new HttpError(409, 'This branch is locked. Import into a branch and open a change request.');
      const group = await createPage({ spaceId: space.id, branchId: branch.id, title: `${name} reference`, kind: 'group', userId: req.user!.id });
      await createPage({ spaceId: space.id, branchId: branch.id, title: `${name} overview`, parentStableId: group.stableId, description: spec.info?.description?.split('\n')[0]?.slice(0, 200) ?? null, content: overviewDoc(spec), userId: req.user!.id });
      for (const p of specToPages(specId, deref(spec))) {
        await createPage({ spaceId: space.id, branchId: branch.id, title: p.title, parentStableId: group.stableId, kind: 'api', description: p.description, content: p.doc, userId: req.user!.id });
        pagesCreated++;
      }
    }
    await bumpContentVersion(space.id);
    await audit(req, space.org_id, body.specId ? 'openapi.updated' : 'openapi.imported', { type: 'openapi', id: specId }, { name, pagesCreated });
    res.json({ id: specId, pagesCreated });
  }),
);

spacesRouter.get(
  '/:spaceId/openapi/:specId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const row = await one('SELECT * FROM openapi_specs WHERE id=? AND space_id=?', [req.params.specId, space.id]);
    if (!row) throw notFound('Spec');
    res.json({ ...row, spec: deref(json(row.spec, {})) });
  }),
);

spacesRouter.delete(
  '/:spaceId/openapi/:specId',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    await exec('DELETE FROM openapi_specs WHERE id=? AND space_id=?', [req.params.specId, space.id]);
    await bumpContentVersion(space.id);
    await audit(req, space.org_id, 'openapi.deleted', { type: 'openapi', id: req.params.specId });
    res.json({ ok: true });
  }),
);

spacesRouter.post(
  '/:spaceId/reindex',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'admin');
    const n = await reindexSpace(space.id);
    res.json({ pages: n });
  }),
);
