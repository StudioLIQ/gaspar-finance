//! Liquidation Engine Contract
//!
//! Handles liquidation of under-collateralized vaults.
//! Liquidation occurs when a vault's ICR falls below the MCR (110%).
//!
//! Liquidation flow:
//! 1. Check vault is liquidatable (ICR < MCR)
//! 2. Calculate debt to cover and collateral to seize
//! 3. Use Stability Pool funds if available
//! 4. Apply liquidation penalty (10% default)
//! 5. Transfer collateral to liquidator/SP depositors
//! 6. Close or reduce the vault

use odra::prelude::*;
use odra::casper_types::{U256, U512, RuntimeArgs, runtime_args};
use odra::CallDef;
use crate::types::{CollateralId, OracleStatus, SafeModeState};
use crate::errors::CdpError;

/// Oracle adapter interface
#[odra::external_contract]
pub trait OracleAdapter {
    fn get_price(&self, collateral_id: u8) -> U256;
    fn get_price_status(&self, collateral_id: u8) -> u8;
}

/// Branch interface for vault operations
#[odra::external_contract]
pub trait Branch {
    fn get_collateral(&self, owner: Address) -> U256;
    fn get_debt(&self, owner: Address) -> U256;
    fn seize_collateral(&mut self, owner: Address, amount: U256);
    fn reduce_debt(&mut self, owner: Address, amount: U256);
    fn close_vault(&mut self, owner: Address);
}

/// Stability Pool interface
#[odra::external_contract]
pub trait StabilityPool {
    fn offset(&mut self, collateral_id: u8, debt_to_offset: U256, collateral_to_add: U256) -> U256;
    fn get_total_deposits(&self) -> U256;
}

/// gUSD stablecoin interface
#[odra::external_contract]
pub trait GUsd {
    fn burn_from(&mut self, from: Address, amount: U256);
}

/// CEP-18 interface for stCSPR
#[odra::external_contract]
pub trait Cep18 {
    fn transfer(&mut self, recipient: Address, amount: U256) -> bool;
}

/// Minimum Collateralization Ratio for liquidation (110% = 11000 bps)
const MCR_BPS: u32 = 11000;

/// Liquidation penalty in basis points (10% = 1000 bps)
const LIQUIDATION_PENALTY_BPS: u32 = 1000;

/// Precision scale (1e18)
const SCALE: u64 = 1_000_000_000_000_000_000;

/// Basis points scale
const BPS_SCALE: u32 = 10000;

/// Liquidation result for a single vault
#[odra::odra_type]
pub struct LiquidationResult {
    /// Owner of the liquidated vault
    pub vault_owner: Address,
    /// Collateral type
    pub collateral_id: CollateralId,
    /// Debt covered in the liquidation
    pub debt_liquidated: U256,
    /// Collateral seized (including penalty)
    pub collateral_seized: U256,
    /// Collateral going to stability pool depositors
    pub collateral_to_sp: U256,
    /// Collateral going to liquidator as gas compensation
    pub collateral_to_liquidator: U256,
    /// Whether vault was fully liquidated
    pub fully_liquidated: bool,
}

/// Batch liquidation summary
#[odra::odra_type]
pub struct BatchLiquidationResult {
    /// Number of vaults liquidated
    pub vaults_liquidated: u32,
    /// Total debt liquidated
    pub total_debt_liquidated: U256,
    /// Total collateral seized
    pub total_collateral_seized: U256,
}

/// Liquidation Engine Contract
#[odra::module]
pub struct LiquidationEngine {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address
    router: Var<Address>,
    /// Stability Pool contract address
    stability_pool: Var<Address>,
    /// Oracle adapter contract address
    oracle: Var<Address>,
    /// CSPR Branch contract address
    branch_cspr: Var<Address>,
    /// stCSPR Branch contract address
    branch_scspr: Var<Address>,
    /// gUSD stablecoin contract address
    stablecoin: Var<Address>,
    /// stCSPR token address (for CEP-18 transfers)
    scspr_token: Var<Address>,
    /// Liquidation penalty in bps
    liquidation_penalty_bps: Var<u32>,
    /// Gas compensation for liquidator (in collateral)
    gas_compensation: Var<U256>,
    /// Total liquidations processed
    total_liquidations: Var<u64>,
    /// Total debt liquidated (cumulative)
    total_debt_liquidated: Var<U256>,
    /// Total collateral seized (cumulative)
    total_collateral_seized: Var<U256>,
    /// Local safe mode state
    safe_mode: Var<SafeModeState>,
}

