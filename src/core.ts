/** 纯决策层：路由解析、优先级、身份规则。不 import 任何 dsh 包，不碰 IO。 */

import type { Membership, Route, RouteSource, TeamModelState } from './types.ts'

/** 把模型串解析成 Route；格式错误返回 { error }。 */
export function parseRoute(input: string): Route | { error: string } {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { error: 'model route is empty' }

  const parts = trimmed.split('$')
  if (parts.length > 2) return { error: `model route may carry at most one $reasoningLevel suffix (got "${input}")` }
  const routePart = parts[0] ?? ''
  const levelPart = parts[1]

  const slash = routePart.indexOf('/')
  if (slash <= 0 || slash === routePart.length - 1) {
    return { error: `model route must be "provider/model" (got "${input}")` }
  }
  const provider = routePart.slice(0, slash)
  const model = routePart.slice(slash + 1)
  if (provider.includes('/') || model.includes('/')) {
    return { error: `model route must contain exactly one "/" between provider and model (got "${input}")` }
  }
  if (/\s/.test(provider) || /\s/.test(model)) {
    return { error: `model route must not contain whitespace (got "${input}")` }
  }
  if (levelPart !== undefined && levelPart.length === 0) {
    return { error: 'model route has an empty $reasoningLevel suffix' }
  }

  return levelPart === undefined
    ? { provider, model }
    : { provider, model, reasoningEffort: levelPart }
}

/** 把 Route 格式回模型串（与 ListModels 的 id 形态一致）。 */
export function formatRoute(route: Route): string {
  const base = `${route.provider}/${route.model}`
  return route.reasoningEffort === undefined ? base : `${base}$${route.reasoningEffort}`
}

/**
 * 解析一次 set/default 的输入：model 与 effort 至少给一个。
 * - 只给 model：照 parseRoute（可带 $level 后缀）。
 * - 只给 effort：沿用 current 的 provider/model，仅换思考强度（current 必须已知）。
 * - 两者都给：effort 参数优先；与后缀冲突时报错，不静默吞。
 */
export function resolveSelection(
  model: string | undefined,
  effort: string | undefined,
  current: Route | undefined,
): Route | { error: string } {
  if (effort !== undefined && effort.trim().length === 0) return { error: 'effort must not be empty' }
  if (model === undefined) {
    if (effort === undefined) return { error: 'pass model, effort, or both' }
    if (current === undefined) {
      return { error: 'effort-only change needs a known current route; this member has no override/default and is not online — pass model explicitly' }
    }
    return { provider: current.provider, model: current.model, reasoningEffort: effort }
  }
  const parsed = parseRoute(model)
  if ('error' in parsed) return parsed
  if (effort === undefined) return parsed
  if (parsed.reasoningEffort !== undefined && parsed.reasoningEffort !== effort) {
    return { error: `conflicting reasoning levels: model suffix says "${parsed.reasoningEffort}" but effort says "${effort}"` }
  }
  return { provider: parsed.provider, model: parsed.model, reasoningEffort: effort }
}

/** 请求期优先级：override > 团队默认 > 派发路由（undefined 表示直通，不改路由）。 */
export function effectiveRoute(state: TeamModelState, member: string): Route | undefined {
  return state.overrides[member] ?? state.defaultModel
}

/** 该成员生效路由来自哪一层。 */
export function routeSource(state: TeamModelState, member: string): RouteSource {
  if (state.overrides[member] !== undefined) return 'override'
  if (state.defaultModel !== undefined) return 'default'
  return 'dispatch'
}

export type TargetCheck =
  | { ok: true }
  | { ok: false; error: string }

/**
 * 设置/清除目标的身份规则：
 * - teammate：只能指向自己；allowSelfSelect=false 时直接拒绝。
 * - lead：可指向本队任意 teammate；不允许把 "lead" 当目标（Lead 模型不归本插件管）。
 */
export function checkSetTarget(input: {
  caller: Membership
  target: string
  allowSelfSelect: boolean
  teammates: readonly string[]
}): TargetCheck {
  const { caller, target, allowSelfSelect, teammates } = input

  if (caller.role === 'teammate') {
    if (!allowSelfSelect) {
      return { ok: false, error: 'teammates may not select their own model in this deployment (allowSelfSelect=false)' }
    }
    if (target !== caller.name) {
      return { ok: false, error: `teammate "${caller.name}" may only target itself, not "${target}"` }
    }
    return { ok: true }
  }

  if (target === 'lead') {
    return { ok: false, error: 'the Lead model is not managed by team tools; use the native model picker for the Lead session' }
  }
  if (!teammates.includes(target)) {
    return { ok: false, error: `"${target}" is not a teammate in this Team` }
  }
  return { ok: true }
}
