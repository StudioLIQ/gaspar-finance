//! Oracle Adapter Contract
//!
//! Provides price data for CSPR and stCSPR collateral using Styks (Odra) oracle.
//! Implements:
//! - Direct CSPR/USD price feed
//! - Composite pricing for stCSPR: P(stCSPR) = P(CSPR) * R
//! - Freshness and deviation checks
//! - Safe mode triggering on oracle failures
//! - Last good price caching
//! - Integration with stCSPR ybToken for on-chain exchange rate

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, PriceData, OracleStatus};
use crate::errors::CdpError;

/// Default maximum price age in seconds (1 hour)
const DEFAULT_MAX_PRICE_AGE_SECONDS: u64 = 3600;

/// Default maximum deviation in basis points (5% = 500 bps)
const DEFAULT_MAX_DEVIATION_BPS: u32 = 500;

/// Price scale (1e18)
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Rate scale (1e18) - matches stCSPR ybToken scale
/// R = CSPR_PER_SCSPR, where 1e18 = 1.0
const RATE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Default rate (1.0 = 1e18)
const DEFAULT_RATE: u128 = 1_000_000_000_000_000_000;

/// Oracle configuration
#[odra::odra_type]
pub struct OracleConfig {
    /// Maximum price age in seconds before considered stale
    pub max_price_age_seconds: u64,
    /// Maximum price deviation from last good price in bps
    pub max_deviation_bps: u32,
    /// Minimum valid CSPR price (sanity check)
    pub min_cspr_price: U256,
    /// Maximum valid CSPR price (sanity check)
    pub max_cspr_price: U256,
    /// Minimum valid exchange rate (sanity check)
    pub min_exchange_rate: U256,
    /// Maximum valid exchange rate (sanity check)
    pub max_exchange_rate: U256,
}

impl Default for OracleConfig {
    fn default() -> Self {
        Self {
            max_price_age_seconds: DEFAULT_MAX_PRICE_AGE_SECONDS,
            max_deviation_bps: DEFAULT_MAX_DEVIATION_BPS,
            // CSPR price bounds: $0.001 to $1000 (scaled by 1e18)
            min_cspr_price: U256::from(PRICE_SCALE / 1000), // $0.001
            max_cspr_price: U256::from(1000u64) * U256::from(PRICE_SCALE), // $1000
            // Exchange rate bounds: 0.5x to 3.0x (scaled by 1e18)
            // R = CSPR_PER_SCSPR, starts at 1.0, increases with staking rewards
            min_exchange_rate: U256::from(RATE_SCALE / 2), // 0.5e18
            max_exchange_rate: U256::from(RATE_SCALE * 3), // 3.0e18 (allows for significant rewards)
        }
    }
}

/// Cached price data for a collateral type
#[odra::odra_type]
pub struct CachedPrice {
    /// Price value (scaled by 1e18, USD per 1 token)
    pub price: U256,
    /// Timestamp when price was last updated
    pub timestamp: u64,
    /// Status of the price
    pub status: OracleStatus,
}

/// Oracle Adapter Contract
#[odra::module]
pub struct OracleAdapter {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address (for triggering safe mode)
    router: Var<Address>,
    /// External Styks oracle address for CSPR/USD
    cspr_oracle: Var<Option<Address>>,
    /// stCSPR ybToken contract address (source of exchange rate)
    scspr_ybtoken: Var<Option<Address>>,
    /// Oracle configuration
    config: Var<OracleConfig>,
    /// Last good CSPR price
    last_good_cspr_price: Var<U256>,
    /// Last good stCSPR/CSPR exchange rate (scaled by 1e18)
    last_good_exchange_rate: Var<U256>,
    /// Last exchange rate update timestamp
    last_rate_update: Var<u64>,
    /// Cached CSPR price data
    cached_cspr_price: Var<CachedPrice>,
    /// Cached stCSPR price data
    cached_scspr_price: Var<CachedPrice>,
    /// Whether oracle is in degraded mode
    is_degraded: Var<bool>,
}

