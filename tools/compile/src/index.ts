export const COMPILE_PACKAGE = "@atp/compile";

export function main(): void {
  console.log("[compile] manifest generation lands in P4; no tests to compile yet.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
