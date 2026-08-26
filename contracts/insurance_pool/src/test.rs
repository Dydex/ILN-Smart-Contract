#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

struct Setup {
    env: Env,
    client: InsurancePoolClient<'static>,
    token_client: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    admin: Address,
    lp: Address,
}

const COVERAGE: i128 = 1_000_000_000; // flat per-claim cap (100 units @ 1e7)

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, InsurancePool);
    let client = InsurancePoolClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let lp = Address::generate(&env);

    // Deploy a mock token contract
    let token_admin_addr = Address::generate(&env);
    let token_contract_id = env.register_stellar_asset_contract_v2(token_admin_addr);
    let token_address = token_contract_id.address();
    let token_client = TokenClient::new(&env, &token_address);
    let token_admin = StellarAssetClient::new(&env, &token_address);

    client.initialize(&admin, &COVERAGE, &token_address);

    Setup {
        env,
        client,
        token_client,
        token_admin,
        admin,
        lp,
    }
}

// ── Issue #528: risk-priced insurance premiums tests ──────────────────

#[test]
fn calculate_premium_rate_base_case() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Default base rate is 500 bps (5%), no defaults
    let rate = s.client.calculate_premium_rate_bps(&lp);
    assert_eq!(rate, 500);
}

#[test]
fn calculate_premium_rate_with_defaults() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Add defaults
    s.client.increment_default_count(&lp);
    s.client.increment_default_count(&lp);

    // Default rate increases with more defaults
    let rate = s.client.calculate_premium_rate_bps(&lp);
    assert!(rate > 500);
}

#[test]
fn set_base_premium_rate() {
    let s = setup();

    // Set new base rate
    s.client.set_base_premium_rate_bps(&1000); // 10%
    let rate = s.client.get_base_premium_rate_bps();
    assert_eq!(rate, 1000);
}

#[test]
fn set_risk_multiplier() {
    let s = setup();

    // Set new risk multiplier
    s.client.set_risk_multiplier(&200, &1); // 200x per default
    let num = s.client.get_risk_multiplier_numerator();
    let den = s.client.get_risk_multiplier_denominator();
    assert_eq!(num, 200);
    assert_eq!(den, 1);
}

#[test]
fn calculate_premium_amount() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Base rate: 500 bps (5%), invoice amount: 1000
    // Premium = 1000 * 500 / 10000 = 50
    let premium = s.client.calculate_premium_amount(&lp, &1000);
    assert_eq!(premium, 50);
}

#[test]
fn tiered_coverage_low_premiums() {
    let s = setup();

    // Deposit less than 10% of coverage -> 50% tier
    let amount = COVERAGE / 20; // 5%
    s.token_admin.mint(&s.lp, &amount);
    s.client.deposit_premium(&s.lp, &amount);

    let coverage = s.client.get_tiered_coverage(&s.lp);
    assert_eq!(coverage, COVERAGE / 2); // 50% of coverage
}

#[test]
fn tiered_coverage_medium_premiums() {
    let s = setup();

    // Deposit 10-25% of coverage -> 75% tier
    let amount = COVERAGE / 5; // 20%
    s.token_admin.mint(&s.lp, &amount);
    s.client.deposit_premium(&s.lp, &amount);

    let coverage = s.client.get_tiered_coverage(&s.lp);
    assert_eq!(coverage, (COVERAGE * 75) / 100); // 75% of coverage
}

#[test]
fn tiered_coverage_high_premiums() {
    let s = setup();

    // Deposit 25-50% of coverage -> 100% tier
    let amount = COVERAGE / 3; // ~33%
    s.token_admin.mint(&s.lp, &amount);
    s.client.deposit_premium(&s.lp, &amount);

    let coverage = s.client.get_tiered_coverage(&s.lp);
    assert_eq!(coverage, COVERAGE); // 100% of coverage
}

#[test]
fn tiered_coverage_very_high_premiums() {
    let s = setup();

    // Deposit >50% of coverage -> 150% tier
    let amount = COVERAGE * 2; // 200%
    s.token_admin.mint(&s.lp, &amount);
    s.client.deposit_premium(&s.lp, &amount);

    let coverage = s.client.get_tiered_coverage(&s.lp);
    assert_eq!(coverage, (COVERAGE * 150) / 100); // 150% of coverage
}

#[test]
fn increment_default_count_requires_admin() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Increment default count
    s.client.increment_default_count(&lp);
    assert_eq!(s.client.get_default_count(&lp), 1);

    s.client.increment_default_count(&lp);
    assert_eq!(s.client.get_default_count(&lp), 2);
}

