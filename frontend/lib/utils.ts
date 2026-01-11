import { type ClassValue, clsx } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function shortenPublicKey(key: string, chars: number = 6): string {
  if (!key) return '';
  if (key.length <= chars * 2) return key;
  return `${key.slice(0, chars)}...${key.slice(-chars)}`;
}

export function getHealthStatus(ratio: bigint, mcr: bigint): {
  status: 'healthy' | 'warning' | 'danger';
  label: string;
} {
  if (ratio >= (mcr * 130n) / 100n) return { status: 'healthy', label: 'Healthy' };
  if (ratio >= mcr) return { status: 'warning', label: 'At risk' };
  return { status: 'danger', label: 'Unsafe' };
}
