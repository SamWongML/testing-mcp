import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * `atp import` — the deterministic Insomnia-v5-YAML scaffolder (research §13.1, §19).
 *
 * Insomnia YAML is a *source*, never wired into MCP directly: this transform maps the clean,
 * mechanical parts (request → step, folder → suite, environment → `_shared/env`, auth →
 * `_shared/auth`, `{{ _.var }}` tags → `{{env.*}}`/`{{secrets.*}}`) into draft `defineTest`/
 * `defineSuite` modules that compile. The messy remainder — response-ref chaining — is left as
 * a `TODO` for the `import_insomnia_collection` prompt / agent to finish. Pure and offline.
 */

export interface GeneratedFile {
  /** Repo-relative path under `tests/` (the CLI writes it; a test compiles it in a tmp root). */
  path: string;
  content: string;
}

/** One Insomnia-source → IR-target row, tabulated into `MIGRATION.md` for incremental cutover. */
export interface MappingEntry {
  /** The Insomnia resource's meta id (e.g. `req_login`), or a synthetic id when absent. */
  insomniaId: string;
  insomniaName: string;
  /** The IR id: a test/suite id, or `<suiteId>#<nodeId>` for a suite node. */
  irId: string;
  kind: "test" | "suite" | "node";
  /** The generated source file this maps into. */
  path: string;
}

export interface ImportResult {
  files: GeneratedFile[];
  mapping: MappingEntry[];
}

/** Lowercase kebab slug for names → file/id segments ("Get Invoice" → "get-invoice"). */
function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

/** An Insomnia response-ref / request tag (`{% response ... %}`) — the chaining "messy
 *  remainder" the deterministic importer cannot resolve; it becomes a TODO placeholder. */
const RESPONSE_TAG = /\{%[\s\S]*?%\}/;
const CHAIN_PLACEHOLDER = "__TODO_CHAIN__";

/** Map Insomnia template tags: `{{ _.foo }}` → `{{env.foo}}`, and any `{% ... %}` response-ref
 *  tag → a `__TODO_CHAIN__` placeholder (the agent/prompt wires the real chain). */
