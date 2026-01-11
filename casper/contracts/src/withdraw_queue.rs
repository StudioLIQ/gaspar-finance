//! Withdraw Queue Contract
//!
//! Manages withdrawal requests for stCSPR (LST) with unbonding delay.
//!
//! ## Design
//!
//! - "Quote at request time" model: exchange rate is fixed when request is created
//! - stCSPR is locked (transferred to queue), not burned at request time
//! - CSPR is paid and stCSPR is burned at claim time
//!
//! ## Flow
//!
//! 1. User calls `request_withdraw(shares)` on this contract
//! 2. Queue pulls stCSPR from user (transfer_from to queue)
//! 3. Queue records request with `quoted_rate` (current R at request time)
//! 4. Operator triggers undelegation as needed
//! 5. After cooldown, user calls `claim(request_id)`
//! 6. Queue burns locked stCSPR via ybToken and transfers CSPR to user

use odra::prelude::*;
use odra::casper_types::{U256, runtime_args, RuntimeArgs};
use odra::CallDef;
use crate::errors::CdpError;

/// Scale for rate calculations (1e18)
const SCALE: u128 = 1_000_000_000_000_000_000;
/// Default unbonding period in seconds (7 hours for testnet, ~14 days for mainnet)
/// Testnet: 7 hours = 7 * 60 * 60 = 25200 seconds
const DEFAULT_UNBONDING_PERIOD: u64 = 25200;
/// Maximum requests per user (to limit storage)
const MAX_REQUESTS_PER_USER: u32 = 100;

/// Withdrawal request status
#[odra::odra_type]
#[derive(Copy)]
pub enum WithdrawStatus {
    /// Request is pending, waiting for cooldown
    Pending,
    /// Request is claimable (cooldown complete)
    Claimable,
    /// Request has been claimed
    Claimed,
    /// Request was cancelled
    Cancelled,
}

/// Withdrawal request record
#[odra::odra_type]
pub struct WithdrawRequest {
    /// Unique request ID
    pub request_id: u64,
    /// Owner address
    pub owner: Address,
    /// Amount of stCSPR locked (shares)
    pub shares_locked: U256,
    /// Quoted assets (CSPR) at request time: shares * R
    pub quoted_assets: U256,
    /// Quoted rate (R) at request time (scaled by 1e18)
    pub quoted_rate: U256,
    /// Request timestamp
    pub request_timestamp: u64,
    /// Cooldown end timestamp (when claimable)
    pub claimable_at: u64,
    /// Current status
    pub status: WithdrawStatus,
}

/// Queue statistics
#[odra::odra_type]
#[derive(Default)]
pub struct QueueStats {
    /// Total pending shares in queue
    pub total_pending_shares: U256,
    /// Total pending assets (quoted) in queue
    pub total_pending_assets: U256,
    /// Total claimable assets in queue
    pub total_claimable_assets: U256,
    /// Number of pending requests
    pub pending_count: u64,
    /// Number of claimable requests
    pub claimable_count: u64,
}

/// Queue configuration
#[odra::odra_type]
pub struct QueueConfig {
    /// Unbonding period in seconds
    pub unbonding_period: u64,
    /// Minimum withdrawal amount (in shares)
    pub min_withdrawal: U256,
    /// Whether new requests are paused
    pub requests_paused: bool,
    /// Whether claims are paused
    pub claims_paused: bool,
}

/// Withdraw Queue Contract
#[odra::module]
pub struct WithdrawQueue {
    /// ybToken (stCSPR) contract address
    ybtoken: Var<Address>,
    /// Admin address
    admin: Var<Address>,
    /// Next request ID counter
    next_request_id: Var<u64>,
    /// Request storage: request_id -> request
    requests: Mapping<u64, WithdrawRequest>,
    /// User request list: (user, index) -> request_id
    user_requests: Mapping<(Address, u32), u64>,
    /// User request count: user -> count
    user_request_count: Mapping<Address, u32>,
    /// Queue configuration
    config: Var<QueueConfig>,
    /// Queue statistics
    stats: Var<QueueStats>,
    /// Cached exchange rate (updated externally to avoid cross-contract call issues)
    /// Scaled by 1e18 (1e18 = 1.0)
    cached_rate: Var<U256>,
}

