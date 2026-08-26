#![cfg(test)]

//! Tests for Issue #532 — governance-controlled oracle registry.
//!
//! Covers:
//! 1. Registry resolution priority: per-token override > feed-type default > legacy price_oracle.
//! 2. register_oracle / remove_oracle / register_token_oracle / remove_token_oracle CRUD.
//! 3. fund_invoice queries the registry-resolved oracle, not just the legacy field.
//! 4. Oracle health recording (staleness) after a query.

use super::*;
use crate::oracle_registry::OracleFeedType;
use crate::test::setup;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

/// Same shape as tests_oracle_freshness.rs's MockTimestampedOracle: returns
/// a stored `is_verified` + `timestamp` pair configurable per test.
#[contract]
struct MockRegistryOracle;

#[contractimpl]
impl MockRegistryOracle {
    pub fn interface_version(_env: Env) -> u32 {
        crate::oracle_interface::ORACLE_INTERFACE_VERSION
    }

    pub fn set_response(env: Env, verified: bool, ts: u32) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("verified"), &verified);
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("ts"), &ts);
    }

    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        let is_verified: bool = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("verified"))
            .unwrap_or(true);
        let ts: u32 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("ts"))
            .unwrap_or(env.ledger().sequence());
        OracleVerificationResponse {
            is_verified,
            timestamp: ts,
        }
    }
}

/// `set_price_oracle` / `set_max_oracle_age` are rate-limited
/// (`check_rate_limit`, cooldown = `DEFAULT_RATE_LIMIT_LEDGERS` = 120
/// ledgers). Since the last-call ledger defaults to 0 when never called,
/// and `setup()` starts the ledger at sequence 100, calling either of these
/// immediately after `setup()` incorrectly trips the cooldown on its very
/// first-ever call. Advance the ledger past the cooldown first — this is a
/// pre-existing rate-limiting quirk unrelated to Issue #532, worked around
/// here rather than fixed since fixing `check_rate_limit` is out of scope.
fn advance_past_rate_limit_cooldown(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 150;
    info.timestamp += 150 * 5;
    env.ledger().set(info);
}

/// Same shape as tests_access_control.rs's setup_env(): an env WITHOUT
/// mock_all_auths(), so require_auth() actually enforces the caller.
fn setup_env_no_mock_auths() -> (
    Env,
    Address,
    Address,
    InvoiceLiquidityContractClient<'static>,
) {
    let env = Env::default();
    let admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = usdc_contract.address();

    let xlm_admin = Address::generate(&env);
    let xlm_contract = env.register_stellar_asset_contract_v2(xlm_admin.clone());
    let xlm_address = xlm_contract.address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.initialize(&admin, &token_address, &token_address, &xlm_address);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    (env, admin, token_address, client)
}

fn deploy_mock_oracle(t: &crate::test::TestEnv, verified: bool, ts: u32) -> Address {
    let id = t.env.register_contract(None, MockRegistryOracle);
    let client = MockRegistryOracleClient::new(&t.env, &id);
    client.set_response(&verified, &ts);
    id
}

fn make_invoice(t: &crate::test::TestEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

// ── Registry CRUD ────────────────────────────────────────────────────────────

#[test]
fn test_no_oracle_registered_resolves_to_none() {
    let t = setup();
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_register_oracle_sets_feed_type_default() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle)
    );
}

#[test]
fn test_remove_oracle_clears_feed_type_default() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);
    t.contract.remove_oracle(&OracleFeedType::Identity);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_per_token_override_takes_priority_over_feed_type_default() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &token_oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(token_oracle)
    );
}

#[test]
fn test_remove_token_oracle_falls_back_to_feed_type_default() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &token_oracle);
    t.contract
        .remove_token_oracle(&OracleFeedType::Identity, &t.token.address);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(default_oracle)
    );
}

#[test]
fn test_legacy_price_oracle_used_as_fallback_for_identity_feed() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    // No registry entries at all — resolution falls through to the legacy field.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(legacy_oracle)
    );
}

#[test]
fn test_registry_default_takes_priority_over_legacy_price_oracle() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let registry_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract.set_price_oracle(&legacy_oracle);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &registry_oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(registry_oracle)
    );
}

