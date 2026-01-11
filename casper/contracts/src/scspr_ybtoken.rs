//! stCSPR ybToken (Yield-Bearing Token) Contract
//!
//! LST (Liquid Staking Token) implementation for Casper.
//! Follows the ybToken model where:
//! - shares = stCSPR balance
//! - assets = CSPR backing
//! - R = total_assets / total_shares = CSPR_PER_SCSPR
//!
//! Staking rewards are reflected by R increasing (not by rebasing balances).
//!
//! ## Architecture
//!
//! - CEP-18 compatible share token
//! - Vault logic for CSPR deposits/withdrawals
//! - Exchange rate (R) is derived from total_assets/total_shares
//! - MVP: Operator-based staking sync (contract cannot directly delegate)
//!
//! ## Deposit Flow
//!
//! 1. User deposits CSPR
//! 2. Contract mints stCSPR: minted = assets / R
//! 3. CSPR held in idle buffer (operator delegates externally)
//!
//! ## Rate Update (Operator)
//!
//! 1. Operator compounds rewards off-chain
//! 2. Operator calls sync_assets() to update total_assets
//! 3. R increases, reflecting staking rewards

use odra::prelude::*;
use odra::casper_types::{U256, U512};
use crate::errors::CdpError;

/// Scale factor for internal calculations (1e18)
const SCALE: u128 = 1_000_000_000_000_000_000;
/// Minimum deposit amount (1 CSPR in motes)
const MIN_DEPOSIT: u64 = 1_000_000_000; // 1 CSPR = 1e9 motes
/// Default decimals for stCSPR
const DECIMALS: u8 = 9;
/// Testnet primary validator public key (hex-encoded without 0x prefix)
/// Confirmed: 2026-01-10, block_height=6501862, era_id=20717
const PRIMARY_VALIDATOR_PUBKEY: &str = "0106ca7c39cd272dbf21a86eeb3b36b7c26e2e9b94af64292419f7862936bca2ca";

/// Asset breakdown for total_assets calculation
#[odra::odra_type]
#[derive(Default)]
pub struct AssetBreakdown {
    /// CSPR held in contract (not yet delegated)
    pub idle_cspr: U256,
    /// CSPR delegated to validators
    pub delegated_cspr: U256,
    /// CSPR in undelegation cooldown
    pub undelegating_cspr: U256,
    /// CSPR ready to claim from undelegation
    pub claimable_cspr: U256,
    /// Protocol fees accrued (subtracted from NAV)
    pub protocol_fees: U256,
    /// Realized losses from slashing (subtracted from NAV)
    pub realized_losses: U256,
}

impl AssetBreakdown {
    /// Calculate total_assets = idle + delegated + undelegating + claimable - fees - losses
    pub fn total(&self) -> U256 {
        let gross = self.idle_cspr + self.delegated_cspr + self.undelegating_cspr + self.claimable_cspr;
        let deductions = self.protocol_fees + self.realized_losses;
        if gross > deductions {
            gross - deductions
        } else {
            U256::zero()
        }
    }
}

/// Configuration for the ybToken
#[odra::odra_type]
pub struct YbTokenConfig {
    /// Operator address (can sync assets, trigger compounding)
    pub operator: Address,
    /// Whether deposits are paused
    pub deposits_paused: bool,
    /// Whether withdrawals are paused
    pub withdrawals_paused: bool,
}

/// stCSPR ybToken Contract
///
/// CEP-18 compatible yield-bearing token representing staked CSPR.
#[odra::module]
pub struct ScsprYbToken {
    // ===== CEP-18 Token State =====
    /// Token name
    name: Var<String>,
    /// Token symbol
    symbol: Var<String>,
    /// Decimals (9 for CSPR compatibility)
    decimals: Var<u8>,
    /// Total shares (stCSPR supply)
    total_shares: Var<U256>,
    /// Balance mapping (owner -> shares)
    balances: Mapping<Address, U256>,
    /// Allowance mapping (owner, spender) -> amount
    allowances: Mapping<(Address, Address), U256>,