#[odra::module]
impl WithdrawQueue {
    /// Initialize the withdraw queue
    pub fn init(&mut self, ybtoken: Address, admin: Address) {
        self.ybtoken.set(ybtoken);
        self.admin.set(admin);
        self.next_request_id.set(1);
        self.stats.set(QueueStats::default());
        // Initialize cached rate to 1:1 (1e18)
        self.cached_rate.set(U256::from(SCALE));

        self.config.set(QueueConfig {
            unbonding_period: DEFAULT_UNBONDING_PERIOD,
            min_withdrawal: U256::zero(),
            requests_paused: false,
            claims_paused: false,
        });
    }

    // ===== User Functions =====

    /// Request withdrawal of stCSPR shares
    ///
    /// # Arguments
    /// * `shares` - Amount of stCSPR to withdraw
    ///
    /// # Returns
    /// * Request ID
    ///
    /// # Notes
    /// * User must have approved this contract to transfer their stCSPR
    /// * Exchange rate is fixed at request time (quote model)
    /// * stCSPR is locked in this contract until claim
    pub fn request_withdraw(&mut self, shares: U256) -> u64 {
        let config = self.config.get().unwrap();
        if config.requests_paused {
            self.env().revert(CdpError::SafeModeActive);
        }

        let caller = self.env().caller();

        // Validate minimum
        if shares < config.min_withdrawal {
            self.env().revert(CdpError::BelowMinDebt);
        }

        if shares.is_zero() {
            self.env().revert(CdpError::BelowMinDebt);
        }

        // Check user hasn't exceeded max requests
        let user_count = self.user_request_count.get(&caller).unwrap_or(0);
        if user_count >= MAX_REQUESTS_PER_USER {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Get current exchange rate from ybToken
        // Note: In a real implementation, this would be a cross-contract call
        // For MVP, we'll store the rate calculation here
        let quoted_rate = self.get_current_rate();

        // Calculate quoted assets: assets = shares * R / SCALE
        let quoted_assets = shares * quoted_rate / U256::from(SCALE);

        // Generate request ID
        let request_id = self.next_request_id.get().unwrap_or(1);
        self.next_request_id.set(request_id + 1);

        // Calculate claimable timestamp
        let now = self.env().get_block_time();
        let claimable_at = now + config.unbonding_period;

        // Create request
        let request = WithdrawRequest {
            request_id,
            owner: caller,
            shares_locked: shares,
            quoted_assets,
            quoted_rate,
            request_timestamp: now,
            claimable_at,
            status: WithdrawStatus::Pending,
        };

        // Store request
        self.requests.set(&request_id, request);

        // Add to user's request list
        self.user_requests.set(&(caller, user_count), request_id);
        self.user_request_count.set(&caller, user_count + 1);

        // Update stats
        let mut stats = self.stats.get().unwrap_or_default();
        stats.total_pending_shares = stats.total_pending_shares + shares;
        stats.total_pending_assets = stats.total_pending_assets + quoted_assets;
        stats.pending_count += 1;
        self.stats.set(stats);

        // Transfer stCSPR from user to this contract (lock)
        // Note: User must have approved this contract first
        // In real implementation: ybtoken.transfer_from(caller, self, shares)
        self.lock_shares_from_user(caller, shares);

        request_id
    }

    /// Claim a completed withdrawal request
    ///
    /// # Arguments
    /// * `request_id` - The request ID to claim
    ///
    /// # Notes
    /// * Only owner of the request can claim
    /// * Request must be past cooldown period
    /// * Burns locked stCSPR and transfers CSPR to user
    pub fn claim(&mut self, request_id: u64) {
        let config = self.config.get().unwrap();
        if config.claims_paused {
            self.env().revert(CdpError::SafeModeActive);
        }

        let caller = self.env().caller();

        // Get request
        let mut request = match self.requests.get(&request_id) {
            Some(r) => r,
            None => self.env().revert(CdpError::VaultNotFound),
        };

        // Verify ownership
        if request.owner != caller {
            self.env().revert(CdpError::Unauthorized);
        }

        // Verify status
        match request.status {
            WithdrawStatus::Pending => {}
            WithdrawStatus::Claimable => {}
            WithdrawStatus::Claimed => self.env().revert(CdpError::VaultNotFound),
            WithdrawStatus::Cancelled => self.env().revert(CdpError::VaultNotFound),
        }

        // Check cooldown
        let now = self.env().get_block_time();
        if now < request.claimable_at {
            self.env().revert(CdpError::SafeModeActive); // Still in cooldown
        }

        // Update request status
        request.status = WithdrawStatus::Claimed;
        self.requests.set(&request_id, request.clone());

        // Update stats
        let mut stats = self.stats.get().unwrap_or_default();
        if stats.total_pending_shares >= request.shares_locked {
            stats.total_pending_shares = stats.total_pending_shares - request.shares_locked;
        }
        if stats.total_pending_assets >= request.quoted_assets {
            stats.total_pending_assets = stats.total_pending_assets - request.quoted_assets;
        }
        if stats.pending_count > 0 {
            stats.pending_count -= 1;
        }
        self.stats.set(stats);

        // Burn locked stCSPR via ybToken
        // Note: In real implementation, call ybtoken.burn_from_queue(self, shares)
        self.burn_locked_shares(request.shares_locked);

        // Transfer CSPR to user via ybToken
        // Note: In real implementation, call ybtoken.transfer_cspr_to_user(caller, quoted_assets)
        self.transfer_cspr_to_user(caller, request.quoted_assets);
    }

    /// Get request details
    pub fn get_request(&self, request_id: u64) -> Option<WithdrawRequest> {
        self.requests.get(&request_id)
    }

    /// Get user's request count
    pub fn get_user_request_count(&self, user: Address) -> u32 {
        self.user_request_count.get(&user).unwrap_or(0)
    }

    /// Get user's request at index
    pub fn get_user_request_at(&self, user: Address, index: u32) -> Option<u64> {
        self.user_requests.get(&(user, index))
    }

    /// Get all pending request IDs for a user
    pub fn get_user_pending_requests(&self, user: Address) -> Vec<u64> {
        let count = self.user_request_count.get(&user).unwrap_or(0);
        let mut pending = Vec::new();

        for i in 0..count {
            if let Some(request_id) = self.user_requests.get(&(user, i)) {
                if let Some(request) = self.requests.get(&request_id) {
                    match request.status {
                        WithdrawStatus::Pending | WithdrawStatus::Claimable => {
                            pending.push(request_id);
                        }
                        _ => {}
                    }
                }
            }
        }

        pending
    }

    /// Check if a request is claimable
    pub fn is_claimable(&self, request_id: u64) -> bool {
        if let Some(request) = self.requests.get(&request_id) {
            let now = self.env().get_block_time();
            match request.status {
                WithdrawStatus::Pending | WithdrawStatus::Claimable => {
                    now >= request.claimable_at
                }
                _ => false,
            }
        } else {
            false
        }
    }

    /// Get queue statistics
    pub fn get_stats(&self) -> QueueStats {
        self.stats.get().unwrap_or_default()
    }

    /// Get queue configuration
    pub fn get_config(&self) -> QueueConfig {
        self.config.get().unwrap()
    }

    /// Get ybToken address
    pub fn get_ybtoken(&self) -> Address {
        self.ybtoken.get().unwrap()
    }

    // ===== Admin Functions =====

    /// Set unbonding period (admin only)
    pub fn set_unbonding_period(&mut self, period: u64) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.unbonding_period = period;
        self.config.set(config);
    }

