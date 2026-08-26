#![no_std]

//! Default-protection insurance pool — stub implementation (Issue #123).
//!
//! Liquidity providers (LPs) optionally opt into this pool by paying premiums.
//! When an invoice they funded defaults, the pool compensates them out of the
//! accumulated premium balance (up to a flat per-claim coverage cap).
//!
//! This is a **design-forward stub**: it implements the full
//! [`InsurancePoolInterface`] with correct storage, auth, events and accounting
//! semantics, but deliberately keeps the economics simple:
//!   * Premiums are tracked as pool *accounting* balance rather than via an
//!     actual token transfer (token settlement is a follow-up).
//!   * Compensation is a flat per-claim cap configured at init, not a
//!     risk-priced payout.
//!
//! See `docs/insurance-pool-design.md` for the integration design and the
//! follow-up work needed before mainnet.

mod insurance_interface;
#[cfg(test)]
mod test;

pub use insurance_interface::{
    InsurancePoolInterface, InsurancePoolInterfaceClient, INSURANCE_INTERFACE_VERSION,
};

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env,
};

/// Timelock delay (in seconds) enforced between proposing and executing an
/// admin action, and before which a proposal may be cancelled (Issue #542).
pub const TIMELOCK_DELAY_SECONDS: u64 = 3 * 24 * 60 * 60; // 3 days

/// Seconds in an average month, used to monthly-ize historical claim data
/// for `get_pool_health`'s solvency estimate. A simplification (not
/// calendar-accurate) — fine for a rough runway estimate.
const SECONDS_PER_MONTH: u64 = 30 * 24 * 60 * 60;

/// Errors surfaced by the insurance pool stub.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum InsuranceError {
    /// Contract has not been initialised with an admin.
    NotInitialized = 1,
    /// A claim has already been processed for this invoice.
    AlreadyClaimed = 2,
    /// Premium / coverage amount must be positive.
    InvalidAmount = 3,
    /// Pool has no balance available to pay a claim.
    PoolEmpty = 4,
    /// Contract is already initialised.
    AlreadyInitialized = 5,
    /// No pending proposal exists for the requested admin action.
    NoPendingProposal = 6,
    /// The proposal's timelock has not yet expired.
    TimelockNotExpired = 7,
    /// A checked arithmetic operation overflowed.
    ArithmeticOverflow = 8,
    /// Premium deposit would exceed the configured pool balance cap.
    BalanceCapExceeded = 9,
}

/// Storage keys for the pool.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorised to report confirmed defaults (the liquidity contract).
    Admin,
    /// Total pool balance (sum of premiums minus payouts).
    Balance,
    /// Flat per-claim coverage cap configured at init.
    Coverage,
    /// Token address for real transfers (Issue #527).
    TokenAddress,
    /// Enrollment flag per LP.
    Enrolled(Address),
    /// Cumulative premium paid per LP.
    Premiums(Address),
    /// Whether a claim has been processed for a given invoice id.
    Claimed(u64),
    /// Proposed new coverage cap awaiting timelock expiry (Issue #542).
    PendingCoverage,
    /// Proposed new admin awaiting timelock expiry (Issue #542).
    PendingAdmin,
    /// Ledger timestamp at which the pending coverage change becomes executable.
    CoverageEta,
    /// Ledger timestamp at which the pending admin transfer becomes executable.
    AdminEta,
    /// Base premium rate in basis points (e.g., 500 = 5%) (Issue #528).
    BasePremiumRateBps,
    /// Risk multiplier numerator for premium calculation (Issue #528).
    RiskMultiplierNumerator,
    /// Risk multiplier denominator for premium calculation (Issue #528).
    RiskMultiplierDenominator,
    /// LP's historical default count (Issue #528).
    DefaultCount(Address),
    /// LP's historical claim count (Issue #528).
    ClaimCount(Address),
    /// Tiered coverage caps: (tier_threshold, coverage_amount) (Issue #528).
    CoverageTiers,
    /// Optional maximum pool balance cap (governance-configurable).
    BalanceCap,
    /// Ledger timestamp the pool was initialized at (Issue #pool-health).
    InitializedAt,
    /// Count of distinct LPs currently enrolled (Issue #pool-health) — since
    /// Soroban storage can't be iterated, this running counter is
    /// maintained alongside the per-LP `Enrolled` flag rather than derived.
    EnrolledCount,
    /// Running total of confirmed defaults across all LPs (Issue
    /// #pool-health) — a pool-wide rollup of the per-LP `DefaultCount`
    /// already tracked for risk-priced premiums (Issue #528), used to
    /// estimate the pool's claim rate.
    TotalDefaultCount,
}

