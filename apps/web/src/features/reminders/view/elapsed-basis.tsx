import type { ElapsedTimeBasis } from '../model/types';

// Render only the persisted calculation inputs; never recompute the target time.
export function ElapsedBasis({
  basis,
  className = 'text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]',
}: {
  basis?: ElapsedTimeBasis | null;
  className?: string;
}) {
  if (!basis) return null;
  return (
    <p className={className}>
      按经过时间冻结：从 <span className="font-mono tabular-nums">{basis.anchor_utc}</span>（UTC）起{' '}
      <span className="font-mono tabular-nums">{basis.duration_seconds}</span> 秒 · 依据版本{' '}
      {basis.revision}
    </p>
  );
}
