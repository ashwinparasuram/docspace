import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, ExternalLink, Globe, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, ApiError, uploadFiles } from '../../lib/api';
import { cn, formatBytes, ROLE_LABELS, timeAgo } from '../../lib/utils';
import { Badge, CopyField, EmptyState, Field, Section, Spinner, Toggle, useConfirm, useToast } from '../../components/ui';
import { METHOD_COLORS } from '../../editor/nodes';

const TABS = [
  ['general', 'General'],
  ['publishing', 'Publishing & access'],
  ['domain', 'Custom domain'],
  ['theme', 'Theme'],
  ['seo', 'SEO'],
  ['redirects', 'Redirects'],
  ['permissions', 'Permissions'],
  ['openapi', 'OpenAPI'],
  ['files', 'Files'],
  ['danger', 'Danger zone'],
] as const;

export default function SpaceSettings({ space }: { space: any }) {
  const { orgSlug, tab = 'general' } = useParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full">
      <nav className="w-56 flex-none space-y-0.5 overflow-y-auto border-r border-slate-200 p-3 dark:border-slate-800">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => navigate(`/o/${orgSlug}/s/${space.id}/settings/${id}`)}
            className={cn('block w-full rounded-md px-3 py-1.5 text-left text-sm', tab === id ? 'bg-slate-100 font-medium dark:bg-slate-800' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-900')}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          {tab === 'general' && <General space={space} />}
          {tab === 'publishing' && <Publishing space={space} />}
          {tab === 'domain' && <Domain space={space} />}
          {tab === 'theme' && <Theme space={space} />}
          {tab === 'seo' && <Seo space={space} />}
          {tab === 'redirects' && <Redirects space={space} />}
          {tab === 'permissions' && <Permissions space={space} />}
          {tab === 'openapi' && <OpenApi space={space} />}
          {tab === 'files' && <Files space={space} />}
          {tab === 'danger' && <Danger space={space} />}
        </div>
      </div>
    </div>
  );
}

function useSave(space: any) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (body: Record<string, unknown>, msg = 'Saved') => {
    try {
      await api.patch(`/spaces/${space.id}`, body);
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      toast(msg);
      return true;
    } catch (err) {
      toast((err as ApiError).message, 'error');
      return false;
    }
  };
}

