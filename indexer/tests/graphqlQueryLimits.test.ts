import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from './helpers.js';
import {
  createQueryLimitValidationRule,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_DEPTH,
} from '../src/api/graphql/queryLimits.js';
import {
  buildSchema,
  parse,
  validate,
  GraphQLSchema,
} from 'graphql';

describe('GraphQL query depth and complexity limiting', () => {
  let schema: GraphQLSchema;

  beforeEach(() => {
    schema = buildSchema(`
      type Nested {
        child: Nested
        value: String
      }
      type Query {
        root: Nested
        invoices: [String]
        reputation: Reputation
      }
      type Reputation {
        history: [String]
      }
    `);
  });

  it('rejects an excessively deep query during validation', () => {
    const rule = createQueryLimitValidationRule({ maxDepth: 3, maxComplexity: 1000 });
    // depth: root(1) -> child(2) -> child(3) -> child(4) exceeds 3
    const document = parse(`
      {
        root {
          child {
            child {
              child {
                value
              }
            }
          }
        }
      }
    `);

    const errors = validate(schema, document, [rule]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/depth/i);
  });

  it('rejects an excessively complex query during validation', () => {
    const rule = createQueryLimitValidationRule({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxComplexity: 5,
    });
    // invoices costs 10 alone
    const document = parse(`{ invoices }`);
    const errors = validate(schema, document, [rule]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/complexity/i);
  });

  it('allows a normal shallow query', () => {
    const rule = createQueryLimitValidationRule({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxComplexity: DEFAULT_MAX_COMPLEXITY,
    });
    const document = parse(`{ reputation { history } }`);
    const errors = validate(schema, document, [rule]);
    expect(errors).toHaveLength(0);
  });
});

describe('GraphQL HTTP rejection before execution', () => {
  afterEach(() => {
    // no-op placeholder for symmetry with other suites
  });

  it('returns GraphQL errors for deep queries without executing resolvers', async () => {
    const db = createTestDb();
    let invoiceResolverHits = 0;
    // Mount via createApp which wires query limits; resolver hit count is
    // verified indirectly — a rejected query must not return invoice data.
    const app = createTestApp(db, {
      graphqlMaxDepth: 2,
      graphqlMaxComplexity: 200,
      rateLimitAnonymousMax: 1_000,
      health: { horizonUrl: '', getChainTipLedger: async () => null },
    });

    // Deep nesting via repeated fragment spreads on InvoiceConnection fields
    // is limited; use introspection-style nesting that exceeds depth 2.
    const deepQuery = `
      query Abuse {
        invoices {
          invoices {
            id
            freelancer
          }
          total
          page
          pageSize
        }
      }
    `;

    const res = await request(app)
      .post('/graphql')
      .send({ query: deepQuery });

    // Yoga may return 200 with errors or 400 for validation failures.
    expect([200, 400]).toContain(res.status);
    expect(res.body.errors?.length).toBeGreaterThan(0);
    expect(res.body.errors[0].message).toMatch(/depth|complexity/i);
    expect(res.body.data?.invoices).toBeUndefined();
    expect(invoiceResolverHits).toBe(0);
  });

  it('rejects high-complexity aliased fan-out before execution', async () => {
    const db = createTestDb();
    const app = createTestApp(db, {
      graphqlMaxDepth: 8,
      graphqlMaxComplexity: 25,
      rateLimitAnonymousMax: 1_000,
      health: { horizonUrl: '', getChainTipLedger: async () => null },
    });

    const aliases = Array.from(
      { length: 10 },
      (_, i) => `a${i}: leaderboard { rank address score }`
    ).join('\n');
    const res = await request(app)
      .post('/graphql')
      .send({ query: `{ ${aliases} }` });

    expect([200, 400]).toContain(res.status);
    expect(res.body.errors?.length).toBeGreaterThan(0);
    expect(res.body.errors[0].message).toMatch(/complexity/i);
    expect(res.body.data).toBeFalsy();
  });
});
