import type { AuthoredEnv } from "@atp/schema";

/**
 * Matrix expansion (research §7.3 / §12): one authored file with a `matrix` becomes N
 * discrete executable units — the cartesian product of its named dimensions. Each unit
 * is separately addressable (`identity.login.matrix#region=us,tier=free`) so an agent can
 * run one cell or all, while the corpus keeps a single authored definition.
 *
 * Expansion is a plan-time concern: `expandUnits` turns a definition into the list of
 * `{ id, matrix, env }` descriptors, then a caller runs each via `runTest`/`runSuite`
 * (passing the unit's `matrix` coords + resolved `env`). The `env: (m) => …` builder from
 * §7.3 (deferred from P1) is resolved here, per cell.
 */

/** One cell of a matrix's cartesian product. */
export interface MatrixCell {
  /** The chosen value per dimension; populates the `{{matrix.*}}` scope. */
  coords: Record<string, unknown>;
  /** Stable id suffix in authored dimension order, e.g. `region=us,tier=free`. */
  key: string;
}

/** A discrete executable unit derived from a (possibly matrixed) test or suite. */
export interface MatrixUnit {
  /** `${baseId}` (no matrix) or `${baseId}#region=us,tier=free` (one per cell). */
  id: string;
  /** Coordinates that populate `{{matrix.*}}`; empty for a non-matrix unit. */
  matrix: Record<string, unknown>;
  /** Env resolved for this cell (authored `env` builder called with the cell's coords),
   *  the static env object, or undefined when none is authored. */
  env?: Record<string, unknown>;
}

/** A dimension value rendered for the cell key — primitives verbatim, objects as JSON. */
function formatValue(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Cartesian product of a matrix's named dimensions, in authored (row-major) order:
 * the last dimension varies fastest. `{ region: ["us","eu"], tier: ["free","pro"] }`
 * → `region=us,tier=free` / `region=us,tier=pro` / `region=eu,tier=free` / … .
 * A matrix with no dimensions yields a single empty cell (the empty product).
 */
export function expandMatrix(matrix: Record<string, unknown[]>): MatrixCell[] {
  let cells: MatrixCell[] = [{ coords: {}, key: "" }];
  for (const [dimension, values] of Object.entries(matrix)) {
    const next: MatrixCell[] = [];
    for (const cell of cells) {
      for (const value of values) {
        const pair = `${dimension}=${formatValue(value)}`;
        next.push({
          coords: { ...cell.coords, [dimension]: value },
          key: cell.key ? `${cell.key},${pair}` : pair,
        });
      }
    }
    cells = next;
  }
  return cells;
}

/** Resolve an authored `env` for a cell: call the builder with the coords, or return the
 *  static object as-is. Shared with the runner so a direct `runTest(test, { matrix })`
 *  resolves a matrix-derived env too. */
export function resolveEnv(
  env: AuthoredEnv | undefined,
  coords: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return typeof env === "function" ? env(coords) : env;
}

/**
 * Enumerate the discrete executable units of an authored test or suite. With no `matrix`
 * (or an empty one) there is a single base unit — the empty product yields one cell with
 * an empty `key`, so the id stays the bare `def.id`; with a `matrix`, one unit per
 * cartesian cell, each carrying its `{{matrix.*}}` coords and per-cell resolved env.
 */
export function expandUnits(def: {
  id: string;
  matrix?: Record<string, unknown[]>;
  env?: AuthoredEnv;
}): MatrixUnit[] {
  return expandMatrix(def.matrix ?? {}).map((cell) => ({
    id: cell.key ? `${def.id}#${cell.key}` : def.id,
    matrix: cell.coords,
    env: resolveEnv(def.env, cell.coords),
  }));
}
