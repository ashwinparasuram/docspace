import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, Database, HardDrive, Server, PenLine } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatBytes, timeAgo } from '../lib/utils';
import { Badge, PageLoader, Section, Tabs, useConfirm, useToast } from '../components/ui';

export default function Admin() {
  const me = useMe();
  const [tab, setTab] = useState<'overview' | 'users' | 'orgs' | 'audit'>('overview');
  if (!me.data?.user?.is_admin) return <Navigate to="/" replace />;
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Instance administration</h1>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'users', label: 'Users' },
          { id: 'orgs', label: 'Organizations' },
          { id: 'audit', label: 'Audit log' },
        ]}
      />
      <div className="mt-6">
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <Users />}
        {tab === 'orgs' && <Orgs />}
        {tab === 'audit' && <AuditAll />}
      </div>
    </div>
  );
}

function Health({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span className="muted text-xs">{detail}</span>
        <Badge tone={ok ? 'green' : 'red'}>{ok ? 'healthy' : 'down'}</Badge>
      </span>
    </div>
  );
}

function Overview() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api.get('/admin/stats'), refetchInterval: 15000 });
  if (isLoading) return <PageLoader />;
  const c = data.counts;
  const tiles = [
    ['Users', c.users],
    ['Organizations', c.orgs],
    ['Spaces', `${c.spaces} (${c.published_spaces} live)`],
    ['Pages', c.pages],
    ['Files', `${c.files} · ${formatBytes(c.file_bytes)}`],
    ['Active sessions', c.sessions],
    ['Events (24h)', c.events_24h],
    ['Webhooks queued / failed', `${c.webhooks_pending} / ${c.webhooks_failed}`],
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="card p-4">
            <div className="muted text-xs">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Section title={<span className="flex items-center gap-2"><Activity className="h-4 w-4" /> Health</span>}>
          <Health ok={data.health.database} label="MySQL" detail="primary database" />
          <Health ok={data.health.cache.ok} label="Cache / pub-sub" detail={data.health.cache.kind === 'redis' ? 'Redis' : 'in-memory (single node)'} />
          <Health ok={data.health.storage.ok} label="Object storage" detail={data.health.storage.kind} />
          <div className="flex items-center justify-between py-1.5 text-sm">
            <span>Real-time collaboration</span>
            <span className="muted text-xs">
              {data.collab.rooms} open docs · {data.collab.connections} connections
            </span>
          </div>
        </Section>
        <Section title={<span className="flex items-center gap-2"><Server className="h-4 w-4" /> Runtime</span>}>
          <dl className="space-y-1.5 text-sm">
            {[
              ['App URL', data.runtime.appUrl],
              ['Node.js', data.runtime.node],
              ['Environment', data.runtime.env],
              ['Uptime', `${Math.floor(data.runtime.uptimeSec / 3600)}h ${Math.floor((data.runtime.uptimeSec % 3600) / 60)}m`],
              ['Memory', `${data.runtime.memoryMb} MB`],
              ['Open registration', data.runtime.allowRegistration ? 'yes' : 'no'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt className="muted">{k}</dt>
                <dd className="font-mono text-xs">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section title={<span className="flex items-center gap-2"><PenLine className="h-4 w-4" /> AI</span>}>
          <p className="text-sm">
            Provider: <strong>{data.ai.provider}</strong>
            {data.ai.llm ? (
              <>
                {' '}
                · chat model <code>{data.ai.chatModel}</code>
              </>
            ) : (
              ' — built-in offline features only (extractive answers, local semantic search, rule-based quality checks).'
            )}
          </p>
          <p className="muted mt-1 text-sm">Embeddings: {data.ai.embedModel || 'local hashed n-gram vectors'}</p>
        </Section>
        <Section title={<span className="flex items-center gap-2"><Database className="h-4 w-4" /> Maintenance</span>}>
          <p className="muted mb-3 text-sm">Prune analytics older than a year, expired sessions, old webhook deliveries and versions beyond the newest 200 per page.</p>
          <button
            className="btn-secondary"
            onClick={async () => {
              if (!(await confirm({ title: 'Run maintenance prune?', confirmLabel: 'Prune' }))) return;
              try {
                const r = await api.post('/admin/maintenance/prune', { analyticsDays: 365 });
                toast(`Pruned ${r.analytics} events, ${r.sessions} sessions, ${r.deliveries} deliveries, ${r.versions} versions`);
                void refetch();
              } catch (err) {
                toast((err as ApiError).message, 'error');
              }
            }}
          >
            <HardDrive className="h-4 w-4" /> Prune old data
          </button>
        </Section>
      </div>
    </div>
  );
}

function Users() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const { data = [], refetch } = useQuery({ queryKey: ['admin-users', q], queryFn: () => api.get(`/admin/users?q=${encodeURIComponent(q)}`) });
  const patch = async (id: string, body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/admin/users/${id}`, body);
      toast(msg);
      void refetch();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };
  return (
    <div className="card p-4">
      <input className="input mb-3" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
              <th className="py-2 pr-3 font-medium">User</th>
              <th className="py-2 pr-3 font-medium">Orgs</th>
              <th className="py-2 pr-3 font-medium">Last login</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u: any) => (
              <tr key={u.id} className="border-b border-slate-100 dark:border-slate-800/60">
                <td className="py-2 pr-3">
                  <div className="font-medium">{u.name}</div>
                  <div className="muted text-xs">{u.email}</div>
                </td>
                <td className="py-2 pr-3">{u.orgs}</td>
                <td className="py-2 pr-3 text-xs">{u.last_login_at ? timeAgo(u.last_login_at) : 'never'}</td>
                <td className="space-x-1 py-2 pr-3">
                  {u.is_admin && <Badge tone="purple">admin</Badge>}
                  {u.disabled && <Badge tone="red">disabled</Badge>}
                  {u.totp_enabled && <Badge tone="green">2FA</Badge>}
                </td>
                <td className="space-x-1 whitespace-nowrap py-2">
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => patch(u.id, { is_admin: !u.is_admin }, u.is_admin ? 'Admin removed' : 'Made admin')}>
                    {u.is_admin ? 'Revoke admin' : 'Make admin'}
                  </button>
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => patch(u.id, { disabled: !u.disabled }, u.disabled ? 'User enabled' : 'User disabled')}>
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    className="btn-secondary px-2 py-1 text-xs"
                    onClick={() => {
                      const password = window.prompt(`New password for ${u.email}`);
                      if (password) void patch(u.id, { password }, 'Password reset');
                    }}
                  >
                    Reset password
                  </button>
                  {u.totp_enabled && (
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => patch(u.id, { reset2fa: true }, '2FA reset')}>
                      Reset 2FA
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Orgs() {
  const { data = [] } = useQuery({ queryKey: ['admin-orgs'], queryFn: () => api.get('/admin/orgs') });
  return (
    <div className="card divide-y divide-slate-100 dark:divide-slate-800">
      {data.map((o: any) => (
        <a key={o.id} href={`/o/${o.slug}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <span className="flex-1 font-medium">{o.name}</span>
          <span className="muted text-xs">
            {o.members} members · {o.spaces} spaces · created {timeAgo(o.created_at)}
          </span>
        </a>
      ))}
    </div>
  );
}

function AuditAll() {
  const { data = [] } = useQuery({ queryKey: ['admin-audit'], queryFn: () => api.get('/admin/audit') });
  return (
    <div className="card overflow-x-auto p-4">
      <table className="w-full text-sm">
        <tbody>
          {data.map((a: any) => (
            <tr key={a.id} className="border-b border-slate-100 dark:border-slate-800/60">
              <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{timeAgo(a.created_at)}</td>
              <td className="py-1.5 pr-3 text-xs">{a.actor_email || 'system'}</td>
              <td className="py-1.5 pr-3">
                <code className="text-xs">{a.action}</code>
              </td>
              <td className="py-1.5 pr-3 text-xs">{a.org_name}</td>
              <td className="max-w-xs truncate py-1.5 font-mono text-[11px] text-slate-500">{a.meta ? JSON.stringify(a.meta) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
