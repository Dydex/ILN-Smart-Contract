/**
 * Integration test for insurance pool SDK — exercises the full flow against a local Stellar node.
 *
 * This test is skipped by default and only runs when provided with:
 *   - STELLAR_RPC_URL: deployed Stellar node RPC endpoint
 *   - INSURANCE_POOL_ID: deployed insurance pool contract ID
 *   - Funded test account keypairs (via TEST_ACCOUNT_SECRET)
 */

import { SorobanRpc, Keypair, Account, Networks, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import {
  getPoolBalance,
  getCoverage,
  isEnrolled,
  getPremiumsPaid,
  getInsurancePoolInfo,
  enrollInsurancePool,
  depositInsurancePremium,
  claimInsurance,
  isInsuranceClaimed,
  getBasePremiumRateBps,
  getDefaultCount,
  calculateInsurancePremiumRateBps,
  calculateInsurancePremiumAmount,
  getInsuranceTieredCoverage,
  getInsuranceBalanceCap,
  setBasePremiumRateViaGovernance,
} from "../../src/methods/insurance.js";

const RPC_URL = process.env.STELLAR_RPC_URL || "http://localhost:8000";
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const INSURANCE_POOL_ID = process.env.INSURANCE_POOL_ID;
const TEST_ACCOUNT_SECRET = process.env.TEST_ACCOUNT_SECRET;

const shouldRun = Boolean(INSURANCE_POOL_ID && TEST_ACCOUNT_SECRET);

(shouldRun ? describe : describe.skip)("Insurance Pool SDK - Integration Tests", () => {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
  let testAccount: Account;
  let lp: Keypair;

  beforeAll(async () => {
    const funder = Keypair.fromSecret(TEST_ACCOUNT_SECRET as string);
    testAccount = await server.getAccount(funder.publicKey());
    lp = Keypair.random();
  });

  function sign(tx: any) {
    const funder = Keypair.fromSecret(TEST_ACCOUNT_SECRET as string);
    tx.sign(funder);
    return tx;
  }

  it("queries pool balance", async () => {
    const balance = await getPoolBalance(server, INSURANCE_POOL_ID as string, NETWORK_PASSPHRASE);
    expect(typeof balance).toBe("bigint");
    expect(balance).toBeGreaterThanOrEqual(0n);
  });

  it("queries coverage cap", async () => {
    const coverage = await getCoverage(server, INSURANCE_POOL_ID as string, NETWORK_PASSPHRASE);
    expect(typeof coverage).toBe("bigint");
    expect(coverage).toBeGreaterThan(0n);
  });

  it("checks enrollment status for an LP", async () => {
    const enrolled = await isEnrolled(server, INSURANCE_POOL_ID as string, lp.publicKey(), NETWORK_PASSPHRASE);
    expect(typeof enrolled).toBe("boolean");
  });

  it("retrieves combined pool info", async () => {
    const info = await getInsurancePoolInfo(
      server,
      INSURANCE_POOL_ID as string,
      lp.publicKey(),
      NETWORK_PASSPHRASE
    );
    expect(info).toHaveProperty("poolBalance");
    expect(info).toHaveProperty("coverage");
    expect(info).toHaveProperty("isEnrolled");
    expect(info).toHaveProperty("premiumsPaid");
  });

  it("reads base premium rate", async () => {
    const rate = await getBasePremiumRateBps(server, INSURANCE_POOL_ID as string, NETWORK_PASSPHRASE);
    expect(typeof rate).toBe("number");
    expect(rate).toBeGreaterThanOrEqual(0);
  });

  it("calculates premium rate for an LP", async () => {
    const rate = await calculateInsurancePremiumRateBps(
      server,
      INSURANCE_POOL_ID as string,
      lp.publicKey(),
      NETWORK_PASSPHRASE
    );
    expect(typeof rate).toBe("number");
    expect(rate).toBeGreaterThanOrEqual(0);
  });

  it("checks if an invoice claim was already processed", async () => {
    const claimed = await isInsuranceClaimed(server, INSURANCE_POOL_ID as string, 42n, NETWORK_PASSPHRASE);
    expect(typeof claimed).toBe("boolean");
  });

  it("retrieves tiered coverage for an LP", async () => {
    const coverage = await getInsuranceTieredCoverage(
      server,
      INSURANCE_POOL_ID as string,
      lp.publicKey(),
      NETWORK_PASSPHRASE
    );
    expect(typeof coverage).toBe("bigint");
    expect(coverage).toBeGreaterThanOrEqual(0n);
  });

  it("retrieves optional balance cap", async () => {
    const cap = await getInsuranceBalanceCap(server, INSURANCE_POOL_ID as string, NETWORK_PASSPHRASE);
    expect(cap === null || typeof cap === "bigint").toBe(true);
  });

  it("retrieves default count for an LP", async () => {
    const count = await getDefaultCount(server, INSURANCE_POOL_ID as string, lp.publicKey(), NETWORK_PASSPHRASE);
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("calculates premium amount for an invoice", async () => {
    const amount = await calculateInsurancePremiumAmount(
      server,
      INSURANCE_POOL_ID as string,
      lp.publicKey(),
      1000n,
      NETWORK_PASSPHRASE
    );
    expect(typeof amount).toBe("bigint");
    expect(amount).toBeGreaterThanOrEqual(0n);
  });

  it("retrieves premiums paid by an LP", async () => {
    const premiums = await getPremiumsPaid(
      server,
      INSURANCE_POOL_ID as string,
      lp.publicKey(),
      NETWORK_PASSPHRASE
    );
    expect(typeof premiums).toBe("bigint");
    expect(premiums).toBeGreaterThanOrEqual(0n);
  });
});
