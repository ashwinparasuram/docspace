import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  ChevronRightSquare,
  Code2,
  FileUp,
  Frame,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  Link2,
  List,
  ListOrdered,
  Minus,
  Network,
  Puzzle,
  Quote,
  PenLine,
  Table as TableIcon,
  Text,
  XCircle,
  PanelTop,
  Braces,
} from 'lucide-react';
import { cn } from '../lib/utils';

export interface SlashItem {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  group: string;
  run: (editor: Editor, range: Range) => void;
}

/** Window events let slash commands open React modals owned by the page editor. */
const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

export const SLASH_ITEMS: SlashItem[] = [
  { group: 'Basic', title: 'Text', description: 'Plain paragraph', icon: Text, keywords: 'paragraph p', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { group: 'Basic', title: 'Heading 1', description: 'Large section heading', icon: Heading1, keywords: 'h1 title', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { group: 'Basic', title: 'Heading 2', description: 'Medium section heading', icon: Heading2, keywords: 'h2 subtitle', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { group: 'Basic', title: 'Heading 3', description: 'Small section heading', icon: Heading3, keywords: 'h3', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { group: 'Basic', title: 'Bulleted list', description: 'Simple bullet list', icon: List, keywords: 'ul unordered', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { group: 'Basic', title: 'Numbered list', description: 'Ordered list', icon: ListOrdered, keywords: 'ol ordered', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { group: 'Basic', title: 'Task list', description: 'Checklist with checkboxes', icon: CheckSquare, keywords: 'todo checkbox', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { group: 'Basic', title: 'Quote', description: 'Block quotation', icon: Quote, keywords: 'blockquote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { group: 'Basic', title: 'Divider', description: 'Horizontal rule', icon: Minus, keywords: 'hr separator', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { group: 'Blocks', title: 'Code block', description: 'Syntax-highlighted code', icon: Code2, keywords: 'snippet pre', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  {
    group: 'Blocks',
    title: 'Table',
    description: '3×3 table with header row',
    icon: TableIcon,
    keywords: 'grid',
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  ...(['info', 'success', 'warning', 'danger'] as const).map((type) => ({
    group: 'Blocks',
    title: `${type[0].toUpperCase()}${type.slice(1)} callout`,
    description: { info: 'Highlight a note', success: 'Tip or success message', warning: 'Warn readers', danger: 'Critical warning' }[type],
    icon: { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }[type],
    keywords: 'hint alert note admonition',
    run: (e: Editor, r: Range) => e.chain().focus().deleteRange(r).insertContent({ type: 'callout', attrs: { type }, content: [{ type: 'paragraph' }] }).run(),
  })),
  {
    group: 'Blocks',
    title: 'Expandable',
    description: 'Collapsible section',
    icon: ChevronRightSquare,
    keywords: 'details accordion toggle collapse',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'expandable', attrs: { title: 'Click to expand' }, content: [{ type: 'paragraph' }] }).run(),
  },
  {
    group: 'Blocks',
    title: 'Tabs',
    description: 'Tabbed content (e.g. per language)',
    icon: PanelTop,
    keywords: 'tab group',
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertContent({
          type: 'tabs',
          content: [
            { type: 'tab', attrs: { title: 'First tab' }, content: [{ type: 'paragraph' }] },
            { type: 'tab', attrs: { title: 'Second tab' }, content: [{ type: 'paragraph' }] },
          ],
        })
        .run(),
  },
  {
    group: 'Blocks',
    title: 'Diagram',
    description: 'Mermaid flowchart, sequence, ERD…',
    icon: Network,
    keywords: 'mermaid chart flowchart sequence graph',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'mermaid', attrs: { code: 'flowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Iterate] --> B' } }).run(),
  },
  { group: 'Media', title: 'Image', description: 'Upload an image', icon: ImageIcon, keywords: 'picture photo upload', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:upload', 'image')) },
  { group: 'Media', title: 'File or video', description: 'Upload a file, video or audio', icon: FileUp, keywords: 'attachment pdf video audio upload', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:upload', 'file')) },
  { group: 'Media', title: 'Embed URL', description: 'Embed a page in an iframe', icon: Frame, keywords: 'iframe youtube video', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:picker', 'embed-url')) },
  { group: 'Content', title: 'Link to page', description: 'Insert a link to another page', icon: Link2, keywords: 'internal reference mention', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:picker', 'page-link')) },
  { group: 'Content', title: 'Reusable content', description: 'Insert a synced block', icon: Puzzle, keywords: 'snippet synced include partial', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:picker', 'reusable')) },
  { group: 'Content', title: 'API operation', description: 'OpenAPI endpoint with playground', icon: Braces, keywords: 'openapi endpoint rest swagger', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:picker', 'api')) },
  { group: 'Assistant', title: 'Draft with assistant', description: 'Write content from a prompt', icon: PenLine, keywords: 'ai generate write gpt llm', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:picker', 'ai-prompt')) },
  { group: 'Assistant', title: 'Continue writing', description: 'Continue from the cursor', icon: PenLine, keywords: 'ai continue autocomplete', run: (e, r) => (e.chain().focus().deleteRange(r).run(), emit('ds:ai-continue', null)) },
];

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => `${i.title} ${i.keywords || ''} ${i.group}`.toLowerCase().includes(q));
}

interface ListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const SlashList = forwardRef<{ onKeyDown: (p: SuggestionKeyDownProps) => boolean }, ListProps>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useEffect(() => {
    document.querySelector(`[data-slash-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'Enter') {
        if (items[selected]) command(items[selected]);
        return true;
      }
      return false;
    },
  }));
  if (!items.length) return <div className="card px-3 py-2 text-sm shadow-xl muted">No matching blocks</div>;
  let lastGroup = '';
  return (
    <div className="card scrollbar-thin max-h-80 w-72 overflow-y-auto py-1 shadow-xl">
      {items.map((item, i) => {
        const header = item.group !== lastGroup ? item.group : null;
        lastGroup = item.group;
        return (
          <div key={item.title}>
            {header && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{header}</div>}
            <button
              data-slash-index={i}
              className={cn('flex w-full items-center gap-3 px-3 py-1.5 text-left', i === selected ? 'bg-slate-100 dark:bg-slate-800' : '')}
              onMouseEnter={() => setSelected(i)}
              onClick={() => command(item)}
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <item.icon className="h-4 w-4 text-slate-600 dark:text-slate-300" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="muted block truncate text-xs">{item.description}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
});
SlashList.displayName = 'SlashList';

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ editor }) => editor.isEditable,
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let component: ReactRenderer<{ onKeyDown: (p: SuggestionKeyDownProps) => boolean }, ListProps> | null = null;
          let el: HTMLDivElement | null = null;
          const position = (props: SuggestionProps<SlashItem>) => {
            const rect = props.clientRect?.();
            if (!rect || !el) return;
            const below = window.innerHeight - rect.bottom > 340;
            el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
            el.style.top = below ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - 330)}px`;
          };
          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashList, { props: { items: props.items, command: props.command }, editor: props.editor });
              el = document.createElement('div');
              el.style.position = 'fixed';
              el.style.zIndex = '70';
              el.appendChild(component.element);
              document.body.appendChild(el);
              position(props);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: props.command });
              position(props);
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                el?.remove();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              el?.remove();
              component?.destroy();
              el = null;
              component = null;
            },
          };
        },
      }),
    ];
  },
});