    // ===== Vault State =====
    /// Asset breakdown for NAV calculation
    assets: Var<AssetBreakdown>,
    /// Last asset sync timestamp
    last_sync_timestamp: Var<u64>,
    /// Configuration
    config: Var<YbTokenConfig>,
    /// Withdraw queue contract address
    withdraw_queue: Var<Option<Address>>,
    /// Admin address
    admin: Var<Address>,
}

#[odra::module]
impl ScsprYbToken {
    /// Initialize the ybToken contract
    pub fn init(&mut self, admin: Address, operator: Address) {
        self.name.set(String::from("stCSPR"));
        self.symbol.set(String::from("stCSPR"));
        self.decimals.set(DECIMALS);
        self.total_shares.set(U256::zero());
        self.assets.set(AssetBreakdown::default());
        self.last_sync_timestamp.set(0);
        self.admin.set(admin);
        self.withdraw_queue.set(None);

        self.config.set(YbTokenConfig {
            operator,
            deposits_paused: false,
            withdrawals_paused: false,
        });
    }

    // ===== CEP-18 Standard Functions =====

    /// Get token name
    pub fn name(&self) -> String {
        self.name.get().unwrap_or_else(|| String::from("stCSPR"))
    }

    /// Get token symbol
    pub fn symbol(&self) -> String {
        self.symbol.get().unwrap_or_else(|| String::from("stCSPR"))
    }

    /// Get decimals
    pub fn decimals(&self) -> u8 {
        self.decimals.get().unwrap_or(DECIMALS)
    }

    /// Get total supply (total shares)
    pub fn total_supply(&self) -> U256 {
        self.total_shares()
    }

    /// Get balance of account (in shares)
    pub fn balance_of(&self, account: Address) -> U256 {
        self.balances.get(&account).unwrap_or(U256::zero())
    }

