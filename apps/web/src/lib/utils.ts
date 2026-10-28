import { clsx, type ClassValue } from 'clsx';

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

export function timeAgo(date: string | Date | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'];
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export const ROLE_LABELS: Record<string, string> = {
  reader: 'Reader',
  commenter: 'Commenter',
  reviewer: 'Reviewer',
  editor: 'Editor',
  creator: 'Creator',
  admin: 'Admin',
  owner: 'Owner',
};

export const ROLE_HELP: Record<string, string> = {
  reader: 'Can view content',
  commenter: 'Can view and comment',
  reviewer: 'Can comment and approve change requests',
  editor: 'Can edit content and merge change requests',
  creator: 'Editor who can also create spaces',
  admin: 'Full control over settings and members',
  owner: 'Admin who can manage owners and delete the organization',
};

const ORDER = ['reader', 'commenter', 'reviewer', 'editor', 'creator', 'admin', 'owner'];
export const atLeast = (role: string | null | undefined, min: string) => ORDER.indexOf(role || '') >= ORDER.indexOf(min);