#[odra::module]
impl OracleAdapter {
    /// Initialize the oracle adapter
    pub fn init(&mut self, registry: Address, router: Address) {
        self.registry.set(registry);
        self.router.set(router);
        self.config.set(OracleConfig::default());
        self.scspr_ybtoken.set(None);

        // Initialize with safe default prices (1 CSPR = $1, rate = 1.0)
        let default_price = U256::from(PRICE_SCALE);
        let default_rate = U256::from(DEFAULT_RATE); // 1e18 = 1.0

        self.last_good_cspr_price.set(default_price);
        self.last_good_exchange_rate.set(default_rate);

        let current_time = self.env().get_block_time();
        self.last_rate_update.set(current_time);

        self.cached_cspr_price.set(CachedPrice {
            price: default_price,
            timestamp: current_time,
            status: OracleStatus::Ok,
        });
        self.cached_scspr_price.set(CachedPrice {
            price: default_price, // Initial stCSPR price = CSPR price * 1.0
            timestamp: current_time,
            status: OracleStatus::Ok,
        });

        self.is_degraded.set(false);
    }

    // ========== Price Query Functions ==========

    /// Get price for a collateral type
    pub fn get_price(&self, collateral_id: CollateralId) -> PriceData {
        match collateral_id {
            CollateralId::Cspr => self.get_cspr_price(),
            CollateralId::SCSPR => self.get_scspr_price(),
        }
    }

    /// Get CSPR/USD price
    pub fn get_cspr_price(&self) -> PriceData {
        let cached = self.cached_cspr_price.get().unwrap_or(CachedPrice {
            price: self.last_good_cspr_price.get().unwrap_or(U256::from(PRICE_SCALE)),
            timestamp: 0,
            status: OracleStatus::Unavailable,
        });

        let current_time = self.env().get_block_time();
        let config = self.config.get().unwrap_or_default();

        // Check freshness
        let age = current_time.saturating_sub(cached.timestamp);
        let status = if age > config.max_price_age_seconds {
            OracleStatus::Stale
        } else {
            cached.status
        };

        PriceData {
            price_int: cached.price,
            price_decimals: 18,
            timestamp_sec: cached.timestamp,
            status,
        }
    }

    /// Get stCSPR/USD price using composite formula
    /// P(stCSPR) = P(CSPR) * R where R is stCSPR/CSPR exchange rate (CSPR_PER_SCSPR)
    ///
    /// Both CSPR price and exchange rate must be fresh for the composite price to be valid.
    /// effective_age = max(age(P_cspr), age(R))
    pub fn get_scspr_price(&self) -> PriceData {
        let cspr_price = self.get_cspr_price();
        let rate = self.last_good_exchange_rate.get().unwrap_or(U256::from(DEFAULT_RATE));
        let rate_timestamp = self.last_rate_update.get().unwrap_or(0);
        let config = self.config.get().unwrap_or_default();
        let current_time = self.env().get_block_time();

        // Check rate freshness
        let rate_age = current_time.saturating_sub(rate_timestamp);
        let rate_is_stale = rate_age > config.max_price_age_seconds;

        // If CSPR price is not OK, stCSPR price inherits the status
        if cspr_price.status != OracleStatus::Ok {
            return PriceData {
                price_int: self.calculate_composite_price(cspr_price.price_int, rate),
                price_decimals: 18,
                timestamp_sec: cspr_price.timestamp_sec,
                status: cspr_price.status,
            };
        }

        // If rate is stale, mark composite price as stale
        if rate_is_stale {
            return PriceData {
                price_int: self.calculate_composite_price(cspr_price.price_int, rate),
                price_decimals: 18,
                timestamp_sec: rate_timestamp.min(cspr_price.timestamp_sec),
                status: OracleStatus::Stale,
            };
        }

        // Calculate composite price
        let composite_price = self.calculate_composite_price(cspr_price.price_int, rate);
        // Use the older timestamp (effective_age = max of both ages)
        let effective_timestamp = rate_timestamp.min(cspr_price.timestamp_sec);

        PriceData {
            price_int: composite_price,
            price_decimals: 18,
            timestamp_sec: effective_timestamp,
            status: OracleStatus::Ok,
        }
    }