    /// Get allowance
    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.get(&(owner, spender)).unwrap_or(U256::zero())
    }

    /// Transfer shares to recipient
    pub fn transfer(&mut self, recipient: Address, amount: U256) -> bool {
        let sender = self.env().caller();
        self.transfer_internal(sender, recipient, amount);
        true
    }

    /// Approve spender to transfer shares
    pub fn approve(&mut self, spender: Address, amount: U256) -> bool {
        let owner = self.env().caller();
        self.allowances.set(&(owner, spender), amount);
        true
    }

    /// Transfer from owner to recipient (requires allowance)
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) -> bool {
        let spender = self.env().caller();

        let current_allowance = self.allowance(owner, spender);
        if current_allowance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.transfer_internal(owner, recipient, amount);
        self.allowances.set(&(owner, spender), current_allowance - amount);
        true
    }

    // ===== ybToken Vault Functions =====

    /// Deposit CSPR and receive stCSPR shares
    ///
    /// # Arguments
    /// * Attached CSPR value is deposited
    ///
    /// # Returns
    /// * Amount of stCSPR minted
    #[odra(payable)]
    pub fn deposit(&mut self) -> U256 {
        // Check deposits not paused
        let config = self.config.get().unwrap();
        if config.deposits_paused {
            self.env().revert(CdpError::SafeModeActive);
        }

        let caller = self.env().caller();
        let cspr_amount_u512 = self.env().attached_value();

        // Convert U512 to U256 (safe for CSPR amounts which fit in U256)
        let cspr_amount = u512_to_u256(cspr_amount_u512);

        // Validate minimum deposit
        if cspr_amount < U256::from(MIN_DEPOSIT) {
            self.env().revert(CdpError::BelowMinDebt);
        }

        // Calculate shares to mint: shares = assets / R = assets * total_shares / total_assets
        let shares_to_mint = self.convert_to_shares(cspr_amount);

        // Handle first deposit (bootstrap)
        let shares_to_mint = if self.total_shares().is_zero() {
            // First deposit: 1:1 ratio
            cspr_amount
        } else {
            shares_to_mint
        };

        // Update assets (add to idle)
        let mut assets = self.assets.get().unwrap_or_default();
        assets.idle_cspr = assets.idle_cspr + cspr_amount;
        self.assets.set(assets);

        // Mint shares to caller
        self.mint_internal(caller, shares_to_mint);

        shares_to_mint
    }

    /// Get total shares (stCSPR supply)
    pub fn total_shares(&self) -> U256 {
        self.total_shares.get().unwrap_or(U256::zero())
    }

    /// Get total assets (CSPR backing)
    ///
    /// total_assets = idle_cspr + delegated_cspr + undelegating_cspr + claimable_cspr - fees - losses
    pub fn total_assets(&self) -> U256 {
        self.assets.get().unwrap_or_default().total()
    }

    /// Get exchange rate: R = CSPR_PER_SCSPR = total_assets / total_shares
    ///
    /// Returns (rate_int, rate_decimals) where rate = rate_int / 10^rate_decimals
    ///
    /// Uses 18 decimal precision for rate calculation.
    pub fn cspr_per_scspr(&self) -> (U256, u8) {
        let total_assets = self.total_assets();
        let total_shares = self.total_shares();

        if total_shares.is_zero() {
            // No shares: default rate is 1.0
            return (U256::from(SCALE), 18);
        }

        // R = total_assets * SCALE / total_shares
        let rate = total_assets * U256::from(SCALE) / total_shares;
        (rate, 18)
    }

    /// Get exchange rate as simple ratio (for CDP oracle)
    ///
    /// Returns rate scaled by 1e18
    pub fn get_exchange_rate(&self) -> U256 {
        let (rate, _) = self.cspr_per_scspr();
        rate
    }

    /// Convert shares to assets: assets = shares * R
    pub fn convert_to_assets(&self, shares: U256) -> U256 {
        let total_assets = self.total_assets();
        let total_shares = self.total_shares();

        if total_shares.is_zero() {
            return shares; // 1:1 if no shares
        }

        // assets = shares * total_assets / total_shares
        shares * total_assets / total_shares
    }

    /// Convert assets to shares: shares = assets / R
    pub fn convert_to_shares(&self, assets: U256) -> U256 {
        let total_assets = self.total_assets();
        let total_shares = self.total_shares();

        if total_shares.is_zero() {
            return assets; // 1:1 if no shares
        }

        if total_assets.is_zero() {
            return U256::zero();
        }

        // shares = assets * total_shares / total_assets
        assets * total_shares / total_assets
    }

    /// Get asset breakdown
    pub fn get_asset_breakdown(&self) -> AssetBreakdown {
        self.assets.get().unwrap_or_default()
    }

    /// Get last sync timestamp
    pub fn get_last_sync_timestamp(&self) -> u64 {
        self.last_sync_timestamp.get().unwrap_or(0)
    }

    /// Get primary validator public key (testnet)
    pub fn get_primary_validator(&self) -> String {
        String::from(PRIMARY_VALIDATOR_PUBKEY)
    }

    // ===== Operator Functions =====

    /// Sync asset totals (operator only)
    ///
    /// Called after off-chain staking operations to update NAV.
    /// This is how staking rewards are reflected in the rate.
    ///
    /// # Arguments
    /// * `delegated` - CSPR currently delegated to validators
    /// * `undelegating` - CSPR in undelegation cooldown
    /// * `claimable` - CSPR ready to claim
    pub fn sync_assets(
        &mut self,
        delegated: U256,
        undelegating: U256,
        claimable: U256
    ) {
        self.require_operator();

        let mut assets = self.assets.get().unwrap_or_default();
        assets.delegated_cspr = delegated;
        assets.undelegating_cspr = undelegating;
        assets.claimable_cspr = claimable;
        self.assets.set(assets);

        self.last_sync_timestamp.set(self.env().get_block_time());
    }

    /// Record realized loss from slashing (operator only)
    pub fn record_loss(&mut self, loss_amount: U256) {
        self.require_operator();

        let mut assets = self.assets.get().unwrap_or_default();
        assets.realized_losses = assets.realized_losses + loss_amount;
        self.assets.set(assets);
    }

    /// Withdraw idle CSPR to operator for delegation (operator only)
    ///
    /// Returns the amount withdrawn.
    pub fn withdraw_idle_for_delegation(&mut self, amount: U256) -> U256 {
        self.require_operator();

        let mut assets = self.assets.get().unwrap_or_default();
        if assets.idle_cspr < amount {
            self.env().revert(CdpError::InsufficientCollateral);
        }

        // Move from idle to delegated (operator will actually delegate)
        assets.idle_cspr = assets.idle_cspr - amount;
        assets.delegated_cspr = assets.delegated_cspr + amount;
        self.assets.set(assets);

        // Transfer CSPR to operator
        let config = self.config.get().unwrap();
        self.env().transfer_tokens(&config.operator, &u256_to_u512(amount));

        amount
    }

    /// Deposit CSPR from operator after claiming rewards/undelegation
    #[odra(payable)]
    pub fn deposit_from_operator(&mut self) {
        self.require_operator();

        let amount_u512 = self.env().attached_value();
        let amount = u512_to_u256(amount_u512);
        let mut assets = self.assets.get().unwrap_or_default();

        // Add to idle (this includes compounded rewards)
        assets.idle_cspr = assets.idle_cspr + amount;
        self.assets.set(assets);
    }

    // ===== Withdraw Queue Integration =====

    /// Set withdraw queue contract address (admin only)
    pub fn set_withdraw_queue(&mut self, queue_address: Address) {
        self.require_admin();
        self.withdraw_queue.set(Some(queue_address));
    }

    /// Get withdraw queue address
    pub fn get_withdraw_queue(&self) -> Option<Address> {
        self.withdraw_queue.get().flatten()
    }

    /// Burn shares (called by withdraw queue during claim)
    pub fn burn_from_queue(&mut self, owner: Address, amount: U256) {
        self.require_withdraw_queue();
        self.burn_internal(owner, amount);
    }

    /// Transfer CSPR to user (called by withdraw queue during claim)
    pub fn transfer_cspr_to_user(&mut self, recipient: Address, amount: U256) {
        self.require_withdraw_queue();

        let mut assets = self.assets.get().unwrap_or_default();

        // Use claimable first, then idle
        if assets.claimable_cspr >= amount {
            assets.claimable_cspr = assets.claimable_cspr - amount;
        } else {
            let from_claimable = assets.claimable_cspr;
            let from_idle = amount - from_claimable;

            if assets.idle_cspr < from_idle {
                self.env().revert(CdpError::InsufficientCollateral);
            }

            assets.claimable_cspr = U256::zero();
            assets.idle_cspr = assets.idle_cspr - from_idle;
        }

        self.assets.set(assets);
        self.env().transfer_tokens(&recipient, &u256_to_u512(amount));
    }

    // ===== Admin Functions =====

    /// Pause deposits (admin only)
    pub fn pause_deposits(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.deposits_paused = true;
        self.config.set(config);
    }

    /// Unpause deposits (admin only)
    pub fn unpause_deposits(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.deposits_paused = false;
        self.config.set(config);
    }

    /// Pause withdrawals (admin only)
    pub fn pause_withdrawals(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.withdrawals_paused = true;
        self.config.set(config);
    }

    /// Unpause withdrawals (admin only)
    pub fn unpause_withdrawals(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.withdrawals_paused = false;
        self.config.set(config);
    }

    /// Update operator address (admin only)
    pub fn set_operator(&mut self, new_operator: Address) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.operator = new_operator;
        self.config.set(config);
    }

    /// Get operator address
    pub fn get_operator(&self) -> Address {
        self.config.get().unwrap().operator
    }

    /// Get admin address
    pub fn get_admin(&self) -> Address {
        self.admin.get().unwrap()
    }

    /// Get config
    pub fn get_config(&self) -> YbTokenConfig {
        self.config.get().unwrap()
    }

    // ===== Internal Functions =====

    fn transfer_internal(&mut self, from: Address, to: Address, amount: U256) {
        let from_balance = self.balance_of(from);
        if from_balance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.balances.set(&from, from_balance - amount);
        let to_balance = self.balance_of(to);
        self.balances.set(&to, to_balance + amount);
    }

    fn mint_internal(&mut self, to: Address, amount: U256) {
        let current_balance = self.balance_of(to);
        self.balances.set(&to, current_balance + amount);

        let current_supply = self.total_shares();
        self.total_shares.set(current_supply + amount);
    }

    fn burn_internal(&mut self, from: Address, amount: U256) {
        let current_balance = self.balance_of(from);
        if current_balance < amount {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }

        self.balances.set(&from, current_balance - amount);

        let current_supply = self.total_shares();
        self.total_shares.set(current_supply - amount);
    }

    fn require_admin(&self) {
        let caller = self.env().caller();
        let admin = self.admin.get().unwrap();
        if caller != admin {
            self.env().revert(CdpError::Unauthorized);
        }
    }

    fn require_operator(&self) {
        let caller = self.env().caller();
        let config = self.config.get().unwrap();
        if caller != config.operator {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn require_withdraw_queue(&self) {
        let caller = self.env().caller();
        let queue = self.withdraw_queue.get().flatten();
        match queue {
            Some(q) if caller == q => {}
            _ => self.env().revert(CdpError::UnauthorizedProtocol),
        }
    }
}

// ===== Helper Functions =====

/// Convert U512 to U256 (safe for CSPR amounts which fit in U256)
///
/// CSPR total supply is ~12B with 9 decimals = 12e18 which fits in U256.
/// This function takes the lower 256 bits.
fn u512_to_u256(value: U512) -> U256 {
    // Extract lower 256 bits (4 x 64-bit limbs)
    let mut bytes = [0u8; 64];
    value.to_little_endian(&mut bytes);
    U256::from_little_endian(&bytes[..32])
}

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
    fn test_asset_breakdown_total() {
        let assets = AssetBreakdown {
            idle_cspr: U256::from(100u64),
            delegated_cspr: U256::from(200u64),
            undelegating_cspr: U256::from(50u64),
            claimable_cspr: U256::from(25u64),
            protocol_fees: U256::from(10u64),
            realized_losses: U256::from(5u64),
        };

        // Total = 100 + 200 + 50 + 25 - 10 - 5 = 360
        assert_eq!(assets.total(), U256::from(360u64));
    }

    #[test]
    fn test_asset_breakdown_total_with_high_deductions() {
        let assets = AssetBreakdown {
            idle_cspr: U256::from(100u64),
            delegated_cspr: U256::zero(),
            undelegating_cspr: U256::zero(),
            claimable_cspr: U256::zero(),
            protocol_fees: U256::from(50u64),
            realized_losses: U256::from(60u64), // More than assets
        };

        // Should return 0, not underflow
        assert_eq!(assets.total(), U256::zero());
    }

    #[test]
    fn test_primary_validator_constant() {
        assert_eq!(
            PRIMARY_VALIDATOR_PUBKEY,
            "0106ca7c39cd272dbf21a86eeb3b36b7c26e2e9b94af64292419f7862936bca2ca"
        );
    }

    #[test]
    fn test_scale_constant() {
        assert_eq!(SCALE, 1_000_000_000_000_000_000);
    }
}
