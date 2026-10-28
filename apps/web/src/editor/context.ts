import { createContext, useContext } from 'react';

export interface EditorCtx {
  spaceId: string;
  orgSlug: string;
  branchId: string;
  pageId: string;
  canEdit: boolean;
  openPicker: (kind: 'reusable' | 'api' | 'page-link' | 'embed-url' | 'ai-prompt') => void;
  requestUpload: (kind: 'image' | 'file') => void;
  activeThread: string | null;
  setActiveThread: (id: string | null) => void;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditorCtx(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('EditorContext missing');
  return ctx;
}
