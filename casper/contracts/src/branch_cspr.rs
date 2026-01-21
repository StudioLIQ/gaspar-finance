//! Branch contract for native CSPR collateral.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, VaultData, VaultKey, UserVaultIndex, SafeModeState, OracleStatus};
use crate::interfaces::{VaultInfo, BranchStatus, AdjustVaultParams};
use crate::errors::CdpError;
use crate::interest::accrue_interest;

/// Minimum Collateralization Ratio in basis points (110% = 11000 bps)
const MCR_BPS: u32 = 11000;
/// Minimum debt in smallest unit (1 gUSD)
const MIN_DEBT_WHOLE: u64 = 1;
/// Price scale (1e18) - prices are in 18 decimals
const PRICE_SCALE: u64 = 1_000_000_000_000_000_000;
/// Collateral decimals (CSPR uses 9 decimals)
const COLLATERAL_DECIMALS: u64 = 1_000_000_000;
/// Maximum interest rate in basis points (40% = 4000 bps)
const MAX_INTEREST_RATE_BPS: u32 = 4000;

/// Entry in the sorted vault list (by interest rate)
#[odra::odra_type]
pub struct SortedVaultEntry {
    /// Vault key
    pub vault_key: VaultKey,
    /// Interest rate in bps for sorting
    pub interest_rate_bps: u32,
    /// Next entry in the list (lower rate)
    pub prev: Option<VaultKey>,
    /// Previous entry in the list (higher rate)
    pub next: Option<VaultKey>,
}

/// Branch contract for CSPR collateral
#[odra::module]
pub struct BranchCspr {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address
    router: Var<Address>,
    /// Mapping from vault key to vault data
    vaults: Mapping<VaultKey, VaultData>,
    /// Sorted vault entries by interest rate (for redemption ordering)
    sorted_vaults: Mapping<VaultKey, SortedVaultEntry>,
    /// Head of sorted list (lowest interest rate)
    sorted_head: Var<Option<VaultKey>>,
    /// Tail of sorted list (highest interest rate)
    sorted_tail: Var<Option<VaultKey>>,
    /// Total collateral in the branch
    total_collateral: Var<U256>,
    /// Total debt in the branch
    total_debt: Var<U256>,
    /// Number of active vaults
    vault_count: Var<u64>,
    /// Last known good price (cached for safe mode)
    last_good_price: Var<U256>,
    /// Next vault id per owner (starts at 1)
    next_vault_id: Mapping<Address, u64>,
    /// Active vault count per owner
    user_vault_count: Mapping<Address, u64>,
    /// Mapping from (owner, index) to vault id for enumeration
    user_vault_ids: Mapping<UserVaultIndex, u64>,
    /// Mapping from vault key to its index in the owner's list
    vault_indices: Mapping<VaultKey, u64>,
}

#[odra::module]
impl BranchCspr {
    /// Initialize the branch
    pub fn init(&mut self, registry: Address, router: Address) {
        self.registry.set(registry);
        self.router.set(router);
        self.total_collateral.set(U256::zero());
        self.total_debt.set(U256::zero());
        self.vault_count.set(0);
        self.sorted_head.set(None);
        self.sorted_tail.set(None);
        self.last_good_price.set(U256::from(PRICE_SCALE)); // Default 1:1 price
    }

