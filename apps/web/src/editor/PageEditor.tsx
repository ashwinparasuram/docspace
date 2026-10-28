import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent, BubbleMenu, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import {
  Bold,
  Code,
  ExternalLink,
  GitBranch,
  Highlighter,
  History,
  Italic,
  Link2,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Settings2,
  PenLine,
  Strikethrough,
  Underline as UnderlineIcon,
  Wifi,
  WifiOff,
  Copy,
  Trash2,
  Columns,
  Rows,
} from 'lucide-react';
import { api, uploadFiles, ApiError } from '../lib/api';
import { useMe, useMeta } from '../lib/auth';
import { atLeast, cn, colorFor, timeAgo } from '../lib/utils';
import { Avatar, Menu, MenuItem, PageLoader, useConfirm, useToast } from '../components/ui';
import { EditorContext, type EditorCtx } from './context';
import { ApiOperation, Callout, CodeBlock, CommentMark, Embed, Expandable, ImageNode, Mermaid, ReusableBlock, Tab, Tabs } from './nodes';
import { SlashCommand } from './SlashMenu';
import { AiDialog, AI_ACTIONS, type AiRequest } from './AiDialog';
import { Picker, type PickerKind } from './Pickers';
import { CommentsPanel, HistoryPanel, SettingsPanel, type PendingComment } from './Panels';