#[test]
fn test_price_feed_type_has_no_legacy_fallback() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    // The legacy field is Identity-only; the Price feed type has nothing to
    // fall back to since it didn't exist pre-#532.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Price, &t.token.address),
        None
    );
}

// ── fund_invoice integration ─────────────────────────────────────────────────

#[test]
fn test_fund_invoice_uses_registry_resolved_oracle() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

#[test]
fn test_fund_invoice_rejects_unverified_payer_from_registry_oracle() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, false, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(res, Err(Ok(ContractError::PayerUnverified)));
}

// ── Oracle health monitoring ──────────────────────────────────────────────────

#[test]
fn test_oracle_health_unrecorded_before_first_query() {
    let t = setup();
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_oracle_health_recorded_as_fresh_after_successful_query() {
    let t = setup();
    let current_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, current_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    let health = t
        .contract
        .get_oracle_health(&OracleFeedType::Identity, &t.token.address)
        .unwrap();
    assert_eq!(health.oracle, oracle);
    assert!(!health.is_stale);
    assert_eq!(health.consecutive_stale_count, 0);
}

// Note: fund_invoice's health write for a REJECTED (stale/unverified) call
// does not persist — Soroban rolls back all storage writes made during an
// invocation that returns Err, health snapshot included. That's why the
// tests below use check_oracle_health (which never errors) to observe
// staleness, rather than asserting on state left behind by a failed
// fund_invoice call.

#[test]
fn test_check_oracle_health_detects_stale_data_without_erroring() {
    let t = setup();
    // Lower max_oracle_age so a small, TTL-safe ledger jump is enough to
    // trigger staleness (a 20_000-ledger jump would archive unrelated
    // storage entries in the test sandbox).
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(health.is_stale);
    assert_eq!(health.consecutive_stale_count, 1);

    // Confirm it's durable — a fresh read sees the same recorded snapshot.
    let reread = t
        .contract
        .get_oracle_health(&OracleFeedType::Identity, &t.token.address)
        .unwrap();
    assert_eq!(reread, health);
}

#[test]
fn test_check_oracle_health_consecutive_stale_count_increments() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let first = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(first.consecutive_stale_count, 1);

    let second = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(second.consecutive_stale_count, 2);
}

#[test]
fn test_check_oracle_health_resets_count_after_fresh_query() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let stale = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(stale.is_stale);
    assert_eq!(stale.consecutive_stale_count, 1);

    // Refresh the oracle's timestamp to the current ledger — next query is fresh.
    let fresh_ts = t.env.ledger().sequence();
    let oracle_client = MockRegistryOracleClient::new(&t.env, &oracle);
    oracle_client.set_response(&true, &fresh_ts);

    let fresh = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(!fresh.is_stale);
    assert_eq!(fresh.consecutive_stale_count, 0);
}

#[test]
fn test_check_oracle_health_returns_none_when_no_oracle_registered() {
    let t = setup();
    assert_eq!(
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer),
        None
    );
}

// ── Access control ────────────────────────────────────────────────────────────

#[test]
fn test_register_oracle_unauthorized_caller() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);
    let oracle = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_oracle",
            args: (OracleFeedType::Price, oracle.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_register_oracle(&OracleFeedType::Price, &oracle);
    assert!(
        res.is_err(),
        "register_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_register_token_oracle_unauthorized_caller() {
    let (env, _admin, token, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);
    let oracle = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_token_oracle",
            args: (OracleFeedType::Price, token.clone(), oracle.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_register_token_oracle(&OracleFeedType::Price, &token, &oracle);
    assert!(
        res.is_err(),
        "register_token_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_remove_oracle_unauthorized_caller() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();

    env.mock_all_auths();
    let oracle_id = env.register_contract(None, MockRegistryOracle);
    MockRegistryOracleClient::new(&env, &oracle_id).set_response(&true, &env.ledger().sequence());
    client.register_oracle(&OracleFeedType::Price, &oracle_id);

    let imposter = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "remove_oracle",
            args: (OracleFeedType::Price,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_remove_oracle(&OracleFeedType::Price);
    assert!(
        res.is_err(),
        "remove_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_register_oracle_accepts_compatible_interface_version() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let result = t
        .contract
        .try_register_oracle(&OracleFeedType::Identity, &oracle);
    assert!(result.is_ok(), "compatible oracle version must be accepted");
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle)
    );
}

#[contract]
struct IncompatibleVersionOracle;

#[contractimpl]
impl IncompatibleVersionOracle {
    pub fn interface_version(_env: Env) -> u32 {
        999
    }

    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: true,
            timestamp: env.ledger().sequence(),
        }
    }
}

#[test]
fn test_register_oracle_rejects_incompatible_interface_version() {
    let t = setup();
    let oracle = t.env.register_contract(None, IncompatibleVersionOracle);
    let result = t
        .contract
        .try_register_oracle(&OracleFeedType::Identity, &oracle);
    assert_eq!(
        result.err(),
        Some(Ok(ContractError::IncompatibleInterfaceVersion))
    );
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None,
        "incompatible oracle must not be persisted"
    );
}

