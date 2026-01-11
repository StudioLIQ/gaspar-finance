//! Redemption Engine Contract
//!
//! Allows users to redeem gUSD for collateral at face value ($1 per gUSD).
//! Redemptions are processed in order of ascending interest rate (low APR first).
//!
//! Key mechanics:
//! - Redeemer sends gUSD, receives collateral minus fee
//! - Vaults are redeemed starting with lowest interest rate
//! - Redemption fee goes to treasury
//! - Partial vault redemption supported
//!
//! Safe mode restrictions:
//! - Redemptions: BLOCKED when safe_mode is active

use odra::prelude::*;
use odra::casper_types::{U256, U512, RuntimeArgs, runtime_args};
use odra::CallDef;
use crate::types::{CollateralId, OracleStatus, SafeModeState};
use crate::errors::CdpError;
use crate::styks_oracle::StyksOracle;

/// gUSD stablecoin interface
#[odra::external_contract]
pub trait GUsd {
    fn burn_with_allowance(&mut self, from: Address, amount: U256);
    fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) -> bool;
}

/// Branch interface for vault queries and updates
#[odra::external_contract]
pub trait Branch {
    fn get_collateral(&self, owner: Address) -> U256;
    fn get_debt(&self, owner: Address) -> U256;
    fn get_interest_rate_bps(&self, owner: Address) -> u32;
    fn reduce_collateral_for_redemption(&mut self, owner: Address, collateral_amount: U256, debt_amount: U256);
    fn get_sorted_vault_owners(&self, max_count: u32) -> Vec<Address>;
}

/// CEP-18 token interface for stCSPR
#[odra::external_contract]
pub trait Cep18 {
    fn transfer(&mut self, recipient: Address, amount: U256) -> bool;
}

/// Precision scale (1e18)
const SCALE: u64 = 1_000_000_000_000_000_000;

/// Basis points scale
const BPS_SCALE: u32 = 10000;

/// Base redemption fee in basis points (0.5% = 50 bps)
const BASE_REDEMPTION_FEE_BPS: u32 = 50;

/// Maximum redemption fee in basis points (5% = 500 bps)
const MAX_REDEMPTION_FEE_BPS: u32 = 500;

/// Minimum redemption amount (prevents dust redemptions)
const MIN_REDEMPTION: u64 = 1_000_000_000_000_000_000; // 1 gUSD

/// Redemption hint for efficient vault lookup
#[odra::odra_type]
#[derive(Default)]
pub struct RedemptionHint {
    /// First vault to try redeeming from
    pub first_vault_owner: Option<Address>,
    /// Expected interest rate of first vault
    pub expected_rate_bps: u32,
    /// Maximum number of vaults to process
    pub max_iterations: u32,
}

/// Result of a single vault redemption
#[odra::odra_type]
pub struct VaultRedemptionResult {
    /// Owner of the redeemed vault
    pub vault_owner: Address,
    /// Debt reduced from the vault
    pub debt_redeemed: U256,
    /// Collateral sent to redeemer
    pub collateral_sent: U256,
    /// Whether vault was fully redeemed (closed)
    pub fully_redeemed: bool,
}

/// Result of a redemption operation
#[odra::odra_type]
pub struct RedemptionResult {
    /// Total gUSD redeemed
    pub csprusd_redeemed: U256,
    /// Total collateral received (after fee)
    pub collateral_received: U256,
    /// Total fee paid
    pub fee_paid: U256,
    /// Number of vaults touched
    pub vaults_touched: u32,
}

/// Redemption statistics
#[odra::odra_type]
pub struct RedemptionStats {
    /// Total gUSD redeemed (cumulative)
    pub total_redeemed: U256,
    /// Total collateral distributed (cumulative)
    pub total_collateral_distributed: U256,
    /// Total fees collected (cumulative)
    pub total_fees_collected: U256,
    /// Total redemption operations
    pub total_redemptions: u64,
}

