import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Puzzle, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { atLeast, cn, timeAgo } from '../lib/utils';
import { EmptyState, PageLoader, Spinner, useConfirm, useToast } from '../components/ui';
import { SimpleEditor } from '../editor/SimpleEditor';

export default function Reusable() {
  const { orgSlug, blockId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ['org', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}`) });
  const list = useQuery({ queryKey: ['reusable-list', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}/reusable`) });
  const canEdit = atLeast(org.data?.role, 'editor');

  useEffect(() => {
    if (!blockId && list.data?.length) navigate(`/o/${orgSlug}/reusable/${list.data[0].id}`, { replace: true });
  }, [blockId, list.data, navigate, orgSlug]);

  const create = async () => {
    const res = await api.post(`/orgs/${orgSlug}/reusable`, { name: 'New reusable block' });
    await qc.invalidateQueries({ queryKey: ['reusable-list', orgSlug] });
    navigate(`/o/${orgSlug}/reusable/${res.id}`);
  };

  if (list.isLoading || org.isLoading) return <PageLoader />;
  return (
    <div className="flex h-full">
      <aside className="flex w-72 flex-none flex-col border-r border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between p-4">
          <div>
            <h1 className="font-semibold">Reusable content</h1>
            <p className="muted text-xs">Write once, insert in any page of {org.data.name}.</p>
          </div>
          {canEdit && (
            <button className="btn-primary p-1.5" onClick={create} title="New block">
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {list.data.map((b: any) => (
            <Link key={b.id} to={`/o/${orgSlug}/reusable/${b.id}`} className={cn('block rounded-md px-3 py-2', b.id === blockId ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-900')}>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Puzzle className="h-3.5 w-3.5 text-slate-400" /> {b.name}
              </div>
              <div className="muted line-clamp-1 pl-5 text-xs">{b.preview || 'Empty'}</div>
            </Link>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {blockId ? (
          <BlockEditor key={blockId} orgSlug={orgSlug!} blockId={blockId} canEdit={canEdit} />
        ) : (
          <EmptyState icon={<Puzzle className="h-6 w-6" />} title="No reusable content yet" description="Reusable blocks are synced snippets (warnings, prerequisites, legal notes…) that update everywhere they're used." action={canEdit && <button className="btn-primary" onClick={create}>Create a block</button>} />
        )}
      </div>
    </div>
  );
}

function BlockEditor({ orgSlug, blockId, canEdit }: { orgSlug: string; blockId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['reusable', orgSlug, blockId], queryFn: () => api.get(`/orgs/${orgSlug}/reusable/${blockId}`) });
  const [name, setName] = useState('');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (data) setName(data.name);
  }, [data]);
  const queue = (patch: Record<string, unknown>) => {
    setSaving('saving');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        await api.patch(`/orgs/${orgSlug}/reusable/${blockId}`, patch);
        setSaving('saved');
        await qc.invalidateQueries({ queryKey: ['reusable-list', orgSlug] });
      } catch (err) {
        toast((err as ApiError).message, 'error');
      }
    }, 800);
  };
  if (isLoading || !data) return <PageLoader />;
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="mb-2 flex items-center gap-3">
        <input className="flex-1 bg-transparent text-[1.75rem] font-semibold tracking-tight outline-none" value={name} readOnly={!canEdit} onChange={(e) => (setName(e.target.value), queue({ name: e.target.value }))} />
        <span className="muted text-xs">{saving === 'saving' ? <Spinner /> : saving === 'saved' ? 'Saved' : `Updated ${timeAgo(data.updated_at)}`}</span>
        {canEdit && (
          <button
            className="btn-ghost p-1.5"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this block?', message: data.usage.length ? `It is used on ${data.usage.length} page(s); those blocks will render empty.` : undefined, danger: true }))) return;
              await api.del(`/orgs/${orgSlug}/reusable/${blockId}`);
              await qc.invalidateQueries({ queryKey: ['reusable-list', orgSlug] });
              navigate(`/o/${orgSlug}/reusable`);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="muted mb-6 text-sm">
        Used on {data.usage.length} published page{data.usage.length === 1 ? '' : 's'}
        {data.usage.length > 0 && `: ${data.usage.map((u: any) => `${u.title} (${u.space_name})`).join(', ')}`}
      </p>
      <SimpleEditor content={data.content} editable={canEdit} orgSlug={orgSlug} onChange={(doc) => queue({ content: doc })} />
    </div>
  );
}
