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
use odra::casper_types::U256;
use crate::types::{CollateralId, OracleStatus, SafeModeState};
use crate::errors::CdpError;

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
    /// Oracle adapter contract address
    oracle: Var<Address>,

    // === Fee Configuration ===
    /// Base redemption fee in bps
    base_fee_bps: Var<u32>,
    /// Maximum redemption fee in bps
    max_fee_bps: Var<u32>,
    /// Decay factor for fee calculation
    fee_decay_factor: Var<U256>,
    /// Last redemption timestamp
    last_redemption_time: Var<u64>,

    // === Statistics ===
    /// Total gUSD redeemed
    total_redeemed: Var<U256>,
    /// Total collateral distributed
    total_collateral_distributed: Var<U256>,
    /// Total fees collected
    total_fees_collected: Var<U256>,
    /// Total redemption count
    total_redemptions: Var<u64>,

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
        oracle: Address,
    ) {
        self.registry.set(registry);
        self.router.set(router);
        self.stablecoin.set(stablecoin);
        self.treasury.set(treasury);
        self.oracle.set(oracle);

        // Initialize fee configuration
        self.base_fee_bps.set(BASE_REDEMPTION_FEE_BPS);
        self.max_fee_bps.set(MAX_REDEMPTION_FEE_BPS);
        self.fee_decay_factor.set(U256::from(SCALE));
        self.last_redemption_time.set(0);

        // Initialize statistics
        self.total_redeemed.set(U256::zero());
        self.total_collateral_distributed.set(U256::zero());
        self.total_fees_collected.set(U256::zero());
        self.total_redemptions.set(0);

        // Initialize safe mode
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    // ========== Redemption Functions ==========

    /// Redeem gUSD for collateral
    /// Returns the collateral amount received after fees
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

        // Process redemption against vaults
        let vaults_touched = self.process_redemption(
            collateral_id,
            csprusd_amount,
            collateral_before_fee,
            hint.unwrap_or_default(),
        );

        // Update statistics
        let total_redeemed = self.total_redeemed.get().unwrap_or(U256::zero());
        self.total_redeemed.set(total_redeemed + csprusd_amount);

        let total_distributed = self.total_collateral_distributed.get().unwrap_or(U256::zero());
        self.total_collateral_distributed.set(total_distributed + collateral_after_fee);

        let total_fees = self.total_fees_collected.get().unwrap_or(U256::zero());
        self.total_fees_collected.set(total_fees + fee_amount);

        let total_count = self.total_redemptions.get().unwrap_or(0);
        self.total_redemptions.set(total_count + 1);

        // Update last redemption time (for fee decay)
        self.last_redemption_time.set(self.env().get_block_time());

        // TODO: Transfer gUSD from redeemer and burn
        // TODO: Transfer collateral to redeemer
        // TODO: Transfer fee to treasury

        RedemptionResult {
            csprusd_redeemed: csprusd_amount,
            collateral_received: collateral_after_fee,
            fee_paid: fee_amount,
            vaults_touched,
        }
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
            total_redemptions: self.total_redemptions.get().unwrap_or(0),
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

    fn get_price(&self, _collateral_id: CollateralId) -> U256 {
        // TODO: Cross-contract call to oracle.get_price(collateral_id)
        // For now, return default price (1 USD)
        U256::from(SCALE)
    }

    fn process_redemption(
        &self,
        _collateral_id: CollateralId,
        _csprusd_amount: U256,
        _collateral_amount: U256,
        hint: RedemptionHint,
    ) -> u32 {
        // TODO: Implement actual vault iteration
        // 1. Start from hint.first_vault_owner or lowest rate vault
        // 2. Iterate through vaults in ascending interest rate order
        // 3. Reduce debt and collateral from each vault
        // 4. Close fully redeemed vaults
        // 5. Stop when csprusd_amount is fully covered or max_iterations reached

        // For now, return simulated vault count
        hint.max_iterations.min(10)
    }

    /// Get vaults sorted by interest rate for redemption
    /// Returns list of (owner, debt, collateral, rate_bps)
    fn get_sorted_vaults(
        &self,
        _collateral_id: CollateralId,
        _max_count: u32,
    ) -> Vec<(Address, U256, U256, u32)> {
        // TODO: Cross-contract call to router/branch to get sorted vaults
        // Vaults should be sorted by ascending interest rate
        Vec::new()
    }
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
