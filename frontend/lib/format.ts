/**
 * Number Formatting Utilities
 *
 * Consistent formatting functions for numbers across the application.
 */

import { PERCENT_DECIMALS, PRICE_DECIMALS, DEFAULT_TOKEN_DECIMALS } from './constants';

/**
 * Format a percentage value (e.g., 15000 bps -> "150.0%")
 */
export function formatPercentBps(bps: number, decimals: number = PERCENT_DECIMALS): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

/**
 * Format a percentage from decimal (e.g., 0.15 -> "15.0%")
 */
export function formatPercent(value: number, decimals: number = PERCENT_DECIMALS): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a USD price from bigint (18 decimals)
 */
export function formatUsdPrice(priceWei: bigint, decimals: number = PRICE_DECIMALS): string {
  const price = Number(priceWei) / 1e18;
  return `$${price.toFixed(decimals)}`;
}

/**
 * Format a USD price from number
 */
export function formatUsd(value: number, decimals: number = DEFAULT_TOKEN_DECIMALS): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Format large numbers in compact notation (1K, 1M, etc.)
 */
export function formatCompact(value: number): string {
  const formatter = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 2,
  });
  return formatter.format(value);
}

/**
 * Format a bigint token amount with custom decimals
 */
export function formatTokenAmount(
  amount: bigint,
  tokenDecimals: number,
  displayDecimals: number = DEFAULT_TOKEN_DECIMALS
): string {
  const divisor = BigInt(10 ** tokenDecimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  const fractionalStr = fractionalPart.toString().padStart(tokenDecimals, '0');
  const truncatedFractional = fractionalStr.slice(0, displayDecimals);

  if (displayDecimals === 0) {
    return wholePart.toLocaleString();
  }

  return `${wholePart.toLocaleString()}.${truncatedFractional}`;
}

/**
 * Get CR status color class based on collateral ratio
 */
export function getCrStatusColor(crBps: number): string {
  if (crBps >= 20000) return 'text-green-600';
  if (crBps >= 15000) return 'text-yellow-600';
  if (crBps >= 11000) return 'text-orange-500';
  return 'text-red-600';
}

/**
 * Get CR status label based on collateral ratio
 */
export function getCrStatusLabel(crBps: number): string {
  if (crBps >= 20000) return 'Healthy';
  if (crBps >= 15000) return 'Moderate';
  if (crBps >= 11000) return 'Risky';
  return 'Critical';
}
