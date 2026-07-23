import { compileToFile, CompileError } from "./compile";

export const COMPILE_PACKAGE = "@atp/compile";
export * from "./compile";
export * from "./discover";

/** `pnpm compile`: build `dist/manifest.json` from the `tests/` corpus at the repo root. */
export async function main(): Promise<void> {
  try {
    const { manifest, outPath } = await compileToFile(process.cwd());
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
