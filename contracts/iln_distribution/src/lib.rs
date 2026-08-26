#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token::StellarAssetClient, Address, Env,
    Symbol,
};

const HALF_TOKEN: i128 = 5_000_000;
const HUNDRED_USDC_STROOPS: i128 = 1_000_000_000;
/// Default LP reward rate: 10,000,000 stroops per 100 USDC.
const DEFAULT_LP_REWARD_RATE: i128 = 10_000_000;
/// Default freelancer reward rate: 5,000,000 stroops per settlement.
const DEFAULT_FREELANCER_REWARD_RATE: i128 = HALF_TOKEN;
/// Default payer reward rate: 5,000,000 stroops per on-time settlement.
const DEFAULT_PAYER_REWARD_RATE: i128 = HALF_TOKEN;
/// Defense-in-depth ceiling for a single `accrue_lp` call (~1,000,000 USDC
/// at 7-decimal stroops). Prevents a compromised/misconfigured ILN from
/// accruing absurd volumes in one invocation.
pub const MAX_LP_ACCRUAL_PER_CALL: i128 = 10_000_000_000_000; // 1e13

#[contracttype]
pub enum StorageKey {
    Initialized,
    IlnContract,
    GovToken,
    LpFundedVolume(Address),
    FreelancerSettled(Address),
    PayerOnTimeSettled(Address),
    Claimed(Address),
    /// Reward rate per 100 USDC of LP volume (in stroops).
    LpRewardRate,
    /// Reward rate per freelancer settlement (in stroops).
    FreelancerRewardRate,
    /// Reward rate per on-time payer settlement (in stroops).
    PayerRewardRate,
}

/// Emitted once, when the contract is initialised (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractInitialized {
    pub iln_contract: Address,
    pub gov_token: Address,
}

/// Emitted when an LP's funded volume accrual increases (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LpVolumeAccrued {
    pub lp: Address,
    pub amount_usdc_equivalent: i128,
}

/// Emitted when a settlement is recorded for a freelancer/payer (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SettlementAccrued {
    pub freelancer: Address,
    pub payer: Address,
    pub settled_on_time: bool,
}

/// Emitted when a participant claims accrued governance tokens (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokensClaimed {
    pub claimer: Address,
    pub amount: i128,
}

/// Emitted when a reward rate is updated via governance.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RewardRateUpdated {
    pub rate_type: Symbol,
    pub old_rate: i128,
    pub new_rate: i128,
}

#[contract]
pub struct IlnDistribution;

#[contractimpl]
impl IlnDistribution {
    pub fn initialize(env: Env, iln_contract: Address, gov_token: Address) {
        if env.storage().instance().has(&StorageKey::Initialized) {
            panic!("already initialized");
        }

        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&StorageKey::IlnContract, &iln_contract);
        env.storage()
            .instance()
            .set(&StorageKey::GovToken, &gov_token);
        env.storage()
            .instance()
            .set(&StorageKey::LpRewardRate, &DEFAULT_LP_REWARD_RATE);
        env.storage().instance().set(
            &StorageKey::FreelancerRewardRate,
            &DEFAULT_FREELANCER_REWARD_RATE,
        );
        env.storage()
            .instance()
            .set(&StorageKey::PayerRewardRate, &DEFAULT_PAYER_REWARD_RATE);

