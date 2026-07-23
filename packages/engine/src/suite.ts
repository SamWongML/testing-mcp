import type { AuthoredStep, AuthoredSuite, AuthoredSuiteNode } from "@atp/schema";

import { topoSort } from "./graph";
import { resolveParams } from "./params";

/**
 * Suite normalization (research §7.2 / §12): flatten an authored suite's node map into
 * an ordered, executable plan the DAG runner consumes.
 *
 * Each authored node — a `useTest` reference, a `useStep` reference, or an inline step —
 * becomes one `PlanNode`: the map key is its `id` (the addressing key for `needs` and
 * `{{nodes.X.var}}`), its `needs` carry over, and its executable `step` is re-keyed to
 * that id. A node's `params` bag scopes `{{params.*}}` for that node only: a `useTest`
 * node resolves its reused test's params (defaults applied); a `useStep` node exposes
 * its bound `with` inputs; an inline node has none. Ordering and structural validation
 * (cycles, unknown/duplicate `needs`) are delegated to `topoSort`.
 */
export interface PlanNode {
  id: string;
  needs: string[];
  /** The executable step, re-keyed to the node id. */
  step: AuthoredStep;
  /** Per-node `{{params.*}}` scope (reused-test params or bound `with` inputs). */
  params: Record<string, unknown>;
}

function toPlanNode(id: string, node: AuthoredSuiteNode): PlanNode {
  if ("use" in node) {
    if (node.use === "test") {
      const { test } = node;
      if (test.steps.length !== 1) {
        throw new Error(
          `useTest("${test.id}") in node "${id}": only single-step tests can be composed for now`,
        );
      }
      const step = test.steps[0] as AuthoredStep;
      return {
        id,
        needs: node.needs ?? [],
        step: { ...step, id },
        params: resolveParams(test, node.params),
      };
    }
    return {
      id,
      needs: node.needs ?? [],
      step: { ...node.step, id },
      params: { ...(node.with ?? {}) },
    };
  }
  return { id, needs: node.needs ?? [], step: { ...node, id }, params: {} };
}

/** Flatten an authored suite into its executable plan, in topological order. */
export function planSuite(suite: AuthoredSuite): PlanNode[] {
  const nodes = Object.entries(suite.nodes).map(([id, node]) => toPlanNode(id, node));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return topoSort(nodes).map((id) => byId.get(id) as PlanNode);
}
