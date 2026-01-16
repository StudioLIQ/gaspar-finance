/**
 * Frontend Constants
 *
 * Centralized location for all magic numbers and configuration values
 * used across the frontend application.
 */

// =============================================================================
// Gas & Transaction
// =============================================================================

/** Gas buffer for CSPR transactions (5 CSPR in motes) */
export const GAS_BUFFER_MOTES = BigInt('5000000000');

/** Deploy polling interval in milliseconds */
export const DEPLOY_POLL_INTERVAL_MS = 5000;

/** Maximum deploy poll attempts (5 minutes total at 5s intervals) */
export const DEPLOY_POLL_MAX_ATTEMPTS = 60;

/** Approval transaction poll attempts (2 minutes at 5s intervals) */
export const APPROVAL_POLL_MAX_ATTEMPTS = 24;

/** Standard timeout messages for transaction polling */
export const TX_TIMEOUT_MESSAGES = {
  approval: 'Approval confirmation timed out',
  transaction: 'Transaction confirmation timed out',
  request: 'Request confirmation timed out',
  claim: 'Claim confirmation timed out',
} as const;

// =============================================================================
// Data Refresh
// =============================================================================

/** Data refresh interval in milliseconds (30 seconds) */
export const DATA_REFRESH_INTERVAL_MS = 30_000;

// =============================================================================
// Staking
// =============================================================================

/** Minimum stake amount for CSPR (Casper network requirement: 500 CSPR) */
export const MIN_STAKE_CSPR_MOTES = BigInt('500000000000');

// =============================================================================
// Number Formatting
// =============================================================================

/** Default decimal places for token amounts */
export const DEFAULT_TOKEN_DECIMALS = 2;

/** Decimal places for prices */
export const PRICE_DECIMALS = 6;

/** Decimal places for percentages */
export const PERCENT_DECIMALS = 1;

// =============================================================================
// Collateral Ratio Thresholds (for UI color coding)
// =============================================================================

/** CR threshold for green (healthy) - 200% */
export const CR_HEALTHY_BPS = 20000;

/** CR threshold for yellow (caution) - 150% */
export const CR_CAUTION_BPS = 15000;

/** CR threshold for orange (warning) - 110% */
export const CR_WARNING_BPS = 11000;

// =============================================================================
// Interest Rate
// =============================================================================

/** Maximum interest rate (40%) */
export const MAX_INTEREST_RATE_PERCENT = 40;

/** Minimum interest rate (0%) */
export const MIN_INTEREST_RATE_PERCENT = 0;

/** Default interest rate (5%) */
export const DEFAULT_INTEREST_RATE_PERCENT = '5.0';