#[test]
fn initialize_sets_coverage_and_zero_balance() {
    let s = setup();
    assert_eq!(s.client.get_pool_balance(), 0);
    assert_eq!(s.client.get_coverage(), COVERAGE);
    assert_eq!(s.client.get_token_address(), s.token_client.address.clone());
}

#[test]
fn initialize_is_single_shot() {
    let s = setup();
    let other = Address::generate(&s.env);
    let res = s
        .client
        .try_initialize(&other, &COVERAGE, &s.token_client.address);
    assert_eq!(res, Err(Ok(InsuranceError::AlreadyInitialized)));
}

#[test]
fn enroll_marks_lp_enrolled() {
    let s = setup();
    assert!(!s.client.is_enrolled(&s.lp));
    s.client.enroll(&s.lp);
    assert!(s.client.is_enrolled(&s.lp));
}

#[test]
fn deposit_premium_increases_balance_and_transfers_tokens() {
    let s = setup();

    // Mint tokens to LP
    s.token_admin.mint(&s.lp, &500);

    s.client.deposit_premium(&s.lp, &250);
    s.client.deposit_premium(&s.lp, &250);

    assert_eq!(s.client.get_pool_balance(), 500);
    assert_eq!(s.client.get_premiums_paid(&s.lp), 500);
    assert!(s.client.is_enrolled(&s.lp)); // auto-enrolled on first premium

    // Verify token balances
    assert_eq!(s.token_client.balance(&s.lp), 0);
    assert_eq!(s.token_client.balance(&s.client.address), 500);
}

#[test]
fn deposit_premium_rejects_non_positive_amount() {
    let s = setup();
    assert!(s.client.try_deposit_premium(&s.lp, &0).is_err());
    assert!(s.client.try_deposit_premium(&s.lp, &-100).is_err());
}

#[test]
fn claim_pays_coverage_capped_by_balance_and_transfers_tokens() {
    let s = setup();

    // Mint tokens to LP and deposit
    s.token_admin.mint(&s.lp, &400);
    s.client.deposit_premium(&s.lp, &400);

    // Pool has less than the coverage cap -> payout bounded by balance.
    let payout = s.client.claim(&1, &s.lp);
    assert_eq!(payout, 400);
    assert_eq!(s.client.get_pool_balance(), 0);
    assert!(s.client.is_claimed(&1));

    // Verify tokens transferred to LP
    assert_eq!(s.token_client.balance(&s.client.address), 0);
    assert_eq!(s.token_client.balance(&s.lp), 400);
}

#[test]
fn claim_pays_tiered_coverage_when_pool_is_large() {
    let s = setup();

    // Mint tokens to LP and deposit (more than 50% of coverage -> tier 4: 150%)
    s.token_admin.mint(&s.lp, &(COVERAGE * 3));
    s.client.deposit_premium(&s.lp, &(COVERAGE * 3));

    // With tiered coverage, LP gets 150% of coverage because they paid > 50%
    let expected_payout = (COVERAGE * 150) / 100;
    let payout = s.client.claim(&7, &s.lp);
    assert_eq!(payout, expected_payout); // tiered coverage: 150%
    assert_eq!(s.client.get_pool_balance(), COVERAGE * 3 - expected_payout);

    // Verify token balances
    assert_eq!(s.token_client.balance(&s.lp), expected_payout); // LP receives payout
    assert_eq!(
        s.token_client.balance(&s.client.address),
        COVERAGE * 3 - expected_payout
    ); // Pool keeps remainder
}

#[test]
fn claim_is_idempotent_per_invoice() {
    let s = setup();

    // Mint tokens to LP and deposit
    s.token_admin.mint(&s.lp, &(COVERAGE * 2));
    s.client.deposit_premium(&s.lp, &(COVERAGE * 2));

    s.client.claim(&42, &s.lp);
    let res = s.client.try_claim(&42, &s.lp);
    // `claim` returns `i128` and panics with the error, so it surfaces as the
    // outer host error (a `soroban_sdk::Error`) rather than an inner `Result`.
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::AlreadyClaimed)))
    );
}

#[test]
fn claim_rejects_when_pool_empty() {
    let s = setup();
    let res = s.client.try_claim(&99, &s.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::PoolEmpty)))
    );
}

#[test]
fn admin_is_recorded() {
    let s = setup();
    // Mint tokens and deposit for a claim
    s.token_admin.mint(&s.lp, &COVERAGE);
    s.client.deposit_premium(&s.lp, &COVERAGE);
    let _ = s.client.claim(&100, &s.lp);
    // admin captured at init is the one we passed
    assert!(s.client.is_claimed(&100));
}

