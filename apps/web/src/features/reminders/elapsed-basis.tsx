import type { ElapsedTimeBasis } from '@/lib/types';

// Render only the persisted calculation inputs; never recompute the target time.
export function ElapsedBasis({ basis }: { basis?: ElapsedTimeBasis | null }) {
  if (!basis) return null;
  return (
    <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
      按经过时间冻结：从 {basis.anchor_utc}（UTC）起 {basis.duration_seconds} 秒 · 依据版本{' '}
      {basis.revision}
    </p>
  );
}