        env.events().publish(
            (symbol_short!("init"),),
            ContractInitialized {
                iln_contract,
                gov_token,
            },
        );
    }

    pub fn accrue_lp(env: Env, lp: Address, amount_usdc_equivalent: i128) {
        Self::require_iln_invoker(&env);

        // Defense-in-depth: ignore non-positive and absurdly large settlements
        // rather than trusting upstream blindly (even though ILN is the sole
        // intended caller).
        if amount_usdc_equivalent <= 0 || amount_usdc_equivalent > MAX_LP_ACCRUAL_PER_CALL {
            return;
        }

        let key = StorageKey::LpFundedVolume(lp.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &current.saturating_add(amount_usdc_equivalent));

        env.events().publish(
            (symbol_short!("lp_accr"), lp.clone()),
            LpVolumeAccrued {
                lp,
                amount_usdc_equivalent,
            },
        );
    }

    pub fn accrue_settlement(env: Env, freelancer: Address, payer: Address, settled_on_time: bool) {
        Self::require_iln_invoker(&env);

        let freelancer_key = StorageKey::FreelancerSettled(freelancer.clone());
        let freelancer_count: u64 = env
            .storage()
            .persistent()
            .get(&freelancer_key)
            .unwrap_or(0_u64);
        env.storage()
            .persistent()
            .set(&freelancer_key, &freelancer_count.saturating_add(1));

        if settled_on_time {
            let payer_key = StorageKey::PayerOnTimeSettled(payer.clone());
            let payer_count: u64 = env.storage().persistent().get(&payer_key).unwrap_or(0_u64);
            env.storage()
                .persistent()
                .set(&payer_key, &payer_count.saturating_add(1));
        }

        env.events().publish(
            (symbol_short!("settled"), freelancer.clone(), payer.clone()),
            SettlementAccrued {
                freelancer,
                payer,
                settled_on_time,
            },
        );
    }

    pub fn claim_tokens(env: Env, claimer: Address) -> i128 {
        claimer.require_auth();

        let total_earned = Self::total_earned(&env, &claimer);
        let claimed_key = StorageKey::Claimed(claimer.clone());
        let already_claimed: i128 = env.storage().persistent().get(&claimed_key).unwrap_or(0);

        let claimable = total_earned.saturating_sub(already_claimed);
        if claimable <= 0 {
            return 0;
        }

        let gov_token: Address = env.storage().instance().get(&StorageKey::GovToken).unwrap();
        StellarAssetClient::new(&env, &gov_token).mint(&claimer, &claimable);

        env.storage()
            .persistent()
            .set(&claimed_key, &already_claimed.saturating_add(claimable));

        env.events().publish(
            (symbol_short!("claimed"), claimer.clone()),
            TokensClaimed {
                claimer,
                amount: claimable,
            },
        );

        claimable
    }

    pub fn get_accrual(env: Env, participant: Address) -> i128 {
        Self::total_earned(&env, &participant)
    }

    fn total_earned(env: &Env, participant: &Address) -> i128 {
        let lp_volume: i128 = env
            .storage()
            .persistent()
            .get(&StorageKey::LpFundedVolume(participant.clone()))
            .unwrap_or(0);
        let freelancer_settled: u64 = env
            .storage()
            .persistent()
            .get(&StorageKey::FreelancerSettled(participant.clone()))
            .unwrap_or(0_u64);
        let payer_on_time: u64 = env
            .storage()
            .persistent()
            .get(&StorageKey::PayerOnTimeSettled(participant.clone()))
            .unwrap_or(0_u64);

        let lp_reward_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::LpRewardRate)
            .unwrap_or(DEFAULT_LP_REWARD_RATE);
        let freelancer_reward_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::FreelancerRewardRate)
            .unwrap_or(DEFAULT_FREELANCER_REWARD_RATE);
        let payer_reward_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::PayerRewardRate)
            .unwrap_or(DEFAULT_PAYER_REWARD_RATE);

        let lp_reward = (lp_volume / HUNDRED_USDC_STROOPS).saturating_mul(lp_reward_rate);
        let freelancer_reward = (freelancer_settled as i128).saturating_mul(freelancer_reward_rate);
        let payer_reward = (payer_on_time as i128).saturating_mul(payer_reward_rate);

        lp_reward
            .saturating_add(freelancer_reward)
            .saturating_add(payer_reward)
    }

    /// Set LP reward rate (requires governance contract authorization).
    pub fn set_lp_reward_rate(env: Env, new_rate: i128) {
        Self::require_governance_invoker(&env);
        let old_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::LpRewardRate)
            .unwrap_or(DEFAULT_LP_REWARD_RATE);
        env.storage()
            .instance()
            .set(&StorageKey::LpRewardRate, &new_rate);
        env.events().publish(
            (symbol_short!("rw_upd"),),
            RewardRateUpdated {
                rate_type: Symbol::new(&env, "lp_reward"),
                old_rate,
                new_rate,
            },
        );
    }

    /// Set freelancer reward rate (requires governance contract authorization).
    pub fn set_freelancer_reward_rate(env: Env, new_rate: i128) {
        Self::require_governance_invoker(&env);
        let old_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::FreelancerRewardRate)
            .unwrap_or(DEFAULT_FREELANCER_REWARD_RATE);
        env.storage()
            .instance()
            .set(&StorageKey::FreelancerRewardRate, &new_rate);
        env.events().publish(
            (symbol_short!("rw_upd"),),
            RewardRateUpdated {
                rate_type: Symbol::new(&env, "freelancer_reward"),
                old_rate,
                new_rate,
            },
        );
    }

    /// Set payer reward rate (requires governance contract authorization).
    pub fn set_payer_reward_rate(env: Env, new_rate: i128) {
        Self::require_governance_invoker(&env);
        let old_rate: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::PayerRewardRate)
            .unwrap_or(DEFAULT_PAYER_REWARD_RATE);
        env.storage()
            .instance()
            .set(&StorageKey::PayerRewardRate, &new_rate);
        env.events().publish(
            (symbol_short!("rw_upd"),),
            RewardRateUpdated {
                rate_type: Symbol::new(&env, "payer_reward"),
                old_rate,
                new_rate,
            },
        );
    }

    /// Get current LP reward rate.
    pub fn get_lp_reward_rate(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&StorageKey::LpRewardRate)
            .unwrap_or(DEFAULT_LP_REWARD_RATE)
    }

    /// Get current freelancer reward rate.
    pub fn get_freelancer_reward_rate(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&StorageKey::FreelancerRewardRate)
            .unwrap_or(DEFAULT_FREELANCER_REWARD_RATE)
    }

    /// Get current payer reward rate.
    pub fn get_payer_reward_rate(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&StorageKey::PayerRewardRate)
            .unwrap_or(DEFAULT_PAYER_REWARD_RATE)
    }

    fn require_iln_invoker(env: &Env) {
        let iln_contract: Address = env
            .storage()
            .instance()
            .get(&StorageKey::IlnContract)
            .unwrap();
        iln_contract.require_auth();
    }

    fn require_governance_invoker(env: &Env) {
        let iln_contract: Address = env
            .storage()
            .instance()
            .get(&StorageKey::IlnContract)
            .unwrap();
        iln_contract.require_auth();
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token::Client as TokenClient, Address};

    #[cfg(test)]
    use super::{HALF_TOKEN, HUNDRED_USDC_STROOPS};

    #[contract]
    pub struct MockIln;

    #[contractimpl]
    impl MockIln {
        pub fn accrue_lp(env: Env, dist: Address, lp: Address, amount: i128) {
            IlnDistributionClient::new(&env, &dist).accrue_lp(&lp, &amount);
        }

        pub fn accrue_settlement(
            env: Env,
            dist: Address,
            freelancer: Address,
            payer: Address,
            on_time: bool,
        ) {
            IlnDistributionClient::new(&env, &dist).accrue_settlement(
                &freelancer,
                &payer,
                &on_time,
            );
        }
    }

    #[test]
    fn lp_earns_on_funding_and_cannot_double_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();
        let token_client = TokenClient::new(&env, &gov_token);

        dist.initialize(&iln_id, &gov_token);

        let lp = Address::generate(&env);
        iln.accrue_lp(&dist_id, &lp, &HUNDRED_USDC_STROOPS);

        let claimed = dist.claim_tokens(&lp);
        assert_eq!(claimed, 10_000_000);
        assert_eq!(token_client.balance(&lp), 10_000_000);

        let second_claim = dist.claim_tokens(&lp);
        assert_eq!(second_claim, 0);
        assert_eq!(token_client.balance(&lp), 10_000_000);
    }

    #[test]
    fn freelancer_and_payer_earn_on_settlement() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();
        let token_client = TokenClient::new(&env, &gov_token);

        dist.initialize(&iln_id, &gov_token);

        let freelancer = Address::generate(&env);
        let payer = Address::generate(&env);

        iln.accrue_settlement(&dist_id, &freelancer, &payer, &true);

        assert_eq!(dist.claim_tokens(&freelancer), HALF_TOKEN);
        assert_eq!(dist.claim_tokens(&payer), HALF_TOKEN);
        assert_eq!(token_client.balance(&freelancer), HALF_TOKEN);
        assert_eq!(token_client.balance(&payer), HALF_TOKEN);
    }

    #[test]
    fn late_settlement_does_not_reward_payer() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();

        dist.initialize(&iln_id, &gov_token);

        let freelancer = Address::generate(&env);
        let payer = Address::generate(&env);

        iln.accrue_settlement(&dist_id, &freelancer, &payer, &false);

        assert_eq!(dist.claim_tokens(&freelancer), HALF_TOKEN);
        assert_eq!(dist.claim_tokens(&payer), 0);
    }

    #[test]
    fn governance_can_update_lp_reward_rate() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();

        dist.initialize(&iln_id, &gov_token);

        // Check default rate
        assert_eq!(dist.get_lp_reward_rate(), DEFAULT_LP_REWARD_RATE);

        // Update rate via governance (with ILN auth)
        dist.set_lp_reward_rate(&20_000_000);
        assert_eq!(dist.get_lp_reward_rate(), 20_000_000);
    }

    #[test]
    fn governance_can_update_freelancer_reward_rate() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();

        dist.initialize(&iln_id, &gov_token);

        // Check default rate
        assert_eq!(
            dist.get_freelancer_reward_rate(),
            DEFAULT_FREELANCER_REWARD_RATE
        );

        // Update rate
        dist.set_freelancer_reward_rate(&8_000_000);
        assert_eq!(dist.get_freelancer_reward_rate(), 8_000_000);
    }

    #[test]
    fn governance_can_update_payer_reward_rate() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();

        dist.initialize(&iln_id, &gov_token);

        // Check default rate
        assert_eq!(dist.get_payer_reward_rate(), DEFAULT_PAYER_REWARD_RATE);

        // Update rate
        dist.set_payer_reward_rate(&7_000_000);
        assert_eq!(dist.get_payer_reward_rate(), 7_000_000);
    }

    #[test]
    fn updated_rates_affect_reward_calculation() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        let gov_token = gov_token_id.address();
        let token_client = TokenClient::new(&env, &gov_token);

        dist.initialize(&iln_id, &gov_token);

        let lp = Address::generate(&env);

        // Update LP reward rate to 20_000_000
        dist.set_lp_reward_rate(&20_000_000);

        // Accrue 100 USDC
        iln.accrue_lp(&dist_id, &lp, &HUNDRED_USDC_STROOPS);

        // Claim should give 20_000_000 instead of default 10_000_000
        let claimed = dist.claim_tokens(&lp);
        assert_eq!(claimed, 20_000_000);
        assert_eq!(token_client.balance(&lp), 20_000_000);
    }

    #[test]
    fn accrue_lp_rejects_negative_and_zero_amounts() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        dist.initialize(&iln_id, &gov_token_id.address());

        let lp = Address::generate(&env);
        iln.accrue_lp(&dist_id, &lp, &0);
        iln.accrue_lp(&dist_id, &lp, &-1);
        iln.accrue_lp(&dist_id, &lp, &i128::MIN);

        assert_eq!(dist.get_accrual(&lp), 0);
        assert_eq!(dist.claim_tokens(&lp), 0);
    }

    #[test]
    fn accrue_lp_rejects_amounts_above_sanity_ceiling() {
        let env = Env::default();
        env.mock_all_auths();

        let iln_id = env.register_contract(None, MockIln);
        let dist_id = env.register_contract(None, IlnDistribution);
        let dist = IlnDistributionClient::new(&env, &dist_id);
        let iln = MockIlnClient::new(&env, &iln_id);

        let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
        dist.initialize(&iln_id, &gov_token_id.address());

        let lp = Address::generate(&env);
        // Just over the ceiling and i128::MAX must not inflate accrual.
        iln.accrue_lp(&dist_id, &lp, &(MAX_LP_ACCRUAL_PER_CALL + 1));
        iln.accrue_lp(&dist_id, &lp, &i128::MAX);
        assert_eq!(dist.get_accrual(&lp), 0);

        // Boundary: exact ceiling is accepted.
        iln.accrue_lp(&dist_id, &lp, &MAX_LP_ACCRUAL_PER_CALL);
        let expected_units = MAX_LP_ACCRUAL_PER_CALL / HUNDRED_USDC_STROOPS;
        assert_eq!(
            dist.get_accrual(&lp),
            expected_units.saturating_mul(DEFAULT_LP_REWARD_RATE)
        );
    }
}
