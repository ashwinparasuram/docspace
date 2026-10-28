import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useMe } from './lib/auth';
import { PageLoader } from './components/ui';
import { AppShell } from './components/AppShell';
import { LoginPage, RegisterPage, MfaPage, InvitePage } from './pages/Auth';
import { HomeRedirect } from './pages/Home';

const OrgHome = lazy(() => import('./pages/OrgHome'));
const OrgSettings = lazy(() => import('./pages/OrgSettings'));
const Reusable = lazy(() => import('./pages/Reusable'));
const Account = lazy(() => import('./pages/Account'));
const Admin = lazy(() => import('./pages/Admin'));
const SpaceLayout = lazy(() => import('./pages/space/SpaceLayout'));

function RequireAuth({ children }: { children: JSX.Element }) {
  const { data, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <PageLoader />;
  if (data?.mfaPending) return <Navigate to={`/mfa?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!data?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/o/:orgSlug" element={<OrgHome />} />
          <Route path="/o/:orgSlug/settings" element={<OrgSettings />} />
          <Route path="/o/:orgSlug/settings/:tab" element={<OrgSettings />} />
          <Route path="/o/:orgSlug/reusable" element={<Reusable />} />
          <Route path="/o/:orgSlug/reusable/:blockId" element={<Reusable />} />
          <Route path="/o/:orgSlug/s/:spaceId/*" element={<SpaceLayout />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