#[odra::module]
impl LiquidationEngine {
    /// Initialize the liquidation engine
    pub fn init(
        &mut self,
        registry: Address,
        router: Address,
        stability_pool: Address,
        oracle: Address,
    ) {
        self.registry.set(registry);
        self.router.set(router);
        self.stability_pool.set(stability_pool);
        self.oracle.set(oracle);
        self.liquidation_penalty_bps.set(LIQUIDATION_PENALTY_BPS);
        self.gas_compensation.set(U256::from(200) * U256::from(SCALE)); // 200 gUSD equivalent
        self.total_liquidations.set(0);
        self.total_debt_liquidated.set(U256::zero());
        self.total_collateral_seized.set(U256::zero());
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Update stability pool address (post-deploy wiring).
    /// NOTE: Access control should be enforced via registry admin; left open for now.
    pub fn set_stability_pool(&mut self, stability_pool: Address) {
        self.stability_pool.set(stability_pool);
    }

    /// Set CSPR branch address
    pub fn set_branch_cspr(&mut self, branch: Address) {
        self.branch_cspr.set(branch);
    }

    /// Set stCSPR branch address
    pub fn set_branch_scspr(&mut self, branch: Address) {
        self.branch_scspr.set(branch);
    }

    /// Set stablecoin address
    pub fn set_stablecoin(&mut self, stablecoin: Address) {
        self.stablecoin.set(stablecoin);
    }

    /// Set stCSPR token address
    pub fn set_scspr_token(&mut self, scspr_token: Address) {
        self.scspr_token.set(scspr_token);
    }

    /// Set oracle address
    pub fn set_oracle(&mut self, oracle: Address) {
        self.oracle.set(oracle);
    }

    // ========== Liquidation Functions ==========

    /// Liquidate a single vault
    pub fn liquidate(&mut self, collateral_id: CollateralId, vault_owner: Address) -> LiquidationResult {
        // Check safe mode - liquidations blocked
        self.require_not_safe_mode();

        // Get vault data and check if liquidatable
        let vault_data = self.get_vault_data(collateral_id, vault_owner);
        if vault_data.collateral.is_zero() && vault_data.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        // Get current price
        let price = self.get_price(collateral_id);

        // Calculate ICR
        let collateral_value = self.calculate_collateral_value(vault_data.collateral, price);
        let icr_bps = self.calculate_icr(collateral_value, vault_data.debt);

        // Check if vault is liquidatable
        if icr_bps >= MCR_BPS {
            self.env().revert(CdpError::NotLiquidatable);
        }

        // Calculate liquidation amounts
        let result = self.calculate_liquidation(
            collateral_id,
            vault_owner,
            vault_data.collateral,
            vault_data.debt,
            price,
        );

        // Update statistics
        let total_liq = self.total_liquidations.get().unwrap_or(0);
        self.total_liquidations.set(total_liq + 1);

        let total_debt = self.total_debt_liquidated.get().unwrap_or(U256::zero());
        self.total_debt_liquidated.set(total_debt + result.debt_liquidated);

        let total_coll = self.total_collateral_seized.get().unwrap_or(U256::zero());
        self.total_collateral_seized.set(total_coll + result.collateral_seized);

        // Execute actual liquidation
        self.execute_liquidation(collateral_id, &result);

        result
    }

    /// Frontend-friendly liquidate using primitive types
    ///
    /// collateral_id: 0 = CSPR, 1 = stCSPR
    pub fn liquidate_u8(&mut self, collateral_id: u8, vault_owner: Address) -> LiquidationResult {
        let coll_id = match collateral_id {
            0 => CollateralId::Cspr,
            1 => CollateralId::SCSPR,
            _ => self.env().revert(CdpError::UnsupportedCollateral),
        };
        self.liquidate(coll_id, vault_owner)
    }

    /// Batch liquidate multiple vaults (gas efficient)
    pub fn batch_liquidate(
        &mut self,
        collateral_id: CollateralId,
        vault_owners: Vec<Address>,
        max_vaults: u32,
    ) -> BatchLiquidationResult {
        // Check safe mode
        self.require_not_safe_mode();

        let mut vaults_liquidated: u32 = 0;
        let mut total_debt = U256::zero();
        let mut total_collateral = U256::zero();

        // Get price once for batch efficiency
        let price = self.get_price(collateral_id);

        for owner in vault_owners.iter().take(max_vaults as usize) {
            let vault_data = self.get_vault_data(collateral_id, *owner);

            // Skip empty vaults
            if vault_data.collateral.is_zero() && vault_data.debt.is_zero() {
                continue;
            }

            // Calculate ICR
            let collateral_value = self.calculate_collateral_value(vault_data.collateral, price);
            let icr_bps = self.calculate_icr(collateral_value, vault_data.debt);

            // Skip healthy vaults
            if icr_bps >= MCR_BPS {
                continue;
            }

            // Calculate liquidation
            let result = self.calculate_liquidation(
                collateral_id,
                *owner,
                vault_data.collateral,
                vault_data.debt,
                price,
            );

            // Execute the liquidation
            self.execute_liquidation(collateral_id, &result);

            vaults_liquidated += 1;
            total_debt = total_debt + result.debt_liquidated;
            total_collateral = total_collateral + result.collateral_seized;
        }

        // Update cumulative stats
        let total_liq = self.total_liquidations.get().unwrap_or(0);
        self.total_liquidations.set(total_liq + vaults_liquidated as u64);

        let cumulative_debt = self.total_debt_liquidated.get().unwrap_or(U256::zero());
        self.total_debt_liquidated.set(cumulative_debt + total_debt);

        let cumulative_coll = self.total_collateral_seized.get().unwrap_or(U256::zero());
        self.total_collateral_seized.set(cumulative_coll + total_collateral);

        BatchLiquidationResult {
            vaults_liquidated,
            total_debt_liquidated: total_debt,
            total_collateral_seized: total_collateral,
        }
    }

    // ========== Query Functions ==========

    /// Check if a vault is liquidatable
    pub fn is_liquidatable(&self, collateral_id: CollateralId, vault_owner: Address) -> bool {
        let vault_data = self.get_vault_data(collateral_id, vault_owner);
        if vault_data.collateral.is_zero() && vault_data.debt.is_zero() {
            return false;
        }

        let price = self.get_price(collateral_id);
        let collateral_value = self.calculate_collateral_value(vault_data.collateral, price);
        let icr_bps = self.calculate_icr(collateral_value, vault_data.debt);

        icr_bps < MCR_BPS
    }

    /// Get liquidation statistics
    pub fn get_stats(&self) -> LiquidationStats {
        LiquidationStats {
            total_liquidations: self.total_liquidations.get().unwrap_or(0),
            total_debt_liquidated: self.total_debt_liquidated.get().unwrap_or(U256::zero()),
            total_collateral_seized: self.total_collateral_seized.get().unwrap_or(U256::zero()),
        }
    }

    /// Get liquidation penalty in bps
    pub fn get_liquidation_penalty(&self) -> u32 {
        self.liquidation_penalty_bps.get().unwrap_or(LIQUIDATION_PENALTY_BPS)
    }

    /// Get gas compensation amount
    pub fn get_gas_compensation(&self) -> U256 {
        self.gas_compensation.get().unwrap_or(U256::from(200) * U256::from(SCALE))
    }

    // ========== Admin Functions ==========

    /// Set liquidation penalty (admin only)
    pub fn set_liquidation_penalty(&mut self, penalty_bps: u32) {
        // TODO: Add admin access control
        if penalty_bps > 5000 {
            // Max 50%
            self.env().revert(CdpError::InvalidConfig);
        }
        self.liquidation_penalty_bps.set(penalty_bps);
    }

    /// Set gas compensation (admin only)
    pub fn set_gas_compensation(&mut self, amount: U256) {
        // TODO: Add admin access control
        self.gas_compensation.set(amount);
    }

    /// Trigger safe mode
    pub fn trigger_safe_mode(&mut self, reason: OracleStatus) {
        self.safe_mode.set(SafeModeState {
            is_active: true,
            triggered_at: self.env().get_block_time(),
            reason,
        });
    }

    /// Clear safe mode
    pub fn clear_safe_mode(&mut self) {
        // TODO: Add admin access control
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
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

    fn get_vault_data(&self, collateral_id: CollateralId, owner: Address) -> VaultDataSimple {
        let branch_addr = match collateral_id {
            CollateralId::Cspr => self.branch_cspr.get().expect("branch_cspr not set"),
            CollateralId::SCSPR => self.branch_scspr.get().expect("branch_scspr not set"),
        };

        // Get collateral from branch
        let get_coll_args = runtime_args! {
            "owner" => owner
        };
        let get_coll_call = CallDef::new("get_collateral", false, get_coll_args);
        let collateral: U256 = self.env().call_contract(branch_addr, get_coll_call);

        // Get debt from branch
        let get_debt_args = runtime_args! {
            "owner" => owner
        };
        let get_debt_call = CallDef::new("get_debt", false, get_debt_args);
        let debt: U256 = self.env().call_contract(branch_addr, get_debt_call);

        VaultDataSimple { collateral, debt }
    }

    fn get_price(&self, collateral_id: CollateralId) -> U256 {
        let oracle_addr = self.oracle.get().expect("oracle not set");
        let coll_id: u8 = match collateral_id {
            CollateralId::Cspr => 0,
            CollateralId::SCSPR => 1,
        };

        // Cross-contract call to oracle.get_price()
        let args = runtime_args! {
            "collateral_id" => coll_id
        };
        let call_def = CallDef::new("get_price", false, args);
        self.env().call_contract::<U256>(oracle_addr, call_def)
    }

    fn execute_liquidation(&mut self, collateral_id: CollateralId, result: &LiquidationResult) {
        let liquidator = self.env().caller();

        // 1. Get branch address
        let branch_addr = match collateral_id {
            CollateralId::Cspr => self.branch_cspr.get().expect("branch_cspr not set"),
            CollateralId::SCSPR => self.branch_scspr.get().expect("branch_scspr not set"),
        };

        // 2. Seize collateral from vault (branch updates its accounting)
        let seize_args = runtime_args! {
            "owner" => result.vault_owner,
            "amount" => result.collateral_seized
        };
        let seize_call = CallDef::new("seize_collateral", true, seize_args);
        self.env().call_contract::<()>(branch_addr, seize_call);

        // 3. Reduce vault debt
        let reduce_debt_args = runtime_args! {
            "owner" => result.vault_owner,
            "amount" => result.debt_liquidated
        };
        let reduce_debt_call = CallDef::new("reduce_debt", true, reduce_debt_args);
        self.env().call_contract::<()>(branch_addr, reduce_debt_call);

        // 4. Offset debt with stability pool
        if !result.debt_liquidated.is_zero() {
            if let Some(sp_addr) = self.stability_pool.get() {
                let coll_id: u8 = match collateral_id {
                    CollateralId::Cspr => 0,
                    CollateralId::SCSPR => 1,
                };

                // Call SP offset to record the debt absorption
                let offset_args = runtime_args! {
                    "collateral_id" => coll_id,
                    "debt_to_offset" => result.debt_liquidated,
                    "collateral_to_add" => result.collateral_to_sp
                };
                let offset_call = CallDef::new("offset_u8", true, offset_args);
                let _offset_result: U256 = self.env().call_contract(sp_addr, offset_call);

                // Transfer collateral to SP
                if !result.collateral_to_sp.is_zero() {
                    match collateral_id {
                        CollateralId::Cspr => {
                            // Native CSPR transfer to SP via receive_cspr_collateral
                            self.env().transfer_tokens(&sp_addr, &u256_to_u512(result.collateral_to_sp));
                        }
                        CollateralId::SCSPR => {
                            // For stCSPR, approve and call receive_scspr_collateral
                            // The liquidation engine holds the stCSPR after seizing it
                            // SP will pull the stCSPR from the source
                            let engine_addr = self.env().self_address();
                            let receive_args = runtime_args! {
                                "from" => engine_addr,
                                "amount" => result.collateral_to_sp
                            };
                            let receive_call = CallDef::new("receive_scspr_collateral", true, receive_args);
                            self.env().call_contract::<()>(sp_addr, receive_call);
                        }
                    }
                }
            }
        }

        // 5. Transfer gas compensation to liquidator
        if !result.collateral_to_liquidator.is_zero() {
            match collateral_id {
                CollateralId::Cspr => {
                    self.env().transfer_tokens(&liquidator, &u256_to_u512(result.collateral_to_liquidator));
                }
                CollateralId::SCSPR => {
                    let scspr_addr = self.scspr_token.get().expect("scspr_token not set");
                    let transfer_args = runtime_args! {
                        "recipient" => liquidator,
                        "amount" => result.collateral_to_liquidator
                    };
                    let transfer_call = CallDef::new("transfer", true, transfer_args);
                    let success: bool = self.env().call_contract(scspr_addr, transfer_call);
                    if !success {
                        self.env().revert(CdpError::InsufficientTokenBalance);
                    }
                }
            }
        }

        // 6. Close vault if fully liquidated
        if result.fully_liquidated {
            let close_args = runtime_args! {
                "owner" => result.vault_owner
            };
            let close_call = CallDef::new("close_vault_for_liquidation", true, close_args);
            self.env().call_contract::<()>(branch_addr, close_call);
        }
    }

    fn calculate_collateral_value(&self, collateral: U256, price: U256) -> U256 {
        collateral * price / U256::from(SCALE)
    }

    fn calculate_icr(&self, collateral_value: U256, debt: U256) -> u32 {
        if debt.is_zero() {
            return u32::MAX;
        }
        let scaled = collateral_value * U256::from(BPS_SCALE) / debt;
        if scaled > U256::from(u32::MAX) {
            u32::MAX
        } else {
            scaled.low_u32()
        }
    }

    fn calculate_liquidation(
        &self,
        collateral_id: CollateralId,
        vault_owner: Address,
        collateral: U256,
        debt: U256,
        price: U256,
    ) -> LiquidationResult {
        let penalty_bps = self.liquidation_penalty_bps.get().unwrap_or(LIQUIDATION_PENALTY_BPS);

        // Calculate collateral to seize: debt * (1 + penalty) / price
        // collateral_to_seize = debt * (10000 + penalty_bps) / 10000 / price * SCALE
        let penalty_multiplier = U256::from(BPS_SCALE + penalty_bps);
        let collateral_value_needed = debt * penalty_multiplier / U256::from(BPS_SCALE);
        let collateral_to_seize = collateral_value_needed * U256::from(SCALE) / price;

        // Cap at available collateral
        let actual_collateral_seized = if collateral_to_seize > collateral {
            collateral
        } else {
            collateral_to_seize
        };

        // Calculate debt covered
        let debt_covered = if collateral_to_seize > collateral {
            // Partial liquidation due to insufficient collateral
            collateral * price * U256::from(BPS_SCALE) / U256::from(SCALE) / penalty_multiplier
        } else {
            debt
        };

        let fully_liquidated = collateral_to_seize <= collateral;

        // Gas compensation for liquidator (small portion of collateral)
        let gas_comp = self.gas_compensation.get().unwrap_or(U256::zero());
        let gas_comp_in_collateral = gas_comp * U256::from(SCALE) / price;
        let collateral_to_liquidator = if gas_comp_in_collateral > actual_collateral_seized {
            actual_collateral_seized / U256::from(100) // 1% fallback
        } else {
            gas_comp_in_collateral
        };

        let collateral_to_sp = actual_collateral_seized - collateral_to_liquidator;

        LiquidationResult {
            vault_owner,
            collateral_id,
            debt_liquidated: debt_covered,
            collateral_seized: actual_collateral_seized,
            collateral_to_sp,
            collateral_to_liquidator,
            fully_liquidated,
        }
    }
}

/// Simple vault data for internal calculations
struct VaultDataSimple {
    collateral: U256,
    debt: U256,
}

/// Liquidation statistics
#[odra::odra_type]
pub struct LiquidationStats {
    /// Total number of liquidations
    pub total_liquidations: u64,
    /// Total debt liquidated (cumulative)
    pub total_debt_liquidated: U256,
    /// Total collateral seized (cumulative)
    pub total_collateral_seized: U256,
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
    fn test_icr_calculation() {
        // Collateral value: $1100, Debt: $1000
        // ICR = 1100 * 10000 / 1000 = 11000 bps = 110%
        let collateral_value = U256::from(1100u64);
        let debt = U256::from(1000u64);

        let icr_bps = collateral_value * U256::from(BPS_SCALE) / debt;
        assert_eq!(icr_bps, U256::from(11000u32));
    }

    #[test]
    fn test_liquidation_threshold() {
        // ICR at exactly MCR should NOT be liquidatable
        assert!(MCR_BPS == 11000);
        assert!(11000 >= MCR_BPS); // Not liquidatable
        assert!(10999 < MCR_BPS); // Liquidatable
    }

    #[test]
    fn test_penalty_calculation() {
        // Debt: 1000, Penalty: 10%
        // Collateral needed = 1000 * 1.1 = 1100
        let debt = U256::from(1000u64);
        let penalty_multiplier = U256::from(BPS_SCALE + LIQUIDATION_PENALTY_BPS);

        let collateral_needed = debt * penalty_multiplier / U256::from(BPS_SCALE);
        assert_eq!(collateral_needed, U256::from(1100u64));
    }
}
