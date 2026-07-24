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

/** An Insomnia variable tag: `{{ _.foo }}` → the `foo` capture. */
const INSOMNIA_VAR_TAG = /\{\{\s*_\.([a-zA-Z0-9_]+)\s*\}\}/;
/** An Insomnia response-ref / request tag (`{% response ... %}`) — the chaining "messy
 *  remainder" the deterministic importer cannot resolve; it becomes a TODO placeholder. */
const RESPONSE_TAG = /\{%[\s\S]*?%\}/;
const CHAIN_PLACEHOLDER = "__TODO_CHAIN__";
/** The placeholder assertion every scaffolded request carries until golden-master parity
 *  assertions replace it (a request that merely didn't 5xx — deliberately weak, see §19). */
const STATUS_ASSERT = `[{ path: "status", op: "lt", value: 500 }]`;

/** Map Insomnia template tags: `{{ _.foo }}` → `{{env.foo}}`, and any `{% ... %}` response-ref
 *  tag → a `__TODO_CHAIN__` placeholder (the agent/prompt wires the real chain). */
function mapTemplateTags(text: string): string {
  return text
    .replace(new RegExp(INSOMNIA_VAR_TAG, "g"), (_m, name: string) => `{{env.${name}}}`)
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

/** The `{{secrets.*}}` KEY for a bearer token, from the referenced Insomnia var
 *  (`{{ _.apiToken }}` → `API_TOKEN`; falls back to `<DOMAIN>_TOKEN`). */
function tokenSecretKey(domain: string, token: string | undefined): string {
  const ref = token?.match(INSOMNIA_VAR_TAG);
  return ref ? upperSnake(ref[1]!) : `${upperSnake(domain)}_TOKEN`;
}

/** Coerce an arbitrary string into a valid TS identifier for a generated `export const`. */
function identifier(name: string): string {
  const id = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[a-zA-Z_$]/.test(id) ? id : `_${id}`;
}

/** A name deduper: returns `base`, then `base-2`, `base-3`, … so ids/paths never collide
 *  (silent clobber/collapse otherwise loses a whole request). */
function makeUniquifier(): (base: string) => string {
  const used = new Set<string>();
  return (base) => {
    let candidate = base;
    for (let i = 2; used.has(candidate); i++) candidate = `${base}-${i}`;
    used.add(candidate);
    return candidate;
  };
}

/** Depth-first flatten: every request (method-bearing item) under `items`, descending into
 *  folders. Nested folders collapse into their nearest suite so no empty suite is emitted. */
function collectRequests(items: InsomniaRequest[]): InsomniaRequest[] {
  const out: InsomniaRequest[] = [];
  for (const item of items) {
    if (item.children) out.push(...collectRequests(item.children));
    else if (item.method) out.push(item);
  }
  return out;
}

/** Render `// TODO(migrate): …` lines (one per note) at `indent`, or "" when there are none. */
function todoLines(notes: string[], indent: string): string {
  return notes.map((n) => `${indent}// TODO(migrate): ${n}\n`).join("");
}

/** Per-request scaffolding extras: the resolved `authRef` (bearer only) and any TODO notes for
 *  the parts the deterministic transform can't finish (non-bearer auth, response-ref chaining). */
function requestExtras(
  req: InsomniaRequest,
  providerFor: Map<string, string>,
): { authRef?: string; todos: string[] } {
  const todos: string[] = [];
  let authRef: string | undefined;
  const auth = req.authentication;
  if (auth?.type === "bearer") authRef = providerFor.get(auth.token ?? "");
  else if (auth?.type) {
    todos.push(
      `auth type "${auth.type}" isn't auto-mapped — add a provider in tests/_shared/auth (see @atp/engine basicAuth / oauth2ClientCredentials) and set \`authRef\`.`,
    );
  }
  if (hasResponseTag(req)) {
    todos.push(
      `this request used an Insomnia response ref — replace ${CHAIN_PLACEHOLDER} by wiring \`extract\` on the source node + \`{{nodes.<id>.<var>}}\` (and \`needs\` in a suite). See the import_insomnia_collection prompt.`,
    );
  }
  return { authRef, todos };
}

/** Build the IR `request` object for one Insomnia request (shared by tests and suite nodes). */
function mapRequest(req: InsomniaRequest, authRef: string | undefined): Record<string, unknown> {
  const request: Record<string, unknown> = {
    method: (req.method ?? "GET").toUpperCase(),
    url: mapTemplateTags(req.url ?? ""),
  };
  const headers = mapHeaders(req.headers);
  if (headers) request.headers = headers;
  if (authRef) request.authRef = authRef;
  const body = mapBody(req.body);
  if (body !== undefined) request.body = body;
  return request;
}

/** Plan one reusable bearer provider per *distinct* token across all requests, so two requests
 *  with different tokens never collapse onto one wrong credential. A collection with a single
 *  bearer token keeps the tidy `<domain>` provider id; multiple tokens disambiguate by secret. */
function planAuth(
  domain: string,
  requests: InsomniaRequest[],
): { providerFor: Map<string, string>; files: GeneratedFile[] } {
  const tokens: string[] = [];
  for (const r of requests) {
    if (r.authentication?.type === "bearer") {
      const token = r.authentication.token ?? "";
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  const providerFor = new Map<string, string>();
  const files: GeneratedFile[] = [];
  const uniq = makeUniquifier();
  for (const token of tokens) {
    const key = tokenSecretKey(domain, token);
    const providerId = uniq(tokens.length === 1 ? domain : `${domain}-${slug(key)}`);
    providerFor.set(token, providerId);
    files.push(emitAuth(providerId, key));
  }
  return { providerFor, files };
}

/** Emit a `defineTest` module for one top-level Insomnia request, with its mapping row. */
function emitTest(
  domain: string,
  req: InsomniaRequest,
  name: string,
  providerFor: Map<string, string>,
): { file: GeneratedFile; mapping: MappingEntry } {
  const id = `${domain}.${name}`;
  const path = `tests/${domain}/${name}.test.ts`;
  const { authRef, todos } = requestExtras(req, providerFor);
  // 6-space base indent: the `request:` key sits 6 columns in (steps[0] → request).
  const request = renderLiteral(mapRequest(req, authRef), "      ");

  const content = `import { defineTest } from "@atp/engine";

import { ${domain} } from "../_shared/env/${domain}";

export default defineTest({
  id: "${id}",
  version: 1,
  title: ${JSON.stringify(req.name ?? name)},
  tags: [${JSON.stringify(domain)}],
  env: ${domain},
  steps: [
${todoLines(todos, "    ")}    {
      id: "${name}",
      request: ${request},
      assert: ${STATUS_ASSERT},
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

/** Emit a `defineSuite` module for one Insomnia folder / request group (§13.1). Every request
 *  under the folder (nested folders flattened) becomes an inline node; response-ref chaining and
 *  non-bearer auth are left as TODO comments for the agent/prompt to finish. */
function emitSuite(
  domain: string,
  folder: InsomniaRequest,
  suiteName: string,
  providerFor: Map<string, string>,
): { file: GeneratedFile; mapping: MappingEntry[] } {
  const id = `${domain}.${suiteName}`;
  const path = `tests/${domain}/${suiteName}.suite.ts`;
  const uniqNode = makeUniquifier();

  const mapping: MappingEntry[] = [
    {
      insomniaId: folder.meta?.id ?? suiteName,
      insomniaName: folder.name ?? suiteName,
      irId: id,
      kind: "suite",
      path,
    },
  ];
  const nodeSrc: string[] = [];
  for (const child of collectRequests(folder.children ?? [])) {
    const key = uniqNode(slug(child.name ?? "request"));
    const { authRef, todos } = requestExtras(child, providerFor);
    const request = renderLiteral(mapRequest(child, authRef), "      ");
    nodeSrc.push(
      `${todoLines(todos, "    ")}    ${JSON.stringify(key)}: {\n` +
        `      request: ${request},\n` +
        `      assert: ${STATUS_ASSERT},\n` +
        `    },`,
    );
    mapping.push({
      insomniaId: child.meta?.id ?? key,
      insomniaName: child.name ?? key,
      irId: `${id}#${key}`,
      kind: "node",
      path,
    });
  }

  const content = `import { defineSuite } from "@atp/engine";

import { ${domain} } from "../_shared/env/${domain}";

export default defineSuite({
  id: "${id}",
  version: 1,
  title: ${JSON.stringify(folder.name ?? suiteName)},
  tags: [${JSON.stringify(domain)}],
  env: ${domain},
  nodes: {
${nodeSrc.join("\n")}
  },
});
`;
  return { file: { path, content }, mapping };
}

