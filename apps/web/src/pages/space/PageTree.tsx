import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Copy, EyeOff, Eye, ExternalLink, FolderOpen, MoreHorizontal, Plus, Trash2, Braces } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Menu, MenuItem, useConfirm, useToast } from '../../components/ui';

export interface TreeNode {
  id: string;
  stableId: string;
  title: string;
  kind: string;
  icon: string | null;
  hidden: boolean;
  modified: boolean;
  isNew: boolean;
  children: TreeNode[];
}

type DropPos = 'before' | 'after' | 'inside';

function loadExpanded(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

export function PageTree({
  pages,
  activePageId,
  canEdit,
  orgSlug,
  spaceId,
  branchId,
  filter,
}: {
  pages: TreeNode[];
  activePageId?: string;
  canEdit: boolean;
  orgSlug: string;
  spaceId: string;
  branchId: string;
  filter: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const storeKey = `ds-tree-${spaceId}`;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpanded(storeKey));
  const [drag, setDrag] = useState<{ id: string; stableId: string } | null>(null);
  const [drop, setDrop] = useState<{ stableId: string; pos: DropPos } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(expanded));
    } catch {
      /* ignore */
    }
  }, [expanded, storeKey]);

  // Expand ancestors of the active page.
  useEffect(() => {
    if (!activePageId) return;
    const path: string[] = [];
    const find = (nodes: TreeNode[], trail: string[]): boolean =>
      nodes.some((n) => {
        if (n.id === activePageId) {
          path.push(...trail);
          return true;
        }
        return find(n.children, [...trail, n.stableId]);
      });
    find(pages, []);
    if (path.length) setExpanded((e) => ({ ...e, ...Object.fromEntries(path.map((p) => [p, true])) }));
  }, [activePageId, pages]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['tree', spaceId, branchId] });
  const go = (id: string) => navigate(`/o/${orgSlug}/s/${spaceId}/b/${branchId}/p/${id}`);

  const addChild = async (parent: TreeNode | null, kind = 'doc') => {
    try {
      const res = await api.post(`/spaces/${spaceId}/branches/${branchId}/pages`, { title: kind === 'group' ? 'New section' : 'Untitled', parentStableId: parent?.stableId ?? null, kind });
      if (parent) setExpanded((e) => ({ ...e, [parent.stableId]: true }));
      await refresh();
      go(res.id);
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  const move = async (source: { id: string; stableId: string }, target: TreeNode, pos: DropPos, parentOf: Map<string, string | null>, siblingsOf: Map<string | null, TreeNode[]>) => {
    if (source.stableId === target.stableId) return;
    let parentStableId: string | null;
    let index: number;
    if (pos === 'inside') {
      parentStableId = target.stableId;
      index = target.children.length;
      setExpanded((e) => ({ ...e, [target.stableId]: true }));
    } else {
      parentStableId = parentOf.get(target.stableId) ?? null;
      const siblings = (siblingsOf.get(parentStableId) || []).filter((s) => s.stableId !== source.stableId);
      index = siblings.findIndex((s) => s.stableId === target.stableId) + (pos === 'after' ? 1 : 0);
    }
    try {
      await api.post(`/pages/${source.id}/move`, { parentStableId, index });
      await refresh();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  const parentOf = new Map<string, string | null>();
  const siblingsOf = new Map<string | null, TreeNode[]>();
  const index = (nodes: TreeNode[], parent: string | null) => {
    siblingsOf.set(parent, nodes);
    for (const n of nodes) {
      parentOf.set(n.stableId, parent);
      index(n.children, n.stableId);
    }
  };
  index(pages, null);

  const matches = (n: TreeNode): boolean => !filter || n.title.toLowerCase().includes(filter.toLowerCase()) || n.children.some(matches);

  const renderNode = (n: TreeNode, depth: number) => {
    if (!matches(n)) return null;
    const open = filter ? true : expanded[n.stableId] ?? depth === 0;
    const active = n.id === activePageId;
    const isDrop = drop?.stableId === n.stableId;
    const Icon = n.kind === 'link' ? ExternalLink : n.kind === 'api' ? Braces : null;
    return (
      <li key={n.stableId}>
        <div
          draggable={canEdit}
          onDragStart={(e) => {
            setDrag({ id: n.id, stableId: n.stableId });
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            setDrag(null);
            setDrop(null);
          }}
          onDragOver={(e) => {
            if (!drag || drag.stableId === n.stableId) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = e.clientY - r.top;
            setDrop({ stableId: n.stableId, pos: y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : 'inside' });
          }}
          onDragLeave={() => setDrop((d) => (d?.stableId === n.stableId ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drop) void move(drag, n, drop.pos, parentOf, siblingsOf);
            setDrag(null);
            setDrop(null);
          }}
          className={cn(
            'group relative flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-sm',
            active ? 'bg-slate-200/70 font-medium text-slate-900 dark:bg-slate-800 dark:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70',
            n.kind === 'group' && !active && 'mt-3 text-2xs font-semibold uppercase tracking-[0.06em] text-slate-500 dark:text-slate-500',
            isDrop && drop?.pos === 'inside' && 'ring-2 ring-brand-400',
            n.hidden && 'opacity-60',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => go(n.id)}
        >
          {isDrop && drop?.pos === 'before' && <span className="absolute inset-x-0 -top-px h-0.5 bg-brand-500" />}
          {isDrop && drop?.pos === 'after' && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand-500" />}
          <button
            className={cn('flex h-5 w-5 flex-none items-center justify-center rounded text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700', !n.children.length && 'invisible')}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded({ ...expanded, [n.stableId]: !open });
            }}
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          {n.icon ? <span className="w-4 flex-none text-center text-[13px]">{n.icon}</span> : Icon ? <Icon className="h-3.5 w-3.5 flex-none text-slate-400" /> : null}
          <span className="min-w-0 flex-1 truncate">{n.title}</span>
          {n.isNew ? <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-500" title="New in this branch" /> : n.modified ? <span className="h-1.5 w-1.5 flex-none rounded-full bg-amber-500" title="Modified in this branch" /> : null}
          {n.hidden && <EyeOff className="h-3 w-3 flex-none text-slate-400" />}
          {canEdit && (
            <div className="hidden flex-none items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
              <button className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700" title="Add child page" onClick={() => addChild(n)}>
                <Plus className="h-3.5 w-3.5" />
              </button>
              <Menu
                align="right"
                trigger={() => (
                  <button className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700" aria-label="Page actions">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Plus className="h-4 w-4" />} onClick={() => (close(), void addChild(n))}>
                      Add child page
                    </MenuItem>
                    <MenuItem
                      icon={<Copy className="h-4 w-4" />}
                      onClick={async () => {
                        close();
                        const res = await api.post(`/pages/${n.id}/duplicate`);
                        await refresh();
                        go(res.id);
                      }}
                    >
                      Duplicate
                    </MenuItem>
                    <MenuItem
                      icon={n.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      onClick={async () => {
                        close();
                        await api.patch(`/pages/${n.id}`, { hidden: !n.hidden });
                        await refresh();
                      }}
                    >
                      {n.hidden ? 'Show in navigation' : 'Hide from navigation'}
                    </MenuItem>
                    <MenuItem
                      icon={<Trash2 className="h-4 w-4" />}
                      danger
                      onClick={async () => {
                        close();
                        if (!(await confirm({ title: `Delete "${n.title}"?`, message: n.children.length ? `This also deletes ${n.children.length} child page(s).` : undefined, danger: true, confirmLabel: 'Delete' }))) return;
                        await api.del(`/pages/${n.id}`);
                        await refresh();
                        if (active) navigate(`/o/${orgSlug}/s/${spaceId}/b/${branchId}`);
                      }}
                    >
                      Delete
                    </MenuItem>
                  </>
                )}
              </Menu>
            </div>
          )}
        </div>
        {open && n.children.length > 0 && <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div>
      <ul className="space-y-px">{pages.map((n) => renderNode(n, 0))}</ul>
      {canEdit && (
        <div className="mt-2 flex gap-1">
          <button className="btn-ghost flex-1 justify-start px-2 py-1 text-xs" onClick={() => addChild(null)}>
            <Plus className="h-3.5 w-3.5" /> New page
          </button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => addChild(null, 'group')} title="Add a sidebar section group">
            <FolderOpen className="h-3.5 w-3.5" /> Group
          </button>
        </div>
      )}
    </div>
  );
}