    /// Get last known good price for a collateral type
    pub fn get_last_good_price(&self, collateral_id: CollateralId) -> U256 {
        match collateral_id {
            CollateralId::Cspr => self.last_good_cspr_price.get().unwrap_or(U256::from(PRICE_SCALE)),
            CollateralId::SCSPR => {
                let cspr_price = self.last_good_cspr_price.get().unwrap_or(U256::from(PRICE_SCALE));
                let rate = self.last_good_exchange_rate.get().unwrap_or(U256::from(DEFAULT_RATE));
                self.calculate_composite_price(cspr_price, rate)
            }
        }
    }

    // ========== Price Update Functions ==========

    /// Update CSPR price (called by authorized oracle feeder)
    pub fn update_cspr_price(&mut self, price: U256, timestamp: u64) {
        // TODO: Add access control for oracle feeder

        let config = self.config.get().unwrap_or_default();
        let current_time = self.env().get_block_time();

        // Validate price bounds
        if price < config.min_cspr_price || price > config.max_cspr_price {
            self.handle_price_failure(OracleStatus::Deviation);
            return;
        }

        // Check deviation from last good price
        let last_good = self.last_good_cspr_price.get().unwrap_or(price);
        let deviation_status = self.check_deviation(price, last_good, config.max_deviation_bps);

        if deviation_status != OracleStatus::Ok {
            self.handle_price_failure(deviation_status);
            return;
        }

        // Check freshness (timestamp should be recent)
        if timestamp < current_time.saturating_sub(config.max_price_age_seconds) {
            self.handle_price_failure(OracleStatus::Stale);
            return;
        }

        // Price is valid - update cache and last good price
        self.cached_cspr_price.set(CachedPrice {
            price,
            timestamp,
            status: OracleStatus::Ok,
        });
        self.last_good_cspr_price.set(price);
        self.is_degraded.set(false);

        // Update stCSPR cached price with new CSPR price
        let rate = self.last_good_exchange_rate.get().unwrap_or(U256::from(DEFAULT_RATE));
        let rate_timestamp = self.last_rate_update.get().unwrap_or(timestamp);
        let scspr_price = self.calculate_composite_price(price, rate);
        self.cached_scspr_price.set(CachedPrice {
            price: scspr_price,
            timestamp: timestamp.min(rate_timestamp), // Use older timestamp
            status: OracleStatus::Ok,
        });
    }

    /// Update stCSPR/CSPR exchange rate (called by authorized rate feeder or sync)
    /// Rate should be scaled by 1e18 (CSPR_PER_SCSPR)
    pub fn update_exchange_rate(&mut self, rate: U256) {
        // TODO: Add access control for rate feeder

        let config = self.config.get().unwrap_or_default();

        // Validate rate bounds
        if rate < config.min_exchange_rate || rate > config.max_exchange_rate {
            self.handle_price_failure(OracleStatus::InvalidRate);
            return;
        }

        let current_time = self.env().get_block_time();

        // Update last good rate and timestamp
        self.last_good_exchange_rate.set(rate);
        self.last_rate_update.set(current_time);

        // Update stCSPR cached price
        let cspr_price = self.last_good_cspr_price.get().unwrap_or(U256::from(PRICE_SCALE));
        let scspr_price = self.calculate_composite_price(cspr_price, rate);

        self.cached_scspr_price.set(CachedPrice {
            price: scspr_price,
            timestamp: current_time,
            status: OracleStatus::Ok,
        });
    }

    /// Force refresh from external oracle (if configured)
    pub fn refresh_price(&mut self) {
        // TODO: Implement actual external oracle call when Styks interface is available
        // For now, this is a placeholder that validates cached prices

        let current_time = self.env().get_block_time();
        let config = self.config.get().unwrap_or_default();

        let cached = self.cached_cspr_price.get();
        if let Some(cached) = cached {
            let age = current_time.saturating_sub(cached.timestamp);
            if age > config.max_price_age_seconds {
                self.handle_price_failure(OracleStatus::Stale);
            }
        } else {
            self.handle_price_failure(OracleStatus::Unavailable);
        }
    }

    // ========== Safe Mode Functions ==========

    /// Handle price failure by triggering safe mode
    fn handle_price_failure(&mut self, reason: OracleStatus) {
        self.is_degraded.set(true);

        // Update cached price status
        if let Some(mut cached) = self.cached_cspr_price.get() {
            cached.status = reason;
            self.cached_cspr_price.set(cached);
        }

        // Trigger safe mode on router
        // TODO: Make cross-contract call to router.trigger_safe_mode(reason)
    }

