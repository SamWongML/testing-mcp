#!/usr/bin/env node
import { compileToFile, CompileError } from "@atp/compile";

import { formatList, formatResult, listEntries, runById, validate } from "./commands";

export const CLI_PACKAGE = "@atp/cli";
export * from "./commands";
export * from "./mock-sut";

const USAGE = `atp — API testing platform CLI

Usage:
  atp compile                       build dist/manifest.json from tests/
  atp list [--tags a,b] [--owner o] [--kind test|suite]
  atp run <id> [--params '<json>'] [--env name]
  atp validate                      compile in-memory; fail on any error
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      // Accept both `--flag value` and `--flag=value`.
      const eq = arg.indexOf("=");
      if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = argv[++i] ?? "";
    } else positional.push(arg);
  }
  return { positional, flags };
}

/** Dispatch a parsed command line against the corpus at `root`. Returns the exit code.
 *  `root` is injectable for tests; the real CLI passes `process.cwd()` (see below). */
export async function run(argv: string[], root: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  try {
    switch (command) {
      case "compile": {
        const { manifest, outPath } = await compileToFile(root);
        console.log(
          `[compile] ${manifest.entries.length} entries → ${outPath} (git ${manifest.gitSha})`,
        );
        return 0;
      }

      case "list": {
        const entries = await listEntries({
          root,
          tags: flags.tags ? flags.tags.split(",") : undefined,
          owner: flags.owner,
          kind: flags.kind === "test" || flags.kind === "suite" ? flags.kind : undefined,
        });
        console.log(formatList(entries));
        return 0;
      }

      case "validate": {
        const { entries } = await validate(root);
        console.log(`ok — ${entries} entries compile cleanly`);
        return 0;
      }

      case "run": {
        const id = positional[0];
        if (!id) {
          console.error("atp run: missing <id>\n");
          console.error(USAGE);
          return 1;
        }
        const result = await runById(id, {
          root,
          params: flags.params ? (JSON.parse(flags.params) as Record<string, unknown>) : undefined,
          envName: flags.env || undefined,
        });
        console.log(formatResult(result));
        return result.status === "passed" ? 0 : 1;
      }

      default:
        console.log(USAGE);
        return command ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.message);
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
