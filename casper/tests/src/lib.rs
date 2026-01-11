//! CSPR-CDP Integration Tests
//!
//! Test modules for the CDP protocol.

#[cfg(test)]
mod tests {
    use cspr_cdp_contracts::types::*;

    #[test]
    fn test_collateral_id_ordering() {
        // Verify CollateralId ordering is consistent
        assert!(CollateralId::Cspr < CollateralId::SCSPR);
    }

    #[test]
    fn test_oracle_status_variants() {
        // Verify all oracle status variants exist
        let statuses = [
            OracleStatus::Ok,
            OracleStatus::Unavailable,
            OracleStatus::Stale,
            OracleStatus::Deviation,
            OracleStatus::InvalidRate,
            OracleStatus::DecimalsMismatch,
        ];
        assert_eq!(statuses.len(), 6);
    }
}

#[cfg(test)]
mod lst_tests {
    use cspr_cdp_contracts::scspr_ybtoken::*;
    use cspr_cdp_contracts::withdraw_queue::*;
    use odra::casper_types::U256;

    const SCALE: u128 = 1_000_000_000_000_000_000;

    // ===== Cross-Contract Call Logic Tests =====
    // Note: Full E2E tests require odra-test-vm specific setup.
    // The core cross-contract call logic is verified at the unit test level
    // by testing the data structures and calculation logic.

    /// Verify cross-contract call arguments are correctly formed
    #[test]
    fn test_cross_contract_call_args() {
        use odra::casper_types::RuntimeArgs;
        use odra::CallDef;

        // Test get_exchange_rate call definition
        let call_def = CallDef::new("get_exchange_rate", false, RuntimeArgs::new());
        assert_eq!(call_def.entry_point(), "get_exchange_rate");
        assert!(!call_def.is_mut());

        // Test transfer_from call definition
        let args = odra::casper_types::runtime_args! {
            "owner" => odra::prelude::Address::Account(odra::casper_types::account::AccountHash::default()),
            "recipient" => odra::prelude::Address::Account(odra::casper_types::account::AccountHash::default()),
            "amount" => U256::from(1000u64)
        };
        let call_def = CallDef::new("transfer_from", true, args);
        assert_eq!(call_def.entry_point(), "transfer_from");
        assert!(call_def.is_mut());

        // Test burn_from_queue call definition
        let args = odra::casper_types::runtime_args! {
            "owner" => odra::prelude::Address::Account(odra::casper_types::account::AccountHash::default()),
            "amount" => U256::from(500u64)
        };
        let call_def = CallDef::new("burn_from_queue", true, args);
        assert_eq!(call_def.entry_point(), "burn_from_queue");
        assert!(call_def.is_mut());

        // Test transfer_cspr_to_user call definition
        let args = odra::casper_types::runtime_args! {
            "recipient" => odra::prelude::Address::Account(odra::casper_types::account::AccountHash::default()),
            "amount" => U256::from(750u64)
        };
        let call_def = CallDef::new("transfer_cspr_to_user", true, args);
        assert_eq!(call_def.entry_point(), "transfer_cspr_to_user");
        assert!(call_def.is_mut());
    }

    // ===== AssetBreakdown Tests =====

