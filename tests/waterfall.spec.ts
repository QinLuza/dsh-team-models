import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentModel } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import type { TeamModelState } from '../src/types.ts'

const disk = vi.hoisted(() => ({ state: { version: 1, overrides: {} } as TeamModelState }))
vi.mock('../src/storage.ts', () => ({
  statePath: () => 'unused-test-state.json',
  loadState: () => ({ state: structuredClone(disk.state) }),
  saveState: (_path: string, state: TeamModelState) => { disk.state = structuredClone(state) },
}))

const dispatch = { provider: 'original', model: 'dispatch', reasoningEffort: 'high' } as ModelSelection

/** Exercise the real plugin entry and AgentModel; only runtime membership and registration are fixtures. */
function harness(config = {}, seed = disk.state) {
  disk.state = seed
  let enabled = true
  const listeners = new Map<string, Array<(...args: any[]) => any>>()
  const cleanup: Array<() => void> = []
  const agents: any[] = []
  const pending = new Set<string>()
  const register = (event: string, fn: (...args: any[]) => any) => {
    const entries = listeners.get(event) ?? []
    entries.push(fn)
    listeners.set(event, entries)
    return () => entries.splice(entries.indexOf(fn), 1)
  }
  function member(id: string, name: string, root?: any, current = dispatch) {
    const projection: ModelSelectionProjectionState = { lastUsed: current, pending: null }
    const calls: ModelSelection[] = []
    const tools = new Map<string, any>()
    const conditions = new Map<string, any>()
    const ownCleanup: Array<() => void> = []
    const agent: any = {
      id, name, root, options: { ...dispatch }, calls, tools, conditions,
      session: {
        header: { id, ...(root ? { origin: 'subagent' } : {}) },
        append(_type: string, selection: ModelSelection) {
          calls.push(selection)
          Object.assign(projection, { pending: selection })
        },
      },
      ctx: {
        tools: { register(tool: any, options?: any) {
          tools.set(tool.name, tool)
          conditions.set(tool.name, options?.when)
          return () => { tools.delete(tool.name); conditions.delete(tool.name) }
        } },
        on: register,
        effect: (factory: any) => effect(factory, ownCleanup),
      },
    }
    agent.root ??= agent
    agent.model = new AgentModel(() => projection, agent.session, agent.options)
    agents.push(agent)
    return agent
  }
  function effect(factory: any, disposers = cleanup) {
    const value = factory()
    const fns = typeof value === 'function' ? [value] : [...value]
    const dispose = () => { for (const fn of fns.reverse()) fn() }
    disposers.push(dispose)
    return dispose
  }
  const lead = member('root', 'lead')
  const child = member('child', 'grader', lead)
  const subagents = {
    rootOf(agent: any) {
      if (pending.has(agent.id)) throw Object.assign(new Error('agent has no active runtime owner'), { code: 'UNAUTHORIZED' })
      return agent.root
    },
    namesOf: (agent: any) => ({ self: agent.name }),
    listDescendants: vi.fn(async (id: string) => agents
      .filter(a => a.root.id === id && a.id !== id)
      .map(a => ({ kind: 'child', mode: 'continuable', id: a.id, path: a.name }))),
  }
  const catalog = new Map<string, string[] | 'opaque'>()
  const unresolved = new Set<string>()
  const llm = {
    resolveModelInfo: vi.fn(async (provider: string, model: string) => {
      const key = `${provider}/${model}`
      if (unresolved.has(key)) throw new Error(`no adapter owns ${provider}`)
      const entry = catalog.get(key)
      return {
        provider, id: model, name: model,
        ...(entry === 'opaque' ? {} : { reasoning: { efforts: (entry ?? ['low', 'medium', 'high']).map(id => ({ id })) } }),
      }
    }),
  }
  const ctx: any = {
    agents: { list: () => agents, get: (id: string) => agents.find(a => a.id === id) },
    subagents,
    agentTeams: { isEnabled: () => enabled },
    llm,
    get(name: string) { return this[name] },
    on: register,
    effect: (factory: any) => effect(factory),
  }
  const emit = async (name: string, ...args: any[]) => {
    for (const fn of [...listeners.get(name) ?? []]) {
      const returned = fn(...args)
      if (name === 'subagent/start') expect(returned).toBeUndefined()
      else await returned
    }
  }
  const call = async (agent: any, name: string, args = {}) => {
    const tool = agent.tools.get(name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent, signal: new AbortController().signal })
  }
  return {
    lead, child, agents, member, ctx, subagents, pending, emit, call, catalog, unresolved, llm,
    install: () => apply(ctx, config),
    disable: async () => { enabled = false; await emit('session/event', lead.session, { type: 'team/mode' }) },
    dispose: () => { for (const fn of cleanup.reverse()) fn() },
  }
}

