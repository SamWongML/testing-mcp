/**
 * DAG helpers for suite composition (research §12). A suite is a set of nodes, each
 * with `needs` edges; the runner executes them in dependency order and can run
 * independent branches in parallel. `topoSort` validates the graph — duplicate ids,
 * `needs` pointing at unknown nodes, and cycles are authoring mistakes surfaced here
 * (compile-time in P4) rather than mid-run — and returns a deterministic topological
 * ordering via Kahn's algorithm, ties broken by authored order.
 */

export interface GraphNode {
  id: string;
  needs?: string[];
}

/**
 * Return the node ids in a valid dependency order (each node after everything it
 * `needs`). Throws with a clear message on duplicate ids, unknown `needs`, or a cycle.
 */
export function topoSort(nodes: GraphNode[]): string[] {
  const ids: string[] = [];
  const idSet = new Set<string>();
  for (const node of nodes) {
    if (idSet.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
    idSet.add(node.id);
    ids.push(node.id);
  }

  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (!idSet.has(need)) {
        throw new Error(`node "${node.id}" needs unknown node "${need}"`);
      }
      indegree.set(node.id, (indegree.get(node.id) as number) + 1);
      (dependents.get(need) as string[]).push(node.id);
    }
  }

  // Kahn's algorithm: drain nodes whose dependencies are all satisfied, keeping
  // authored order among those that become ready at the same time.
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dep of dependents.get(id) as string[]) {
      const remaining = (indegree.get(dep) as number) - 1;
      indegree.set(dep, remaining);
      if (remaining === 0) ready.push(dep);
    }
  }

  if (order.length !== ids.length) {
    const inCycle = ids.filter((id) => (indegree.get(id) as number) > 0);
    throw new Error(`suite graph has a cycle involving: ${inCycle.join(", ")}`);
  }
  return order;
}
