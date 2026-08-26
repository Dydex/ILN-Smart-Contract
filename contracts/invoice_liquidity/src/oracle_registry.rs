//! Governance-controlled oracle registry (Issue #532).
//!
//! Before this, the contract had a single `Config.price_oracle` field used
//! for payer identity/creditworthiness verification in `fund_invoice`. That
//! doesn't scale to a protocol that wants multiple *kinds* of oracle data
//! (price feeds, identity verification, credit scoring) or different oracle
//! providers per token (e.g. a USDC price feed vs an XLM price feed).
//!
//! This module adds a registry keyed by `OracleFeedType`, with an optional
//! per-token override on top of a feed-type-wide default. Resolution order
//! (see `resolve_oracle`):
//!   1. Per-token override for this feed type, if registered.
//!   2. Feed-type-wide default, if registered.
//!   3. The legacy `Config.price_oracle` field (kept for backwards
//!      compatibility with contracts/tests that only ever called
//!      `set_price_oracle`).
//!
//! Registration is governance-controlled the same way `update_fee_rate` /
//! `add_token` are: gated by `require_admin`, with governance driving it via
//! a cross-contract proposal execution where the ILN contract's stored admin
//! is the governance contract's own address.

use soroban_sdk::{contracttype, vec, Address, Env, IntoVal, Symbol};

use crate::access::require_admin;
use crate::errors::ContractError;
use crate::events::{OracleHealthRecorded, OracleRegistered, OracleUnregistered};
use crate::oracle_interface::{OracleClient, ORACLE_INTERFACE_VERSION};
use crate::storage::DataKey;
use crate::OracleVerificationResponse;

/// The kind of off-chain data an oracle provides.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleFeedType {
    /// Token/asset price feed (e.g. for USD normalisation).
    Price,
    /// Payer identity verification (the pre-#532 `price_oracle` use case).
    Identity,
    /// Payer creditworthiness / credit scoring.
    Credit,
}

/// Point-in-time health snapshot for an oracle, recorded whenever
/// `fund_invoice` (or another caller) queries it. There is no network
/// latency to measure on-chain — "response time" here means data
/// staleness: how many ledgers old the oracle's returned timestamp was
/// at query time.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleHealthStatus {
    pub oracle: Address,
    /// Ledger sequence at which this snapshot was recorded.
    pub last_checked_ledger: u32,
    /// The `timestamp` field the oracle returned in its response.
    pub last_data_timestamp: u32,
    /// `last_checked_ledger - last_data_timestamp`, i.e. how stale the data
    /// was at query time.
    pub last_data_age_ledgers: u64,
    /// Whether `last_data_age_ledgers` exceeded the configured max age.
    pub is_stale: bool,
    /// Number of consecutive queries (across calls) that returned stale
    /// data. Resets to 0 on a fresh (non-stale) response.
    pub consecutive_stale_count: u32,
}

/// Register (or update) the default oracle for `feed_type`. Applies to every
/// token that doesn't have a more specific per-token override.
///
/// Access: Admin only (in production, the ILN contract's stored admin is set
/// to the governance contract's address, so this is effectively
/// governance-controlled via a proposal).
///
/// Rejects oracles that do not report a compatible [`ORACLE_INTERFACE_VERSION`].
pub fn register_oracle(
    env: &Env,
    feed_type: OracleFeedType,
    oracle: Address,
) -> Result<(), ContractError> {
    require_admin(env)?;
    let version = verify_oracle_interface_version(env, &oracle)?;
    env.storage()
        .instance()
        .set(&DataKey::OracleRegistry(feed_type), &oracle);
    crate::storage::set_oracle_interface_version(env, feed_type, version);
    env.events().publish(
        (
            soroban_sdk::Symbol::new(env, "oracle_registered"),
            feed_type,
        ),
        OracleRegistered {
            feed_type,
            token: None,
            oracle,
        },
    );
    Ok(())
}