beforeEach(() => { disk.state = { version: 1, overrides: {} } })

describe('current DSH model selection adapter', () => {
  it('starts without legacy membership APIs and leaves unconfigured routes untouched', async () => {
    const h = harness()
    expect(() => h.install()).not.toThrow()
    const list = await h.call(h.lead, 'team_model_list')
    expect(list.rows).toEqual([
      { name: 'lead', role: 'lead', source: 'dispatch' },
      { name: 'grader', role: 'teammate', source: 'dispatch' },
    ])
    expect(h.child.calls).toEqual([])
    expect(h.lead.calls).toEqual([])
  })

  it('selects the next step through AgentModel, clears inherited effort, and resets to dispatch', async () => {
    const h = harness()
    h.install()
    const prepared = h.child.model.current()
    await h.call(h.lead, 'team_model_set', { target: 'grader', model: 'chosen/model' })
    expect(h.child.model.current()).toEqual({ provider: 'chosen', model: 'model' })
    expect(prepared).toEqual(dispatch)
    await h.call(h.lead, 'team_model_reset', { target: 'grader' })
    expect(h.child.model.current()).toEqual(dispatch)
    expect(h.lead.calls).toEqual([])
  })

  it('keeps explicit reasoning and falls back from override to the team default', async () => {
    const h = harness()
    h.install()
    await h.call(h.lead, 'team_model_default', { model: 'team/default$low' })
    await h.call(h.child, 'team_model_set', { target: 'grader', model: 'own/model$medium' })
    expect(h.child.model.current()).toEqual({ provider: 'own', model: 'model', reasoningEffort: 'medium' })
    await h.call(h.child, 'team_model_reset', { target: 'grader' })
    expect(h.child.model.current()).toEqual({ provider: 'team', model: 'default', reasoningEffort: 'low' })
    await h.call(h.lead, 'team_model_default')
    expect(h.child.model.current()).toEqual(dispatch)
  })

  it('denies selecting another teammate and modifying the lead', async () => {
    const h = harness()
    h.install()
    await expect(h.call(h.child, 'team_model_set', { target: 'someone', model: 'p/m' })).rejects.toThrow(/only target itself/)
    await expect(h.call(h.lead, 'team_model_set', { target: 'lead', model: 'p/m' })).rejects.toThrow(/Lead model/)
    expect(h.child.calls).toEqual([])
  })

  it('installs fresh and resumed children only after runtime ownership is published', async () => {
    const h = harness({ defaultModel: 'team/default' })
    h.install()
    const late = h.member('late', 'reviewer', h.lead)
    h.pending.add(late.id)
    await expect(h.emit('agent/created', { agent: late })).resolves.not.toThrow()
    expect(late.calls).toEqual([])
    h.pending.delete(late.id)
    await h.emit('subagent/start', { local: true, id: late.id })
    expect(late.model.current()).toEqual({ provider: 'team', model: 'default' })
    const external = h.member('external', 'codex', h.lead)
    await h.emit('subagent/start', { local: false, id: external.id })
    expect(external.tools.size).toBe(0)
  })

  it('restores a cold member after its override was cleared while it was offline', async () => {
    const first = harness()
    first.install()
    await first.call(first.lead, 'team_model_set', { target: 'grader', model: 'p/override' })
    const saved = structuredClone(disk.state)
    await first.emit('agent/disposed', { agent: first.child })
    first.agents.splice(first.agents.indexOf(first.child), 1)
    first.subagents.listDescendants.mockResolvedValueOnce([
      { kind: 'child', mode: 'continuable', id: 'child', path: 'grader' },
    ])
    await first.call(first.lead, 'team_model_reset', { target: 'grader' })
    const resumed = harness({}, disk.state)
    // The session still records the old override, while options restore its descriptor route.
    resumed.child.model.select({ provider: 'p', model: 'override' })
    resumed.child.calls.length = 0
    resumed.agents.splice(resumed.agents.indexOf(resumed.child), 1)
    resumed.install()
    resumed.agents.push(resumed.child)
    await resumed.emit('subagent/start', { local: true, id: resumed.child.id })
    expect(resumed.child.model.current()).toEqual(dispatch)
    expect(saved.overrides.grader).toBeDefined()
  })

  it('hides tools and restores managed routing when Team mode is turned off', async () => {
    const h = harness({ defaultModel: 'p/default' })
    h.install()
    await h.disable()
    expect(h.child.model.current()).toEqual(dispatch)
    const when = h.lead.conditions.get('team_model_list')
    expect(await when({ agent: h.lead })).toBe(false)
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m' })).rejects.toThrow(/Team/)
  })

  it('defers a child observed during the HMR publication window', async () => {
    const h = harness()
    h.pending.add(h.child.id)
    expect(() => h.install()).not.toThrow()
    expect(h.child.tools.size).toBe(0)
    h.pending.delete(h.child.id)
    await h.emit('subagent/start', { local: true, id: h.child.id })
    expect(h.child.tools.has('team_model_list')).toBe(true)
  })

  it('contains mode-change failures and still restores the remaining members', async () => {
    const h = harness({ defaultModel: 'p/default' })
    const other = h.member('other', 'reviewer', h.lead)
    h.install()
    delete h.child.options.provider
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(h.disable()).resolves.not.toThrow()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cannot restore dispatch model'))
      expect(other.model.current()).toEqual(dispatch)
    } finally { warning.mockRestore() }
  })

  it('lists nested and cold continuable members, omitting external and corrupt branches', async () => {
    const h = harness()
    h.install()
    h.subagents.listDescendants.mockResolvedValueOnce([
      { kind: 'child', mode: 'continuable', id: 'child', path: 'grader' },
      { kind: 'child', mode: 'continuable', id: 'cold', path: 'grader/checker' },
      { kind: 'child', mode: 'external', id: 'remote', path: 'codex' },
      { kind: 'diagnostic', id: 'bad', reason: 'corrupt' },
    ] as never)
    const list = await h.call(h.lead, 'team_model_list')
    expect(list.rows.map((row: any) => row.name)).toEqual(['lead', 'grader', 'grader/checker'])
  })

  it('does not change a selection when ownership cannot be persisted', async () => {
    const h = harness()
    h.install()
    const { saveState } = await import('../src/storage.ts')
    const failing = vi.spyOn(await import('../src/storage.ts'), 'saveState')
    // The override is saved first, then ownership must be saved before model.select.
    failing.mockImplementationOnce(saveState).mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m' })).rejects.toThrow('disk full')
    expect(h.child.calls).toEqual([])
    failing.mockRestore()
  })

  it('preserves an existing native selection when this plugin never managed the member', () => {
    const h = harness()
    h.child.model.select({ provider: 'native', model: 'chosen' })
    h.child.calls.length = 0
    h.install()
    expect(h.child.model.current()).toEqual({ provider: 'native', model: 'chosen' })
    expect(h.child.calls).toEqual([])
  })

  it('removes scoped tools on plugin unload and respects allowSelfSelect', () => {
    const h = harness({ allowSelfSelect: false })
    h.install()
    expect([...h.child.tools.keys()]).toEqual(['team_model_list'])
    h.dispose()
    expect(h.lead.tools.size).toBe(0)
    expect(h.child.tools.size).toBe(0)
  })
})

