//! Router contract for dispatching operations by collateral type.
//!
//! The router acts as the main entry point for the protocol,
//! forwarding calls to the appropriate branch based on collateralId.

use odra::prelude::*;
use odra::casper_types::{U256, runtime_args};
use odra::CallDef;
use crate::types::{CollateralId, SafeModeState, OracleStatus};
use crate::interfaces::{AdjustVaultParams, VaultInfo, BranchStatus};
use crate::errors::CdpError;

/// Router contract - main entry point for the CDP protocol
#[odra::module]
pub struct Router {
    /// Registry contract address
    registry: Var<Address>,
    /// Global safe mode state
    safe_mode: Var<SafeModeState>,
}

#[odra::module]
impl Router {
    /// Initialize the router with registry address
    pub fn init(&mut self, registry: Address) {
        self.registry.set(registry);
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Open a new vault for the specified collateral type
    ///
    /// # Arguments
    /// * `collateral_id` - Collateral type (0 = CSPR, 1 = stCSPR)
    /// * `collateral_amount` - Amount of collateral to deposit
    /// * `debt_amount` - Amount of gUSD to mint
    /// * `interest_rate_bps` - Interest rate in basis points
    #[odra(payable)]
    pub fn open_vault(
        &mut self,
        collateral_id: CollateralId,
        collateral_amount: U256,
        debt_amount: U256,
        interest_rate_bps: u32,
    ) -> u64 {
        self.require_not_safe_mode_for_open();
        self.validate_interest_rate(interest_rate_bps);

        let caller = self.env().caller();
        let branch_addr = self.get_branch_address(collateral_id);

        let branch_args = runtime_args! {
            "owner" => caller,
            "collateral_amount" => collateral_amount,
            "debt_amount" => debt_amount,
            "interest_rate_bps" => interest_rate_bps,
        };
        let branch_call = CallDef::new("open_vault", true, branch_args);
        let vault_id: u64 = self.env().call_contract(branch_addr, branch_call);

        if !debt_amount.is_zero() {
            let stablecoin_addr = self.get_stablecoin_address();
            let mint_args = runtime_args! {
                "to" => caller,
                "amount" => debt_amount,
            };
            let mint_call = CallDef::new("mint", true, mint_args);
            self.env().call_contract::<()>(stablecoin_addr, mint_call);
        }

        vault_id
    }

    /// Adjust an existing vault
    ///
    /// # Arguments
    /// * `collateral_id` - Collateral type (0 = CSPR, 1 = stCSPR)
    /// * `collateral_delta` - Amount of collateral to add/withdraw
    /// * `collateral_is_withdraw` - true to withdraw, false to add
    /// * `debt_delta` - Amount of debt to repay/borrow
    /// * `debt_is_repay` - true to repay, false to borrow
    pub fn adjust_vault(
        &mut self,
        collateral_id: CollateralId,
        vault_id: u64,
        collateral_delta: U256,
        collateral_is_withdraw: bool,
        debt_delta: U256,
        debt_is_repay: bool,
    ) {
        let params = AdjustVaultParams {
            collateral_delta,
            collateral_is_withdraw,
            debt_delta,
            debt_is_repay,
        };
        self.require_safe_mode_adjustment_allowed(&params);

        let caller = self.env().caller();
        let branch_addr = self.get_branch_address(collateral_id);

        let branch_args = runtime_args! {
            "owner" => caller,
            "vault_id" => vault_id,
            "collateral_delta" => collateral_delta,
            "collateral_is_withdraw" => collateral_is_withdraw,
            "debt_delta" => debt_delta,
            "debt_is_repay" => debt_is_repay,
        };
        let branch_call = CallDef::new("adjust_vault", true, branch_args);
        self.env().call_contract::<()>(branch_addr, branch_call);

        if !debt_delta.is_zero() {
            let stablecoin_addr = self.get_stablecoin_address();
            if debt_is_repay {
                let burn_args = runtime_args! {
                    "from" => caller,
                    "amount" => debt_delta,
                };
                let burn_call = CallDef::new("burn_with_allowance", true, burn_args);
                self.env().call_contract::<()>(stablecoin_addr, burn_call);
            } else {
                let mint_args = runtime_args! {
                    "to" => caller,
                    "amount" => debt_delta,
                };
                let mint_call = CallDef::new("mint", true, mint_args);
                self.env().call_contract::<()>(stablecoin_addr, mint_call);
            }
        }
    }

    /// Close vault and withdraw all collateral
    pub fn close_vault(&mut self, collateral_id: CollateralId, vault_id: u64) {
        self.require_not_safe_mode_for_close();

        let caller = self.env().caller();
        let branch_addr = self.get_branch_address(collateral_id);

        let debt_args = runtime_args! { "owner" => caller, "vault_id" => vault_id };
        let debt_call = CallDef::new("get_debt", false, debt_args);
        let debt: U256 = self.env().call_contract(branch_addr, debt_call);

        if !debt.is_zero() {
            let stablecoin_addr = self.get_stablecoin_address();
            let burn_args = runtime_args! {
                "from" => caller,
                "amount" => debt,
            };
            let burn_call = CallDef::new("burn_with_allowance", true, burn_args);
            self.env().call_contract::<()>(stablecoin_addr, burn_call);
        }

        let close_args = runtime_args! { "owner" => caller, "vault_id" => vault_id };
        let close_call = CallDef::new("close_vault", true, close_args);
        self.env().call_contract::<()>(branch_addr, close_call);
    }

    /// Get vault info for a specific owner and collateral type
    pub fn get_vault(&self, collateral_id: CollateralId, _owner: Address, vault_id: u64) -> Option<VaultInfo> {
        let branch_addr = self.get_branch_address(collateral_id);
        let args = runtime_args! { "owner" => _owner, "vault_id" => vault_id };
        let call_def = CallDef::new("get_vault", false, args);
        self.env().call_contract(branch_addr, call_def)
    }

    /// Get branch status for a collateral type
    pub fn get_branch_status(&self, collateral_id: CollateralId) -> Option<BranchStatus> {
        let branch_addr = self.get_branch_address(collateral_id);
        let args = runtime_args! {};
        let call_def = CallDef::new("get_status", false, args);
        Some(self.env().call_contract(branch_addr, call_def))
    }

    /// Get global safe mode state
    pub fn get_safe_mode(&self) -> SafeModeState {
        self.safe_mode.get().unwrap_or(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        })
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    /// Trigger safe mode (called by oracle adapter on price failure)
    pub fn trigger_safe_mode(&mut self, reason: OracleStatus) {
        let state = SafeModeState {
            is_active: true,
            triggered_at: self.env().get_block_time(),
            reason,
        };
        self.safe_mode.set(state);
    }

    /// Clear safe mode (admin only, requires manual confirmation)
    pub fn clear_safe_mode(&mut self) {
        let current = self.get_safe_mode();
        if !current.is_active {
            self.env().revert(CdpError::SafeModeAlreadyCleared);
        }

        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    fn require_not_safe_mode_for_open(&self) {
        let state = self.get_safe_mode();
        if state.is_active {
            self.env().revert(CdpError::SafeModeActive);
        }
    }

    fn require_not_safe_mode_for_close(&self) {
        let state = self.get_safe_mode();
        if state.is_active {
            self.env().revert(CdpError::SafeModeActive);
        }
    }

    fn require_safe_mode_adjustment_allowed(&self, params: &AdjustVaultParams) {
        let state = self.get_safe_mode();
        if !state.is_active {
            return;
        }

        let is_borrowing = !params.debt_is_repay && params.debt_delta > U256::zero();
        let is_withdrawing = params.collateral_is_withdraw && params.collateral_delta > U256::zero();

        if is_borrowing || is_withdrawing {
            self.env().revert(CdpError::SafeModeActive);
        }
    }

    fn validate_interest_rate(&self, rate_bps: u32) {
        const MIN_RATE_BPS: u32 = 0;
        const MAX_RATE_BPS: u32 = 4000;

        if rate_bps > MAX_RATE_BPS {
            self.env().revert(CdpError::InterestRateOutOfBounds);
        }
    }

    fn get_branch_address(&self, collateral_id: CollateralId) -> Address {
        let registry = self.registry.get().expect("registry not set");
        let args = runtime_args! { "collateral_id" => collateral_id };
        let call_def = CallDef::new("get_branch", false, args);
        let branch: Option<Address> = self.env().call_contract(registry, call_def);
        branch.expect("branch not set")
    }

    fn get_stablecoin_address(&self) -> Address {
        let registry = self.registry.get().expect("registry not set");
        let args = runtime_args! {};
        let call_def = CallDef::new("get_stablecoin", false, args);
        let stablecoin: Option<Address> = self.env().call_contract(registry, call_def);
        stablecoin.expect("stablecoin not set")
    }
}
