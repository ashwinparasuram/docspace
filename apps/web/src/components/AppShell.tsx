import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, ChevronsUpDown, LogOut, Monitor, Moon, Plus, Search, Settings, Shield, Sun, User } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { cn, timeAgo } from '../lib/utils';
import { Avatar, Menu, MenuItem, Modal } from './ui';
import { LogoMark, Monogram } from './Logo';

function useThemeMode() {
  const [mode, setMode] = useState<string>(() => {
    try {
      return localStorage.getItem('ds-app-mode') || 'auto';
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
    apply();
    try {
      localStorage.setItem('ds-app-mode', mode);
    } catch {
      /* ignore */
    }
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);
  return [mode, setMode] as const;
}

function QuickSearch({ orgSlug, open, onClose }: { orgSlug: string; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const { data = [] } = useQuery({ queryKey: ['org-search', orgSlug, q], queryFn: () => api.get(`/orgs/${orgSlug}/search?q=${encodeURIComponent(q)}`), enabled: open && q.trim().length > 1 });
  useEffect(() => {
    if (open) setQ('');
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} size="md">
      <div className="-mx-5 -my-4">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <Search className="h-4 w-4 text-slate-400" />
          <input autoFocus className="h-12 flex-1 bg-transparent text-sm outline-none" placeholder="Search pages across all spaces…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="kbd">Esc</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {q.trim().length > 1 && !data.length && <p className="muted p-6 text-center text-sm">No pages found</p>}
          {data.map((r: any) => (
            <button
              key={r.spaceId + r.stableId}
              className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => {
                onClose();
                navigate(`/o/${orgSlug}/s/${r.spaceId}/b/${r.branchId}/p/${r.pageId}`);
              }}
            >
              <div className="text-sm font-medium">
                {r.title} <span className="muted font-normal">· {r.spaceName}</span>
              </div>
              <div className="muted line-clamp-1 text-xs">{r.excerpt}</div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function Notifications({ count }: { count: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data = [], refetch } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/auth/notifications'), enabled: false });
  return (
    <Menu
      align="right"
      className="w-80"
      trigger={() => (
        <button
          className="btn-ghost relative h-8 w-8 p-0"
          aria-label="Notifications"
          onClick={() => {
            void refetch();
            if (count) void api.post('/auth/notifications/read').then(() => qc.invalidateQueries({ queryKey: ['me'] }));
          }}
        >
          <Bell className="h-4 w-4" />
          {count > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-600 ring-2 ring-white dark:ring-slate-950" aria-label={`${count} unread`} />}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-96 overflow-y-auto">
          <div className="border-b border-slate-200 px-3 py-2 text-sm font-semibold dark:border-slate-800">Notifications</div>
          {!data.length && <p className="muted px-3 py-6 text-center text-sm">You're all caught up</p>}
          {data.map((n: any) => (
            <button
              key={n.id}
              className="block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              onClick={() => {
                close();
                if (n.link) navigate(n.link);
              }}
            >
              <div className={cn('text-sm', !n.read_at && 'font-medium')}>{n.title}</div>
              {n.body && <div className="muted line-clamp-2 text-xs">{n.body}</div>}
              <div className="muted mt-0.5 text-[11px]">{timeAgo(n.created_at)}</div>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

export function AppShell() {
  const { data } = useMe();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useThemeMode();
  const [searchOpen, setSearchOpen] = useState(false);
  const orgs = data?.orgs || [];
  const orgSlug = params.orgSlug || (() => {
    try {
      return localStorage.getItem('ds-last-org');
    } catch {
      return null;
    }
  })() || orgs[0]?.slug;
  const org = orgs.find((o) => o.slug === orgSlug) || orgs[0];
  const user = data!.user!;
  const inSpace = location.pathname.includes('/s/');

  useEffect(() => {
    if (params.orgSlug) {
      try {
        localStorage.setItem('ds-last-org', params.orgSlug);
      } catch {
        /* ignore */
      }
    }
  }, [params.orgSlug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !inSpace) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inSpace]);

  const needs2fa = org?.enforce2fa && !user.totp_enabled;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 flex-none items-center gap-1.5 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
        <Link to={org ? `/o/${org.slug}` : '/'} className="mr-1 flex items-center" aria-label="DocSpace home">
          <LogoMark size={22} className="text-slate-900 dark:text-white" />
        </Link>
        <svg width="16" height="16" viewBox="0 0 16 16" className="flex-none text-slate-300 dark:text-slate-700" aria-hidden="true">
          <path d="M10.5 2.5 5.5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {org && (
          <Menu
            trigger={() => (
              <button className="btn-ghost h-7 max-w-[240px] gap-2 px-1.5 text-slate-900 dark:text-slate-100">
                <Monogram name={org.name} size={18} className="text-[10px]" />
                <span className="truncate">{org.name}</span>
                <ChevronsUpDown className="h-3 w-3 flex-none text-slate-400" />
              </button>
            )}
          >
            {(close) => (
              <>
                {orgs.map((o) => (
                  <MenuItem
                    key={o.id}
                    icon={o.slug === org.slug ? <Check className="h-4 w-4" /> : null}
                    onClick={() => {
                      close();
                      navigate(`/o/${o.slug}`);
                    }}
                  >
                    {o.name}
                  </MenuItem>
                ))}
                <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
                <MenuItem
                  icon={<Plus className="h-4 w-4" />}
                  onClick={async () => {
                    close();
                    const name = window.prompt('Organization name');
                    if (!name) return;
                    const res = await api.post('/orgs', { name });
                    await qc.invalidateQueries({ queryKey: ['me'] });
                    navigate(`/o/${res.slug}`);
                  }}
                >
                  New organization
                </MenuItem>
              </>
            )}
          </Menu>
        )}
        <div className="flex-1" />
        {org && !inSpace && (
          <button className="btn-secondary mr-1 hidden h-7 w-60 justify-start gap-2 px-2 text-slate-400 md:flex" onClick={() => setSearchOpen(true)}>
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left font-normal">Search pages</span>
            <span className="kbd">Ctrl K</span>
          </button>
        )}
        <Notifications count={data?.unreadNotifications || 0} />
        <Menu
          align="right"
          trigger={() => (
            <button className="btn-ghost p-1" aria-label="Account menu">
              <Avatar name={user.name} id={user.id} url={user.avatar_url} size={24} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
                <div className="text-sm font-medium">{user.name}</div>
                <div className="muted text-xs">{user.email}</div>
              </div>
              <MenuItem icon={<User className="h-4 w-4" />} onClick={() => (close(), navigate('/account'))}>
                Account & security
              </MenuItem>
              {org && (
                <MenuItem icon={<Settings className="h-4 w-4" />} onClick={() => (close(), navigate(`/o/${org.slug}/settings`))}>
                  Organization settings
                </MenuItem>
              )}
              {user.is_admin && (
                <MenuItem icon={<Shield className="h-4 w-4" />} onClick={() => (close(), navigate('/admin'))}>
                  Instance admin
                </MenuItem>
              )}
              <div className="flex items-center gap-1 px-3 py-1.5">
                <span className="muted flex-1 text-xs">Theme</span>
                {[
                  ['light', Sun],
                  ['dark', Moon],
                  ['auto', Monitor],
                ].map(([m, Icon]: any) => (
                  <button key={m} className={cn('rounded p-1', mode === m ? 'bg-slate-200 dark:bg-slate-700' : 'hover:bg-slate-100 dark:hover:bg-slate-800')} onClick={() => setMode(m)} aria-label={m}>
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
              <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
              <MenuItem
                icon={<LogOut className="h-4 w-4" />}
                onClick={async () => {
                  await api.post('/auth/logout');
                  qc.clear();
                  navigate('/login');
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </header>
      {needs2fa && location.pathname !== '/account' && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          {org!.name} requires two-factor authentication.{' '}
          <Link to="/account" className="font-semibold underline">
            Set it up now
          </Link>
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      {org && <QuickSearch orgSlug={org.slug} open={searchOpen} onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