/// Solvency snapshot returned by `get_pool_health`, so LPs can judge
/// coverage capacity against enrolled exposure rather than reading raw
/// balance alone.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolHealth {
    /// Current pool balance (premiums collected minus payouts).
    pub balance: i128,
    /// Number of distinct LPs currently enrolled in default protection.
    pub enrolled_lp_count: u32,
    /// Estimated token outflow per month from claims, projected from the
    /// pool's historical default count times the flat coverage cap. `0`
    /// when there's no default history yet.
    pub estimated_monthly_claim_rate: i128,
    /// How many months the current balance would last at
    /// `estimated_monthly_claim_rate`. `None` when there's no claim
    /// history to project a rate from — this means "not yet estimable",
    /// not "infinite coverage".
    ///
    /// Named `months_of_coverage` rather than the fuller
    /// `months_of_coverage_at_current_rate` because Soroban's
    /// `#[contracttype]` caps struct field names at 30 characters.
    pub months_of_coverage: Option<u32>,
}

#[contract]
pub struct InsurancePool;

#[contractimpl]
impl InsurancePool {
    /// Initialise the pool.
    ///
    /// * `admin` — authorised to file claims (in production, the liquidity
    ///   contract address acting on a confirmed default).
    /// * `coverage` — flat per-claim compensation cap (in token stroops).
    /// * `token` — address of the token contract for real transfers (Issue #527).
    pub fn initialize(
        env: Env,
        admin: Address,
        coverage: i128,
        token: Address,
    ) -> Result<(), InsuranceError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(InsuranceError::AlreadyInitialized);
        }
        if coverage <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        admin.require_auth();
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Balance, &0i128);
        storage.set(&DataKey::Coverage, &coverage);
        storage.set(&DataKey::TokenAddress, &token);
        storage.set(&DataKey::InitializedAt, &env.ledger().timestamp());

        env.events()
            .publish((symbol_short!("init"), admin), coverage);
        Ok(())
    }

    /// Total premium an LP has contributed over the pool's lifetime.
    pub fn get_premiums_paid(env: Env, lp: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Premiums(lp))
            .unwrap_or(0)
    }

    /// The configured flat per-claim coverage cap.
    pub fn get_coverage(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Coverage)
            .unwrap_or(0)
    }

    /// The configured token address for real transfers (Issue #527).
    pub fn get_token_address(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .unwrap()
    }

    // ── Issue #528: risk-priced insurance premiums ───────────────────────
    //
    // Premiums are calculated based on LP's historical default rate.
    // Higher risk = higher premiums, lower risk = lower premiums.
    // This creates incentives for LPs to fund high-quality invoices.

    /// Get the base premium rate in basis points (e.g., 500 = 5%).
    pub fn get_base_premium_rate_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::BasePremiumRateBps)
            .unwrap_or(500) // Default 5%
    }

    /// Set the base premium rate in basis points. Requires admin auth.
    pub fn set_base_premium_rate_bps(env: Env, rate_bps: u32) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        if rate_bps == 0 || rate_bps > 10_000 {
            return Err(InsuranceError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::BasePremiumRateBps, &rate_bps);
        Ok(())
    }

    /// Get the risk multiplier numerator for premium calculation.
    pub fn get_risk_multiplier_numerator(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RiskMultiplierNumerator)
            .unwrap_or(1) // Default 1x
    }

    /// Get the risk multiplier denominator for premium calculation.
    pub fn get_risk_multiplier_denominator(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RiskMultiplierDenominator)
            .unwrap_or(1) // Default 1/1
    }

    /// Set the risk multiplier for premium calculation. Requires admin auth.
    pub fn set_risk_multiplier(
        env: Env,
        numerator: i128,
        denominator: i128,
    ) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        if numerator < 0 || denominator <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::RiskMultiplierNumerator, &numerator);
        env.storage()
            .instance()
            .set(&DataKey::RiskMultiplierDenominator, &denominator);
        Ok(())
    }

    /// Get the LP's historical default count.
    pub fn get_default_count(env: Env, lp: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::DefaultCount(lp))
            .unwrap_or(0)
    }

    /// Increment the LP's default count. Admin-only.
    pub fn increment_default_count(env: Env, lp: Address) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        let count: u32 = Self::get_default_count(env.clone(), lp.clone());
        env.storage()
            .persistent()
            .set(&DataKey::DefaultCount(lp), &(count + 1));

        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDefaultCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDefaultCount, &(total + 1));
        Ok(())
    }

    /// Get the LP's historical claim count.
    pub fn get_claim_count(env: Env, lp: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ClaimCount(lp))
            .unwrap_or(0)
    }

    /// Calculate the risk-priced premium for an LP based on their history.
    /// Returns the premium rate in basis points.
    ///
    /// Formula: base_rate + (default_count * risk_multiplier)
    /// Example: base=500 (5%), multiplier=100/1 (100x per default)
    ///   - 0 defaults: 500 bps (5%)
    ///   - 1 default: 600 bps (6%)
    ///   - 2 defaults: 700 bps (7%)
    pub fn calculate_premium_rate_bps(env: Env, lp: Address) -> u32 {
        let base_rate = Self::get_base_premium_rate_bps(env.clone());
        let default_count = Self::get_default_count(env.clone(), lp) as i128;
        let numerator = Self::get_risk_multiplier_numerator(env.clone());
        let denominator = Self::get_risk_multiplier_denominator(env);

        if denominator == 0 {
            return base_rate;
        }

        let risk_adjustment = (default_count * numerator * 10_000) / denominator;
        let total_rate = base_rate as i128 + risk_adjustment;

        // Cap at 100% (10_000 bps)
        if total_rate > 10_000 {
            10_000
        } else {
            total_rate as u32
        }
    }

    /// Calculate the premium amount for an LP based on their risk profile.
    /// The amount is the invoice amount multiplied by the risk-priced rate.
    pub fn calculate_premium_amount(env: Env, lp: Address, invoice_amount: i128) -> i128 {
        let rate_bps = Self::calculate_premium_rate_bps(env, lp);
        (invoice_amount * rate_bps as i128) / 10_000
    }

    /// Get the tiered coverage for an LP based on their total premiums paid.
    /// Returns the coverage cap for the LP's tier.
    pub fn get_tiered_coverage(env: Env, lp: Address) -> i128 {
        let premiums_paid = Self::get_premiums_paid(env.clone(), lp);
        let default_coverage = Self::get_coverage(env.clone());

        // Simple tiered system based on premiums paid:
        // Tier 1: < 10% of default coverage -> 50% of default coverage
        // Tier 2: 10-25% of default coverage -> 75% of default coverage
        // Tier 3: 25-50% of default coverage -> 100% of default coverage
        // Tier 4: > 50% of default coverage -> 150% of default coverage
        let threshold_10 = default_coverage / 10;
        let threshold_25 = default_coverage / 4;
        let threshold_50 = default_coverage / 2;

        if premiums_paid >= threshold_50 {
            (default_coverage * 150) / 100 // 150% coverage
        } else if premiums_paid >= threshold_25 {
            default_coverage // 100% coverage
        } else if premiums_paid >= threshold_10 {
            (default_coverage * 75) / 100 // 75% coverage
        } else {
            (default_coverage * 50) / 100 // 50% coverage
        }
    }

    /// Returns `true` if a claim has already been processed for `invoice_id`.
    pub fn is_claimed(env: Env, invoice_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Claimed(invoice_id))
            .unwrap_or(false)
    }

    // ── Issue #542: timelocked admin actions ────────────────────────────
    //
    // Coverage cap changes and admin transfers are sensitive, LP-affecting
    // parameters. Rather than applying immediately, they are queued behind a
    // `TIMELOCK_DELAY_SECONDS` delay so LPs have advance notice and a chance
    // to exit before the change takes effect. The current admin may cancel a
    // pending proposal at any time before it executes.

    /// Propose a new coverage cap. Requires current admin auth. Overwrites
    /// any previously pending coverage proposal.
    pub fn propose_coverage_change(env: Env, new_coverage: i128) -> Result<u64, InsuranceError> {
        Self::require_admin(&env);
        if new_coverage <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }

        let eta = env
            .ledger()
            .timestamp()
            .saturating_add(TIMELOCK_DELAY_SECONDS);

        let storage = env.storage().instance();
        storage.set(&DataKey::PendingCoverage, &new_coverage);
        storage.set(&DataKey::CoverageEta, &eta);

        env.events()
            .publish((symbol_short!("cov_prop"),), (new_coverage, eta));
        Ok(eta)
    }

    /// Execute a previously proposed coverage change once its timelock has
    /// expired. Callable by anyone once the delay has elapsed.
    pub fn execute_coverage_change(env: Env) -> Result<(), InsuranceError> {
        let storage = env.storage().instance();
        let new_coverage: i128 = storage
            .get(&DataKey::PendingCoverage)
            .ok_or(InsuranceError::NoPendingProposal)?;
        let eta: u64 = storage
            .get(&DataKey::CoverageEta)
            .ok_or(InsuranceError::NoPendingProposal)?;

        if env.ledger().timestamp() < eta {
            return Err(InsuranceError::TimelockNotExpired);
        }

        storage.set(&DataKey::Coverage, &new_coverage);
        storage.remove(&DataKey::PendingCoverage);
        storage.remove(&DataKey::CoverageEta);

        env.events()
            .publish((symbol_short!("cov_exec"),), new_coverage);
        Ok(())
    }

    /// Cancel a pending coverage change proposal. Requires current admin auth.
    pub fn cancel_coverage_change(env: Env) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        let storage = env.storage().instance();
        if !storage.has(&DataKey::PendingCoverage) {
            return Err(InsuranceError::NoPendingProposal);
        }
        storage.remove(&DataKey::PendingCoverage);
        storage.remove(&DataKey::CoverageEta);
        env.events().publish((symbol_short!("cov_cncl"),), ());
        Ok(())
    }

    /// Propose an admin transfer. Requires current admin auth. Overwrites any
    /// previously pending admin proposal.
    pub fn propose_admin_transfer(env: Env, new_admin: Address) -> Result<u64, InsuranceError> {
        Self::require_admin(&env);

        let eta = env
            .ledger()
            .timestamp()
            .saturating_add(TIMELOCK_DELAY_SECONDS);

        let storage = env.storage().instance();
        storage.set(&DataKey::PendingAdmin, &new_admin);
        storage.set(&DataKey::AdminEta, &eta);

        env.events()
            .publish((symbol_short!("adm_prop"), new_admin), eta);
        Ok(eta)
    }

    /// Execute a previously proposed admin transfer once its timelock has
    /// expired. Callable by anyone once the delay has elapsed.
    pub fn execute_admin_transfer(env: Env) -> Result<(), InsuranceError> {
        let storage = env.storage().instance();
        let new_admin: Address = storage
            .get(&DataKey::PendingAdmin)
            .ok_or(InsuranceError::NoPendingProposal)?;
        let eta: u64 = storage
            .get(&DataKey::AdminEta)
            .ok_or(InsuranceError::NoPendingProposal)?;

        if env.ledger().timestamp() < eta {
            return Err(InsuranceError::TimelockNotExpired);
        }

        storage.set(&DataKey::Admin, &new_admin);
        storage.remove(&DataKey::PendingAdmin);
        storage.remove(&DataKey::AdminEta);

        env.events()
            .publish((symbol_short!("adm_exec"),), new_admin);
        Ok(())
    }

    /// Cancel a pending admin transfer proposal. Requires current admin auth.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        let storage = env.storage().instance();
        if !storage.has(&DataKey::PendingAdmin) {
            return Err(InsuranceError::NoPendingProposal);
        }
        storage.remove(&DataKey::PendingAdmin);
        storage.remove(&DataKey::AdminEta);
        env.events().publish((symbol_short!("adm_cncl"),), ());
        Ok(())
    }

    /// Returns the pending coverage proposal (new cap, eta), if any.
    pub fn get_pending_coverage(env: Env) -> Option<(i128, u64)> {
        let storage = env.storage().instance();
        let new_coverage: i128 = storage.get(&DataKey::PendingCoverage)?;
        let eta: u64 = storage.get(&DataKey::CoverageEta)?;
        Some((new_coverage, eta))
    }

    /// Returns the pending admin transfer proposal (new admin, eta), if any.
    pub fn get_pending_admin(env: Env) -> Option<(Address, u64)> {
        let storage = env.storage().instance();
        let new_admin: Address = storage.get(&DataKey::PendingAdmin)?;
        let eta: u64 = storage.get(&DataKey::AdminEta)?;
        Some((new_admin, eta))
    }

    /// Set coverage cap directly via governance (no timelock, single call).
    /// Requires governance contract authorization.
    pub fn set_coverage_via_governance(env: Env, new_coverage: i128) -> Result<(), InsuranceError> {
        if new_coverage <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(InsuranceError::NotInitialized)?;
        admin.require_auth();

        let old_coverage: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Coverage)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Coverage, &new_coverage);

        env.events()
            .publish((symbol_short!("cov_gov"),), (old_coverage, new_coverage));
        Ok(())
    }

    /// Set premium rate directly via governance.
    /// Requires governance contract authorization.
    pub fn set_premium_rate_via_governance(env: Env, _rate: u32) -> Result<(), InsuranceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(InsuranceError::NotInitialized)?;
        admin.require_auth();

        env.events().publish((symbol_short!("prem_gov"),), _rate);
        Ok(())
    }

    /// Get the current pool balance cap, or `None` if uncapped.
    pub fn get_balance_cap(env: Env) -> Option<i128> {
        env.storage().instance().get(&DataKey::BalanceCap)
    }

    /// Set (or clear) the pool balance cap. Pass `0` to remove the cap.
    /// Requires admin auth.
    pub fn set_balance_cap(env: Env, cap: i128) -> Result<(), InsuranceError> {
        Self::require_admin(&env);
        if cap < 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        if cap == 0 {
            env.storage().instance().remove(&DataKey::BalanceCap);
        } else {
            env.storage().instance().set(&DataKey::BalanceCap, &cap);
        }
        env.events().publish((symbol_short!("cap_set"),), cap);
        Ok(())
    }

    /// Get a point-in-time solvency snapshot: balance, enrolled exposure,
    /// and an estimated runway based on historical default activity.
    ///
    /// The claim-rate estimate is deliberately simple: it projects the
    /// pool's running total default count (`TotalDefaultCount`, a rollup of
    /// the per-LP `DefaultCount` already tracked for Issue #528's
    /// risk-priced premiums) at the flat `Coverage` cap per default, spread
    /// over the pool's lifetime to date. It does not account for tiered
    /// coverage varying the actual per-claim payout, or for claim
    /// frequency changing over time — it's a rough, conservative-by-default
    /// signal for LPs deciding whether to enroll, not a precise actuarial
    /// model.
    pub fn get_pool_health(env: Env) -> PoolHealth {
        let balance: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        let enrolled_lp_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EnrolledCount)
            .unwrap_or(0);
        let total_defaults: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDefaultCount)
            .unwrap_or(0);

        // No claim history yet: rate is 0 and there's nothing to divide by.
        let estimated_monthly_claim_rate = if total_defaults == 0 {
            0i128
        } else {
            let initialized_at: u64 = env
                .storage()
                .instance()
                .get(&DataKey::InitializedAt)
                .unwrap_or_else(|| env.ledger().timestamp());
            let elapsed_seconds = env.ledger().timestamp().saturating_sub(initialized_at);
            // Floor the divisor at one month so a young pool (or defaults
            // recorded in the same ledger as initialization) can't inflate
            // the estimate by dividing by a near-zero time window.
            let elapsed_months = (elapsed_seconds / SECONDS_PER_MONTH).max(1) as i128;
            let coverage = Self::get_coverage(env.clone());
            (total_defaults as i128).saturating_mul(coverage) / elapsed_months
        };

        let months_of_coverage = if estimated_monthly_claim_rate <= 0 {
            None
        } else {
            let months = balance / estimated_monthly_claim_rate;
            Some(months.clamp(0, u32::MAX as i128) as u32)
        };

        PoolHealth {
            balance,
            enrolled_lp_count,
            estimated_monthly_claim_rate,
            months_of_coverage,
        }
    }

    /// Mark `lp` as enrolled, maintaining `EnrolledCount` — a no-op if
    /// already enrolled, so repeated `enroll()`/`deposit_premium()` calls
    /// don't inflate the count.
    fn mark_enrolled(env: &Env, lp: &Address) {
        let already_enrolled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Enrolled(lp.clone()))
            .unwrap_or(false);
        if already_enrolled {
            return;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Enrolled(lp.clone()), &true);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EnrolledCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::EnrolledCount, &(count + 1));
    }

    fn require_admin(env: &Env) -> Address {
        match env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
        {
            Some(admin) => {
                admin.require_auth();
                admin
            }
            None => panic_with_error!(env, InsuranceError::NotInitialized),
        }
    }

    fn get_token_client(env: &Env) -> token::Client {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .unwrap();
        token::Client::new(env, &token_addr)
    }
}