    /// Set minimum withdrawal (admin only)
    pub fn set_min_withdrawal(&mut self, min: U256) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.min_withdrawal = min;
        self.config.set(config);
    }

    /// Pause new requests (admin only)
    pub fn pause_requests(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.requests_paused = true;
        self.config.set(config);
    }

    /// Unpause requests (admin only)
    pub fn unpause_requests(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.requests_paused = false;
        self.config.set(config);
    }

    /// Pause claims (admin only)
    pub fn pause_claims(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.claims_paused = true;
        self.config.set(config);
    }

    /// Unpause claims (admin only)
    pub fn unpause_claims(&mut self) {
        self.require_admin();
        let mut config = self.config.get().unwrap();
        config.claims_paused = false;
        self.config.set(config);
    }

    /// Update cached exchange rate (admin only)
    ///
    /// This should be called periodically by a keeper to sync the rate
    /// from the ybToken contract. Avoids cross-contract call issues.
    ///
    /// # Arguments
    /// * `rate` - Exchange rate scaled by 1e18 (e.g., 1.05e18 for 1.05 CSPR/stCSPR)
    pub fn update_rate(&mut self, rate: U256) {
        self.require_admin();
        if rate.is_zero() {
            self.env().revert(CdpError::InvalidConfig);
        }
        self.cached_rate.set(rate);
    }

    /// Get cached exchange rate
    pub fn get_cached_rate(&self) -> U256 {
        self.cached_rate.get().unwrap_or(U256::from(SCALE))
    }

    /// Get admin address
    pub fn get_admin(&self) -> Address {
        self.admin.get().unwrap()
    }

    // ===== Internal Functions =====

    fn require_admin(&self) {
        let caller = self.env().caller();
        let admin = self.admin.get().unwrap();
        if caller != admin {
            self.env().revert(CdpError::Unauthorized);
        }
    }

    /// Get current exchange rate from cached value
    ///
    /// Returns rate scaled by 1e18 (CSPR_PER_SCSPR)
    /// Uses cached rate instead of cross-contract call to avoid Casper 2.0 issues
    fn get_current_rate(&self) -> U256 {
        // Use cached rate (updated externally by keeper/admin)
        // Falls back to 1:1 rate (1e18) if not set
        self.cached_rate.get().unwrap_or(U256::from(SCALE))
    }

    /// Lock shares from user by transferring to this contract
    ///
    /// Calls ybtoken.transfer_from(user, queue, shares) to lock the shares.
    /// User must have approved this contract beforehand.
    fn lock_shares_from_user(&mut self, from: Address, amount: U256) {
        let ybtoken_address = self.ybtoken.get().unwrap();
        let queue_address = self.env().self_address();

        let args = runtime_args! {
            "owner" => from,
            "recipient" => queue_address,
            "amount" => amount
        };
        let call_def = CallDef::new("transfer_from", true, args);
        let success: bool = self.env().call_contract(ybtoken_address, call_def);

        if !success {
            self.env().revert(CdpError::InsufficientTokenBalance);
        }
    }

    /// Burn locked shares via ybToken
    ///
    /// Calls ybtoken.burn_from_queue(queue, shares) to burn the locked shares.
    /// The queue holds the shares after lock, so it is the owner for burning.
    fn burn_locked_shares(&mut self, amount: U256) {
        let ybtoken_address = self.ybtoken.get().unwrap();
        let queue_address = self.env().self_address();

        let args = runtime_args! {
            "owner" => queue_address,
            "amount" => amount
        };
        let call_def = CallDef::new("burn_from_queue", true, args);
        self.env().call_contract::<()>(ybtoken_address, call_def);
    }

    /// Transfer CSPR to user via ybToken
    ///
    /// Calls ybtoken.transfer_cspr_to_user(recipient, amount) to pay out CSPR.
    fn transfer_cspr_to_user(&mut self, to: Address, amount: U256) {
        let ybtoken_address = self.ybtoken.get().unwrap();

        let args = runtime_args! {
            "recipient" => to,
            "amount" => amount
        };
        let call_def = CallDef::new("transfer_cspr_to_user", true, args);
        self.env().call_contract::<()>(ybtoken_address, call_def);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_withdraw_status_variants() {
        let statuses = [
            WithdrawStatus::Pending,
            WithdrawStatus::Claimable,
            WithdrawStatus::Claimed,
            WithdrawStatus::Cancelled,
        ];
        assert_eq!(statuses.len(), 4);
    }

    #[test]
    fn test_queue_stats_default() {
        let stats = QueueStats::default();
        assert!(stats.total_pending_shares.is_zero());
        assert!(stats.total_pending_assets.is_zero());
        assert!(stats.total_claimable_assets.is_zero());
        assert_eq!(stats.pending_count, 0);
        assert_eq!(stats.claimable_count, 0);
    }

    #[test]
    fn test_constants() {
        assert_eq!(SCALE, 1_000_000_000_000_000_000);
        assert_eq!(DEFAULT_UNBONDING_PERIOD, 25200); // 7 hours
        assert_eq!(MAX_REQUESTS_PER_USER, 100);
    }

    #[test]
    fn test_quoted_assets_calculation() {
        // shares = 1000, rate = 1.1 (1.1e18)
        let shares = U256::from(1000u64);
        let rate = U256::from(SCALE) * U256::from(11u64) / U256::from(10u64); // 1.1

        // quoted_assets = shares * rate / SCALE = 1000 * 1.1 = 1100
        let quoted_assets = shares * rate / U256::from(SCALE);
        assert_eq!(quoted_assets, U256::from(1100u64));
    }
}
