import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { AlertCircle, CheckCircle2, Download, History, Languages, MessageSquare, RotateCcw, PenLine, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { atLeast, cn, timeAgo } from '../lib/utils';
import { Avatar, Badge, Field, Modal, Spinner, Toggle, useConfirm, useToast } from '../components/ui';
import { LANGUAGES } from './AiDialog';

// ---- Comments ---------------------------------------------------------------------------------

export interface PendingComment {
  threadId: string;
  quote: string;
}

function findThreadRange(editor: Editor, threadId: string): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.threadId === threadId)) {
      if (from < 0) from = pos;
      to = pos + node.nodeSize;
    }
  });
  return from >= 0 ? { from, to } : null;
}

export function removeThreadMark(editor: Editor, threadId: string) {
  const range = findThreadRange(editor, threadId);
  if (!range) return;
  const type = editor.schema.marks.comment;
  const tr = editor.state.tr;
  editor.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    node.marks.filter((m) => m.type === type && m.attrs.threadId === threadId).forEach((m) => tr.removeMark(pos, pos + node.nodeSize, m));
  });
  editor.view.dispatch(tr);
}

export function CommentsPanel({
  spaceId,
  pageStableId,
  branchId,
  editor,
  role,
  canEdit,
  pending,
  clearPending,
  activeThread,
  setActiveThread,
}: {
  spaceId: string;
  pageStableId: string;
  branchId: string;
  editor: Editor | null;
  role: string;
  canEdit: boolean;
  pending: PendingComment | null;
  clearPending: () => void;
  activeThread: string | null;
  setActiveThread: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ['comments', spaceId, pageStableId];
  const { data: threads = [], isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/spaces/${spaceId}/comments?pageStableId=${pageStableId}`) });
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const canComment = atLeast(role, 'commenter');

  useEffect(() => {
    if (activeThread) document.getElementById(`thread-${activeThread}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeThread]);

  // Highlight the active thread's anchor in the document.
  useEffect(() => {
    document.querySelectorAll('.comment-highlight.active').forEach((el) => el.classList.remove('active'));
    if (activeThread) document.querySelectorAll(`[data-comment-id="${activeThread}"]`).forEach((el) => el.classList.add('active'));
  }, [activeThread, threads]);

  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const submitNew = async () => {
    if (!draft.trim()) return;
    try {
      const threadId = pending?.threadId;
      await api.post(`/spaces/${spaceId}/comments`, { body: draft, pageStableId, branchId, threadId, quote: pending?.quote });
      setDraft('');
      clearPending();
      await refresh();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  const reply = async (thread: any) => {
    const body = replies[thread.thread_id];
    if (!body?.trim()) return;
    await api.post(`/spaces/${spaceId}/comments`, { body, parentId: thread.id });
    setReplies({ ...replies, [thread.thread_id]: '' });
    await refresh();
  };

  const resolve = async (thread: any, resolved: boolean) => {
    await api.post(`/spaces/${spaceId}/comments/threads/${thread.thread_id}/resolve`, { resolved });
    if (resolved && editor && canEdit) removeThreadMark(editor, thread.thread_id);
    await refresh();
  };

  const remove = async (c: any, isThread: boolean) => {
    if (!(await confirm({ title: isThread ? 'Delete thread?' : 'Delete comment?', danger: true, confirmLabel: 'Delete' }))) return;
    await api.del(`/spaces/${spaceId}/comments/${c.id}`);
    if (isThread && editor && canEdit) removeThreadMark(editor, c.thread_id);
    await refresh();
  };

  const visible = threads.filter((t: any) => showResolved || !t.resolved);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="h-4 w-4" /> Comments
        </h3>
        <label className="muted flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {canComment && (
          <div className={cn('rounded-lg border p-2', pending ? 'border-amber-300 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/5' : 'border-slate-200 dark:border-slate-700')}>
            {pending && (
              <div className="mb-2 flex items-start justify-between gap-2">
                <blockquote className="line-clamp-3 border-l-2 border-amber-400 pl-2 text-xs italic text-slate-600 dark:text-slate-300">{pending.quote}</blockquote>
                <button className="muted text-xs" onClick={clearPending}>
                  Cancel
                </button>
              </div>
            )}
            <textarea
              className="input min-h-[60px] resize-y border-0 p-1 focus:ring-0"
              placeholder={pending ? 'Comment on the selection…' : 'Leave a comment on this page…'}
              value={draft}
              autoFocus={!!pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitNew();
              }}
            />
            <div className="flex justify-end">
              <button className="btn-primary px-2.5 py-1 text-xs" disabled={!draft.trim()} onClick={submitNew}>
                Comment
              </button>
            </div>
          </div>
        )}
        {isLoading && <Spinner />}
        {!isLoading && !visible.length && <p className="muted py-6 text-center text-sm">No comments yet. Select text and click the comment button to start a discussion.</p>}
        {visible.map((t: any) => (
          <div
            key={t.id}
            id={`thread-${t.thread_id}`}
            className={cn('rounded-lg border p-3 text-sm transition', activeThread === t.thread_id ? 'border-amber-400 shadow-sm' : 'border-slate-200 dark:border-slate-700', t.resolved && 'opacity-60')}
            onClick={() => {
              setActiveThread(t.thread_id);
              if (editor) {
                const r = findThreadRange(editor, t.thread_id);
                if (r) editor.commands.setTextSelection(r);
                document.querySelector(`[data-comment-id="${t.thread_id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
            }}
          >
            {t.quote && <blockquote className="mb-2 line-clamp-2 border-l-2 border-amber-400 pl-2 text-xs italic text-slate-500">{t.quote}</blockquote>}
            {[t, ...t.replies].map((c: any, i: number) => (
              <div key={c.id} className={cn('group', i > 0 && 'mt-3 border-t border-slate-100 pt-2 dark:border-slate-800')}>
                <div className="flex items-center gap-2">
                  <Avatar name={c.author_name || '?'} id={c.author_id} url={c.author_avatar} size={20} />
                  <span className="font-medium">{c.author_name}</span>
                  <span className="muted text-xs">{timeAgo(c.created_at)}</span>
                  <button className="ml-auto hidden text-slate-400 hover:text-red-500 group-hover:block" onClick={(e) => (e.stopPropagation(), void remove(c, i === 0))} aria-label="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-300">{c.body.replace(/@\[([^\]]+)\]\(user:[^)]+\)/g, '@$1')}</p>
              </div>
            ))}
            {canComment && (
              <div className="mt-3 flex gap-2" onClick={(e) => e.stopPropagation()}>
                <input
                  className="input py-1 text-xs"
                  placeholder="Reply…"
                  value={replies[t.thread_id] || ''}
                  onChange={(e) => setReplies({ ...replies, [t.thread_id]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && void reply(t)}
                />
                <button className="btn-secondary flex-none px-2 py-1 text-xs" onClick={() => resolve(t, !t.resolved)} title={t.resolved ? 'Reopen' : 'Resolve'}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> {t.resolved ? 'Reopen' : 'Resolve'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Version history ----------------------------------------------------------------------------

export function HistoryPanel({ pageId, canEdit, onRestored }: { pageId: string; canEdit: boolean; onRestored: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: versions = [], isLoading } = useQuery({ queryKey: ['versions', pageId], queryFn: () => api.get(`/pages/${pageId}/versions`) });
  const [viewing, setViewing] = useState<string | null>(null);
  const version = useQuery({ queryKey: ['version', pageId, viewing], queryFn: () => api.get(`/pages/${pageId}/versions/${viewing}`), enabled: !!viewing });

  const save = async () => {
    const message = window.prompt('Describe this version (optional)') ?? undefined;
    if (message === undefined) return;
    await api.post(`/pages/${pageId}/versions`, { message });
    await qc.invalidateQueries({ queryKey: ['versions', pageId] });
    toast('Version saved');
  };

  const restore = async (id: string) => {
    if (!(await confirm({ title: 'Restore this version?', message: 'The current content is saved as a version first, so you can undo this.', confirmLabel: 'Restore' }))) return;
    await api.post(`/pages/${pageId}/versions/${id}/restore`);
    setViewing(null);
    await qc.invalidateQueries({ queryKey: ['versions', pageId] });
    toast('Version restored');
    onRestored();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4" /> Version history
        </h3>
        {canEdit && (
          <button className="btn-secondary px-2 py-1 text-xs" onClick={save}>
            Save version
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && <Spinner />}
        {!isLoading && !versions.length && <p className="muted p-6 text-center text-sm">Versions are created automatically as you edit (at most every 10 minutes) and before restores and merges.</p>}
        {versions.map((v: any) => (
          <button key={v.id} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setViewing(v.id)}>
            <div className="text-sm font-medium">{v.message || new Date(v.created_at).toLocaleString()}</div>
            <div className="muted text-xs">
              {v.author || 'Unknown'} · {timeAgo(v.created_at)} · v{v.version}
            </div>
          </button>
        ))}
      </div>
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        size="xl"
        title={version.data ? `Version from ${new Date(version.data.created_at).toLocaleString()}` : 'Version'}
        footer={
          canEdit && (
            <button className="btn-primary" onClick={() => viewing && restore(viewing)}>
              <RotateCcw className="h-4 w-4" /> Restore this version
            </button>
          )
        }
      >
        {version.isLoading ? (
          <Spinner />
        ) : (
          <div>
            <p className="muted mb-2 text-xs">Changes from this version to the current page (green = added since, red = removed since).</p>
            <DiffView diff={version.data?.diff || []} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export function DiffView({ diff }: { diff: { value: string; added?: boolean; removed?: boolean }[] }) {
  if (!diff.some((d) => d.added || d.removed)) return <p className="muted text-sm">No content differences.</p>;
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200 font-mono text-xs leading-5 dark:border-slate-700">
      {diff.map((d, i) => {
        const lines = d.value.replace(/\n$/, '').split('\n');
        if (!d.added && !d.removed && lines.length > 6) {
          return (
            <div key={i} className="text-slate-400">
              {lines.slice(0, 2).map((l, j) => (
                <div key={j} className="px-3">
                  {'  '}
                  {l}
                </div>
              ))}
              <div className="bg-slate-50 px-3 text-center dark:bg-slate-800/50">⋯ {lines.length - 4} unchanged lines ⋯</div>
              {lines.slice(-2).map((l, j) => (
                <div key={j} className="px-3">
                  {'  '}
                  {l}
                </div>
              ))}
            </div>
          );
        }
        return lines.map((l, j) => (
          <div key={`${i}-${j}`} className={cn('whitespace-pre-wrap px-3', d.added && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300', d.removed && 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300')}>
            {d.added ? '+ ' : d.removed ? '- ' : '  '}
            {l}
          </div>
        ));
      })}
    </pre>
  );
}

// ---- Page settings, quality & tools -------------------------------------------------------------

export function SettingsPanel({ page, canEdit, llm, onChanged, onReplaceMarkdown, onNavigate }: { page: any; canEdit: boolean; llm: boolean; onChanged: () => void; onReplaceMarkdown: (md: string) => void; onNavigate: (pageId: string) => void }) {
  const toast = useToast();
  const [slug, setSlug] = useState(page.slug);
  const [icon, setIcon] = useState(page.icon || '');
  const [linkUrl, setLinkUrl] = useState(page.link_url || '');
  const quality = useQuery({ queryKey: ['quality', page.id, page.version], queryFn: () => api.get(`/pages/${page.id}/quality`) });
  const [review, setReview] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [lang, setLang] = useState('Spanish');
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    setSlug(page.slug);
    setIcon(page.icon || '');
    setLinkUrl(page.link_url || '');
  }, [page.slug, page.icon, page.link_url]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/pages/${page.id}`, body);
      onChanged();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold dark:border-slate-800">Page settings</div>
      <div className="space-y-4 p-4">
        <div className="flex gap-2">
          <Field label="Icon">
            <input className="input w-16 text-center" value={icon} maxLength={4} disabled={!canEdit} onChange={(e) => setIcon(e.target.value)} onBlur={() => icon !== (page.icon || '') && patch({ icon: icon || null })} />
          </Field>
          <div className="flex-1">
            <Field label="URL slug">
              <input className="input font-mono text-xs" value={slug} disabled={!canEdit} onChange={(e) => setSlug(e.target.value)} onBlur={() => slug !== page.slug && patch({ slug })} />
            </Field>
          </div>
        </div>
        <Field label="Page type">
          <select className="input" value={page.kind} disabled={!canEdit} onChange={(e) => patch({ kind: e.target.value })}>
            <option value="doc">Page</option>
            <option value="group">Section group (sidebar heading)</option>
            <option value="link">External link</option>
            <option value="api">API reference page</option>
          </select>
        </Field>
        {page.kind === 'link' && (
          <Field label="Link URL">
            <input className="input" value={linkUrl} disabled={!canEdit} onChange={(e) => setLinkUrl(e.target.value)} onBlur={() => patch({ linkUrl })} placeholder="https://" />
          </Field>
        )}
        <Toggle checked={!!page.hidden} disabled={!canEdit} onChange={(v) => patch({ hidden: v })} label="Hide from navigation" description="Still reachable by URL; excluded from sidebar and search." />

        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Quality check</h4>
            {quality.data && <Badge tone={quality.data.score >= 85 ? 'green' : quality.data.score >= 60 ? 'amber' : 'red'}>{quality.data.score}/100</Badge>}
          </div>
          {quality.data && (
            <>
              <p className="muted mb-2 text-xs">
                {quality.data.words} words · {quality.data.readingMinutes} min read · readability {quality.data.readability}
              </p>
              {!quality.data.issues.length ? (
                <p className="flex items-center gap-1.5 text-sm text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" /> No issues found
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {quality.data.issues.map((i: any, idx: number) => (
                    <li key={idx} className="flex gap-2 text-xs">
                      <AlertCircle className={cn('mt-0.5 h-3.5 w-3.5 flex-none', i.severity === 'error' ? 'text-red-500' : i.severity === 'warning' ? 'text-amber-500' : 'text-slate-400')} />
                      <span>
                        {i.message}
                        {i.excerpt && <span className="muted block truncate italic">“{i.excerpt}”</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button
            className="btn-secondary mt-3 w-full text-xs"
            disabled={!llm || reviewing}
            title={llm ? '' : 'Requires a configured language model'}
            onClick={async () => {
              setReviewing(true);
              try {
                const res = await api.post(`/pages/${page.id}/ai-review`);
                setReview(res.markdown);
              } catch (err) {
                toast((err as ApiError).message, 'error');
              } finally {
                setReviewing(false);
              }
            }}
          >
            {reviewing ? <Spinner /> : <PenLine className="h-3.5 w-3.5" />} Editorial review
          </button>
        </div>

        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h4 className="mb-2 text-sm font-semibold">Translate page</h4>
          <div className="flex gap-2">
            <select className="input py-1.5 text-xs" value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <button
              className="btn-secondary flex-none text-xs"
              disabled={!canEdit || !llm || translating}
              title={llm ? 'Creates a translated copy next to this page' : 'Requires a configured language model'}
              onClick={async () => {
                setTranslating(true);
                try {
                  const res = await api.post(`/pages/${page.id}/translate`, { language: lang });
                  toast(`Translated copy created`);
                  onChanged();
                  onNavigate(res.id);
                } catch (err) {
                  toast((err as ApiError).message, 'error');
                } finally {
                  setTranslating(false);
                }
              }}
            >
              {translating ? <Spinner /> : <Languages className="h-3.5 w-3.5" />} Translate
            </button>
          </div>
        </div>

        <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <h4 className="text-sm font-semibold">Markdown</h4>
          <a className="btn-secondary w-full text-xs" href={`/api/pages/${page.id}/markdown`}>
            <Download className="h-3.5 w-3.5" /> Export as Markdown
          </a>
          {canEdit && (
            <label className="btn-secondary w-full cursor-pointer text-xs">
              <Upload className="h-3.5 w-3.5" /> Replace with Markdown file…
              <input
                type="file"
                accept=".md,.markdown,.mdx,.txt"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) onReplaceMarkdown(await f.text());
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      </div>
      <Modal open={!!review} onClose={() => setReview(null)} title="Editorial review" size="lg">
        <div className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap text-sm leading-6">{review}</div>
      </Modal>
    </div>
  );
}