describe('reasoning effort selection (0.2.0)', () => {
  it('changes only the effort of an existing override', async () => {
    const h = harness()
    h.install()
    await h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m' })
    const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', effort: 'high' })
    expect(row.model).toBe('p/m$high')
    expect(h.child.model.current()).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('effort-only falls back to the team default route', async () => {
    const h = harness({ defaultModel: 'team/default$low' })
    h.install()
    const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', effort: 'medium' })
    expect(row.model).toBe('team/default$medium')
  })

  it('effort-only uses the live dispatch route when nothing is configured', async () => {
    const h = harness()
    h.install()
    const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', effort: 'low' })
    expect(row.model).toBe('original/dispatch$low')
    expect(h.child.model.current()).toEqual({ provider: 'original', model: 'dispatch', reasoningEffort: 'low' })
  })

  it('rejects effort-only for a cold member with no known route', async () => {
    const h = harness()
    h.install()
    await h.emit('agent/disposed', { agent: h.child })
    h.agents.splice(h.agents.indexOf(h.child), 1)
    h.subagents.listDescendants.mockResolvedValueOnce([
      { kind: 'child', mode: 'continuable', id: 'child', path: 'grader' },
    ])
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader', effort: 'low' }))
      .rejects.toThrow(/effort-only change needs a known current route/)
  })

  it('rejects conflicting suffix and effort parameter', async () => {
    const h = harness()
    h.install()
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m$low', effort: 'high' }))
      .rejects.toThrow(/conflicting reasoning levels/)
    expect(h.child.calls).toEqual([])
  })

  it('accepts a matching suffix and effort parameter', async () => {
    const h = harness()
    h.install()
    const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m$high', effort: 'high' })
    expect(row.model).toBe('p/m$high')
  })

  it('rejects an effort the model catalog does not support', async () => {
    const h = harness()
    h.catalog.set('p/m', ['low', 'high'])
    h.install()
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m', effort: 'medium' }))
      .rejects.toThrow(/does not support reasoning level "medium"; supported: low, high/)
    expect(h.child.calls).toEqual([])
  })

  it('passes unverifiable routes through with a warning', async () => {
    const h = harness()
    h.unresolved.add('p/m')
    h.install()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m', effort: 'xhigh' })
      expect(row.model).toBe('p/m$xhigh')
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cannot verify route p/m'))
    } finally { warning.mockRestore() }
  })

  it('accepts any effort when the adapter exposes no reasoning metadata', async () => {
    const h = harness()
    h.catalog.set('p/m', 'opaque')
    h.install()
    const { row } = await h.call(h.lead, 'team_model_set', { target: 'grader', model: 'p/m', effort: 'minimal' })
    expect(row.model).toBe('p/m$minimal')
  })

  it('adjusts only the default effort and rejects effort-only without a default', async () => {
    const h = harness({ defaultModel: 'team/default$low' })
    h.install()
    const set = await h.call(h.lead, 'team_model_default', { effort: 'high' })
    expect(set.defaultModel).toBe('team/default$high')
    expect(h.child.model.current()).toEqual({ provider: 'team', model: 'default', reasoningEffort: 'high' })
    await h.call(h.lead, 'team_model_default')
    await expect(h.call(h.lead, 'team_model_default', { effort: 'low' }))
      .rejects.toThrow(/effort-only change needs a known current route/)
  })

  it('lets a teammate adjust its own effort but not another member', async () => {
    const h = harness()
    h.install()
    const { row } = await h.call(h.child, 'team_model_set', { target: 'grader', effort: 'low' })
    expect(row.model).toBe('original/dispatch$low')
    await expect(h.call(h.child, 'team_model_set', { target: 'someone', effort: 'low' }))
      .rejects.toThrow(/only target itself/)
  })

  it('rejects set with neither model nor effort', async () => {
    const h = harness()
    h.install()
    await expect(h.call(h.lead, 'team_model_set', { target: 'grader' }))
      .rejects.toThrow(/pass model, effort, or both/)
  })
})
