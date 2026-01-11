//! gUSD Stablecoin Contract
//!
//! CEP-18 compatible stablecoin with protocol-controlled minting and burning.
//! Only authorized protocol contracts (branches, redemption engine) can mint/burn.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::errors::CdpError;

/// Total supply cap (optional, 0 = unlimited)
const DEFAULT_SUPPLY_CAP: u64 = 0;

/// gUSD Stablecoin Contract
#[odra::module]
pub struct CsprUsd {
    /// Token name
    name: Var<String>,
    /// Token symbol
    symbol: Var<String>,
    /// Decimals (18 for gUSD)
    decimals: Var<u8>,
    /// Total supply
    total_supply: Var<U256>,
    /// Balance mapping
    balances: Mapping<Address, U256>,
    /// Allowance mapping (owner -> spender -> amount)
    allowances: Mapping<(Address, Address), U256>,
    /// Registry contract address (for access control)
    registry: Var<Address>,
    /// Authorized minters (protocol contracts)
    authorized_minters: Mapping<Address, bool>,
    /// Optional supply cap
    supply_cap: Var<U256>,
}

#[odra::module]
impl CsprUsd {
    /// Initialize the stablecoin
    pub fn init(&mut self, registry: Address) {
        self.name.set(String::from("gUSD"));
        self.symbol.set(String::from("gUSD"));
        self.decimals.set(18);
        self.total_supply.set(U256::zero());
        self.registry.set(registry);
        self.supply_cap.set(U256::from(DEFAULT_SUPPLY_CAP));
    }

    // ========== CEP-18 Standard Functions ==========

    /// Get token name
    pub fn name(&self) -> String {
        self.name.get().unwrap_or_else(|| String::from("gUSD"))
    }

    /// Get token symbol
    pub fn symbol(&self) -> String {
        self.symbol.get().unwrap_or_else(|| String::from("gUSD"))
    }

    /// Get decimals
    pub fn decimals(&self) -> u8 {
        self.decimals.get().unwrap_or(18)
    }

    /// Get total supply
    pub fn total_supply(&self) -> U256 {
        self.total_supply.get().unwrap_or(U256::zero())
    }

    /// Get balance of an account
    pub fn balance_of(&self, account: Address) -> U256 {
        self.balances.get(&account).unwrap_or(U256::zero())
    }

    /// Get allowance for spender
    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.get(&(owner, spender)).unwrap_or(U256::zero())
    }

    /// Transfer tokens to recipient
    pub fn transfer(&mut self, recipient: Address, amount: U256) -> bool {
        let sender = self.env().caller();
        self.transfer_internal(sender, recipient, amount);
        true
    }

    /// Approve spender to spend tokens
    pub fn approve(&mut self, spender: Address, amount: U256) -> bool {
        let owner = self.env().caller();
        self.approve_internal(owner, spender, amount);
        true
    }

    /// Transfer tokens from owner to recipient (requires allowance)
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) -> bool {
        let spender = self.env().caller();

        let current_allowance = self.allowance(owner, spender);
        if current_allowance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.transfer_internal(owner, recipient, amount);
        self.approve_internal(owner, spender, current_allowance - amount);
        true
    }

    // ========== Protocol Functions (Restricted) ==========

    /// Mint new tokens (only authorized minters)
    pub fn mint(&mut self, to: Address, amount: U256) {
        self.require_authorized_minter();

        // Check supply cap if set
        let cap = self.supply_cap.get().unwrap_or(U256::zero());
        if cap > U256::zero() {
            let new_supply = self.total_supply() + amount;
            if new_supply > cap {
                self.env().revert(CdpError::InvalidConfig);
            }
        }

        let current_balance = self.balance_of(to);
        self.balances.set(&to, current_balance + amount);

        let current_supply = self.total_supply();
        self.total_supply.set(current_supply + amount);
    }

    /// Burn tokens from caller
    pub fn burn(&mut self, amount: U256) {
        let caller = self.env().caller();
        self.burn_from_internal(caller, amount);
    }

    /// Burn tokens from account (only authorized minters, used for repayment)
    pub fn burn_from(&mut self, from: Address, amount: U256) {
        self.require_authorized_minter();
        self.burn_from_internal(from, amount);
    }

    // ========== Admin Functions ==========

    /// Add an authorized minter (admin only via registry)
    pub fn add_minter(&mut self, minter: Address) {
        // TODO: Check caller is registry admin
        self.authorized_minters.set(&minter, true);
    }

    /// Remove an authorized minter (admin only via registry)
    pub fn remove_minter(&mut self, minter: Address) {
        // TODO: Check caller is registry admin
        self.authorized_minters.set(&minter, false);
    }

    /// Check if address is authorized minter
    pub fn is_minter(&self, account: Address) -> bool {
        self.authorized_minters.get(&account).unwrap_or(false)
    }

    /// Set supply cap (admin only)
    pub fn set_supply_cap(&mut self, cap: U256) {
        // TODO: Check caller is registry admin
        self.supply_cap.set(cap);
    }

    /// Get supply cap
    pub fn get_supply_cap(&self) -> U256 {
        self.supply_cap.get().unwrap_or(U256::zero())
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    // ========== Internal Functions ==========

    fn transfer_internal(&mut self, from: Address, to: Address, amount: U256) {
        let from_balance = self.balance_of(from);
        if from_balance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.balances.set(&from, from_balance - amount);

        let to_balance = self.balance_of(to);
        self.balances.set(&to, to_balance + amount);
    }

    fn approve_internal(&mut self, owner: Address, spender: Address, amount: U256) {
        self.allowances.set(&(owner, spender), amount);
    }

    fn burn_from_internal(&mut self, from: Address, amount: U256) {
        let current_balance = self.balance_of(from);
        if current_balance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.balances.set(&from, current_balance - amount);

        let current_supply = self.total_supply();
        self.total_supply.set(current_supply - amount);
    }

    fn require_authorized_minter(&self) {
        let caller = self.env().caller();
        if !self.is_minter(caller) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }
}