/// Redemption Engine Contract
#[odra::module]
pub struct RedemptionEngine {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address
    router: Var<Address>,
    /// Stablecoin (gUSD) contract address
    stablecoin: Var<Address>,
    /// Treasury contract address
    treasury: Var<Address>,
    /// Styks oracle contract address (direct price feed)
    styks_oracle: Var<Address>,
    /// stCSPR ybToken address (for exchange rate)
    scspr_ybtoken: Var<Address>,
    /// CSPR Branch contract address
    branch_cspr: Var<Address>,
    /// stCSPR Branch contract address
    branch_scspr: Var<Address>,
    /// stCSPR token address (for CEP-18 transfers)
    scspr_token: Var<Address>,
    /// Base redemption fee in bps
    base_fee_bps: Var<u32>,
    /// Maximum redemption fee in bps
    max_fee_bps: Var<u32>,
    /// Total gUSD redeemed
    total_redeemed: Var<U256>,
    /// Total collateral distributed
    total_collateral_distributed: Var<U256>,
    /// Total fees collected
    total_fees_collected: Var<U256>,
    /// Safe mode state
    safe_mode: Var<SafeModeState>,
}

#[odra::module]
impl RedemptionEngine {
    /// Initialize the redemption engine
    pub fn init(
        &mut self,
        registry: Address,
        router: Address,
        stablecoin: Address,
        treasury: Address,
        styks_oracle: Address,
    ) {
        self.registry.set(registry);
        self.router.set(router);
        self.stablecoin.set(stablecoin);
        self.treasury.set(treasury);
        self.styks_oracle.set(styks_oracle);

        // Initialize fee configuration
        self.base_fee_bps.set(BASE_REDEMPTION_FEE_BPS);
        self.max_fee_bps.set(MAX_REDEMPTION_FEE_BPS);

        // Initialize statistics
        self.total_redeemed.set(U256::zero());
        self.total_collateral_distributed.set(U256::zero());
        self.total_fees_collected.set(U256::zero());

        // Initialize safe mode
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    // ========== Admin Functions for Wiring ==========

    /// Set CSPR branch address
    pub fn set_branch_cspr(&mut self, branch: Address) {
        self.branch_cspr.set(branch);
    }

    /// Set stCSPR branch address
    pub fn set_branch_scspr(&mut self, branch: Address) {
        self.branch_scspr.set(branch);
    }

    /// Set stCSPR token address
    pub fn set_scspr_token(&mut self, scspr_token: Address) {
        self.scspr_token.set(scspr_token);
    }

    /// Set Styks oracle address
    pub fn set_styks_oracle(&mut self, styks_oracle: Address) {
        self.styks_oracle.set(styks_oracle);
    }

    /// Set stCSPR ybToken address (for exchange rate)
    pub fn set_scspr_ybtoken(&mut self, scspr_ybtoken: Address) {
        self.scspr_ybtoken.set(scspr_ybtoken);
    }

    // ========== Redemption Functions ==========

    /// Redeem gUSD for collateral
    /// Returns the collateral amount received after fees
    ///
    /// Note: Caller must have approved this contract to spend their gUSD.
    pub fn redeem(
        &mut self,
        collateral_id: CollateralId,
        csprusd_amount: U256,
        max_fee_bps: u32,
        hint: Option<RedemptionHint>,
    ) -> RedemptionResult {
        // Redemptions BLOCKED in safe mode
        self.require_not_safe_mode();

        // Validate amount
        if csprusd_amount < U256::from(MIN_REDEMPTION) {
            self.env().revert(CdpError::BelowMinDebt);
        }

        // Calculate fee
        let current_fee_bps = self.get_current_fee_bps();
        if current_fee_bps > max_fee_bps {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Get price from oracle
        let price = self.get_price(collateral_id);
        if price.is_zero() {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Calculate collateral amount before fee
        // collateral = csprusd_amount * SCALE / price
        let collateral_before_fee = csprusd_amount * U256::from(SCALE) / price;

        // Calculate fee
        let fee_amount = collateral_before_fee * U256::from(current_fee_bps) / U256::from(BPS_SCALE);
        let collateral_after_fee = collateral_before_fee - fee_amount;

        let redeemer = self.env().caller();

        // Process redemption against vaults (reduces vault collateral and debt)
        let vaults_touched = self.process_redemption(
            collateral_id,
            csprusd_amount,
            collateral_before_fee,
            hint.unwrap_or_default(),
        );

        // Burn gUSD from redeemer (requires approval)
        // Using transfer_from to burn address (zero address not supported, use treasury as burn sink)
        let stablecoin_addr = self.stablecoin.get().expect("stablecoin not set");
        let treasury_addr = self.treasury.get().expect("treasury not set");
        let burn_args = runtime_args! {
            "owner" => redeemer,
            "recipient" => treasury_addr,
            "amount" => csprusd_amount
        };
        let burn_call = CallDef::new("transfer_from", true, burn_args);
        let burn_success: bool = self.env().call_contract(stablecoin_addr, burn_call);
        if !burn_success {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        // Transfer collateral to redeemer
        self.transfer_collateral(collateral_id, redeemer, collateral_after_fee);

        // Transfer fee to treasury
        if !fee_amount.is_zero() {
            if let Some(treasury_addr) = self.treasury.get() {
                self.transfer_collateral(collateral_id, treasury_addr, fee_amount);
            }
        }

        // Update statistics
        let total_redeemed = self.total_redeemed.get().unwrap_or(U256::zero());
        self.total_redeemed.set(total_redeemed + csprusd_amount);

        let total_distributed = self.total_collateral_distributed.get().unwrap_or(U256::zero());
        self.total_collateral_distributed.set(total_distributed + collateral_after_fee);

        let total_fees = self.total_fees_collected.get().unwrap_or(U256::zero());
        self.total_fees_collected.set(total_fees + fee_amount);

        RedemptionResult {
            csprusd_redeemed: csprusd_amount,
            collateral_received: collateral_after_fee,
            fee_paid: fee_amount,
            vaults_touched,
        }
    }

    /// Frontend-friendly redeem using primitive types
    ///
    /// collateral_id: 0 = CSPR, 1 = stCSPR
    pub fn redeem_u8(
        &mut self,
        collateral_id: u8,
        csprusd_amount: U256,
        max_fee_bps: u32,
        max_iterations: u32,
    ) -> RedemptionResult {
        let coll_id = match collateral_id {
            0 => CollateralId::Cspr,
            1 => CollateralId::SCSPR,
            _ => self.env().revert(CdpError::UnsupportedCollateral),
        };

        let hint = RedemptionHint {
            first_vault_owner: None,
            expected_rate_bps: 0,
            max_iterations,
        };

        self.redeem(coll_id, csprusd_amount, max_fee_bps, Some(hint))
    }

    /// Redeem with slippage protection
    pub fn redeem_with_protection(
        &mut self,
        collateral_id: CollateralId,
        csprusd_amount: U256,
        min_collateral_out: U256,
        max_fee_bps: u32,
        hint: Option<RedemptionHint>,
    ) -> RedemptionResult {
        let result = self.redeem(collateral_id, csprusd_amount, max_fee_bps, hint);

        // Check slippage protection
        if result.collateral_received < min_collateral_out {
            self.env().revert(CdpError::InvalidConfig);
        }

        result
    }

    // ========== Query Functions ==========

    /// Get current redemption fee in basis points
    pub fn get_current_fee_bps(&self) -> u32 {
        let base_fee = self.base_fee_bps.get().unwrap_or(BASE_REDEMPTION_FEE_BPS);
        let max_fee = self.max_fee_bps.get().unwrap_or(MAX_REDEMPTION_FEE_BPS);

        // Simple fee model: base fee increases based on recent redemption activity
        // For now, return base fee (dynamic fee calculation can be added later)
        base_fee.min(max_fee)
    }

    /// Calculate expected collateral output for a given gUSD amount
    pub fn get_redemption_quote(
        &self,
        collateral_id: CollateralId,
        csprusd_amount: U256,
    ) -> (U256, U256) {
        let price = self.get_price(collateral_id);
        if price.is_zero() {
            return (U256::zero(), U256::zero());
        }

        let collateral_before_fee = csprusd_amount * U256::from(SCALE) / price;
        let fee_bps = self.get_current_fee_bps();
        let fee = collateral_before_fee * U256::from(fee_bps) / U256::from(BPS_SCALE);
        let collateral_after_fee = collateral_before_fee - fee;

        (collateral_after_fee, fee)
    }

    /// Get redemption statistics
    pub fn get_stats(&self) -> RedemptionStats {
        RedemptionStats {
            total_redeemed: self.total_redeemed.get().unwrap_or(U256::zero()),
            total_collateral_distributed: self.total_collateral_distributed.get().unwrap_or(U256::zero()),
            total_fees_collected: self.total_fees_collected.get().unwrap_or(U256::zero()),
            total_redemptions: 0, // Removed to reduce field count
        }
    }

    /// Get base fee
    pub fn get_base_fee_bps(&self) -> u32 {
        self.base_fee_bps.get().unwrap_or(BASE_REDEMPTION_FEE_BPS)
    }

    /// Get max fee
    pub fn get_max_fee_bps(&self) -> u32 {
        self.max_fee_bps.get().unwrap_or(MAX_REDEMPTION_FEE_BPS)
    }

    // ========== Frontend-Friendly State Access ==========

    /// Get total gUSD redeemed (primitive return for frontend)
    pub fn get_total_redeemed(&self) -> U256 {
        self.total_redeemed.get().unwrap_or(U256::zero())
    }

    /// Get total collateral distributed (primitive return for frontend)
    pub fn get_total_collateral_distributed(&self) -> U256 {
        self.total_collateral_distributed.get().unwrap_or(U256::zero())
    }

    /// Get total fees collected (primitive return for frontend)
    pub fn get_total_fees_collected(&self) -> U256 {
        self.total_fees_collected.get().unwrap_or(U256::zero())
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    /// Get router address
    pub fn get_router(&self) -> Option<Address> {
        self.router.get()
    }

    // ========== Admin Functions ==========

    /// Set base redemption fee (admin only)
    pub fn set_base_fee(&mut self, fee_bps: u32) {
        // TODO: Add admin access control
        if fee_bps > MAX_REDEMPTION_FEE_BPS {
            self.env().revert(CdpError::InvalidConfig);
        }
        self.base_fee_bps.set(fee_bps);
    }

    /// Set maximum redemption fee (admin only)
    pub fn set_max_fee(&mut self, fee_bps: u32) {
        // TODO: Add admin access control
        if fee_bps > 1000 {
            // Hard cap at 10%
            self.env().revert(CdpError::InvalidConfig);
        }
        self.max_fee_bps.set(fee_bps);
    }

    // ========== Safe Mode Functions ==========

    /// Trigger safe mode
    pub fn trigger_safe_mode(&mut self, reason: OracleStatus) {
        self.safe_mode.set(SafeModeState {
            is_active: true,
            triggered_at: self.env().get_block_time(),
            reason,
        });
    }

    /// Clear safe mode (admin only)
    pub fn clear_safe_mode(&mut self) {
        // TODO: Add admin access control
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Check if safe mode is active
    pub fn is_safe_mode_active(&self) -> bool {
        self.safe_mode.get().map(|s| s.is_active).unwrap_or(false)
    }

    // ========== Internal Functions ==========

    fn require_not_safe_mode(&self) {
        let state = self.safe_mode.get().unwrap_or(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
        if state.is_active {
            self.env().revert(CdpError::SafeModeActive);
        }
    }

    fn get_price(&self, collateral_id: CollateralId) -> U256 {
        let styks_addr = self.styks_oracle.get().expect("styks_oracle not set");

        // Get stCSPR exchange rate if needed
        let scspr_rate = if matches!(collateral_id, CollateralId::SCSPR) {
            self.get_scspr_exchange_rate()
        } else {
            None
        };

        // Call Styks oracle directly
        StyksOracle::get_price(&self.env(), styks_addr, collateral_id, scspr_rate)
    }

    fn get_scspr_exchange_rate(&self) -> Option<U256> {
        let ybtoken_addr = self.scspr_ybtoken.get()?;
        let args = runtime_args! {};
        let call_def = CallDef::new("get_exchange_rate", false, args);
        Some(self.env().call_contract::<U256>(ybtoken_addr, call_def))
    }

    fn process_redemption(
        &mut self,
        collateral_id: CollateralId,
        mut csprusd_remaining: U256,
        mut collateral_remaining: U256,
        hint: RedemptionHint,
    ) -> u32 {
        // Get branch address
        let branch_addr = match collateral_id {
            CollateralId::Cspr => self.branch_cspr.get().expect("branch_cspr not set"),
            CollateralId::SCSPR => self.branch_scspr.get().expect("branch_scspr not set"),
        };

        let price = self.get_price(collateral_id);
        let max_iterations = if hint.max_iterations == 0 { 10 } else { hint.max_iterations };

        // Get sorted vault owners from branch (low interest rate first)
        let get_sorted_args = runtime_args! {
            "max_count" => max_iterations
        };
        let get_sorted_call = CallDef::new("get_sorted_vault_owners", false, get_sorted_args);
        let vault_owners: Vec<Address> = self.env().call_contract(branch_addr, get_sorted_call);

        let mut vaults_touched = 0u32;

        for owner in vault_owners {
            if csprusd_remaining.is_zero() || collateral_remaining.is_zero() {
                break;
            }

            // Get vault debt
            let get_debt_args = runtime_args! {
                "owner" => owner
            };
            let get_debt_call = CallDef::new("get_debt", false, get_debt_args);
            let vault_debt: U256 = self.env().call_contract(branch_addr, get_debt_call);

            if vault_debt.is_zero() {
                continue;
            }

            // Get vault collateral
            let get_coll_args = runtime_args! {
                "owner" => owner
            };
            let get_coll_call = CallDef::new("get_collateral", false, get_coll_args);
            let vault_collateral: U256 = self.env().call_contract(branch_addr, get_coll_call);

            if vault_collateral.is_zero() {
                continue;
            }

            // Calculate how much to redeem from this vault
            let debt_to_redeem = if csprusd_remaining >= vault_debt {
                vault_debt
            } else {
                csprusd_remaining
            };

            // Calculate collateral to take: collateral = debt / price
            let collateral_to_take = debt_to_redeem * U256::from(SCALE) / price;

            // Cap at vault's actual collateral
            let actual_collateral = if collateral_to_take > vault_collateral {
                vault_collateral
            } else {
                collateral_to_take
            };

            // Cap at remaining collateral needed
            let actual_collateral = if actual_collateral > collateral_remaining {
                collateral_remaining
            } else {
                actual_collateral
            };

            // Recalculate debt based on actual collateral
            let actual_debt = actual_collateral * price / U256::from(SCALE);

            if actual_debt.is_zero() || actual_collateral.is_zero() {
                continue;
            }

            // Call branch to reduce vault collateral and debt
            let reduce_args = runtime_args! {
                "owner" => owner,
                "collateral_amount" => actual_collateral,
                "debt_amount" => actual_debt
            };
            let reduce_call = CallDef::new("reduce_collateral_for_redemption", true, reduce_args);
            self.env().call_contract::<()>(branch_addr, reduce_call);

            // Update remaining amounts
            csprusd_remaining = csprusd_remaining.saturating_sub(actual_debt);
            collateral_remaining = collateral_remaining.saturating_sub(actual_collateral);
            vaults_touched += 1;
        }

        vaults_touched
    }

    fn transfer_collateral(&mut self, collateral_id: CollateralId, recipient: Address, amount: U256) {
        if amount.is_zero() {
            return;
        }

        match collateral_id {
            CollateralId::Cspr => {
                // Native CSPR transfer
                self.env().transfer_tokens(&recipient, &u256_to_u512(amount));
            }
            CollateralId::SCSPR => {
                // CEP-18 stCSPR transfer
                let scspr_addr = self.scspr_token.get().expect("scspr_token not set");
                let args = runtime_args! {
                    "recipient" => recipient,
                    "amount" => amount
                };
                let call_def = CallDef::new("transfer", true, args);
                let success: bool = self.env().call_contract(scspr_addr, call_def);
                if !success {
                    self.env().revert(CdpError::InsufficientTokenBalance);
                }
            }
        }
    }

    /// Get vaults sorted by interest rate for redemption
    /// Returns list of (owner, debt, collateral, rate_bps)
    #[allow(dead_code)]
    fn get_sorted_vaults(
        &self,
        collateral_id: CollateralId,
        max_count: u32,
    ) -> Vec<(Address, U256, U256, u32)> {
        let _branch_addr = match collateral_id {
            CollateralId::Cspr => self.branch_cspr.get(),
            CollateralId::SCSPR => self.branch_scspr.get(),
        };

        let _max_count = max_count;

        // Placeholder: Cross-contract call to branch.get_sorted_vault_owners()
        // TODO: Wire cross-contract calls when Odra external_contract is available
        Vec::new()
    }
}

// ===== Helper Functions =====

/// Convert U256 to U512
fn u256_to_u512(value: U256) -> U512 {
    let mut bytes = [0u8; 32];
    value.to_little_endian(&mut bytes);
    U512::from_little_endian(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_min_redemption_constant() {
        assert_eq!(MIN_REDEMPTION, 1_000_000_000_000_000_000);
    }

    #[test]
    fn test_fee_constants() {
        assert_eq!(BASE_REDEMPTION_FEE_BPS, 50); // 0.5%
        assert_eq!(MAX_REDEMPTION_FEE_BPS, 500); // 5%
        assert!(BASE_REDEMPTION_FEE_BPS < MAX_REDEMPTION_FEE_BPS);
    }

    #[test]
    fn test_collateral_calculation() {
        // gUSD = 100, price = 2 USD per collateral
        // Expected collateral = 100 / 2 = 50
        let csprusd = U256::from(100u64) * U256::from(SCALE);
        let price = U256::from(2u64) * U256::from(SCALE);

        let collateral = csprusd * U256::from(SCALE) / price;
        let expected = U256::from(50u64) * U256::from(SCALE);
        assert_eq!(collateral, expected);
    }

    #[test]
    fn test_fee_calculation() {
        // Collateral = 100, fee = 0.5% (50 bps)
        // Expected fee = 100 * 50 / 10000 = 0.5
        let collateral = U256::from(100u64) * U256::from(SCALE);
        let fee_bps = BASE_REDEMPTION_FEE_BPS;

        let fee = collateral * U256::from(fee_bps) / U256::from(BPS_SCALE);
        let expected = U256::from(SCALE) / U256::from(2u64); // 0.5 * SCALE
        assert_eq!(fee, expected);
    }

    #[test]
    fn test_redemption_hint_default() {
        let hint = RedemptionHint::default();
        assert!(hint.first_vault_owner.is_none());
        assert_eq!(hint.expected_rate_bps, 0);
        assert_eq!(hint.max_iterations, 0);
    }

    #[test]
    fn test_fee_bounds() {
        // Base fee should be less than max fee
        assert!(BASE_REDEMPTION_FEE_BPS <= MAX_REDEMPTION_FEE_BPS);

        // Max fee should be reasonable (not more than 10%)
        assert!(MAX_REDEMPTION_FEE_BPS <= 1000);
    }
}
