//! gUSD Stablecoin Contract
//!
//! CEP-18 compatible stablecoin with protocol-controlled minting and burning.
//! Only authorized protocol contracts (branches, redemption engine) can mint/burn.

use odra::prelude::*;
use odra::casper_types::{U256, RuntimeArgs, runtime_args, Key};
use odra::casper_types::account::AccountHash;
use odra::casper_types::bytesrepr::ToBytes;
use odra::CallDef;
use crate::errors::CdpError;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;

#[cfg(target_arch = "wasm32")]
use casper_contract::contract_api::{runtime, storage};
#[cfg(target_arch = "wasm32")]
use odra::casper_types::URef;

/// Total supply cap (optional, 0 = unlimited)
const DEFAULT_SUPPLY_CAP: u64 = 0;
const CEP18_NAME_KEY: &str = "name";
const CEP18_SYMBOL_KEY: &str = "symbol";
const CEP18_DECIMALS_KEY: &str = "decimals";
const CEP18_TOTAL_SUPPLY_KEY: &str = "total_supply";
const CEP18_BALANCES_DICT: &str = "balances";
const CEP18_ALLOWANCES_DICT: &str = "allowances";
const SECURITY_NONE: u8 = 0;
const SECURITY_ADMIN: u8 = 1;
const SECURITY_MINT_AND_BURN: u8 = 2;
const SECURITY_BURNER: u8 = 3;
const SECURITY_MINTER: u8 = 4;

#[odra::event]
pub struct Transfer {
    pub sender: Address,
    pub recipient: Address,
    pub amount: U256,
}

#[odra::event]
pub struct TransferFrom {
    pub spender: Address,
    pub owner: Address,
    pub recipient: Address,
    pub amount: U256,
}

#[odra::event]
pub struct SetAllowance {
    pub owner: Address,
    pub spender: Address,
    pub allowance: U256,
}

#[odra::event]
pub struct IncreaseAllowance {
    pub owner: Address,
    pub spender: Address,
    pub allowance: U256,
    pub inc_by: U256,
}

#[odra::event]
pub struct DecreaseAllowance {
    pub owner: Address,
    pub spender: Address,
    pub allowance: U256,
    pub decr_by: U256,
}

#[odra::event]
pub struct Mint {
    pub recipient: Address,
    pub amount: U256,
}

#[odra::event]
pub struct Burn {
    pub owner: Address,
    pub amount: U256,
}