    /// Open a new vault with CSPR collateral.
    ///
    /// Returns the newly created vault id (unique per owner, per branch).
    pub fn open_vault(
        &mut self,
        owner: Address,
        collateral_amount: U256,
        debt_amount: U256,
        interest_rate_bps: u32,
    ) -> u64 {
        self.require_router();
        let caller = owner;

        // Defensive check (router validates too).
        if interest_rate_bps > MAX_INTEREST_RATE_BPS {
            self.env().revert(CdpError::InterestRateOutOfBounds);
        }

        // Check minimum debt
        let min_debt = U256::from(MIN_DEBT_WHOLE) * U256::from(PRICE_SCALE);
        if debt_amount < min_debt {
            self.env().revert(CdpError::BelowMinDebt);
        }

        // Check MCR (using last known good price)
        let collateral_value = self.get_collateral_value(collateral_amount);
        self.check_mcr(collateral_value, debt_amount);

        // Allocate a new vault id for this owner.
        let next_id = self.next_vault_id.get(&caller).unwrap_or(1);
        let vault_key = VaultKey { owner: caller, id: next_id };
        self.next_vault_id.set(&caller, next_id.saturating_add(1));

        // Create the vault
        let vault = VaultData {
            owner: caller,
            collateral_id: CollateralId::Cspr,
            collateral: collateral_amount,
            debt: debt_amount,
            interest_rate_bps,
            last_accrual_timestamp: self.env().get_block_time(),
        };

        self.vaults.set(&vault_key, vault);

        // Add to sorted list
        self.insert_into_sorted_list(vault_key, interest_rate_bps);

        // Update totals
        let current_collateral = self.total_collateral.get().unwrap_or(U256::zero());
        let current_debt = self.total_debt.get().unwrap_or(U256::zero());
        let current_count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(current_collateral + collateral_amount);
        self.total_debt.set(current_debt + debt_amount);
        self.vault_count.set(current_count + 1);

        // Track per-user vault list for enumeration.
        let user_count = self.user_vault_count.get(&caller).unwrap_or(0);
        let idx_key = UserVaultIndex { owner: caller, index: user_count };
        self.user_vault_ids.set(&idx_key, next_id);
        self.vault_indices.set(&vault_key, user_count);
        self.user_vault_count.set(&caller, user_count + 1);

        // TODO: Transfer CSPR from caller (requires payable entry point)
        // TODO: Mint gUSD to caller

        next_id
    }

    /// Adjust an existing vault
    pub fn adjust_vault(
        &mut self,
        owner: Address,
        vault_id: u64,
        collateral_delta: U256,
        collateral_is_withdraw: bool,
        debt_delta: U256,
        debt_is_repay: bool,
    ) {
        self.require_router();
        let caller = owner;
        let vault_key = VaultKey { owner: caller, id: vault_id };
        let params = AdjustVaultParams {
            collateral_delta,
            collateral_is_withdraw,
            debt_delta,
            debt_is_repay,
        };

        let mut vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => {
                self.env().revert(CdpError::VaultNotFound);
            }
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        // Accrue interest before adjustment
        let current_time = self.env().get_block_time();
        let accrual = accrue_interest(
            vault.debt,
            vault.interest_rate_bps,
            vault.last_accrual_timestamp,
            current_time,
        );

        // Update vault with accrued interest
        vault.debt = accrual.new_debt;
        vault.last_accrual_timestamp = current_time;

        // Track total accrued interest
        if accrual.interest_accrued > U256::zero() {
            // Update total debt with interest
            let current_debt = self.total_debt.get().unwrap_or(U256::zero());
            self.total_debt.set(current_debt + accrual.interest_accrued);
        }

        // Calculate new collateral
        let new_collateral = if params.collateral_is_withdraw {
            if vault.collateral < params.collateral_delta {
                self.env().revert(CdpError::InsufficientCollateral);
            }
            vault.collateral - params.collateral_delta
        } else {
            vault.collateral + params.collateral_delta
        };

        // Calculate new debt
        let new_debt = if params.debt_is_repay {
            if vault.debt < params.debt_delta {
                self.env().revert(CdpError::RepayExceedsDebt);
            }
            vault.debt - params.debt_delta
        } else {
            vault.debt + params.debt_delta
        };

        // Check if this results in closing the vault
        if new_collateral.is_zero() && new_debt.is_zero() {
            // Effectively closing the vault
            self.close_vault_internal(vault_key, vault);
            return;
        }

        // Check minimum debt (if any debt remains)
        if !new_debt.is_zero() {
            let min_debt = U256::from(MIN_DEBT_WHOLE) * U256::from(PRICE_SCALE);
            if new_debt < min_debt {
                self.env().revert(CdpError::BelowMinDebt);
            }
        }

        // Check MCR
        let collateral_value = self.get_collateral_value(new_collateral);
        self.check_mcr(collateral_value, new_debt);

        // Update totals
        let current_collateral = self.total_collateral.get().unwrap_or(U256::zero());
        let current_debt = self.total_debt.get().unwrap_or(U256::zero());

        let collateral_diff = if params.collateral_is_withdraw {
            current_collateral - params.collateral_delta
        } else {
            current_collateral + params.collateral_delta
        };

        let debt_diff = if params.debt_is_repay {
            current_debt - params.debt_delta
        } else {
            current_debt + params.debt_delta
        };

        self.total_collateral.set(collateral_diff);
        self.total_debt.set(debt_diff);

        // Update vault
        vault.collateral = new_collateral;
        vault.debt = new_debt;
        vault.last_accrual_timestamp = self.env().get_block_time();

        self.vaults.set(&vault_key, vault);

        // TODO: Handle token transfers
    }

