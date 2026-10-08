import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import {
  collectInterfaces,
  preserveRedirects,
  renderFunction,
} from "./generate-provider-reference.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))

function renderFixture(parameters, extra = "") {
  const file = "/sdk.ts"
  const text = `
declare namespace pulumi { interface InvokeOptions {} }
export declare function lookup(${parameters}): Promise<Result>
export interface Result { value: string }
${extra}
`
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const rendered = renderFunction(
    {
      pkg: { name: "pulumi-fixture" },
      sources: new Map([[file, source]]),
      interfaces: collectInterfaces(source, "local"),
    },
    { name: "lookup", file },
  )
  const example = rendered.markdown.match(/```ts\n([\s\S]*?)```/)[1]
  const files = new Map([
    [file, text],
    ["/example.ts", example],
  ])
  const options = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, ...args) =>
    files.has(name)
      ? ts.createSourceFile(name, files.get(name), ts.ScriptTarget.Latest, true)
      : getSourceFile(name, ...args)
  host.resolveModuleNames = (names) =>
    names.map((name) =>
      name === "pulumi-fixture"
        ? { resolvedFileName: file, extension: ts.Extension.Ts }
        : undefined,
    )
  const program = ts.createProgram(["/example.ts"], options, host)
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    [],
    example,
  )
  return rendered
}

for (const [name, type] of [
  ["duration", "string"],
  ["unixTimestamp", "number"],
]) {
  test(`documents and type-checks the required ${type} parameter`, () => {
    const rendered = renderFixture(
      `${name}: ${type}, opts?: pulumi.InvokeOptions`,
    )
    assert.equal(rendered.argProps.length, 1)
    assert.equal(rendered.argProps[0].name, name)
    assert.equal(rendered.argProps[0].type, type)
    assert.equal(rendered.argProps[0].optional, false)
    assert.doesNotMatch(rendered.markdown, /This function takes no arguments/)
  })
}

test("keeps multiple positional parameters in their declared order", () => {
  const rendered = renderFixture(
    "path: string, names: string[], opts?: pulumi.InvokeOptions",
  )
  assert.deepEqual(
    rendered.argProps.map((prop) => prop.name),
    ["path", "names"],
  )
  assert.match(rendered.markdown, /lookup\("<path>", \["<names>"\]\)/)
})

test("passes a required argument object even when all its fields are optional", () => {
  const rendered = renderFixture(
    "args: Args, opts?: pulumi.InvokeOptions",
    "export interface Args { name?: string }",
  )
  assert.match(rendered.markdown, /lookup\(\{\}\)/)
})

test("omits an optional argument object when it has no required fields", () => {
  const rendered = renderFixture(
    "args?: Args, opts?: pulumi.InvokeOptions",
    "export interface Args { name?: string }",
  )
  assert.match(rendered.markdown, /lookup\(\)/)
})

test("does not mistake invoke options for function arguments", () => {
  const rendered = renderFixture("opts?: pulumi.InvokeOptions")
  assert.match(rendered.markdown, /This function takes no arguments/)
})

test("preserves historical redirects, resolves later moves, and allows revived pages", () => {
  const base = "/pulumi-any-terraform/providers/time/"
  const existing = [
    { source: `${base}old`, destination: `${base}resources/old` },
    { source: `${base}revived`, destination: `${base}overview` },
  ]
  const updates = [
    { source: `${base}resources/old`, destination: `${base}resources/new` },
  ]
  const pages = new Set([
    `${base}resources/new`.slice(1),
    `${base}revived`.slice(1),
  ])
  const first = preserveRedirects(existing, updates, pages)
  assert.deepEqual(
    first.find((redirect) => redirect.source === `${base}old`),
    {
      source: `${base}old`,
      destination: `${base}resources/new`,
    },
  )
  assert.equal(
    first.some((redirect) => redirect.source === `${base}revived`),
    false,
  )
  assert.deepEqual(preserveRedirects(first, [], pages), first)
})

