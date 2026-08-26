//! Insurance pool interface (Issue #123).
//!
//! Defines the cross-contract surface for the default-protection insurance
//! pool. Liquidity providers (LPs) may *optionally* opt into the pool by paying
//! premiums; if an invoice they funded later defaults, the pool compensates
//! them out of the accumulated premium balance.
//!
//! This trait is intentionally minimal and design-forward. It is consumed by:
//!   * the [`InsurancePool`](crate::InsurancePool) stub contract in this crate,
//!     which provides a correct-but-simplified implementation, and
//!   * the main `invoice_liquidity` contract, which invokes
//!     [`claim`](InsurancePoolInterface::claim) from its default-handling path
//!     via the generated [`InsurancePoolInterfaceClient`].
//!
//! The full risk/pricing model (premium curves, coverage caps, payout
//! priority) is deliberately out of scope here and tracked as a follow-up.

use soroban_sdk::{contractclient, Address, Env};

/// Interface version expected by `invoice_liquidity` when configuring a pool.
/// Bump this (and the implementing contract) together on breaking changes.
pub const INSURANCE_INTERFACE_VERSION: u32 = 1;

/// The default-protection insurance pool interface.
///
/// A `#[contractclient]` is generated as `InsurancePoolInterfaceClient`,
/// allowing the liquidity contract to call into a deployed pool with a typed
/// client over just this interface. (The contract's own full client is
/// generated as `InsurancePoolClient` by `#[contractimpl]`.)
#[contractclient(name = "InsurancePoolInterfaceClient")]
pub trait InsurancePoolInterface {
    /// Returns [`INSURANCE_INTERFACE_VERSION`]. Callers should reject
    /// configuration of a pool that reports a different value.
    fn interface_version(env: Env) -> u32;

    /// Enroll `lp` into the insurance program so future defaults on invoices
    /// they fund become eligible for compensation. Requires `lp` auth.
    fn enroll(env: Env, lp: Address);

    /// Returns `true` when `lp` is currently enrolled in the program.
    fn is_enrolled(env: Env, lp: Address) -> bool;

    /// Record a premium payment of `amount` from `lp`, increasing the pool
    /// balance. Requires `lp` auth. Enrolls `lp` if not already enrolled.
    fn deposit_premium(env: Env, lp: Address, amount: i128);

    /// File a claim for the given defaulted `invoice_id` and compensate `lp`.
    /// Returns the compensation amount credited to the LP. Idempotent per
    /// invoice: a second claim for the same invoice is rejected.
    ///
    /// Requires admin auth, since in the integrated flow only the liquidity
    /// contract (acting as configured admin) reports a confirmed default.
    fn claim(env: Env, invoice_id: u64, lp: Address) -> i128;

    /// Current total balance held by the pool (sum of premiums minus payouts).
    fn get_pool_balance(env: Env) -> i128;
}
