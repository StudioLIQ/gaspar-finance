//! Router contract for dispatching operations by collateral type.
//!
//! The router acts as the main entry point for the protocol,
//! forwarding calls to the appropriate branch based on collateralId.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, SafeModeState, OracleStatus};
use crate::interfaces::{OpenVaultParams, AdjustVaultParams, VaultInfo, BranchStatus};
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
    pub fn open_vault(&mut self, collateral_id: CollateralId, params: OpenVaultParams) {
        self.require_not_safe_mode_for_open();
        self.validate_interest_rate(params.interest_rate_bps);

        match collateral_id {
            CollateralId::Cspr => {}
            CollateralId::SCSPR => {}
        }
    }

    /// Adjust an existing vault
    pub fn adjust_vault(&mut self, collateral_id: CollateralId, params: AdjustVaultParams) {
        self.require_safe_mode_adjustment_allowed(&params);

        match collateral_id {
            CollateralId::Cspr => {}
            CollateralId::SCSPR => {}
        }
    }

    /// Close vault and withdraw all collateral
    pub fn close_vault(&mut self, collateral_id: CollateralId) {
        self.require_not_safe_mode_for_close();

        match collateral_id {
            CollateralId::Cspr => {}
            CollateralId::SCSPR => {}
        }
    }

    /// Get vault info for a specific owner and collateral type
    pub fn get_vault(&self, collateral_id: CollateralId, _owner: Address) -> Option<VaultInfo> {
        match collateral_id {
            CollateralId::Cspr => None,
            CollateralId::SCSPR => None,
        }
    }

    /// Get branch status for a collateral type
    pub fn get_branch_status(&self, collateral_id: CollateralId) -> Option<BranchStatus> {
        match collateral_id {
            CollateralId::Cspr => None,
            CollateralId::SCSPR => None,
        }
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
}