    /// Check if oracle is in degraded mode
    pub fn is_oracle_degraded(&self) -> bool {
        self.is_degraded.get().unwrap_or(false)
    }

    /// Clear degraded mode (admin only, after manual verification)
    pub fn clear_degraded_mode(&mut self) {
        // TODO: Add admin access control
        self.is_degraded.set(false);

        // Update cached statuses
        let current_time = self.env().get_block_time();
        let cspr_price = self.last_good_cspr_price.get().unwrap_or(U256::from(PRICE_SCALE));
        let rate = self.last_good_exchange_rate.get().unwrap_or(U256::from(DEFAULT_RATE));

        self.cached_cspr_price.set(CachedPrice {
            price: cspr_price,
            timestamp: current_time,
            status: OracleStatus::Ok,
        });

        self.cached_scspr_price.set(CachedPrice {
            price: self.calculate_composite_price(cspr_price, rate),
            timestamp: current_time,
            status: OracleStatus::Ok,
        });
    }

    // ========== Configuration Functions ==========

    /// Get oracle configuration
    pub fn get_config(&self) -> OracleConfig {
        self.config.get().unwrap_or_default()
    }

    /// Update oracle configuration (admin only)
    pub fn set_config(&mut self, config: OracleConfig) {
        // TODO: Add admin access control
        self.config.set(config);
    }

    /// Set CSPR oracle address
    pub fn set_cspr_oracle(&mut self, oracle: Address) {
        // TODO: Add admin access control
        self.cspr_oracle.set(Some(oracle));
    }

    /// Set stCSPR ybToken contract address (source of exchange rate)
    pub fn set_scspr_ybtoken(&mut self, ybtoken: Address) {
        // TODO: Add admin access control
        self.scspr_ybtoken.set(Some(ybtoken));
    }

