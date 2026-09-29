/**
 * Regenerates the Pulumi Any Terraform pages in the master docs from the
 * generated SDK. Property names, nested objects, and required flags come from
 * the TypeScript source. Narrative examples are not copied forward.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import ts from '/Users/khanh/KhanhProjects/pulumi-any-terraform/node_modules/typescript/lib/typescript.js'

const packagesRoot = process.env.PULUMI_PACKAGES ?? '/Users/khanh/KhanhProjects/pulumi-any-terraform/packages'
const docsRoot = '/Users/khanh/Projects/docs'
const docsJsonPath = join(docsRoot, 'docs.json')

const providerMeta = [
  ['better-uptime', 'Better Uptime', '/images/providers/better-stack.svg'],
  ['buildkite', 'Buildkite', '/images/providers/buildkite.svg'],
  ['bunnynet', 'Bunny', '/images/providers/bunnynet.svg'],
  ['infisical', 'Infisical', '/images/providers/infisical.svg'],
  ['logtail', 'Logtail', '/images/providers/better-stack.svg'],
  ['namecheap', 'Namecheap', '/images/providers/namecheap.svg'],
  ['openfga', 'OpenFGA', '/images/providers/openfga.svg'],
  ['portainer', 'Portainer', '/images/providers/portainer.svg'],
  ['posthog', 'PostHog', '/images/providers/posthog.svg'],
  ['teamcity', 'TeamCity', '/images/providers/teamcity.png'],
  ['local', 'Local', '/images/providers/terraform.svg'],
  ['time', 'Time', '/images/providers/terraform.svg'],
]

const guidePages = [
  'getting-started',
  'architecture',
  'contributing',
  'troubleshooting',
  'faq',
  'ci-cd',
]

function kebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function read(file) {
  return readFileSync(file, 'utf8')
}

function parse(file) {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function sideFor(file) {
  if (file.endsWith('/types/input.ts')) return 'input'
  if (file.endsWith('/types/output.ts')) return 'output'
  return 'local'
}

function commentOf(node, source) {
  const leading = source.text.slice(node.getFullStart(), node.getStart(source))
  const blocks = [...leading.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
  if (blocks.length === 0) return ''
  return blocks[blocks.length - 1][1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
    .filter((line) => !line.trim().startsWith('@'))
    .join('\n')
    .trim()
}

function cleanDocs(text) {
  const withoutSpans = text.replace(
    /<span\b[^>]*pulumi-lang-nodejs="([^"]*)"[^>]*>[\s\S]*?<\/span>/g,
    (match, name, offset, full) => {
      const cleaned = name.replace(/`/g, '').trim()
      if (!cleaned) return ''
      const before = full[offset - 1] ?? ''
      const after = full[offset + match.length] ?? ''
      const lead = before && /[A-Za-z0-9`]/.test(before) ? ' ' : ''
      const trail = after && /[A-Za-z0-9`]/.test(after) ? ' ' : ''
      return `${lead}\`${cleaned}\`${trail}`
    },
  )
  return withoutSpans
    .replace(/<https?:\/\/[^>\s]+>/g, (url) => url.slice(1, -1))
    .replace(/<\/?span\b[^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeProse(text) {
  const ticks = text.match(/`/g)?.length ?? 0
  const normalized = ticks % 2 === 0 ? text : text.replaceAll('`', "'")
  const parts = normalized.split(/(`[^`]*`)/g)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/&/g, '&amp;')
        .replace(/\{/g, '&#123;')
        .replace(/\}/g, '&#125;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n+/g, ' ')
        .replace(/[ ]{2,}/g, ' ')
    })
    .join('')
    .trim()
}

function yamlQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
}

function collectInterfaces(source, side) {
  const found = new Map()
  const visit = (node, prefix) => {
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text
      const next = prefix ? `${prefix}.${name}` : name
      for (const statement of node.body.statements) visit(statement, next)
      return
    }
    if (ts.isInterfaceDeclaration(node)) {
      const qualified = prefix ? `${prefix}.${node.name.text}` : node.name.text
      const props = []
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          props.push({
            name: member.name.getText(source),
            optional: Boolean(member.questionToken),
            typeNode: member.type,
            docs: cleanDocs(commentOf(member, source)),
          })
        } else if (ts.isIndexSignatureDeclaration(member)) {
          props.push({
            name: `[key: ${member.parameters[0]?.type?.getText(source) ?? 'string'}]`,
            optional: true,
            typeNode: member.type,
            docs: cleanDocs(commentOf(member, source)),
            index: true,
          })
        }
      }
      const key = `${side}:${qualified}`
      if (found.has(key)) {
        throw new Error(`Duplicate interface ${key} in ${source.fileName}`)
      }
      found.set(key, {
        key,
        side,
        qualified,
        display: qualified,
        props,
        source,
      })
    }
  }
  for (const statement of source.statements) visit(statement, '')
  return found
}

function renderType(typeNode, source, refs) {
  if (!typeNode) return 'unknown'
  if (ts.isParenthesizedTypeNode(typeNode)) return renderType(typeNode.type, source, refs)
  if (ts.isUnionTypeNode(typeNode)) {
    const parts = typeNode.types
      .map((part) => renderType(part, source, refs))
      .filter((part) => part !== 'undefined')
    return [...new Set(parts)].join(' | ') || 'undefined'
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.map((part) => renderType(part, source, refs)).join(' & ')
  }
  if (ts.isArrayTypeNode(typeNode)) return `${renderType(typeNode.elementType, source, refs)}[]`
  if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return renderType(typeNode.type, source, refs)
  }
  if (ts.isLiteralTypeNode(typeNode)) return typeNode.getText(source)
  if (ts.isTypeLiteralNode(typeNode)) {
    if (typeNode.members.length === 1 && ts.isIndexSignatureDeclaration(typeNode.members[0])) {
      const index = typeNode.members[0]
      const keyType = index.parameters[0]?.type
        ? renderType(index.parameters[0].type, source, refs)
        : 'string'
      const valueType = index.type ? renderType(index.type, source, refs) : 'unknown'
      return `{ [key: ${keyType}]: ${valueType} }`
    }
    if (typeNode.members.length === 0) return '{}'
    throw new Error(`Unsupported object type ${typeNode.getText(source)} in ${source.fileName}`)
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText(source)
    if ((name === 'pulumi.Input' || name === 'pulumi.Output' || name === 'Promise') && typeNode.typeArguments?.[0]) {
      return renderType(typeNode.typeArguments[0], source, refs)
    }
    if (name === 'Array' && typeNode.typeArguments?.[0]) {
      return `${renderType(typeNode.typeArguments[0], source, refs)}[]`
    }
    if (name === 'Record' && typeNode.typeArguments?.length === 2) {
      const keyType = renderType(typeNode.typeArguments[0], source, refs)
      const valueType = renderType(typeNode.typeArguments[1], source, refs)
      return `{ [key: ${keyType}]: ${valueType} }`
    }
    let key = null
    if (name.startsWith('inputs.')) key = `input:${name.slice('inputs.'.length)}`
    else if (name.startsWith('outputs.')) key = `output:${name.slice('outputs.'.length)}`
    else key = `local:${name}`
    if (key.startsWith('local:') && !refs.interfaces.has(key)) {
      const bare = name
      if (refs.interfaces.has(`input:${bare}`)) key = `input:${bare}`
      else if (refs.interfaces.has(`output:${bare}`)) key = `output:${bare}`
      else key = null
    }
    if (key?.startsWith('input:') || key?.startsWith('output:') || key?.startsWith('local:')) {
      if (!refs.interfaces.has(key)) {
        throw new Error(`Unknown type ${name} (${key}) in ${source.fileName}`)
      }
      refs.list.push(key)
      return typeLabel(refs.interfaces.get(key), refs.interfaces)
    }
    if (name.startsWith('pulumi.')) return name
    if (/[A-Z]/.test(name) || name.includes('.')) {
      throw new Error(`Unresolved type ${name} in ${source.fileName}`)
    }
    if (typeNode.typeArguments?.length) {
      const args = typeNode.typeArguments.map((arg) => renderType(arg, source, refs))
      return `${name}<${args.join(', ')}>`
    }
    return name
  }
  const kind = typeNode.kind
  if (kind === ts.SyntaxKind.StringKeyword) return 'string'
  if (kind === ts.SyntaxKind.NumberKeyword) return 'number'
  if (kind === ts.SyntaxKind.BooleanKeyword) return 'boolean'
  if (kind === ts.SyntaxKind.AnyKeyword) return 'any'
  if (kind === ts.SyntaxKind.VoidKeyword) return 'void'
  if (kind === ts.SyntaxKind.UndefinedKeyword) return 'undefined'
  if (kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (kind === ts.SyntaxKind.NeverKeyword) return 'never'
  if (kind === ts.SyntaxKind.ObjectKeyword) return 'object'
  if (kind === ts.SyntaxKind.UnknownKeyword) return 'unknown'
  throw new Error(
    `Unsupported type ${ts.SyntaxKind[kind]} (${typeNode.getText(source)}) in ${source.fileName}`,
  )
}

function shapeProps(iface, interfaces) {
  return iface.props.map((prop) => {
    const refs = { interfaces, list: [] }
    const type = renderType(prop.typeNode, iface.source, refs)
    return {
      name: prop.name,
      optional: prop.optional,
      index: Boolean(prop.index),
      type,
      docs: prop.docs,
      refs: refs.list,
    }
  })
}

function walkTypes(rootRefs, interfaces) {
  const order = []
  const seen = new Set()
  const visit = (key) => {
    if (seen.has(key)) return
    const iface = interfaces.get(key)
    if (!iface) throw new Error(`Missing interface ${key}`)
    seen.add(key)
    const props = shapeProps(iface, interfaces)
    order.push({ iface, props, heading: typeLabel(iface, interfaces) })
    for (const prop of props) {
      for (const ref of prop.refs) visit(ref)
    }
  }
  for (const ref of rootRefs) visit(ref)
  return order
}

function typeLabel(iface, interfaces) {
  const other = iface.side === 'input' ? 'output' : iface.side === 'output' ? 'input' : null
  if (other && interfaces.has(`${other}:${iface.qualified}`)) {
    return `${iface.display} (${iface.side})`
  }
  return iface.display
}

function table(props, mode) {
  const header =
    mode === 'output'
      ? '| Property | Type | Computed | Description |'
      : mode === 'presence'
        ? '| Property | Type | Always present | Description |'
        : '| Property | Type | Required | Description |'
  const rule = '| --- | --- | --- | --- |'
  if (props.length === 0) return 'This object has no fields.'
  const rows = props.map((prop) => {
    const flag =
      mode === 'output' ? (prop.computed ? 'yes' : 'no') : mode === 'presence' ? (prop.optional ? 'no' : 'yes') : prop.optional ? 'no' : 'yes'
    const description = escapeProse(prop.docs)
    return `| \`${prop.name}\` | \`${prop.type}\` | ${flag} | ${description} |`
  })
  return [header, rule, ...rows].join('\n')
}

function typeSections(sections) {
  return sections
    .map((section) => {
      const label = section.heading
      const blurb =
        section.iface.side === 'output'
          ? `Output object \`${section.iface.display}\`. Fields below belong to this object.`
          : `Input object \`${section.iface.display}\`. Fields below belong to this object, not to the parent.`
      const columnMode = section.iface.side === 'output' ? 'presence' : 'input'
      return `## \`${label}\`\n\n${blurb}\n\n${table(section.props, columnMode)}\n`
    })
    .join('\n')
}

function assertBalanced(markdown, file) {
  const body = markdown.replace(/^---[\s\S]*?---/, '')
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
  if (stripped.includes('{') || stripped.includes('}')) {
    throw new Error(`Unescaped brace in ${file}`)
  }
  const lines = body.split('\n')
  for (const line of lines) {
    if (!line.startsWith('|')) continue
    const ticks = line.match(/`/g)?.length ?? 0
    if (ticks % 2 !== 0) throw new Error(`Unbalanced backtick in ${file}: ${line.slice(0, 180)}`)
  }
}

function frontmatter(title, description) {
  return `---\ntitle: ${yamlQuote(title)}\ndescription: ${yamlQuote(description)}\n---\n`
}

function classProperties(source, className) {
  const statement = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === className,
  )
  if (!statement) throw new Error(`Class ${className} not found in ${source.fileName}`)
  const props = []
  for (const member of statement.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name) continue
    const modifiers = member.getText(source)
    if (modifiers.includes('static')) continue
    props.push({
      name: member.name.getText(source),
      computed: /\/\*out\*\//.test(modifiers),
      typeNode: member.type,
      docs: cleanDocs(commentOf(member, source)),
      optional: Boolean(member.questionToken) || /\| undefined/.test(member.type?.getText(source) ?? ''),
    })
  }
  return props
}

function requiredThrows(source) {
  return new Set([...source.text.matchAll(/Missing required property '([^']+)'/g)].map((match) => match[1]))
}

function secretNames(source) {
  const secrets = new Set(
    [...source.text.matchAll(/pulumi\.secret\(args\?\.([A-Za-z0-9_]+)\)/g)].map((match) => match[1]),
  )
  const extra = source.text.match(/additionalSecretOutputs:\s*\[([^\]]*)\]/)
  if (extra) {
    for (const name of extra[1].matchAll(/"([^"]+)"/g)) secrets.add(name[1])
  }
  return secrets
}

function pulumiType(source) {
  const match = source.text.match(/__pulumiType = '([^']+)'/)
  return match?.[1] ?? ''
}

function decodeUpstream(pkg) {
  const parameter = pkg.pulumi?.parameterization
  if (!parameter?.value) return null
  const decoded = JSON.parse(Buffer.from(parameter.value, 'base64').toString('utf8'))
  return decoded.remote ?? null
}

function configEntries(file, interfaces) {
  if (!file) return []
  const source = parse(file)
  const entries = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      if (name.startsWith('_') || name === 'exports') continue
      if (!declaration.type) continue
      const refs = { interfaces, list: [] }
      entries.push({
        name,
        type: renderType(declaration.type, source, refs),
        docs: cleanDocs(commentOf(statement, source) || commentOf(declaration, source)),
        refs: refs.list,
        optional: true,
      })
    }
  }
  const accessors = new Map()
  for (const match of source.text.matchAll(/__config\.(getObject|getSecret|get(?:Boolean|Number)?)\s*(?:<[^>]+>)?\(\s*"([^"]+)"/g)) {
    accessors.set(match[2], match[1])
  }
  const configName = source.text.match(/new pulumi\.Config\("([^"]+)"\)/)?.[1]
  if (!configName) throw new Error(`Missing pulumi.Config name in ${file}`)
  return { configName, entries: entries.filter((entry) => accessors.has(entry.name)).map((entry) => ({
    ...entry,
    accessor: accessors.get(entry.name),
  })), source }
}

function listTsFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === 'bin') continue
    const info = statSync(full)
    if (info.isDirectory()) files.push(...listTsFiles(full))
    else if (entry.endsWith('.ts')) files.push(full)
  }
  return files
}

function loadPackage(dirName) {
  const dir = join(packagesRoot, dirName)
  const pkg = JSON.parse(read(join(dir, 'package.json')))
  const interfaces = new Map()
  const sources = new Map()
  for (const file of listTsFiles(dir)) {
    if (file.endsWith('/index.ts') || file.endsWith('/utilities.ts') || file.endsWith('/types/index.ts')) continue
    const source = parse(file)
    sources.set(file, source)
    const side = sideFor(file)
    for (const [key, iface] of collectInterfaces(source, side)) {
      if (interfaces.has(key)) throw new Error(`Duplicate ${key} while loading ${dirName}`)
      interfaces.set(key, iface)
    }
  }
  const index = read(join(dir, 'index.ts'))
  const resources = []
  for (const match of index.matchAll(/export const ([A-Z][A-Za-z0-9]*): typeof import\("\.\/([^"]+)"\)\.\1/g)) {
    resources.push({ name: match[1], file: join(dir, `${match[2]}.ts`) })
  }
  const functions = []
  for (const match of index.matchAll(/export const ([a-z][A-Za-z0-9]*): typeof import\("\.\/([^"]+)"\)\.\1/g)) {
    if (match[1].endsWith('Output')) continue
    functions.push({ name: match[1], file: join(dir, `${match[2]}.ts`) })
  }
  const providerFile = join(dir, 'provider.ts')
  const configFile = listTsFiles(dir).find((file) => file.endsWith('/config/vars.ts'))
  return { dirName, dir, pkg, interfaces, sources, resources, functions, providerFile, configFile }
}

function functionSignature(source, name) {
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!fn) throw new Error(`Function ${name} not found in ${source.fileName}`)
  const argsParam = fn.parameters.find((parameter) => {
    const typeName = parameter.type && ts.isTypeReferenceNode(parameter.type) ? parameter.type.typeName.getText(source) : ''
    return typeName !== 'pulumi.InvokeOptions' && typeName !== 'pulumi.InvokeOutputOptions'
  })
  const argsName = argsParam?.type && ts.isTypeReferenceNode(argsParam.type) ? argsParam.type.typeName.getText(source) : null
  let resultName = null
  if (fn.type && ts.isTypeReferenceNode(fn.type) && fn.type.typeName.getText(source) === 'Promise') {
    const inner = fn.type.typeArguments?.[0]
    if (inner && ts.isTypeReferenceNode(inner)) resultName = inner.typeName.getText(source)
  }
  const invoke = source.text.match(/pulumi\.runtime\.invoke\(\s*"([^"]+)"/)
  const outputVariant = source.statements.some(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === `${name}Output`,
  )
  return { argsName, resultName, token: invoke?.[1] ?? '', outputVariant }
}

function renderResource(pkgInfo, resource) {
  const source = pkgInfo.sources.get(resource.file) ?? parse(resource.file)
  const args = pkgInfo.interfaces.get(`local:${resource.name}Args`)
  if (!args) throw new Error(`Missing ${resource.name}Args in ${resource.file}`)
  const argProps = shapeProps(args, pkgInfo.interfaces)
  const thrown = requiredThrows(source)
  const required = new Set(argProps.filter((prop) => !prop.optional && !prop.index).map((prop) => prop.name))
  const thrownExtra = [...thrown].filter((name) => !required.has(name))
  const missingThrow = [...required].filter((name) => !thrown.has(name))
  if (thrownExtra.length || missingThrow.length) {
    throw new Error(
      `${pkgInfo.dirName} ${resource.name} required mismatch. missing throw: ${missingThrow.join(', ')}; extra throw: ${thrownExtra.join(', ')}`,
    )
  }
  const outputs = classProperties(source, resource.name).map((prop) => {
    const refs = { interfaces: pkgInfo.interfaces, list: [] }
    return {
      name: prop.name,
      computed: prop.computed,
      optional: prop.optional,
      type: renderType(prop.typeNode, source, refs),
      docs: prop.docs,
      refs: refs.list,
    }
  })
  const rootRefs = []
  for (const prop of argProps) rootRefs.push(...prop.refs)
  for (const prop of outputs) rootRefs.push(...prop.refs)
  const sections = walkTypes(rootRefs, pkgInfo.interfaces)
  const npmName = pkgInfo.pkg.name
  const binding = npmName.replace(/^pulumi-/, '').replace(/-/g, '')
  const description = `Resource ${resource.name} in ${npmName}.`
  const body = [
    frontmatter(resource.name, description),
    `<!-- Generated from the ${npmName} SDK. -->`,
    '',
    description,
    '',
    `Pulumi type: \`${pulumiType(source)}\`.`,
    '',
    '```ts',
    `import * as ${binding} from "${npmName}"`,
    '```',
    '',
    `Construct with \`new ${binding}.${resource.name}(name, args, opts?)\`.`,
    '',
    '`name` is the Pulumi resource name. Nested object fields are documented under that object. They are not arguments of this resource.',
    '',
    '## Arguments',
    '',
    table(argProps, 'input'),
    '',
    '## Outputs',
    '',
    'Computed outputs are produced by the provider. They are not constructor arguments.',
    '',
    table(
      outputs.map((prop) => ({ ...prop, computed: prop.computed })),
      'output',
    ),
    '',
    typeSections(sections),
  ].join('\n')
  return { markdown: `${body.trim()}\n`, argProps, outputs, sections, binding, npmName }
}

function renderFunction(pkgInfo, item) {
  const source = pkgInfo.sources.get(item.file) ?? parse(item.file)
  const signature = functionSignature(source, item.name)
  const args = signature.argsName ? pkgInfo.interfaces.get(`local:${signature.argsName}`) : null
  const result = signature.resultName ? pkgInfo.interfaces.get(`local:${signature.resultName}`) : null
  if (signature.argsName && !args) throw new Error(`Missing ${signature.argsName} for ${item.name}`)
  if (signature.resultName && !result) throw new Error(`Missing ${signature.resultName} for ${item.name}`)
  const argProps = args ? shapeProps(args, pkgInfo.interfaces) : []
  const resultProps = result
    ? shapeProps(result, pkgInfo.interfaces).map((prop) => ({ ...prop, computed: false }))
    : []
  const rootRefs = []
  for (const prop of argProps) rootRefs.push(...prop.refs)
  for (const prop of resultProps) rootRefs.push(...prop.refs)
  const sections = walkTypes(rootRefs, pkgInfo.interfaces)
  const npmName = pkgInfo.pkg.name
  const binding = npmName.replace(/^pulumi-/, '').replace(/-/g, '')
  const description = `Function ${item.name} in ${npmName}.`
  const lines = [
    frontmatter(item.name, description),
    `<!-- Generated from the ${npmName} SDK. -->`,
    '',
    description,
    '',
    signature.token ? `Invoke token: \`${signature.token}\`.` : '',
    '',
    '```ts',
    `import * as ${binding} from "${npmName}"`,
    '```',
    '',
    `Call \`${binding}.${item.name}(args)\`.`,
    '',
  ]
  if (signature.outputVariant) {
    lines.push(`\`${item.name}Output\` accepts Input values and returns \`Output\` of the same result.`, '')
  }
  lines.push('## Arguments', '', args ? table(argProps, 'input') : 'This function takes no arguments.', '')
  lines.push('## Result', '', result ? table(resultProps, 'presence') : 'This function returns no fields.', '')
  lines.push(typeSections(sections))
  return { markdown: `${lines.filter((line) => line !== undefined).join('\n').trim()}\n`, argProps, resultProps, sections }
}

function renderConfiguration(pkgInfo) {
  const source = pkgInfo.sources.get(pkgInfo.providerFile) ?? parse(pkgInfo.providerFile)
  const args = pkgInfo.interfaces.get('local:ProviderArgs')
  if (!args) throw new Error(`Missing ProviderArgs in ${pkgInfo.dirName}`)
  const argProps = shapeProps(args, pkgInfo.interfaces)
  const secrets = secretNames(source)
  const config = pkgInfo.configFile ? configEntries(pkgInfo.configFile, pkgInfo.interfaces) : null
  const configByName = new Map(config?.entries.map((entry) => [entry.name, entry]) ?? [])
  const names = [...new Set([...argProps.map((prop) => prop.name), ...configByName.keys()])].sort()
  const rootRefs = []
  for (const prop of argProps) rootRefs.push(...prop.refs)
  for (const entry of config?.entries ?? []) rootRefs.push(...entry.refs)
  const sections = walkTypes(rootRefs, pkgInfo.interfaces)
  const rows = names.map((name) => {
    const prop = argProps.find((item) => item.name === name)
    const stack = configByName.get(name)
    const type = prop?.type ?? stack.type
    const docs = prop?.docs || stack?.docs || ''
    const where = [
      prop ? 'provider args' : null,
      stack ? `stack config via config.${stack.accessor}` : null,
    ].filter(Boolean).join('; ')
    const secret = secrets.has(name) ? 'yes' : 'no'
    return `| \`${name}\` | \`${type}\` | ${where} | ${secret} | ${escapeProse(docs)} |`
  })
  const npmName = pkgInfo.pkg.name
  const binding = npmName.replace(/^pulumi-/, '').replace(/-/g, '')
  const description = `Configuration for ${npmName}.`
  const upstream = decodeUpstream(pkgInfo.pkg)
  const lines = [
    frontmatter('Configuration', description),
    `<!-- Generated from the ${npmName} SDK. -->`,
    '',
    description,
    '',
    `npm package \`${npmName}\` version \`${pkgInfo.pkg.version}\`.`,
    `Pulumi bridge \`${pkgInfo.pkg.pulumi?.name ?? ''}\` version \`${pkgInfo.pkg.pulumi?.version ?? ''}\`.`,
  ]
  if (upstream) {
    lines.push(`Upstream provider \`${upstream.url}\` version \`${upstream.version}\`.`)
  }
  lines.push(
    '',
    `An explicit provider is \`new ${binding}.Provider(name, args)\`. Stack configuration is a \`pulumi.Config\` object${config ? ` named \`${config.configName}\`` : ''}.`,
    '',
    'A value marked secret is passed through `pulumi.secret` or listed in `additionalSecretOutputs` on the provider resource.',
    '',
    '## Fields',
    '',
  )
  if (rows.length === 0) {
    lines.push('This provider has no configuration fields.', '')
  } else {
    lines.push(
      '| Property | Type | Source | Secret | Description |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    )
  }
  lines.push(typeSections(sections))
  const markdown = `${lines.join('\n').trim()}\n`
  return { markdown, argProps, config, secrets, sections }
}

function renderProviderOverview(meta, pkgInfo, resources, functions) {
  const npmName = pkgInfo.pkg.name
  const upstream = decodeUpstream(pkgInfo.pkg)
  const description = `Resources and functions exported by ${npmName}.`
  const resourceLines = resources.map(
    (item) => `- [${item.name}](/pulumi-any-terraform/providers/${meta.dir}/resources/${item.slug})`,
  )
  const functionLines = functions.map(
    (item) => `- [${item.name}](/pulumi-any-terraform/providers/${meta.dir}/functions/${item.slug})`,
  )
  const lines = [
    frontmatter(meta.title, description),
    `<!-- Generated from the ${npmName} SDK. -->`,
    '',
    `\`${npmName}\` version \`${pkgInfo.pkg.version}\`.`,
    `Pulumi bridge \`${pkgInfo.pkg.pulumi?.name ?? ''}\` version \`${pkgInfo.pkg.pulumi?.version ?? ''}\`.`,
  ]
  if (upstream) lines.push(`Upstream provider \`${upstream.url}\` version \`${upstream.version}\`.`)
  lines.push(
    '',
    'The package is TypeScript. Import it by the npm package name.',
    '',
    '```ts',
    `import * as ${npmName.replace(/^pulumi-/, '').replace(/-/g, '')} from "${npmName}"`,
    '```',
    '',
    'Nested object fields are on the resource or function page, under the object heading.',
    '',
    '## Resources',
    '',
    resourceLines.length ? resourceLines.join('\n') : 'This package exports no resources.',
    '',
    '## Functions',
    '',
    functionLines.length ? functionLines.join('\n') : 'This package exports no functions.',
    '',
  )
  return `${lines.join('\n').trim()}\n`
}

function renderProductOverview(providers) {
  const rows = providers.map((provider) => {
    const upstream = provider.upstream
    const upstreamCell = upstream ? `\`${upstream.url}\` \`${upstream.version}\`` : ''
    return `| [${provider.title}](/pulumi-any-terraform/providers/${provider.dir}/overview) | \`${provider.npmName}\` | \`${provider.version}\` | ${upstreamCell} |`
  })
  const lines = [
    frontmatter(
      'Pulumi Any Terraform',
      'TypeScript Pulumi packages bridged from Terraform providers.',
    ),
    '',
    'These packages are published for TypeScript. Each npm package is named `pulumi-` plus the provider name.',
    '',
    '<Visibility for="agents">',
    'Resource pages are `/pulumi-any-terraform/providers/<provider>/resources/<resource>`. Function pages are under `functions`. Nested object fields are under that object's heading. A long reference continues on the linked part pages. They are not arguments of the parent. Use only properties listed on the page.',
    '</Visibility>',
    '',
    '| Provider | Package | npm version | Upstream |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ]
  return `${lines.join('\n').trim()}\n`
}

function writePage(file, markdown) {
  assertBalanced(markdown, file)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, markdown)
}

function parseTable(markdown, heading) {
  const start = markdown.indexOf(heading)
  if (start < 0) return null
  const rest = markdown.slice(start + heading.length)
  const next = rest.search(/\n## /)
  const block = next === -1 ? rest : rest.slice(0, next)
  const rows = []
  for (const line of block.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = []
    let current = ''
    let code = false
    for (const char of line) {
      if (char === '`') code = !code
      if (char === '|' && !code) {
        cells.push(current.trim())
        current = ''
      } else current += char
    }
    cells.push(current.trim())
    const useful = cells.filter((cell) => cell !== '')
    rows.push({
      name: useful[0].replace(/`/g, ''),
      type: useful[1].replace(/`/g, ''),
      flag: useful[2],
    })
  }
  return rows
}

function checkRows(actual, expected, label) {
  const actualNames = actual.map((row) => row.name)
  const expectedNames = expected.map((prop) => prop.name)
  if (actualNames.join('\n') !== expectedNames.join('\n')) {
    throw new Error(`${label} properties differ\npage: ${actualNames.join(', ')}\nsdk: ${expectedNames.join(', ')}`)
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index].type !== expected[index].type) {
      throw new Error(`${label} type for ${expected[index].name}: page ${actual[index].type} vs sdk ${expected[index].type}`)
    }
  }
}

const legacyPages = [
  'pulumi-any-terraform/architecture',
  'pulumi-any-terraform/ci-cd',
  'pulumi-any-terraform/contributing',
  'pulumi-any-terraform/faq',
  'pulumi-any-terraform/getting-started',
  'pulumi-any-terraform/troubleshooting',
  'pulumi-any-terraform/providers/better-uptime/heartbeat',
  'pulumi-any-terraform/providers/better-uptime/monitor',
  'pulumi-any-terraform/providers/better-uptime/status-page',
  'pulumi-any-terraform/providers/namecheap/dns-guide',
  'pulumi-any-terraform/providers/namecheap/domain-records',
  'pulumi-any-terraform/providers/namecheap/migration-guide',
  'pulumi-any-terraform/providers/posthog/alert',
  'pulumi-any-terraform/providers/posthog/dashboard',
  'pulumi-any-terraform/providers/posthog/feature-flag',
  'pulumi-any-terraform/providers/posthog/hog-function',
  'pulumi-any-terraform/providers/posthog/insight',
  'pulumi-any-terraform/providers/time/offset',
  'pulumi-any-terraform/providers/time/rotating',
  'pulumi-any-terraform/providers/time/sleep',
  'pulumi-any-terraform/providers/time/static',
  'pulumi-any-terraform/providers/time/time-guide',
]

const pageLimit = 160_000

function splitLargePage(page, markdown, title) {
  if (markdown.length <= pageLimit) return [[page, markdown]]
  const sections = markdown.split(/(?=\n## `)/)
  const bodies = []
  let current = sections[0]
  for (const section of sections.slice(1)) {
    if (current.length + section.length > pageLimit && current.includes('\n## ')) {
      bodies.push(current)
      current = ''
    }
    current += section
  }
  if (current.trim()) bodies.push(current)
  if (bodies.length < 2) return [[page, markdown]]
  return bodies.map((body, index) => {
    const path = index === 0 ? page : `${page}-part-${index + 1}`
    const links = bodies
      .map((_, linkIndex) => {
        const linkPath = linkIndex === 0 ? page : `${page}-part-${linkIndex + 1}`
        const label = linkIndex === 0 ? 'Start' : `Part ${linkIndex + 1}`
        return linkIndex === index ? label : `[${label}](/${linkPath})`
      })
      .join(' · ')
    let text = body.trim()
    if (index > 0) {
      text = `${frontmatter(`${title} ${index + 1}`, `Continued object types for ${title}.`)}\n${text}`
    }
    text += `\n\nObject types for this reference are split across pages. ${links}\n`
    return [path, text]
  })
}
  function verifyRendered(file, rendered) {
  const markdown = rendered.parts
    ? rendered.parts.map((part) => read(join(docsRoot, `${part}.mdx`))).join('\n')
    : read(file)
  if (rendered.argProps) {
    const args = parseTable(markdown, '## Arguments')
    if (!args) throw new Error(`${file} missing arguments`)
    checkRows(args, rendered.argProps, file)
    for (const row of args) {
      const expected = rendered.argProps.find((prop) => prop.name === row.name)
      const flag = expected.optional ? 'no' : 'yes'
      if (row.flag !== flag) throw new Error(`${file} required flag for ${row.name}`)
    }
  }
  if (rendered.outputs) {
    const outputs = parseTable(markdown, '## Outputs')
    if (!outputs) throw new Error(`${file} missing outputs`)
    checkRows(outputs, rendered.outputs, `${file} outputs`)
    for (const row of outputs) {
      const expected = rendered.outputs.find((prop) => prop.name === row.name)
      const flag = expected.computed ? 'yes' : 'no'
      if (row.flag !== flag) throw new Error(`${file} computed flag for ${row.name}`)
    }
  }
  if (rendered.resultProps) {
    const result = parseTable(markdown, '## Result')
    if (!result) throw new Error(`${file} missing result`)
    checkRows(result, rendered.resultProps, `${file} result`)
  }
  for (const section of rendered.sections ?? []) {
    const rows = parseTable(markdown, `## \`${section.heading}\``)
    if (!rows) throw new Error(`${file} missing section ${section.heading}`)
    checkRows(rows, section.props, `${file} ${section.heading}`)
  }
}

function main() {
  const packageNames = providerMeta.map(([dir]) => dir)
  const onDisk = readdirSync(packagesRoot).filter((name) => statSync(join(packagesRoot, name)).isDirectory())
  const missing = onDisk.filter((name) => !packageNames.includes(name))
  const extra = packageNames.filter((name) => !onDisk.includes(name))
  if (missing.length || extra.length) {
    throw new Error(`Package list mismatch. missing meta: ${missing.join(', ')}; extra meta: ${extra.join(', ')}`)
  }

  const oldProviderFiles = []
  const providersDir = join(docsRoot, 'pulumi-any-terraform/providers')
  const walkOld = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walkOld(full)
      else if (entry.endsWith('.mdx')) oldProviderFiles.push(relative(docsRoot, full).replaceAll('\\', '/').replace(/\.mdx$/, ''))
    }
  }
  walkOld(providersDir)

  const generated = new Map()
  const navProviders = []
  const redirects = []

  for (const [dir, title, icon] of providerMeta) {
    process.stderr.write(`reading ${dir}\n`)
    const pkgInfo = loadPackage(dir)
    const resources = pkgInfo.resources
      .map((resource) => ({ ...resource, slug: kebab(resource.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const functions = pkgInfo.functions
      .map((item) => ({ ...item, slug: kebab(item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const slugs = new Set([...resources.map((item) => item.slug), ...functions.map((item) => item.slug)])
    if (slugs.size !== resources.length + functions.length) {
      throw new Error(`Slug collision in ${dir}`)
    }

    const overviewPath = `pulumi-any-terraform/providers/${dir}/overview`
    const configurationPath = `pulumi-any-terraform/providers/${dir}/configuration`
    generated.set(overviewPath, renderProviderOverview({ dir, title }, pkgInfo, resources, functions))
    const configuration = renderConfiguration(pkgInfo)
    generated.set(configurationPath, configuration.markdown)

    const resourcePages = []
    for (const resource of resources) {
      const page = `pulumi-any-terraform/providers/${dir}/resources/${resource.slug}`
      const rendered = renderResource(pkgInfo, resource)
      const parts = splitLargePage(page, rendered.markdown, resource.name)
      for (const [part, markdown] of parts) generated.set(part, markdown)
      generated.set(`${page}#check`, { ...rendered, parts: parts.map(([part]) => part) })
      resourcePages.push(parts[0][0])
      if (parts.length > 1) {
        resourcePages.push({
          group: `${resource.name} types`,
          expanded: false,
          pages: parts.slice(1).map(([part]) => part),
        })
      }
    }
    const functionPages = []
    for (const item of functions) {
      const page = `pulumi-any-terraform/providers/${dir}/functions/${item.slug}`
      const rendered = renderFunction(pkgInfo, item)
      const parts = splitLargePage(page, rendered.markdown, item.name)
      for (const [part, markdown] of parts) generated.set(part, markdown)
      generated.set(`${page}#check`, { ...rendered, parts: parts.map(([part]) => part) })
      functionPages.push(parts[0][0])
      if (parts.length > 1) {
        functionPages.push({
          group: `${item.name} types`,
          expanded: false,
          pages: parts.slice(1).map(([part]) => part),
        })
      }
    }

    const pages = [overviewPath, configurationPath]
    if (resourcePages.length) {
      pages.push({ group: 'Resources', expanded: false, pages: resourcePages })
    }
    if (functionPages.length) {
      pages.push({ group: 'Functions', expanded: false, pages: functionPages })
    }
    navProviders.push({
      group: title,
      icon,
      pages,
      dir,
      title,
      npmName: pkgInfo.pkg.name,
      version: pkgInfo.pkg.version,
      upstream: decodeUpstream(pkgInfo.pkg),
    })
  }

  generated.set('pulumi-any-terraform/overview', renderProductOverview(navProviders))

  const providerRoot = join(docsRoot, 'pulumi-any-terraform/providers')
  rmSync(providerRoot, { recursive: true, force: true })
  for (const page of guidePages) {
    rmSync(join(docsRoot, 'pulumi-any-terraform', `${page}.mdx`), { force: true })
  }
  for (const [page, markdown] of generated) {
    if (page.endsWith('#check')) continue
    writePage(join(docsRoot, `${page}.mdx`), markdown)
  }

  for (const [page, rendered] of generated) {
    if (!page.endsWith('#check')) continue
    verifyRendered(join(docsRoot, `${page.slice(0, -'#check'.length)}.mdx`), rendered)
  }

  const docs = JSON.parse(read(docsJsonPath))
  docs.markdown.instructions = [
    'This site documents fast-url, format-prompt, ja4, vn-number, what-the-fetch, and Pulumi Any Terraform.',
    'Each library is a separate product. Its pages start at /<library>/overview.',
    'Pulumi provider packages are TypeScript modules named pulumi-<provider>. Resource pages are /pulumi-any-terraform/providers/<provider>/resources/<resource>. Function pages are under functions.',
    'Nested object fields are under that object heading. A long reference continues on the linked part pages. They are not arguments of the parent resource.',
    'Use only the APIs and fields written on the pages for that library. Do not invent fields.',
    'The Markdown for a page is that path with .md appended.',
    'If a URL is missing, follow the suggested pages or search /search?q= instead of guessing another path.',
    'The published documentation site is https://docs.khanh.id.',
  ]
  const tab = docs.navigation.tabs[0]
  const product = tab.productGroups[0].products.find((item) => item.product === 'Pulumi Any Terraform')
  product.description = 'TypeScript packages bridged from Terraform providers'
  delete product.pages
  product.groups = [
    { group: 'Overview', pages: ['pulumi-any-terraform/overview'] },
    ...navProviders.map(({ group, icon, pages }) => ({ group, icon, pages })),
  ]

  const keptRedirects = docs.redirects.filter((redirect) => !redirect.source.startsWith('/pulumi-any-terraform'))
  const pulumiRedirects = [
    { source: '/pulumi-any-terraform', destination: '/pulumi-any-terraform/overview' },
    ...guidePages.map((page) => ({
      source: `/pulumi-any-terraform/${page}`,
      destination: '/pulumi-any-terraform/overview',
    })),
  ]
  for (const oldPage of [...legacyPages, ...oldProviderFiles]) {
    const destination = generated.has(oldPage)
      ? `/${oldPage}`
      : matchMoved(oldPage, generated) ?? providerOverview(oldPage)
    if (destination !== `/${oldPage}`) {
      pulumiRedirects.push({ source: `/${oldPage}`, destination })
    }
  }
  for (const [dir] of providerMeta) {
    const source = `/pulumi-any-terraform/providers/${dir}`
    if (!pulumiRedirects.some((redirect) => redirect.source === source)) {
      pulumiRedirects.push({
        source,
        destination: `/pulumi-any-terraform/providers/${dir}/overview`,
      })
    }
  }
  docs.redirects = [...keptRedirects, ...dedupeRedirects(pulumiRedirects)]
  writeFileSync(docsJsonPath, `${JSON.stringify(docs, null, 2)}\n`)

  const indexPath = join(docsRoot, 'index.mdx')
  const index = read(indexPath).replace(
    'Bridge any Terraform provider to Pulumi.',
    'TypeScript packages bridged from Terraform providers.',
  )
  writeFileSync(indexPath, index)

  assertFixtures()
  process.stderr.write(`wrote ${[...generated.keys()].filter((key) => !key.endsWith('#check')).length} pages\n`)
}

function matchMoved(oldPage, generated) {
  const parts = oldPage.split('/')
  const provider = parts[2]
  const slug = parts.at(-1)
  if (!provider || !slug || parts[1] !== 'providers') return null
  const resource = `pulumi-any-terraform/providers/${provider}/resources/${slug}`
  const fn = `pulumi-any-terraform/providers/${provider}/functions/${slug}`
  if (generated.has(resource)) return `/${resource}`
  if (generated.has(fn)) return `/${fn}`
  return null
}

function providerOverview(oldPage) {
  const parts = oldPage.split('/')
  if (parts[1] === 'providers' && parts[2]) {
    return `/pulumi-any-terraform/providers/${parts[2]}/overview`
  }
  return '/pulumi-any-terraform/overview'
}

function dedupeRedirects(redirects) {
  const seen = new Set()
  const result = []
  for (const redirect of redirects) {
    if (seen.has(redirect.source)) continue
    seen.add(redirect.source)
    result.push(redirect)
  }
  return result
}

function assertFixtures() {
  const pullzone = read(join(docsRoot, 'pulumi-any-terraform/providers/bunnynet/resources/pullzone.mdx'))
  const args = parseTable(pullzone, '## Arguments')
  const names = new Set(args.map((row) => row.name))
  if (names.has('originUrl') || names.has('storageZoneId') || names.has('type')) {
    throw new Error('Pullzone arguments still include a flattened origin field')
  }
  const origin = args.find((row) => row.name === 'origin')
  if (!origin || !origin.type.startsWith('PullzoneOrigin')) {
    throw new Error(`Pullzone.origin type is ${origin?.type}`)
  }
  const originHeading = origin.type === 'PullzoneOrigin' ? '## `PullzoneOrigin`' : `## \`${origin.type}\``
  const originRows = parseTable(pullzone, originHeading)
  const originNames = new Set(originRows.map((row) => row.name))
  if (!originNames.has('storagezone') || !originNames.has('type') || !originNames.has('url')) {
    throw new Error(`PullzoneOrigin fields: ${[...originNames].join(', ')}`)
  }
  const records = read(join(docsRoot, 'pulumi-any-terraform/providers/namecheap/resources/domain-records.mdx'))
  if (records.includes('@pulumi-any-terraform/namecheap') || records.includes('example.com')) {
    throw new Error('Namecheap page still contains a hand-written example')
  }
  if (!records.includes('pulumi-namecheap')) throw new Error('Namecheap import missing')
  const recordRows = parseTable(records, '## `DomainRecordsRecord (input)`')
  const recordNames = recordRows.map((row) => row.name)
  if (recordNames.join(',') !== 'address,hostname,mxPref,ttl,type') {
    throw new Error(`DomainRecordsRecord fields ${recordNames.join(',')}`)
  }
  const required = new Set(recordRows.filter((row) => row.flag === 'yes').map((row) => row.name))
  for (const name of ['address', 'hostname', 'type']) {
    if (!required.has(name)) throw new Error(`${name} should be required on DomainRecordsRecord`)
  }
  if (required.has('ttl') || required.has('mxPref')) throw new Error('optional DomainRecordsRecord field marked required')
  const overview = read(join(docsRoot, 'pulumi-any-terraform/overview.mdx'))
  if (/Python|Go, and C#|C#/.test(overview)) throw new Error('Overview still claims other languages')
}

main()
