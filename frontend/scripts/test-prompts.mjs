// Structural/wiring regressions, NOT proof of model behavior or prompt effectiveness.
// Run with `npm run test:prompts`; no build output, browser, backend, or new deps.
// The real TS builders and their local imports run in a small CommonJS VM loader.
// Only browser i18n initialization and workspace storage are stubbed. Registry
// list/get inputs are fixtures, not a test of tool discovery, schema delivery,
// permissions, filesystem execution, or language detection. Transpile != typecheck.
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(frontend, 'src')
const warnings = []
const i18n = { language: 'zh-CN' }
const boundaries = new Map([
  [path.join(src, 'i18n', 'index.ts'), { default: i18n, __esModule: true }],
  [path.join(src, 'services', 'fileSystem.ts'), {
    getAllFiles: async () => { throw new Error('Workspace storage is outside prompt structural tests') },
  }],
])
const context = vm.createContext({
  console: { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) },
})
const modules = new Map()

function load(specifier, importer = path.join(src, '__test__.ts')) {
  assert.ok(specifier.startsWith('@/') || specifier.startsWith('.'),
    `Unexpected external dependency ${specifier} from ${importer}; review environment boundary explicitly`)
  const base = specifier.startsWith('@/')
    ? path.join(src, specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier)
  const filename = [base, `${base}.ts`, path.join(base, 'index.ts')]
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  assert.ok(filename, `Cannot resolve ${specifier} from ${importer}`)
  assert.ok(filename.startsWith(`${src}${path.sep}`), `Import escapes src: ${filename}`)
  if (boundaries.has(filename)) return boundaries.get(filename)
  if (modules.has(filename)) return modules.get(filename).exports
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  modules.set(filename, module)
  const execute = new vm.Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename })
    .runInContext(context)
  execute((name) => load(name, filename), module, module.exports)
  return module.exports
}

const { composeSections, buildToolPromptSections } = load('@/agent/prompt')
const { MAIN_SECTIONS } = load('@/agent/prompt/sections')
const { buildExecutionThinkingBody } = load('@/agent/prompt/sections/executionThinking')
const { callableTools } = load('@/agent/prompt/sections/toolBasics')
const { buildCapabilityRegistry } = load('@/utils/capabilityRegistry')
const { buildSystemPromptSections, sectionsToMessages } = load('@/utils/systemPromptBuilder')
const { buildGeneralAgentSystemPrompt } = load('@/agent/generalAgentPrompt')
const { buildExploreAgentSystemPrompt } = load('@/agent/exploreAgentPrompt')
const capabilities = buildCapabilityRegistry({ webBridgeStatus: 'disconnected' })

const toolNames = ['read_file', 'write_file', 'run_command', 'execute_sql_query', 'grep', 'list_capabilities', 'read_capability']
function tool(name, overrides = {}) {
  return {
    name,
    description: `DESCRIPTION_${name}`,
    usagePrompt: `USAGE_${name}`,
    inputSchema: { type: 'object', properties: { SCHEMA_MUST_NOT_BE_IN_PROMPT: { type: 'string' } } },
    deferred: false,
    ...overrides,
  }
}
function promptContext(tools = []) {
  return {
    mode: capabilities.mode,
    capabilities,
    registry: {
      list: () => [...tools],
      get: (name) => tools.find((t) => t.name.toLowerCase() === name.toLowerCase()),
    },
  }
}
function occurrences(text, body) {
  assert.ok(body.length > 0, 'Expected a nonempty body')
  return text.split(body).length - 1
}
function headings(text) {
  return [...text.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => ({ number: Number(m[1]), title: m[2] }))
}
function resolved(text) {
  assert.doesNotMatch(text, /\{ref:/, 'Unresolved cross reference')
}
async function noWarnings(fn) {
  warnings.length = 0
  try {
    await fn()
    assert.deepEqual(warnings, [], 'Unexpected prompt composition warning')
  } finally {
    warnings.length = 0
  }
}
const section = (id, body, extra = {}) => ({ id, title: id.toUpperCase(), stability: 'static', build: () => body, ...extra })
const empty = promptContext()
const executionBody = buildExecutionThinkingBody()
const conditionalIds = ['discovery', 'sql', 'mcp', 'skill', 'skill-craft', 'workflow-craft', 'long-waits']
const cases = [
  { name: 'no tools', tools: [], active: [] },
  { name: 'read_file only', tools: [tool('read_file')], active: ['skill'] },
  { name: 'write_file only', tools: [tool('write_file')], active: ['skill-craft', 'workflow-craft'] },
  { name: 'run_command only', tools: [tool('run_command')], active: ['long-waits'] },
  { name: 'execute_sql_query only', tools: [tool('execute_sql_query')], active: ['sql'] },
  { name: 'grep only', tools: [tool('grep')], active: [] },
  { name: 'list_capabilities only', tools: [tool('list_capabilities')], active: ['discovery'] },
  { name: 'read_capability only', tools: [tool('read_capability')], active: ['discovery'] },
  { name: 'all seven requested tools', tools: toolNames.map((name) => tool(name)), active: conditionalIds.filter((id) => id !== 'mcp') },
  { name: 'deferred SQL', tools: [tool('execute_sql_query', { deferred: true })], active: [] },
  { name: 'always-loaded deferred SQL', tools: [tool('execute_sql_query', { deferred: true, alwaysLoad: true })], active: ['sql'] },
  { name: 'MCP without discovery primitives', tools: [tool('mcp__fixture__query')], active: ['mcp'] },
]

// Explicit expectations for gates are independent of the production when predicates.
test('MAIN_SECTIONS IDs, order and static/session boundary', () => {
  const ids = [...MAIN_SECTIONS].map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, 'Duplicate section ID')
  assert.equal(ids[0], 'work-cognition')
  for (const [before, after] of [
    ['when-to-call', 'callable-tools'], ['callable-tools', 'discovery'],
    ['feedback-nature', 'execution-thinking'], ['execution-thinking', 'system-signals'],
  ]) assert.ok(ids.indexOf(before) >= 0 && ids.indexOf(before) < ids.indexOf(after), `${before} must precede ${after}`)
  let seenSession = false
  for (const def of MAIN_SECTIONS) {
    assert.match(def.id, /^[\w-]+$/)
    assert.ok(def.title.trim())
    assert.equal(typeof def.build, 'function')
    assert.ok(['static', 'session'].includes(def.stability))
    if (def.stability === 'session') seenSession = true
    else assert.equal(seenSession, false, `${def.id} breaks static prefix`)
  }
  assert.deepEqual([...MAIN_SECTIONS].filter((d) => d.when).map((d) => d.id).sort(), [...conditionalIds].sort())
})

