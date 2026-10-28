import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Send, Trash2, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { atLeast, cn, ROLE_HELP, ROLE_LABELS, timeAgo } from '../lib/utils';
import { Avatar, Badge, CopyField, EmptyState, Field, Modal, PageLoader, Section, Spinner, Toggle, useConfirm, useToast } from '../components/ui';

const TABS = [
  ['general', 'General'],
  ['members', 'Members'],
  ['teams', 'Teams'],
  ['security', 'Security'],
  ['webhooks', 'Webhooks'],
  ['audit', 'Audit log'],
] as const;

const ORG_ROLES = ['reader', 'commenter', 'reviewer', 'editor', 'creator', 'admin', 'owner'];

export default function OrgSettings() {
  const { orgSlug, tab = 'general' } = useParams();
  const navigate = useNavigate();
  const org = useQuery({ queryKey: ['org', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}`) });
  if (org.isLoading) return <PageLoader />;
  if (org.error) return <EmptyState title="Unavailable" description={(org.error as ApiError).message} />;
  const isAdmin = atLeast(org.data.role, 'admin');
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{org.data.name} settings</h1>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="flex flex-none gap-1 overflow-x-auto md:w-48 md:flex-col">
          {TABS.filter(([id]) => isAdmin || id === 'members' || id === 'teams').map(([id, label]) => (
            <button key={id} onClick={() => navigate(`/o/${orgSlug}/settings/${id}`)} className={cn('whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm', tab === id ? 'bg-slate-100 font-medium dark:bg-slate-800' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-900')}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-6">
          {tab === 'general' && <General org={org.data} />}
          {tab === 'members' && <Members org={org.data} />}
          {tab === 'teams' && <Teams org={org.data} />}
          {tab === 'security' && <Security org={org.data} />}
          {tab === 'webhooks' && <Webhooks org={org.data} />}
          {tab === 'audit' && <Audit org={org.data} />}
        </div>
      </div>
    </div>
  );
}

function General({ org }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  return (
    <>
      <Section title="Organization">
        <div className="space-y-3">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL" hint="Used in published site URLs: /s/{org}/{space}">
            <input className="input font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          <button
            className="btn-primary"
            onClick={async () => {
              try {
                await api.patch(`/orgs/${org.slug}`, { name, slug });
                await qc.invalidateQueries({ queryKey: ['me'] });
                toast('Saved');
                if (slug !== org.slug) navigate(`/o/${slug}/settings`);
              } catch (err) {
                toast((err as ApiError).message, 'error');
              }
            }}
          >
            Save
          </button>
        </div>
      </Section>
      {org.role === 'owner' && (
        <Section title="Delete organization" description="Deletes every space, page, file and member association. This cannot be undone.">
          <button
            className="btn-danger"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete organization?', danger: true, typeToConfirm: org.slug, confirmLabel: 'Delete forever' }))) return;
              await api.del(`/orgs/${org.slug}`, { confirm: org.slug });
              await qc.invalidateQueries({ queryKey: ['me'] });
              navigate('/');
            }}
          >
            Delete organization
          </button>
        </Section>
      )}
    </>
  );
}

function Members({ org }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const isAdmin = atLeast(org.role, 'admin');
  const members = useQuery({ queryKey: ['members', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/members`) });
  const invites = useQuery({ queryKey: ['invites', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/invitations`), enabled: isAdmin });
  const [inviting, setInviting] = useState(false);
  const [inv, setInv] = useState({ email: '', role: 'editor' });
  const [link, setLink] = useState<string | null>(null);
  const roles = org.role === 'owner' ? ORG_ROLES : ORG_ROLES.filter((r) => r !== 'owner');

  return (
    <>
      <Section
        title={`Members (${members.data?.length ?? '…'})`}
        actions={
          isAdmin && (
            <button className="btn-primary" onClick={() => (setLink(null), setInviting(true))}>
              <Send className="h-4 w-4" /> Invite
            </button>
          )
        }
      >
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {(members.data || []).map((m: any) => (
            <div key={m.id} className="flex items-center gap-3 py-2.5">
              <Avatar name={m.name} id={m.id} url={m.avatar_url} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {m.name} {m.id === me.data?.user?.id && <span className="muted font-normal">(you)</span>}
                </div>
                <div className="muted truncate text-xs">
                  {m.email} · {m.totp_enabled ? '2FA on' : '2FA off'} · last login {m.last_login_at ? timeAgo(m.last_login_at) : 'never'}
                </div>
              </div>
              {isAdmin ? (
                <select
                  className="input w-32 py-1 text-xs"
                  value={m.role}
                  title={ROLE_HELP[m.role]}
                  onChange={async (e) => {
                    try {
                      await api.patch(`/orgs/${org.slug}/members/${m.id}`, { role: e.target.value });
                      await qc.invalidateQueries({ queryKey: ['members', org.slug] });
                    } catch (err) {
                      toast((err as ApiError).message, 'error');
                    }
                  }}
                >
                  {(m.role === 'owner' && org.role !== 'owner' ? ORG_ROLES : roles).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge>{ROLE_LABELS[m.role]}</Badge>
              )}
              {(isAdmin || m.id === me.data?.user?.id) && (
                <button
                  className="btn-ghost p-1.5"
                  title={m.id === me.data?.user?.id ? 'Leave organization' : 'Remove member'}
                  onClick={async () => {
                    if (!(await confirm({ title: m.id === me.data?.user?.id ? 'Leave organization?' : `Remove ${m.name}?`, danger: true, confirmLabel: 'Remove' }))) return;
                    try {
                      await api.del(`/orgs/${org.slug}/members/${m.id}`);
                      await qc.invalidateQueries({ queryKey: ['members', org.slug] });
                    } catch (err) {
                      toast((err as ApiError).message, 'error');
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>
      {isAdmin && !!invites.data?.length && (
        <Section title="Pending invitations">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {invites.data.map((i: any) => (
              <div key={i.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">{i.email || 'Anyone with the link'}</span>
                <Badge>{ROLE_LABELS[i.role]}</Badge>
                <span className="muted text-xs">expires {new Date(i.expires_at).toLocaleDateString()}</span>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => (navigator.clipboard.writeText(i.url), toast('Link copied'))}>
                  Copy link
                </button>
                <button
                  className="btn-ghost p-1"
                  onClick={async () => {
                    await api.del(`/orgs/${org.slug}/invitations/${i.id}`);
                    await qc.invalidateQueries({ queryKey: ['invites', org.slug] });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
      <Modal open={inviting} onClose={() => setInviting(false)} title="Invite people">
        {link ? (
          <div className="space-y-3">
            <p className="text-sm">Share this invitation link (DocSpace does not send email, so nothing leaves your server):</p>
            <CopyField value={link} />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Email (optional)" hint="Restricts the invite to this address. Leave empty for a reusable-once link.">
              <input className="input" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </Field>
            <Field label="Role" hint={ROLE_HELP[inv.role]}>
              <select className="input" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="btn-primary w-full"
              onClick={async () => {
                try {
                  const res = await api.post(`/orgs/${org.slug}/invitations`, inv);
                  setLink(res.url);
                  await qc.invalidateQueries({ queryKey: ['invites', org.slug] });
                } catch (err) {
                  toast((err as ApiError).message, 'error');
                }
              }}
            >
              Create invitation link
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}

function Teams({ org }: { org: any }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const isAdmin = atLeast(org.role, 'admin');
  const teams = useQuery({ queryKey: ['teams', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/teams`) });
  const members = useQuery({ queryKey: ['members', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/members`) });
  const [editing, setEditing] = useState<any | null>(null);
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['teams', org.slug] });
  return (
    <Section
      title="Teams"
      description="Group members and grant teams access to spaces in each space's permission settings."
      actions={
        isAdmin && (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              await api.post(`/orgs/${org.slug}/teams`, { name });
              setName('');
              await refresh();
            }}
          >
            <input className="input w-40 py-1.5" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary">
              <Plus className="h-4 w-4" />
            </button>
          </form>
        )
      }
    >
      {!teams.data?.length && <EmptyState icon={<Users className="h-5 w-5" />} title="No teams yet" />}
      <div className="space-y-2">
        {(teams.data || []).map((t: any) => (
          <div key={t.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex-1">
              <div className="font-medium">{t.name}</div>
              <div className="muted text-xs">{t.members.map((m: any) => m.name).join(', ') || 'No members'}</div>
            </div>
            {isAdmin && (
              <>
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing({ ...t, selected: new Set(t.members.map((m: any) => m.id)) })}>
                  Members
                </button>
                <button
                  className="btn-ghost p-1"
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete team ${t.name}?`, danger: true }))) return;
                    await api.del(`/orgs/${org.slug}/teams/${t.id}`);
                    await refresh();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Members of ${editing?.name}`}
        footer={
          <button
            className="btn-primary"
            onClick={async () => {
              await api.put(`/orgs/${org.slug}/teams/${editing.id}/members`, { userIds: [...editing.selected] });
              setEditing(null);
              await refresh();
            }}
          >
            Save
          </button>
        }
      >
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {(members.data || []).map((m: any) => (
            <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <input
                type="checkbox"
                checked={editing?.selected.has(m.id) || false}
                onChange={(e) => {
                  const s = new Set(editing.selected);
                  if (e.target.checked) s.add(m.id);
                  else s.delete(m.id);
                  setEditing({ ...editing, selected: s });
                }}
              />
              {m.name} <span className="muted text-xs">{m.email}</span>
            </label>
          ))}
        </div>
      </Modal>
    </Section>
  );
}

function Security({ org }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ips, setIps] = useState((org.settings.ipAllowlist || []).join('\n'));
  const [domains, setDomains] = useState((org.settings.allowedEmailDomains || []).join(', '));
  const save = async (settings: Record<string, unknown>) => {
    try {
      await api.patch(`/orgs/${org.slug}`, { settings });
      await qc.invalidateQueries({ queryKey: ['org', org.slug] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast('Security settings saved');
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  return (
    <>
      <Section title="Authentication">
        <Toggle checked={!!org.settings.enforce2fa} onChange={(v) => save({ enforce2fa: v })} label="Require two-factor authentication" description="Members without 2FA are blocked from this organization's content until they enable it." />
      </Section>
      <Section title="IP allowlist" description="Restrict access to the editor and private sites to these IPs or CIDR ranges (one per line). Leave empty to allow all. Localhost is always allowed.">
        <textarea className="input min-h-[100px] font-mono text-xs" value={ips} onChange={(e) => setIps(e.target.value)} placeholder={'203.0.113.0/24\n198.51.100.7'} />
        <button className="btn-primary mt-3" onClick={() => save({ ipAllowlist: ips.split('\n').map((s: string) => s.trim()).filter(Boolean) })}>
          Save allowlist
        </button>
      </Section>
      <Section title="Allowed email domains" description="Only invite people with these email domains (comma separated). Leave empty to allow any.">
        <input className="input" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" />
        <button className="btn-primary mt-3" onClick={() => save({ allowedEmailDomains: domains.split(',').map((s: string) => s.trim()).filter(Boolean) })}>
          Save
        </button>
      </Section>
    </>
  );
}

function Webhooks({ org }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ['webhooks', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/webhooks`) });
  const spaces = useQuery({ queryKey: ['spaces', org.slug], queryFn: () => api.get(`/orgs/${org.slug}/spaces`) });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ url: '', events: ['*'] as string[], spaceId: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const [viewing, setViewing] = useState<any | null>(null);
  const deliveries = useQuery({ queryKey: ['deliveries', viewing?.id], queryFn: () => api.get(`/orgs/${org.slug}/webhooks/${viewing.id}/deliveries`), enabled: !!viewing });
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks', org.slug] });
  if (isLoading) return <Spinner />;
  return (
    <Section
      title="Webhooks"
      description="Send signed HTTP POST requests to your services when things happen. Signature: HMAC-SHA256 of `timestamp.body` in X-DocSpace-Signature."
      actions={
        <button className="btn-primary" onClick={() => (setSecret(null), setForm({ url: '', events: ['*'], spaceId: '' }), setCreating(true))}>
          <Plus className="h-4 w-4" /> Add webhook
        </button>
      }
    >
      {!data.webhooks.length && <p className="muted text-sm">No webhooks configured.</p>}
      <div className="space-y-2">
        {data.webhooks.map((w: any) => (
          <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm">{w.url}</div>
              <div className="muted text-xs">
                {w.events.join(', ')} · {w.space_name || 'all spaces'}
              </div>
            </div>
            {w.last_status && <Badge tone={w.last_status === 'success' ? 'green' : w.last_status === 'failed' ? 'red' : 'amber'}>{w.last_status}</Badge>}
            <Toggle
              checked={w.active}
              onChange={async (v) => {
                await api.patch(`/orgs/${org.slug}/webhooks/${w.id}`, { active: v, spaceId: w.space_id });
                await refresh();
              }}
            />
            <button
              className="btn-secondary px-2 py-1 text-xs"
              onClick={async () => {
                const r = await api.post(`/orgs/${org.slug}/webhooks/${w.id}/test`);
                toast(r.ok ? `Ping delivered (HTTP ${r.code})` : `Ping failed: ${r.code ?? r.body}`, r.ok ? 'success' : 'error');
                await refresh();
              }}
            >
              Test
            </button>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setViewing(w)}>
              Deliveries
            </button>
            <button
              className="btn-ghost p-1"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete webhook?', danger: true }))) return;
                await api.del(`/orgs/${org.slug}/webhooks/${w.id}`);
                await refresh();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="Add webhook" size="md">
        {secret ? (
          <div className="space-y-2 text-sm">
            <p>Webhook created. Copy the signing secret now — it won't be shown again:</p>
            <CopyField value={secret} />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Payload URL">
              <input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://ci.internal/hooks/docs" />
            </Field>
            <Field label="Space">
              <select className="input" value={form.spaceId} onChange={(e) => setForm({ ...form, spaceId: e.target.value })}>
                <option value="">All spaces</option>
                {(spaces.data || []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <label className="label">Events</label>
              <label className="mb-1 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.events.includes('*')} onChange={(e) => setForm({ ...form, events: e.target.checked ? ['*'] : [] })} /> All events
              </label>
              {!form.events.includes('*') && (
                <div className="grid grid-cols-2 gap-1">
                  {data.events.map((ev: string) => (
                    <label key={ev} className="flex items-center gap-2 font-mono text-xs">
                      <input type="checkbox" checked={form.events.includes(ev)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} /> {ev}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button
              className="btn-primary w-full"
              disabled={!form.url || !form.events.length}
              onClick={async () => {
                try {
                  const res = await api.post(`/orgs/${org.slug}/webhooks`, { url: form.url, events: form.events, spaceId: form.spaceId || null });
                  setSecret(res.secret);
                  await refresh();
                } catch (err) {
                  toast((err as ApiError).message, 'error');
                }
              }}
            >
              Create webhook
            </button>
          </div>
        )}
      </Modal>
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Recent deliveries" size="lg">
        {deliveries.isLoading && <Spinner />}
        {!deliveries.isLoading && !deliveries.data?.length && <p className="muted text-sm">No deliveries yet.</p>}
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {(deliveries.data || []).map((d: any) => (
            <details key={d.id} className="rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700">
              <summary className="flex cursor-pointer items-center gap-2">
                <Badge tone={d.status === 'success' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{d.status}</Badge>
                <code className="text-xs">{d.event}</code>
                <span className="muted text-xs">
                  HTTP {d.response_code ?? '—'} · {d.attempts} attempt(s) · {timeAgo(d.created_at)}
                </span>
                {d.status === 'failed' && (
                  <button
                    className="btn-ghost ml-auto px-2 py-0.5 text-xs"
                    onClick={async (e) => {
                      e.preventDefault();
                      await api.post(`/orgs/${org.slug}/webhooks/${viewing.id}/deliveries/${d.id}/retry`);
                      await deliveries.refetch();
                    }}
                  >
                    Retry
                  </button>
                )}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">{JSON.stringify(d.payload, null, 2)}</pre>
              {d.response_body && <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">{d.response_body}</pre>}
            </details>
          ))}
        </div>
      </Modal>
    </Section>
  );
}

function Audit({ org }: { org: any }) {
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<any[][]>([]);
  const first = useQuery({ queryKey: ['audit', org.slug, action], queryFn: () => api.get(`/orgs/${org.slug}/audit?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}`) });
  const all = [...(first.data || []), ...pages.flat()];
  return (
    <Section
      title="Audit log"
      description="Security-relevant actions across the organization."
      actions={
        <a className="btn-secondary" href={`/api/orgs/${org.slug}/audit.csv`}>
          <Download className="h-4 w-4" /> Export CSV
        </a>
      }
    >
      <select className="input mb-3 w-56" value={action} onChange={(e) => (setPages([]), setAction(e.target.value))}>
        <option value="">All actions</option>
        {['auth.', 'member.', 'space.', 'page.', 'change_request.', 'webhook.', 'team.', 'openapi.', 'org.'].map((a) => (
          <option key={a} value={a}>
            {a.replace('.', '')}
          </option>
        ))}
      </select>
      {first.isLoading && <Spinner />}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
              <th className="py-2 pr-3 font-medium">When</th>
              <th className="py-2 pr-3 font-medium">Actor</th>
              <th className="py-2 pr-3 font-medium">Action</th>
              <th className="py-2 pr-3 font-medium">Details</th>
              <th className="py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {all.map((a: any) => (
              <tr key={a.id} className="border-b border-slate-100 align-top dark:border-slate-800/60">
                <td className="whitespace-nowrap py-2 pr-3 text-xs" title={new Date(a.created_at).toLocaleString()}>
                  {timeAgo(a.created_at)}
                </td>
                <td className="py-2 pr-3 text-xs">{a.actor_name || a.actor_email || 'system'}</td>
                <td className="py-2 pr-3">
                  <code className="text-xs">{a.action}</code>
                </td>
                <td className="max-w-xs truncate py-2 pr-3 font-mono text-[11px] text-slate-500">{a.meta ? JSON.stringify(a.meta) : ''}</td>
                <td className="py-2 font-mono text-[11px]">{a.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length >= 50 && all.length % 50 === 0 && (
        <button
          className="btn-secondary mt-3"
          onClick={async () => {
            const more = await api.get(`/orgs/${org.slug}/audit?limit=50&before=${all[all.length - 1].id}${action ? `&action=${encodeURIComponent(action)}` : ''}`);
            setPages([...pages, more]);
          }}
        >
          Load more
        </button>
      )}
    </Section>
  );
}
