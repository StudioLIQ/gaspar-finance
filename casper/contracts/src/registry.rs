//! Registry contract for managing branches and protocol configuration.

use odra::prelude::*;
use odra::casper_types::{Key, U256};
use crate::types::{CollateralId, ProtocolConfig, InterestRateBounds};
use crate::interfaces::CollateralConfig;
use crate::errors::CdpError;

/// Registry contract for CDP protocol configuration
#[odra::module]
pub struct Registry {
    /// Protocol admin address
    admin: Var<Address>,
    /// Router contract address
    router: Var<Option<Address>>,
    /// Stablecoin (gUSD) contract address
    stablecoin: Var<Option<Address>>,
    /// Treasury contract address
    treasury: Var<Option<Address>>,
    /// Oracle adapter contract address
    oracle: Var<Option<Address>>,
    /// Stability pool contract address
    stability_pool: Var<Option<Address>>,
    /// Liquidation engine contract address
    liquidation_engine: Var<Option<Address>>,
    /// Branch for CSPR collateral
    branch_cspr: Var<Option<Address>>,
    /// Branch for stCSPR collateral
    branch_scspr: Var<Option<Address>>,
    /// Protocol configuration
    config: Var<ProtocolConfig>,
    /// Collateral configurations
    collateral_configs: Mapping<CollateralId, CollateralConfig>,
}

#[odra::module]
impl Registry {
    /// Initialize the registry with primitive config values.
    /// Uses Key instead of Address to allow deployment via casper-client.
    pub fn init(
        &mut self,
        admin: Key,
        mcr_bps: u32,
        min_debt: U256,
        borrowing_fee_bps: u32,
        redemption_fee_bps: u32,
        liquidation_penalty_bps: u32,
        interest_min_bps: u32,
        interest_max_bps: u32,
    ) {
        let config = ProtocolConfig {
            mcr_bps,
            min_debt,
            borrowing_fee_bps,
            redemption_fee_bps,
            liquidation_penalty_bps,
            interest_rate_bounds: InterestRateBounds {
                min_bps: interest_min_bps,
                max_bps: interest_max_bps,
            },
        };
        // Convert Key to Address
        let admin_addr = Address::try_from(admin).expect("Invalid admin key");
        self.admin.set(admin_addr);
        self.config.set(config);
    }

    /// Set the router contract address (admin only)
    pub fn set_router(&mut self, router: Address) {
        self.require_admin();
        self.router.set(Some(router));
    }

    /// Set the stablecoin contract address (admin only)
    pub fn set_stablecoin(&mut self, stablecoin: Address) {
        self.require_admin();
        self.stablecoin.set(Some(stablecoin));
    }

    /// Set the treasury contract address (admin only)
    pub fn set_treasury(&mut self, treasury: Address) {
        self.require_admin();
        self.treasury.set(Some(treasury));
    }

    /// Set the oracle adapter contract address (admin only)
    pub fn set_oracle(&mut self, oracle: Address) {
        self.require_admin();
        self.oracle.set(Some(oracle));
    }

    /// Set the stability pool contract address (admin only)
    pub fn set_stability_pool(&mut self, stability_pool: Address) {
        self.require_admin();
        self.stability_pool.set(Some(stability_pool));
    }

    /// Set the liquidation engine contract address (admin only)
    pub fn set_liquidation_engine(&mut self, liquidation_engine: Address) {
        self.require_admin();
        self.liquidation_engine.set(Some(liquidation_engine));
    }

    /// Register CSPR branch (admin only)
    pub fn set_branch_cspr(&mut self, branch: Address, config: CollateralConfig) {
        self.require_admin();
        self.branch_cspr.set(Some(branch));
        self.collateral_configs.set(&CollateralId::Cspr, config);
    }

    /// Register CSPR branch with primitive parameters (admin only).
    pub fn register_branch_cspr(&mut self, branch: Address, decimals: u8, mcr_bps: u32) {
        let config = CollateralConfig {
            collateral_id: CollateralId::Cspr,
            branch_address: branch,
            is_active: true,
            token_address: None,
            decimals,
            mcr_bps,
        };
        self.set_branch_cspr(branch, config);
    }

    /// Register stCSPR branch (admin only)
    pub fn set_branch_scspr(&mut self, branch: Address, config: CollateralConfig) {
        self.require_admin();
        self.branch_scspr.set(Some(branch));
        self.collateral_configs.set(&CollateralId::SCSPR, config);
    }

    /// Register stCSPR branch with primitive parameters (admin only).
    pub fn register_branch_scspr(
        &mut self,
        branch: Address,
        token_address: Address,
        decimals: u8,
        mcr_bps: u32,
    ) {
        let config = CollateralConfig {
            collateral_id: CollateralId::SCSPR,
            branch_address: branch,
            is_active: true,
            token_address: Some(token_address),
            decimals,
            mcr_bps,
        };
        self.set_branch_scspr(branch, config);
    }

    /// Update protocol configuration (admin only)
    pub fn set_config(&mut self, config: ProtocolConfig) {
        self.require_admin();
        self.config.set(config);
    }

    /// Transfer admin to new address (admin only)
    pub fn transfer_admin(&mut self, new_admin: Address) {
        self.require_admin();
        self.admin.set(new_admin);
    }

    /// Get the admin address
    pub fn get_admin(&self) -> Option<Address> {
        self.admin.get()
    }

    /// Get the router address
    pub fn get_router(&self) -> Option<Address> {
        self.router.get().flatten()
    }

    /// Get the stablecoin address
    pub fn get_stablecoin(&self) -> Option<Address> {
        self.stablecoin.get().flatten()
    }

    /// Get the treasury address
    pub fn get_treasury(&self) -> Option<Address> {
        self.treasury.get().flatten()
    }

    /// Get the oracle address
    pub fn get_oracle(&self) -> Option<Address> {
        self.oracle.get().flatten()
    }

    /// Get the stability pool address
    pub fn get_stability_pool(&self) -> Option<Address> {
        self.stability_pool.get().flatten()
    }

    /// Get the liquidation engine address
    pub fn get_liquidation_engine(&self) -> Option<Address> {
        self.liquidation_engine.get().flatten()
    }

    /// Get branch address by collateral type
    pub fn get_branch(&self, collateral_id: CollateralId) -> Option<Address> {
        match collateral_id {
            CollateralId::Cspr => self.branch_cspr.get().flatten(),
            CollateralId::SCSPR => self.branch_scspr.get().flatten(),
        }
    }

    /// Get collateral config by collateral type
    pub fn get_collateral_config(&self, collateral_id: CollateralId) -> Option<CollateralConfig> {
        self.collateral_configs.get(&collateral_id)
    }

    /// Get protocol configuration
    pub fn get_config(&self) -> Option<ProtocolConfig> {
        self.config.get()
    }

    /// Check if caller is admin
    pub fn is_admin(&self, caller: Address) -> bool {
        self.admin.get().map_or(false, |admin| admin == caller)
    }

    fn require_admin(&self) {
        let caller = self.env().caller();
        if !self.is_admin(caller) {
            self.env().revert(CdpError::Unauthorized);
        }
    }
}

/// Default protocol configuration
pub fn default_protocol_config() -> ProtocolConfig {
    ProtocolConfig {
        mcr_bps: 11000,
        min_debt: U256::from(1) * U256::from(10).pow(U256::from(18)),
        borrowing_fee_bps: 50,
        redemption_fee_bps: 50,
        liquidation_penalty_bps: 1000,
        interest_rate_bounds: InterestRateBounds {
            min_bps: 200,
            max_bps: 4000,
        },
    }
}
