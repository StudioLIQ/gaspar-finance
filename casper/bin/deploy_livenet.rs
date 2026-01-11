//! Deploy contracts to Casper livenet/testnet using Odra livenet environment.
//!
//! Usage:
//!   cd casper && cargo run --bin deploy_livenet --release
//!
//! Requires .env file with:
//!   ODRA_CASPER_LIVENET_SECRET_KEY_PATH=/path/to/secret_key.pem
//!   ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.casper.network
//!   ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
//!   ODRA_CASPER_LIVENET_PAYMENT_AMOUNT=200000000000

use odra::casper_types::U256;
use odra::host::Deployer;
use odra::prelude::*;

use cspr_cdp_contracts::access_control::{AccessControl, AccessControlInitArgs};
use cspr_cdp_contracts::branch_cspr::{BranchCspr, BranchCsprInitArgs};
use cspr_cdp_contracts::branch_scspr::{BranchSCSPR, BranchSCSPRInitArgs};
use cspr_cdp_contracts::liquidation_engine::{LiquidationEngine, LiquidationEngineInitArgs};
use cspr_cdp_contracts::oracle_adapter::{OracleAdapter, OracleAdapterInitArgs};
use cspr_cdp_contracts::redemption_engine::{RedemptionEngine, RedemptionEngineInitArgs};
use cspr_cdp_contracts::registry::{Registry, RegistryInitArgs};
use cspr_cdp_contracts::router::{Router, RouterInitArgs};
use cspr_cdp_contracts::scspr_ybtoken::{ScsprYbToken, ScsprYbTokenInitArgs};
use cspr_cdp_contracts::stability_pool::{StabilityPool, StabilityPoolInitArgs};
use cspr_cdp_contracts::stablecoin::{CsprUsd, CsprUsdInitArgs};
use cspr_cdp_contracts::token_adapter::{TokenAdapter, TokenAdapterInitArgs};
use cspr_cdp_contracts::treasury::{Treasury, TreasuryInitArgs};
use cspr_cdp_contracts::withdraw_queue::{WithdrawQueue, WithdrawQueueInitArgs};

