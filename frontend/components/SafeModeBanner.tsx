'use client';

interface SafeModeBannerProps {
  isActive: boolean;
  triggeredAt?: number | null;
  reason?: number | null;
  context?: string;
  className?: string;
}

const SAFE_MODE_REASONS: Record<number, string> = {
  0: 'No oracle error',
  1: 'Oracle unavailable',
  2: 'Oracle data stale',
  3: 'Price deviation detected',
  4: 'Invalid exchange rate',
  5: 'Decimals mismatch',
};

const SAFE_MODE_REASON_DETAILS: Record<number, string> = {
  0: 'Safe Mode should clear once the protocol confirms stable oracle data.',
  1: 'Price feed could not be reached or returned no data.',
  2: 'Last oracle update exceeded the maximum allowed age.',
  3: 'Price moved beyond the allowed deviation from the last good price.',
  4: 'Oracle returned a zero or out-of-range rate.',
  5: 'Oracle decimals did not match the expected configuration.',
};

export function formatSafeModeReason(reason?: number | null): string {
  if (reason === null || reason === undefined) return 'Unknown';
  return SAFE_MODE_REASONS[reason] ?? `Unknown (${reason})`;
}

function formatSafeModeReasonDetail(reason?: number | null): string | null {
  if (reason === null || reason === undefined) return null;
  return SAFE_MODE_REASON_DETAILS[reason] ?? null;
}

function formatSafeModeTime(triggeredAt?: number | null): string | null {
  if (!triggeredAt || triggeredAt <= 0) return null;
  const date = new Date(triggeredAt * 1000);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function SafeModeBanner({
  isActive,
  triggeredAt,
  reason,
  context,
  className,
}: SafeModeBannerProps) {
  if (!isActive) return null;

  const reasonLabel = formatSafeModeReason(reason);
  const triggeredLabel = formatSafeModeTime(triggeredAt);
  const reasonDetail = formatSafeModeReasonDetail(reason);

  return (
    <div className={`mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5 text-amber-500">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-amber-800">Safe Mode Active</h3>
          <p className="text-sm text-amber-700">
            {context ??
              'Some protocol actions are temporarily paused while oracle data is being validated.'}
          </p>
          <p className="text-xs text-amber-700">
            Reason: {reasonLabel}
            {triggeredLabel ? ` • Triggered: ${triggeredLabel}` : ' • Triggered: Unknown'}
          </p>
          {reasonDetail && (
            <p className="text-xs text-amber-700/80">
              {reasonDetail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function SafeModeBadge({
  isActive,
  reason,
  triggeredAt,
  className,
}: {
  isActive: boolean;
  reason?: number | null;
  triggeredAt?: number | null;
  className?: string;
}) {
  if (!isActive) return null;

  const reasonLabel = formatSafeModeReason(reason);
  const triggeredLabel = formatSafeModeTime(triggeredAt);
  const title = `Safe Mode: ${reasonLabel}${triggeredLabel ? ` (${triggeredLabel})` : ''}`;

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold px-3 py-1 ${className ?? ''}`}
      title={title}
      aria-label={title}
    >
      <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
      <span>Safe Mode</span>
      <span className="hidden xl:inline text-amber-700/80">• {reasonLabel}</span>
    </div>
  );
}
