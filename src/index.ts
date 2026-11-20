/** Cordis 入口（唯一的 adapter 层）：把 cordis 服务接到纯逻辑上。 */

import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { parseRoute } from './core.ts'
import { TeamModelService } from './service.ts'
import type { TeamEnv } from './service.ts'
import { loadState, saveState, statePath } from './storage.ts'
import type { Route } from './types.ts'

export const name = 'team-models'
export const inject = ['agents', 'agentTeams', 'subagents', 'tools']

export interface Config {
  /** 团队默认模型串（provider/model[$level]）；仅在状态文件没有 defaultModel 时作为种子。 */
  defaultModel?: string
  /** false 时队友侧不注册 set/reset 工具（默认 true）。 */
  allowSelfSelect?: boolean
  /** 首次种子 per-teammate 覆盖；状态文件里已有的成员不会被覆盖。 */
  overrides?: Array<{ member?: string; model?: string }>
}

export const Config: z<Config> = z.object({
  defaultModel: z.string(),
  allowSelfSelect: z.boolean().default(true),
  overrides: z.array(z.object({
    member: z.string(),
    model: z.string(),
  })),
})

function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    model: { type: 'string' },
    source: { type: 'string', required: true, enum: ['override', 'default', 'dispatch'] },
  },
} as const

const LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defaultModel: { type: 'string' },
    rows: { type: 'array', required: true, items: ROW_SCHEMA },
  },
} as const

const SET_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { row: { ...ROW_SCHEMA, required: true } },
} as const

const RESET_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { cleared: { type: 'array', required: true, items: { type: 'string' } } },
} as const

const DEFAULT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { defaultModel: { type: 'string' } },
} as const

/** 把内部 Route 转成宿主 ModelSelection（reasoningEffort 是宿主品牌类型）。 */
function toSelection(route: Route): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: route.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']> }),
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool registration. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

