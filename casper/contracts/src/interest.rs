//! Interest rate model for per-vault interest accrual.
//!
//! Implements LiquityV2-style per-vault interest rates with:
//! - Simple interest accrual (compounding can be added later)
//! - Rate bounded by protocol limits (0-40% APR)
//! - Accrual based on elapsed time since last update

use odra::prelude::*;
use odra::casper_types::U256;

/// Seconds in a year (365 days)
pub const SECONDS_PER_YEAR: u64 = 31_536_000;

/// Basis points scale (100% = 10000 bps)
pub const BPS_SCALE: u64 = 10_000;

/// Internal precision scale (1e18)
pub const PRECISION: u64 = 1_000_000_000_000_000_000;

/// Interest rate bounds configuration
#[odra::odra_type]
pub struct InterestRateConfig {
    /// Minimum interest rate in basis points (e.g., 0 = 0%)
    pub min_rate_bps: u32,
    /// Maximum interest rate in basis points (e.g., 4000 = 40%)
    pub max_rate_bps: u32,
}

impl Default for InterestRateConfig {
    fn default() -> Self {
        Self {
            min_rate_bps: 0,
            max_rate_bps: 4000, // 40% max APR
        }
    }
}

/// Interest accrual result
#[odra::odra_type]
pub struct AccrualResult {
    /// New debt amount after accrual
    pub new_debt: U256,
    /// Interest amount accrued
    pub interest_accrued: U256,
}

/// Calculate accrued interest for a vault
///
/// Uses simple interest formula: I = P * r * t
/// Where:
/// - P = principal (current debt)
/// - r = annual interest rate (as decimal)
/// - t = time elapsed (as fraction of year)
///
/// # Arguments
/// * `debt` - Current debt amount
/// * `interest_rate_bps` - Annual interest rate in basis points
/// * `last_accrual_timestamp` - Last time interest was accrued
/// * `current_timestamp` - Current block timestamp
///
/// # Returns
/// * `AccrualResult` containing new debt and interest accrued
pub fn accrue_interest(
    debt: U256,
    interest_rate_bps: u32,
    last_accrual_timestamp: u64,
    current_timestamp: u64,
) -> AccrualResult {
    // No accrual if no time has passed
    if current_timestamp <= last_accrual_timestamp {
        return AccrualResult {
            new_debt: debt,
            interest_accrued: U256::zero(),
        };
    }

    // No accrual if no debt or zero interest rate
    if debt.is_zero() || interest_rate_bps == 0 {
        return AccrualResult {
            new_debt: debt,
            interest_accrued: U256::zero(),
        };
    }

    // Calculate time elapsed in seconds
    let elapsed_seconds = current_timestamp - last_accrual_timestamp;

    // Calculate interest: debt * rate_bps * elapsed / (BPS_SCALE * SECONDS_PER_YEAR)
    // Using high precision to avoid rounding errors
    let interest = debt
        .checked_mul(U256::from(interest_rate_bps))
        .and_then(|v| v.checked_mul(U256::from(elapsed_seconds)))
        .and_then(|v| v.checked_div(U256::from(BPS_SCALE)))
        .and_then(|v| v.checked_div(U256::from(SECONDS_PER_YEAR)))
        .unwrap_or(U256::zero());

    let new_debt = debt + interest;

    AccrualResult {
        new_debt,
        interest_accrued: interest,
    }
}

/// Validate interest rate is within bounds
pub fn validate_interest_rate(rate_bps: u32, config: &InterestRateConfig) -> bool {
    rate_bps >= config.min_rate_bps && rate_bps <= config.max_rate_bps
}

/// Get effective annual rate as a fraction of 1e18
/// Useful for display and calculations
pub fn rate_bps_to_fraction(rate_bps: u32) -> U256 {
    // Convert bps to fraction: rate_bps * 1e18 / 10000
    U256::from(rate_bps) * U256::from(PRECISION) / U256::from(BPS_SCALE)
}

/// Calculate interest rate multiplier for a given time period
/// Returns (1 + r * t) scaled by PRECISION
pub fn calculate_interest_multiplier(
    interest_rate_bps: u32,
    elapsed_seconds: u64,
) -> U256 {
    // multiplier = 1 + (rate_bps * elapsed) / (BPS_SCALE * SECONDS_PER_YEAR)
    // Scaled by PRECISION for accuracy
    let rate_component = U256::from(interest_rate_bps)
        .checked_mul(U256::from(elapsed_seconds))
        .and_then(|v| v.checked_mul(U256::from(PRECISION)))
        .and_then(|v| v.checked_div(U256::from(BPS_SCALE)))
        .and_then(|v| v.checked_div(U256::from(SECONDS_PER_YEAR)))
        .unwrap_or(U256::zero());

    U256::from(PRECISION) + rate_component
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_accrual_when_no_time() {
        let result = accrue_interest(
            U256::from(1000u64) * U256::from(PRECISION),
            500, // 5% APR
            1000,
            1000, // Same timestamp
        );
        assert_eq!(result.interest_accrued, U256::zero());
        assert_eq!(result.new_debt, U256::from(1000u64) * U256::from(PRECISION));
    }

    #[test]
    fn test_no_accrual_when_zero_debt() {
        let result = accrue_interest(
            U256::zero(),
            500, // 5% APR
            1000,
            1000 + SECONDS_PER_YEAR, // One year later
        );
        assert_eq!(result.interest_accrued, U256::zero());
        assert_eq!(result.new_debt, U256::zero());
    }

    #[test]
    fn test_no_accrual_when_zero_rate() {
        let result = accrue_interest(
            U256::from(1000u64) * U256::from(PRECISION),
            0, // 0% APR
            1000,
            1000 + SECONDS_PER_YEAR, // One year later
        );
        assert_eq!(result.interest_accrued, U256::zero());
    }

    #[test]
    fn test_simple_interest_one_year() {
        // 1000 tokens at 5% APR for 1 year = 50 tokens interest
        let debt = U256::from(1000u64) * U256::from(PRECISION);
        let result = accrue_interest(
            debt,
            500, // 5% APR (500 bps)
            1000,
            1000 + SECONDS_PER_YEAR,
        );

        // Expected: 1000 * 0.05 = 50
        let expected_interest = U256::from(50u64) * U256::from(PRECISION);
        assert_eq!(result.interest_accrued, expected_interest);
        assert_eq!(result.new_debt, debt + expected_interest);
    }

    #[test]
    fn test_validate_interest_rate() {
        let config = InterestRateConfig::default();

        assert!(validate_interest_rate(0, &config));
        assert!(validate_interest_rate(2000, &config));
        assert!(validate_interest_rate(4000, &config));
        assert!(!validate_interest_rate(4001, &config));
    }

    #[test]
    fn test_rate_to_fraction() {
        // 5% = 500 bps = 0.05 * 1e18
        let fraction = rate_bps_to_fraction(500);
        let expected = U256::from(50_000_000_000_000_000u64); // 0.05 * 1e18
        assert_eq!(fraction, expected);
    }
}