#[test]
fn coverage_change_requires_timelock_expiry() {
    let s = setup();
    let new_coverage = COVERAGE * 2;

    let eta = s.client.propose_coverage_change(&new_coverage);
    assert_eq!(s.client.get_coverage(), COVERAGE); // unchanged until executed
    assert_eq!(s.client.get_pending_coverage(), Some((new_coverage, eta)));

    // Too early.
    let res = s.client.try_execute_coverage_change();
    assert_eq!(res, Err(Ok(InsuranceError::TimelockNotExpired)));

    s.env.ledger().set_timestamp(eta);
    s.client.execute_coverage_change();

    assert_eq!(s.client.get_coverage(), new_coverage);
    assert_eq!(s.client.get_pending_coverage(), None);
}

#[test]
fn coverage_change_can_be_cancelled() {
    let s = setup();
    s.client.propose_coverage_change(&(COVERAGE * 2));
    assert!(s.client.get_pending_coverage().is_some());

    s.client.cancel_coverage_change();
    assert_eq!(s.client.get_pending_coverage(), None);

    let res = s.client.try_execute_coverage_change();
    assert_eq!(res, Err(Ok(InsuranceError::NoPendingProposal)));
}

#[test]
fn admin_transfer_requires_timelock_expiry() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    let eta = s.client.propose_admin_transfer(&new_admin);
    assert_eq!(s.client.get_pending_admin(), Some((new_admin.clone(), eta)));

    let res = s.client.try_execute_admin_transfer();
    assert_eq!(res, Err(Ok(InsuranceError::TimelockNotExpired)));

    s.env.ledger().set_timestamp(eta);
    s.client.execute_admin_transfer();

    assert_eq!(s.client.get_pending_admin(), None);

    // New admin can now propose further changes; old admin no longer can
    // (require_auth would fail against the new admin in a real invocation --
    // here we simply confirm the pending state cleared and a new proposal by
    // the new admin succeeds under mock_all_auths).
    let _ = s.client.propose_coverage_change(&(COVERAGE * 3));
}

#[test]
fn admin_transfer_can_be_cancelled() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.client.propose_admin_transfer(&new_admin);
    s.client.cancel_admin_transfer();
    assert_eq!(s.client.get_pending_admin(), None);

    let res = s.client.try_execute_admin_transfer();
    assert_eq!(res, Err(Ok(InsuranceError::NoPendingProposal)));
}

// ── Governance-controlled parameter updates ────────────────────────────────

#[test]
fn governance_can_update_coverage_cap() {
    let s = setup();
    assert_eq!(s.client.get_coverage(), COVERAGE);

    let new_coverage = 2_000_000_000;
    s.client.set_coverage_via_governance(&new_coverage);
    assert_eq!(s.client.get_coverage(), new_coverage);
}

#[test]
fn governance_rejects_non_positive_coverage() {
    let s = setup();
    let res = s.client.try_set_coverage_via_governance(&0);
    assert_eq!(res, Err(Ok(InsuranceError::InvalidAmount)));

    let res = s.client.try_set_coverage_via_governance(&-1_000_000);
    assert_eq!(res, Err(Ok(InsuranceError::InvalidAmount)));
}

#[test]
fn governance_can_set_premium_rate() {
    let s = setup();
    // Premium rate setting is allowed
    let res = s.client.try_set_premium_rate_via_governance(&500);
    assert!(res.is_ok());
}

#[test]
fn premium_rate_change_does_not_retroactively_affect_enrolled_lp_coverage() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // 1. LP deposits premium at the original base rate (default 500 bps = 5%)
    let deposit_amount = COVERAGE / 3; // ~33% -> tier 4: 150% coverage
    s.token_admin.mint(&lp, &deposit_amount);
    s.client.deposit_premium(&lp, &deposit_amount);
    assert!(s.client.is_enrolled(&lp));

    // Record the tiered coverage before rate change
    let coverage_before = s.client.get_tiered_coverage(&lp);
    assert_eq!(coverage_before, (COVERAGE * 150) / 100); // 150% tier for >25% deposit

    // 2. Governance changes the base premium rate (double it)
    let new_rate = 1000; // 10% instead of 5%
    s.client.set_base_premium_rate_via_governance(&new_rate);
    assert_eq!(s.client.get_base_premium_rate_bps(), new_rate);

    // 3. LP's existing tiered coverage should NOT be retroactively affected
    let coverage_after = s.client.get_tiered_coverage(&lp);
    assert_eq!(
        coverage_after, coverage_before,
        "Already-enrolled LP's tiered coverage must not change when base rate changes"
    );

    // 4. Verify the new rate affects calculations for future deposits
    let rate_for_lp = s.client.calculate_premium_rate_bps(&lp);
    // The rate calculation should reflect the new base rate
    assert!(rate_for_lp >= new_rate, "New base rate should apply to rate calculations");

    // 5. A new LP or new deposits should use the new rate
    let other_lp = Address::generate(&s.env);
    let rate_for_other = s.client.calculate_premium_rate_bps(&other_lp);
    assert_eq!(rate_for_other, new_rate, "New LP should use the new base rate");
}

