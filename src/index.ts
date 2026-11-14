/** Cordis 入口（唯一的 adapter 层）：把 cordis 服务接到纯逻辑上。 */

import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { parseRoute } from './core.ts'
import { TeamModelService } from './service.ts'
import type { TeamEnv } from './service.ts'
import { loadState, saveState, statePath } from './storage.ts'
import type { Route } from './types.ts'

export const name = 'team-models'
export const inject = ['agents', 'agentTeams', 'tools']

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

/** 本插件依赖的 agentTeams 服务最小面：实验包未随 rc5 发布到 npm，用结构类型对接。 */
interface TeamMembershipLike {
  role: 'lead' | 'teammate'
  name: string
}

interface TeamServiceLike {
  tryMembership(agent: Agent): TeamMembershipLike | undefined
  listMembers(agent: Agent): Array<{ id: string; name: string; role: 'lead' | 'teammate' }>
}

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
  const agentTeams = ctx.get('agentTeams') as unknown as TeamServiceLike

  const envFor = (agent: Agent): TeamEnv | undefined => {
    const membership = agentTeams.tryMembership(agent)
    if (membership === undefined) return undefined
    return {
      caller: { role: membership.role, name: membership.name },
      members: () => agentTeams.listMembers(agent).map((m) => ({ name: m.name, role: m.role })),
      echo: (memberName, route) => {
        const row = agentTeams.listMembers(agent).find((m) => m.name === memberName)
        if (row === undefined) return
        const target = ctx.agents.list().find((live) => String(live.id) === row.id)
        if (target === undefined) return
        // 'model/selection' 是宿主既有事件（modelSelection 投影消费它），
        // 事件表由 session-controller 包增补；本插件不带该包类型，故窄化 append。
        const session = target.session as unknown as { append(type: string, payload: unknown): void }
        try {
          session.append('model/selection', toSelection(route))
        } catch (error) {
          // 回显是尽力而为：落盘/换入已完成，回显失败不能让工具报错。
          console.warn(`[team-models] cannot echo model/selection for "${memberName}": ${String(error)}`)
        }
      },
    }
  }

  const requireEnv = (agent: Agent | undefined, toolName: string): TeamEnv => {
    const caller = callingAgent(agent, toolName)
    const env = envFor(caller)
    if (env === undefined) throw new Error(`${toolName} requires a session that belongs to an Agent Team`)
    return env
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
        return service.list(requireEnv(exec.agent, 'team_model_list'))
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
        const env = requireEnv(exec.agent, 'team_model_set')
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
        const env = requireEnv(exec.agent, 'team_model_reset')
        return service.reset(env, args.target)
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
        const env = requireEnv(exec.agent, 'team_model_default')
        if (args.model === undefined) return service.setDefault(env, undefined)
        const parsed = parseRoute(args.model)
        if ('error' in parsed) throw new Error(parsed.error)
        return service.setDefault(env, parsed)
      },
    })

    return role === 'lead' ? [listTool, setTool, resetTool, defaultTool] : [listTool, setTool, resetTool]
  }

  const installs = new Map<Agent, () => void>()

  const maybeInstall = (agent: Agent): void => {
    if (installs.has(agent)) return
    const env = envFor(agent)
    if (env === undefined) return

    const disposers: Array<() => void> = []
    if (env.caller.role === 'teammate') {
      const memberName = env.caller.name
      disposers.push(installModelSelection(agent.ctx, {
        get current(): ModelSelection | undefined {
          const route = service.routeFor(memberName)
          return route === undefined ? undefined : toSelection(route)
        },
        assembled: undefined,
      }))
    }
    for (const tool of toolsFor(env.caller.role)) {
      disposers.push(agent.ctx.tools.register(tool))
    }

    installs.set(agent, () => {
      for (const dispose of disposers) dispose()
    })
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
    return undefined
  })
}
