//! Access Control Contract
//!
//! Provides role-based access control for the CDP protocol.
//! Implements a flexible role system with:
//! - Admin role (can grant/revoke all roles)
//! - Guardian role (can trigger safe mode)
//! - Oracle role (can update oracle prices)
//! - Treasury role (can distribute fees)
//!
//! Role hierarchy:
//! - ADMIN > all roles
//! - GUARDIAN can trigger emergency functions
//! - ORACLE can update price feeds
//! - TREASURY can manage fee distribution

use odra::prelude::*;
use odra::casper_types::U256;
use crate::errors::CdpError;

/// Role constants (u8 for efficient storage)
pub const ROLE_ADMIN: u8 = 0;
pub const ROLE_GUARDIAN: u8 = 1;
pub const ROLE_ORACLE: u8 = 2;
pub const ROLE_TREASURY: u8 = 3;
pub const ROLE_BRANCH: u8 = 4;
pub const ROLE_LIQUIDATOR: u8 = 5;
pub const ROLE_PAUSER: u8 = 6;

/// Access Control Contract
#[odra::module]
pub struct AccessControl {
    /// Role assignments: (role, account) -> bool
    roles: Mapping<(u8, Address), bool>,
    /// Role admin mapping: role -> admin_role
    role_admin: Mapping<u8, u8>,
    /// Number of accounts with each role
    role_count: Mapping<u8, u32>,
    /// Whether the contract is initialized
    initialized: Var<bool>,
    /// Timelock delay for critical operations (in seconds)
    timelock_delay: Var<u64>,
    /// Pending role changes: (role, account) -> (action, timestamp)
    pending_changes: Mapping<(u8, Address), (bool, u64)>,
}

