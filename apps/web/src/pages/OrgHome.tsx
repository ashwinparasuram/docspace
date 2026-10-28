import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ExternalLink, Plus, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { atLeast, cn, timeAgo } from '../lib/utils';
import { Badge, EmptyState, Field, Modal, PageLoader, Spinner } from '../components/ui';
import { Monogram } from '../components/Logo';

const TEMPLATES = [
  { id: 'blank', name: 'Blank', description: 'A single empty page.' },
  { id: 'product', name: 'Product documentation', description: 'Overview, getting started, guides and troubleshooting.' },
  { id: 'api', name: 'API reference', description: 'Overview and error pages, ready for an OpenAPI import.' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const VISIBILITY: Record<string, string> = { public: 'Public', unlisted: 'Unlisted', password: 'Password', share: 'Share link', members: 'Members' };

export default function OrgHome() {
  const { orgSlug } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ['org', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}`) });
  const spaces = useQuery({ queryKey: ['spaces', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}/spaces`) });
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ name: '', description: '', template: 'product' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (org.isLoading || spaces.isLoading) return <PageLoader />;
  if (org.error) return <EmptyState title="Organization unavailable" description={(org.error as ApiError).message} />;
  const role = org.data.role;
  const list = (spaces.data as any[]).filter((s) => !filter || `${s.name} ${s.description || ''}`.toLowerCase().includes(filter.toLowerCase()));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/orgs/${orgSlug}/spaces`, form);
      await qc.invalidateQueries({ queryKey: ['spaces', orgSlug] });
      navigate(`/o/${orgSlug}/s/${res.id}`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Organization</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{org.data.name}</h1>
          <p className="muted mt-1 text-sm">
            {plural(org.data.counts.spaces, 'space')} · {plural(org.data.counts.members, 'member')} · {plural(org.data.counts.teams, 'team')}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/o/${orgSlug}/reusable`} className="btn-secondary">
            Reusable content
          </Link>
          {atLeast(role, 'admin') && (
            <Link to={`/o/${orgSlug}/settings`} className="btn-secondary">
              Settings
            </Link>
          )}
          {atLeast(role, 'creator') && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New space
            </button>
          )}
        </div>
      </div>

      <div className="mt-8">
        {!spaces.data.length ? (
          <div className="card">
            <EmptyState
              icon={<BookOpen className="h-5 w-5" />}
              title="No spaces yet"
              description="A space is one documentation site: a tree of pages with its own publishing, theme and permissions."
              action={
                atLeast(role, 'creator') && (
                  <button className="btn-primary" onClick={() => setCreating(true)}>
                    Create a space
                  </button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Spaces</h2>
              <div className="relative w-56">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                <input className="input pl-8" placeholder="Filter spaces" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_120px_80px_110px] gap-4 border-b border-slate-200 bg-slate-50/70 px-4 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900">
                <span>Name</span>
                <span>Status</span>
                <span className="text-right">Pages</span>
                <span className="text-right">Updated</span>
              </div>
              {list.map((s) => (
                <div key={s.id} className="group grid grid-cols-[minmax(0,1fr)_120px_80px_110px] items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40">
                  <Link to={`/o/${orgSlug}/s/${s.id}`} className="flex min-w-0 items-center gap-3">
                    <Monogram name={s.name} icon={s.icon} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900 group-hover:underline dark:text-white">{s.name}</span>
                      <span className="muted block truncate text-xs">{s.description || 'No description'}</span>
                    </span>
                  </Link>
                  <span className="flex items-center gap-1.5">
                    {s.published ? <Badge tone="green">{VISIBILITY[s.visibility] || 'Published'}</Badge> : <Badge>Draft</Badge>}
                    {s.open_crs > 0 && (
                      <span className="muted text-xs" title="Open change requests">
                        {s.open_crs} open
                      </span>
                    )}
                  </span>
                  <span className="text-right text-sm tabular-nums text-slate-600 dark:text-slate-400">{s.page_count}</span>
                  <span className="muted flex items-center justify-end gap-2 text-xs">
                    {timeAgo(s.updated_at)}
                    {s.published ? (
                      <a href={`/s/${orgSlug}/${s.slug}`} target="_blank" rel="noreferrer" className="text-slate-400 opacity-0 hover:text-slate-700 group-hover:opacity-100 dark:hover:text-slate-200" title="Open published site">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <span className="w-3.5" />
                    )}
                  </span>
                </div>
              ))}
              {!list.length && <p className="muted px-4 py-8 text-center text-sm">No spaces match “{filter}”.</p>}
            </div>
          </>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New space"
        size="md"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!form.name || busy} onClick={create}>
              {busy && <Spinner className="text-current" />} Create space
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Developer documentation" />
          </Field>
          <Field label="Description" hint="Shown in search results and link previews.">
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div>
            <label className="label">Starting point</label>
            <div className="space-y-1.5">
              {TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                    form.template === t.id ? 'border-slate-900 bg-slate-50 dark:border-slate-300 dark:bg-slate-800/60' : 'border-slate-200 hover:border-slate-300 dark:border-slate-800',
                  )}
                >
                  <input type="radio" className="mt-0.5 accent-slate-900" checked={form.template === t.id} onChange={() => setForm({ ...form, template: t.id })} />
                  <span>
                    <span className="block text-sm font-medium">{t.name}</span>
                    <span className="muted block text-xs">{t.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