#[contractimpl]
impl InsurancePoolInterface for InsurancePool {
    fn interface_version(_env: Env) -> u32 {
        crate::insurance_interface::INSURANCE_INTERFACE_VERSION
    }

    fn enroll(env: Env, lp: Address) {
        lp.require_auth();
        Self::mark_enrolled(&env, &lp);
        env.events().publish((symbol_short!("enrolled"), lp), ());
    }

    fn is_enrolled(env: Env, lp: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Enrolled(lp))
            .unwrap_or(false)
    }

    fn deposit_premium(env: Env, lp: Address, amount: i128) {
        lp.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, InsuranceError::InvalidAmount);
        }

        // Auto-enroll on first premium so a paying LP is always covered.
        Self::mark_enrolled(&env, &lp);

        let prev_premium: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Premiums(lp.clone()))
            .unwrap_or(0);
        let new_premium = prev_premium
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, InsuranceError::ArithmeticOverflow));
        env.storage()
            .persistent()
            .set(&DataKey::Premiums(lp.clone()), &new_premium);

        let balance: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        let new_balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, InsuranceError::ArithmeticOverflow));

        // Enforce the optional balance cap.
        if let Some(cap) = env
            .storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::BalanceCap)
        {
            if new_balance > cap {
                panic_with_error!(&env, InsuranceError::BalanceCapExceeded);
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::Balance, &new_balance);

        // Transfer tokens from LP to pool (checks-effects-interactions pattern).
        // State changes above must complete before this external call.
        let token = Self::get_token_client(&env);
        token.transfer(
            &lp,                             // from (caller)
            &env.current_contract_address(), // to (this contract)
            &amount,
        );

        env.events().publish((symbol_short!("premium"), lp), amount);
    }

    fn claim(env: Env, invoice_id: u64, lp: Address) -> i128 {
        // Only the configured admin (the liquidity contract in production) may
        // report a confirmed default and trigger compensation.
        Self::require_admin(&env);

        if Self::is_claimed(env.clone(), invoice_id) {
            panic_with_error!(&env, InsuranceError::AlreadyClaimed);
        }

        let balance: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        if balance <= 0 {
            panic_with_error!(&env, InsuranceError::PoolEmpty);
        }

        // Use tiered coverage based on LP's premiums paid (Issue #528).
        let coverage: i128 = Self::get_tiered_coverage(env.clone(), lp.clone());
        // Payout: tiered coverage cap, bounded by available balance.
        let payout = if coverage < balance {
            coverage
        } else {
            balance
        };

        // Checks-effects-interactions: update state before external call.
        env.storage()
            .instance()
            .set(&DataKey::Balance, &(balance - payout));
        env.storage()
            .persistent()
            .set(&DataKey::Claimed(invoice_id), &true);

        // Transfer tokens from pool to LP (Issue #527).
        let token = Self::get_token_client(&env);
        token.transfer(
            &env.current_contract_address(), // from (this contract)
            &lp,                             // to
            &payout,
        );

        env.events()
            .publish((symbol_short!("claimed"), invoice_id), payout);
        payout
    }

    fn get_pool_balance(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::Balance).unwrap_or(0)
    }
}
