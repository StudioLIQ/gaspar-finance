//! Branch contract for stCSPR (staked CSPR) collateral.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::types::{CollateralId, VaultData, SafeModeState, OracleStatus};
use crate::interfaces::{VaultInfo, BranchStatus, AdjustVaultParams};
use crate::errors::CdpError;
use crate::interest::{accrue_interest, InterestRateConfig, validate_interest_rate};

/// Minimum Collateralization Ratio in basis points (110% = 11000 bps)
const MCR_BPS: u32 = 11000;
/// Minimum debt in smallest unit (2000 gUSD)
const MIN_DEBT_WHOLE: u64 = 2000;
/// Price scale (1e18) - prices and debt are in 18 decimals
const PRICE_SCALE: u64 = 1_000_000_000_000_000_000;
/// Collateral decimals (stCSPR uses 9 decimals)
const COLLATERAL_DECIMALS: u64 = 1_000_000_000;
/// Maximum interest rate in basis points (40% = 4000 bps)
const MAX_INTEREST_RATE_BPS: u32 = 4000;
/// Exchange rate scale (1e18) - must match ScsprYbToken's SCALE
const RATE_SCALE: u64 = 1_000_000_000_000_000_000;

/// Entry in the sorted vault list (by interest rate)
#[odra::odra_type]
pub struct SortedVaultEntry {
    /// Owner address
    pub owner: Address,
    /// Interest rate in bps for sorting
    pub interest_rate_bps: u32,
    /// Next entry in the list (lower rate)
    pub prev: Option<Address>,
    /// Previous entry in the list (higher rate)
    pub next: Option<Address>,
}

/// Branch contract for stCSPR collateral
#[odra::module]
pub struct BranchScspr {
    /// Registry contract address
    registry: Var<Address>,
    /// Router contract address
    router: Var<Address>,
    /// stCSPR token contract address
    scspr_token: Var<Address>,
    /// Mapping from owner address to vault data
    vaults: Mapping<Address, VaultData>,
    /// Sorted vault entries by interest rate (for redemption ordering)
    sorted_vaults: Mapping<Address, SortedVaultEntry>,
    /// Head of sorted list (lowest interest rate)
    sorted_head: Var<Option<Address>>,
    /// Tail of sorted list (highest interest rate)
    sorted_tail: Var<Option<Address>>,
    /// Total collateral in the branch
    total_collateral: Var<U256>,
    /// Total debt in the branch
    total_debt: Var<U256>,
    /// Number of active vaults
    vault_count: Var<u64>,
    /// Local safe mode state
    safe_mode: Var<SafeModeState>,
    /// Last known good CSPR/USD price (cached for safe mode)
    last_good_price: Var<U256>,
    /// stCSPR/CSPR exchange rate (scaled by RATE_SCALE, e.g., 1100 = 1.1)
    exchange_rate: Var<U256>,
    /// Interest rate configuration
    interest_config: Var<InterestRateConfig>,
    /// Total accrued interest (for protocol accounting)
    total_accrued_interest: Var<U256>,
}

