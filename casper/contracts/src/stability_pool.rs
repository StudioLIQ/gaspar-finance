//! Stability Pool Contract
//!
//! Allows users to deposit gUSD to absorb bad debt during liquidations.
//! In return, depositors receive collateral gains proportional to their stake.
//!
//! Key mechanics:
//! - Users deposit gUSD to the pool
//! - When vaults are liquidated, the pool absorbs the debt
//! - Depositors receive collateral (CSPR or stCSPR) proportionally
//! - Product-sum algorithm for efficient gain tracking (inspired by Liquity)
//!
//! Safe mode restrictions:
//! - Deposits: ALLOWED (always)
//! - Withdrawals: BLOCKED when safe_mode is active

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, OracleStatus, SafeModeState};
use crate::errors::CdpError;

/// Precision scale for product calculations (1e18)
const SCALE: u64 = 1_000_000_000_000_000_000;

/// Scale factor for product/sum algorithm (1e9)
const SCALE_FACTOR: u64 = 1_000_000_000;

/// Minimum deposit amount to prevent dust
const MIN_DEPOSIT: u64 = 1_000_000; // 0.000001 gUSD (with 18 decimals this is ~1e12)

/// Depositor's snapshot at time of deposit/compounding
#[odra::odra_type]
#[derive(Default)]
pub struct DepositSnapshot {
    /// Deposit amount (gUSD, scaled by 1e18)
    pub deposit: U256,
    /// Product snapshot at time of deposit
    pub p: U256,
    /// Sum snapshot at time of deposit (for CSPR gains)
    pub s_cspr: U256,
    /// Sum snapshot at time of deposit (for stCSPR gains)
    pub s_scspr: U256,
    /// Epoch at time of deposit
    pub epoch: u64,
    /// Scale at time of deposit
    pub scale: u64,
}

/// Collateral gains for a depositor
#[odra::odra_type]
#[derive(Default)]
pub struct CollateralGains {
    /// CSPR collateral gains
    pub cspr_gain: U256,
    /// stCSPR collateral gains
    pub scspr_gain: U256,
}

/// Pool statistics
#[odra::odra_type]
pub struct PoolStats {
    /// Total gUSD deposited
    pub total_deposits: U256,
    /// Total CSPR collateral held
    pub total_cspr_collateral: U256,
    /// Total stCSPR collateral held
    pub total_scspr_collateral: U256,
    /// Total debt absorbed (cumulative)
    pub total_debt_absorbed: U256,
    /// Number of depositors
    pub depositor_count: u64,
}

/// Product-sum algorithm state (consolidated)
#[odra::odra_type]
#[derive(Default)]
pub struct ProductSumState {
    /// Current product (starts at SCALE)
    pub p: U256,
    /// Current sum for CSPR gains
    pub s_cspr: U256,
    /// Current sum for stCSPR gains
    pub s_scspr: U256,
    /// Current epoch (incremented on each scale reset)
    pub epoch: u64,
    /// Current scale (tracks decimal precision loss)
    pub scale: u64,
}

/// Stability Pool Contract
#[odra::module]
pub struct StabilityPool {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address
    router: Var<Address>,
    /// Stablecoin (gUSD) contract address
    stablecoin: Var<Address>,
    /// Liquidation engine contract address
    liquidation_engine: Var<Address>,

    // === Pool State (consolidated) ===
    /// Total gUSD deposits
    total_deposits: Var<U256>,
    /// Total CSPR collateral held by pool
    total_cspr_collateral: Var<U256>,
    /// Total stCSPR collateral held by pool
    total_scspr_collateral: Var<U256>,
    /// Total debt absorbed (cumulative)
    total_debt_absorbed: Var<U256>,
    /// Number of depositors with non-zero balance
    depositor_count: Var<u64>,

    // === Product-Sum Algorithm State ===
    /// Consolidated product-sum state
    ps_state: Var<ProductSumState>,
    /// Epoch-to-scale-to-sum mapping for CSPR
    epoch_scale_sum_cspr: Mapping<(u64, u64), U256>,
    /// Epoch-to-scale-to-sum mapping for stCSPR
    epoch_scale_sum_scspr: Mapping<(u64, u64), U256>,

