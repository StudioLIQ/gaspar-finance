//! Token Adapter Contract
//!
//! Provides a standardized interface for interacting with CEP-18 tokens (stCSPR).
//! Handles:
//! - Approve/transfer_from flows
//! - Fee-on-transfer token support (net received accounting)
//! - Non-standard callback handling
//!
//! This adapter ensures the protocol correctly accounts for actual tokens
//! received when dealing with tokens that may have transfer fees.

use odra::prelude::*;
use odra::casper_types::{U256, RuntimeArgs, runtime_args};
use odra::CallDef;
use crate::errors::CdpError;

/// CEP-18 token interface for cross-contract calls
#[odra::external_contract]
pub trait Cep18Token {
    fn transfer(&mut self, recipient: Address, amount: U256) -> bool;
    fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) -> bool;
    fn approve(&mut self, spender: Address, amount: U256) -> bool;
    fn allowance(&self, owner: Address, spender: Address) -> U256;
    fn balance_of(&self, account: Address) -> U256;
    fn total_supply(&self) -> U256;
}

/// Token metadata
#[odra::odra_type]
pub struct TokenInfo {
    /// Token contract address
    pub address: Address,
    /// Token name
    pub name: String,
    /// Token symbol
    pub symbol: String,
    /// Token decimals
    pub decimals: u8,
    /// Whether this token has fee-on-transfer
    pub has_transfer_fee: bool,
}

/// Transfer result with actual amounts
#[odra::odra_type]
pub struct TransferResult {
    /// Amount requested to transfer
    pub requested_amount: U256,
    /// Actual amount received (may differ due to fees)
    pub actual_received: U256,
    /// Fee deducted (if any)
    pub fee_amount: U256,
    /// Whether transfer was successful
    pub success: bool,
}

/// Token balance snapshot for fee calculation
#[odra::odra_type]
#[derive(Default)]
pub struct BalanceSnapshot {
    /// Balance before operation
    pub before: U256,
    /// Balance after operation
    pub after: U256,
}

/// Token Adapter Contract
#[odra::module]
pub struct TokenAdapter {
    /// Registry contract address
    registry: Var<Address>,
    /// Registered token addresses
    registered_tokens: Mapping<Address, TokenInfo>,
    /// Fee-on-transfer flag for tokens
    has_fee: Mapping<Address, bool>,
    /// Authorized callers (protocol contracts)
    authorized_callers: Mapping<Address, bool>,
    /// Token whitelist (only whitelisted tokens can be used)
    whitelisted_tokens: Mapping<Address, bool>,
}

#[odra::module]
impl TokenAdapter {
    /// Initialize the token adapter
    pub fn init(&mut self, registry: Address) {
        self.registry.set(registry);
    }

    // ========== Token Registration ==========

    /// Register a new token (admin only)
    pub fn register_token(
        &mut self,
        token_address: Address,
        name: String,
        symbol: String,
        decimals: u8,
        has_transfer_fee: bool,
    ) {
        self.require_registry_admin();

        let info = TokenInfo {
            address: token_address,
            name,
            symbol,
            decimals,
            has_transfer_fee,
        };

        self.registered_tokens.set(&token_address, info);
        self.has_fee.set(&token_address, has_transfer_fee);
        self.whitelisted_tokens.set(&token_address, true);
    }

    /// Remove token from registry (admin only)
    pub fn unregister_token(&mut self, token_address: Address) {
        self.require_registry_admin();
        self.whitelisted_tokens.set(&token_address, false);
    }

    /// Check if token is whitelisted
    pub fn is_token_whitelisted(&self, token_address: Address) -> bool {
        self.whitelisted_tokens.get(&token_address).unwrap_or(false)
    }

    /// Get token info
    pub fn get_token_info(&self, token_address: Address) -> Option<TokenInfo> {
        self.registered_tokens.get(&token_address)
    }

    // ========== Safe Transfer Functions ==========

    /// Transfer tokens from sender to recipient with fee accounting
    /// Returns the actual amount received
    pub fn safe_transfer_from(
        &self,
        token_address: Address,
        from: Address,
        to: Address,
        amount: U256,
    ) -> TransferResult {
        // Verify token is whitelisted
        if !self.is_token_whitelisted(token_address) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }

        let has_fee = self.has_fee.get(&token_address).unwrap_or(false);

