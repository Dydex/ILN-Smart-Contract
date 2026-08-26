import {
  GraphQLError,
  type ASTVisitor,
  type ValidationContext,
  type ValidationRule,
  Kind,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * Schema-aware defaults for the ILN indexer GraphQL API.
 *
 * Useful query depth is shallow (Query → ReputationScore → history ≈ 3).
 * We allow a small buffer for fragments/aliases while rejecting nesting bombs.
 */
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_COMPLEXITY = 200;

export interface QueryLimitOptions {
  maxDepth?: number;
  maxComplexity?: number;
}

/** Field cost map: expensive list/history fields cost more than scalars. */
const FIELD_COMPLEXITY: Record<string, number> = {
  invoices: 10,
  invoice: 2,
  reputation: 5,
  history: 8,
  leaderboard: 10,
  stats: 5,
  governanceProposals: 1,
};

function fieldCost(fieldName: string): number {
  return FIELD_COMPLEXITY[fieldName] ?? 1;
}

function measureDepth(
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  depth: number,
  visitedFragments: Set<string>
): number {
  if (!selectionSet) {
    return depth;
  }

  let max = depth;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection as FieldNode;
      if (field.name.value.startsWith('__')) {
        continue;
      }
      max = Math.max(
        max,
        measureDepth(field.selectionSet, fragments, depth + 1, visitedFragments)
      );
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inline = selection as InlineFragmentNode;
      max = Math.max(
        max,
        measureDepth(inline.selectionSet, fragments, depth, visitedFragments)
      );
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const spread = selection as FragmentSpreadNode;
      const name = spread.name.value;
      if (visitedFragments.has(name)) {
        continue;
      }
      visitedFragments.add(name);
      const frag = fragments.get(name);
      if (frag) {
        max = Math.max(
          max,
          measureDepth(frag.selectionSet, fragments, depth, visitedFragments)
        );
      }
      visitedFragments.delete(name);
    }
  }
  return max;
}

function measureComplexity(
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  visitedFragments: Set<string>
): number {
  if (!selectionSet) {
    return 0;
  }

  let total = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection as FieldNode;
      if (field.name.value.startsWith('__')) {
        continue;
      }
      total += fieldCost(field.name.value);
      total += measureComplexity(field.selectionSet, fragments, visitedFragments);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inline = selection as InlineFragmentNode;
      total += measureComplexity(inline.selectionSet, fragments, visitedFragments);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const spread = selection as FragmentSpreadNode;
      const name = spread.name.value;
      if (visitedFragments.has(name)) {
        continue;
      }
      visitedFragments.add(name);
      const frag = fragments.get(name);
      if (frag) {
        total += measureComplexity(frag.selectionSet, fragments, visitedFragments);
      }
      visitedFragments.delete(name);
    }
  }
  return total;
}

/**
 * GraphQL validation rule that rejects queries exceeding depth or complexity
 * limits before resolvers execute.
 */
export function createQueryLimitValidationRule(
  options: QueryLimitOptions = {}
): ValidationRule {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;

  return function QueryLimitRule(context: ValidationContext): ASTVisitor {
    const fragments = new Map<string, FragmentDefinitionNode>();

    return {
      FragmentDefinition(node) {
        fragments.set(node.name.value, node);
        return false;
      },
      Document: {
        leave(node) {
          for (const definition of node.definitions) {
            if (definition.kind !== Kind.OPERATION_DEFINITION) {
              continue;
            }
            const op = definition as OperationDefinitionNode;
            const depth = measureDepth(
              op.selectionSet,
              fragments,
              0,
              new Set()
            );
            if (depth > maxDepth) {
              context.reportError(
                new GraphQLError(
                  `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}.`,
                  { nodes: [op] }
                )
              );
            }

            const complexity = measureComplexity(
              op.selectionSet,
              fragments,
              new Set()
            );
            if (complexity > maxComplexity) {
              context.reportError(
                new GraphQLError(
                  `Query complexity ${complexity} exceeds maximum allowed complexity of ${maxComplexity}.`,
                  { nodes: [op] }
                )
              );
            }
          }
        },
      },
    };
  };
}
