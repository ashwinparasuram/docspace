import { useEffect, useMemo, useRef, useState } from 'react';
import { Mark, Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { createLowlight, common } from 'lowlight';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Copy, FileText, Info, Plus, Puzzle, Trash2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatBytes } from '../lib/utils';
import { useEditorCtx } from './context';

export const lowlight = createLowlight(common);
export const LANGUAGES = ['plaintext', ...lowlight.listLanguages().filter((l) => l !== 'plaintext').sort()];

// ---- Code block with language picker -----------------------------------------------------------

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  return (
    <NodeViewWrapper className="my-4 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100/70 px-3 py-1 dark:border-slate-800 dark:bg-slate-900" contentEditable={false}>
        <select
          className="bg-transparent font-mono text-xs text-slate-500 outline-none"
          value={node.attrs.language || 'plaintext'}
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value === 'plaintext' ? null : e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
          onClick={() => {
            void navigator.clipboard.writeText(node.textContent);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!my-0 !rounded-none">
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: null });

// ---- Image with alt text editing ------------------------------------------------------------

function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-4 text-center" data-drag-handle>
      <img src={node.attrs.src} alt={node.attrs.alt || ''} className={cn('mx-auto max-w-full rounded-lg border border-slate-200 dark:border-slate-800', selected && 'ring-2 ring-brand-500')} />
      {(selected || node.attrs.title) && (
        <div className="mx-auto mt-1.5 flex max-w-md gap-2" contentEditable={false}>
          {editor.isEditable && selected ? (
            <>
              <input className="input py-1 text-xs" placeholder="Alt text (accessibility)" value={node.attrs.alt || ''} onChange={(e) => updateAttributes({ alt: e.target.value })} />
              <input className="input py-1 text-xs" placeholder="Caption" value={node.attrs.title || ''} onChange={(e) => updateAttributes({ title: e.target.value })} />
            </>
          ) : (
            <p className="muted w-full text-center text-sm">{node.attrs.title}</p>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const ImageNode = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
}).configure({ inline: false, allowBase64: false });

// ---- Callout (hint) ------------------------------------------------------------------------

const CALLOUTS = {
  info: { icon: Info, cls: 'border-sky-200 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-500/10', iconCls: 'text-sky-600' },
  success: { icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10', iconCls: 'text-emerald-600' },
  warning: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10', iconCls: 'text-amber-600' },
  danger: { icon: XCircle, cls: 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10', iconCls: 'text-red-600' },
} as const;

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const type = (node.attrs.type as keyof typeof CALLOUTS) in CALLOUTS ? (node.attrs.type as keyof typeof CALLOUTS) : 'info';
  const c = CALLOUTS[type];
  const order = Object.keys(CALLOUTS) as (keyof typeof CALLOUTS)[];
  return (
    <NodeViewWrapper className={cn('my-4 flex gap-3 rounded-lg border px-4 py-3', c.cls)}>
      <button
        contentEditable={false}
        className={cn('mt-1 h-5 flex-none', c.iconCls)}
        title="Change callout style"
        disabled={!editor.isEditable}
        onClick={() => updateAttributes({ type: order[(order.indexOf(type) + 1) % order.length] })}
      >
        <c.icon className="h-5 w-5" />
      </button>
      <NodeViewContent className="min-w-0 flex-1 [&>*:first-child]:mt-0" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: { default: 'info', parseHTML: (el) => el.getAttribute('data-callout') || 'info', renderHTML: (a) => ({ 'data-callout': a.type }) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

// ---- Expandable (details) ---------------------------------------------------------------------

function ExpandableView({ node, updateAttributes, editor }: NodeViewProps) {
  const [open, setOpen] = useState(true);
  return (
    <NodeViewWrapper className="my-4 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 px-3 py-2" contentEditable={false}>
        <button onClick={() => setOpen(!open)} className="text-slate-400">
          <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        </button>
        <input
          className="flex-1 bg-transparent font-semibold outline-none"
          value={node.attrs.title}
          placeholder="Expandable title"
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ title: e.target.value })}
        />
      </div>
      <NodeViewContent className={cn('px-4 pb-3 pl-9', !open && 'hidden')} />
    </NodeViewWrapper>
  );
}

export const Expandable = Node.create({
  name: 'expandable',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { title: { default: 'Details' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="expandable"]', getAttrs: (el) => ({ title: (el as HTMLElement).getAttribute('data-title') }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'expandable', 'data-title': node.attrs.title }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExpandableView);
  },
});

// ---- Tabs -------------------------------------------------------------------------------------

function TabsView({ editor, getPos, node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-4 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-900" contentEditable={false}>
        Tabs
        {editor.isEditable && (
          <button
            className="flex items-center gap-1 normal-case text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
            onClick={() => {
              const pos = (getPos() as number) + node.nodeSize - 1;
              editor.chain().insertContentAt(pos, { type: 'tab', attrs: { title: `Tab ${node.childCount + 1}` }, content: [{ type: 'paragraph' }] }).run();
            }}
          >
            <Plus className="h-3 w-3" /> Add tab
          </button>
        )}
      </div>
      <NodeViewContent className="divide-y divide-slate-200 dark:divide-slate-700" />
    </NodeViewWrapper>
  );
}

function TabView({ node, updateAttributes, editor, deleteNode }: NodeViewProps) {
  return (
    <NodeViewWrapper className="px-4 py-2">
      <div className="mb-1 flex items-center gap-2" contentEditable={false}>
        <input className="flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none dark:text-white" value={node.attrs.title} readOnly={!editor.isEditable} onChange={(e) => updateAttributes({ title: e.target.value })} />
        {editor.isEditable && (
          <button className="text-slate-400 hover:text-red-500" onClick={() => deleteNode()} title="Remove tab">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tab+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-type="tabs"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tabs' }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TabsView);
  },
});

export const Tab = Node.create({
  name: 'tab',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { title: { default: 'Tab' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="tab"]', getAttrs: (el) => ({ title: (el as HTMLElement).getAttribute('data-title') }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tab', 'data-title': node.attrs.title }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TabView);
  },
});

// ---- Mermaid diagram -----------------------------------------------------------------------------

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}
let mermaidCounter = 0;

function MermaidView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!node.attrs.code);
  const id = useMemo(() => `mmd-${++mermaidCounter}`, []);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const code = String(node.attrs.code || '').trim();
      if (!code) return setSvg('');
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default', securityLevel: 'strict' });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message?.split('\n')[0] || 'Invalid diagram');
        document.getElementById('d' + id)?.remove();
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [node.attrs.code, id]);
  return (
    <NodeViewWrapper className={cn('my-4 rounded-lg border border-slate-200 dark:border-slate-700', selected && 'ring-2 ring-brand-500')}>
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-900" contentEditable={false}>
        <span>Mermaid diagram</span>
        {editor.isEditable && (
          <button className="font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white" onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      <div contentEditable={false}>
        {editing && editor.isEditable && (
          <textarea
            className="block min-h-[140px] w-full resize-y border-b border-slate-200 bg-white p-3 font-mono text-sm outline-none dark:border-slate-700 dark:bg-slate-950"
            value={node.attrs.code}
            placeholder={'flowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]'}
            onChange={(e) => updateAttributes({ code: e.target.value })}
            spellCheck={false}
          />
        )}
        <div className="overflow-x-auto p-4 text-center">
          {error ? <p className="font-mono text-xs text-red-600">{error}</p> : svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="muted text-sm">Empty diagram</p>}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { code: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="mermaid"]', getAttrs: (el) => ({ code: (el as HTMLElement).getAttribute('data-code') || '' }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mermaid', 'data-code': node.attrs.code })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidView);
  },
});

