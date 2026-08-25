//! Integration tests — governance contract → invoice_liquidity contract.
//!
//! Issue #86: verifies that governance proposals which update main-contract
//! parameters actually take effect, and that vetoed proposals are blocked.
//!
//! Contracts deployed per test:
//!   - `InvoiceLiquidityContract` (ILN) — the main protocol
//!   - `GovContract` — governance with ILN as its target
//!   - `MockToken` — deterministic payment token (wraps mocks/mock_token.rs)
//!   - Stellar Asset Contract — governance voting token

extern crate std;

// ── Import the mock token defined in contracts/tests/mocks/mock_token.rs ──────
#[path = "mocks/mock_token.rs"]
mod mock_token;

use mock_token::{MockToken, MockTokenClient};

use iln_governance::{
    GovContract, GovContractClient, GovernanceError, ProposalAction, ProposalStatus,
};
use invoice_liquidity::{
    ContractError, InvoiceLiquidityContract, InvoiceLiquidityContractClient, ReferralCode,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, BytesN, Env,
};

// ── Shared helpers ────────────────────────────────────────────────────────────

const INVOICE_AMOUNT: i128 = 1_000_000_000; // 100 USDC (7-decimal)
const DISCOUNT_RATE: u32 = 300; // 3 %
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days
const LEDGER_TIMESTAMP: u64 = 1_700_000_000;
const GOV_TOTAL_SUPPLY: i128 = 20_000; // seeded via initialize()'s gov_token_total_supply param

struct GovIntegrationEnv {
    env: Env,
    iln: InvoiceLiquidityContractClient<'static>,
    governance: GovContractClient<'static>,
    /// ILN admin / governance admin.
    admin: Address,
    /// Holder of governance voting tokens — can pass any proposal solo.
    voter: Address,
    /// Payment token (MockToken) used for invoices.
    payment_token: MockTokenClient<'static>,
    payment_token_addr: Address,
    /// Freelancer, payer, LP for invoice flow tests.
    freelancer: Address,
    payer: Address,
    lp: Address,
}

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

fn setup() -> GovIntegrationEnv {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ── Governance voting token (Stellar Asset Contract) ──────────────────
    let gov_token_admin_addr = Address::generate(&env);
    let gov_token_id = env.register_stellar_asset_contract_v2(gov_token_admin_addr);
    let gov_token_addr = gov_token_id.address();
    let gov_token_admin = StellarAssetClient::new(&env, &gov_token_addr);

    let admin = Address::generate(&env);
    let voter = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    // voter holds enough tokens to exceed the 10% quorum on GOV_TOTAL_SUPPLY=20_000.
    gov_token_admin.mint(&voter, &3_000);

    // ── MockToken (payment token for ILN invoices) ────────────────────────
    let payment_token_addr = env.register_contract(None, MockToken);
    let payment_token = MockTokenClient::new(&env, &payment_token_addr);

    // Fund LP (enough for discount cost) and payer (full invoice amount).
    payment_token.mint(&lp, &INVOICE_AMOUNT);
    payment_token.mint(&payer, &INVOICE_AMOUNT);

    // ── ILN contract ──────────────────────────────────────────────────────
    // XLM SAC placeholder (not used in these tests).
    let xlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let xlm_addr = xlm_id.address();

    let iln_id = env.register_contract(None, InvoiceLiquidityContract);
    let iln = InvoiceLiquidityContractClient::new(&env, &iln_id);
    let eurc_addr = Address::generate(&env);
    iln.initialize(&admin, &payment_token_addr, &eurc_addr, &xlm_addr);

    // ── Governance contract ───────────────────────────────────────────────
    // Distribution and reputation_bonus contracts aren't exercised by these
    // tests (no distribution- or reputation-bonus-related proposals), so
    // generated placeholder addresses are sufficient.
    let dist_addr = Address::generate(&env);
    let rep_bonus_addr = Address::generate(&env);
    let governance_id = env.register_contract(None, GovContract);
    let governance = GovContractClient::new(&env, &governance_id);
    governance.initialize(
        &iln_id,
        &dist_addr,
        &rep_bonus_addr,
        &gov_token_addr,
        &admin,
        &GOV_TOTAL_SUPPLY,
    );

    // Fix ledger timestamp.
    let mut ledger = env.ledger().get();
    ledger.timestamp = LEDGER_TIMESTAMP;
    env.ledger().set(ledger);

    GovIntegrationEnv {
        env,
        iln,
        governance,
        admin,
        voter,
        payment_token,
        payment_token_addr,
        freelancer,
        payer,
        lp,
    }
}

/// Pass a proposal through the full governance lifecycle and execute it.
///
/// Steps:
/// 1. voter casts a FOR vote (3 000 / 20 000 = 15 % > 10 % quorum).
/// 2. Advance timestamp past the 3-day voting window.
/// 3. Call `execute_proposal` twice:
///    - first call: Active → Passed
///    - second call: Passed → Executed (with zero timelock delay)
fn pass_and_execute(t: &GovIntegrationEnv, proposal_id: u64) {
    t.governance.cast_vote(&t.voter, &proposal_id, &true);

    // Advance past the 259 200-second voting window. Also advance the
    // ledger sequence: executing an economic-parameter proposal (e.g.
    // UpdateFeeRate, UpdateMaxDiscountRate) calls into the ILN contract's
    // own rate-limited setters, whose cooldown is keyed off ledger
    // sequence, not timestamp. The last-call ledger for a rate-limited
    // function defaults to 0 when never called, so without this the
    // first-ever call at the default sequence 0 incorrectly trips the
    // cooldown — see tests_oracle_registry.rs's
    // `advance_past_rate_limit_cooldown` for the same workaround applied
    // elsewhere in the ILN contract's own test suite.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += 259_201;
    ledger.sequence_number += invoice_liquidity::constants::ECONOMIC_PARAM_COOLDOWN_LEDGERS as u32;
    t.env.ledger().set(ledger);

    // Active → Passed
    t.governance.execute_proposal(&proposal_id);
    // Passed → Executed  (zero-delay timelock: eta_ledger == current_sequence)
    t.governance.execute_proposal(&proposal_id);
}

