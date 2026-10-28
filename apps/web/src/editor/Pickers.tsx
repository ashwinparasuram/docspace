import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Braces, FileText, Puzzle, Search } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { EmptyState, Modal, Spinner } from '../components/ui';
import { METHOD_COLORS } from './nodes';

export type PickerKind = 'reusable' | 'api' | 'page-link' | 'embed-url';

export function Picker({
  kind,
  onClose,
  orgSlug,
  spaceId,
  branchId,
  onPick,
}: {
  kind: PickerKind | null;
  onClose: () => void;
  orgSlug: string;
  spaceId: string;
  branchId: string;
  onPick: (kind: PickerKind, value: any) => void;
}) {
  const [q, setQ] = useState('');
  const [url, setUrl] = useState('');
  const [embedKind, setEmbedKind] = useState('iframe');
  const reusable = useQuery({ queryKey: ['reusable-list', orgSlug], queryFn: () => api.get(`/orgs/${orgSlug}/reusable`), enabled: kind === 'reusable' });
  const specs = useQuery({ queryKey: ['openapi', spaceId], queryFn: () => api.get(`/spaces/${spaceId}/openapi`), enabled: kind === 'api' });
  const pages = useQuery({ queryKey: ['tree', spaceId, branchId], queryFn: () => api.get(`/spaces/${spaceId}/branches/${branchId}/tree`), enabled: kind === 'page-link' });
  const flat: any[] = [];
  const walk = (nodes: any[], depth: number) => nodes.forEach((n) => (flat.push({ ...n, depth }), walk(n.children, depth + 1)));
  if (pages.data) walk(pages.data.pages, 0);
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  const titles: Record<PickerKind, string> = { reusable: 'Insert reusable content', api: 'Insert API operation', 'page-link': 'Link to a page', 'embed-url': 'Embed a URL' };

  return (
    <Modal open={!!kind} onClose={onClose} title={kind ? titles[kind] : ''} size="md">
      {kind === 'embed-url' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url) onPick('embed-url', { src: url, kind: embedKind });
          }}
        >
          <input className="input" autoFocus placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <select className="input" value={embedKind} onChange={(e) => setEmbedKind(e.target.value)}>
            <option value="iframe">Web page (iframe)</option>
            <option value="video">Video file</option>
            <option value="audio">Audio file</option>
            <option value="file">File download link</option>
          </select>
          <p className="muted text-xs">Embeds load directly from the given URL in readers' browsers. Upload files instead to keep everything self-hosted.</p>
          <button className="btn-primary w-full">Embed</button>
        </form>
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {kind === 'reusable' &&
              (reusable.isLoading ? (
                <Spinner />
              ) : !reusable.data?.length ? (
                <EmptyState icon={<Puzzle className="h-5 w-5" />} title="No reusable content yet" description={<a className="text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-slate-100 dark:decoration-slate-600" href={`/o/${orgSlug}/reusable`}>Create a reusable block</a>} />
              ) : (
                reusable.data
                  .filter((b: any) => match(b.name))
                  .map((b: any) => (
                    <button key={b.id} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => onPick('reusable', b)}>
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Puzzle className="h-4 w-4 text-slate-400" /> {b.name}
                      </div>
                      <div className="muted line-clamp-1 pl-6 text-xs">{b.preview}</div>
                    </button>
                  ))
              ))}
            {kind === 'api' &&
              (specs.isLoading ? (
                <Spinner />
              ) : !specs.data?.length ? (
                <EmptyState icon={<Braces className="h-5 w-5" />} title="No OpenAPI specs" description="Import a spec in Space settings → OpenAPI." />
              ) : (
                specs.data.map((s: any) => (
                  <div key={s.id} className="mb-3">
                    <div className="muted px-3 pb-1 text-xs font-semibold uppercase">{s.name}</div>
                    {s.operations
                      .filter((o: any) => match(`${o.method} ${o.path} ${o.summary || ''}`))
                      .map((o: any) => (
                        <button key={o.method + o.path} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => onPick('api', { specId: s.id, method: o.method, path: o.path })}>
                          <span className={cn('w-14 rounded px-1 py-0.5 text-center font-mono text-[10px] font-bold uppercase text-white', METHOD_COLORS[o.method])}>{o.method}</span>
                          <code className="text-xs">{o.path}</code>
                          <span className="muted ml-auto truncate text-xs">{o.summary}</span>
                        </button>
                      ))}
                  </div>
                ))
              ))}
            {kind === 'page-link' &&
              (pages.isLoading ? (
                <Spinner />
              ) : (
                flat
                  .filter((p) => match(p.title))
                  .map((p) => (
                    <button key={p.stableId} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" style={{ paddingLeft: 12 + (q ? 0 : p.depth * 16) }} onClick={() => onPick('page-link', p)}>
                      {p.icon ? <span>{p.icon}</span> : <FileText className="h-4 w-4 text-slate-400" />} {p.title}
                    </button>
                  ))
              ))}
          </div>
        </>
      )}
    </Modal>
  );
}
