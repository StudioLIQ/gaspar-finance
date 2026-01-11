//! Styks Oracle Integration
//!
//! Direct integration with Styks (Odra) price feed for CSPR/USD.
//! https://styks.odra.dev/

use odra::prelude::*;
use odra::casper_types::U256;
use odra::casper_types::runtime_args;

use crate::types::CollateralId;

/// Styks price feed contract address (Casper Testnet)
/// Contract package: 2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc
pub const STYKS_TESTNET_PACKAGE: &str = "2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc";

/// Price feed IDs used by Styks
pub const CSPR_USD_FEED_ID: &str = "CSPRUSD";

/// Price scale (1e18 for USD prices)
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Exchange rate scale (1e18)
pub const RATE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Default CSPR price if oracle unavailable ($0.02)
pub const DEFAULT_CSPR_PRICE: u128 = 20_000_000_000_000_000; // 0.02 * 1e18

/// Styks TWAP price data structure
#[odra::odra_type]
pub struct StyksTwapPrice {
    /// Price value (scaled)
    pub price: U256,
    /// Timestamp of last update
    pub timestamp: u64,
    /// Number of data points in TWAP
    pub num_observations: u32,
}

/// Styks Oracle trait for cross-contract calls
#[odra::external_contract]
pub trait StyksPriceFeed {
    /// Get TWAP price for a feed ID
    fn get_twap_price(&self, price_feed_id: String) -> Option<StyksTwapPrice>;
}

/// Helper module for Styks oracle queries
pub struct StyksOracle;

impl StyksOracle {
    /// Get CSPR/USD price from Styks
    /// Returns price scaled by 1e18, or default if unavailable
    pub fn get_cspr_price(env: &odra::ContractEnv, styks_address: Address) -> U256 {
        let args = runtime_args! {
            "price_feed_id" => CSPR_USD_FEED_ID.to_string()
        };

        let call_def = odra::CallDef::new("get_twap_price", false, args);

        match env.call_contract::<Option<StyksTwapPrice>>(styks_address, call_def) {
            Some(price_data) => price_data.price,
            None => U256::from(DEFAULT_CSPR_PRICE),
        }
    }

    /// Get stCSPR/USD price using composite formula
    /// P(stCSPR) = P(CSPR) * exchange_rate / RATE_SCALE
    pub fn get_scspr_price(
        env: &odra::ContractEnv,
        styks_address: Address,
        exchange_rate: U256,
    ) -> U256 {
        let cspr_price = Self::get_cspr_price(env, styks_address);
        cspr_price * exchange_rate / U256::from(RATE_SCALE)
    }

    /// Get price for any collateral type
    pub fn get_price(
        env: &odra::ContractEnv,
        styks_address: Address,
        collateral_id: CollateralId,
        scspr_exchange_rate: Option<U256>,
    ) -> U256 {
        match collateral_id {
            CollateralId::Cspr => Self::get_cspr_price(env, styks_address),
            CollateralId::SCSPR => {
                let rate = scspr_exchange_rate.unwrap_or(U256::from(RATE_SCALE));
                Self::get_scspr_price(env, styks_address, rate)
            }
        }
    }
}
