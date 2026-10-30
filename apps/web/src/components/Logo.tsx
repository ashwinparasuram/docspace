import { cn } from '../lib/utils';

/** DocSpace mark: a folded page built from two offset planes. Inherits currentColor. */
export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
      <path d="M8 7h5.5L16 9.5V17H8V7Z" className="fill-white dark:fill-slate-900" />
      <path d="M13.5 7v2.5H16" className="stroke-slate-300 dark:stroke-slate-500" strokeWidth="1.2" />
    </svg>
  );
}

export function Logo({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-slate-900 dark:text-white', className)}>
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight">DocSpace</span>
    </span>
  );
}

/** Square monogram used for spaces and organizations without an uploaded icon. */
export function Monogram({ name, icon, logo, size = 24, className }: { name: string; icon?: string | null; logo?: string | null; size?: number; className?: string }) {
  if (logo) return <img src={logo} alt="" className={cn('flex-none rounded-md object-contain', className)} style={{ width: size, height: size }} />;
  return (
    <span
      className={cn('inline-flex flex-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300', className)}
      style={{ width: size, height: size, fontSize: icon ? size * 0.55 : size * 0.42 }}
    >
      {icon || (name.trim()[0] || '?').toUpperCase()}
    </span>
  );
}