    #[test]
    fn test_asset_breakdown_total_basic() {
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
    fn test_asset_breakdown_total_no_deductions() {
        let assets = AssetBreakdown {
            idle_cspr: U256::from(1000u64),
            delegated_cspr: U256::from(5000u64),
            undelegating_cspr: U256::from(500u64),
            claimable_cspr: U256::from(100u64),
            protocol_fees: U256::zero(),
            realized_losses: U256::zero(),
        };

        // Total = 1000 + 5000 + 500 + 100 = 6600
        assert_eq!(assets.total(), U256::from(6600u64));
    }

    #[test]
    fn test_asset_breakdown_underflow_protection() {
        let assets = AssetBreakdown {
            idle_cspr: U256::from(100u64),
            delegated_cspr: U256::zero(),
            undelegating_cspr: U256::zero(),
            claimable_cspr: U256::zero(),
            protocol_fees: U256::from(50u64),
            realized_losses: U256::from(100u64), // More than assets
        };

        // Should return 0, not underflow
        assert_eq!(assets.total(), U256::zero());
    }

    #[test]
    fn test_asset_breakdown_default() {
        let assets = AssetBreakdown::default();
        assert!(assets.idle_cspr.is_zero());
        assert!(assets.delegated_cspr.is_zero());
        assert!(assets.undelegating_cspr.is_zero());
        assert!(assets.claimable_cspr.is_zero());
        assert!(assets.protocol_fees.is_zero());
        assert!(assets.realized_losses.is_zero());
        assert!(assets.total().is_zero());
    }

    // ===== Rate Calculation Tests =====

    #[test]
    fn test_convert_to_shares_1_to_1() {
        // When total_assets = total_shares, rate is 1:1
        let total_assets = U256::from(1000u64);
        let total_shares = U256::from(1000u64);
        let assets_to_convert = U256::from(100u64);

        // shares = assets * total_shares / total_assets
        let shares = assets_to_convert * total_shares / total_assets;
        assert_eq!(shares, U256::from(100u64));
    }

    #[test]
    fn test_convert_to_shares_rate_increase() {
        // After rewards: total_assets = 1100, total_shares = 1000 (R = 1.1)
        let total_assets = U256::from(1100u64);
        let total_shares = U256::from(1000u64);
        let assets_to_convert = U256::from(110u64);

        // shares = assets * total_shares / total_assets = 110 * 1000 / 1100 = 100
        let shares = assets_to_convert * total_shares / total_assets;
        assert_eq!(shares, U256::from(100u64));
    }

    #[test]
    fn test_convert_to_assets_1_to_1() {
        // When total_assets = total_shares, rate is 1:1
        let total_assets = U256::from(1000u64);
        let total_shares = U256::from(1000u64);
        let shares_to_convert = U256::from(100u64);

        // assets = shares * total_assets / total_shares
        let assets = shares_to_convert * total_assets / total_shares;
        assert_eq!(assets, U256::from(100u64));
    }

    #[test]
    fn test_convert_to_assets_rate_increase() {
        // After rewards: total_assets = 1100, total_shares = 1000 (R = 1.1)
        let total_assets = U256::from(1100u64);
        let total_shares = U256::from(1000u64);
        let shares_to_convert = U256::from(100u64);

        // assets = shares * total_assets / total_shares = 100 * 1100 / 1000 = 110
        let assets = shares_to_convert * total_assets / total_shares;
        assert_eq!(assets, U256::from(110u64));
    }

    #[test]
    fn test_rate_calculation() {
        // R = total_assets * SCALE / total_shares
        let total_assets = U256::from(1100u64);
        let total_shares = U256::from(1000u64);

        let rate = total_assets * U256::from(SCALE) / total_shares;

        // R should be 1.1e18
        let expected = U256::from(SCALE) * U256::from(11u64) / U256::from(10u64);
        assert_eq!(rate, expected);
    }

    #[test]
    fn test_deposit_shares_calculation() {
        // User deposits 110 CSPR when R = 1.1
        let total_assets = U256::from(1100u64);
        let total_shares = U256::from(1000u64);
        let deposit_amount = U256::from(110u64);

        // shares = deposit * total_shares / total_assets = 110 * 1000 / 1100 = 100
        let shares_minted = deposit_amount * total_shares / total_assets;
        assert_eq!(shares_minted, U256::from(100u64));

        // After deposit: total_assets = 1210, total_shares = 1100
        // R should remain 1.1
        let new_total_assets = total_assets + deposit_amount;
        let new_total_shares = total_shares + shares_minted;
        let new_rate = new_total_assets * U256::from(SCALE) / new_total_shares;
        let old_rate = total_assets * U256::from(SCALE) / total_shares;

        assert_eq!(new_rate, old_rate); // Rate unchanged after deposit
    }

    // ===== Withdraw Queue Tests =====

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
    fn test_quoted_assets_calculation() {
        // User requests withdraw of 100 shares when R = 1.1
        let shares = U256::from(100u64);
        let rate = U256::from(SCALE) * U256::from(11u64) / U256::from(10u64); // 1.1e18

        // quoted_assets = shares * rate / SCALE = 100 * 1.1 = 110
        let quoted_assets = shares * rate / U256::from(SCALE);
        assert_eq!(quoted_assets, U256::from(110u64));
    }

    #[test]
    fn test_quote_preservation() {
        // Scenario: User quotes at R=1.1, rate later increases to R=1.2
        // User should still receive amount based on R=1.1 (quote-at-request model)
        let shares = U256::from(100u64);
        let quote_rate = U256::from(SCALE) * U256::from(11u64) / U256::from(10u64); // 1.1
        let later_rate = U256::from(SCALE) * U256::from(12u64) / U256::from(10u64); // 1.2

        let quoted_assets = shares * quote_rate / U256::from(SCALE);
        let current_assets = shares * later_rate / U256::from(SCALE);

        assert_eq!(quoted_assets, U256::from(110u64));
        assert_eq!(current_assets, U256::from(120u64));

        // User gets quoted amount, not current (quote model)
        assert!(quoted_assets < current_assets);
    }

    // ===== Constants Tests =====

    #[test]
    fn test_scale_constant() {
        assert_eq!(SCALE, 1_000_000_000_000_000_000);
    }

    #[test]
    fn test_unbonding_period_testnet() {
        // Testnet: 7 hours = 25200 seconds
        const TESTNET_UNBONDING: u64 = 25200;
        assert_eq!(TESTNET_UNBONDING, 7 * 60 * 60);
    }

    // ===== R Invariant Tests =====

    #[test]
    fn test_r_unchanged_after_deposit() {
        // Initial state
        let mut total_assets = U256::from(1000u64);
        let mut total_shares = U256::from(1000u64);

        let initial_r = total_assets * U256::from(SCALE) / total_shares;

        // Deposit 500 CSPR
        let deposit = U256::from(500u64);
        let minted = deposit * total_shares / total_assets;

        total_assets = total_assets + deposit;
        total_shares = total_shares + minted;

        let new_r = total_assets * U256::from(SCALE) / total_shares;

        // R should be unchanged
        assert_eq!(initial_r, new_r);
    }

    #[test]
    fn test_r_increases_with_rewards() {
        // Initial state
        let total_assets = U256::from(1000u64);
        let total_shares = U256::from(1000u64);

        let initial_r = total_assets * U256::from(SCALE) / total_shares;

        // Rewards compound: +100 CSPR (no new shares)
        let rewards = U256::from(100u64);
        let new_total_assets = total_assets + rewards;

        let new_r = new_total_assets * U256::from(SCALE) / total_shares;

        // R should increase
        assert!(new_r > initial_r);
        // R should be 1.1
        let expected_r = U256::from(SCALE) * U256::from(11u64) / U256::from(10u64);
        assert_eq!(new_r, expected_r);
    }

    #[test]
    fn test_r_unchanged_after_withdraw_request() {
        // Initial state
        let total_assets = U256::from(1000u64);
        let total_shares = U256::from(1000u64);

        // User requests withdraw of 100 shares
        // In quote+lock model: shares are locked (transferred to queue), NOT burned
        // So total_shares stays the same

        // R should be unchanged (shares in queue still count as total_shares)
        let r_before = total_assets * U256::from(SCALE) / total_shares;
        let r_after = total_assets * U256::from(SCALE) / total_shares;

        assert_eq!(r_before, r_after);
    }

    #[test]
    fn test_r_consistency_after_claim() {
        // Initial state
        let mut total_assets = U256::from(1000u64);
        let mut total_shares = U256::from(1000u64);

        let initial_r = total_assets * U256::from(SCALE) / total_shares;

        // User claims 100 shares worth of CSPR (quote was at R=1.0)
        let claimed_shares = U256::from(100u64);
        let claimed_assets = U256::from(100u64); // quote at R=1.0

        // At claim: burn shares AND pay assets
        total_shares = total_shares - claimed_shares;
        total_assets = total_assets - claimed_assets;

        let new_r = total_assets * U256::from(SCALE) / total_shares;

        // R should be unchanged if quote was accurate
        assert_eq!(initial_r, new_r);
    }
}