fn main() {
    // Load environment from .env file
    dotenv::dotenv().ok();

    println!("=== CSPR-CDP Livenet Deployment ===");
    println!();

    // Initialize Odra livenet environment
    let env = odra_casper_livenet_env::env();

    // Configure payment amount for deployments/calls (required for Casper 2.0 txs)
    let payment_amount: u64 = std::env::var("ODRA_CASPER_LIVENET_PAYMENT_AMOUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000_000_000);
    env.set_gas(payment_amount);

    // Get deployer address
    let deployer = env.caller();
    println!("Deployer: {:?}", deployer);
    println!();

    // Protocol parameters
    let mcr_bps: u32 = 11000; // 110% MCR
    let min_debt = U256::from(2000u64) * U256::from(10u64).pow(U256::from(18u64)); // 2000 gUSD
    let borrowing_fee_bps: u32 = 50; // 0.5%
    let redemption_fee_bps: u32 = 50; // 0.5%
    let liquidation_penalty_bps: u32 = 1000; // 10%
    let interest_min_bps: u32 = 0;
    let interest_max_bps: u32 = 4000; // 40%

    // ==================== Phase 1: Independent Contracts ====================
    println!("=== Phase 1: Deploying Independent Contracts ===");
    println!();

    // 1. AccessControl
    println!("Deploying AccessControl...");
    let access_control = AccessControl::deploy(
        &env,
        AccessControlInitArgs {
            initial_admin: deployer,
        },
    );
    println!("AccessControl deployed at: {:?}", access_control.address().clone());

    // 2. Registry
    println!("Deploying Registry...");
    let mut registry = Registry::deploy(
        &env,
        RegistryInitArgs {
            admin: deployer.into(),
            mcr_bps,
            min_debt,
            borrowing_fee_bps,
            redemption_fee_bps,
            liquidation_penalty_bps,
            interest_min_bps,
            interest_max_bps,
        },
    );
    let registry_addr = registry.address().clone();
    println!("Registry deployed at: {:?}", registry_addr);

    // 3. ScsprYbToken (LST)
    println!("Deploying ScsprYbToken...");
    let mut scspr_ybtoken = ScsprYbToken::deploy(
        &env,
        ScsprYbTokenInitArgs {
            admin: deployer,
            operator: deployer,
        },
    );
    let scspr_ybtoken_addr = scspr_ybtoken.address().clone();
    println!("ScsprYbToken deployed at: {:?}", scspr_ybtoken_addr);

    println!();

    // ==================== Phase 2: Registry-dependent Contracts ====================
    println!("=== Phase 2: Deploying Registry-dependent Contracts ===");
    println!();

    // 4. WithdrawQueue
    println!("Deploying WithdrawQueue...");
    let withdraw_queue = WithdrawQueue::deploy(
        &env,
        WithdrawQueueInitArgs {
            ybtoken: scspr_ybtoken_addr,
            admin: deployer,
        },
    );
    println!("WithdrawQueue deployed at: {:?}", withdraw_queue.address().clone());

    // 5. Router
    println!("Deploying Router...");
    let router = Router::deploy(
        &env,
        RouterInitArgs {
            registry: registry_addr,
        },
    );
    let router_addr = router.address().clone();
    println!("Router deployed at: {:?}", router_addr);

    // 6. CsprUsd (Stablecoin)
    println!("Deploying CsprUsd (Stablecoin)...");
    let stablecoin = CsprUsd::deploy(
        &env,
        CsprUsdInitArgs {
            registry: registry_addr,
        },
    );
    let stablecoin_addr = stablecoin.address().clone();
    println!("CsprUsd deployed at: {:?}", stablecoin_addr);

    // 7. TokenAdapter
    println!("Deploying TokenAdapter...");
    let token_adapter = TokenAdapter::deploy(
        &env,
        TokenAdapterInitArgs {
            registry: registry_addr,
        },
    );
    println!("TokenAdapter deployed at: {:?}", token_adapter.address().clone());

    // 8. OracleAdapter
    println!("Deploying OracleAdapter...");
    let mut oracle = OracleAdapter::deploy(
        &env,
        OracleAdapterInitArgs {
            registry: registry_addr,
            router: router_addr,
        },
    );
    let oracle_addr = oracle.address().clone();
    println!("OracleAdapter deployed at: {:?}", oracle_addr);

    println!();

    // ==================== Phase 3: Branch Contracts ====================
    println!("=== Phase 3: Deploying Branch Contracts ===");
    println!();

    // 9. BranchCspr
    println!("Deploying BranchCspr...");
    let branch_cspr = BranchCspr::deploy(
        &env,
        BranchCsprInitArgs {
            registry: registry_addr,
            router: router_addr,
        },
    );
    let branch_cspr_addr = branch_cspr.address().clone();
    println!("BranchCspr deployed at: {:?}", branch_cspr_addr);

    // 10. BranchSCSPR (uses ScsprYbToken as the sCSPR token)
    println!("Deploying BranchSCSPR...");
    let branch_scspr = BranchSCSPR::deploy(
        &env,
        BranchSCSPRInitArgs {
            registry: registry_addr,
            router: router_addr,
            scspr_token: scspr_ybtoken_addr,
        },
    );
    let branch_scspr_addr = branch_scspr.address().clone();
    println!("BranchSCSPR deployed at: {:?}", branch_scspr_addr);

    // 11. Treasury
    println!("Deploying Treasury...");
    let treasury = Treasury::deploy(
        &env,
        TreasuryInitArgs {
            registry: registry_addr,
            stablecoin: stablecoin_addr,
        },
    );
    let treasury_addr = treasury.address().clone();
    println!("Treasury deployed at: {:?}", treasury_addr);

    println!();

    // ==================== Phase 4: Engines (with circular dependency) ====================
    println!("=== Phase 4: Deploying Engines ===");
    println!();

    // 12. LiquidationEngine (initially with router as placeholder for stability_pool)
    println!("Deploying LiquidationEngine...");
    let mut liquidation_engine = LiquidationEngine::deploy(
        &env,
        LiquidationEngineInitArgs {
            registry: registry_addr,
            router: router_addr,
            stability_pool: router_addr, // placeholder, will be updated later
            styks_oracle: oracle_addr, // Styks oracle address
        },
    );
    let liquidation_engine_addr = liquidation_engine.address().clone();
    println!("LiquidationEngine deployed at: {:?}", liquidation_engine_addr);

    // 13. StabilityPool
    println!("Deploying StabilityPool...");
    let mut stability_pool = StabilityPool::deploy(
        &env,
        StabilityPoolInitArgs {
            registry: registry_addr,
            router: router_addr,
            stablecoin: stablecoin_addr,
            liquidation_engine: liquidation_engine_addr,
        },
    );
    let stability_pool_addr = stability_pool.address().clone();
    println!("StabilityPool deployed at: {:?}", stability_pool_addr);

    // 14. RedemptionEngine
    println!("Deploying RedemptionEngine...");
    let redemption_engine = RedemptionEngine::deploy(
        &env,
        RedemptionEngineInitArgs {
            registry: registry_addr,
            router: router_addr,
            stablecoin: stablecoin_addr,
            treasury: treasury_addr,
            styks_oracle: oracle_addr, // Styks oracle address
        },
    );
    println!("RedemptionEngine deployed at: {:?}", redemption_engine.address().clone());

    println!();

    // ==================== Phase 5: Cross-contract Configuration ====================
    println!("=== Phase 5: Cross-contract Configuration ===");
    println!();

    // Fix circular dependency: update LiquidationEngine with real StabilityPool
    println!("Configuring LiquidationEngine -> StabilityPool link...");
    liquidation_engine.set_stability_pool(stability_pool_addr);
    println!("Done.");

    // Configure StabilityPool -> LiquidationEngine link (if needed)
    println!("Configuring StabilityPool -> LiquidationEngine link...");
    stability_pool.set_liquidation_engine(liquidation_engine_addr);
    println!("Done.");

    // Configure Registry with all contracts
    println!("Configuring Registry...");
    registry.set_router(router_addr);
    registry.set_stablecoin(stablecoin_addr);
    registry.set_treasury(treasury_addr);
    registry.set_oracle(oracle_addr);
    registry.set_stability_pool(stability_pool_addr);
    registry.set_liquidation_engine(liquidation_engine_addr);
    println!("Done.");

    // Register branches
    println!("Registering BranchCspr...");
    registry.register_branch_cspr(branch_cspr_addr, 9, mcr_bps); // CSPR has 9 decimals
    println!("Done.");

    println!("Registering BranchSCSPR...");
    registry.register_branch_scspr(branch_scspr_addr, scspr_ybtoken_addr, 9, mcr_bps);
    println!("Done.");

    // Configure ScsprYbToken -> WithdrawQueue link
    println!("Configuring ScsprYbToken -> WithdrawQueue link...");
    scspr_ybtoken.set_withdraw_queue(withdraw_queue.address().clone());
    println!("Done.");

    // Configure Oracle -> YbToken link for exchange rate
    println!("Configuring Oracle -> YbToken link...");
    oracle.set_scspr_ybtoken(scspr_ybtoken_addr);
    println!("Done.");

    println!();
    println!("=== Deployment Complete ===");
    println!();
    println!("Contract Addresses:");
    println!("  AccessControl:      {:?}", access_control.address().clone());
    println!("  Registry:           {:?}", registry_addr);
    println!("  Router:             {:?}", router_addr);
    println!("  CsprUsd:            {:?}", stablecoin_addr);
    println!("  Treasury:           {:?}", treasury_addr);
    println!("  OracleAdapter:      {:?}", oracle_addr);
    println!("  BranchCspr:         {:?}", branch_cspr_addr);
    println!("  BranchSCSPR:        {:?}", branch_scspr_addr);
    println!("  LiquidationEngine:  {:?}", liquidation_engine_addr);
    println!("  StabilityPool:      {:?}", stability_pool_addr);
    println!("  RedemptionEngine:   {:?}", redemption_engine.address().clone());
    println!("  TokenAdapter:       {:?}", token_adapter.address().clone());
    println!("  ScsprYbToken:       {:?}", scspr_ybtoken_addr);
    println!("  WithdrawQueue:      {:?}", withdraw_queue.address().clone());
}
