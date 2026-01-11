import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: ReactNode;
  value: string | ReactNode;
  subtitle?: string;
  icon?: ReactNode;
  className?: string;
}

export function StatCard({ label, value, subtitle, icon, className }: StatCardProps) {
  return (
    <div className={cn('rounded-xl p-4 border border-gray-100 bg-gradient-to-br from-gray-50 to-white', className)}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-normal break-words">{label}</p>
          <p className="mt-1 text-xl md:text-2xl font-semibold text-gray-900 whitespace-normal break-words">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-500 whitespace-normal break-words">{subtitle}</p>}
        </div>
        {icon && <div className="ml-4 text-gray-400">{icon}</div>}
      </div>
    </div>
  );
}
