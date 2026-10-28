import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { cn, colorFor, initials } from '../lib/utils';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-3.5 w-3.5 animate-spin text-slate-400', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function Avatar({ name, id, url, size = 28 }: { name: string; id?: string; url?: string | null; size?: number }) {
  if (url) return <img src={url} alt={name} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: colorFor(id || name), fontSize: size * 0.4 }}
      title={name}
    >
      {initials(name) || '?'}
    </span>
  );
}

export function Badge({ children, tone = 'slate', className }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'brand' | 'purple' | 'blue'; className?: string }) {
  const tones = {
    slate: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300',
    red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300',
    brand: 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-300',
    purple: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-300',
    blue: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300',
  };
  return <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-2xs font-medium', tones[tone], className)}>{children}</span>;
}

export function Toggle({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4', disabled && 'cursor-not-allowed opacity-60')}>
      {(label || description) && (
        <span>
          {label && <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">{label}</span>}
          {description && <span className="block text-sm text-slate-500 dark:text-slate-400">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-[18px] w-8 flex-none items-center rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700')}
      >
        <span className={cn('inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[16px]' : 'translate-x-0.5')} />
      </button>
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[10vh] dark:bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('w-full rounded-lg border border-slate-200 bg-white shadow-pop dark:border-slate-800 dark:bg-slate-900', widths[size])} role="dialog" aria-modal="true">
        {title && (
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
            <h2 className="text-base font-semibold">{title}</h2>
            <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-lg border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-slate-800 dark:bg-slate-900">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Small dropdown anchored to its trigger. */
export function Menu({ trigger, children, align = 'left', className }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div className={cn('absolute z-40 mt-1 min-w-[200px] overflow-hidden rounded-md border border-slate-200 bg-white p-1 shadow-pop dark:border-slate-800 dark:bg-slate-900', align === 'right' ? 'right-0' : 'left-0', className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, danger, icon, disabled }: { children: ReactNode; onClick?: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800',
        danger ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-200',
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-slate-400">{icon}</span>}
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-3 rounded-md border border-slate-200 p-2.5 text-slate-400 dark:border-slate-800">{icon}</div>}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="muted mt-1 max-w-md text-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && !error && <p className="muted mt-1 text-xs">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{title}</h3>
          {description && <p className="muted mt-0.5 text-sm">{description}</p>}
        </div>
        {actions && <div className="flex-none">{actions}</div>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

// ---- Toasts --------------------------------------------------------------------------------------

type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };
const ToastCtx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-md border border-slate-200 bg-white px-3.5 py-2.5 text-sm shadow-pop dark:border-slate-800 dark:bg-slate-900">
              {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-emerald-500" /> : t.tone === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-red-500" /> : <Info className="mt-0.5 h-4 w-4 flex-none text-brand-500" />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ---- Confirm dialog --------------------------------------------------------------------------------

type ConfirmOpts = { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean; typeToConfirm?: string };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setTyped('');
    setState({ ...o, resolve });
  }), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title}
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => close(false)}>
              Cancel
            </button>
            <button className={state?.danger ? 'btn-danger' : 'btn-primary'} disabled={!!state?.typeToConfirm && typed !== state.typeToConfirm} onClick={() => close(true)}>
              {state?.confirmLabel || 'Confirm'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
          {state?.message}
          {state?.typeToConfirm && (
            <div>
              <p className="mb-1.5">
                Type <strong className="font-mono">{state.typeToConfirm}</strong> to confirm.
              </p>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          )}
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-5 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-0.5 pb-2.5 pt-1 text-sm font-medium transition-colors',
            value === t.id ? 'border-slate-900 text-slate-900 dark:border-white dark:text-white' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input className="input font-mono text-xs" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn-secondary flex-none"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
