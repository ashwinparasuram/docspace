import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FilePlus2, FileX2, FileEdit, GitMerge, GitPullRequest, MessageSquare, Pencil, Plus, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { atLeast, cn, timeAgo } from '../../lib/utils';
import { Avatar, Badge, EmptyState, Menu, PageLoader, Spinner, Tabs, useConfirm, useToast } from '../../components/ui';
import { DiffView } from '../../editor/Panels';

const STATUS_TONE: Record<string, any> = { open: 'green', draft: 'slate', merged: 'purple', closed: 'red' };

export default function ChangeRequests({ space, onNewCr }: { space: any; onNewCr: () => void }) {
  const { number } = useParams();
  return number ? <CrDetail space={space} number={number} /> : <CrList space={space} onNewCr={onNewCr} />;
}

function CrList({ space, onNewCr }: { space: any; onNewCr: () => void }) {
  const { orgSlug } = useParams();
  const [status, setStatus] = useState<'open' | 'merged' | 'closed' | 'all'>('open');
  const { data = [], isLoading } = useQuery({ queryKey: ['crs', space.id, status], queryFn: () => api.get(`/spaces/${space.id}/change-requests?status=${status}`) });
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Change requests</h1>
            <p className="muted text-sm">Propose, review and merge changes to the live documentation.</p>
          </div>
          {atLeast(space.role, 'editor') && (
            <button className="btn-primary" onClick={onNewCr}>
              <Plus className="h-4 w-4" /> New change request
            </button>
          )}
        </div>
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { id: 'open', label: 'Open' },
            { id: 'merged', label: 'Merged' },
            { id: 'closed', label: 'Closed' },
            { id: 'all', label: 'All' },
          ]}
        />
        <div className="card mt-4 divide-y divide-slate-200 dark:divide-slate-800">
          {isLoading && (
            <div className="p-6">
              <Spinner />
            </div>
          )}
          {!isLoading && !data.length && <EmptyState icon={<GitPullRequest className="h-5 w-5" />} title={`No ${status === 'all' ? '' : status} change requests`} />}
          {data.map((cr: any) => (
            <Link key={cr.id} to={`/o/${orgSlug}/s/${space.id}/cr/${cr.number}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
              {cr.status === 'merged' ? <GitMerge className="h-4 w-4 text-purple-500" /> : cr.status === 'closed' ? <XCircle className="h-4 w-4 text-red-500" /> : <GitPullRequest className="h-4 w-4 text-emerald-500" />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {cr.title} <span className="muted font-normal">#{cr.number}</span>
                </div>
                <div className="muted text-xs">
                  {cr.author_name} · opened {timeAgo(cr.created_at)}
                </div>
              </div>
              {cr.status === 'draft' && <Badge>Draft</Badge>}
              {cr.approvals > 0 && (
                <Badge tone="green">
                  <CheckCircle2 className="h-3 w-3" /> {cr.approvals}
                </Badge>
              )}
              {cr.comments > 0 && (
                <span className="muted flex items-center gap-1 text-xs">
                  <MessageSquare className="h-3.5 w-3.5" /> {cr.comments}
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function CrDetail({ space, number }: { space: any; number: string }) {
  const { orgSlug } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ['cr', space.id, number];
  const { data: cr, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/spaces/${space.id}/change-requests/${number}`) });
  const comments = useQuery({ queryKey: ['cr-comments', cr?.id], queryFn: () => api.get(`/spaces/${space.id}/comments?crId=${cr.id}`), enabled: !!cr?.id });
  const reviewers = useQuery({ queryKey: ['reviewers', space.id], queryFn: () => api.get(`/spaces/${space.id}/reviewers`) });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState('');
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: '', description: '' });
  const [merging, setMerging] = useState(false);

  if (isLoading) return <PageLoader />;
  if (error) return <EmptyState title="Change request not found" description={(error as ApiError).message} />;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ['crs', space.id] });
  };
  const isOpen = cr.status === 'open' || cr.status === 'draft';
  const canEdit = atLeast(space.role, 'editor');

  const submitReview = async (state: string) => {
    try {
      await api.post(`/spaces/${space.id}/change-requests/${number}/reviews`, { state, body: review || undefined });
      setReview('');
      toast(state === 'approved' ? 'Approved' : state === 'changes_requested' ? 'Changes requested' : 'Comment added');
      await refresh();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  const merge = async (force = false) => {
    setMerging(true);
    try {
      const res = await api.post(`/spaces/${space.id}/change-requests/${number}/merge`, { force });
      toast(`Merged ${res.merged} change(s) into main`);
      await refresh();
      await qc.invalidateQueries({ queryKey: ['space', space.id] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409 && atLeast(space.role, 'admin')) {
        const ok = await confirm({
          title: 'Merge conflicts',
          message: (
            <div>
              <p>These pages changed on main since the branch was created:</p>
              <ul className="mt-2 list-disc pl-5">
                {(e.details?.conflicts || []).map((c: any) => (
                  <li key={c.stableId}>{c.title}</li>
                ))}
              </ul>
              <p className="mt-2">Merge anyway and overwrite main with this branch's version?</p>
            </div>
          ),
          danger: true,
          confirmLabel: 'Overwrite and merge',
        });
        if (ok) await merge(true);
      } else toast(e.message, 'error');
    } finally {
      setMerging(false);
    }
  };

  const setStatus = async (status: string) => {
    await api.patch(`/spaces/${space.id}/change-requests/${number}`, { status });
    await refresh();
    if (status === 'closed') await qc.invalidateQueries({ queryKey: ['space', space.id] });
  };

  const timeline = [
    ...cr.reviews.map((r: any) => ({ ...r, kind: 'review' })),
    ...(comments.data || []).flatMap((t: any) => [t, ...t.replies]).map((c: any) => ({ ...c, kind: 'comment' })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Link to={`/o/${orgSlug}/s/${space.id}/cr`} className="muted text-sm hover:underline">
          ← All change requests
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="space-y-2">
                <input className="input text-lg font-semibold" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                <textarea className="input min-h-[80px]" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                <div className="flex gap-2">
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      await api.patch(`/spaces/${space.id}/change-requests/${number}`, form);
                      setEditing(false);
                      await refresh();
                    }}
                  >
                    Save
                  </button>
                  <button className="btn-secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                  {cr.title} <span className="muted font-normal">#{cr.number}</span>
                  {canEdit && isOpen && (
                    <button className="btn-ghost p-1" onClick={() => (setForm({ title: cr.title, description: cr.description || '' }), setEditing(true))}>
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={STATUS_TONE[cr.status]}>{cr.status}</Badge>
                  <span className="muted">
                    {cr.author_name} wants to merge <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{cr.branch_name}</code> into main · {timeAgo(cr.created_at)}
                  </span>
                </div>
                {cr.description && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{cr.description}</p>}
              </>
            )}
          </div>
          {isOpen && (
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => navigate(`/o/${orgSlug}/s/${space.id}/b/${cr.branch_id}`)}>
                <FileEdit className="h-4 w-4" /> Edit content
              </button>
              {canEdit && cr.status === 'draft' && (
                <button className="btn-primary" onClick={() => setStatus('open')}>
                  Ready for review
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <h2 className="font-semibold">Changes {cr.changes.length ? <span className="muted font-normal">({cr.changes.length} pages)</span> : null}</h2>
            {isOpen && !cr.changes.length && <div className="card p-6 text-center text-sm muted">No changes yet. Open the branch and start editing.</div>}
            {cr.status === 'merged' && <div className="card p-4 text-sm">Merged by {cr.merged_by_name} {timeAgo(cr.merged_at)}.</div>}
            {cr.changes.map((c: any) => {
              const open = expanded[c.stableId] ?? cr.changes.length <= 3;
              return (
                <div key={c.stableId} className="card overflow-hidden">
                  <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left" onClick={() => setExpanded({ ...expanded, [c.stableId]: !open })}>
                    {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                    {c.type === 'added' ? <FilePlus2 className="h-4 w-4 text-emerald-500" /> : c.type === 'deleted' ? <FileX2 className="h-4 w-4 text-red-500" /> : <FileEdit className="h-4 w-4 text-amber-500" />}
                    <span className="flex-1 truncate font-medium">{c.title}</span>
                    {c.conflict && (
                      <Badge tone="red">
                        <AlertTriangle className="h-3 w-3" /> Conflict
                      </Badge>
                    )}
                    <span className="text-xs text-emerald-600">+{c.stats.added}</span>
                    <span className="text-xs text-red-600">−{c.stats.removed}</span>
                  </button>
                  {open && (
                    <div className="border-t border-slate-200 p-3 dark:border-slate-800">
                      {c.meta.length > 0 && (
                        <ul className="mb-2 space-y-0.5 text-xs">
                          {c.meta.map((m: any) => (
                            <li key={m.field}>
                              <span className="font-medium">{m.field}</span>: <s className="text-red-600">{String(m.from ?? '—')}</s> → <span className="text-emerald-600">{String(m.to ?? '—')}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <DiffView diff={c.diff} />
                    </div>
                  )}
                </div>
              );
            })}

            <h2 className="pt-4 font-semibold">Activity</h2>
            <div className="space-y-3">
              {timeline.map((t: any) => (
                <div key={t.id} className="flex gap-3">
                  <Avatar name={t.user_name || t.author_name || '?'} id={t.user_id || t.author_id} size={28} />
                  <div className="card min-w-0 flex-1 px-4 py-2.5 text-sm">
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="font-medium">{t.user_name || t.author_name}</span>
                      {t.kind === 'review' && t.state === 'approved' && <Badge tone="green">approved</Badge>}
                      {t.kind === 'review' && t.state === 'changes_requested' && <Badge tone="red">requested changes</Badge>}
                      <span className="muted text-xs">{timeAgo(t.created_at)}</span>
                    </div>
                    {t.body && <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">{t.body}</p>}
                  </div>
                </div>
              ))}
              {atLeast(space.role, 'commenter') && (
                <div className="flex gap-2">
                  <textarea className="input min-h-[60px]" placeholder="Leave a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <button
                    className="btn-secondary self-end"
                    disabled={!comment.trim()}
                    onClick={async () => {
                      await api.post(`/spaces/${space.id}/comments`, { body: comment, crId: cr.id });
                      setComment('');
                      await qc.invalidateQueries({ queryKey: ['cr-comments', cr.id] });
                    }}
                  >
                    Comment
                  </button>
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-4">
            <div className="card p-4">
              <h3 className="mb-2 text-sm font-semibold">Review</h3>
              <p className="muted text-xs">
                {cr.approvals} of {cr.requiredApprovals || 0} required approval{cr.requiredApprovals === 1 ? '' : 's'}
                {cr.changesRequested && ' · changes requested'}
              </p>
              {isOpen && atLeast(space.role, 'commenter') && (
                <div className="mt-3 space-y-2">
                  <textarea className="input min-h-[60px] text-xs" placeholder="Review summary (optional)" value={review} onChange={(e) => setReview(e.target.value)} />
                  {atLeast(space.role, 'reviewer') && (
                    <div className="flex gap-1.5">
                      <button className="btn-secondary flex-1 px-2 text-xs text-emerald-700 dark:text-emerald-400" onClick={() => submitReview('approved')}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button className="btn-secondary flex-1 px-2 text-xs text-red-700 dark:text-red-400" onClick={() => submitReview('changes_requested')}>
                        Request changes
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="card p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Reviewers</h3>
                {canEdit && isOpen && (
                  <Menu
                    align="right"
                    className="w-64"
                    trigger={() => <button className="text-xs text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-slate-100 dark:decoration-slate-600">Edit</button>}
                  >
                    {() => (
                      <div className="max-h-64 overflow-y-auto py-1">
                        {(reviewers.data || []).map((u: any) => {
                          const selected = cr.reviewers.some((r: any) => r.id === u.id);
                          return (
                            <label key={u.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={async () => {
                                  const ids = selected ? cr.reviewers.filter((r: any) => r.id !== u.id).map((r: any) => r.id) : [...cr.reviewers.map((r: any) => r.id), u.id];
                                  await api.post(`/spaces/${space.id}/change-requests/${number}/reviewers`, { userIds: ids });
                                  await refresh();
                                }}
                              />
                              {u.name}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </Menu>
                )}
              </div>
              {!cr.reviewers.length && <p className="muted text-xs">No reviewers requested</p>}
              {cr.reviewers.map((r: any) => {
                const last = [...cr.reviews].reverse().find((x: any) => x.user_id === r.id && x.state !== 'commented');
                return (
                  <div key={r.id} className="flex items-center gap-2 py-1 text-sm">
                    <Avatar name={r.name} id={r.id} size={22} />
                    <span className="flex-1 truncate">{r.name}</span>
                    {last?.state === 'approved' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                    {last?.state === 'changes_requested' && <XCircle className="h-4 w-4 text-red-500" />}
                  </div>
                );
              })}
            </div>
            {isOpen && canEdit && (
              <div className="card space-y-2 p-4">
                {cr.conflicts > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-red-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" /> {cr.conflicts} page(s) changed on main since this branch was created. Use “Sync” in the branch or merge as an admin to overwrite.
                  </p>
                )}
                <button className={cn('btn-primary w-full', !cr.canMerge && 'opacity-60')} disabled={merging || cr.status !== 'open' || !cr.changes.length} onClick={() => merge(false)}>
                  {merging ? <Spinner className="text-current" /> : <GitMerge className="h-4 w-4" />} Merge into main
                </button>
                {!cr.canMerge && cr.status === 'open' && cr.changes.length > 0 && <p className="muted text-xs">{cr.changesRequested ? 'Changes were requested.' : `Needs ${cr.requiredApprovals} approval(s); admins can override.`}</p>}
                <button className="btn-ghost w-full text-xs text-red-600" onClick={() => setStatus('closed')}>
                  Close change request
                </button>
              </div>
            )}
            {cr.status === 'closed' && canEdit && cr.branch_status === 'open' && (
              <button className="btn-secondary w-full" onClick={() => setStatus('open')}>
                Reopen
              </button>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