/** Emit `tests/_shared/auth/<providerId>.ts` — a reusable bearer provider (§13.1). */
function emitAuth(providerId: string, secretKey: string): GeneratedFile {
  const content = `import { bearerAuth } from "@atp/engine";

export const ${identifier(providerId)} = bearerAuth({
  id: "${providerId}",
  token: "{{secrets.${secretKey}}}",
});
`;
  return { path: `tests/_shared/auth/${providerId}.ts`, content };
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

  // Plan auth providers across *all* requests (top-level + nested) up front so every request
  // gets the right `authRef`, then emit env, then the entries (ids deduped collection-wide).
  const { providerFor, files: authFiles } = planAuth(domain, collectRequests(collection));
  files.push(emitEnv(domain, doc.environments ?? {}));

  const uniqEntry = makeUniquifier();
  for (const item of collection) {
    if (item.children) {
      // A folder that flattens to zero requests would be an empty, non-compiling suite — skip it.
      if (collectRequests(item.children).length === 0) continue;
      const suiteName = uniqEntry(slug(item.name ?? "suite"));
      const { file, mapping: rows } = emitSuite(domain, item, suiteName, providerFor);
      files.push(file);
      mapping.push(...rows);
    } else if (item.method) {
      const name = uniqEntry(slug(item.name ?? "request"));
      const { file, mapping: row } = emitTest(domain, item, name, providerFor);
      files.push(file);
      mapping.push(row);
    }
  }

  files.push(...authFiles);
  return { files, mapping };
}

/** Escape a value for a Markdown table cell so a literal `|` can't break the column layout. */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** Render `MIGRATION.md` — the Insomnia-id → IR-id mapping table for incremental cutover (§19). */
export function renderMigration(mapping: MappingEntry[], source: string): string {
  const rows = mapping
    .map(
      (m) =>
        `| \`${m.insomniaId}\` | ${mdCell(m.insomniaName)} | \`${m.irId}\` | ${m.kind} | ${mdCell(m.path)} |`,
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