// ── Test 1 ────────────────────────────────────────────────────────────────────

/// A governance proposal to lower `max_discount_rate` is executed, and the
/// main contract enforces the new limit when validating future invoices.
#[test]
fn test_update_max_discount_via_governance_takes_effect() {
    let t = setup();

    // Before the proposal: discount_rate=2_000 (20 %) is below the default
    // maximum of 5_000 (50 %) so submission succeeds.
    let due_date = LEDGER_TIMESTAMP + DUE_DATE_OFFSET;
    let result_before = t.iln.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &2_000,
        &t.payment_token_addr,
        &ReferralCode::None,
    );
    assert!(
        result_before.is_ok(),
        "submission with rate=2000 should succeed before governance change"
    );

    // Governance proposal: lower MaxDiscountRate to 1 000 (10 %).
    let proposal_id = t.governance.create_proposal(
        &t.voter,
        &ProposalAction::UpdateMaxDiscountRate(1_000),
        &dummy_hash(&t.env),
        &1_000_i128,
    );

    pass_and_execute(&t, proposal_id);

    let p = t.governance.get_proposal(&proposal_id);
    assert_eq!(p.status, ProposalStatus::Executed);

    // After execution: discount_rate=2_000 now exceeds the new maximum of 1_000.
    let due_date_2 = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let result_after = t.iln.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date_2,
        &2_000,
        &t.payment_token_addr,
        &ReferralCode::None,
    );
    assert_eq!(
        result_after,
        Err(Ok(ContractError::InvalidDiscountRate)),
        "submission with rate=2000 must be rejected after max was lowered to 1000"
    );

    // A submission at the new limit (1 000) still succeeds.
    let result_at_limit = t.iln.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date_2,
        &1_000,
        &t.payment_token_addr,
        &ReferralCode::None,
    );
    assert!(
        result_at_limit.is_ok(),
        "submission with rate==new_max (1000) must still succeed"
    );
}

// ── Test 2 ────────────────────────────────────────────────────────────────────

/// A governance proposal to set the protocol fee is executed, and the fee is
/// correctly deducted from LP payout when the invoice is settled.
#[test]
fn test_update_fee_rate_via_governance_takes_effect() {
    let t = setup();

    // Governance proposal: set fee_rate to 200 bps (2 %).
    let fee_rate: u32 = 200;
    let proposal_id = t.governance.create_proposal(
        &t.voter,
        &ProposalAction::UpdateFeeRate(fee_rate),
        &dummy_hash(&t.env),
        &(fee_rate as i128),
    );

    pass_and_execute(&t, proposal_id);

    let p = t.governance.get_proposal(&proposal_id);
    assert_eq!(p.status, ProposalStatus::Executed);

    // Run the invoice lifecycle: submit → fund → mark_paid.
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.iln.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.payment_token_addr,
        &ReferralCode::None,
    );

    t.iln
        .fund_invoice(&t.lp, &invoice_id, &INVOICE_AMOUNT, &false);
    t.iln.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Admin should have received the protocol fee.
    // fee = INVOICE_AMOUNT * fee_rate / 10_000 = 1_000_000_000 * 200 / 10_000 = 20_000_000
    let expected_fee = INVOICE_AMOUNT * fee_rate as i128 / 10_000;
    let admin_balance = t.payment_token.balance(&t.admin);

    assert_eq!(
        admin_balance, expected_fee,
        "admin balance ({}) must equal the protocol fee ({})",
        admin_balance, expected_fee,
    );
}

// ── Test 3 ────────────────────────────────────────────────────────────────────

/// A vetoed proposal cannot be executed; the target parameter is unchanged.
#[test]
fn test_veto_proposal_prevents_execution() {
    let t = setup();

    // Create a proposal that would change the fee rate.
    let proposal_id = t.governance.create_proposal(
        &t.voter,
        &ProposalAction::UpdateFeeRate(500),
        &dummy_hash(&t.env),
        &500_i128,
    );

    // Cast a FOR vote so the proposal would pass if not vetoed.
    t.governance.cast_vote(&t.voter, &proposal_id, &true);

    // Admin vetoes the proposal.
    t.governance
        .veto_proposal(&proposal_id, &dummy_hash(&t.env));

    let p = t.governance.get_proposal(&proposal_id);
    assert_eq!(p.status, ProposalStatus::Vetoed);

    // Advance past the voting window.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += 259_201;
    t.env.ledger().set(ledger);

    // Attempting to execute a vetoed proposal must return AlreadyResolved.
    let execute_result = t.governance.try_execute_proposal(&proposal_id);
    assert_eq!(
        execute_result,
        Err(Ok(GovernanceError::AlreadyResolved)),
        "executing a vetoed proposal must fail with AlreadyResolved"
    );

    // The ILN fee rate was NOT changed — submitting and funding an invoice
    // with the default fee (0) means admin receives no fee.
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.iln.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.payment_token_addr,
        &ReferralCode::None,
    );
    t.iln
        .fund_invoice(&t.lp, &invoice_id, &INVOICE_AMOUNT, &false);
    t.iln.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // With fee_rate still at 0, admin receives no protocol fee.
    let admin_balance = t.payment_token.balance(&t.admin);
    assert_eq!(
        admin_balance, 0,
        "admin balance must be 0 — the vetoed fee-rate change must not have taken effect"
    );
}
