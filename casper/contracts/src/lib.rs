//! CSPR-CDP Contracts
//!
//! Casper-native LiquityV2-style CDP protocol implementation.
//!
//! ## Architecture
//!
//! - **Router**: Dispatches operations by collateral type to branches
//! - **Branch (CSPR)**: Vault logic for native CSPR collateral
//! - **Branch (stCSPR)**: Vault logic for stCSPR (CEP-18) collateral
//! - **Stablecoin (gUSD)**: Protocol stablecoin with mint/burn access control
//! - **Treasury**: Fee collection and distribution
//! - **OracleAdapter**: Styks/Odra oracle with composite pricing for stCSPR
//! - **StabilityPool**: Bad debt absorption and collateral gain distribution
//! - **LiquidationEngine**: Under-collateralized vault liquidation
//! - **RedemptionEngine**: gUSD redemption for collateral
//!
//! ## Safe Mode (Circuit Breaker)
//!
//! When oracle status is not OK, the protocol enters safe_mode (ADR-001):
//! - Allowed: repay, add collateral, SP deposit
//! - Blocked: open/borrow, withdraw, liquidation, redemption, SP withdraw

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
extern crate alloc;

// Re-export odra for downstream usage
pub use odra;

// Core module declarations
pub mod types;
pub mod errors;
pub mod interfaces;
pub mod interest;
pub mod styks_oracle;

// Contract modules
pub mod registry;
pub mod router;
pub mod branch_cspr;
pub mod branch_scspr;
pub mod stablecoin;
pub mod treasury;
pub mod oracle_adapter;
pub mod liquidation_engine;
pub mod stability_pool;
pub mod redemption_engine;
pub mod token_adapter;
pub mod access_control;

// LST (Liquid Staking Token) modules
pub mod scspr_ybtoken;
pub mod withdraw_queue;