function mapTemplateTags(text: string): string {
  return text
    .replace(/\{\{\s*_\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => `{{env.${name}}}`)
    .replace(new RegExp(RESPONSE_TAG, "g"), CHAIN_PLACEHOLDER);
}

/** Render an object key: bare when it's a valid identifier, quoted otherwise (corpus style). */
function objKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Render a JSON-ish value as a pretty TS object literal (bare identifier keys, `{{...}}`
 *  templates preserved as strings). Used for request headers/body in the generated source. */
function renderLiteral(value: unknown, indent = ""): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = value.map((v) => `${indent}  ${renderLiteral(v, `${indent}  `)}`).join(",\n");
    return `[\n${inner},\n${indent}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const inner = entries
      .map(([k, v]) => `${indent}  ${objKey(k)}: ${renderLiteral(v, `${indent}  `)}`)
      .join(",\n");
    return `{\n${inner},\n${indent}}`;
  }
  return "undefined";
}

/** camelCase / kebab → UPPER_SNAKE for a `{{secrets.*}}` key ("apiToken" → "API_TOKEN"). */
function upperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

interface InsomniaHeader {
  name?: string;
  value?: string;
}

interface InsomniaBody {
  mimeType?: string;
  text?: string;
}

interface InsomniaAuth {
  type?: string;
  token?: string;
}

interface InsomniaRequest {
  name?: string;
  url?: string;
  method?: string;
  headers?: InsomniaHeader[];
  body?: InsomniaBody;
  authentication?: InsomniaAuth;
  meta?: { id?: string };
  /** A folder / request group carries children instead of a method (→ a `defineSuite`). */
  children?: InsomniaRequest[];
}

/** True if any part of a raw request still carries an Insomnia `{% ... %}` response-ref tag. */
function hasResponseTag(req: InsomniaRequest): boolean {
  const parts = [
    req.url ?? "",
    req.body?.text ?? "",
    ...(req.headers ?? []).map((h) => h.value ?? ""),
  ];
  return parts.some((p) => RESPONSE_TAG.test(p));
}

interface InsomniaEnvironment {
  name?: string;
  data?: Record<string, unknown>;
}

/** Header array → a lowercased-key object with template tags mapped (HTTP is case-insensitive). */
function mapHeaders(headers: InsomniaHeader[] | undefined): Record<string, string> | undefined {
  if (!headers?.length) return undefined;
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name) out[h.name.toLowerCase()] = mapTemplateTags(h.value ?? "");
  }
  return Object.keys(out).length ? out : undefined;
}

/** Insomnia request body → a JS value: a JSON body becomes an object literal (tags mapped);
 *  any other text stays a mapped string. Absent/empty bodies yield `undefined`. */
function mapBody(body: InsomniaBody | undefined): unknown {
  if (!body || typeof body.text !== "string" || body.text.trim() === "") return undefined;
  const mapped = mapTemplateTags(body.text);
  if ((body.mimeType ?? "").includes("json")) {
    try {
      return JSON.parse(mapped);
    } catch {
      return mapped;
    }
  }
  return mapped;
}

/** The `{{secrets.*}}` template for a bearer token, keyed off the referenced Insomnia var. */
function tokenSecret(domain: string, token: string | undefined): string {
  const ref = token?.match(/\{\{\s*_\.([a-zA-Z0-9_]+)\s*\}\}/);
  const key = ref ? upperSnake(ref[1]!) : `${upperSnake(domain)}_TOKEN`;
  return `{{secrets.${key}}}`;
}

/** Build the IR `request` object for one Insomnia request (shared by tests and suite nodes). */
function mapRequest(domain: string, req: InsomniaRequest): Record<string, unknown> {
  const request: Record<string, unknown> = {
    method: (req.method ?? "GET").toUpperCase(),
    url: mapTemplateTags(req.url ?? ""),
  };
  const headers = mapHeaders(req.headers);
  if (headers) request.headers = headers;
  if (req.authentication?.type === "bearer") request.authRef = domain;
  const body = mapBody(req.body);
  if (body !== undefined) request.body = body;
  return request;
}

/** Emit a `defineTest` module for one top-level Insomnia request, with its mapping row. */
function emitTest(
  domain: string,
  req: InsomniaRequest,
): { file: GeneratedFile; mapping: MappingEntry } {
  const name = slug(req.name ?? "request");
  const id = `${domain}.${name}`;
  const path = `tests/${domain}/${name}.test.ts`;
  // 6-space base indent: the `request:` key sits 6 columns in (steps[0] → request).
  const request = renderLiteral(mapRequest(domain, req), "      ");

  const content = `import { defineTest } from "@atp/engine";

import { ${domain} } from "../_shared/env/${domain}";

export default defineTest({
  id: "${id}",
  version: 1,
  title: ${JSON.stringify(req.name ?? name)},
  tags: [${JSON.stringify(domain)}],
  env: ${domain},
  steps: [
    {
      id: "${name}",
      request: ${request},
      assert: [{ path: "status", op: "lt", value: 500 }],
    },
  ],
});
`;
  const mapping: MappingEntry = {
    insomniaId: req.meta?.id ?? name,
    insomniaName: req.name ?? name,
    irId: id,
    kind: "test",
    path,
  };
  return { file: { path, content }, mapping };
}

/** Emit a `defineSuite` module for one Insomnia folder / request group (§13.1). Each child
 *  request becomes an inline node; a child that used a response-ref tag gets a TODO comment. */
function emitSuite(
  domain: string,
  folder: InsomniaRequest,
): { file: GeneratedFile; mapping: MappingEntry[] } {
  const folderName = slug(folder.name ?? "suite");
  const id = `${domain}.${folderName}`;
  const path = `tests/${domain}/${folderName}.suite.ts`;
  const children = (folder.children ?? []).filter((c) => c.method);

  const nodes = children
    .map((child) => {
      const key = slug(child.name ?? "request");
      const request = renderLiteral(mapRequest(domain, child), "      ");
      const todo = hasResponseTag(child)
        ? `    // TODO(migrate): "${key}" used an Insomnia response ref — replace ${CHAIN_PLACEHOLDER} by\n` +
          `    // wiring \`extract\` on the source node + \`{{nodes.<id>.<var>}}\` here (and \`needs\`).\n` +
          `    // See the import_insomnia_collection prompt.\n`
        : "";
      return (
        `${todo}    ${JSON.stringify(key)}: {\n` +
        `      request: ${request},\n` +
        `      assert: [{ path: "status", op: "lt", value: 500 }],\n` +
        `    },`
      );
    })
    .join("\n");

  const mapping: MappingEntry[] = [
    {
      insomniaId: folder.meta?.id ?? folderName,
      insomniaName: folder.name ?? folderName,
      irId: id,
      kind: "suite",
      path,
    },
    ...children.map((child): MappingEntry => {
      const key = slug(child.name ?? "request");
      return {
        insomniaId: child.meta?.id ?? key,
        insomniaName: child.name ?? key,
        irId: `${id}#${key}`,
        kind: "node",
        path,
      };
    }),
  ];

  const content = `import { defineSuite } from "@atp/engine";

import { ${domain} } from "../_shared/env/${domain}";

export default defineSuite({
  id: "${id}",
  version: 1,
  title: ${JSON.stringify(folder.name ?? folderName)},
  tags: [${JSON.stringify(domain)}],
  env: ${domain},
  nodes: {
${nodes}
  },
});
`;
  return { file: { path, content }, mapping };
}

