import { DOTS, STATUS, TONES } from '../../lib/status';
import { cn } from '../../lib/format';

export default function StatusBadge({ status, label, className, pulse = false }) {
  const meta = STATUS[status] || { label: status, tone: 'zinc' };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        TONES[meta.tone],
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {pulse && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', DOTS[meta.tone])} />}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', DOTS[meta.tone])} />
      </span>
      {label || meta.label}
    </span>
  );
}
