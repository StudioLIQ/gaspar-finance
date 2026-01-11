//! Protocol error definitions.

use odra::prelude::*;

/// CDP protocol errors
#[repr(u16)]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CdpError {
    // Vault errors (1xx)
    VaultNotFound = 100,
    VaultAlreadyExists = 101,
    BelowMcr = 102,
    BelowMinDebt = 103,
    InsufficientCollateral = 104,
    InsufficientDebt = 105,
    RepayExceedsDebt = 106,

    // Oracle errors (2xx)
    OraclePriceUnavailable = 200,
    OraclePriceStale = 201,
    OraclePriceDeviation = 202,
    OracleInvalidRate = 203,
    OracleDecimalsMismatch = 204,
    OracleRateTooLow = 205,

    // Safe mode errors (3xx)
    SafeModeActive = 300,
    SafeModeAlreadyCleared = 301,

    // Access control errors (4xx)
    Unauthorized = 400,
    UnauthorizedProtocol = 401,

    // Token errors (5xx)
    TokenTransferFailed = 500,
    TokenApprovalFailed = 501,
    InsufficientTokenBalance = 502,

    // Stability pool errors (6xx)
    SpInsufficientDeposit = 600,
    SpNoGains = 601,

    // Liquidation errors (7xx)
    NotLiquidatable = 700,
    LiquidationInsufficientSp = 701,

    // Redemption errors (8xx)
    RedemptionNoEligibleVaults = 800,
    RedemptionAmountExceeds = 801,

    // Configuration errors (9xx)
    InvalidConfig = 900,
    InterestRateOutOfBounds = 901,
    UnsupportedCollateral = 902,

    // LST errors (10xx)
    LstRequestNotFound = 1000,
    LstCooldownActive = 1001,
    LstAlreadyClaimed = 1002,
    LstInsufficientClaimable = 1003,
    LstMaxRequestsExceeded = 1004,
    LstInvalidRate = 1005,
    LstDepositsPaused = 1006,
    LstWithdrawalsPaused = 1007,
}

impl CdpError {
    pub const fn message(&self) -> &'static str {
        match self {
            // Vault
            CdpError::VaultNotFound => "Vault not found",
            CdpError::VaultAlreadyExists => "Vault already exists for this owner",
            CdpError::BelowMcr => "Below minimum collateralization ratio",
            CdpError::BelowMinDebt => "Below minimum debt",
            CdpError::InsufficientCollateral => "Insufficient collateral",
            CdpError::InsufficientDebt => "Insufficient debt to repay",
            CdpError::RepayExceedsDebt => "Repay amount exceeds vault debt",

            // Oracle
            CdpError::OraclePriceUnavailable => "Oracle price unavailable",
            CdpError::OraclePriceStale => "Oracle price stale",
            CdpError::OraclePriceDeviation => "Oracle price deviation",
            CdpError::OracleInvalidRate => "Oracle invalid rate",
            CdpError::OracleDecimalsMismatch => "Oracle decimals mismatch",
            CdpError::OracleRateTooLow => "Oracle rate too low or zero",

            // Safe mode
            CdpError::SafeModeActive => "Operation blocked: safe mode active",
            CdpError::SafeModeAlreadyCleared => "Safe mode already cleared",

            // Access control
            CdpError::Unauthorized => "Unauthorized: caller is not admin",
            CdpError::UnauthorizedProtocol => "Unauthorized: caller is not protocol contract",

            // Token
            CdpError::TokenTransferFailed => "Token transfer failed",
            CdpError::TokenApprovalFailed => "Token approval failed",
            CdpError::InsufficientTokenBalance => "Insufficient token balance",

            // Stability pool
            CdpError::SpInsufficientDeposit => "Stability pool: insufficient deposit",
            CdpError::SpNoGains => "Stability pool: no gains to claim",

            // Liquidation
            CdpError::NotLiquidatable => "Vault is not liquidatable",
            CdpError::LiquidationInsufficientSp => "Liquidation: insufficient SP funds",

            // Redemption
            CdpError::RedemptionNoEligibleVaults => "Redemption: no eligible vaults",
            CdpError::RedemptionAmountExceeds => "Redemption: amount exceeds available",

            // Config
            CdpError::InvalidConfig => "Invalid configuration parameter",
            CdpError::InterestRateOutOfBounds => "Interest rate out of bounds",
            CdpError::UnsupportedCollateral => "Collateral not supported",

            // LST
            CdpError::LstRequestNotFound => "LST: withdrawal request not found",
            CdpError::LstCooldownActive => "LST: withdrawal still in cooldown",
            CdpError::LstAlreadyClaimed => "LST: withdrawal already claimed",
            CdpError::LstInsufficientClaimable => "LST: insufficient claimable assets",
            CdpError::LstMaxRequestsExceeded => "LST: max requests exceeded",
            CdpError::LstInvalidRate => "LST: invalid rate (zero or overflow)",
            CdpError::LstDepositsPaused => "LST: deposits paused",
            CdpError::LstWithdrawalsPaused => "LST: withdrawals paused",
        }
    }
}

impl core::fmt::Display for CdpError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<CdpError> for OdraError {
    fn from(error: CdpError) -> Self {
        #[cfg(target_arch = "wasm32")]
        {
            OdraError::user(error as u16)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            OdraError::user(error as u16, error.message())
        }
    }
}
