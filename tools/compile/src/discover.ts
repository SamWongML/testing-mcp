import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Filesystem discovery (research §9): find every authored test/suite file under a
 * directory. The convention is the whole mechanism — every executable test is
 * `*.test.ts`, every composition is `*.suite.ts`, so discovery never guesses and adding
 * a test is just dropping a conforming file. Results are sorted for a deterministic
 * manifest (stable ordering → stable `manifestHash`).
 */

/** Match the `*.test.ts` / `*.suite.ts` naming convention. */
function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts") || name.endsWith(".suite.ts");
}

/** Recursively list absolute paths of authored test/suite files under `dir`, sorted. A
 *  missing directory yields an empty list (an empty corpus is not an error). */
export async function discover(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discover(full)));
    } else if (entry.isFile() && isTestFile(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}
