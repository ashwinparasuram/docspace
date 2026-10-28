import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Callout, CodeBlock, Expandable, ImageNode, Mermaid, Tab, Tabs, Embed } from './nodes';
import { SlashCommand } from './SlashMenu';
import { EditorContext } from './context';

/** Non-collaborative editor (used for reusable content blocks). */
export function SimpleEditor({ content, onChange, editable, orgSlug }: { content: any; onChange: (doc: any) => void; editable: boolean; orgSlug: string }) {
  const editor = useEditor({
    editable,
    content,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Placeholder.configure({ placeholder: "Type '/' for blocks…" }),
      Link.configure({ openOnClick: false }),
      Underline,
      Highlight,
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
      SlashCommand,
    ],
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  return (
    <EditorContext.Provider
      value={{ spaceId: '', orgSlug, branchId: '', pageId: '', canEdit: editable, openPicker: () => {}, requestUpload: () => {}, activeThread: null, setActiveThread: () => {} }}
    >
      <div className="ds-editor">
        <EditorContent editor={editor} />
      </div>
    </EditorContext.Provider>
  );
}
