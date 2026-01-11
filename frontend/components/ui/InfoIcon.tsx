export function InfoIcon({ className = 'w-4 h-4 text-gray-400' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-9.5a.75.75 0 011.5 0v5a.75.75 0 01-1.5 0v-5zm.75-3a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
    </svg>
  );
}