    /// Adjust the interest rate for an existing vault.
    pub fn adjust_interest_rate(&mut self, owner: Address, vault_id: u64, interest_rate_bps: u32) {
        self.require_router();

        // Defensive check (router validates too).
        if interest_rate_bps > MAX_INTEREST_RATE_BPS {
            self.env().revert(CdpError::InterestRateOutOfBounds);
        }

        let vault_key = VaultKey { owner, id: vault_id };
        let mut vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        // Accrue interest before changing the rate.
        let current_time = self.env().get_block_time();
        let accrual = accrue_interest(
            vault.debt,
            vault.interest_rate_bps,
            vault.last_accrual_timestamp,
            current_time,
        );
        vault.debt = accrual.new_debt;
        vault.last_accrual_timestamp = current_time;

        // Update total debt with accrued interest
        if accrual.interest_accrued > U256::zero() {
            let current_debt = self.total_debt.get().unwrap_or(U256::zero());
            self.total_debt.set(current_debt + accrual.interest_accrued);
        }

        if vault.interest_rate_bps != interest_rate_bps {
            self.remove_from_sorted_list(vault_key);
            vault.interest_rate_bps = interest_rate_bps;
            self.insert_into_sorted_list(vault_key, interest_rate_bps);
        }

        self.vaults.set(&vault_key, vault);
    }

    /// Close vault and withdraw all collateral
    pub fn close_vault(&mut self, owner: Address, vault_id: u64) {
        self.require_router();
        let caller = owner;
        let vault_key = VaultKey { owner: caller, id: vault_id };

        let vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => {
                self.env().revert(CdpError::VaultNotFound);
            }
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        self.close_vault_internal(vault_key, vault);
    }

    /// Internal vault closing logic
    fn close_vault_internal(&mut self, vault_key: VaultKey, vault: VaultData) {
        let owner = vault_key.owner;
        let current_collateral = self.total_collateral.get().unwrap_or(U256::zero());
        let current_debt = self.total_debt.get().unwrap_or(U256::zero());
        let current_count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(current_collateral - vault.collateral);
        self.total_debt.set(current_debt - vault.debt);
        self.vault_count.set(current_count.saturating_sub(1));

        // Remove from sorted list
        self.remove_from_sorted_list(vault_key);

        // Clear vault data
        let empty_vault = VaultData {
            owner,
            collateral_id: CollateralId::Cspr,
            collateral: U256::zero(),
            debt: U256::zero(),
            interest_rate_bps: 0,
            last_accrual_timestamp: 0,
        };
        self.vaults.set(&vault_key, empty_vault);

        // Remove from owner's vault list
        self.remove_vault_from_owner_list(vault_key);

        // TODO: Transfer collateral back to owner
        // TODO: Require debt repayment (burn gUSD)
    }

    /// Check if an address has an active vault
    pub fn has_vault(&self, owner: &Address) -> bool {
        self.user_vault_count.get(owner).unwrap_or(0) > 0
    }

    /// Get vault info for an owner (includes pending accrued interest)
    pub fn get_vault(&self, owner: Address, vault_id: u64) -> Option<VaultInfo> {
        let vault_key = VaultKey { owner, id: vault_id };
        let vault = self.vaults.get(&vault_key)?;

        if vault.collateral.is_zero() && vault.debt.is_zero() {
            return None;
        }

        // Calculate current debt including pending interest
        let current_time = self.env().get_block_time();
        let accrual = accrue_interest(
            vault.debt,
            vault.interest_rate_bps,
            vault.last_accrual_timestamp,
            current_time,
        );

        // Create vault info with current debt (including pending interest)
        let mut vault_with_interest = vault.clone();
        vault_with_interest.debt = accrual.new_debt;

        let collateral_value = self.get_collateral_value(vault.collateral);
        let icr_bps = self.calculate_icr(collateral_value, accrual.new_debt);

        Some(VaultInfo {
            vault: vault_with_interest,
            icr_bps,
            collateral_value_usd: collateral_value,
        })
    }

