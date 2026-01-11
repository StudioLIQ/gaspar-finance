import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
}

export function Card({ children, className, title, subtitle }: CardProps) {
  return (
    <div className={cn('bg-white/90 backdrop-blur rounded-xl card-shadow border border-gray-200 hover:border-primary-200 transition-colors', className)}>
      {(title || subtitle) && (
        <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-white to-gray-50 rounded-t-xl">
          {title && <h2 className="text-xl font-semibold text-gray-900">{title}</h2>}
          {subtitle && <p className="text-sm text-gray-600 mt-1">{subtitle}</p>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}