function createCheckout(t) {
  const temporary = mkdtempSync(join(tmpdir(), "docs-generator-"))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const docs = join(temporary, "docs")
  const packages = join(temporary, "sdk/packages")
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  put(join(docs, "package.json"), '{"type":"module"}')
  put(join(docs, "index.mdx"), "Bridge any Terraform provider to Pulumi.\n")
  put(
    join(docs, "docs.json"),
    JSON.stringify({
      markdown: {},
      navigation: {
        tabs: [
          {
            productGroups: [
              { products: [{ product: "Pulumi Any Terraform" }] },
            ],
          },
        ],
      },
      redirects: [],
    }),
  )
  put(
    join(docs, "pulumi-any-terraform/providers/bunnynet/old.mdx"),
    "Old page\n",
  )
  mkdirSync(join(docs, "scripts"))
  cpSync(
    join(repository, "scripts/generate-provider-reference.mjs"),
    join(docs, "scripts/generate-provider-reference.mjs"),
  )
  symlinkSync(
    join(repository, "node_modules"),
    join(docs, "node_modules"),
    "junction",
  )
  const providers = [
    "better-uptime",
    "buildkite",
    "bunnynet",
    "infisical",
    "logtail",
    "namecheap",
    "openfga",
    "portainer",
    "posthog",
    "teamcity",
    "local",
    "time",
  ]
  for (const provider of providers) {
    const dir = join(packages, provider)
    put(
      join(dir, "package.json"),
      JSON.stringify({ name: `pulumi-${provider}`, version: "1.0.0" }),
    )
    put(join(dir, "provider.ts"), "export interface ProviderArgs {}")
    put(join(dir, "index.ts"), "")
  }
  put(
    join(packages, "bunnynet/index.ts"),
    'export const Pullzone: typeof import("./pullzone").Pullzone',
  )
  put(
    join(packages, "bunnynet/pullzone.ts"),
    `
import * as inputs from "./types/input"
export interface PullzoneArgs { origin: inputs.PullzoneOrigin }
export class Pullzone {
  constructor(name: string, args: PullzoneArgs) {
    if (!args.origin) throw new Error("Missing required property 'origin'")
  }
}
`,
  )
  put(
    join(packages, "bunnynet/types/input.ts"),
    "export interface PullzoneOrigin { storagezone?: string; type: string; url?: string }",
  )
  put(
    join(packages, "namecheap/index.ts"),
    'export const DomainRecords: typeof import("./domainRecords").DomainRecords',
  )
  put(
    join(packages, "namecheap/domainRecords.ts"),
    `
import * as inputs from "./types/input"
export interface DomainRecordsArgs { domain: string; records?: inputs.DomainRecordsRecord[] }
export class DomainRecords {
  constructor(name: string, args: DomainRecordsArgs) {
    if (!args.domain) throw new Error("Missing required property 'domain'")
  }
}
`,
  )
  const record =
    "export interface DomainRecordsRecord { address: string; hostname: string; mxPref?: number; ttl?: number; type: string }"
  put(join(packages, "namecheap/types/input.ts"), record)
  put(join(packages, "namecheap/types/output.ts"), record)
  const run = () =>
    spawnSync(
      process.execPath,
      [join(docs, "scripts/generate-provider-reference.mjs")],
      {
        cwd: temporary,
        env: { ...process.env, PULUMI_PACKAGES: packages },
        encoding: "utf8",
      },
    )
  return { docs, packages, run }
}

test("generates in a relocated checkout and retains deleted page redirects across runs", (t) => {
  const { docs, run } = createCheckout(t)
  for (let index = 0; index < 2; index += 1) {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      existsSync(
        join(
          docs,
          "pulumi-any-terraform/providers/bunnynet/resources/pullzone.mdx",
        ),
      ),
    )
    const config = JSON.parse(readFileSync(join(docs, "docs.json"), "utf8"))
    assert.deepEqual(
      config.redirects.find(
        (redirect) =>
          redirect.source === "/pulumi-any-terraform/providers/bunnynet/old",
      ),
      {
        source: "/pulumi-any-terraform/providers/bunnynet/old",
        destination: "/pulumi-any-terraform/providers/bunnynet/overview",
      },
    )
  }
})

test("leaves existing pages and configuration intact when generated validation fails", (t) => {
  const { docs, packages, run } = createCheckout(t)
  writeFileSync(
    join(packages, "bunnynet/types/input.ts"),
    "export interface PullzoneOrigin { type: string }",
  )
  const config = readFileSync(join(docs, "docs.json"), "utf8")
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PullzoneOrigin fields/)
  assert.equal(
    readFileSync(
      join(docs, "pulumi-any-terraform/providers/bunnynet/old.mdx"),
      "utf8",
    ),
    "Old page\n",
  )
  assert.equal(readFileSync(join(docs, "docs.json"), "utf8"), config)
  assert.equal(
    readFileSync(join(docs, "index.mdx"), "utf8"),
    "Bridge any Terraform provider to Pulumi.\n",
  )
})
