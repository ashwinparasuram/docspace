import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from '../lib/auth';
import { api, ApiError } from '../lib/api';
import { EmptyState } from '../components/ui';
import { Building2 } from 'lucide-react';

export function HomeRedirect() {
  const { data } = useMe();
  const orgs = data?.orgs || [];
  let last: string | null = null;
  try {
    last = localStorage.getItem('ds-last-org');
  } catch {
    /* ignore */
  }
  const target = orgs.find((o) => o.slug === last) || orgs[0];
  if (target) return <Navigate to={`/o/${target.slug}`} replace />;
  return <CreateOrg />;
}

export function CreateOrg() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-md py-16">
      <EmptyState icon={<Building2 className="h-6 w-6" />} title="Create an organization" description="Organizations hold your spaces, members and teams." />
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const res = await api.post('/orgs', { name });
            await qc.invalidateQueries({ queryKey: ['me'] });
            navigate(`/o/${res.slug}`);
          } catch (err) {
            setError((err as ApiError).message);
          }
        }}
      >
        <input className="input" placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary">Create</button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