/// gUSD Stablecoin Contract
#[odra::module(events = [Transfer, TransferFrom, SetAllowance, IncreaseAllowance, DecreaseAllowance, Mint, Burn])]
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
    /// CEP-18 security levels (address -> level)
    security_levels: Mapping<Address, u8>,
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
        self.ensure_cep18_named_keys();
    }

    /// Upgrade hook (called automatically by Odra during contract upgrade).
    ///
    /// Backfills CEP-18 named keys/dictionaries for explorers/indexers.
    pub fn upgrade(&mut self) {
        self.ensure_cep18_named_keys();
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

    /// Get balance of an owner
    pub fn balance_of(&self, owner: Address) -> U256 {
        self.balances.get(&owner).unwrap_or(U256::zero())
    }

    /// Get allowance for spender
    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.get(&(owner, spender)).unwrap_or(U256::zero())
    }

    /// Transfer tokens to recipient
    pub fn transfer(&mut self, recipient: Address, amount: U256) -> bool {
        let sender = self.env().caller();
        self.transfer_internal(sender, recipient, amount);
        self.env().emit_event(Transfer {
            sender,
            recipient,
            amount,
        });
        true
    }

    /// Approve spender to spend tokens
    pub fn approve(&mut self, spender: Address, amount: U256) -> bool {
        let owner = self.env().caller();
        self.set_allowance_internal(owner, spender, amount);
        self.env().emit_event(SetAllowance {
            owner,
            spender,
            allowance: amount,
        });
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
        self.set_allowance_internal(owner, spender, current_allowance - amount);
        self.env().emit_event(TransferFrom {
            spender,
            owner,
            recipient,
            amount,
        });
        true
    }

    /// Increase allowance for spender
    pub fn increase_allowance(&mut self, spender: Address, amount: U256) -> bool {
        let owner = self.env().caller();
        let current_allowance = self.allowance(owner, spender);
        let new_allowance = current_allowance + amount;
        self.set_allowance_internal(owner, spender, new_allowance);
        self.env().emit_event(IncreaseAllowance {
            owner,
            spender,
            allowance: new_allowance,
            inc_by: amount,
        });
        true
    }

    /// Decrease allowance for spender
    pub fn decrease_allowance(&mut self, spender: Address, amount: U256) -> bool {
        let owner = self.env().caller();
        let current_allowance = self.allowance(owner, spender);
        if current_allowance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }
        let new_allowance = current_allowance - amount;
        self.set_allowance_internal(owner, spender, new_allowance);
        self.env().emit_event(DecreaseAllowance {
            owner,
            spender,
            allowance: new_allowance,
            decr_by: amount,
        });
        true
    }

    // ========== Protocol Functions (Restricted) ==========

    /// Mint new tokens (only authorized minters)
    pub fn mint(&mut self, to: Address, amount: U256) {
        self.require_minter();

        // Check supply cap if set
        let cap = self.supply_cap.get().unwrap_or(U256::zero());
        if cap > U256::zero() {
            let new_supply = self.total_supply() + amount;
            if new_supply > cap {
                self.env().revert(CdpError::InvalidConfig);
            }
        }

        self.mint_internal(to, amount);
    }

    /// Burn tokens from caller
    pub fn burn(&mut self, owner: Address, amount: U256) {
        self.require_burner();
        self.burn_from_internal(owner, amount);
    }

    /// Burn tokens from account (only authorized minters, used for repayment)
    pub fn burn_from(&mut self, from: Address, amount: U256) {
        self.require_burner();
        self.burn_from_internal(from, amount);
    }

    /// Burn tokens using allowance (for SP/Redemption flows)
    ///
    /// This allows authorized protocol contracts to burn gUSD that users
    /// have approved, without needing minter privileges.
    pub fn burn_with_allowance(&mut self, from: Address, amount: U256) {
        let spender = self.env().caller();
        self.require_burner();

        let current_allowance = self.allowance(from, spender);
        if current_allowance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        // Burn the tokens
        self.burn_from_internal(from, amount);

        // Reduce allowance
        self.set_allowance_internal(from, spender, current_allowance - amount);
    }

    /// Protocol transfer: move gUSD between addresses (only authorized minters)
    ///
    /// Used for internal protocol flows (e.g., SP gains distribution).
    pub fn protocol_transfer(&mut self, from: Address, to: Address, amount: U256) {
        self.require_authorized_minter();
        self.transfer_internal(from, to, amount);
        self.env().emit_event(Transfer {
            sender: from,
            recipient: to,
            amount,
        });
    }

    // ========== Admin Functions ==========

    /// Add an authorized minter (admin only via registry)
    pub fn add_minter(&mut self, minter: Address) {
        self.require_registry_admin();
        self.authorized_minters.set(&minter, true);
    }

    /// Remove an authorized minter (admin only via registry)
    pub fn remove_minter(&mut self, minter: Address) {
        self.require_registry_admin();
        self.authorized_minters.set(&minter, false);
    }

    /// Check if address is authorized minter
    pub fn is_minter(&self, account: Address) -> bool {
        self.authorized_minters.get(&account).unwrap_or(false)
    }

    /// Set supply cap (admin only)
    pub fn set_supply_cap(&mut self, cap: U256) {
        self.require_registry_admin();
        self.supply_cap.set(cap);
    }

    /// Change security roles (registry admin only)
    ///
    /// Lists are comma-separated account-hash strings. Empty string = no-op.
    pub fn change_security(
        &mut self,
        none_list: String,
        admin_list: String,
        mint_and_burn_list: String,
        burner_list: String,
    ) {
        self.require_registry_admin();

        // Apply in ascending priority order: Burner < MintAndBurn < Admin < None
        self.apply_security_list(&burner_list, SECURITY_BURNER);
        self.apply_security_list(&mint_and_burn_list, SECURITY_MINT_AND_BURN);
        self.apply_security_list(&admin_list, SECURITY_ADMIN);
        self.apply_security_list(&none_list, SECURITY_NONE);
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

        let new_from_balance = from_balance - amount;
        self.balances.set(&from, new_from_balance);
        self.set_balance_cep18(from, new_from_balance);

        let to_balance = self.balance_of(to);
        let new_to_balance = to_balance + amount;
        self.balances.set(&to, new_to_balance);
        self.set_balance_cep18(to, new_to_balance);
    }

    fn set_allowance_internal(&mut self, owner: Address, spender: Address, amount: U256) {
        self.allowances.set(&(owner, spender), amount);
        self.set_allowance_cep18(owner, spender, amount);
    }

    fn mint_internal(&mut self, to: Address, amount: U256) {
        let current_balance = self.balance_of(to);
        let new_balance = current_balance + amount;
        self.balances.set(&to, new_balance);
        self.set_balance_cep18(to, new_balance);

        let current_supply = self.total_supply();
        let new_supply = current_supply + amount;
        self.total_supply.set(new_supply);
        self.set_total_supply_cep18(new_supply);

        self.env().emit_event(Mint {
            recipient: to,
            amount,
        });
    }

    fn burn_from_internal(&mut self, from: Address, amount: U256) {
        let current_balance = self.balance_of(from);
        if current_balance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        let new_balance = current_balance - amount;
        self.balances.set(&from, new_balance);
        self.set_balance_cep18(from, new_balance);

        let current_supply = self.total_supply();
        let new_supply = current_supply - amount;
        self.total_supply.set(new_supply);
        self.set_total_supply_cep18(new_supply);

        self.env().emit_event(Burn {
            owner: from,
            amount,
        });
    }

    fn set_balance_cep18(&self, owner: Address, amount: U256) {
        let key = Self::cep18_balance_key(owner);
        self.env().set_dictionary_value(CEP18_BALANCES_DICT, key.as_bytes(), amount);

        // Native Casper dictionary update for Explorer
        #[cfg(target_arch = "wasm32")]
        if let Some(dict_uref) = self.get_dict_uref(CEP18_BALANCES_DICT) {
            storage::dictionary_put(dict_uref, key.as_str(), amount);
        }
    }

    fn set_allowance_cep18(&self, owner: Address, spender: Address, amount: U256) {
        let key = self.cep18_allowance_key(owner, spender);
        self.env().set_dictionary_value(CEP18_ALLOWANCES_DICT, &key, amount);

        // Native Casper dictionary update for Explorer
        #[cfg(target_arch = "wasm32")]
        if let Some(dict_uref) = self.get_dict_uref(CEP18_ALLOWANCES_DICT) {
            // Convert [u8; 64] to string for dictionary key
            let key_str = core::str::from_utf8(&key).unwrap_or("");
            storage::dictionary_put(dict_uref, key_str, amount);
        }
    }

    fn set_total_supply_cep18(&self, amount: U256) {
        self.env().set_named_value(CEP18_TOTAL_SUPPLY_KEY, amount);

        // Native Casper named key update for Explorer
        #[cfg(target_arch = "wasm32")]
        {
            let uref = storage::new_uref(amount);
            runtime::put_key(CEP18_TOTAL_SUPPLY_KEY, Key::URef(uref));
        }
    }

    fn cep18_balance_key(owner: Address) -> String {
        let key = Key::from(owner);
        let bytes = key.to_bytes().unwrap_or_default();
        BASE64_STANDARD.encode(bytes)
    }

    fn cep18_allowance_key(&self, owner: Address, spender: Address) -> [u8; 64] {
        // CEP-18 allowance dictionary keys must be <= 64 bytes.
        // Use blake2b(owner_bytes || spender_bytes) and hex-encode (64 chars).
        let mut preimage = Vec::new();
        preimage.extend_from_slice(&owner.to_bytes().unwrap_or_default());
        preimage.extend_from_slice(&spender.to_bytes().unwrap_or_default());

        let digest = self.env().hash(&preimage);
        let mut key = [0u8; 64];
        odra::utils::hex_to_slice(&digest, &mut key);
        key
    }

    fn ensure_cep18_named_keys(&self) {
        // Odra internal state management
        self.env().init_dictionary(CEP18_BALANCES_DICT);
        self.env().init_dictionary(CEP18_ALLOWANCES_DICT);
        self.env().set_named_value(CEP18_NAME_KEY, self.name());
        self.env().set_named_value(CEP18_SYMBOL_KEY, self.symbol());
        self.env().set_named_value(CEP18_DECIMALS_KEY, self.decimals());
        self.env().set_named_value(CEP18_TOTAL_SUPPLY_KEY, self.total_supply());

        // Native Casper named keys for Explorer compatibility (WASM only)
        #[cfg(target_arch = "wasm32")]
        self.put_cep18_named_keys_native();
    }

    /// Create native Casper named keys for CEP-18 Explorer compatibility
    #[cfg(target_arch = "wasm32")]
    fn put_cep18_named_keys_native(&self) {
        // Create balances dictionary if not exists
        if runtime::get_key(CEP18_BALANCES_DICT).is_none() {
            if let Ok(uref) = storage::new_dictionary(CEP18_BALANCES_DICT) {
                runtime::put_key(CEP18_BALANCES_DICT, Key::URef(uref));
            }
        }

        // Create allowances dictionary if not exists
        if runtime::get_key(CEP18_ALLOWANCES_DICT).is_none() {
            if let Ok(uref) = storage::new_dictionary(CEP18_ALLOWANCES_DICT) {
                runtime::put_key(CEP18_ALLOWANCES_DICT, Key::URef(uref));
            }
        }

        // Put metadata as named keys (create new URef for each)
        let name_uref = storage::new_uref(self.name());
        runtime::put_key(CEP18_NAME_KEY, Key::URef(name_uref));

        let symbol_uref = storage::new_uref(self.symbol());
        runtime::put_key(CEP18_SYMBOL_KEY, Key::URef(symbol_uref));

        let decimals_uref = storage::new_uref(self.decimals());
        runtime::put_key(CEP18_DECIMALS_KEY, Key::URef(decimals_uref));

        let total_supply_uref = storage::new_uref(self.total_supply());
        runtime::put_key(CEP18_TOTAL_SUPPLY_KEY, Key::URef(total_supply_uref));
    }

    /// Get or create dictionary URef for native Casper storage
    #[cfg(target_arch = "wasm32")]
    fn get_dict_uref(&self, name: &str) -> Option<URef> {
        runtime::get_key(name).and_then(|key| key.into_uref())
    }

    fn require_authorized_minter(&self) {
        let caller = self.env().caller();
        let level = self.security_levels.get(&caller).unwrap_or(SECURITY_NONE);
        let has_security = level == SECURITY_ADMIN || level == SECURITY_MINT_AND_BURN || level == SECURITY_MINTER;
        if !self.is_minter(caller) && !has_security {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn require_minter(&self) {
        let caller = self.env().caller();
        let level = self.security_levels.get(&caller).unwrap_or(SECURITY_NONE);
        let has_security = level == SECURITY_ADMIN || level == SECURITY_MINT_AND_BURN || level == SECURITY_MINTER;
        if !self.is_minter(caller) && !has_security {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn require_burner(&self) {
        let caller = self.env().caller();
        let level = self.security_levels.get(&caller).unwrap_or(SECURITY_NONE);
        let has_security = level == SECURITY_ADMIN || level == SECURITY_MINT_AND_BURN || level == SECURITY_BURNER;
        if !self.is_minter(caller) && !has_security {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn require_registry_admin(&self) {
        let caller = self.env().caller();
        let registry_addr = self.registry.get();

        if registry_addr.is_none() {
            self.env().revert(CdpError::InvalidConfig);
        }

        let args = runtime_args! {
            "caller" => caller
        };
        let call_def = CallDef::new("is_admin", false, args);
        let is_admin: bool = self.env().call_contract(registry_addr.unwrap(), call_def);

        if !is_admin {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn apply_security_list(&mut self, list: &str, level: u8) {
        for raw in list.split(',') {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let addr = self.parse_account_hash_address(trimmed);
            self.security_levels.set(&addr, level);
        }
    }

    fn parse_account_hash_address(&self, value: &str) -> Address {
        let formatted = if value.starts_with("account-hash-") {
            value.to_string()
        } else {
            format!("account-hash-{}", value)
        };
        let account_hash = AccountHash::from_formatted_str(&formatted)
            .map_err(|_| CdpError::InvalidConfig)
            .unwrap_or_else(|err| self.env().revert(err));
        let key = Key::Account(account_hash);
        Address::try_from(key).unwrap_or_else(|_| self.env().revert(CdpError::InvalidConfig))
    }
}
