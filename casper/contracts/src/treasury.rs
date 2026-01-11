//! Treasury Contract
//!
//! Collects and manages protocol fees including:
//! - Borrowing fees (from opening vaults)
//! - Redemption fees
//! - Accrued interest
//!
//! Fees are collected in gUSD and can be distributed to stakeholders.

use odra::prelude::*;
use odra::casper_types::U256;
use crate::errors::CdpError;

/// Treasury Contract for protocol fee collection and distribution
#[odra::module]
pub struct Treasury {
    /// Registry contract address
    registry: Var<Address>,
    /// Stablecoin (gUSD) contract address
    stablecoin: Var<Address>,
    /// Total fees collected (all time, in gUSD)
    total_fees_collected: Var<U256>,
    /// Total fees distributed (all time, in gUSD)
    total_fees_distributed: Var<U256>,
    /// Pending fees available for distribution
    pending_fees: Var<U256>,
    /// Fee breakdown by type
    borrowing_fees: Var<U256>,
    redemption_fees: Var<U256>,
    interest_fees: Var<U256>,
    /// Authorized depositors (protocol contracts)
    authorized_depositors: Mapping<Address, bool>,
    /// Fee recipient address
    fee_recipient: Var<Option<Address>>,
}

#[odra::module]
impl Treasury {
    /// Initialize the treasury
    pub fn init(&mut self, registry: Address, stablecoin: Address) {
        self.registry.set(registry);
        self.stablecoin.set(stablecoin);
        self.total_fees_collected.set(U256::zero());
        self.total_fees_distributed.set(U256::zero());
        self.pending_fees.set(U256::zero());
        self.borrowing_fees.set(U256::zero());
        self.redemption_fees.set(U256::zero());
        self.interest_fees.set(U256::zero());
        self.fee_recipient.set(None);
    }

    // ========== Fee Collection (Protocol Only) ==========

    /// Record borrowing fee (called by branches when vault is opened)
    pub fn record_borrowing_fee(&mut self, amount: U256) {
        self.require_authorized_depositor();
        self.add_fee(amount, FeeType::Borrowing);
    }

    /// Record redemption fee (called by redemption engine)
    pub fn record_redemption_fee(&mut self, amount: U256) {
        self.require_authorized_depositor();
        self.add_fee(amount, FeeType::Redemption);
    }

    /// Record interest fee (called by branches on interest accrual)
    pub fn record_interest_fee(&mut self, amount: U256) {
        self.require_authorized_depositor();
        self.add_fee(amount, FeeType::Interest);
    }

    // ========== Fee Distribution (Admin Only) ==========

    /// Distribute pending fees to recipient
    pub fn distribute_fees(&mut self, amount: U256) {
        // TODO: Check caller is admin
        let pending = self.pending_fees.get().unwrap_or(U256::zero());
        if amount > pending {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Update accounting
        self.pending_fees.set(pending - amount);

        let total_distributed = self.total_fees_distributed.get().unwrap_or(U256::zero());
        self.total_fees_distributed.set(total_distributed + amount);

        // TODO: Actually transfer gUSD to fee_recipient
        // This requires the stablecoin contract interaction
    }

    // ========== View Functions ==========

    /// Get total fees collected
    pub fn get_total_fees_collected(&self) -> U256 {
        self.total_fees_collected.get().unwrap_or(U256::zero())
    }

    /// Get total fees distributed
    pub fn get_total_fees_distributed(&self) -> U256 {
        self.total_fees_distributed.get().unwrap_or(U256::zero())
    }

    /// Get pending fees
    pub fn get_pending_fees(&self) -> U256 {
        self.pending_fees.get().unwrap_or(U256::zero())
    }

    /// Get fee breakdown
    pub fn get_fee_breakdown(&self) -> FeeBreakdown {
        FeeBreakdown {
            borrowing: self.borrowing_fees.get().unwrap_or(U256::zero()),
            redemption: self.redemption_fees.get().unwrap_or(U256::zero()),
            interest: self.interest_fees.get().unwrap_or(U256::zero()),
        }
    }

    /// Get registry address
    pub fn get_registry(&self) -> Option<Address> {
        self.registry.get()
    }

    /// Get stablecoin address
    pub fn get_stablecoin(&self) -> Option<Address> {
        self.stablecoin.get()
    }

    /// Get fee recipient
    pub fn get_fee_recipient(&self) -> Option<Address> {
        self.fee_recipient.get().flatten()
    }

    // ========== Admin Functions ==========

    /// Add authorized depositor (admin only)
    pub fn add_depositor(&mut self, depositor: Address) {
        // TODO: Check caller is registry admin
        self.authorized_depositors.set(&depositor, true);
    }

    /// Remove authorized depositor (admin only)
    pub fn remove_depositor(&mut self, depositor: Address) {
        // TODO: Check caller is registry admin
        self.authorized_depositors.set(&depositor, false);
    }

    /// Check if address is authorized depositor
    pub fn is_depositor(&self, account: Address) -> bool {
        self.authorized_depositors.get(&account).unwrap_or(false)
    }

    /// Set fee recipient (admin only)
    pub fn set_fee_recipient(&mut self, recipient: Address) {
        // TODO: Check caller is registry admin
        self.fee_recipient.set(Some(recipient));
    }

    // ========== Internal Functions ==========

    fn add_fee(&mut self, amount: U256, fee_type: FeeType) {
        if amount.is_zero() {
            return;
        }

        // Update total
        let total = self.total_fees_collected.get().unwrap_or(U256::zero());
        self.total_fees_collected.set(total + amount);

        // Update pending
        let pending = self.pending_fees.get().unwrap_or(U256::zero());
        self.pending_fees.set(pending + amount);

        // Update by type
        match fee_type {
            FeeType::Borrowing => {
                let current = self.borrowing_fees.get().unwrap_or(U256::zero());
                self.borrowing_fees.set(current + amount);
            }
            FeeType::Redemption => {
                let current = self.redemption_fees.get().unwrap_or(U256::zero());
                self.redemption_fees.set(current + amount);
            }
            FeeType::Interest => {
                let current = self.interest_fees.get().unwrap_or(U256::zero());
                self.interest_fees.set(current + amount);
            }
        }
    }

    fn require_authorized_depositor(&self) {
        let caller = self.env().caller();
        if !self.is_depositor(caller) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }
}

/// Fee type enum for internal tracking
enum FeeType {
    Borrowing,
    Redemption,
    Interest,
}

/// Fee breakdown structure
#[odra::odra_type]
pub struct FeeBreakdown {
    /// Total borrowing fees collected
    pub borrowing: U256,
    /// Total redemption fees collected
    pub redemption: U256,
    /// Total interest fees collected
    pub interest: U256,
}
