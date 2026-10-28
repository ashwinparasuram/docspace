import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Check, ExternalLink, FileUp, GitBranch, GitPullRequest, Globe, Plus, RefreshCw, Search, Settings, PenLine, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMeta } from '../../lib/auth';
import { atLeast, cn } from '../../lib/utils';
import { Badge, EmptyState, Field, Menu, MenuItem, Modal, PageLoader, Spinner, useToast } from '../../components/ui';
import { PageTree } from './PageTree';
import { Monogram } from '../../components/Logo';
import { PageEditor } from '../../editor/PageEditor';

const ChangeRequests = lazy(() => import('./ChangeRequests'));
const Insights = lazy(() => import('./Insights'));
const SpaceSettings = lazy(() => import('./SpaceSettings'));

export default function SpaceLayout() {
  const { orgSlug, spaceId } = useParams();
  const space = useQuery({ queryKey: ['space', spaceId], queryFn: () => api.get(`/spaces/${spaceId}`) });
  const crs = useQuery({ queryKey: ['crs', spaceId, 'open'], queryFn: () => api.get(`/spaces/${spaceId}/change-requests?status=open`) });
  const [newCr, setNewCr] = useState(false);

  if (space.isLoading) return <PageLoader />;
  if (space.error) return <EmptyState title="Space unavailable" description={(space.error as ApiError).message} />;
  const s = space.data;
  const main = s.branches.find((b: any) => b.is_main);
  const base = `/o/${orgSlug}/s/${spaceId}`;

  const tab = (to: string, label: React.ReactNode, end = false) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium', isActive ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white')
      }
    >
      {label}
    </NavLink>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
        <Link to={`/o/${orgSlug}`} className="flex min-w-0 items-center gap-2 font-semibold">
          <Monogram name={s.name} icon={s.icon} size={22} className="text-[11px]" />
          <span className="truncate">{s.name}</span>
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {tab(`${base}/b`, 'Content')}
          {tab(
            `${base}/cr`,
            <>
              <GitPullRequest className="h-3.5 w-3.5" /> Change requests
              {crs.data?.length ? <Badge tone="brand">{crs.data.length}</Badge> : null}
            </>,
          )}
          {tab(
            `${base}/insights`,
            <>
              <BarChart3 className="h-3.5 w-3.5" /> Insights
            </>,
          )}
          {atLeast(s.role, 'admin') &&
            tab(
              `${base}/settings`,
              <>
                <Settings className="h-3.5 w-3.5" /> Settings
              </>,
            )}
        </nav>
        <div className="flex-1" />
        {s.published ? (
          <a href={s.siteUrl} target="_blank" rel="noreferrer" className="btn-secondary hidden sm:inline-flex">
            Open site <ExternalLink className="h-3 w-3 text-slate-400" />
          </a>
        ) : atLeast(s.role, 'admin') ? (
          <Link to={`${base}/settings/publishing`} className="btn-primary">
            Publish
          </Link>
        ) : (
          <Badge>Not published</Badge>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route index element={<Navigate to={`b/${main.id}`} replace />} />
            <Route path="b" element={<Navigate to={`${main.id}`} replace />} />
            <Route path="b/:branchId" element={<BranchView space={s} onNewCr={() => setNewCr(true)} />} />
            <Route path="b/:branchId/p/:pageId" element={<BranchView space={s} onNewCr={() => setNewCr(true)} />} />
            <Route path="cr" element={<ChangeRequests space={s} onNewCr={() => setNewCr(true)} />} />
            <Route path="cr/:number" element={<ChangeRequests space={s} onNewCr={() => setNewCr(true)} />} />
            <Route path="insights" element={<Insights space={s} />} />
            <Route path="settings" element={<SpaceSettings space={s} />} />
            <Route path="settings/:tab" element={<SpaceSettings space={s} />} />
          </Routes>
        </Suspense>
      </div>
      <NewChangeRequestModal open={newCr} onClose={() => setNewCr(false)} space={s} />
    </div>
  );
}