const MD_HINT = /(^|\n)(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|```|\|.+\|)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/;

interface Props {
  pageId: string;
  orgSlug: string;
  spaceId: string;
  siteUrl: string;
  onCreateChangeRequest: () => void;
}

type Panel = 'comments' | 'history' | 'settings' | null;

export function PageEditor(props: Props) {
  const { data: page, error, refetch } = useQuery({ queryKey: ['page', props.pageId], queryFn: () => api.get(`/pages/${props.pageId}`) });
  if (error) return <div className="p-10 text-center text-sm text-red-600">{(error as ApiError).message}</div>;
  if (!page) return <PageLoader />;
  return <LoadedEditor key={page.id} page={page} refetchPage={refetch} {...props} />;
}

function LoadedEditor({ page, refetchPage, orgSlug, spaceId, siteUrl, onCreateChangeRequest }: Props & { page: any; refetchPage: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const meta = useMeta();
  const user = me.data!.user!;
  const canEdit: boolean = page.canEdit;
  const [panel, setPanel] = useState<Panel>(() => (window.innerWidth > 1280 ? null : null));
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState(page.description || '');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<{ name: string; color: string; id: string }[]>([]);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadKind = useRef<'image' | 'file'>('image');

  // ---- Real-time collaboration (Yjs over WebSocket) --------------------------------------------
  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return new WebsocketProvider(`${proto}://${window.location.host}/collab`, page.id, ydoc, { connect: true, maxBackoffTime: 5000 });
  }, [page.id, ydoc]);

  useEffect(() => {
    const onStatus = ({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) => setStatus(status);
    const onSync = (s: boolean) => s && setSynced(true);
    const onAwareness = () => {
      const list: { name: string; color: string; id: string }[] = [];
      provider.awareness.getStates().forEach((s: any, clientId: number) => {
        if (clientId !== provider.awareness.clientID && s.user) list.push({ name: s.user.name, color: s.user.color, id: s.user.id });
      });
      const seen = new Set<string>();
      setPeers(list.filter((p) => !seen.has(p.id) && seen.add(p.id)));
    };
    provider.on('status', onStatus);
    provider.on('sync', onSync);
    provider.awareness.on('change', onAwareness);
    return () => {
      provider.off('status', onStatus);
      provider.off('sync', onSync);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider, ydoc]);

  const editorRef = useRef<Editor | null>(null);

  const insertMarkdown = useCallback(async (md: string, range?: { from: number; to: number }) => {
    const ed = editorRef.current;
    if (!ed) return;
    const doc = await api.post('/markdown/parse', { markdown: md });
    const content = doc.content || [];
    if (range) ed.chain().focus().insertContentAt(range, content).run();
    else ed.chain().focus().insertContent(content).run();
  }, []);

  const upload = useCallback(
    async (files: File[], at?: number) => {
      const ed = editorRef.current;
      if (!ed || !files.length) return;
      try {
        toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'info');
        const res = await uploadFiles(spaceId, files);
        const nodes = res.map((f) =>
          f.mime.startsWith('image/') && f.mime !== 'image/svg+xml'
            ? { type: 'image', attrs: { src: f.url, alt: f.filename.replace(/\.\w+$/, '') } }
            : { type: 'embed', attrs: { src: f.url, kind: f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? 'audio' : 'file', title: f.filename, size: f.size } },
        );
        if (at !== undefined) ed.chain().focus().insertContentAt(at, nodes).run();
        else ed.chain().focus().insertContent(nodes).run();
      } catch (err) {
        toast((err as ApiError).message, 'error');
      }
    },
    [spaceId, toast],
  );

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        StarterKit.configure({ history: false, codeBlock: false, heading: { levels: [1, 2, 3, 4] }, dropcursor: { color: '#6366f1', width: 2 } }),
        Collaboration.configure({ document: ydoc, field: 'default' }),
        CollaborationCursor.configure({ provider, user: { name: user.name, color: colorFor(user.id), id: user.id } }),
        Placeholder.configure({
          placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : "Type '/' for blocks, or start writing…"),
          includeChildren: false,
        }),
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
        Underline,
        Highlight,
        Subscript,
        Superscript,
        Typography,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        CodeBlock,
        ImageNode,
        Callout,
        Expandable,
        Tabs,
        Tab,
        Mermaid,
        Embed,
        ReusableBlock,
        ApiOperation,
        CommentMark,
        SlashCommand,
      ],
      editorProps: {
        attributes: { class: 'ProseMirror', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files || []);
          if (files.length) {
            event.preventDefault();
            void upload(files);
            return true;
          }
          const text = event.clipboardData?.getData('text/plain') || '';
          const html = event.clipboardData?.getData('text/html') || '';
          if (!html && text.length > 2 && MD_HINT.test(text) && !view.state.selection.$from.parent.type.spec.code) {
            event.preventDefault();
            void insertMarkdown(text, { from: view.state.selection.from, to: view.state.selection.to });
            return true;
          }
          return false;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files || []);
          if (moved || !files.length) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void upload(files, pos);
          return true;
        },
        handleClickOn: (_view, _pos, _node, _nodePos, event) => {
          const el = (event.target as HTMLElement).closest('[data-comment-id]');
          if (el) {
            setActiveThread(el.getAttribute('data-comment-id'));
            setPanel('comments');
          }
          return false;
        },
      },
    },
    [provider],
  );
  editorRef.current = editor;

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Window events dispatched by slash commands.
  useEffect(() => {
    const onPicker = (e: Event) => {
      const kind = (e as CustomEvent).detail as string;
      if (kind === 'ai-prompt') setAiRequest({ action: 'generate', text: '', hasSelection: false, context: editor?.getText().slice(0, 4000) });
      else setPicker(kind as PickerKind);
    };
    const onUpload = (e: Event) => {
      uploadKind.current = (e as CustomEvent).detail;
      if (fileInput.current) {
        fileInput.current.accept = uploadKind.current === 'image' ? 'image/*' : '';
        fileInput.current.click();
      }
    };
    const onContinue = () => {
      if (!editor) return;
      const before = editor.state.doc.textBetween(Math.max(0, editor.state.selection.from - 3000), editor.state.selection.from, '\n');
      setAiRequest({ action: 'continue', text: before, hasSelection: false });
    };
    window.addEventListener('ds:picker', onPicker);
    window.addEventListener('ds:upload', onUpload);
    window.addEventListener('ds:ai-continue', onContinue);
    return () => {
      window.removeEventListener('ds:picker', onPicker);
      window.removeEventListener('ds:upload', onUpload);
      window.removeEventListener('ds:ai-continue', onContinue);
    };
  }, [editor]);

  // ---- Title / description (saved via REST, debounced) -------------------------------------------
  const saveMeta = useRef<number | null>(null);
  const queueMeta = (patch: Record<string, unknown>) => {
    if (saveMeta.current) window.clearTimeout(saveMeta.current);
    saveMeta.current = window.setTimeout(async () => {
      try {
        await api.patch(`/pages/${page.id}`, patch);
        await qc.invalidateQueries({ queryKey: ['tree'] });
      } catch (err) {
        toast((err as ApiError).message, 'error');
      }
    }, 600);
  };

  const selectionText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, '\n');
  };

  const selectionMarkdown = async () => {
    if (!editor) return '';
    const slice = editor.state.selection.content();
    try {
      const res = await api.post('/markdown/serialize', { content: { type: 'doc', content: slice.content.toJSON() || [] } });
      return res.markdown as string;
    } catch {
      return selectionText();
    }
  };

  const startAi = async (action: string) => {
    if (!editor) return;
    const hasSelection = !editor.state.selection.empty;
    const text = hasSelection ? await selectionMarkdown() : editor.getText();
    setAiRequest({ action, text, hasSelection, context: editor.getText().slice(0, 4000) });
  };

  const applyAi = async (markdown: string, mode: 'replace' | 'insert') => {
    const ed = editorRef.current;
    if (!ed) return;
    setAiRequest(null);
    if (!canEdit) {
      void navigator.clipboard.writeText(markdown);
      toast('Copied to clipboard (this page is read-only)', 'info');
      return;
    }
    const { from, to } = ed.state.selection;
    if (mode === 'replace' && from !== to) await insertMarkdown(markdown, { from, to });
    else await insertMarkdown(markdown, { from: to, to });
  };

  const startComment = () => {
    if (!editor) return;
    const quote = selectionText();
    const threadId = crypto.randomUUID();
    if (canEdit && quote) editor.chain().focus().setMark('comment', { threadId }).run();
    setPendingComment({ threadId, quote: quote.slice(0, 500) });
    setActiveThread(threadId);
    setPanel('comments');
  };

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (leave empty to remove). Tip: use /Link to page to link internal pages.', prev || 'https://');
    if (url === null) return;
    if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const onPick = (kind: PickerKind, value: any) => {
    setPicker(null);
    if (!editor) return;
    const chain = editor.chain().focus();
    if (kind === 'reusable') chain.insertContent({ type: 'reusableBlock', attrs: { blockId: value.id } }).run();
    if (kind === 'api') chain.insertContent({ type: 'apiOperation', attrs: value }).run();
    if (kind === 'embed-url') chain.insertContent({ type: 'embed', attrs: { src: value.src, kind: value.kind, title: value.src } }).run();
    if (kind === 'page-link') {
      const href = `page://${value.stableId}`;
      if (editor.state.selection.empty) chain.insertContent({ type: 'text', text: value.title, marks: [{ type: 'link', attrs: { href } }] }).insertContent(' ').run();
      else chain.setLink({ href }).run();
    }
  };

  const ctx: EditorCtx = {
    spaceId,
    orgSlug,
    branchId: page.branch.id,
    pageId: page.id,
    canEdit,
    openPicker: (k) => (k === 'ai-prompt' ? setAiRequest({ action: 'generate', text: '', hasSelection: false }) : setPicker(k as PickerKind)),
    requestUpload: (k) => {
      uploadKind.current = k;
      fileInput.current?.click();
    },
    activeThread,
    setActiveThread,
  };

  const deletePage = async () => {
    if (!(await confirm({ title: `Delete "${page.title}"?`, message: 'Child pages are deleted too. On the main branch this cannot be undone except through version history of a branch.', danger: true, confirmLabel: 'Delete page' }))) return;
    await api.del(`/pages/${page.id}`);
    await qc.invalidateQueries({ queryKey: ['tree'] });
    navigate(`/o/${orgSlug}/s/${spaceId}/b/${page.branch.id}`);
  };

  const duplicate = async () => {
    const res = await api.post(`/pages/${page.id}/duplicate`);
    await qc.invalidateQueries({ queryKey: ['tree'] });
    navigate(`/o/${orgSlug}/s/${spaceId}/b/${page.branch.id}/p/${res.id}`);
  };

  const publishedUrl = page.branch.is_main && page.kind !== 'group' ? `${siteUrl}` : null;

  return (
    <EditorContext.Provider value={ctx}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Page toolbar */}
          <div className="flex h-11 flex-none items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
            <div className="muted flex min-w-0 items-center gap-1.5 text-xs">
              {!page.branch.is_main && (
                <span className="flex items-center gap-1 rounded border border-slate-200 px-1.5 py-px font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300">
                  <GitBranch className="h-3 w-3" /> {page.branch.name}
                </span>
              )}
              <span className="truncate">
                {page.updatedBy ? `Edited by ${page.updatedBy.name} ` : 'Edited '}
                {timeAgo(page.updated_at)}
              </span>
            </div>
            <div className="flex-1" />
            <div className="flex -space-x-1.5">
              {peers.slice(0, 5).map((p) => (
                <span key={p.id} className="rounded-full ring-2 ring-white dark:ring-slate-950" title={`${p.name} is here`}>
                  <Avatar name={p.name} id={p.id} size={24} />
                </span>
              ))}
            </div>
            <span className={cn('flex items-center gap-1.5 text-xs', status === 'connected' ? 'text-slate-500' : 'text-amber-600')} title={`Real-time sync: ${status}`}>
              {status === 'connected' ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : <WifiOff className="h-3.5 w-3.5" />}
              <span className="hidden lg:inline">{status === 'connected' ? (canEdit ? 'Saved' : 'Read only') : status === 'connecting' ? 'Connecting' : 'Offline'}</span>
            </span>
            <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-800" />
            <button className={cn('btn-ghost p-1.5', panel === 'comments' && 'bg-slate-100 dark:bg-slate-800')} onClick={() => setPanel(panel === 'comments' ? null : 'comments')} title="Comments">
              <MessageSquare className="h-4 w-4" />
            </button>
            <button className={cn('btn-ghost p-1.5', panel === 'history' && 'bg-slate-100 dark:bg-slate-800')} onClick={() => setPanel(panel === 'history' ? null : 'history')} title="Version history">
              <History className="h-4 w-4" />
            </button>
            <button className={cn('btn-ghost p-1.5', panel === 'settings' && 'bg-slate-100 dark:bg-slate-800')} onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title="Page settings & quality">
              <Settings2 className="h-4 w-4" />
            </button>
            <Menu
              align="right"
              trigger={() => (
                <button className="btn-ghost p-1.5" title="Writing assistant">
                  <PenLine className="h-4 w-4" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem disabled={!canEdit} onClick={() => (close(), setAiRequest({ action: 'generate', text: '', hasSelection: false, context: editor?.getText().slice(0, 4000) }))}>
                    Draft with assistant…
                  </MenuItem>
                  <MenuItem onClick={() => (close(), void startAi('summarize'))}>Summarize page</MenuItem>
                  <MenuItem onClick={() => (close(), void startAi('improve'))}>Improve page</MenuItem>
                  <MenuItem onClick={() => (close(), void startAi('fix'))}>Fix spelling & grammar</MenuItem>
                  <MenuItem onClick={() => (close(), void startAi('translate'))}>Translate…</MenuItem>
                </>
              )}
            </Menu>
            <Menu
              align="right"
              trigger={() => (
                <button className="btn-ghost p-1.5" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {publishedUrl && (
                    <MenuItem icon={<ExternalLink className="h-4 w-4" />} onClick={() => (close(), window.open(publishedUrl, '_blank'))}>
                      Open published site
                    </MenuItem>
                  )}
                  <MenuItem icon={<Copy className="h-4 w-4" />} disabled={!canEdit} onClick={() => (close(), void duplicate())}>
                    Duplicate page
                  </MenuItem>
                  <MenuItem icon={<Trash2 className="h-4 w-4" />} danger disabled={!canEdit} onClick={() => (close(), void deletePage())}>
                    Delete page
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>

          {!canEdit && (
            <div className="flex flex-wrap items-center justify-center gap-2 bg-slate-50 px-4 py-2 text-sm dark:bg-slate-900">
              <Lock className="h-3.5 w-3.5 text-slate-400" />
              {page.branch.is_main && atLeast(page.role, 'editor') ? (
                <>
                  <span>The main branch is protected — changes go through change requests.</span>
                  <button className="btn-primary px-2.5 py-1 text-xs" onClick={onCreateChangeRequest}>
                    <GitBranch className="h-3.5 w-3.5" /> New change request
                  </button>
                </>
              ) : (
                <span>You have {page.role} access — this page is read-only{atLeast(page.role, 'commenter') ? ', but you can comment' : ''}.</span>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[760px] px-6 pb-10 pt-14 lg:px-12">
              <div className="mb-1 flex items-center gap-3">
                {page.icon && <span className="text-3xl">{page.icon}</span>}
                <textarea
                  rows={1}
                  className="w-full resize-none overflow-hidden bg-transparent text-[2rem] font-semibold leading-tight tracking-tight text-slate-900 outline-none placeholder:text-slate-300 dark:text-white dark:placeholder:text-slate-700"
                  value={title}
                  readOnly={!canEdit}
                  placeholder="Untitled"
                  onChange={(e) => {
                    setTitle(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = e.target.scrollHeight + 'px';
                    if (e.target.value.trim()) queueMeta({ title: e.target.value.trim() });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      editor?.commands.focus('start');
                    }
                  }}
                />
              </div>
              <input
                className="mb-8 mt-2 w-full bg-transparent text-[16px] text-slate-500 outline-none placeholder:text-slate-300 dark:text-slate-400 dark:placeholder:text-slate-600"
                value={description}
                readOnly={!canEdit}
                placeholder={canEdit ? 'Add a page description…' : ''}
                onChange={(e) => {
                  setDescription(e.target.value);
                  queueMeta({ description: e.target.value || null });
                }}
              />
              {page.kind === 'group' && <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-900">This is a section group: it appears as a heading in the published sidebar. Its child pages hold the content.</p>}
              <div className={cn('ds-editor relative', !synced && 'opacity-60')}>
                {!synced && status !== 'disconnected' && <div className="muted absolute -top-6 right-0 text-xs">Syncing…</div>}
                {editor && (
                  <BubbleMenu editor={editor} tippyOptions={{ duration: 100, maxWidth: 'none' }} shouldShow={({ editor: ed, state }) => !state.selection.empty && !ed.isActive('codeBlock') && !ed.isActive('image') && !ed.isActive('mermaid')}>
                    <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-1 shadow-pop dark:border-slate-700 dark:bg-slate-900">
                      {canEdit && (
                        <>
                          <ToolbarBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)">
                            <Bold className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)">
                            <Italic className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (Ctrl+U)">
                            <UnderlineIcon className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
                            <Strikethrough className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code">
                            <Code className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} title="Highlight">
                            <Highlighter className="h-4 w-4" />
                          </ToolbarBtn>
                          <ToolbarBtn active={editor.isActive('link')} onClick={setLink} title="Link">
                            <Link2 className="h-4 w-4" />
                          </ToolbarBtn>
                          {editor.isActive('table') && (
                            <>
                              <div className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-slate-700" />
                              <ToolbarBtn onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column">
                                <Columns className="h-4 w-4" />
                              </ToolbarBtn>
                              <ToolbarBtn onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row">
                                <Rows className="h-4 w-4" />
                              </ToolbarBtn>
                              <ToolbarBtn onClick={() => editor.chain().focus().deleteTable().run()} title="Delete table">
                                <Trash2 className="h-4 w-4" />
                              </ToolbarBtn>
                            </>
                          )}
                          <div className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-slate-700" />
                        </>
                      )}
                      {atLeast(page.role, 'commenter') && (
                        <ToolbarBtn onClick={startComment} title="Comment">
                          <MessageSquarePlus className="h-4 w-4" />
                        </ToolbarBtn>
                      )}
                      <Menu
                        trigger={() => (
                          <button className="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
                            <PenLine className="h-3.5 w-3.5" /> Assist
                          </button>
                        )}
                      >
                        {(close) =>
                          AI_ACTIONS.map((a) => (
                            <MenuItem key={a.id} onClick={() => (close(), void startAi(a.id))}>
                              {a.label}
                            </MenuItem>
                          ))
                        }
                      </Menu>
                    </div>
                  </BubbleMenu>
                )}
                <EditorContent editor={editor} />
              </div>
            </div>
          </div>
        </div>

        {panel && (
          <aside className="w-80 flex-none border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            {panel === 'comments' && (
              <CommentsPanel
                spaceId={spaceId}
                pageStableId={page.stable_id}
                branchId={page.branch.id}
                editor={editor}
                role={page.role}
                canEdit={canEdit}
                pending={pendingComment}
                clearPending={() => {
                  if (pendingComment && editor && canEdit) {
                    // Drop the provisional anchor if the comment was never posted.
                    void api.get(`/spaces/${spaceId}/comments?pageStableId=${page.stable_id}`).then((threads: any[]) => {
                      if (!threads.some((t) => t.thread_id === pendingComment.threadId)) {
                        import('./Panels').then((m) => m.removeThreadMark(editor, pendingComment.threadId));
                      }
                    });
                  }
                  setPendingComment(null);
                }}
                activeThread={activeThread}
                setActiveThread={setActiveThread}
              />
            )}
            {panel === 'history' && (
              <HistoryPanel
                pageId={page.id}
                canEdit={canEdit}
                onRestored={() => {
                  refetchPage();
                  void qc.invalidateQueries({ queryKey: ['tree'] });
                }}
              />
            )}
            {panel === 'settings' && (
              <SettingsPanel
                page={page}
                canEdit={canEdit}
                llm={!!meta.data?.ai.llm}
                onChanged={() => {
                  refetchPage();
                  void qc.invalidateQueries({ queryKey: ['tree'] });
                }}
                onReplaceMarkdown={async (md) => {
                  if (!(await confirm({ title: 'Replace page content?', message: 'The current content is kept in version history.', confirmLabel: 'Replace' }))) return;
                  await api.put(`/pages/${page.id}/content`, { markdown: md, message: 'Imported Markdown' });
                  toast('Content replaced');
                }}
                onNavigate={(id) => navigate(`/o/${orgSlug}/s/${spaceId}/b/${page.branch.id}/p/${id}`)}
              />
            )}
          </aside>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          void upload(files);
        }}
      />
      <Picker kind={picker} onClose={() => setPicker(null)} orgSlug={orgSlug} spaceId={spaceId} branchId={page.branch.id} onPick={onPick} />
      <AiDialog request={aiRequest} onClose={() => setAiRequest(null)} onApply={applyAi} llm={!!meta.data?.ai.llm} />
    </EditorContext.Provider>
  );
}

function ToolbarBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick: () => void; active?: boolean; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn('rounded p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800', active && 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white')}
    >
      {children}
    </button>
  );
}