    /// Get branch status
    pub fn get_status(&self) -> BranchStatus {
        BranchStatus {
            collateral_id: CollateralId::Cspr,
            total_collateral: self.total_collateral.get().unwrap_or(U256::zero()),
            total_debt: self.total_debt.get().unwrap_or(U256::zero()),
            vault_count: self.vault_count.get().unwrap_or(0),
            safe_mode: SafeModeState {
                is_active: false,
                triggered_at: 0,
                reason: OracleStatus::Ok,
            },
        }
    }

    /// Get vault at the head of sorted list (lowest interest rate, first for redemption)
    pub fn get_first_vault_for_redemption(&self) -> Option<VaultKey> {
        self.sorted_head.get().flatten()
    }

    /// Get next vault in sorted list
    pub fn get_next_vault_for_redemption(&self, current: VaultKey) -> Option<VaultKey> {
        let entry = self.sorted_vaults.get(&current)?;
        entry.next
    }

    /// Get sorted vault owners (ascending by interest rate) for redemption iteration
    /// Returns up to max_count vault keys.
    pub fn get_sorted_vault_owners(&self, max_count: u32) -> Vec<VaultKey> {
        let mut result = Vec::new();
        let mut current = self.sorted_head.get().flatten();
        let mut count = 0u32;

        while let Some(key) = current {
            if count >= max_count {
                break;
            }
            result.push(key);
            count += 1;

            if let Some(entry) = self.sorted_vaults.get(&key) {
                current = entry.next;
            } else {
                break;
            }
        }

        result
    }

    /// Get vault collateral amount (for redemption/liquidation queries)
    pub fn get_collateral(&self, owner: Address, vault_id: u64) -> U256 {
        let key = VaultKey { owner, id: vault_id };
        self.vaults.get(&key).map(|v| v.collateral).unwrap_or(U256::zero())
    }

    /// Get vault debt amount (for redemption/liquidation queries)
    pub fn get_debt(&self, owner: Address, vault_id: u64) -> U256 {
        let key = VaultKey { owner, id: vault_id };
        self.vaults.get(&key).map(|v| v.debt).unwrap_or(U256::zero())
    }

    /// Get vault interest rate in bps (for redemption ordering)
    pub fn get_interest_rate_bps(&self, owner: Address, vault_id: u64) -> u32 {
        let key = VaultKey { owner, id: vault_id };
        self.vaults.get(&key).map(|v| v.interest_rate_bps).unwrap_or(0)
    }

    // ========== Frontend-Friendly User State Access ==========

    /// Get user's vault state in a single call (collateral, debt, rate_bps)
    /// Returns (collateral, debt, interest_rate_bps) as primitives
    pub fn get_user_vault_state(&self, owner: Address, vault_id: u64) -> (U256, U256, u32) {
        let key = VaultKey { owner, id: vault_id };
        match self.vaults.get(&key) {
            Some(vault) => (vault.collateral, vault.debt, vault.interest_rate_bps),
            None => (U256::zero(), U256::zero(), 0),
        }
    }

    /// Get number of active vaults for an owner (for offchain enumeration).
    pub fn get_user_vault_count(&self, owner: Address) -> u64 {
        self.user_vault_count.get(&owner).unwrap_or(0)
    }

    /// Get vault id at a given index for an owner (0-based).
    pub fn get_user_vault_id_at(&self, owner: Address, index: u64) -> u64 {
        let key = UserVaultIndex { owner, index };
        self.user_vault_ids.get(&key).unwrap_or(0)
    }

    /// Get total collateral in branch
    pub fn get_total_collateral(&self) -> U256 {
        self.total_collateral.get().unwrap_or(U256::zero())
    }

    /// Get total debt in branch
    pub fn get_total_debt(&self) -> U256 {
        self.total_debt.get().unwrap_or(U256::zero())
    }

    /// Get vault count
    pub fn get_vault_count(&self) -> u64 {
        self.vault_count.get().unwrap_or(0)
    }