#[odra::module]
impl BranchScspr {
    /// Initialize the branch
    pub fn init(&mut self, registry: Address, router: Address, scspr_token: Address) {
        self.registry.set(registry);
        self.router.set(router);
        self.scspr_token.set(scspr_token);
        self.total_collateral.set(U256::zero());
        self.total_debt.set(U256::zero());
        self.vault_count.set(0);
        self.sorted_head.set(None);
        self.sorted_tail.set(None);
        self.last_good_price.set(U256::from(PRICE_SCALE)); // Default 1:1 CSPR/USD price
        self.exchange_rate.set(U256::from(RATE_SCALE)); // Default 1:1 stCSPR/CSPR rate
        self.interest_config.set(InterestRateConfig::default());
        self.total_accrued_interest.set(U256::zero());
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Open a new vault with stCSPR collateral
    pub fn open_vault(&mut self, collateral_amount: U256, debt_amount: U256, interest_rate_bps: u32) {
        let caller = self.env().caller();

        // Check safe mode - no new vaults allowed
        self.require_not_safe_mode();

        // Check if vault already exists
        if self.has_vault(&caller) {
            self.env().revert(CdpError::VaultAlreadyExists);
        }

        // Validate interest rate against config
        let interest_config = self.interest_config.get().unwrap_or_default();
        if !validate_interest_rate(interest_rate_bps, &interest_config) {
            self.env().revert(CdpError::InterestRateOutOfBounds);
        }

        // Check minimum debt
        let min_debt = U256::from(MIN_DEBT_WHOLE) * U256::from(PRICE_SCALE);
        if debt_amount < min_debt {
            self.env().revert(CdpError::BelowMinDebt);
        }

        // Check MCR (using composite pricing)
        let collateral_value = self.get_collateral_value(collateral_amount);
        self.check_mcr(collateral_value, debt_amount);

        // Create the vault
        let vault = VaultData {
            owner: caller,
            collateral_id: CollateralId::SCSPR,
            collateral: collateral_amount,
            debt: debt_amount,
            interest_rate_bps,
            last_accrual_timestamp: self.env().get_block_time(),
        };

        self.vaults.set(&caller, vault);

        // Add to sorted list
        self.insert_into_sorted_list(caller, interest_rate_bps);

        // Update totals
        let current_collateral = self.total_collateral.get().unwrap_or(U256::zero());
        let current_debt = self.total_debt.get().unwrap_or(U256::zero());
        let current_count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(current_collateral + collateral_amount);
        self.total_debt.set(current_debt + debt_amount);
        self.vault_count.set(current_count + 1);

        // TODO: Transfer stCSPR from caller (CEP-18 transfer_from)
        // TODO: Mint gUSD to caller
    }

    /// Adjust an existing vault
    pub fn adjust_vault(&mut self, params: AdjustVaultParams) {
        let caller = self.env().caller();

        let mut vault = match self.vaults.get(&caller) {
            Some(v) => v,
            None => {
                self.env().revert(CdpError::VaultNotFound);
            }
        };

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
            let total = self.total_accrued_interest.get().unwrap_or(U256::zero());
            self.total_accrued_interest.set(total + accrual.interest_accrued);

            // Update total debt with interest
            let current_debt = self.total_debt.get().unwrap_or(U256::zero());
            self.total_debt.set(current_debt + accrual.interest_accrued);
        }

        // Check safe mode restrictions
        self.check_safe_mode_adjustment(&params);

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
            self.close_vault_internal(caller, vault);
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

        self.vaults.set(&caller, vault);

        // TODO: Handle token transfers (CEP-18)
    }

    /// Close vault and withdraw all collateral
    pub fn close_vault(&mut self) {
        let caller = self.env().caller();

        // Check safe mode - no vault closing allowed
        self.require_not_safe_mode();

        let vault = match self.vaults.get(&caller) {
            Some(v) => v,
            None => {
                self.env().revert(CdpError::VaultNotFound);
            }
        };

        self.close_vault_internal(caller, vault);
    }

    /// Internal vault closing logic
    fn close_vault_internal(&mut self, owner: Address, vault: VaultData) {
        let current_collateral = self.total_collateral.get().unwrap_or(U256::zero());
        let current_debt = self.total_debt.get().unwrap_or(U256::zero());
        let current_count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(current_collateral - vault.collateral);
        self.total_debt.set(current_debt - vault.debt);
        self.vault_count.set(current_count.saturating_sub(1));

        // Remove from sorted list
        self.remove_from_sorted_list(owner);

        // Clear vault data
        let empty_vault = VaultData {
            owner,
            collateral_id: CollateralId::SCSPR,
            collateral: U256::zero(),
            debt: U256::zero(),
            interest_rate_bps: 0,
            last_accrual_timestamp: 0,
        };
        self.vaults.set(&owner, empty_vault);

        // TODO: Transfer stCSPR back to owner (CEP-18 transfer)
        // TODO: Require debt repayment (burn gUSD)
    }

    /// Check if an address has an active vault
    pub fn has_vault(&self, owner: &Address) -> bool {
        if let Some(vault) = self.vaults.get(owner) {
            !vault.collateral.is_zero() || !vault.debt.is_zero()
        } else {
            false
        }
    }