test('compose resolves forward/back/self references and strips leading body newlines', () => noWarnings(() => {
  const output = composeSections(empty, [section('a', '\n\n{ref:b} / {ref:a}'), section('b', '{ref:a}')])
  assert.equal(output, '### 1. A\n§2 / §1\n\n### 2. B\n§1')
}))
test('compose filters before numbering, resolves fallback and never builds inactive sections', () => noWarnings(() => {
  const output = composeSections(empty, [
    section('a', '{ref:hidden|not available} / {ref:c}'),
    section('hidden', '', { when: () => false, build: () => assert.fail('Inactive section built') }),
    section('c', '{ref:a}'),
  ])
  assert.equal(output, '### 1. A\nnot available / §2\n\n### 2. C\n§1')
  assert.equal(composeSections(empty, []), '')
}))
test('compose uses section reference over fallback when target is active', () => noWarnings(() => {
  assert.equal(composeSections(empty, [section('a', '{ref:a|unused}')]), '### 1. A\n§1')
}))
test('compose warns and preserves missing references without a fallback', () => {
  warnings.length = 0
  try {
    assert.equal(composeSections(empty, [section('a', '{ref:missing}')]), '### 1. A\n{ref:missing}')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('a') && warnings[0].includes('missing'))
  } finally { warnings.length = 0 }
})
test('compose diagnoses static after session, but accepts static then session', () => {
  warnings.length = 0
  try {
    composeSections(empty, [section('a', ''), section('s', '', { stability: 'session' })])
    assert.equal(warnings.length, 0)
    composeSections(empty, [section('s', '', { stability: 'session' }), section('a', '')])
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('a') && warnings[0].includes('static'))
  } finally { warnings.length = 0 }
})

for (const fixture of cases) {
  test(`real tool/main builders: ${fixture.name} (gates, refs, wiring, repeatability)`, () => noWarnings(async () => {
    const ctx = promptContext(fixture.tools)
    const expected = [...MAIN_SECTIONS].filter((d) => !conditionalIds.includes(d.id) || fixture.active.includes(d.id))
    assert.deepEqual([...MAIN_SECTIONS].filter((d) => !d.when || d.when(ctx)).map((d) => d.id), expected.map((d) => d.id))
    const toolSections = buildToolPromptSections(ctx)
    assert.deepEqual([...toolSections].map((s) => s.section), ['tool_usage', 'file_handling', 'safety'])
    const usage = toolSections[0].content
    assert.deepEqual(headings(usage), expected.map((d, i) => ({ number: i + 1, title: d.title })))
    assert.equal(occurrences(usage, composeSections(ctx, MAIN_SECTIONS)), 1)
    // Whole-body identity is deliberately a wiring assertion, not a behavioral claim.
    assert.equal(occurrences(usage, executionBody), 1)
    const waits = MAIN_SECTIONS.find((d) => d.id === 'long-waits')
    assert.equal(occurrences(usage, waits.build(ctx)), fixture.active.includes('long-waits') ? 1 : 0)
    for (const s of toolSections) {
      assert.ok(s.content.trim())
      resolved(s.content)
    }
    assert.equal(JSON.stringify(buildToolPromptSections(ctx)), JSON.stringify(toolSections))

    const main = await buildSystemPromptSections(capabilities, ctx.registry)
    const repeat = await buildSystemPromptSections(capabilities, ctx.registry)
    assert.equal(JSON.stringify(repeat), JSON.stringify(main))
    for (const expectedSection of toolSections) {
      const actual = [...main].filter((s) => s.section === expectedSection.section)
      assert.equal(actual.length, 1)
      assert.equal(actual[0].content, expectedSection.content)
      assert.equal(actual[0].role, 'system')
      assert.equal(actual[0].priority, 4)
    }
    const messages = sectionsToMessages(main)
    assert.equal(messages.length, main.length)
    assert.equal(occurrences([...messages].map((m) => m.content).join('\n'), executionBody), 1)
    for (const s of main) {
      assert.equal(s.role, 'system')
      assert.ok(Number.isFinite(s.priority))
      assert.ok(s.content.trim())
      resolved(s.content)
    }
  }))
}

