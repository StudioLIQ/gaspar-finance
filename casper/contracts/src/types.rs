//! Common types used across the CDP protocol.

use odra::prelude::*;
use odra::casper_types::U256;

/// Collateral type identifier
#[odra::odra_type]
#[derive(Copy, PartialOrd, Ord)]
pub enum CollateralId {
    /// Native CSPR
    Cspr,
    /// Staked CSPR (CEP-18 token)
    SCSPR,
}

/// Oracle price status
#[odra::odra_type]
#[derive(Copy)]
pub enum OracleStatus {
    /// Price is valid and fresh
    Ok,
    /// Price data unavailable
    Unavailable,
    /// Price data is stale (age > MAX_PRICE_AGE_SECONDS)
    Stale,
    /// Price deviation exceeds MAX_DEVIATION_BPS from last_good_price
    Deviation,
    /// Rate is invalid (zero or abnormal)
    InvalidRate,
    /// Decimals mismatch detected
    DecimalsMismatch,
}

/// Price data returned by oracle
#[odra::odra_type]
pub struct PriceData {
    /// Integer price value
    pub price_int: U256,
    /// Decimal places for price_int
    pub price_decimals: u8,
    /// Timestamp in seconds
    pub timestamp_sec: u64,
    /// Price status
    pub status: OracleStatus,
}

/// Vault data structure
#[odra::odra_type]
pub struct VaultData {
    /// Owner address
    pub owner: Address,
    /// Collateral type
    pub collateral_id: CollateralId,
    /// Collateral amount (in smallest unit)
    pub collateral: U256,
    /// Debt amount (gUSD, in smallest unit)
    pub debt: U256,
    /// Interest rate in basis points (0-10000 = 0-100%)
    pub interest_rate_bps: u32,
    /// Last interest accrual timestamp
    pub last_accrual_timestamp: u64,
}

/// Unique vault identifier within a collateral branch.
///
/// A vault is identified by `(owner, id)` so a single owner can open multiple vaults.
#[odra::odra_type]
#[derive(Copy)]
pub struct VaultKey {
    /// Owner address
    pub owner: Address,
    /// Vault id (unique per owner, per collateral branch)
    pub id: u64,
}

/// Index key for per-user vault id list.
#[odra::odra_type]
#[derive(Copy)]
pub struct UserVaultIndex {
    /// Owner address
    pub owner: Address,
    /// 0-based index into the owner's active vault list
    pub index: u64,
}

/// Interest rate bounds (configurable)
#[odra::odra_type]
pub struct InterestRateBounds {
    /// Minimum interest rate in bps
    pub min_bps: u32,
    /// Maximum interest rate in bps
    pub max_bps: u32,
}

/// Protocol configuration parameters
#[odra::odra_type]
pub struct ProtocolConfig {
    /// Minimum Collateralization Ratio in bps (e.g., 11000 = 110%)
    pub mcr_bps: u32,
    /// Minimum debt amount (in stablecoin smallest unit)
    pub min_debt: U256,
    /// Borrowing fee in bps
    pub borrowing_fee_bps: u32,
    /// Redemption fee in bps
    pub redemption_fee_bps: u32,
    /// Liquidation penalty in bps
    pub liquidation_penalty_bps: u32,
    /// Interest rate bounds
    pub interest_rate_bounds: InterestRateBounds,
}

/// Safe mode state
#[odra::odra_type]
pub struct SafeModeState {
    /// Whether safe mode is active (latched on oracle failure)
    pub is_active: bool,
    /// Timestamp when safe mode was triggered
    pub triggered_at: u64,
    /// Reason for safe mode activation
    pub reason: OracleStatus,
}