// ── Cross-contract pause boundary ─────────────────────────────────────────────
//
// `pause()` only sets a flag read by the *invoice_liquidity* contract's own
// state-changing entry points (see the `is_paused` guards in `fund_invoice`,
// `submit_invoice`, etc. in lib.rs). It has no effect on:
//   1. This contract's own read-only oracle registry queries
//      (`get_oracle_for_token`, `get_oracle_health`, `check_oracle_health`) —
//      they're informational, carry no `is_paused` guard, and stay callable
//      by monitors/keepers throughout an incident.
//   2. The registry's admin/governance mutations (`register_oracle`,
//      `remove_oracle`, `register_token_oracle`, `remove_token_oracle`) —
//      these are gated by `require_admin` only, not `is_paused`, so
//      governance can still repoint or clear a compromised oracle while the
//      protocol is paused (arguably a requirement during an oracle-related
//      incident, not a gap).
//   3. The externally deployed oracle contracts themselves — they are
//      separate contracts with their own lifecycle, wholly outside this
//      contract's `Paused` flag.
// `fund_invoice` never observes any of this: it checks `is_paused` before
// doing anything else, so a paused call never reaches the oracle registry at
// all — it fails fast with `ContractPaused` and leaves no health record.

#[test]
fn test_get_oracle_for_token_readable_while_paused() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    t.contract.pause();

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle),
        "registry resolution is a read-only view and must work while paused"
    );
}

#[test]
fn test_check_oracle_health_readable_while_paused() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    t.contract.pause();

    // check_oracle_health performs a live cross-contract call to the oracle
    // and persists a health snapshot. Neither the call nor the write is
    // gated on `is_paused` — it must succeed exactly as it would unpaused.
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .expect("oracle health check must succeed while contract is paused");
    assert!(!health.is_stale);
    assert_eq!(health.oracle, oracle);

    // And the recorded snapshot is readable back, still while paused.
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        Some(health)
    );
}

#[test]
fn test_fund_invoice_paused_never_reaches_oracle_registry() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract.pause();

    // fund_invoice must fail fast on the pause guard, before it ever
    // resolves or queries the oracle registry — even with oracle
    // verification requested and a healthy oracle registered.
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

    // No health snapshot was ever recorded — proof the oracle was never
    // touched, rather than silently queried and its result discarded.
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        None,
        "a paused fund_invoice call must not query the oracle registry at all"
    );
}

#[test]
fn test_oracle_registry_mutations_unaffected_by_core_contract_pause() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract.pause();

    // Governance/admin oracle config changes are a different concern from
    // the core contract's operational pause and must go through unaffected.
    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract.register_token_oracle(
        &OracleFeedType::Identity,
        &t.token.address,
        &token_oracle,
    );
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(token_oracle)
    );

    t.contract
        .remove_token_oracle(&OracleFeedType::Identity, &t.token.address);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(default_oracle),
        "removing the per-token override must succeed while paused, falling back to the default"
    );

    t.contract.remove_oracle(&OracleFeedType::Identity);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None,
        "removing the feed-type default must succeed while paused"
    );
}