function General({ space }: { space: any }) {
  const save = useSave(space);
  const [f, setF] = useState({ name: space.name, slug: space.slug, description: space.description || '', icon: space.icon || '' });
  const [images, setImages] = useState({ logoUrl: space.theme?.logoUrl || '', faviconUrl: space.theme?.faviconUrl || '' });
  const upload = async (key: 'logoUrl' | 'faviconUrl', file?: File) => {
    if (!file) return;
    const [u] = await uploadFiles(space.id, [file]);
    setImages((cur) => ({ ...cur, [key]: u.url }));
  };
  const s = space.settings;
  return (
    <>
      <Section title="Space details">
        <div className="space-y-3">
          <div className="flex gap-3">
            <Field label="Icon" hint={images.logoUrl ? 'Logo replaces the icon' : undefined}>
              {images.logoUrl ? (
                <img src={images.logoUrl} alt="" className="h-9 w-16 rounded border border-slate-200 object-contain dark:border-slate-700" />
              ) : (
                <input className="input w-16 text-center" value={f.icon} maxLength={4} onChange={(e) => setF({ ...f, icon: e.target.value })} />
              )}
            </Field>
            <div className="flex-1">
              <Field label="Name">
                <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
            </div>
          </div>
          <Field label="URL slug" hint={`Published at /s/${space.org.slug}/${f.slug}`}>
            <input className="input font-mono" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Logo" hint="Shown instead of the icon in the app and on the published site.">
              <div className="flex items-center gap-2">
                <label className="btn-secondary cursor-pointer">
                  <Upload className="h-4 w-4" /> {images.logoUrl ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => upload('logoUrl', e.target.files?.[0])} />
                </label>
                {images.logoUrl && (
                  <button className="btn-ghost text-xs" onClick={() => setImages({ ...images, logoUrl: '' })}>
                    Remove
                  </button>
                )}
              </div>
            </Field>
            <Field label="Favicon" hint="Browser tab icon for the published site.">
              <div className="flex items-center gap-2">
                {images.faviconUrl && <img src={images.faviconUrl} alt="" className="h-6 w-6 object-contain" />}
                <label className="btn-secondary cursor-pointer">
                  <Upload className="h-4 w-4" /> {images.faviconUrl ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/png,image/x-icon,image/vnd.microsoft.icon" className="hidden" onChange={(e) => upload('faviconUrl', e.target.files?.[0])} />
                </label>
                {images.faviconUrl && (
                  <button className="btn-ghost text-xs" onClick={() => setImages({ ...images, faviconUrl: '' })}>
                    Remove
                  </button>
                )}
              </div>
            </Field>
          </div>
          <button className="btn-primary" onClick={() => save({ ...f, icon: f.icon || null, theme: images })}>
            Save
          </button>
        </div>
      </Section>
      <Section title="Workflow" description="Control how changes reach the live documentation.">
        <div className="space-y-4">
          <Toggle checked={!!s.requireChangeRequests} onChange={(v) => save({ settings: { requireChangeRequests: v } })} label="Require change requests" description="Lock the main branch: all edits happen in branches and are merged after review." />
          <Field label="Required approvals before merging" hint="Admins can always override.">
            <select className="input w-40" value={s.requireApprovals ?? 0} onChange={(e) => save({ settings: { requireApprovals: Number(e.target.value) } })}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Toggle checked={s.inheritOrgPermissions !== false} onChange={(v) => save({ settings: { inheritOrgPermissions: v } })} label="Inherit organization roles" description="Organization members get their org role in this space. Turn off to restrict the space to explicitly added people and teams (org admins keep access)." />
        </div>
      </Section>
      <Section title="Reader features">
        <div className="space-y-4">
          <Toggle checked={s.searchEnabled !== false} onChange={(v) => save({ settings: { searchEnabled: v } })} label="Search" description="Full-text and semantic search on the published site." />
          <Toggle checked={s.aiEnabled !== false} onChange={(v) => save({ settings: { aiEnabled: v } })} label="Ask AI" description="Let readers ask questions answered from your docs, with citations." />
          <Toggle checked={s.feedbackEnabled !== false} onChange={(v) => save({ settings: { feedbackEnabled: v } })} label="Page feedback" description="“Was this helpful?” widget on every page." />
          <Toggle checked={s.llmsTxt !== false} onChange={(v) => save({ settings: { llmsTxt: v } })} label="llms.txt for AI agents" description="Serve /llms.txt and /llms-full.txt; every page is also available as Markdown by adding .md." />
        </div>
      </Section>
    </>
  );
}

function Publishing({ space }: { space: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [visibility, setVisibility] = useState(space.visibility);
  const [password, setPassword] = useState('');
  const [shareToken, setShareToken] = useState<string | null>(space.share_token);
  const save = async (published: boolean, extra: Record<string, unknown> = {}) => {
    try {
      const res = await api.put(`/spaces/${space.id}/publishing`, { published, visibility, password: password || undefined, ...extra });
      setShareToken(res.shareToken);
      setPassword('');
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      toast(published ? 'Site published' : 'Site unpublished');
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  const options = [
    ['public', 'Public', 'Anyone can read it; indexed by search engines.'],
    ['unlisted', 'Unlisted', 'Anyone with the link; hidden from search engines.'],
    ['password', 'Password protected', 'Readers enter a shared password.'],
    ['share', 'Share link only', 'Accessible through a secret link (and to members).'],
    ['members', 'Members only', 'Only signed-in people with access to this space.'],
  ];
  return (
    <>
      <Section
        title="Publishing"
        description="The published site always shows the main branch."
        actions={space.published ? <Badge tone="green">Live</Badge> : <Badge>Not published</Badge>}
      >
        <CopyField value={space.siteUrl} />
        <div className="mt-4 flex gap-2">
          {space.published ? (
            <>
              <a className="btn-secondary" href={space.siteUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Open site
              </a>
              <button className="btn-secondary" onClick={() => save(false)}>
                Unpublish
              </button>
            </>
          ) : (
            <>
              <button className="btn-primary" onClick={() => save(true)}>
                <Globe className="h-4 w-4" /> Publish site
              </button>
              <a className="btn-secondary" href={space.siteUrl} target="_blank" rel="noreferrer">
                Preview (members only)
              </a>
            </>
          )}
        </div>
      </Section>
      <Section
        title="Access control"
        description="People signed in with access to this space can always read it, so it will look open to you. Use “View as visitor” on the site, or a private window, to check what outsiders see. Changes apply immediately."
      >
        <div className="space-y-2">
          {options.map(([id, label, desc]) => (
            <label key={id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', visibility === id ? 'border-slate-900 bg-slate-50 dark:border-slate-300 dark:bg-slate-800/60' : 'border-slate-200 dark:border-slate-800')}>
              <input type="radio" className="mt-1 accent-slate-900" checked={visibility === id} onChange={() => setVisibility(id)} />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="muted block text-sm">{desc}</span>
              </span>
            </label>
          ))}
        </div>
        {visibility === 'password' && (
          <div className="mt-3">
            <Field label={space.has_password ? 'New password (leave empty to keep current)' : 'Password'}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}
        {(visibility === 'share' || visibility === 'members' || visibility === 'password') && shareToken && (
          <div className="mt-3">
            <Field label="Secret share link" hint="Anyone with this link can read the site. Regenerating it revokes the old link.">
              <CopyField value={`${space.siteUrl}?share=${shareToken}`} />
            </Field>
            <button className="btn-ghost mt-1 text-xs" onClick={() => save(!!space.published, { regenerateShareToken: true })}>
              <RefreshCw className="h-3.5 w-3.5" /> Regenerate link
            </button>
          </div>
        )}
        <button className="btn-primary mt-4" onClick={() => save(!!space.published)}>
          Save access settings
        </button>
      </Section>
    </>
  );
}

function Domain({ space }: { space: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [domain, setDomain] = useState(space.custom_domain || '');
  const [info, setInfo] = useState<{ verifyToken: string | null; cnameTarget: string } | null>(space.custom_domain ? { verifyToken: space.domain_verify_token, cnameTarget: space.cnameTarget } : null);
  const [checks, setChecks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const saveDomain = async (value: string | null) => {
    try {
      const res = await api.put(`/spaces/${space.id}/domain`, { domain: value });
      setInfo(value ? res : null);
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      toast(value ? 'Domain saved — now configure DNS' : 'Domain removed');
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  const verify = async (force = false) => {
    setBusy(true);
    try {
      const res = await api.post(`/spaces/${space.id}/domain/verify`, { force });
      setChecks(res.checks);
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      toast(res.verified ? 'Domain verified' : 'Not verified yet', res.verified ? 'success' : 'error');
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Custom domain" description="Serve this space from your own domain, e.g. docs.example.com." actions={space.custom_domain && (space.domain_verified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Pending</Badge>)}>
      <div className="flex gap-2">
        <input className="input" placeholder="docs.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button className="btn-primary flex-none" onClick={() => saveDomain(domain || null)}>
          Save
        </button>
        {space.custom_domain && (
          <button className="btn-secondary flex-none" onClick={() => (setDomain(''), saveDomain(null))}>
            Remove
          </button>
        )}
      </div>
      {space.custom_domain && info && (
        <div className="mt-5 space-y-4 text-sm">
          <div>
            <p className="font-medium">1. Point the domain at this server</p>
            <p className="muted">
              Create a <code>CNAME</code> record for <code>{space.custom_domain}</code> pointing to <code>{info.cnameTarget}</code> (or an <code>A</code> record to this server's IP).
            </p>
          </div>
          {info.verifyToken && (
            <div>
              <p className="font-medium">2. Prove ownership (if not using a CNAME)</p>
              <p className="muted mb-1">
                Add a <code>TXT</code> record at <code>_docspace.{space.custom_domain}</code> with value:
              </p>
              <CopyField value={info.verifyToken} />
            </div>
          )}
          <div>
            <p className="font-medium">3. TLS certificates</p>
            <p className="muted">Run the included Caddy reverse proxy (see docs/DEPLOYMENT.md): it issues certificates automatically for verified domains using its on-demand TLS check endpoint.</p>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => verify(false)} disabled={busy}>
              {busy && <Spinner />} Check DNS
            </button>
            <button className="btn-ghost text-xs" onClick={() => verify(true)} title="Instance administrators only — for internal/LAN domains">
              Mark verified (admin)
            </button>
          </div>
          {checks.length > 0 && (
            <ul className="muted list-disc pl-5 text-xs">
              {checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

function Theme({ space }: { space: any }) {
  const save = useSave(space);
  const [t, setT] = useState({ primaryColor: '#2563eb', mode: 'auto', logoUrl: '', faviconUrl: '', font: 'Inter', footerText: '', showEditedAt: true, customCss: '', headerLinks: [] as { label: string; url: string }[], ...space.theme });
  const upload = async (key: 'logoUrl' | 'faviconUrl', file?: File) => {
    if (!file) return;
    const [f] = await uploadFiles(space.id, [file]);
    setT({ ...t, [key]: f.url });
  };
  return (
    <Section title="Theme" description="Customize how the published site looks." actions={<button className="btn-primary" onClick={() => save({ theme: t })}>Save theme</button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Primary color">
          <div className="flex gap-2">
            <input type="color" className="h-9 w-12 cursor-pointer rounded border border-slate-200 dark:border-slate-700" value={t.primaryColor} onChange={(e) => setT({ ...t, primaryColor: e.target.value })} />
            <input className="input font-mono" value={t.primaryColor} onChange={(e) => setT({ ...t, primaryColor: e.target.value })} />
          </div>
        </Field>
        <Field label="Default mode">
          <select className="input" value={t.mode} onChange={(e) => setT({ ...t, mode: e.target.value })}>
            <option value="auto">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <Field label="Font">
          <select className="input" value={t.font} onChange={(e) => setT({ ...t, font: e.target.value })}>
            <option value="Inter">Sans-serif (system)</option>
            <option value="Serif">Serif</option>
            <option value="Rounded">Rounded</option>
            <option value="Mono">Monospace</option>
          </select>
        </Field>
        <Field label="Footer text">
          <input className="input" value={t.footerText} onChange={(e) => setT({ ...t, footerText: e.target.value })} placeholder="© 2026 Acme Inc." />
        </Field>
        <Field label="Logo">
          <div className="flex items-center gap-2">
            {t.logoUrl && <img src={t.logoUrl} alt="" className="h-8 rounded border border-slate-200 dark:border-slate-700" />}
            <label className="btn-secondary cursor-pointer">
              <Upload className="h-4 w-4" /> Upload
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => upload('logoUrl', e.target.files?.[0])} />
            </label>
            {t.logoUrl && (
              <button className="btn-ghost text-xs" onClick={() => setT({ ...t, logoUrl: '' })}>
                Remove
              </button>
            )}
          </div>
        </Field>
        <Field label="Favicon">
          <div className="flex items-center gap-2">
            {t.faviconUrl && <img src={t.faviconUrl} alt="" className="h-6 w-6" />}
            <label className="btn-secondary cursor-pointer">
              <Upload className="h-4 w-4" /> Upload
              <input type="file" accept="image/png,image/x-icon,image/vnd.microsoft.icon" className="hidden" onChange={(e) => upload('faviconUrl', e.target.files?.[0])} />
            </label>
            {t.faviconUrl && (
              <button className="btn-ghost text-xs" onClick={() => setT({ ...t, faviconUrl: '' })}>
                Remove
              </button>
            )}
          </div>
        </Field>
      </div>
      <div className="mt-4">
        <label className="label">Header links</label>
        {t.headerLinks.map((l: any, i: number) => (
          <div key={i} className="mb-2 flex gap-2">
            <input className="input" placeholder="Label" value={l.label} onChange={(e) => setT({ ...t, headerLinks: t.headerLinks.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input className="input" placeholder="https://" value={l.url} onChange={(e) => setT({ ...t, headerLinks: t.headerLinks.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)) })} />
            <button className="btn-ghost" onClick={() => setT({ ...t, headerLinks: t.headerLinks.filter((_: any, j: number) => j !== i) })}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button className="btn-secondary text-xs" onClick={() => setT({ ...t, headerLinks: [...t.headerLinks, { label: '', url: '' }] })} disabled={t.headerLinks.length >= 8}>
          <Plus className="h-3.5 w-3.5" /> Add link
        </button>
      </div>
      <div className="mt-4 space-y-4">
        <Toggle checked={t.showEditedAt !== false} onChange={(v) => setT({ ...t, showEditedAt: v })} label="Show “Last updated” date" />
        <Field label="Custom CSS" hint="Advanced: injected into every published page. Override CSS variables like --primary, --font or --sidebar.">
          <textarea className="input min-h-[100px] font-mono text-xs" value={t.customCss} onChange={(e) => setT({ ...t, customCss: e.target.value })} spellCheck={false} />
        </Field>
      </div>
    </Section>
  );
}

function Seo({ space }: { space: any }) {
  const save = useSave(space);
  const [s, setS] = useState({ titleTemplate: `%s | ${space.name}`, description: space.description || '', ogImage: '', noindex: false, language: 'en', ...space.seo });
  return (
    <Section title="Search engine optimization" actions={<button className="btn-primary" onClick={() => save({ seo: s })}>Save</button>}>
      <div className="space-y-4">
        <Field label="Title template" hint="%s is replaced by the page title.">
          <input className="input" value={s.titleTemplate} onChange={(e) => setS({ ...s, titleTemplate: e.target.value })} />
        </Field>
        <Field label="Default meta description" hint="Used when a page has no description of its own.">
          <textarea className="input" value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} maxLength={500} />
        </Field>
        <Field label="Social sharing image URL" hint="Open Graph / Twitter card image (1200×630 recommended).">
          <input className="input" value={s.ogImage} onChange={(e) => setS({ ...s, ogImage: e.target.value })} />
        </Field>
        <Field label="Content language">
          <input className="input w-32" value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })} />
        </Field>
        <Toggle checked={!!s.noindex} onChange={(v) => setS({ ...s, noindex: v })} label="Hide from search engines" description="Adds noindex and disallows crawling in robots.txt." />
        <p className="muted text-xs">
          Generated automatically: <code>sitemap.xml</code>, <code>robots.txt</code>, canonical URLs, Open Graph tags, JSON-LD structured data and automatic redirects when pages move.
        </p>
      </div>
    </Section>
  );
}

function Redirects({ space }: { space: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data = [] } = useQuery({ queryKey: ['redirects', space.id], queryFn: () => api.get(`/spaces/${space.id}/redirects`) });
  const [f, setF] = useState({ source: '', target: '', statusCode: 301 });
  const add = async () => {
    try {
      await api.post(`/spaces/${space.id}/redirects`, f);
      setF({ source: '', target: '', statusCode: 301 });
      await qc.invalidateQueries({ queryKey: ['redirects', space.id] });
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  return (
    <Section title="Redirects" description="Redirect old URLs to new pages. Use a trailing /* to redirect a whole section. Moves and renames create automatic redirects.">
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input min-w-[160px] flex-1 font-mono text-xs" placeholder="/old/path" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
        <input className="input min-w-[160px] flex-1 font-mono text-xs" placeholder="/new/path or https://…" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        <select className="input w-24" value={f.statusCode} onChange={(e) => setF({ ...f, statusCode: Number(e.target.value) })}>
          <option value={301}>301</option>
          <option value={302}>302</option>
        </select>
        <button className="btn-primary" onClick={add} disabled={!f.source || !f.target}>
          Add
        </button>
      </div>
      {!data.length && <p className="muted text-sm">No redirects yet.</p>}
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {data.map((r: any) => (
          <div key={r.id} className="flex items-center gap-2 py-2 font-mono text-xs">
            <span className="flex-1 truncate">{r.source}</span>→<span className="flex-1 truncate">{r.target}</span>
            <Badge>{r.status_code}</Badge>
            {r.automatic ? <Badge tone="blue">auto</Badge> : null}
            <button
              className="btn-ghost p-1"
              onClick={async () => {
                await api.del(`/spaces/${space.id}/redirects/${r.id}`);
                await qc.invalidateQueries({ queryKey: ['redirects', space.id] });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Permissions({ space }: { space: any }) {
  const { orgSlug } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const perms = useQuery({ queryKey: ['perms', space.id], queryFn: () => api.get(`/spaces/${space.id}/permissions`) });
  const members = useQuery({ queryKey: ['members', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}/members`) });
  const teams = useQuery({ queryKey: ['teams', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}/teams`) });
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState('editor');
  const add = async () => {
    const [subjectType, subjectId] = subject.split(':');
    try {
      await api.put(`/spaces/${space.id}/permissions`, { subjectType, subjectId, role });
      setSubject('');
      await qc.invalidateQueries({ queryKey: ['perms', space.id] });
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  return (
    <Section title="Permissions" description={space.settings.inheritOrgPermissions === false ? 'This space is restricted: only the people and teams below (and org admins) can access it.' : 'Organization members inherit their org role. Grant additional access to specific people or teams below.'}>
      <div className="mb-4 flex flex-wrap gap-2">
        <select className="input min-w-[200px] flex-1" value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">Choose a person or team…</option>
          <optgroup label="Teams">
            {(teams.data || []).map((t: any) => (
              <option key={t.id} value={`team:${t.id}`}>
                {t.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="People">
            {(members.data || []).map((m: any) => (
              <option key={m.id} value={`user:${m.id}`}>
                {m.name} ({m.email})
              </option>
            ))}
          </optgroup>
        </select>
        <select className="input w-36" value={role} onChange={(e) => setRole(e.target.value)}>
          {['reader', 'commenter', 'reviewer', 'editor', 'admin'].map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn-primary" disabled={!subject} onClick={add}>
          Grant
        </button>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {(perms.data || []).map((p: any) => (
          <div key={p.id} className="flex items-center gap-3 py-2 text-sm">
            <Badge tone={p.subject_type === 'team' ? 'purple' : 'slate'}>{p.subject_type}</Badge>
            <span className="flex-1">
              {p.name} {p.email && <span className="muted text-xs">{p.email}</span>}
            </span>
            <select
              className="input w-32 py-1 text-xs"
              value={p.role}
              onChange={async (e) => {
                await api.put(`/spaces/${space.id}/permissions`, { subjectType: p.subject_type, subjectId: p.subject_id, role: e.target.value });
                await qc.invalidateQueries({ queryKey: ['perms', space.id] });
              }}
            >
              {['reader', 'commenter', 'reviewer', 'editor', 'admin'].map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button
              className="btn-ghost p-1"
              onClick={async () => {
                await api.del(`/spaces/${space.id}/permissions/${p.id}`);
                await qc.invalidateQueries({ queryKey: ['perms', space.id] });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function OpenApi({ space }: { space: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: ['openapi', space.id], queryFn: () => api.get(`/spaces/${space.id}/openapi`) });
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [generate, setGenerate] = useState(true);
  const [busy, setBusy] = useState(false);
  const main = space.branches.find((b: any) => b.is_main);
  const editable = space.branches.filter((b: any) => b.canEdit);
  const [branchId, setBranchId] = useState(editable.find((b: any) => b.is_main)?.id || editable[0]?.id || main.id);
  useEffect(() => {
    if (!editable.some((b: any) => b.id === branchId) && editable[0]) setBranchId(editable[0].id);
  }, [editable, branchId]);

  const doImport = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post(`/spaces/${space.id}/openapi`, { ...body, generatePages: generate, branchId });
      toast(res.pagesCreated ? `Imported — ${res.pagesCreated} reference pages created` : 'Spec saved');
      setUrl('');
      setText('');
      await qc.invalidateQueries({ queryKey: ['openapi', space.id] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title="Import an OpenAPI spec" description="OpenAPI 3.x or Swagger 2.0, JSON or YAML. Generates reference pages with schemas and an interactive “Try it” playground.">
        <div className="space-y-3">
          <Field label="From URL">
            <div className="flex gap-2">
              <input className="input" placeholder="https://api.example.com/openapi.json" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn-primary flex-none" disabled={!url || busy} onClick={() => doImport({ url })}>
                Import
              </button>
            </div>
          </Field>
          <Field label="Or paste / upload the spec">
            <textarea className="input min-h-[120px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="openapi: 3.0.0 …" spellCheck={false} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn-secondary cursor-pointer">
              <Upload className="h-4 w-4" /> Upload file
              <input type="file" accept=".json,.yaml,.yml" className="hidden" onChange={async (e) => e.target.files?.[0] && setText(await e.target.files[0].text())} />
            </label>
            <button className="btn-primary" disabled={!text || busy} onClick={() => doImport({ text })}>
              {busy && <Spinner className="text-current" />} Import pasted spec
            </button>
          </div>
          <Toggle checked={generate} onChange={setGenerate} label="Generate reference pages" description="One page per tag, with an operation block per endpoint." />
          {generate && (
            <Field label="Create pages in branch">
              <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {editable.map((b: any) => (
                  <option key={b.id} value={b.id}>
                    {b.is_main ? 'main' : b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </Section>
      <Section title="Specs">
        {isLoading && <Spinner />}
        {!isLoading && !data.length && <EmptyState icon={<Braces className="h-5 w-5" />} title="No specs imported" />}
        <div className="space-y-3">
          {data.map((s: any) => (
            <div key={s.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">
                  {s.name} {s.api_version && <Badge>v{s.api_version}</Badge>}
                </span>
                <span className="muted text-xs">updated {timeAgo(s.updated_at)}</span>
                {s.source_url && (
                  <button className="btn-ghost p-1" title="Re-fetch from source URL" onClick={() => doImport({ url: s.source_url, specId: s.id })}>
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  className="btn-ghost p-1"
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete ${s.name}?`, message: 'API blocks referencing this spec will show as unavailable.', danger: true }))) return;
                    await api.del(`/spaces/${space.id}/openapi/${s.id}`);
                    await qc.invalidateQueries({ queryKey: ['openapi', space.id] });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {s.operations.map((o: any) => (
                  <div key={o.method + o.path} className="flex items-center gap-2 text-xs">
                    <span className={cn('w-14 rounded px-1 text-center font-mono font-bold uppercase text-white', METHOD_COLORS[o.method])}>{o.method}</span>
                    <code>{o.path}</code>
                    <span className="muted truncate">{o.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function Files({ space }: { space: any }) {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ['files', space.id], queryFn: () => api.get(`/spaces/${space.id}/files`) });
  return (
    <Section
      title="Files"
      description="Uploaded images, videos and attachments, stored on this server."
      actions={
        <label className="btn-primary cursor-pointer">
          <Upload className="h-4 w-4" /> Upload
          <input
            type="file"
            multiple
            className="hidden"
            onChange={async (e) => {
              if (e.target.files?.length) {
                await uploadFiles(space.id, Array.from(e.target.files));
                await qc.invalidateQueries({ queryKey: ['files', space.id] });
              }
            }}
          />
        </label>
      }
    >
      {isLoading && <Spinner />}
      {!isLoading && !data.length && <p className="muted text-sm">No files yet.</p>}
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {data.map((f: any) => (
          <div key={f.id} className="flex items-center gap-3 py-2 text-sm">
            {f.mime.startsWith('image/') ? <img src={f.url} alt="" className="h-9 w-9 rounded object-cover" /> : <div className="h-9 w-9 rounded bg-slate-100 dark:bg-slate-800" />}
            <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">
              {f.filename}
            </a>
            <span className="muted text-xs">{formatBytes(f.size)}</span>
            <span className="muted hidden text-xs sm:inline">{timeAgo(f.created_at)}</span>
            <button
              className="btn-ghost p-1"
              onClick={async () => {
                await api.del(`/spaces/${space.id}/files/${f.id}`);
                await qc.invalidateQueries({ queryKey: ['files', space.id] });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Danger({ space }: { space: any }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <Section title="Danger zone">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">Reindex search</p>
          <p className="muted text-sm">Rebuild the full-text and semantic index (e.g. after changing the AI embedding model).</p>
        </div>
        <button
          className="btn-secondary"
          onClick={async () => {
            const res = await api.post(`/spaces/${space.id}/reindex`);
            toast(`Reindexed ${res.pages} pages`);
          }}
        >
          Reindex
        </button>
      </div>
      <div className="mt-6 flex items-center justify-between gap-4 border-t border-slate-200 pt-6 dark:border-slate-800">
        <div>
          <p className="font-medium text-red-600">Delete this space</p>
          <p className="muted text-sm">Permanently deletes all pages, branches, history, files and analytics.</p>
        </div>
        <button
          className="btn-danger"
          onClick={async () => {
            if (!(await confirm({ title: 'Delete space?', message: 'This cannot be undone.', danger: true, typeToConfirm: space.name, confirmLabel: 'Delete space' }))) return;
            await api.del(`/spaces/${space.id}`, { confirm: space.name });
            await qc.invalidateQueries({ queryKey: ['spaces'] });
            navigate(`/o/${space.org.slug}`);
          }}
        >
          Delete space
        </button>
      </div>
    </Section>
  );
}