    // === Depositor State & Access Control ===
    /// Depositor snapshots
    deposits: Mapping<Address, DepositSnapshot>,
    /// Safe mode state
    safe_mode: Var<SafeModeState>,
}

#[odra::module]
impl StabilityPool {
    /// Initialize the stability pool
    pub fn init(
        &mut self,
        registry: Address,
        router: Address,
        stablecoin: Address,
        liquidation_engine: Address,
    ) {
        self.registry.set(registry);
        self.router.set(router);
        self.stablecoin.set(stablecoin);
        self.liquidation_engine.set(liquidation_engine);

        // Initialize pool state
        self.total_deposits.set(U256::zero());
        self.total_cspr_collateral.set(U256::zero());
        self.total_scspr_collateral.set(U256::zero());
        self.total_debt_absorbed.set(U256::zero());
        self.depositor_count.set(0);

        // Initialize product-sum state
        self.ps_state.set(ProductSumState {
            p: U256::from(SCALE),
            s_cspr: U256::zero(),
            s_scspr: U256::zero(),
            epoch: 0,
            scale: 0,
        });

        // Initialize safe mode
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Update liquidation engine address (post-deploy wiring).
    /// NOTE: Access control should be enforced via registry admin; left open for now.
    pub fn set_liquidation_engine(&mut self, liquidation_engine: Address) {
        self.liquidation_engine.set(liquidation_engine);
    }

    // ========== Deposit Functions ==========

    /// Deposit gUSD to the stability pool
    /// Note: Caller must have approved the pool to spend gUSD
    pub fn deposit(&mut self, amount: U256) {
        // Deposits are ALWAYS allowed (even in safe mode)
        if amount < U256::from(MIN_DEPOSIT) {
            self.env().revert(CdpError::BelowMinDebt);
        }

        let depositor = self.env().caller();

        // Get existing deposit and pending gains
        let existing_snapshot = self.deposits.get(&depositor).unwrap_or_default();
        let existing_deposit = self.get_compounded_deposit(depositor);
        let gains = self.get_depositor_gains(depositor);

        // Calculate new deposit
        let new_deposit = existing_deposit + amount;

        // Update depositor count if new depositor
        if existing_snapshot.deposit.is_zero() && !new_deposit.is_zero() {
            let count = self.depositor_count.get().unwrap_or(0);
            self.depositor_count.set(count + 1);
        }

        // Store new snapshot
        self.store_snapshot(depositor, new_deposit);

        // Update total deposits
        let total = self.total_deposits.get().unwrap_or(U256::zero());
        self.total_deposits.set(total + amount);

        // TODO: Transfer gUSD from depositor to pool
        // stablecoin.transfer_from(depositor, self, amount)

        // TODO: Transfer pending gains to depositor
        // if gains.cspr_gain > 0 { transfer CSPR }
        // if gains.scspr_gain > 0 { transfer stCSPR }
        let _ = gains; // Suppress unused warning until cross-contract calls implemented
    }

    /// Withdraw gUSD from the stability pool
    pub fn withdraw(&mut self, amount: U256) {
        // Withdrawals BLOCKED in safe mode
        self.require_not_safe_mode();

        let depositor = self.env().caller();

        // Get compounded deposit (accounting for debt absorption)
        let compounded_deposit = self.get_compounded_deposit(depositor);

        if amount > compounded_deposit {
            self.env().revert(CdpError::InsufficientCollateral);
        }

        // Get pending gains
        let gains = self.get_depositor_gains(depositor);

        // Calculate new deposit
        let new_deposit = compounded_deposit - amount;

        // Update depositor count if fully withdrawn
        let existing_snapshot = self.deposits.get(&depositor).unwrap_or_default();
        if !existing_snapshot.deposit.is_zero() && new_deposit.is_zero() {
            let count = self.depositor_count.get().unwrap_or(0);
            if count > 0 {
                self.depositor_count.set(count - 1);
            }
        }

        // Store new snapshot (or clear if zero)
        if new_deposit.is_zero() {
            self.deposits.set(&depositor, DepositSnapshot::default());
        } else {
            self.store_snapshot(depositor, new_deposit);
        }

        // Update total deposits
        let total = self.total_deposits.get().unwrap_or(U256::zero());
        if amount <= total {
            self.total_deposits.set(total - amount);
        } else {
            self.total_deposits.set(U256::zero());
        }

        // TODO: Transfer gUSD from pool to depositor
        // stablecoin.transfer(depositor, amount)

        // TODO: Transfer pending gains to depositor
        let _ = gains; // Suppress unused warning
    }

    /// Claim collateral gains without modifying deposit
    pub fn claim_gains(&mut self) {
        // Claims BLOCKED in safe mode (treated as withdrawal)
        self.require_not_safe_mode();

        let depositor = self.env().caller();
        let gains = self.get_depositor_gains(depositor);

        if gains.cspr_gain.is_zero() && gains.scspr_gain.is_zero() {
            return; // Nothing to claim
        }

        // Update snapshot to current state (resets gains)
        let compounded_deposit = self.get_compounded_deposit(depositor);
        if !compounded_deposit.is_zero() {
            self.store_snapshot(depositor, compounded_deposit);
        }

        // TODO: Transfer gains to depositor
        let _ = gains; // Suppress unused warning
    }

    // ========== Liquidation Offset Functions ==========

    /// Offset debt using pool deposits (called by LiquidationEngine)
    /// Returns the amount of debt that was offset
    pub fn offset(
        &mut self,
        collateral_id: CollateralId,
        debt_to_offset: U256,
        collateral_to_add: U256,
    ) -> U256 {
        // TODO: Add authorized liquidator check
        // self.require_authorized_liquidator();

        let total = self.total_deposits.get().unwrap_or(U256::zero());

        if total.is_zero() {
            return U256::zero(); // No deposits to offset with
        }

        // Cap debt offset to available deposits
        let actual_debt_offset = if debt_to_offset > total {
            total
        } else {
            debt_to_offset
        };

        if actual_debt_offset.is_zero() {
            return U256::zero();
        }

        // Update product and sum based on collateral type
        self.update_product_sum(collateral_id, actual_debt_offset, collateral_to_add, total);

        // Update total deposits (reduced by offset amount)
        self.total_deposits.set(total - actual_debt_offset);

        // Update collateral holdings
        match collateral_id {
            CollateralId::Cspr => {
                let current = self.total_cspr_collateral.get().unwrap_or(U256::zero());
                self.total_cspr_collateral.set(current + collateral_to_add);
            }
            CollateralId::SCSPR => {
                let current = self.total_scspr_collateral.get().unwrap_or(U256::zero());
                self.total_scspr_collateral.set(current + collateral_to_add);
            }
        }

        // Update cumulative debt absorbed
        let absorbed = self.total_debt_absorbed.get().unwrap_or(U256::zero());
        self.total_debt_absorbed.set(absorbed + actual_debt_offset);

        actual_debt_offset
    }

    // ========== Query Functions ==========

    /// Get depositor's compounded deposit (after accounting for absorbed debt)
    pub fn get_compounded_deposit(&self, depositor: Address) -> U256 {
        let snapshot = self.deposits.get(&depositor).unwrap_or_default();

        if snapshot.deposit.is_zero() {
            return U256::zero();
        }

        let state = self.ps_state.get().unwrap_or(ProductSumState {
            p: U256::from(SCALE),
            s_cspr: U256::zero(),
            s_scspr: U256::zero(),
            epoch: 0,
            scale: 0,
        });

        let snapshot_p = snapshot.p;
        if snapshot_p.is_zero() {
            return snapshot.deposit;
        }

        // Handle epoch changes
        if state.epoch > snapshot.epoch {
            // Deposit was wiped out in a previous epoch
            return U256::zero();
        }

        // Handle scale changes
        let scale_diff = state.scale.saturating_sub(snapshot.scale);

        if scale_diff == 0 {
            snapshot.deposit * state.p / snapshot_p
        } else if scale_diff == 1 {
            snapshot.deposit * state.p / snapshot_p / U256::from(SCALE_FACTOR)
        } else {
            // More than 1 scale difference means deposit is effectively zero
            U256::zero()
        }
    }

    /// Get depositor's pending collateral gains
    pub fn get_depositor_gains(&self, depositor: Address) -> CollateralGains {
        let snapshot = self.deposits.get(&depositor).unwrap_or_default();

        if snapshot.deposit.is_zero() {
            return CollateralGains::default();
        }

        let state = self.ps_state.get().unwrap_or_default();

        // Calculate CSPR gains
        let cspr_gain = self.calculate_gains(
            snapshot.deposit,
            snapshot.s_cspr,
            snapshot.p,
            snapshot.epoch,
            snapshot.scale,
            state.s_cspr,
            state.epoch,
            state.scale,
            CollateralId::Cspr,
        );

        // Calculate stCSPR gains
        let scspr_gain = self.calculate_gains(
            snapshot.deposit,
            snapshot.s_scspr,
            snapshot.p,
            snapshot.epoch,
            snapshot.scale,
            state.s_scspr,
            state.epoch,
            state.scale,
            CollateralId::SCSPR,
        );

        CollateralGains {
            cspr_gain,
            scspr_gain,
        }
    }

    /// Get pool statistics
    pub fn get_stats(&self) -> PoolStats {
        PoolStats {
            total_deposits: self.total_deposits.get().unwrap_or(U256::zero()),
            total_cspr_collateral: self.total_cspr_collateral.get().unwrap_or(U256::zero()),
            total_scspr_collateral: self.total_scspr_collateral.get().unwrap_or(U256::zero()),
            total_debt_absorbed: self.total_debt_absorbed.get().unwrap_or(U256::zero()),
            depositor_count: self.depositor_count.get().unwrap_or(0),
        }
    }

    /// Get total deposits
    pub fn get_total_deposits(&self) -> U256 {
        self.total_deposits.get().unwrap_or(U256::zero())
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    /// Get router address
    pub fn get_router(&self) -> Option<Address> {
        self.router.get()
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

    fn store_snapshot(&mut self, depositor: Address, deposit: U256) {
        let state = self.ps_state.get().unwrap_or(ProductSumState {
            p: U256::from(SCALE),
            s_cspr: U256::zero(),
            s_scspr: U256::zero(),
            epoch: 0,
            scale: 0,
        });

        let snapshot = DepositSnapshot {
            deposit,
            p: state.p,
            s_cspr: state.s_cspr,
            s_scspr: state.s_scspr,
            epoch: state.epoch,
            scale: state.scale,
        };
        self.deposits.set(&depositor, snapshot);
    }

    fn update_product_sum(
        &mut self,
        collateral_id: CollateralId,
        debt_offset: U256,
        collateral_gain: U256,
        total_deposits: U256,
    ) {
        let scale = U256::from(SCALE);
        let mut state = self.ps_state.get().unwrap_or(ProductSumState {
            p: scale,
            s_cspr: U256::zero(),
            s_scspr: U256::zero(),
            epoch: 0,
            scale: 0,
        });

        // Product decrease factor = (total - debt) / total = 1 - debt/total
        let numerator = if total_deposits > debt_offset {
            total_deposits - debt_offset
        } else {
            U256::zero()
        };

        // Update sum: S += collateral * P / totalDeposits
        let sum_increment = collateral_gain * state.p / total_deposits;

        match collateral_id {
            CollateralId::Cspr => {
                state.s_cspr = state.s_cspr + sum_increment;
                // Store sum at current epoch and scale
                self.epoch_scale_sum_cspr.set(&(state.epoch, state.scale), state.s_cspr);
            }
            CollateralId::SCSPR => {
                state.s_scspr = state.s_scspr + sum_increment;
                self.epoch_scale_sum_scspr.set(&(state.epoch, state.scale), state.s_scspr);
            }
        }

        // Update product: P *= (1 - debtLoss/totalDeposits)
        if numerator.is_zero() {
            // Full depletion - reset to new epoch
            state.epoch += 1;
            state.scale = 0;
            state.p = scale;
        } else {
            let new_p = state.p * numerator / total_deposits;

            // Check for scale change (product becomes too small)
            if new_p < scale / U256::from(SCALE_FACTOR) {
                state.p = new_p * U256::from(SCALE_FACTOR);
                state.scale += 1;
            } else {
                state.p = new_p;
            }
        }

        self.ps_state.set(state);
    }

    #[allow(clippy::too_many_arguments)]
    fn calculate_gains(
        &self,
        deposit: U256,
        snapshot_s: U256,
        snapshot_p: U256,
        snapshot_epoch: u64,
        snapshot_scale: u64,
        current_s: U256,
        current_epoch: u64,
        current_scale: u64,
        collateral_id: CollateralId,
    ) -> U256 {
        if snapshot_p.is_zero() {
            return U256::zero();
        }

        // If epoch changed, depositor's gain is from last epoch
        if current_epoch != snapshot_epoch {
            return U256::zero(); // Simplified: would need epoch boundary sums
        }

        // Calculate sum difference (accounting for scale changes)
        let scale_diff = current_scale.saturating_sub(snapshot_scale);

        let sum_diff = if scale_diff == 0 {
            current_s.saturating_sub(snapshot_s)
        } else if scale_diff == 1 {
            // Get sum at next scale
            let sum_at_next = match collateral_id {
                CollateralId::Cspr => {
                    self.epoch_scale_sum_cspr.get(&(snapshot_epoch, snapshot_scale + 1))
                        .unwrap_or(U256::zero())
                }
                CollateralId::SCSPR => {
                    self.epoch_scale_sum_scspr.get(&(snapshot_epoch, snapshot_scale + 1))
                        .unwrap_or(U256::zero())
                }
            };
            sum_at_next / U256::from(SCALE_FACTOR) + current_s.saturating_sub(snapshot_s)
        } else {
            U256::zero()
        };

        // Gain = deposit * (S_current - S_snapshot) / P_snapshot
        deposit * sum_diff / snapshot_p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_min_deposit_constant() {
        assert!(MIN_DEPOSIT > 0);
        assert_eq!(MIN_DEPOSIT, 1_000_000);
    }

    #[test]
    fn test_scale_constants() {
        assert_eq!(SCALE, 1_000_000_000_000_000_000);
        assert_eq!(SCALE_FACTOR, 1_000_000_000);
    }

    #[test]
    fn test_deposit_snapshot_default() {
        let snapshot = DepositSnapshot::default();
        assert!(snapshot.deposit.is_zero());
        assert!(snapshot.p.is_zero());
        assert!(snapshot.s_cspr.is_zero());
        assert_eq!(snapshot.epoch, 0);
        assert_eq!(snapshot.scale, 0);
    }

    #[test]
    fn test_collateral_gains_default() {
        let gains = CollateralGains::default();
        assert!(gains.cspr_gain.is_zero());
        assert!(gains.scspr_gain.is_zero());
    }

    #[test]
    fn test_product_decrease_math() {
        // Simulate: total = 1000, debt = 100
        // New product factor = (1000 - 100) / 1000 = 0.9
        let total = U256::from(1000u64);
        let debt = U256::from(100u64);
        let scale = U256::from(SCALE);

        let initial_p = scale;
        let numerator = total - debt;
        let new_p = initial_p * numerator / total;

        // Expected: 1e18 * 0.9 = 9e17
        let expected = U256::from(900_000_000_000_000_000u64);
        assert_eq!(new_p, expected);
    }

    #[test]
    fn test_sum_increment_math() {
        // Simulate: collateral = 50, P = 1e18, total = 1000
        // Sum increment = 50 * 1e18 / 1000 = 5e16
        let collateral = U256::from(50u64);
        let p = U256::from(SCALE);
        let total = U256::from(1000u64);

        let sum_increment = collateral * p / total;
        let expected = U256::from(50_000_000_000_000_000u64);
        assert_eq!(sum_increment, expected);
    }

    #[test]
    fn test_product_sum_state_default() {
        let state = ProductSumState::default();
        assert!(state.p.is_zero());
        assert!(state.s_cspr.is_zero());
        assert!(state.s_scspr.is_zero());
        assert_eq!(state.epoch, 0);
        assert_eq!(state.scale, 0);
    }
}
