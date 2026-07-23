/** True when every item has a distinct `id` — the addressing key for DAG nodes,
 * `{{nodes.X.*}}` templates, and manifest lookup. Used as a Zod array refinement. */
export function uniqueById(items: ReadonlyArray<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}
