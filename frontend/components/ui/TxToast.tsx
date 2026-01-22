'use client';

import { getDeployExplorerUrl } from '@/lib/casperDeploy';
import type { TxStatus } from '@/hooks/useCdp';

interface TxToastProps {
  title: string;
  status: TxStatus;
  error?: string | null;
  deployHash?: string | null;
}

type StepState = 'pending' | 'active' | 'completed' | 'error';

interface Step {
  label: string;
  state: StepState;
}

function getSteps(status: TxStatus, error?: string | null): Step[] {
  const steps: Step[] = [
    { label: 'Sign', state: 'pending' },
    { label: 'Approve', state: 'pending' },
    { label: 'Pending', state: 'pending' },
  ];

  switch (status) {
    case 'idle':
      return steps;
    case 'signing':
      steps[0].state = 'active';
      return steps;
    case 'approving':
      steps[0].state = 'completed';
      steps[1].state = 'active';
      return steps;
    case 'pending':
      steps[0].state = 'completed';
      steps[1].state = 'completed';
      steps[2].state = 'active';
      return steps;
    case 'success':
      steps[0].state = 'completed';
      steps[1].state = 'completed';
      steps[2].state = 'completed';
      return steps;
    case 'error':
      if (error) {
        // Determine which step failed based on error message
        if (error.toLowerCase().includes('signing') || error.toLowerCase().includes('cancelled')) {
          steps[0].state = 'error';
        } else if (error.toLowerCase().includes('approv')) {
          steps[0].state = 'completed';
          steps[1].state = 'error';
        } else {
          steps[0].state = 'completed';
          steps[1].state = 'completed';
          steps[2].state = 'error';
        }
      } else {
        steps[2].state = 'error';
      }
      return steps;
    default:
      return steps;
  }
}

function StepIndicator({ step, isLast }: { step: Step; isLast: boolean }) {
  const stateStyles: Record<StepState, string> = {
    pending: 'bg-gray-200 text-gray-500',
    active: 'bg-primary-100 text-primary-600 ring-2 ring-primary-400 animate-pulse',
    completed: 'bg-green-100 text-green-600',
    error: 'bg-red-100 text-red-600',
  };

  const lineStyles: Record<StepState, string> = {
    pending: 'bg-gray-200',
    active: 'bg-gray-200',
    completed: 'bg-green-400',
    error: 'bg-red-400',
  };

  const iconMap: Record<StepState, React.ReactNode> = {
    pending: <span className="text-xs">-</span>,
    active: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
    ),
    completed: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
  };

  return (
    <div className="flex items-center">
      <div className="flex flex-col items-center">
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center ${stateStyles[step.state]}`}
        >
          {iconMap[step.state]}
        </div>
        <span className="text-[10px] mt-1 text-gray-600 font-medium">{step.label}</span>
      </div>
      {!isLast && (
        <div className={`w-8 h-0.5 mx-1 ${lineStyles[step.state]}`} />
      )}
    </div>
  );
}

export function TxToast({ title, status, error, deployHash }: TxToastProps) {
  const steps = getSteps(status, error);
  const isComplete = status === 'success';
  const hasError = status === 'error';

  return (
    <div className="bg-white rounded-lg shadow-lg border border-gray-100 p-4 min-w-[280px] max-w-[320px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-gray-900 text-sm">{title}</h4>
        {isComplete && (
          <span className="text-green-600 text-xs font-medium flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Success
          </span>
        )}
        {hasError && (
          <span className="text-red-600 text-xs font-medium flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Failed
          </span>
        )}
      </div>

      {/* Stepper */}
      <div className="flex items-start justify-center mb-3">
        {steps.map((step, idx) => (
          <StepIndicator key={step.label} step={step} isLast={idx === steps.length - 1} />
        ))}
      </div>

      {/* Error message */}
      {hasError && error && (
        <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1.5 mb-2 line-clamp-2">
          {error}
        </p>
      )}

      {/* Explorer link */}
      {deployHash && (
        <a
          href={getDeployExplorerUrl(deployHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary-600 hover:text-primary-700 hover:underline flex items-center gap-1"
        >
          View on Explorer
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
    </div>
  );
}