        if has_fee {
            // For fee-on-transfer tokens, measure actual received
            self.transfer_with_fee_accounting(token_address, from, to, amount)
        } else {
            // For standard tokens, amount sent = amount received
            self.transfer_standard(token_address, from, to, amount)
        }
    }

    /// Safe approve with unlimited amount protection
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn safe_approve(
        &self,
        token_address: Address,
        _spender: Address,
        _amount: U256,
    ) -> bool {
        // Verify token is whitelisted
        if !self.is_token_whitelisted(token_address) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }

        // Placeholder: assume approval succeeds
        // TODO: Wire cross-contract call to token.approve()
        true
    }

    /// Get current allowance
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn get_allowance(
        &self,
        _token_address: Address,
        _owner: Address,
        _spender: Address,
    ) -> U256 {
        // Placeholder: return zero allowance
        // TODO: Wire cross-contract call to token.allowance()
        U256::zero()
    }

    /// Get token balance
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn get_balance(&self, _token_address: Address, _account: Address) -> U256 {
        // Placeholder: return zero balance
        // TODO: Wire cross-contract call to token.balance_of()
        U256::zero()
    }

    // ========== Protocol Integration Functions ==========

    /// Pull tokens from user to protocol (deposit flow)
    /// Handles: approve check, transfer, and actual amount accounting
    pub fn pull_tokens(
        &self,
        token_address: Address,
        from: Address,
        amount: U256,
    ) -> U256 {
        self.require_authorized_caller();

        // Get protocol's current balance
        let balance_before = self.get_balance(token_address, self.env().self_address());

        // Transfer from user to protocol
        let result = self.safe_transfer_from(
            token_address,
            from,
            self.env().self_address(),
            amount,
        );

        if !result.success {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        // For fee-on-transfer, use actual received
        // For standard, use result amount
        if self.has_fee.get(&token_address).unwrap_or(false) {
            let balance_after = self.get_balance(token_address, self.env().self_address());
            balance_after - balance_before
        } else {
            result.actual_received
        }
    }

    /// Push tokens from protocol to user (withdrawal flow)
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn push_tokens(
        &self,
        token_address: Address,
        _to: Address,
        amount: U256,
    ) -> U256 {
        self.require_authorized_caller();

        let has_fee = self.has_fee.get(&token_address).unwrap_or(false);

        // Placeholder: assume transfer succeeds
        // TODO: Wire cross-contract call to token.transfer()

        if has_fee {
            // Placeholder: assume 0.1% fee for fee-on-transfer tokens
            let fee = amount / U256::from(1000u64);
            amount - fee
        } else {
            amount
        }
    }

    // ========== Admin Functions ==========

    /// Add authorized caller (admin only)
    pub fn add_caller(&mut self, caller: Address) {
        self.require_registry_admin();
        self.authorized_callers.set(&caller, true);
    }

    /// Remove authorized caller (admin only)
    pub fn remove_caller(&mut self, caller: Address) {
        self.require_registry_admin();
        self.authorized_callers.set(&caller, false);
    }

    /// Check if caller is authorized
    pub fn is_authorized_caller(&self, caller: Address) -> bool {
        self.authorized_callers.get(&caller).unwrap_or(false)
    }

    /// Set fee-on-transfer flag for a token (admin only)
    pub fn set_token_has_fee(&mut self, token_address: Address, has_fee: bool) {
        self.require_registry_admin();
        self.has_fee.set(&token_address, has_fee);
    }

    // ========== Internal Functions ==========

    fn require_authorized_caller(&self) {
        let caller = self.env().caller();
        if !self.is_authorized_caller(caller) {
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

    fn transfer_standard(
        &self,
        _token_address: Address,
        _from: Address,
        _to: Address,
        amount: U256,
    ) -> TransferResult {
        // Placeholder: assume transfer succeeds
        // TODO: Wire cross-contract call to token.transfer_from()
        TransferResult {
            requested_amount: amount,
            actual_received: amount,
            fee_amount: U256::zero(),
            success: true,
        }
    }

    fn transfer_with_fee_accounting(
        &self,
        _token_address: Address,
        _from: Address,
        _to: Address,
        amount: U256,
    ) -> TransferResult {
        // Placeholder: assume 0.1% fee for fee-on-transfer tokens
        // TODO: Wire cross-contract call to token.transfer_from() with balance snapshots
        let fee = amount / U256::from(1000u64);
        let actual = amount - fee;

        TransferResult {
            requested_amount: amount,
            actual_received: actual,
            fee_amount: fee,
            success: true,
        }
    }
}

/// stCSPR-specific adapter functions
/// Extends TokenAdapter with stCSPR-specific logic
#[odra::module]
pub struct SCSPRAdapter {
    /// Token adapter contract address
    token_adapter: Var<Address>,
    /// stCSPR token address (CEP-18)
    scspr_address: Var<Address>,
    /// LST contract address (for exchange rate)
    lst_contract: Var<Address>,
    /// Admin address
    admin: Var<Address>,
    /// Authorized protocol contracts
    authorized_callers: Mapping<Address, bool>,
}

/// Exchange rate scale (1e18)
const RATE_SCALE: u128 = 1_000_000_000_000_000_000;

#[odra::module]
impl SCSPRAdapter {
    /// Initialize the stCSPR adapter
    pub fn init(
        &mut self,
        token_adapter: Address,
        scspr_address: Address,
        lst_contract: Address,
    ) {
        self.token_adapter.set(token_adapter);
        self.scspr_address.set(scspr_address);
        self.lst_contract.set(lst_contract);
        self.admin.set(self.env().caller());
    }

    /// Get stCSPR/CSPR exchange rate from LST contract
    ///
    /// Returns rate scaled by 1e18 (1e18 = 1.0)
    /// Note: Cross-contract call to ybToken - placeholder for now
    pub fn get_exchange_rate(&self) -> U256 {
        // Placeholder: 1.0 rate (1e18)
        // TODO: Wire cross-contract call to ybToken.get_exchange_rate() when available
        U256::from(RATE_SCALE)
    }

    /// Convert stCSPR shares to CSPR value
    /// Note: Cross-contract call to ybToken - placeholder for now
    pub fn convert_to_assets(&self, shares: U256) -> U256 {
        // Placeholder: 1:1 conversion
        // TODO: Wire cross-contract call to ybToken.convert_to_assets()
        shares
    }

    /// Convert CSPR value to stCSPR shares
    /// Note: Cross-contract call to ybToken - placeholder for now
    pub fn convert_to_shares(&self, assets: U256) -> U256 {
        // Placeholder: 1:1 conversion
        // TODO: Wire cross-contract call to ybToken.convert_to_shares()
        assets
    }

    /// Deposit stCSPR to protocol using transfer_from
    ///
    /// Requires user to have approved this contract for `amount`.
    /// Returns actual amount received (for fee-on-transfer tokens).
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn deposit(&self, _from: Address, amount: U256) -> U256 {
        self.require_authorized_caller();
        // Placeholder: assume full amount transferred
        // TODO: Wire cross-contract call to stCSPR.transfer_from()
        amount
    }

    /// Withdraw stCSPR from protocol to user
    ///
    /// Returns actual amount sent.
    /// Note: Cross-contract call to CEP-18 - placeholder for now
    pub fn withdraw(&self, _to: Address, amount: U256) -> U256 {
        self.require_authorized_caller();
        // Placeholder: assume full amount sent
        // TODO: Wire cross-contract call to stCSPR.transfer()
        amount
    }

    /// Get stCSPR address
    pub fn get_scspr_address(&self) -> Option<Address> {
        self.scspr_address.get()
    }

    /// Get LST contract address
    pub fn get_lst_contract(&self) -> Option<Address> {
        self.lst_contract.get()
    }

    /// Add authorized caller (admin only)
    pub fn add_authorized_caller(&mut self, caller: Address) {
        self.require_admin();
        self.authorized_callers.set(&caller, true);
    }

    /// Remove authorized caller (admin only)
    pub fn remove_authorized_caller(&mut self, caller: Address) {
        self.require_admin();
        self.authorized_callers.set(&caller, false);
    }

    /// Check if caller is authorized
    pub fn is_authorized_caller(&self, caller: Address) -> bool {
        self.authorized_callers.get(&caller).unwrap_or(false)
    }

    // ========== Internal ==========

    fn require_admin(&self) {
        let caller = self.env().caller();
        let admin = self.admin.get();
        match admin {
            Some(adm) if caller == adm => {}
            _ => self.env().revert(CdpError::Unauthorized),
        }
    }

    fn require_authorized_caller(&self) {
        let caller = self.env().caller();
        let admin = self.admin.get();

        // Allow admin or authorized callers
        if let Some(adm) = admin {
            if caller == adm {
                return;
            }
        }

        if !self.is_authorized_caller(caller) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transfer_result_standard() {
        let amount = U256::from(1000u64);
        let result = TransferResult {
            requested_amount: amount,
            actual_received: amount,
            fee_amount: U256::zero(),
            success: true,
        };
        assert_eq!(result.requested_amount, result.actual_received);
        assert!(result.fee_amount.is_zero());
        assert!(result.success);
    }

    #[test]
    fn test_transfer_result_with_fee() {
        let amount = U256::from(1000u64);
        let fee = amount / U256::from(1000u64); // 0.1%
        let actual = amount - fee;

        let result = TransferResult {
            requested_amount: amount,
            actual_received: actual,
            fee_amount: fee,
            success: true,
        };

        assert!(result.actual_received < result.requested_amount);
        assert!(!result.fee_amount.is_zero());
        assert_eq!(result.requested_amount, result.actual_received + result.fee_amount);
    }

    #[test]
    fn test_balance_snapshot_default() {
        let snapshot = BalanceSnapshot::default();
        assert!(snapshot.before.is_zero());
        assert!(snapshot.after.is_zero());
    }

    #[test]
    fn test_fee_on_transfer_calculation() {
        // Simulate 0.1% fee
        let amount = U256::from(100_000u64);
        let fee = amount / U256::from(1000u64);
        let received = amount - fee;

        assert_eq!(fee, U256::from(100u64));
        assert_eq!(received, U256::from(99_900u64));
    }

    #[test]
    fn test_exchange_rate_scaling() {
        // Exchange rate is scaled by 1000
        // Rate of 1050 = 1.05 (5% rewards)
        let rate = 1050u64;
        let cspr_amount = U256::from(1000u64);

        // stCSPR value = CSPR * rate / 1000
        let scspr_value = cspr_amount * U256::from(rate) / U256::from(1000u64);
        assert_eq!(scspr_value, U256::from(1050u64));
    }
}