// ---- Embedded media / file ---------------------------------------------------------------------

function EmbedView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const { src, kind, title, size } = node.attrs;
  return (
    <NodeViewWrapper className={cn('my-4', selected && 'rounded-lg ring-2 ring-brand-500')} data-drag-handle>
      <div contentEditable={false}>
        {kind === 'video' && <video src={src} controls className="w-full rounded-lg" />}
        {kind === 'audio' && <audio src={src} controls className="w-full" />}
        {kind === 'iframe' && <iframe src={src} title={title || 'Embed'} className="aspect-video w-full rounded-lg border border-slate-200 dark:border-slate-700" sandbox="allow-scripts allow-same-origin allow-popups" />}
        {kind === 'file' && (
          <a href={src} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 hover:border-brand-400 dark:border-slate-700">
            <FileText className="h-5 w-5 text-slate-400" />
            <span>
              <span className="block text-sm font-medium">{title || 'File'}</span>
              {size ? <span className="muted text-xs">{formatBytes(Number(size))}</span> : null}
            </span>
          </a>
        )}
        {selected && editor.isEditable && (
          <input className="input mt-1.5 py-1 text-xs" placeholder="Title" value={title || ''} onChange={(e) => updateAttributes({ title: e.target.value })} />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: '' }, kind: { default: 'file' }, title: { default: null }, size: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="embed"]', getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-src'), kind: (el as HTMLElement).getAttribute('data-kind') }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'embed', 'data-src': node.attrs.src, 'data-kind': node.attrs.kind })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

