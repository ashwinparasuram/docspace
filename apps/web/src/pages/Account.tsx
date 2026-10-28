import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Monitor, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/utils';
import { Badge, CopyField, Field, Modal, Section, useToast } from '../components/ui';

export default function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const user = me.data!.user!;
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get('/auth/sessions') });
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get('/auth/tokens') });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('');

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Account & security</h1>
      <Section title="Profile">
        <div className="flex gap-2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" onClick={() => run(async () => (await api.patch('/auth/me', { name }), qc.invalidateQueries({ queryKey: ['me'] })), 'Profile updated')}>
            Save
          </button>
        </div>
        <p className="muted mt-2 text-sm">{user.email}</p>
      </Section>

      <Section title="Password">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password">
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
        </div>
        <button className="btn-primary mt-3" disabled={!pw.current || pw.next.length < 8} onClick={() => run(async () => (await api.post('/auth/password', pw), setPw({ current: '', next: '' })), 'Password changed; other sessions signed out')}>
          Change password
        </button>
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Two-factor authentication
          </span>
        }
        description="Use an authenticator app (TOTP) such as Aegis, 2FAS, Google Authenticator or 1Password."
        actions={user.totp_enabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="amber">Disabled</Badge>}
      >
        {user.totp_enabled ? (
          <button
            className="btn-secondary"
            onClick={() => {
              const password = window.prompt('Confirm your password to disable 2FA');
              if (password) void run(async () => (await api.post('/auth/2fa/disable', { password }), qc.invalidateQueries({ queryKey: ['me'] })), '2FA disabled');
            }}
          >
            Disable 2FA
          </button>
        ) : (
          <button className="btn-primary" onClick={async () => setSetup(await api.post('/auth/2fa/setup'))}>
            Set up 2FA
          </button>
        )}
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            <Monitor className="h-4 w-4" /> Active sessions
          </span>
        }
      >
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {(sessions.data || []).map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{s.user_agent || 'Unknown device'}</div>
                <div className="muted text-xs">
                  {s.ip} · last active {timeAgo(s.last_seen_at)}
                </div>
              </div>
              {s.current ? (
                <Badge tone="green">This device</Badge>
              ) : (
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => run(async () => (await api.del(`/auth/sessions/${s.id}`), sessions.refetch()), 'Session revoked')}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> API tokens
          </span>
        }
        description="Personal tokens for the REST API (Authorization: Bearer dsk_…). They act with your permissions."
      >
        <form
          className="mb-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const res = await api.post('/auth/tokens', { name: tokenName });
              setNewToken(res.token);
              setTokenName('');
              await tokens.refetch();
            } catch (err) {
              toast((err as ApiError).message, 'error');
            }
          }}
        >
          <input className="input" placeholder="Token name, e.g. CI publishing" value={tokenName} onChange={(e) => setTokenName(e.target.value)} required />
          <button className="btn-primary flex-none">Create token</button>
        </form>
        {newToken && (
          <div className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-500/10">
            <p className="mb-2">Copy your token now — it won't be shown again.</p>
            <CopyField value={newToken} />
          </div>
        )}
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {(tokens.data || []).map((t: any) => (
            <div key={t.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex-1">{t.name}</span>
              <code className="muted text-xs">{t.prefix}…</code>
              <span className="muted text-xs">{t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : 'never used'}</span>
              <button className="btn-ghost p-1" onClick={() => run(async () => (await api.del(`/auth/tokens/${t.id}`), tokens.refetch()), 'Token revoked')}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Modal open={!!setup} onClose={() => setSetup(null)} title="Set up two-factor authentication" size="sm">
        {setup && (
          <div className="space-y-3 text-center">
            <p className="text-sm">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
            <img src={setup.qr} alt="2FA QR code" className="mx-auto rounded-lg bg-white p-2" />
            <p className="muted break-all font-mono text-xs">{setup.secret}</p>
            <input className="input text-center font-mono tracking-[0.3em]" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <button
              className="btn-primary w-full"
              onClick={() =>
                run(async () => {
                  await api.post('/auth/2fa/enable', { code });
                  setSetup(null);
                  setCode('');
                  await qc.invalidateQueries({ queryKey: ['me'] });
                }, '2FA enabled')
              }
            >
              Verify & enable
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
