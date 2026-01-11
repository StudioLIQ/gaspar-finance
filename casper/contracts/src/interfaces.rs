//! Shared interfaces for the CDP protocol.
//!
//! Defines traits that both BranchCSPR and BranchSCSPR implement.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, VaultData, SafeModeState};

/// Result type for branch operations
pub type BranchResult<T> = Result<T, crate::errors::CdpError>;

/// Parameters for opening a new vault
#[odra::odra_type]
pub struct OpenVaultParams {
    /// Amount of collateral to deposit
    pub collateral_amount: U256,
    /// Amount of debt (gUSD) to mint
    pub debt_amount: U256,
    /// Interest rate in basis points
    pub interest_rate_bps: u32,
}

/// Parameters for adjusting an existing vault
#[odra::odra_type]
pub struct AdjustVaultParams {
    /// Collateral delta (positive = add, negative value via is_withdraw flag)
    pub collateral_delta: U256,
    /// Whether to withdraw collateral (true) or add (false)
    pub collateral_is_withdraw: bool,
    /// Debt delta (positive = borrow, negative value via is_repay flag)
    pub debt_delta: U256,
    /// Whether to repay debt (true) or borrow (false)
    pub debt_is_repay: bool,
}

/// Branch status information
#[odra::odra_type]
pub struct BranchStatus {
    /// Collateral type
    pub collateral_id: CollateralId,
    /// Total collateral in the branch
    pub total_collateral: U256,
    /// Total debt in the branch
    pub total_debt: U256,
    /// Number of active vaults
    pub vault_count: u64,
    /// Safe mode state
    pub safe_mode: SafeModeState,
}

/// Vault query result
#[odra::odra_type]
pub struct VaultInfo {
    /// Full vault data
    pub vault: VaultData,
    /// Current Individual Collateralization Ratio in bps
    pub icr_bps: u32,
    /// Current collateral value in USD (scaled)
    pub collateral_value_usd: U256,
}

/// Collateral configuration for a branch
#[odra::odra_type]
pub struct CollateralConfig {
    /// Collateral type identifier
    pub collateral_id: CollateralId,
    /// Branch contract address
    pub branch_address: Address,
    /// Whether this collateral is active
    pub is_active: bool,
    /// Token contract address (None for native CSPR)
    pub token_address: Option<Address>,
    /// Decimals for the collateral
    pub decimals: u8,
    /// Minimum collateralization ratio in bps
    pub mcr_bps: u32,
}