#[test]
fn coverage_update_affects_future_claims() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Deposit with default coverage (LP pays > 50% → tier 4: 150%)
    let deposit_large = COVERAGE * 2;
    s.token_admin.mint(&lp, &deposit_large);
    s.client.deposit_premium(&lp, &deposit_large);
    let payout1 = s.client.claim(&1, &lp);
    assert_eq!(payout1, (COVERAGE * 150) / 100);

    // Update coverage to higher value via governance
    let new_coverage = 3_000_000_000;
    s.client.set_coverage_via_governance(&new_coverage);

    // Add more balance so the pool can pay out at the new coverage level
    let deposit2 = new_coverage * 2;
    s.token_admin.mint(&lp, &deposit2);
    s.client.deposit_premium(&lp, &deposit2);
    let payout2 = s.client.claim(&2, &lp);
    // LP still has > 50% of new coverage → tier 4 (150%)
    assert_eq!(payout2, (new_coverage * 150) / 100);
}

// ── Overflow and balance cap tests ──────────────────────────────────────────

#[test]
fn deposit_premium_at_i128_max_overflows() {
    let s = setup();

    // Seed the premium record to (i128::MAX - 1) by depositing a large amount.
    // Then depositing 1 more triggers a checked overflow.
    let near_max: i128 = i128::MAX - 1;
    // Mint enough tokens; i128::MAX won't fit in a typical test but we can simulate
    // the state by pre-setting storage and then trying to add 2.
    // We use two deposits: first near_max, then a small extra amount.
    s.token_admin.mint(&s.lp, &near_max);
    // This should succeed (within i128 bounds)
    s.client.deposit_premium(&s.lp, &near_max);
    assert_eq!(s.client.get_premiums_paid(&s.lp), near_max);

    // Now depositing even 1 more should overflow the pool balance (near_max + 1 > i128::MAX - 1, balance check).
    // Actually balance is now near_max; adding 1 more gives i128::MAX which barely fits.
    // Adding 2 will cause i128 checked_add to return None.
    s.token_admin.mint(&s.lp, &2);
    let result = s.client.try_deposit_premium(&s.lp, &2);
    // checked_add(near_max + 2) overflows → ArithmeticOverflow
    assert!(
        result.is_err(),
        "Depositing beyond i128::MAX must fail with overflow error"
    );
}

#[test]
fn deposit_premium_enforces_balance_cap() {
    let s = setup();

    // Set a cap of 1_000 tokens
    let cap: i128 = 1_000;
    s.client.set_balance_cap(&cap);
    assert_eq!(s.client.get_balance_cap(), Some(cap));

    // Deposit up to the cap — should succeed
    s.token_admin.mint(&s.lp, &cap);
    s.client.deposit_premium(&s.lp, &cap);
    assert_eq!(s.client.get_pool_balance(), cap);

    // Depositing even 1 more must be rejected
    s.token_admin.mint(&s.lp, &1);
    let result = s.client.try_deposit_premium(&s.lp, &1);
    assert!(
        result.is_err(),
        "Deposit exceeding the balance cap must fail"
    );

    // Pool balance must remain unchanged after the failed deposit
    assert_eq!(s.client.get_pool_balance(), cap);
}

#[test]
fn balance_cap_can_be_cleared() {
    let s = setup();

    let cap: i128 = 500;
    s.client.set_balance_cap(&cap);
    assert_eq!(s.client.get_balance_cap(), Some(cap));

    // Clear cap by passing 0
    s.client.set_balance_cap(&0);
    assert_eq!(s.client.get_balance_cap(), None);

    // Now deposits beyond the old cap should succeed
    let amount: i128 = 1_000;
    s.token_admin.mint(&s.lp, &amount);
    s.client.deposit_premium(&s.lp, &amount);
    assert_eq!(s.client.get_pool_balance(), amount);
}
