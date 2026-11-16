/** 纯服务层：工具背后的全部行为。不 import 任何 dsh 包；通过 TeamEnv 注入宿主能力。 */

import { checkSetTarget, effectiveRoute, formatRoute, routeSource } from './core.ts'
import type { Membership, Route, TeamModelRow, TeamModelState } from './types.ts'

/** 一次工具调用可用的宿主环境（由 index.ts 从 cordis ctx 构造）。 */
export interface TeamEnv {
  /** 确切调用者。 */
  readonly caller: Membership
  /** 调用者所在 Team 的全部成员（含 lead）。 */
  members(): ReadonlyArray<{ name: string; role: 'lead' | 'teammate' }>
  /** 尽力把选择回显成既有 model/selection 事件（目标不在线时静默跳过）。 */
  echo(member: string, route: Route): void
}

export interface TeamModelListValue {
  defaultModel?: string
  rows: TeamModelRow[]
}

export class TeamModelService {
  constructor(
    private state: TeamModelState,
    private readonly allowSelfSelect: boolean,
    private readonly persist: (state: TeamModelState) => void,
  ) {}

  /** Whether a durable selection was written by this plugin, including cold members. */
  manages(sessionId: string): boolean {
    return this.state.managed?.includes(sessionId) ?? false
  }

  /** Persist ownership so a reset while cold can restore the descriptor route on resume. */
  manage(sessionId: string, managed: boolean): void {
    if (this.manages(sessionId) === managed) return
    const ids = this.state.managed ?? []
    const next = {
      ...this.state,
      managed: managed ? [...ids, sessionId] : ids.filter(id => id !== sessionId),
    }
    this.persist(next)
    this.state = next
  }

  /** Resolve the selected route before the next step is prepared. */
  routeFor(member: string): Route | undefined {
    return effectiveRoute(this.state, member)
  }

  list(env: TeamEnv): TeamModelListValue {
    const rows = env.members().map((member): TeamModelRow => {
      // Lead 的模型不归本插件管，行里不给 model/source 只能标 dispatch。
      if (member.role === 'lead') return { name: member.name, role: 'lead', source: 'dispatch' }
      const route = effectiveRoute(this.state, member.name)
      return {
        name: member.name,
        role: 'teammate',
        ...(route === undefined ? {} : { model: formatRoute(route) }),
        source: routeSource(this.state, member.name),
      }
    })
    return {
      ...(this.state.defaultModel === undefined ? {} : { defaultModel: formatRoute(this.state.defaultModel) }),
      rows,
    }
  }

  set(env: TeamEnv, target: string, route: Route): TeamModelRow {
    const check = checkSetTarget({
      caller: env.caller,
      target,
      allowSelfSelect: this.allowSelfSelect,
      teammates: teammatesOf(env),
    })
    if (!check.ok) throw new Error(check.error)
    // 先写副本、落盘成功再换入：persist 抛错时内存状态保持旧值。
    const next: TeamModelState = {
      ...this.state,
      overrides: { ...this.state.overrides, [target]: route },
    }
    this.persist(next)
    this.state = next
    env.echo(target, route)
    return { name: target, role: 'teammate', model: formatRoute(route), source: 'override' }
  }

  reset(env: TeamEnv, target: string | undefined): { cleared: string[] } {
    if (env.caller.role === 'teammate') {
      if (!this.allowSelfSelect) {
        throw new Error('teammates may not select their own model in this deployment (allowSelfSelect=false)')
      }
      // 队友不传 target 会清空全表（含其他成员/其他 Team），必须显式点名自己。
      if (target === undefined) {
        throw new Error(`teammate "${env.caller.name}" must name itself; clearing every override is Team Lead only`)
      }
      if (target !== env.caller.name) {
        throw new Error(`teammate "${env.caller.name}" may only target itself, not "${target}"`)
      }
    } else if (target === undefined) {
      requireTeammates(env, 'clearing every override')
    } else {
      const check = checkSetTarget({
        caller: env.caller,
        target,
        allowSelfSelect: this.allowSelfSelect,
        teammates: teammatesOf(env),
      })
      if (!check.ok) throw new Error(check.error)
    }

    const cleared: string[] = []
    const overrides = { ...this.state.overrides }
    if (target === undefined) {
      for (const name of Object.keys(overrides)) {
        delete overrides[name]
        cleared.push(name)
      }
    } else if (overrides[target] !== undefined) {
      delete overrides[target]
      cleared.push(target)
    }
    if (cleared.length > 0) {
      const next: TeamModelState = { ...this.state, overrides }
      this.persist(next)
      this.state = next
    }
    return { cleared }
  }

  setDefault(env: TeamEnv, route: Route | undefined): { defaultModel?: string } {
    if (env.caller.role !== 'lead') {
      throw new Error('only the Team Lead may change the team default model')
    }
    // 普通 root 会话（没有队友）上游也判 lead；若放行，一个无关会话能改全局默认。
    requireTeammates(env, 'setting the team default model')
    const next: TeamModelState = { ...this.state, overrides: this.state.overrides }
    if (route === undefined) delete next.defaultModel
    else next.defaultModel = route
    this.persist(next)
    this.state = next
    return route === undefined ? {} : { defaultModel: formatRoute(route) }
  }
}

function teammatesOf(env: TeamEnv): string[] {
  return env.members().filter((member) => member.role === 'teammate').map((member) => member.name)
}

/** 全局动作（清全部 / 改团队默认）要求本队至少有一个 teammate，挡住非 Team root 会话。 */
function requireTeammates(env: TeamEnv, action: string): void {
  if (teammatesOf(env).length === 0) {
    throw new Error(`this session has no teammates; ${action} is only available inside an Agent Team`)
  }
}