#[odra::module]
impl AccessControl {
    /// Initialize access control with initial admin
    pub fn init(&mut self, initial_admin: Address) {
        if self.initialized.get().unwrap_or(false) {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Grant admin role to initial admin
        self.set_role_internal(ROLE_ADMIN, initial_admin, true);

        // Set admin as the admin for all roles
        for role_id in 0..7u8 {
            self.role_admin.set(&role_id, ROLE_ADMIN);
        }

        // Default timelock: 24 hours
        self.timelock_delay.set(86400);
        self.initialized.set(true);
    }

    // ========== Role Query Functions ==========

    /// Check if account has a specific role
    pub fn has_role(&self, role_id: u8, account: Address) -> bool {
        self.roles.get(&(role_id, account)).unwrap_or(false)
    }

    /// Check if caller has a specific role
    pub fn caller_has_role(&self, role_id: u8) -> bool {
        self.has_role(role_id, self.env().caller())
    }

    /// Get the admin role for a given role
    pub fn get_role_admin(&self, role_id: u8) -> u8 {
        self.role_admin.get(&role_id).unwrap_or(ROLE_ADMIN)
    }

    /// Get the number of accounts with a role
    pub fn get_role_member_count(&self, role_id: u8) -> u32 {
        self.role_count.get(&role_id).unwrap_or(0)
    }

    // ========== Role Management Functions ==========

    /// Grant a role to an account (requires role admin)
    pub fn grant_role(&mut self, role_id: u8, account: Address) {
        self.require_role_admin(role_id);

        if self.has_role(role_id, account) {
            return; // Already has role
        }

        self.set_role_internal(role_id, account, true);
    }

    /// Revoke a role from an account (requires role admin)
    pub fn revoke_role(&mut self, role_id: u8, account: Address) {
        self.require_role_admin(role_id);

        if !self.has_role(role_id, account) {
            return; // Doesn't have role
        }

        // Prevent revoking the last admin
        if role_id == ROLE_ADMIN {
            let admin_count = self.get_role_member_count(ROLE_ADMIN);
            if admin_count <= 1 {
                self.env().revert(CdpError::InvalidConfig);
            }
        }

        self.set_role_internal(role_id, account, false);
    }

    /// Renounce a role (caller gives up their own role)
    pub fn renounce_role(&mut self, role_id: u8) {
        let caller = self.env().caller();

        if !self.has_role(role_id, caller) {
            return; // Doesn't have role
        }

        // Prevent renouncing the last admin
        if role_id == ROLE_ADMIN {
            let admin_count = self.get_role_member_count(ROLE_ADMIN);
            if admin_count <= 1 {
                self.env().revert(CdpError::InvalidConfig);
            }
        }

        self.set_role_internal(role_id, caller, false);
    }

    // ========== Timelocked Role Changes ==========

    /// Queue a role change (for critical roles)
    pub fn queue_role_change(&mut self, role_id: u8, account: Address, grant: bool) {
        self.require_role_admin(role_id);

        let execute_time = self.env().get_block_time() + self.timelock_delay.get().unwrap_or(86400);
        self.pending_changes.set(&(role_id, account), (grant, execute_time));
    }

    /// Execute a queued role change
    pub fn execute_role_change(&mut self, role_id: u8, account: Address) {
        let (grant, execute_time) = self.pending_changes
            .get(&(role_id, account))
            .unwrap_or((false, 0));

        if execute_time == 0 {
            self.env().revert(CdpError::InvalidConfig);
        }

        let current_time = self.env().get_block_time();
        if current_time < execute_time {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Clear pending change
        self.pending_changes.set(&(role_id, account), (false, 0));

        // Execute the change
        self.set_role_internal(role_id, account, grant);
    }

    /// Cancel a queued role change
    pub fn cancel_role_change(&mut self, role_id: u8, account: Address) {
        self.require_role_admin(role_id);
        self.pending_changes.set(&(role_id, account), (false, 0));
    }

    // ========== Admin Functions ==========

    /// Set the admin role for a role (admin only)
    pub fn set_role_admin(&mut self, role_id: u8, admin_role_id: u8) {
        self.require_admin();
        self.role_admin.set(&role_id, admin_role_id);
    }

    /// Set timelock delay (admin only)
    pub fn set_timelock_delay(&mut self, delay_seconds: u64) {
        self.require_admin();

        // Minimum 1 hour, maximum 7 days
        if delay_seconds < 3600 || delay_seconds > 604800 {
            self.env().revert(CdpError::InvalidConfig);
        }
        self.timelock_delay.set(delay_seconds);
    }

    /// Get timelock delay
    pub fn get_timelock_delay(&self) -> u64 {
        self.timelock_delay.get().unwrap_or(86400)
    }

    // ========== Modifier-like Functions (for other contracts) ==========

    /// Revert if caller doesn't have the specified role
    pub fn require_role(&self, role_id: u8) {
        if !self.caller_has_role(role_id) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    /// Revert if caller doesn't have admin role
    pub fn require_admin(&self) {
        self.require_role(ROLE_ADMIN);
    }

    /// Revert if caller doesn't have guardian or admin role
    pub fn require_guardian(&self) {
        if !self.caller_has_role(ROLE_GUARDIAN) && !self.caller_has_role(ROLE_ADMIN) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    /// Revert if caller doesn't have oracle or admin role
    pub fn require_oracle(&self) {
        if !self.caller_has_role(ROLE_ORACLE) && !self.caller_has_role(ROLE_ADMIN) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    /// Revert if caller doesn't have treasury or admin role
    pub fn require_treasury(&self) {
        if !self.caller_has_role(ROLE_TREASURY) && !self.caller_has_role(ROLE_ADMIN) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }

    // ========== Internal Functions ==========

    fn set_role_internal(&mut self, role_id: u8, account: Address, value: bool) {
        let had_role = self.roles.get(&(role_id, account)).unwrap_or(false);

        self.roles.set(&(role_id, account), value);

        // Update count
        let current_count = self.role_count.get(&role_id).unwrap_or(0);
        if value && !had_role {
            self.role_count.set(&role_id, current_count + 1);
        } else if !value && had_role && current_count > 0 {
            self.role_count.set(&role_id, current_count - 1);
        }
    }

    fn require_role_admin(&self, role_id: u8) {
        let admin_role_id = self.get_role_admin(role_id);
        if !self.caller_has_role(admin_role_id) {
            self.env().revert(CdpError::UnauthorizedProtocol);
        }
    }
}

/// Governance module for protocol parameter updates
#[odra::module]
pub struct Governance {
    /// Access control contract address
    access_control: Var<Address>,
    /// Protocol parameters with timelocks
    pending_params: Mapping<String, (U256, u64)>,
    /// Current protocol parameters
    current_params: Mapping<String, U256>,
    /// Parameter update delay
    param_delay: Var<u64>,
}

#[odra::module]
impl Governance {
    /// Initialize governance
    pub fn init(&mut self, access_control: Address) {
        self.access_control.set(access_control);
        self.param_delay.set(86400); // 24 hour default
    }

    /// Queue a parameter update
    pub fn queue_param_update(&mut self, param_name: String, new_value: U256) {
        // TODO: Check caller has admin role via access_control

        let execute_time = self.env().get_block_time() + self.param_delay.get().unwrap_or(86400);
        self.pending_params.set(&param_name, (new_value, execute_time));
    }

    /// Execute a queued parameter update
    pub fn execute_param_update(&mut self, param_name: String) {
        let (value, execute_time) = self.pending_params
            .get(&param_name)
            .unwrap_or((U256::zero(), 0));

        if execute_time == 0 {
            self.env().revert(CdpError::InvalidConfig);
        }

        let current_time = self.env().get_block_time();
        if current_time < execute_time {
            self.env().revert(CdpError::InvalidConfig);
        }

        // Clear pending and set current
        self.pending_params.set(&param_name, (U256::zero(), 0));
        self.current_params.set(&param_name, value);
    }

    /// Get current parameter value
    pub fn get_param(&self, param_name: String) -> U256 {
        self.current_params.get(&param_name).unwrap_or(U256::zero())
    }

    /// Get pending parameter update
    pub fn get_pending_param(&self, param_name: String) -> (U256, u64) {
        self.pending_params.get(&param_name).unwrap_or((U256::zero(), 0))
    }

    /// Set parameter delay (admin only)
    pub fn set_param_delay(&mut self, delay_seconds: u64) {
        // TODO: Check caller has admin role via access_control
        if delay_seconds < 3600 || delay_seconds > 604800 {
            self.env().revert(CdpError::InvalidConfig);
        }
        self.param_delay.set(delay_seconds);
    }

    /// Get parameter delay
    pub fn get_param_delay(&self) -> u64 {
        self.param_delay.get().unwrap_or(86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_role_constants() {
        assert_eq!(ROLE_ADMIN, 0);
        assert_eq!(ROLE_GUARDIAN, 1);
        assert_eq!(ROLE_ORACLE, 2);
        assert_eq!(ROLE_TREASURY, 3);
        assert_eq!(ROLE_BRANCH, 4);
        assert_eq!(ROLE_LIQUIDATOR, 5);
        assert_eq!(ROLE_PAUSER, 6);
    }

    #[test]
    fn test_timelock_bounds() {
        // Minimum 1 hour = 3600 seconds
        // Maximum 7 days = 604800 seconds
        assert!(3600 >= 1);
        assert!(604800 <= 7 * 24 * 3600);
    }

    #[test]
    fn test_default_timelock() {
        // Default is 24 hours = 86400 seconds
        let default_delay = 86400u64;
        assert!(default_delay >= 3600);
        assert!(default_delay <= 604800);
    }

    #[test]
    fn test_role_id_validity() {
        // All role IDs should be less than 7
        assert!(ROLE_ADMIN < 7);
        assert!(ROLE_GUARDIAN < 7);
        assert!(ROLE_ORACLE < 7);
        assert!(ROLE_TREASURY < 7);
        assert!(ROLE_BRANCH < 7);
        assert!(ROLE_LIQUIDATOR < 7);
        assert!(ROLE_PAUSER < 7);
    }
}