// ---- Reusable content reference ------------------------------------------------------------------

function ReusableView({ node, selected }: NodeViewProps) {
  const { orgSlug } = useEditorCtx();
  const { data, error } = useQuery({ queryKey: ['reusable', orgSlug, node.attrs.blockId], queryFn: () => api.get(`/orgs/${orgSlug}/reusable/${node.attrs.blockId}`), staleTime: 30_000 });
  return (
    <NodeViewWrapper className={cn('my-4 rounded-md border border-dashed border-slate-300 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/40', selected && 'ring-2 ring-brand-500')} data-drag-handle>
      <div contentEditable={false} className="px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Puzzle className="h-3.5 w-3.5" /> Synced block · {data?.name || (error ? 'missing block' : '…')}
          {data && (
            <a className="ml-auto underline" href={`/o/${orgSlug}/reusable/${node.attrs.blockId}`} target="_blank" rel="noreferrer">
              Edit source
            </a>
          )}
        </div>
        <p className="line-clamp-4 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{data?.content_text || (error ? 'This reusable block was deleted.' : '')}</p>
      </div>
    </NodeViewWrapper>
  );
}

export const ReusableBlock = Node.create({
  name: 'reusableBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { blockId: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="reusable"]', getAttrs: (el) => ({ blockId: (el as HTMLElement).getAttribute('data-block-id') }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'reusable', 'data-block-id': node.attrs.blockId })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ReusableView);
  },
});

// ---- OpenAPI operation -----------------------------------------------------------------------------

export const METHOD_COLORS: Record<string, string> = {
  get: 'bg-emerald-600',
  post: 'bg-blue-600',
  put: 'bg-amber-600',
  patch: 'bg-purple-600',
  delete: 'bg-red-600',
  head: 'bg-slate-500',
  options: 'bg-slate-500',
};

function ApiOperationView({ node, selected }: NodeViewProps) {
  const { spaceId } = useEditorCtx();
  const { data } = useQuery({ queryKey: ['openapi', spaceId], queryFn: () => api.get(`/spaces/${spaceId}/openapi`), staleTime: 60_000 });
  const spec = data?.find((s: any) => s.id === node.attrs.specId);
  const op = spec?.operations.find((o: any) => o.method === node.attrs.method && o.path === node.attrs.path);
  return (
    <NodeViewWrapper className={cn('my-4 rounded-lg border border-slate-200 dark:border-slate-700', selected && 'ring-2 ring-brand-500')} data-drag-handle>
      <div contentEditable={false} className="flex items-center gap-2 px-4 py-3">
        <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-white', METHOD_COLORS[node.attrs.method] || 'bg-slate-500')}>{node.attrs.method}</span>
        <code className="font-mono text-sm">{node.attrs.path}</code>
        <span className="muted ml-auto truncate text-xs">{op?.summary || (data && !op ? 'Operation not found in spec' : '')}</span>
      </div>
      <div contentEditable={false} className="muted border-t border-slate-200 px-4 py-1.5 text-xs dark:border-slate-700">
        API reference block · {spec?.name || 'spec'} — rendered with parameters, schemas and a live “Try it” playground on the published site.
      </div>
    </NodeViewWrapper>
  );
}

export const ApiOperation = Node.create({
  name: 'apiOperation',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { specId: { default: null }, method: { default: 'get' }, path: { default: '/' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="api-operation"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'api-operation' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ApiOperationView);
  },
});

// ---- Inline comment anchors ------------------------------------------------------------------------

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() {
    return { threadId: { default: null, parseHTML: (el) => el.getAttribute('data-comment-id'), renderHTML: (a) => ({ 'data-comment-id': a.threadId }) } };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-highlight' }), 0];
  },
});

/** Small hook to keep a stable ref to the latest value (used by suggestion renderers). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
