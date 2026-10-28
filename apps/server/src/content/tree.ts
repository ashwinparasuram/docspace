export interface PageRow {
  id: string;
  stable_id: string;
  parent_stable_id: string | null;
  title: string;
  slug: string;
  kind: string;
  position: number;
  hidden: number | boolean;
  icon: string | null;
  link_url: string | null;
  description: string | null;
  updated_at?: Date;
  [k: string]: any;
}

export interface TreeNode extends PageRow {
  path: string;
  children: TreeNode[];
  depth: number;
}

/** Build a sorted tree and compute URL paths from slug chains ("getting-started/install"). */
export function buildTree(pages: PageRow[]): { roots: TreeNode[]; byStable: Map<string, TreeNode>; byPath: Map<string, TreeNode>; flat: TreeNode[] } {
  const byStable = new Map<string, TreeNode>();
  for (const p of pages) byStable.set(p.stable_id, { ...p, path: '', children: [], depth: 0 });
  const roots: TreeNode[] = [];
  for (const node of byStable.values()) {
    const parent = node.parent_stable_id ? byStable.get(node.parent_stable_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (arr: TreeNode[]) => arr.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const byPath = new Map<string, TreeNode>();
  const flat: TreeNode[] = [];
  const assign = (arr: TreeNode[], prefix: string, depth: number) => {
    sort(arr);
    for (const n of arr) {
      // Groups are section headers: their children live at the root path level of the group slug.
      n.path = prefix ? `${prefix}/${n.slug}` : n.slug;
      n.depth = depth;
      if (!byPath.has(n.path)) byPath.set(n.path, n);
      flat.push(n);
      assign(n.children, n.path, depth + 1);
    }
  };
  assign(roots, '', 0);
  return { roots, byStable, byPath, flat };
}

/** Readable page order for prev/next navigation (skips groups, links and hidden pages). */
export function readingOrder(flat: TreeNode[]): TreeNode[] {
  return flat.filter((n) => n.kind === 'doc' || n.kind === 'api').filter((n) => !n.hidden);
}