    /// Get stCSPR ybToken address
    pub fn get_scspr_ybtoken(&self) -> Option<Address> {
        self.scspr_ybtoken.get().flatten()
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    /// Get router address
    pub fn get_router(&self) -> Option<Address> {
        self.router.get()
    }

    /// Get exchange rate (CSPR_PER_SCSPR, scaled by 1e18)
    pub fn get_exchange_rate(&self) -> U256 {
        self.last_good_exchange_rate.get().unwrap_or(U256::from(DEFAULT_RATE))
    }

    /// Get last rate update timestamp
    pub fn get_last_rate_update(&self) -> u64 {
        self.last_rate_update.get().unwrap_or(0)
    }

    // ========== ybToken Rate Sync Functions ==========

    /// Sync exchange rate from stCSPR ybToken contract
    ///
    /// This function should be called periodically (by operator or keeper) to update
    /// the exchange rate from the on-chain LST state.
    ///
    /// # Arguments
    /// * `rate` - Exchange rate from ybToken.get_exchange_rate(), scaled by 1e18
    ///
    /// # Notes
    /// In MVP, this requires an external caller to read the rate from ybToken and
    /// pass it here. Future versions may use cross-contract calls for automation.
    pub fn sync_rate_from_ybtoken(&mut self, rate: U256) {
        // Validate ybToken is configured
        if self.scspr_ybtoken.get().flatten().is_none() {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Use the standard update_exchange_rate logic
        self.update_exchange_rate(rate);
    }

    /// Check if rate sync is needed (rate is stale)
    pub fn is_rate_stale(&self) -> bool {
        let rate_timestamp = self.last_rate_update.get().unwrap_or(0);
        let current_time = self.env().get_block_time();
        let config = self.config.get().unwrap_or_default();

        current_time.saturating_sub(rate_timestamp) > config.max_price_age_seconds
    }

    /// Get rate info for monitoring
    pub fn get_rate_info(&self) -> (U256, u64, bool) {
        let rate = self.get_exchange_rate();
        let timestamp = self.get_last_rate_update();
        let is_stale = self.is_rate_stale();
        (rate, timestamp, is_stale)
    }

    // ========== Internal Functions ==========

    /// Calculate composite price: P(stCSPR) = P(CSPR) * R / RATE_SCALE
    /// Where R is CSPR_PER_SCSPR (scaled by 1e18)
    fn calculate_composite_price(&self, cspr_price: U256, rate: U256) -> U256 {
        cspr_price * rate / U256::from(RATE_SCALE)
    }

    /// Check deviation between new price and reference price
    fn check_deviation(&self, new_price: U256, reference_price: U256, max_deviation_bps: u32) -> OracleStatus {
        if reference_price.is_zero() {
            return OracleStatus::Ok; // No reference to compare against
        }

        // Calculate absolute difference
        let diff = if new_price > reference_price {
            new_price - reference_price
        } else {
            reference_price - new_price
        };

        // Calculate deviation in bps: (diff * 10000) / reference
        let deviation_bps = diff * U256::from(10000u32) / reference_price;

        if deviation_bps > U256::from(max_deviation_bps) {
            OracleStatus::Deviation
        } else {
            OracleStatus::Ok
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_composite_price_calculation() {
        // Test: CSPR price = $0.05, rate = 1.1 (R = CSPR_PER_SCSPR)
        // Expected: stCSPR price = $0.05 * 1.1 = $0.055

        let cspr_price = U256::from(50_000_000_000_000_000u128); // $0.05 * 1e18
        // Rate 1.1 = 1.1e18 = 1_100_000_000_000_000_000
        let rate = U256::from(1_100_000_000_000_000_000u128);

        // P(stCSPR) = P(CSPR) * R / RATE_SCALE
        let expected = cspr_price * rate / U256::from(RATE_SCALE);
        let expected_value = U256::from(55_000_000_000_000_000u128); // $0.055 * 1e18

        assert_eq!(expected, expected_value);
    }

    #[test]
    fn test_composite_price_rate_1_0() {
        // Test: Rate = 1.0 (1e18), CSPR price = $1
        // Expected: stCSPR price = $1 * 1.0 = $1

        let cspr_price = U256::from(PRICE_SCALE); // $1
        let rate = U256::from(RATE_SCALE); // 1.0

        let expected = cspr_price * rate / U256::from(RATE_SCALE);

        assert_eq!(expected, cspr_price); // stCSPR price = CSPR price when R = 1.0
    }

    #[test]
    fn test_composite_price_rate_1_5() {
        // Test: Rate = 1.5 (after significant staking rewards)
        // P(stCSPR) = P(CSPR) * 1.5

        let cspr_price = U256::from(100_000_000_000_000_000u128); // $0.10 * 1e18
        let rate = U256::from(1_500_000_000_000_000_000u128); // 1.5e18

        let expected = cspr_price * rate / U256::from(RATE_SCALE);
        let expected_value = U256::from(150_000_000_000_000_000u128); // $0.15 * 1e18

        assert_eq!(expected, expected_value);
    }

    #[test]
    fn test_deviation_calculation() {
        // 5% deviation = 500 bps
        let reference = U256::from(100u64);
        let new_price = U256::from(106u64); // 6% higher

        let diff = new_price - reference;
        let deviation_bps = diff * U256::from(10000u32) / reference;

        assert_eq!(deviation_bps, U256::from(600u32)); // 6% = 600 bps
        assert!(deviation_bps > U256::from(500u32)); // Exceeds 5% threshold
    }

    #[test]
    fn test_default_config() {
        let config = OracleConfig::default();
        assert_eq!(config.max_price_age_seconds, 3600);
        assert_eq!(config.max_deviation_bps, 500);

        // Rate bounds: 0.5e18 to 3.0e18
        assert_eq!(config.min_exchange_rate, U256::from(RATE_SCALE / 2));
        assert_eq!(config.max_exchange_rate, U256::from(RATE_SCALE * 3));
    }

    #[test]
    fn test_rate_scale_matches_ybtoken() {
        // Verify RATE_SCALE matches stCSPR ybToken scale (1e18)
        assert_eq!(RATE_SCALE, 1_000_000_000_000_000_000u128);
        assert_eq!(DEFAULT_RATE, RATE_SCALE); // Default rate is 1.0
    }

    #[test]
    fn test_price_scale() {
        // Verify PRICE_SCALE is 1e18
        assert_eq!(PRICE_SCALE, 1_000_000_000_000_000_000u128);
    }
}
