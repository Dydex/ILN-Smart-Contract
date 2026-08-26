#![cfg(test)]

//! Tests for issue #93 — oracle data freshness validation in fund_invoice().
//!
//! The freshness check compares the oracle's reported ledger sequence number
//! (OracleVerificationResponse.timestamp) against the current ledger sequence.
//! If current_ledger - oracle.timestamp >= max_oracle_age_ledgers the contract
//! returns ContractError::OracleDataStale.
//!
//! Scenarios covered:
//! 1. Fresh oracle (age = 0)                               → succeeds.
//! 2. Stale oracle (age > max_oracle_age_ledgers)          → OracleDataStale.
//! 3. Boundary: age = max_oracle_age_ledgers - 1           → succeeds (just inside).
//! 4. Boundary: age = max_oracle_age_ledgers               → OracleDataStale (exactly at limit).
//! 5. max_oracle_age_ledgers = 0 disables the check        → succeeds regardless of age.
//! 6. Governance can update max_oracle_age_ledgers          → new limit respected.
//! 7. Stale but require_oracle_verification=false           → succeeds (check skipped).

use super::*;
use crate::test::setup;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

// ----------------------------------------------------------------
// Configurable-timestamp oracle for boundary testing.
// The oracle stores an externally-set timestamp and returns it with
// every get_payer_data() call.  Tests control "data age" by setting
// the ledger sequence and then providing an older timestamp.
// ----------------------------------------------------------------
#[contract]
struct MockTimestampedOracle;

#[contractimpl]
impl MockTimestampedOracle {
    /// Initialise the oracle's stored timestamp.
    pub fn init(_env: Env, _timestamp: u32) {}

    /// Return verified=true with the timestamp that was passed at registration.
    /// In tests we use the args Vec to inject the timestamp value.
    pub fn interface_version(_env: Env) -> u32 {
        crate::oracle_interface::ORACLE_INTERFACE_VERSION
    }

    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        // Read the timestamp from instance storage (set via a helper below).
        let ts: u32 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("ts"))
            .unwrap_or(env.ledger().sequence());
        OracleVerificationResponse {
            is_verified: true,
            timestamp: ts,
        }
    }

    /// Admin helper: store the timestamp so get_payer_data() returns it.
    pub fn set_timestamp(env: Env, ts: u32) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("ts"), &ts);
    }
}

// ----------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------

/// Register a MockTimestampedOracle, pre-seed its timestamp, wire it into the
/// contract config, and return the oracle's contract address.
fn register_oracle_with_timestamp(t: &crate::test::TestEnv, oracle_ts: u32) -> Address {
    let oracle_id = t.env.register_contract(None, MockTimestampedOracle);
    let oracle_client = MockTimestampedOracleClient::new(&t.env, &oracle_id);
    oracle_client.set_timestamp(&oracle_ts);
    t.contract.set_price_oracle(&oracle_id).unwrap();
    oracle_id
}

fn make_invoice(t: &crate::test::TestEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    t.contract
        .submit_invoice(
            &t.freelancer,
            &t.payer,
            &INVOICE_AMOUNT,
            &(now + DUE_DATE_OFFSET),
            &DISCOUNT_RATE,
            &t.token.address,
            &ReferralCode::None,
        )
        .unwrap()
}

/// Advance the ledger sequence by `delta` ledgers.
fn advance_ledger(env: &soroban_sdk::Env, delta: u32) {
    let mut info = env.ledger().get();
    info.sequence_number += delta;
    // Also advance timestamp proportionally (5 s per ledger) to keep the
    // due-date check from expiring the invoice.
    info.timestamp += delta as u64 * 5;
    env.ledger().set(info);
}