test('callableTools shows visible descriptions/usage once, not schemas or deferred usage', () => noWarnings(() => {
  const tools = [
    tool('visible_tool'),
    tool('deferred_tool', { deferred: true }),
    tool('forced_tool', { deferred: true, alwaysLoad: true }),
  ]
  // Throwing schema getter catches schema access even when formatting changes.
  for (const t of tools) Object.defineProperty(t, 'inputSchema', { get: () => assert.fail('Prompt builder read tool schema') })
  const ctx = promptContext(tools)
  const body = callableTools.build(ctx)
  const output = buildToolPromptSections(ctx).map((s) => s.content).join('\n')
  for (const name of ['visible_tool', 'forced_tool']) {
    assert.equal(occurrences(body, `**${name}**`), 1)
    assert.equal(occurrences(body, `DESCRIPTION_${name}`), 1)
    assert.equal(occurrences(body, `USAGE_${name}`), 1)
    assert.equal(occurrences(output, `USAGE_${name}`), 1)
  }
  assert.doesNotMatch(output, /DESCRIPTION_deferred_tool|USAGE_deferred_tool|\*\*deferred_tool\*\*|SCHEMA_MUST_NOT_BE_IN_PROMPT/)
  resolved(output)
}))

test('ordinary general agent includes executionThinking exactly once and is repeatable', () => noWarnings(() => {
  for (const opts of [
    { hasCapabilityPrimitives: false },
    { hasCapabilityPrimitives: true, sql: { dialect: 'sqlite' } },
    { hasCapabilityPrimitives: true, sql: { dialect: 'sqlserver' }, structuredOutputToolName: 'submit_fixture' },
  ]) {
    const output = buildGeneralAgentSystemPrompt(opts)
    assert.equal(occurrences(output, executionBody), 1)
    assert.equal(buildGeneralAgentSystemPrompt(opts), output)
    resolved(output)
  }
}))
test('stateKeeper excludes ordinary executionThinking body and is repeatable', () => noWarnings(() => {
  for (const hasCapabilityPrimitives of [false, true]) {
    const opts = { hasCapabilityPrimitives, stateKeeper: { statePath: '/workspace/state/fixture.txt' }, sql: { dialect: 'sqlite' } }
    const output = buildGeneralAgentSystemPrompt(opts)
    assert.equal(occurrences(output, executionBody), 0)
    assert.equal(buildGeneralAgentSystemPrompt(opts), output)
    resolved(output)
  }
}))
test('explore excludes executionThinking for all thoroughness levels and is repeatable', () => noWarnings(() => {
  for (const thoroughness of ['quick', 'medium', 'thorough']) {
    const opts = { thoroughness, hasCapabilityPrimitives: true, sql: { dialect: 'sqlite' } }
    const output = buildExploreAgentSystemPrompt(opts)
    assert.equal(occurrences(output, executionBody), 0)
    assert.equal(buildExploreAgentSystemPrompt(opts), output)
    resolved(output)
  }
}))
test('main assembly remains byte-identical across different calendar dates', () => noWarnings(async () => {
  const ctx = promptContext(toolNames.map((name) => tool(name)))
  const atDate = async (iso) => {
    const epoch = Date.parse(iso)
    context.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [epoch])) }
      static now() { return epoch }
    }
    return JSON.stringify(await buildSystemPromptSections(capabilities, ctx.registry))
  }
  try {
    assert.equal(await atDate('2026-01-01T12:00:00Z'), await atDate('2027-07-15T12:00:00Z'))
  } finally { delete context.Date }
}))

test('actual main builder language gate runs with fixed i18n boundary inputs', () => noWarnings(async () => {
  try {
    i18n.language = 'en-US'
    const english = await buildSystemPromptSections(capabilities, empty.registry)
    assert.equal([...english].filter((s) => s.section === 'language').length, 1)
    assert.equal(JSON.stringify(await buildSystemPromptSections(capabilities, empty.registry)), JSON.stringify(english))
    i18n.language = 'zh-CN'
    const chinese = await buildSystemPromptSections(capabilities, empty.registry)
    assert.equal([...chinese].filter((s) => s.section === 'language').length, 0)
    assert.equal(JSON.stringify(english.filter((s) => s.section !== 'language')), JSON.stringify(chinese))
  } finally { i18n.language = 'zh-CN' }
}))
