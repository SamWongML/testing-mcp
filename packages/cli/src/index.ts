#!/usr/bin/env node
import { compileToFile, CompileError } from "@atp/compile";
import { isReportFormat, REPORT_FORMATS } from "@atp/reporting";

import {
  captureGolden,
  formatGolden,
  formatList,
  formatResult,
  listEntries,
  runById,
  validate,
  writeReport,
} from "./commands";
import { writeImport } from "./import";

export const CLI_PACKAGE = "@atp/cli";
export * from "./commands";
export * from "./golden";
export * from "./import";
export * from "./mock-sut";
export * from "./strict";

const USAGE = `atp — API testing platform CLI

Usage:
  atp compile                       build dist/manifest.json from tests/
  atp list [--tags a,b] [--owner o] [--kind test|suite]
  atp run <id> [--params '<json>'] [--env name] [--report md|html|junit|json|summary] [--out path]
  atp validate                      compile in-memory; fail on a compile error, an unwired
                                    __TODO_CHAIN__, or a node asserting nothing (or only a
                                    range op on status, the atp import placeholder)
  atp import <insomnia.yaml>        scaffold defineTest/defineSuite drafts + MIGRATION.md
  atp golden <id> --base-url <url>  run once against a real SUT; print parity assertions
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
        const { entries, violations } = await validate(root);
        if (violations.length > 0) {
          for (const v of violations) {
            console.error(`${v.entryId}#${v.nodeId} [${v.rule}] ${v.detail}`);
          }
          console.error(
            `\n${violations.length} violation(s) — finish the migration (wire the chain refs, ` +
              `then \`atp golden <id>\` for real parity assertions).`,
          );
          return 1;
        }
        console.log(`ok — ${entries} entries compile cleanly and assert strictly`);
        return 0;
      }

      case "import": {
        const yamlPath = positional[0];
        if (!yamlPath) {
          console.error("atp import: missing <insomnia.yaml>\n");
          console.error(USAGE);
          return 1;
        }
        const { written, mapping } = await writeImport(yamlPath, root);
        console.log(
          `[import] ${mapping.length} entr${mapping.length === 1 ? "y" : "ies"} → ${written.length} file(s):`,
        );
        for (const path of written) console.log(`  ${path}`);
        console.log(
          "Next: wire the __TODO_CHAIN__ refs, capture parity assertions with " +
            "`atp golden <id> --base-url <url>`, then `atp validate` until it is clean.",
        );
        return 0;
      }

      case "golden": {
        const id = positional[0];
        if (!id) {
          console.error("atp golden: missing <id>\n");
          console.error(USAGE);
          return 1;
        }
        const { blocks, missing } = await captureGolden(id, {
          root,
          baseUrl: flags["base-url"] || undefined,
          params: flags.params ? (JSON.parse(flags.params) as Record<string, unknown>) : undefined,
          envName: flags.env || undefined,
        });
        console.log(formatGolden(blocks));
        if (missing.length > 0) {
          console.error(
            `\natp golden: ${missing.length} node(s) never executed, so no baseline exists ` +
              `for them: ${missing.join(", ")}. Fix the run, then capture again.`,
          );
          return 1;
        }
        return 0;
      }

      case "run": {
        const id = positional[0];
        if (!id) {
          console.error("atp run: missing <id>\n");
          console.error(USAGE);
          return 1;
        }
        if (flags.report && !isReportFormat(flags.report)) {
          console.error(
            `atp run: unknown --report format "${flags.report}" (expected: ${REPORT_FORMATS.join(", ")})`,
          );
          return 1;
        }
        const result = await runById(id, {
          root,
          params: flags.params ? (JSON.parse(flags.params) as Record<string, unknown>) : undefined,
          envName: flags.env || undefined,
        });
        console.log(formatResult(result));
        if (flags.report && isReportFormat(flags.report)) {
          const path = await writeReport(result, flags.report, flags.out || undefined);
          console.log(`[report] ${flags.report} → ${path}`);
        }
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
