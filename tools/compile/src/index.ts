import { resolve } from "node:path";

import { compile, writeManifest, CompileError } from "./compile";

export const COMPILE_PACKAGE = "@atp/compile";
export * from "./compile";
export * from "./discover";

/** `pnpm compile`: build `dist/manifest.json` from the `tests/` corpus at the repo root. */
export async function main(): Promise<void> {
  const root = process.cwd();
  const outPath = resolve(root, "dist/manifest.json");
  try {
    const manifest = await compile({ root });
    await writeManifest(manifest, outPath);
    console.log(
      `[compile] ${manifest.entries.length} entries → ${outPath} (git ${manifest.gitSha})`,
    );
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