export function apply(ctx: Context, config: Config): void {
  const persistPath = statePath()
  const loaded = loadState(persistPath)
  if (loaded.warning !== undefined) console.warn(`[team-models] ${loaded.warning}`)
  const state = loaded.state

  // Config 只做首次种子：状态文件已有值时不覆盖（避免双源打架）。
  // schemastery 对非 required 字段会把 null 原样透传，这里显式只认字符串。
  if (state.defaultModel === undefined && typeof config.defaultModel === 'string' && config.defaultModel.length > 0) {
    const parsed = parseRoute(config.defaultModel)
    if ('error' in parsed) console.warn(`[team-models] config.defaultModel ignored: ${parsed.error}`)
    else state.defaultModel = parsed
  }
  for (const seed of config.overrides ?? []) {
    if (typeof seed.member !== 'string' || typeof seed.model !== 'string') {
      console.warn('[team-models] config override entry needs both "member" and "model" strings; entry ignored')
      continue
    }
    if (state.overrides[seed.member] !== undefined) continue
    const parsed = parseRoute(seed.model)
    if ('error' in parsed) {
      console.warn(`[team-models] config override for "${seed.member}" ignored: ${parsed.error}`)
      continue
    }
    state.overrides[seed.member] = parsed
  }
  if (state.defaultModel !== undefined || Object.keys(state.overrides).length > 0) {
    // 种子若来自 Config，先落盘一次，此后永远以状态文件为准。
    try {
      saveState(persistPath, state)
    } catch (error) {
      console.warn(`[team-models] cannot persist seeded state: ${String(error)}`)
    }
  }

  const allowSelfSelect = config.allowSelfSelect ?? true
  const service = new TeamModelService(state, allowSelfSelect, (next) => saveState(persistPath, next))
  const { agentTeams, subagents } = ctx

  const syncModel = (agent: Agent): void => {
    if (subagents.rootOf(agent) === agent) return
    const route = agentTeams.isEnabled(agent) ? service.routeFor(subagents.namesOf(agent).self) : undefined
    if (route === undefined && !service.manages(agent.id)) return
    const { provider, model, reasoningEffort } = agent.options
    const selected = route === undefined
      ? provider && model ? { provider, model, reasoningEffort } : undefined
      : toSelection(route)
    if (selected === undefined) throw new Error(`cannot restore dispatch model for ${agent.id}: no explicit dispatch route`)
    // Persist ownership before the durable selection; cold resume can compensate after a reset.
    if (route !== undefined) service.manage(agent.id, true)
    agent.model.select(selected)
    if (route === undefined) service.manage(agent.id, false)
  }

  const installs = new Map<Agent, () => void>()
  const syncModels = (): void => {
    const failures: unknown[] = []
    for (const agent of installs.keys()) {
      try { syncModel(agent) } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'cannot synchronize Team model selections')
  }

  const requireEnv = async (agent: Agent | undefined, toolName: string, signal: AbortSignal): Promise<TeamEnv> => {
    const caller = callingAgent(agent, toolName)
    if (!agentTeams.isEnabled(caller)) throw new Error(`${toolName} requires Agent Team mode`)
    const root = subagents.rootOf(caller)
    const descendants = await subagents.listDescendants(root.id, signal)
    signal.throwIfAborted()
    // Team mode and exact live ownership may have changed during the catalog read.
    if (!agentTeams.isEnabled(caller) || subagents.rootOf(caller) !== root) {
      throw new Error(`${toolName} requires an active Agent Team`)
    }
    const members: Array<{ name: string; role: 'lead' | 'teammate' }> = [{ name: 'lead', role: 'lead' }]
    for (const row of descendants) {
      if (row.kind === 'child' && row.mode === 'continuable') {
        members.push({ name: row.path ?? row.id, role: 'teammate' })
      }
    }
    return {
      caller: { role: caller === root ? 'lead' : 'teammate', name: subagents.namesOf(caller).self },
      members: () => members,
      echo: () => syncModels(),
    }
  }

  const toolsFor = (role: 'lead' | 'teammate'): Array<ReturnType<typeof defineTool>> => {
    const listTool = defineTool({
      name: 'team_model_list',
      description:
        'List the Agent Team default model and each member current model route with its source. '
        + 'Any Team member may call this.',
      parameters: {},
      output: jsonOutput(LIST_VALUE_SCHEMA),
      async execute(_args, exec) {
        return service.list(await requireEnv(exec.agent, 'team_model_list', exec.signal))
      },
    })

    if (role === 'teammate' && !allowSelfSelect) return [listTool]

    const setTool = defineTool({
      name: 'team_model_set',
      description:
        'Set the model route for one teammate. The Team Lead may target any teammate; '
        + 'a teammate may target only itself. Route format: "provider/model" with an optional '
        + '"$reasoningLevel" suffix (for example "provider-a/model-a$high"). '
        + 'Takes effect on the next step without touching the Lead session or the global default.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate name from team_model_list.' },
        model: { type: 'string', required: true, description: 'Route as "provider/model[$reasoningLevel]".' },
      },
      output: jsonOutput(SET_VALUE_SCHEMA),
      async execute(args, exec) {
        const env = await requireEnv(exec.agent, 'team_model_set', exec.signal)
        const parsed = parseRoute(args.model)
        if ('error' in parsed) throw new Error(parsed.error)
        return { row: service.set(env, args.target, parsed) }
      },
    })

    const resetTool = defineTool({
      name: 'team_model_reset',
      description:
        'Clear a teammate model override so it falls back to the team default, then to its dispatch route. '
        + 'The Team Lead may clear any teammate, or every override by omitting target; '
        + 'a teammate may clear only itself.',
      parameters: {
        target: {
          type: 'string',
          description: 'Teammate name; omit to clear every override (Team Lead only).',
        },
      },
      output: jsonOutput(RESET_VALUE_SCHEMA),
      async execute(args, exec) {
        const env = await requireEnv(exec.agent, 'team_model_reset', exec.signal)
        const result = service.reset(env, args.target)
        syncModels()
        return result
      },
    })

    const defaultTool = defineTool({
      name: 'team_model_default',
      description:
        'Set or clear the team-wide default model for teammates. Only the Team Lead may call this. '
        + 'Pass a route as "provider/model[$reasoningLevel]", or omit model to clear the default.',
      parameters: {
        model: { type: 'string', description: 'Default route as "provider/model[$reasoningLevel]"; omit to clear.' },
      },
      output: jsonOutput(DEFAULT_VALUE_SCHEMA),
      async execute(args, exec) {
        const env = await requireEnv(exec.agent, 'team_model_default', exec.signal)
        const parsed = args.model === undefined ? undefined : parseRoute(args.model)
        if (parsed !== undefined && 'error' in parsed) throw new Error(parsed.error)
        const result = service.setDefault(env, parsed)
        syncModels()
        return result
      },
    })

    return role === 'lead' ? [listTool, setTool, resetTool, defaultTool] : [listTool, setTool, resetTool]
  }

  const maybeInstall = (agent: Agent): void => {
    if (installs.has(agent)) return
    const role = subagents.rootOf(agent) === agent ? 'lead' : 'teammate'
    const dispose = agent.ctx.effect(() => {
      const disposers = toolsFor(role).map(tool => agent.ctx.tools.register(tool, {
        when: ({ agent: caller }) => agentTeams.isEnabled(caller),
      }))
      if (role === 'teammate') disposers.push(installModelSelection(agent.ctx))
      return () => { for (const stop of disposers) stop() }
    }, 'team-models.tools()')
    installs.set(agent, dispose)
    syncModel(agent)
  }

  // A child's agent/created notification precedes its runtime Activation. Only
  // subagent/start guarantees rootOf/namesOf and runs before the first prompt.
  ctx.on('subagent/start', info => {
    if (!info.local) return
    const agent = ctx.agents.get(info.id)
    if (agent !== undefined) maybeInstall(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') maybeInstall(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installs.get(agent)?.()
    installs.delete(agent)
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'team/mode') return
    try { syncModels() } catch (error) {
      console.warn(`[team-models] cannot synchronize Team mode: ${String(error)}`)
    }
  })
  ctx.effect(() => () => {
    for (const dispose of installs.values()) dispose()
    installs.clear()
  }, 'team-models.agents()')
  for (const agent of ctx.agents.list()) {
    try { maybeInstall(agent) } catch (error) {
      // HMR can observe a child between agent/created and runtime publication.
      // Its imminent subagent/start event will complete installation.
      if (agent.session.header.origin === 'subagent' && error instanceof Error
        && 'code' in error && error.code === 'UNAUTHORIZED') continue
      throw error
    }
  }
}
