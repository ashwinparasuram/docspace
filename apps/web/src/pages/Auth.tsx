import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Logo } from '../components/Logo';
import { api, ApiError } from '../lib/api';
import { useMe, useMeta } from '../lib/auth';
import { PageLoader, Spinner } from '../components/ui';

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      <div className="px-6 py-5">
        <Logo />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 pt-[8vh]">
        <div className="w-full max-w-[380px]">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="muted mt-1.5 text-sm">{subtitle}</p>}
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">{children}</div>
        </div>
      </div>
      <footer className="muted px-6 py-5 text-xs">Self-hosted documentation platform</footer>
    </div>
  );
}

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Absolute paths outside the SPA (e.g. published members-only sites) need a full page load. */
function go(navigate: ReturnType<typeof useNavigate>, next: string) {
  if (next.startsWith('/s/')) window.location.href = next;
  else navigate(next, { replace: true });
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meta = useMeta();
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  if (me.data?.user) {
    go(navigate, next);
    return null;
  }
  if (meta.data?.needsSetup) return <RegisterPage firstRun />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ mfaRequired: boolean }>('/auth/login', { email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      if (res.mfaRequired) navigate(`/mfa?next=${encodeURIComponent(next)}`);
      else go(navigate, next);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Welcome back to your documentation workspace.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary h-9 w-full" disabled={busy}>
          {busy && <Spinner className="text-current" />} Sign in
        </button>
      </form>
      {meta.data?.allowRegistration && (
        <p className="muted mt-4 text-center text-sm">
          No account?{' '}
          <Link className="font-medium text-slate-900 underline underline-offset-2 dark:text-white" to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Create one
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

export function RegisterPage({ firstRun, inviteToken }: { firstRun?: boolean; inviteToken?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/register', { ...form, orgName: form.orgName || undefined, inviteToken });
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['meta'] });
      go(navigate, safeNext(params.get('next')));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={firstRun ? 'Set up DocSpace' : inviteToken ? 'Create your account' : 'Create an account'}
      subtitle={firstRun ? 'Create the first account. It becomes the instance administrator.' : undefined}
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Full name</label>
          <input className="input" value={form.name} onChange={set('name')} required autoFocus />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={form.email} onChange={set('email')} required />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} />
          <p className="muted mt-1 text-xs">At least 8 characters with letters and numbers.</p>
        </div>
        {!inviteToken && (
          <div>
            <label className="label">Organization name</label>
            <input className="input" placeholder="Acme Inc." value={form.orgName} onChange={set('orgName')} />
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary h-9 w-full" disabled={busy}>
          {busy && <Spinner className="text-current" />} Create account
        </button>
      </form>
      {!firstRun && (
        <p className="muted mt-4 text-center text-sm">
          Already have an account?{' '}
          <Link className="font-medium text-slate-900 underline underline-offset-2 dark:text-white" to="/login">
            Sign in
          </Link>
        </p>
      )}
    </AuthCard>
  );
}

export function MfaPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/auth/mfa', { code });
      await qc.invalidateQueries({ queryKey: ['me'] });
      go(navigate, safeNext(params.get('next')));
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  return (
    <AuthCard title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={submit} className="space-y-3">
        <input className="input text-center font-mono text-lg tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary h-9 w-full">Verify</button>
      </form>
    </AuthCard>
  );
}

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.get(`/auth/invitations/${token}`), retry: false });
  const [error, setError] = useState<string | null>(null);
  if (invite.isLoading || me.isLoading) return <PageLoader />;
  if (invite.error) {
    return (
      <AuthCard title="Invitation unavailable">
        <p className="text-sm">{(invite.error as ApiError).message}</p>
      </AuthCard>
    );
  }
  const inv = invite.data;
  if (!me.data?.user) {
    return (
      <div>
        <div className="border-b border-slate-200 bg-white px-4 py-2 text-center text-sm dark:border-slate-800 dark:bg-slate-900">
          You've been invited to join <strong>{inv.org_name}</strong> as {inv.role}.{' '}
          <Link className="underline" to={`/login?next=/invite/${token}`}>
            Sign in instead
          </Link>
        </div>
        <RegisterPage inviteToken={token} />
      </div>
    );
  }
  const accept = async () => {
    try {
      const res = await api.post(`/auth/invitations/${token}/accept`);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(`/o/${res.orgSlug}`);
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  return (
    <AuthCard title={`Join ${inv.org_name}`} subtitle={`You've been invited as ${inv.role}.`}>
      <button className="btn-primary h-9 w-full" onClick={accept}>
        Accept invitation
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </AuthCard>
  );
}
