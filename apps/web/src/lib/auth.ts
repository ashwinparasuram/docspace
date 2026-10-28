import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Me {
  user: { id: string; email: string; name: string; avatar_url: string | null; is_admin: boolean; totp_enabled: boolean } | null;
  mfaPending?: boolean;
  orgs?: { id: string; name: string; slug: string; role: string; logo_url: string | null; enforce2fa: boolean }[];
  unreadNotifications?: number;
}

export function useMe() {
  return useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/auth/me'), staleTime: 30_000 });
}

export interface Meta {
  needsSetup: boolean;
  allowRegistration: boolean;
  appUrl: string;
  ai: { provider: string; chatModel: string | null; llm: boolean };
}

export function useMeta() {
  return useQuery<Meta>({ queryKey: ['meta'], queryFn: () => api.get('/auth/meta'), staleTime: 300_000 });
}