    /// Reduce vault collateral and debt during redemption
    /// Called by RedemptionEngine
    pub fn reduce_collateral_for_redemption(
        &mut self,
        owner: Address,
        vault_id: u64,
        collateral_amount: U256,
        debt_amount: U256,
    ) {
        // TODO: Add caller authorization (only RedemptionEngine)

        let vault_key = VaultKey { owner, id: vault_id };
        let mut vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        // Validate amounts
        if collateral_amount > vault.collateral {
            self.env().revert(CdpError::InsufficientCollateral);
        }
        if debt_amount > vault.debt {
            self.env().revert(CdpError::RepayExceedsDebt);
        }

        // Update vault
        vault.collateral = vault.collateral - collateral_amount;
        vault.debt = vault.debt - debt_amount;

        // Update totals
        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        self.total_collateral.set(total_coll - collateral_amount);
        self.total_debt.set(total_debt - debt_amount);

        // Check if vault should be closed
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.remove_from_sorted_list(vault_key);
            let count = self.vault_count.get().unwrap_or(0);
            self.vault_count.set(count.saturating_sub(1));
            self.remove_vault_from_owner_list(vault_key);
        }

        self.vaults.set(&vault_key, vault);
    }

    /// Seize collateral from a vault during liquidation
    /// Called by LiquidationEngine
    pub fn seize_collateral(&mut self, owner: Address, vault_id: u64, amount: U256) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let vault_key = VaultKey { owner, id: vault_id };
        let mut vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        if amount > vault.collateral {
            self.env().revert(CdpError::InsufficientCollateral);
        }

        vault.collateral = vault.collateral - amount;

        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        self.total_collateral.set(total_coll - amount);

        self.vaults.set(&vault_key, vault);
    }

    /// Reduce debt on a vault during liquidation
    /// Called by LiquidationEngine (when SP absorbs debt)
    pub fn reduce_debt(&mut self, owner: Address, vault_id: u64, amount: U256) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let vault_key = VaultKey { owner, id: vault_id };
        let mut vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        if amount > vault.debt {
            self.env().revert(CdpError::RepayExceedsDebt);
        }

        vault.debt = vault.debt - amount;

        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        self.total_debt.set(total_debt - amount);

        self.vaults.set(&vault_key, vault);
    }

    /// Close a vault during liquidation (full liquidation)
    /// Called by LiquidationEngine
    pub fn close_vault_for_liquidation(&mut self, owner: Address, vault_id: u64) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let vault_key = VaultKey { owner, id: vault_id };
        let vault = match self.vaults.get(&vault_key) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };
        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.env().revert(CdpError::VaultNotFound);
        }

        // Update totals
        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        let count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(total_coll - vault.collateral);
        self.total_debt.set(total_debt - vault.debt);
        self.vault_count.set(count.saturating_sub(1));

        // Remove from sorted list
        self.remove_from_sorted_list(vault_key);

        // Clear vault
        let empty_vault = VaultData {
            owner: vault_key.owner,
            collateral_id: CollateralId::Cspr,
            collateral: U256::zero(),
            debt: U256::zero(),
            interest_rate_bps: 0,
            last_accrual_timestamp: 0,
        };
        self.vaults.set(&vault_key, empty_vault);
        self.remove_vault_from_owner_list(vault_key);
    }

    /// Update last good price (called by oracle adapter)
    pub fn update_price(&mut self, price: U256) {
        self.last_good_price.set(price);
    }

    // ========== Internal helpers ==========

    fn require_router(&self) {
        let caller = self.env().caller();
        let router = self.router.get().unwrap_or_else(|| self.env().self_address());
        if caller != router {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    fn get_collateral_value(&self, collateral: U256) -> U256 {
        let price = self.last_good_price.get().unwrap_or(U256::from(PRICE_SCALE));
        // collateral (9 dec) * price (18 dec) / COLLATERAL_DECIMALS (9) = value (18 dec)
        collateral * price / U256::from(COLLATERAL_DECIMALS)
    }

    fn calculate_icr(&self, collateral_value: U256, debt: U256) -> u32 {
        if debt.is_zero() {
            return u32::MAX;
        }
        // ICR = (collateral_value * 10000) / debt
        let scaled = collateral_value * U256::from(10000) / debt;
        if scaled > U256::from(u32::MAX) {
            u32::MAX
        } else {
            scaled.low_u32()
        }
    }

    fn check_mcr(&self, collateral_value: U256, debt: U256) {
        let icr = self.calculate_icr(collateral_value, debt);
        if icr < MCR_BPS {
            self.env().revert(CdpError::BelowMcr);
        }
    }

    fn remove_vault_from_owner_list(&mut self, vault_key: VaultKey) {
        let owner = vault_key.owner;
        let count = self.user_vault_count.get(&owner).unwrap_or(0);
        if count == 0 {
            return;
        }

        let index = self.vault_indices.get(&vault_key).unwrap_or(u64::MAX);
        if index == u64::MAX || index >= count {
            return;
        }

        let last_index = count - 1;
        if index != last_index {
            // Swap-remove: move last vault id into removed slot.
            let last_id_key = UserVaultIndex { owner, index: last_index };
            if let Some(last_id) = self.user_vault_ids.get(&last_id_key) {
                let move_key = UserVaultIndex { owner, index };
                self.user_vault_ids.set(&move_key, last_id);

                let moved_vault_key = VaultKey { owner, id: last_id };
                self.vault_indices.set(&moved_vault_key, index);
            }
        }

        // Best-effort clear last slot (ignored because count is decremented).
        let last_key = UserVaultIndex { owner, index: last_index };
        self.user_vault_ids.set(&last_key, 0);
        self.vault_indices.set(&vault_key, u64::MAX);
        self.user_vault_count.set(&owner, last_index);
    }

    fn insert_into_sorted_list(&mut self, vault_key: VaultKey, interest_rate_bps: u32) {
        let head = self.sorted_head.get().flatten();
        let tail = self.sorted_tail.get().flatten();

        // If list is empty
        if head.is_none() {
            let entry = SortedVaultEntry {
                vault_key,
                interest_rate_bps,
                prev: None,
                next: None,
            };
            self.sorted_vaults.set(&vault_key, entry);
            self.sorted_head.set(Some(vault_key));
            self.sorted_tail.set(Some(vault_key));
            return;
        }

        // Find insertion point (sorted by ascending interest rate)
        let mut current = head;
        while let Some(curr_key) = current {
            if let Some(curr_entry) = self.sorted_vaults.get(&curr_key) {
                if interest_rate_bps <= curr_entry.interest_rate_bps {
                    // Insert before current
                    let new_entry = SortedVaultEntry {
                        vault_key,
                        interest_rate_bps,
                        prev: curr_entry.prev,
                        next: Some(curr_key),
                    };
                    self.sorted_vaults.set(&vault_key, new_entry);

                    // Update current's prev pointer
                    let mut updated_curr = curr_entry.clone();
                    updated_curr.prev = Some(vault_key);
                    self.sorted_vaults.set(&curr_key, updated_curr);

                    // Update previous's next pointer
                    if let Some(prev_key) = curr_entry.prev {
                        if let Some(mut prev_entry) = self.sorted_vaults.get(&prev_key) {
                            prev_entry.next = Some(vault_key);
                            self.sorted_vaults.set(&prev_key, prev_entry);
                        }
                    } else {
                        // We're the new head
                        self.sorted_head.set(Some(vault_key));
                    }
                    return;
                }
                current = curr_entry.next;
            } else {
                break;
            }
        }

        // Insert at tail
        if let Some(tail_key) = tail {
            if let Some(mut tail_entry) = self.sorted_vaults.get(&tail_key) {
                let new_entry = SortedVaultEntry {
                    vault_key,
                    interest_rate_bps,
                    prev: Some(tail_key),
                    next: None,
                };
                self.sorted_vaults.set(&vault_key, new_entry);
                tail_entry.next = Some(vault_key);
                self.sorted_vaults.set(&tail_key, tail_entry);
                self.sorted_tail.set(Some(vault_key));
            }
        }
    }

    fn remove_from_sorted_list(&mut self, vault_key: VaultKey) {
        let entry = match self.sorted_vaults.get(&vault_key) {
            Some(e) => e,
            None => return,
        };

        // Update prev's next pointer
        if let Some(prev_key) = entry.prev {
            if let Some(mut prev_entry) = self.sorted_vaults.get(&prev_key) {
                prev_entry.next = entry.next;
                self.sorted_vaults.set(&prev_key, prev_entry);
            }
        } else {
            // We were the head
            self.sorted_head.set(entry.next);
        }

        // Update next's prev pointer
        if let Some(next_key) = entry.next {
            if let Some(mut next_entry) = self.sorted_vaults.get(&next_key) {
                next_entry.prev = entry.prev;
                self.sorted_vaults.set(&next_key, next_entry);
            }
        } else {
            // We were the tail
            self.sorted_tail.set(entry.prev);
        }

        // Clear entry
        let empty_entry = SortedVaultEntry {
            vault_key,
            interest_rate_bps: 0,
            prev: None,
            next: None,
        };
        self.sorted_vaults.set(&vault_key, empty_entry);
    }
}