/// Remove the default oracle for `feed_type`. Per-token overrides for that
/// feed type, if any, are untouched.
///
/// Access: Admin only.
pub fn remove_oracle(env: &Env, feed_type: OracleFeedType) -> Result<(), ContractError> {
    require_admin(env)?;
    env.storage()
        .instance()
        .remove(&DataKey::OracleRegistry(feed_type));
    env.events().publish(
        (soroban_sdk::Symbol::new(env, "oracle_removed"), feed_type),
        OracleUnregistered {
            feed_type,
            token: None,
        },
    );
    Ok(())
}

/// Register (or update) a per-token override oracle for `feed_type`. Takes
/// priority over the feed-type-wide default when resolving the oracle for
/// this exact token.
///
/// Access: Admin only.
///
/// Rejects oracles that do not report a compatible [`ORACLE_INTERFACE_VERSION`].
pub fn register_token_oracle(
    env: &Env,
    feed_type: OracleFeedType,
    token: Address,
    oracle: Address,
) -> Result<(), ContractError> {
    require_admin(env)?;
    let version = verify_oracle_interface_version(env, &oracle)?;
    env.storage()
        .persistent()
        .set(&DataKey::TokenOracle(feed_type, token.clone()), &oracle);
    crate::storage::set_oracle_interface_version(env, feed_type, version);
    env.events().publish(
        (
            soroban_sdk::Symbol::new(env, "oracle_registered"),
            feed_type,
        ),
        OracleRegistered {
            feed_type,
            token: Some(token),
            oracle,
        },
    );
    Ok(())
}

/// Remove a per-token override oracle for `feed_type`. The feed-type-wide
/// default (if any) then applies again for this token.
///
/// Access: Admin only.
pub fn remove_token_oracle(
    env: &Env,
    feed_type: OracleFeedType,
    token: Address,
) -> Result<(), ContractError> {
    require_admin(env)?;
    env.storage()
        .persistent()
        .remove(&DataKey::TokenOracle(feed_type, token.clone()));
    env.events().publish(
        (soroban_sdk::Symbol::new(env, "oracle_removed"), feed_type),
        OracleUnregistered {
            feed_type,
            token: Some(token),
        },
    );
    Ok(())
}

/// Resolve the oracle address to query for `feed_type` + `token`, in
/// priority order: per-token override, then feed-type default, then (for
/// `Identity` only) the legacy `Config.price_oracle` field.
pub fn resolve_oracle(env: &Env, feed_type: OracleFeedType, token: &Address) -> Option<Address> {
    if let Some(addr) = env
        .storage()
        .persistent()
        .get(&DataKey::TokenOracle(feed_type, token.clone()))
    {
        return Some(addr);
    }
    if let Some(addr) = env
        .storage()
        .instance()
        .get(&DataKey::OracleRegistry(feed_type))
    {
        return Some(addr);
    }
    if feed_type == OracleFeedType::Identity {
        return crate::storage::get_config(env).and_then(|c| c.price_oracle);
    }
    None
}

/// Public getter mirroring `resolve_oracle`, for external callers / SDK.
pub fn get_oracle_for_token(
    env: Env,
    feed_type: OracleFeedType,
    token: Address,
) -> Option<Address> {
    resolve_oracle(&env, feed_type, &token)
}

