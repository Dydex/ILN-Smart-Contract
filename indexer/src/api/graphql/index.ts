import { createYoga, createSchema } from 'graphql-yoga';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { typeDefs } from './schema.js';
import { createResolvers } from './resolvers.js';
import {
  createQueryLimitValidationRule,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_DEPTH,
} from './queryLimits.js';

export interface MountGraphQLOptions {
  /** Enable GraphiQL playground (default: NODE_ENV !== 'production'). */
  dev?: boolean;
  maxDepth?: number;
  maxComplexity?: number;
}

/**
 * Attach the GraphQL endpoint to an Express app.
 *
 * - Endpoint: `POST /graphql` (queries and mutations)
 * - GraphiQL playground: `GET /graphql` in development mode
 * - Depth and complexity limits reject abusive queries before resolvers run
 *
 * @param app  - Express application instance
 * @param db   - SQLite database (same instance used by REST routes)
 * @param optionsOrDev - Options object, or boolean for backward-compatible `dev` flag
 */
export function mountGraphQL(
  app: Express,
  db: Database.Database,
  optionsOrDev:
    | boolean
    | MountGraphQLOptions = process.env['NODE_ENV'] !== 'production'
): void {
  const options: MountGraphQLOptions =
    typeof optionsOrDev === 'boolean' ? { dev: optionsOrDev } : optionsOrDev;
  const dev =
    options.dev ?? process.env['NODE_ENV'] !== 'production';
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;

  const schema = createSchema({
    typeDefs,
    resolvers: createResolvers(db),
  });

  const yoga = createYoga({
    schema,
    graphiql: dev,
    logging: false,
    plugins: [
      {
        onValidate({
          addValidationRule,
        }: {
          addValidationRule: (rule: ReturnType<typeof createQueryLimitValidationRule>) => void;
        }) {
          addValidationRule(
            createQueryLimitValidationRule({ maxDepth, maxComplexity })
          );
        },
      },
    ],
  });
  app.use('/graphql', yoga);
}