/** Emit `tests/_shared/auth/<domain>.ts` — a reusable bearer provider (§13.1). */
function emitAuth(domain: string, token: string | undefined): GeneratedFile {
  const content = `import { bearerAuth } from "@atp/engine";

export const ${domain} = bearerAuth({
  id: "${domain}",
  token: "${tokenSecret(domain, token)}",
});
`;
  return { path: `tests/_shared/auth/${domain}.ts`, content };
}

/** Emit `tests/_shared/env/<domain>.ts` from the collection's environment data (§13.1). */
function emitEnv(domain: string, env: InsomniaEnvironment): GeneratedFile {
  const data = env.data ?? {};
  const entries = Object.entries(data)
    .map(([k, v]) => `  ${objKey(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  const content = `import { defineEnv } from "@atp/engine";

export const ${domain} = defineEnv({
${entries}
});
`;
  return { path: `tests/_shared/env/${domain}.ts`, content };
}

/** Depth-first search for the first bearer token across requests and their folder children. */
function firstBearerToken(items: InsomniaRequest[]): { found: boolean; token?: string } {
  for (const item of items) {
    if (item.authentication?.type === "bearer")
      return { found: true, token: item.authentication.token };
    if (item.children) {
      const nested = firstBearerToken(item.children);
      if (nested.found) return nested;
    }
  }
  return { found: false };
}

/** Parse an Insomnia v5 YAML export and scaffold draft `defineTest`/`defineSuite` modules. */
export function importInsomnia(yamlText: string): ImportResult {
  const doc = parseYaml(yamlText) as {
    name?: string;
    collection?: InsomniaRequest[];
    environments?: InsomniaEnvironment;
  };
  const domain = slug(doc.name ?? "imported");
  const collection = doc.collection ?? [];
  const files: GeneratedFile[] = [];
  const mapping: MappingEntry[] = [];

  files.push(emitEnv(domain, doc.environments ?? {}));

  for (const item of collection) {
    if (item.children) {
      const { file, mapping: rows } = emitSuite(domain, item);
      files.push(file);
      mapping.push(...rows);
    } else if (item.method) {
      const { file, mapping: row } = emitTest(domain, item);
      files.push(file);
      mapping.push(row);
    }
  }

  // A single reusable bearer provider per collection, from the first bearer request found.
  const bearer = firstBearerToken(collection);
  if (bearer.found) files.push(emitAuth(domain, bearer.token));

  return { files, mapping };
}

/** Render `MIGRATION.md` — the Insomnia-id → IR-id mapping table for incremental cutover (§19). */
export function renderMigration(mapping: MappingEntry[], source: string): string {
  const rows = mapping
    .map(
      (m) => `| \`${m.insomniaId}\` | ${m.insomniaName} | \`${m.irId}\` | ${m.kind} | ${m.path} |`,
    )
    .join("\n");
  return `# Migration — Insomnia → IR

Generated by \`atp import ${source}\`. Insomnia YAML is a *source*, converted into the typed IR
(research §19). Track cutover here and retire the Insomnia file once the namespace reaches parity.

| Insomnia id | Insomnia name | IR id | kind | source |
|---|---|---|---|---|
${rows}
`;
}

/** Result of an `atp import`: the repo-relative paths written and the migration mapping. */
export interface WriteImportResult {
  written: string[];
  mapping: MappingEntry[];
}

/** Read an Insomnia YAML export, scaffold the IR drafts + `MIGRATION.md`, and write them under
 *  `root`. The `atp import` CLI command layer; the pure transform is {@link importInsomnia}. */
export async function writeImport(yamlPath: string, root: string): Promise<WriteImportResult> {
  const yamlText = await readFile(resolve(yamlPath), "utf8");
  const { files, mapping } = importInsomnia(yamlText);

  const written: string[] = [];
  for (const file of [
    ...files,
    { path: "MIGRATION.md", content: renderMigration(mapping, yamlPath) },
  ]) {
    const target = resolve(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
    written.push(file.path);
  }
  return { written, mapping };
}