/// Record a health snapshot for the oracle that served `feed_type` + `token`
/// at the current ledger, given the data timestamp it returned and the max
/// age threshold that was applied.
///
/// Note: Soroban rolls back ALL storage writes made during an invocation
/// that returns `Err` (there is no partial commit) — so a health snapshot
/// written here is only durable if the *overall* call that invoked this
/// function goes on to return `Ok`. `fund_invoice` calls this before its own
/// staleness check, so health IS recorded whenever funding succeeds, but a
/// rejected (stale/unverified) `fund_invoice` call rolls its health write
/// back along with everything else. For monitoring that must observe
/// staleness even when funding would be rejected, use
/// `check_oracle_health` instead, which never errors.
pub fn record_oracle_health(
    env: &Env,
    feed_type: OracleFeedType,
    token: &Address,
    oracle: &Address,
    data_timestamp: u32,
    max_age_ledgers: u64,
) {
    let current_ledger = env.ledger().sequence();
    let age = (current_ledger as u64).saturating_sub(data_timestamp as u64);
    let is_stale = max_age_ledgers > 0 && age >= max_age_ledgers;

    let key = DataKey::OracleHealth(feed_type, token.clone());
    let previous: Option<OracleHealthStatus> = env.storage().persistent().get(&key);
    let consecutive_stale_count = match previous {
        Some(prev) if is_stale => prev.consecutive_stale_count.saturating_add(1),
        _ if is_stale => 1,
        _ => 0,
    };

    let status = OracleHealthStatus {
        oracle: oracle.clone(),
        last_checked_ledger: current_ledger,
        last_data_timestamp: data_timestamp,
        last_data_age_ledgers: age,
        is_stale,
        consecutive_stale_count,
    };
    env.storage().persistent().set(&key, &status);

    env.events().publish(
        (
            soroban_sdk::Symbol::new(env, "oracle_health_recorded"),
            feed_type,
        ),
        OracleHealthRecorded {
            feed_type,
            token: token.clone(),
            is_stale,
            last_data_age_ledgers: age,
            consecutive_stale_count,
        },
    );
}

/// Public getter for the last recorded health snapshot of `feed_type` +
/// `token`. `None` if never queried.
pub fn get_oracle_health(
    env: Env,
    feed_type: OracleFeedType,
    token: Address,
) -> Option<OracleHealthStatus> {
    env.storage()
        .persistent()
        .get(&DataKey::OracleHealth(feed_type, token))
}

/// Actively query the oracle resolved for `feed_type` + `token` (for
/// `payer`'s record) and record + return its current health status.
///
/// Unlike `fund_invoice`'s inline oracle check, this NEVER errors on
/// stale/unverified data — it just reports the observation — so the write
/// always commits. This is the entrypoint off-chain monitors/keepers
/// should poll to track oracle staleness over time, independent of (and
/// without needing to trigger or revert) any funding activity.
///
/// Returns `None` if no oracle resolves for this `feed_type` + `token`.
pub fn check_oracle_health(
    env: Env,
    feed_type: OracleFeedType,
    token: Address,
    payer: Address,
) -> Option<OracleHealthStatus> {
    let oracle_addr = resolve_oracle(&env, feed_type, &token)?;
    let response: OracleVerificationResponse = env.invoke_contract(
        &oracle_addr,
        &Symbol::new(&env, "get_payer_data"),
        vec![&env, payer.into_val(&env)],
    );
    let max_age = crate::storage::get_config(&env)
        .map(|c| c.max_oracle_age_ledgers)
        .unwrap_or(crate::DEFAULT_MAX_ORACLE_AGE_LEDGERS);
    record_oracle_health(
        &env,
        feed_type,
        &token,
        &oracle_addr,
        response.timestamp,
        max_age,
    );
    env.storage()
        .persistent()
        .get(&DataKey::OracleHealth(feed_type, token))
}

/// Query `oracle.interface_version()` and reject incompatible / missing
/// implementations before persisting a registry entry.
fn verify_oracle_interface_version(env: &Env, oracle: &Address) -> Result<u32, ContractError> {
    let client = OracleClient::new(env, oracle);
    let version = match client.try_interface_version() {
        Ok(Ok(v)) => v,
        _ => return Err(ContractError::IncompatibleInterfaceVersion),
    };
    if version != ORACLE_INTERFACE_VERSION {
        return Err(ContractError::IncompatibleInterfaceVersion);
    }
    Ok(version)
}