export function NewChangeRequestModal({ open, onClose, space }: { open: boolean; onClose: () => void; space: any }) {
  const { orgSlug } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setError(null);
    }
  }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/spaces/${space.id}/change-requests`, { title, description, draft: true });
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      await qc.invalidateQueries({ queryKey: ['crs', space.id] });
      onClose();
      navigate(`/o/${orgSlug}/s/${space.id}/b/${res.branchId}`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New change request"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!title.trim() || busy} onClick={create}>
            {busy && <Spinner className="text-current" />} Create & start editing
          </button>
        </>
      }
    >
      <p className="muted mb-4 text-sm">A change request creates a branch — an isolated copy of the content. Edit it freely, then submit it for review and merge it into the live documentation.</p>
      <div className="space-y-3">
        <Field label="Title">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document the new billing API" />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-[80px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is changing and why?" />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

function BranchView({ space, onNewCr }: { space: any; onNewCr: () => void }) {
  const { orgSlug, branchId, pageId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const [filter, setFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const tree = useQuery({ queryKey: ['tree', space.id, branchId], queryFn: () => api.get(`/spaces/${space.id}/branches/${branchId}/tree`) });
  const branch = space.branches.find((b: any) => b.id === branchId);
  const base = `/o/${orgSlug}/s/${space.id}`;

  // Redirect to the first page when none is selected.
  useEffect(() => {
    if (!pageId && tree.data?.pages?.length) {
      const first = (nodes: any[]): any => {
        for (const n of nodes) {
          if (n.kind === 'doc' || n.kind === 'api') return n;
          const c = first(n.children);
          if (c) return c;
        }
        return nodes[0];
      };
      const p = first(tree.data.pages);
      if (p) navigate(`${base}/b/${branchId}/p/${p.id}`, { replace: true });
    }
  }, [pageId, tree.data, branchId, base, navigate]);

  if (!branch) {
    if (tree.error) return <EmptyState title="Branch not found" description="It may have been merged or closed." action={<Link className="btn-primary" to={base}>Go to main</Link>} />;
  }

  const canEdit: boolean = tree.data?.canEdit ?? false;
  const branches = space.branches as any[];

  const importMarkdown = async (files: FileList) => {
    const list = await Promise.all(Array.from(files).map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, markdown: await f.text() })));
    try {
      const res = await api.post(`/spaces/${space.id}/branches/${branchId}/import`, { files: list.filter((f) => /\.(md|mdx|markdown)$/i.test(f.path)) });
      toast(`Imported ${res.created} page(s)`);
      await qc.invalidateQueries({ queryKey: ['tree', space.id, branchId] });
      setImporting(false);
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 flex-none flex-col border-r border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="space-y-2 p-3">
          <Menu
            className="w-72"
            trigger={() => (
              <button className="btn-secondary w-full justify-between">
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 flex-none text-slate-400" />
                  <span className="truncate">{branch?.is_main ? 'main (live)' : branch?.name || 'Branch'}</span>
                </span>
                <span className="text-xs text-slate-400">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                {branches.map((b) => (
                  <MenuItem key={b.id} icon={b.id === branchId ? <Check className="h-4 w-4" /> : <GitBranch className="h-4 w-4" />} onClick={() => (close(), navigate(`${base}/b/${b.id}`))}>
                    <span className="truncate">{b.is_main ? 'main (live)' : b.name}</span>
                    {b.cr_number && <span className="muted ml-auto text-xs">#{b.cr_number}</span>}
                  </MenuItem>
                ))}
                {atLeast(space.role, 'editor') && (
                  <>
                    <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
                    <MenuItem icon={<Plus className="h-4 w-4" />} onClick={() => (close(), onNewCr())}>
                      New change request
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Menu>
          {branch && !branch.is_main && (
            <div className="rounded-md border border-slate-200 bg-white p-2.5 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="font-medium text-slate-900 dark:text-white">Editing a branch</div>
              <p className="muted mt-0.5">Changes are isolated until the change request is merged.</p>
              <div className="mt-2 flex gap-1.5">
                {branch.cr_number ? (
                  <Link className="btn-primary px-2 py-1 text-xs" to={`${base}/cr/${branch.cr_number}`}>
                    <GitPullRequest className="h-3.5 w-3.5" /> Review #{branch.cr_number}
                  </Link>
                ) : null}
                <button
                  className="btn-secondary px-2 py-1 text-xs"
                  title="Pull the latest main content into pages you haven't changed"
                  onClick={async () => {
                    const res = await api.post(`/spaces/${space.id}/branches/${branchId}/sync`);
                    toast(res.updated ? `Updated ${res.updated} page(s) from main` : 'Already up to date');
                    await qc.invalidateQueries({ queryKey: ['tree', space.id, branchId] });
                    await qc.invalidateQueries({ queryKey: ['page'] });
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Sync
                </button>
              </div>
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <input className="input py-1.5 pl-8 text-xs" placeholder="Filter pages" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {filter && (
              <button className="absolute right-2 top-1.5 text-slate-400" onClick={() => setFilter('')}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tree.isLoading ? (
            <div className="p-3">
              <Spinner />
            </div>
          ) : (
            <PageTree pages={tree.data?.pages || []} activePageId={pageId} canEdit={canEdit} orgSlug={orgSlug!} spaceId={space.id} branchId={branchId!} filter={filter} />
          )}
        </div>
        {canEdit && (
          <div className="flex gap-1 border-t border-slate-200 p-2 dark:border-slate-800">
            <button className="btn-ghost flex-1 px-2 py-1 text-xs" onClick={() => setImporting(true)}>
              <FileUp className="h-3.5 w-3.5" /> Import
            </button>
            <button className="btn-ghost flex-1 px-2 py-1 text-xs" onClick={() => setGenerating(true)} disabled={!meta.data?.ai.llm} title={meta.data?.ai.llm ? 'Draft a page with the writing assistant' : 'Requires a configured language model'}>
              <PenLine className="h-3.5 w-3.5" /> Draft page
            </button>
          </div>
        )}
      </aside>
      <div className="min-w-0 flex-1">
        {pageId ? (
          <PageEditor key={pageId} pageId={pageId} orgSlug={orgSlug!} spaceId={space.id} siteUrl={space.siteUrl} onCreateChangeRequest={onNewCr} />
        ) : tree.data && !tree.data.pages.length ? (
          <EmptyState title="No pages yet" description={canEdit ? 'Create your first page from the sidebar.' : 'This space is empty.'} />
        ) : (
          <PageLoader />
        )}
      </div>

      <Modal open={importing} onClose={() => setImporting(false)} title="Import Markdown">
        <p className="muted mb-4 text-sm">Import .md files or a whole folder (e.g. an existing docs repository). Folders become nested pages; README/index files become the folder page. GitHub alerts, hints, tables, task lists and mermaid fences are converted.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="btn-secondary cursor-pointer py-6">
            Choose files
            <input type="file" multiple accept=".md,.mdx,.markdown" className="hidden" onChange={(e) => e.target.files && importMarkdown(e.target.files)} />
          </label>
          <label className="btn-secondary cursor-pointer py-6">
            Choose folder
            <input type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => e.target.files && importMarkdown(e.target.files)} />
          </label>
        </div>
      </Modal>

      <Modal
        open={generating}
        onClose={() => setGenerating(false)}
        title="Draft a page"
        footer={
          <button
            className="btn-primary"
            disabled={genPrompt.trim().length < 3 || genBusy}
            onClick={async () => {
              setGenBusy(true);
              try {
                const res = await api.post(`/spaces/${space.id}/branches/${branchId}/ai-generate`, { prompt: genPrompt });
                await qc.invalidateQueries({ queryKey: ['tree', space.id, branchId] });
                setGenerating(false);
                setGenPrompt('');
                navigate(`${base}/b/${branchId}/p/${res.id}`);
              } catch (err) {
                toast((err as ApiError).message, 'error');
              } finally {
                setGenBusy(false);
              }
            }}
          >
            {genBusy ? <Spinner className="text-current" /> : <PenLine className="h-4 w-4" />} Draft page
          </button>
        }
      >
        <textarea className="input min-h-[120px]" autoFocus value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} placeholder="Describe the page: audience, topics, examples to include…" />
        <p className="muted mt-2 text-xs">Uses the configured model ({meta.data?.ai.chatModel}). Review the draft before publishing.</p>
      </Modal>
    </div>
  );
}
