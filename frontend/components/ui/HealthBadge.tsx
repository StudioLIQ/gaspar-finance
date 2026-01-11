import { getHealthStatus } from '@/lib/utils';

export function HealthBadge({ ratio, mcr }: { ratio?: bigint; mcr?: bigint }) {
  if (!ratio || !mcr) return null;
  const status = getHealthStatus(ratio, mcr);
  const styles =
    status.status === 'healthy'
      ? 'bg-green-50 text-green-700 border-green-200'
      : status.status === 'warning'
      ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
      : 'bg-red-50 text-red-700 border-red-200';
  return (
    <span className={`ml-2 inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${styles}`}>
      {status.label}
    </span>
  );
}