// ----------------------------------------------------------------
// Test 1: fresh oracle (age = 0) passes
// ----------------------------------------------------------------
#[test]
fn test_fresh_oracle_passes() {
    let t = setup();
    // Oracle timestamp == current ledger sequence → age = 0 → fresh.
    let current_seq = t.env.ledger().sequence();
    register_oracle_with_timestamp(&t, current_seq);

    let invoice_id = make_invoice(&t);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 2: stale oracle (age >> max) fails with OracleDataStale
// ----------------------------------------------------------------
#[test]
fn test_stale_oracle_fails() {
    let t = setup();
    // Set a tiny max age so we can manufacture staleness easily.
    let max_age: u64 = 10;
    t.contract.set_max_oracle_age(&max_age).unwrap();

    let current_seq = t.env.ledger().sequence(); // 100
                                                 // Oracle timestamp is older than max_age (age = 20 ≥ 10).
    register_oracle_with_timestamp(&t, current_seq - 20);

    let invoice_id = make_invoice(&t);

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    assert_eq!(
        result,
        Err(Ok(ContractError::OracleDataStale)),
        "expected OracleDataStale when oracle data is older than max_oracle_age_ledgers"
    );
}

// ----------------------------------------------------------------
// Test 3: exactly one ledger inside the limit passes (age = max - 1)
// ----------------------------------------------------------------
#[test]
fn test_boundary_one_before_limit_passes() {
    let t = setup();
    let max_age: u64 = 10;
    t.contract.set_max_oracle_age(&max_age).unwrap();

    let current_seq = t.env.ledger().sequence(); // 100
                                                 // age = 9 < 10 → should pass.
    register_oracle_with_timestamp(&t, current_seq - 9);

    let invoice_id = make_invoice(&t);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 4: exactly at the limit fails (age = max)
// ----------------------------------------------------------------
#[test]
fn test_boundary_exactly_at_limit_fails() {
    let t = setup();
    let max_age: u64 = 10;
    t.contract.set_max_oracle_age(&max_age).unwrap();

    let current_seq = t.env.ledger().sequence(); // 100
                                                 // age = 10 = max_age → should fail.
    register_oracle_with_timestamp(&t, current_seq - 10);

    let invoice_id = make_invoice(&t);

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    assert_eq!(
        result,
        Err(Ok(ContractError::OracleDataStale)),
        "expected OracleDataStale at exactly the boundary (age == max_oracle_age_ledgers)"
    );
}

// ----------------------------------------------------------------
// Test 5: max_oracle_age_ledgers = 0 disables the freshness check
// ----------------------------------------------------------------
#[test]
fn test_zero_max_age_disables_check() {
    let t = setup();
    // Disable freshness check entirely.
    t.contract.set_max_oracle_age(&0u64).unwrap();

    let current_seq = t.env.ledger().sequence();
    // Very old timestamp — age would exceed any real limit.
    register_oracle_with_timestamp(&t, current_seq.saturating_sub(999_999));

    let invoice_id = make_invoice(&t);

    // Should succeed because max_oracle_age_ledgers == 0 skips the check.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 6: governance can tighten max_oracle_age; new limit respected
// ----------------------------------------------------------------
#[test]
fn test_governance_can_update_max_oracle_age() {
    let t = setup();

    // Default max age (17_280) — a 5-ledger-old timestamp is fine.
    let current_seq = t.env.ledger().sequence();
    register_oracle_with_timestamp(&t, current_seq - 5);

    let invoice_id1 = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id1, &INVOICE_AMOUNT, &true)
        .unwrap();

    // Governance tightens the limit to 3 ledgers — same oracle data now stale.
    t.contract.set_max_oracle_age(&3u64).unwrap();
    assert_eq!(t.contract.get_max_oracle_age(), 3u64);

    let invoice_id2 = make_invoice(&t);
    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id2, &INVOICE_AMOUNT, &true);

    assert_eq!(
        result,
        Err(Ok(ContractError::OracleDataStale)),
        "after tightening max age, previously-fresh data should now be stale"
    );
}

// ----------------------------------------------------------------
// Test 7: stale oracle + require_oracle_verification=false → passes
// ----------------------------------------------------------------
#[test]
fn test_stale_oracle_ignored_when_flag_false() {
    let t = setup();
    t.contract.set_max_oracle_age(&5u64).unwrap();

    let current_seq = t.env.ledger().sequence();
    // Deliberately stale: age = 99 ≥ 5.
    register_oracle_with_timestamp(&t, current_seq.saturating_sub(99));

    let invoice_id = make_invoice(&t);

    // flag=false → oracle not consulted → no staleness check → succeeds.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 8: staleness detected after ledger advances (dynamic staleness)
// ----------------------------------------------------------------
#[test]
fn test_data_becomes_stale_as_ledger_advances() {
    let t = setup();
    let max_age: u64 = 5;
    t.contract.set_max_oracle_age(&max_age).unwrap();

    let oracle_ts = t.env.ledger().sequence(); // timestamp frozen at registration
    register_oracle_with_timestamp(&t, oracle_ts);

    // Advance 4 ledgers — still within limit (age = 4 < 5).
    advance_ledger(&t.env, 4);
    let invoice_id1 = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id1, &INVOICE_AMOUNT, &true)
        .unwrap();

    // Advance 1 more ledger — now age = 5 = max_age → stale.
    advance_ledger(&t.env, 1);
    let invoice_id2 = make_invoice(&t);
    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id2, &INVOICE_AMOUNT, &true);

    assert_eq!(
        result,
        Err(Ok(ContractError::OracleDataStale)),
        "oracle data should become stale once ledger advances past max_oracle_age"
    );
}