    /// Get vault info for an owner (includes pending accrued interest)
    pub fn get_vault(&self, owner: Address) -> Option<VaultInfo> {
        let vault = self.vaults.get(&owner)?;

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
            collateral_id: CollateralId::SCSPR,
            total_collateral: self.total_collateral.get().unwrap_or(U256::zero()),
            total_debt: self.total_debt.get().unwrap_or(U256::zero()),
            vault_count: self.vault_count.get().unwrap_or(0),
            safe_mode: self.safe_mode.get().unwrap_or(SafeModeState {
                is_active: false,
                triggered_at: 0,
                reason: OracleStatus::Ok,
            }),
        }
    }

    /// Get stCSPR token address
    pub fn get_scspr_token(&self) -> Option<Address> {
        self.scspr_token.get()
    }

    /// Get vault at the head of sorted list (lowest interest rate, first for redemption)
    pub fn get_first_vault_for_redemption(&self) -> Option<Address> {
        self.sorted_head.get().flatten()
    }

    /// Get next vault in sorted list
    pub fn get_next_vault_for_redemption(&self, current: Address) -> Option<Address> {
        let entry = self.sorted_vaults.get(&current)?;
        entry.next
    }

    /// Get sorted vault owners (ascending by interest rate) for redemption iteration
    /// Returns up to max_count vault owner addresses
    pub fn get_sorted_vault_owners(&self, max_count: u32) -> Vec<Address> {
        let mut result = Vec::new();
        let mut current = self.sorted_head.get().flatten();
        let mut count = 0u32;

        while let Some(addr) = current {
            if count >= max_count {
                break;
            }
            result.push(addr);
            count += 1;

            if let Some(entry) = self.sorted_vaults.get(&addr) {
                current = entry.next;
            } else {
                break;
            }
        }

        result
    }

    /// Get vault collateral amount (for redemption/liquidation queries)
    pub fn get_collateral(&self, owner: Address) -> U256 {
        self.vaults.get(&owner).map(|v| v.collateral).unwrap_or(U256::zero())
    }

    /// Get vault debt amount (for redemption/liquidation queries)
    pub fn get_debt(&self, owner: Address) -> U256 {
        self.vaults.get(&owner).map(|v| v.debt).unwrap_or(U256::zero())
    }

    /// Get vault interest rate in bps (for redemption ordering)
    pub fn get_interest_rate_bps(&self, owner: Address) -> u32 {
        self.vaults.get(&owner).map(|v| v.interest_rate_bps).unwrap_or(0)
    }

    // ========== Frontend-Friendly User State Access ==========

    /// Get user's vault state in a single call (collateral, debt, rate_bps)
    /// Returns (collateral, debt, interest_rate_bps) as primitives
    pub fn get_user_vault_state(&self, owner: Address) -> (U256, U256, u32) {
        match self.vaults.get(&owner) {
            Some(vault) => (vault.collateral, vault.debt, vault.interest_rate_bps),
            None => (U256::zero(), U256::zero(), 0),
        }
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

    /// Check if safe mode is active
    pub fn is_safe_mode_active(&self) -> bool {
        self.safe_mode.get().map(|s| s.is_active).unwrap_or(false)
    }

    /// Reduce vault collateral and debt during redemption
    /// Called by RedemptionEngine
    pub fn reduce_collateral_for_redemption(
        &mut self,
        owner: Address,
        collateral_amount: U256,
        debt_amount: U256,
    ) {
        // TODO: Add caller authorization (only RedemptionEngine)

        let mut vault = match self.vaults.get(&owner) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };

        if collateral_amount > vault.collateral {
            self.env().revert(CdpError::InsufficientCollateral);
        }
        if debt_amount > vault.debt {
            self.env().revert(CdpError::RepayExceedsDebt);
        }

        vault.collateral = vault.collateral - collateral_amount;
        vault.debt = vault.debt - debt_amount;

        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        self.total_collateral.set(total_coll - collateral_amount);
        self.total_debt.set(total_debt - debt_amount);

        if vault.collateral.is_zero() && vault.debt.is_zero() {
            self.remove_from_sorted_list(owner);
            let count = self.vault_count.get().unwrap_or(0);
            self.vault_count.set(count.saturating_sub(1));
        }

        self.vaults.set(&owner, vault);
    }

    /// Seize collateral from a vault during liquidation
    /// Called by LiquidationEngine
    pub fn seize_collateral(&mut self, owner: Address, amount: U256) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let mut vault = match self.vaults.get(&owner) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };

        if amount > vault.collateral {
            self.env().revert(CdpError::InsufficientCollateral);
        }

        vault.collateral = vault.collateral - amount;

        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        self.total_collateral.set(total_coll - amount);

        self.vaults.set(&owner, vault);
    }

    /// Reduce debt on a vault during liquidation
    /// Called by LiquidationEngine (when SP absorbs debt)
    pub fn reduce_debt(&mut self, owner: Address, amount: U256) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let mut vault = match self.vaults.get(&owner) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };

        if amount > vault.debt {
            self.env().revert(CdpError::RepayExceedsDebt);
        }

        vault.debt = vault.debt - amount;

        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        self.total_debt.set(total_debt - amount);

        self.vaults.set(&owner, vault);
    }

    /// Close a vault during liquidation (full liquidation)
    /// Called by LiquidationEngine
    pub fn close_vault_for_liquidation(&mut self, owner: Address) {
        // TODO: Add caller authorization (only LiquidationEngine)

        let vault = match self.vaults.get(&owner) {
            Some(v) => v,
            None => self.env().revert(CdpError::VaultNotFound),
        };

        let total_coll = self.total_collateral.get().unwrap_or(U256::zero());
        let total_debt = self.total_debt.get().unwrap_or(U256::zero());
        let count = self.vault_count.get().unwrap_or(0);

        self.total_collateral.set(total_coll - vault.collateral);
        self.total_debt.set(total_debt - vault.debt);
        self.vault_count.set(count.saturating_sub(1));

        self.remove_from_sorted_list(owner);

        let empty_vault = VaultData {
            owner,
            collateral_id: CollateralId::SCSPR,
            collateral: U256::zero(),
            debt: U256::zero(),
            interest_rate_bps: 0,
            last_accrual_timestamp: 0,
        };
        self.vaults.set(&owner, empty_vault);
    }

    /// Trigger safe mode
    pub fn trigger_safe_mode(&mut self, reason: OracleStatus) {
        let state = SafeModeState {
            is_active: true,
            triggered_at: self.env().get_block_time(),
            reason,
        };
        self.safe_mode.set(state);
    }

    /// Clear safe mode (requires external admin verification)
    pub fn clear_safe_mode(&mut self) {
        self.safe_mode.set(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });
    }

    /// Update CSPR/USD price (called by oracle adapter)
    pub fn update_price(&mut self, price: U256) {
        self.last_good_price.set(price);
    }

    /// Update stCSPR/CSPR exchange rate (called by oracle adapter)
    /// Rate direction: CSPR_PER_SCSPR (R1) - how much CSPR you get for 1 stCSPR
    /// Scaled by RATE_SCALE (1000 = 1.0, 1100 = 1.1)
    pub fn update_exchange_rate(&mut self, rate: U256) {
        // Validate rate is not zero or abnormally low
        if rate.is_zero() {
            self.env().revert(CdpError::OracleRateTooLow);
        }
        self.exchange_rate.set(rate);
    }

    /// Get current exchange rate
    pub fn get_exchange_rate(&self) -> U256 {
        self.exchange_rate.get().unwrap_or(U256::from(RATE_SCALE))
    }

    /// Get total accrued interest (for protocol accounting)
    pub fn get_total_accrued_interest(&self) -> U256 {
        self.total_accrued_interest.get().unwrap_or(U256::zero())
    }

    /// Get interest rate configuration
    pub fn get_interest_config(&self) -> InterestRateConfig {
        self.interest_config.get().unwrap_or_default()
    }

    /// Update interest rate configuration (admin only)
    pub fn set_interest_config(&mut self, config: InterestRateConfig) {
        // TODO: Add admin access control
        self.interest_config.set(config);
    }

    // ========== Internal helpers ==========

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

    fn check_safe_mode_adjustment(&self, params: &AdjustVaultParams) {
        let state = self.safe_mode.get().unwrap_or(SafeModeState {
            is_active: false,
            triggered_at: 0,
            reason: OracleStatus::Ok,
        });

        if !state.is_active {
            return;
        }

        // In safe mode: only allow adding collateral and repaying debt
        let is_borrowing = !params.debt_is_repay && params.debt_delta > U256::zero();
        let is_withdrawing = params.collateral_is_withdraw && params.collateral_delta > U256::zero();

        if is_borrowing || is_withdrawing {
            self.env().revert(CdpError::SafeModeActive);
        }
    }

    /// Composite pricing: P(stCSPR) = P(CSPR) * R
    /// Where R is the stCSPR/CSPR exchange rate (CSPR_PER_SCSPR)
    fn get_collateral_value(&self, collateral: U256) -> U256 {
        let cspr_price = self.last_good_price.get().unwrap_or(U256::from(PRICE_SCALE));
        let rate = self.exchange_rate.get().unwrap_or(U256::from(RATE_SCALE));

        // stCSPR collateral (9 dec) * rate (18 dec) / RATE_SCALE (18) = CSPR equivalent (9 dec)
        let cspr_equivalent = collateral * rate / U256::from(RATE_SCALE);
        // CSPR equivalent (9 dec) * cspr_price (18 dec) / COLLATERAL_DECIMALS (9) = USD value (18 dec)
        cspr_equivalent * cspr_price / U256::from(COLLATERAL_DECIMALS)
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

    fn insert_into_sorted_list(&mut self, owner: Address, interest_rate_bps: u32) {
        let head = self.sorted_head.get().flatten();
        let tail = self.sorted_tail.get().flatten();

        // If list is empty
        if head.is_none() {
            let entry = SortedVaultEntry {
                owner,
                interest_rate_bps,
                prev: None,
                next: None,
            };
            self.sorted_vaults.set(&owner, entry);
            self.sorted_head.set(Some(owner));
            self.sorted_tail.set(Some(owner));
            return;
        }

        // Find insertion point (sorted by ascending interest rate)
        let mut current = head;
        while let Some(curr_addr) = current {
            if let Some(curr_entry) = self.sorted_vaults.get(&curr_addr) {
                if interest_rate_bps <= curr_entry.interest_rate_bps {
                    // Insert before current
                    let new_entry = SortedVaultEntry {
                        owner,
                        interest_rate_bps,
                        prev: curr_entry.prev,
                        next: Some(curr_addr),
                    };
                    self.sorted_vaults.set(&owner, new_entry);

                    // Update current's prev pointer
                    let mut updated_curr = curr_entry.clone();
                    updated_curr.prev = Some(owner);
                    self.sorted_vaults.set(&curr_addr, updated_curr);

                    // Update previous's next pointer
                    if let Some(prev_addr) = curr_entry.prev {
                        if let Some(mut prev_entry) = self.sorted_vaults.get(&prev_addr) {
                            prev_entry.next = Some(owner);
                            self.sorted_vaults.set(&prev_addr, prev_entry);
                        }
                    } else {
                        // We're the new head
                        self.sorted_head.set(Some(owner));
                    }
                    return;
                }
                current = curr_entry.next;
            } else {
                break;
            }
        }

        // Insert at tail
        if let Some(tail_addr) = tail {
            if let Some(mut tail_entry) = self.sorted_vaults.get(&tail_addr) {
                let new_entry = SortedVaultEntry {
                    owner,
                    interest_rate_bps,
                    prev: Some(tail_addr),
                    next: None,
                };
                self.sorted_vaults.set(&owner, new_entry);
                tail_entry.next = Some(owner);
                self.sorted_vaults.set(&tail_addr, tail_entry);
                self.sorted_tail.set(Some(owner));
            }
        }
    }

    fn remove_from_sorted_list(&mut self, owner: Address) {
        let entry = match self.sorted_vaults.get(&owner) {
            Some(e) => e,
            None => return,
        };

        // Update prev's next pointer
        if let Some(prev_addr) = entry.prev {
            if let Some(mut prev_entry) = self.sorted_vaults.get(&prev_addr) {
                prev_entry.next = entry.next;
                self.sorted_vaults.set(&prev_addr, prev_entry);
            }
        } else {
            // We were the head
            self.sorted_head.set(entry.next);
        }

        // Update next's prev pointer
        if let Some(next_addr) = entry.next {
            if let Some(mut next_entry) = self.sorted_vaults.get(&next_addr) {
                next_entry.prev = entry.prev;
                self.sorted_vaults.set(&next_addr, next_entry);
            }
        } else {
            // We were the tail
            self.sorted_tail.set(entry.prev);
        }

        // Clear entry
        let empty_entry = SortedVaultEntry {
            owner,
            interest_rate_bps: 0,
            prev: None,
            next: None,
        };
        self.sorted_vaults.set(&owner, empty_entry);
    }
}