// ----------------------------------------------------------------
// Test 9: no oracle configured → fail-open (require_oracle_verification=true)
// ----------------------------------------------------------------
#[test]
fn test_no_oracle_configured_fails_open() {
    let t = setup();
    // Do NOT register any oracle — config.price_oracle is None.

    let invoice_id = make_invoice(&t);

    // When require_oracle_verification=true but no oracle is configured,
    // the contract should skip the oracle check and succeed (fail-open).
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ================================================================
// Tests for set_max_oracle_age (Issue #484)
// ================================================================

// ----------------------------------------------------------------
// Test 10: admin can set max oracle age
// ----------------------------------------------------------------
#[test]
fn test_set_max_oracle_age_succeeds() {
    let t = setup();

    t.contract.set_max_oracle_age(&42).unwrap();

    assert_eq!(t.contract.get_max_oracle_age(), 42);
}

// ----------------------------------------------------------------
// Test 11: setting max_oracle_age affects fund_invoice oracle check
// ----------------------------------------------------------------
#[test]
fn test_set_max_oracle_age_affects_fund_invoice_check() {
    let t = setup();
    let current_seq = t.env.ledger().sequence();

    // Set a tight max age of 5 ledgers.
    t.contract.set_max_oracle_age(&5).unwrap();

    // Oracle timestamp is 4 ledgers old → age=4 < 5 → fresh.
    register_oracle_with_timestamp(&t, current_seq - 4);

    let invoice_id1 = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id1, &INVOICE_AMOUNT, &true)
        .unwrap();
    assert_eq!(
        t.contract.get_invoice(&invoice_id1).unwrap().status,
        InvoiceStatus::Funded
    );

    // Tighten to 3 ledgers → same oracle data (age=4) now stale.
    t.contract.set_max_oracle_age(&3).unwrap();

    let invoice_id2 = make_invoice(&t);
    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id2, &INVOICE_AMOUNT, &true);

    assert_eq!(result, Err(Ok(ContractError::OracleDataStale)));
}

// ----------------------------------------------------------------
// Test 12: non-admin cannot call set_max_oracle_age
// ----------------------------------------------------------------
#[test]
fn test_set_max_oracle_age_unauthorized() {
    // Use a fresh env WITHOUT mock_all_auths to test real auth.
    let env = Env::default();
    // Don't call env.mock_all_auths() — we want real auth checks.

    let usdc_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let eurc_admin = Address::generate(&env);
    let eurc = env.register_stellar_asset_contract_v2(eurc_admin.clone());
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin.clone());

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&usdc_admin, &usdc.address(), &eurc.address(), &xlm.address());

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    let unauthorized = Address::generate(&env);
    // Only the unauthorized address signs — admin does not.
    env.mock_auths(&[
        soroban_sdk::testutils::MockAuth {
            address: &unauthorized,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_max_oracle_age",
                sub_invokes: &[],
                args: (&100u64,).into_val(&env),
            },
        },
    ]);

    let result = contract.try_set_max_oracle_age(&100);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}
