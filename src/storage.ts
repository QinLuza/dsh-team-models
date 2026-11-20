/** 状态文件读写：$DSH_HOME/storages/team-models/state.json。只依赖 node 标准库。 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Route, TeamModelState } from './types.ts'

/** 状态文件路径；$DSH_HOME 缺省或空白时回退 %USERPROFILE%/.dsh。 */
export function statePath(): string {
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'team-models', 'state.json')
}

export interface LoadedState {
  state: TeamModelState
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRoute(value: unknown): value is Route {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

/** 读取状态；文件不存在 = 空状态；JSON 损坏 = 空状态 + 另存 .corrupt-<ts>；字段级无效 = 丢弃该条并告警。 */
export function loadState(path: string): LoadedState {
  const empty = (): TeamModelState => ({ version: 1, overrides: {} })
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: empty() }
    return { state: empty(), warning: `state file ${path} is unreadable (${String(error)}); starting empty` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return corrupted(path, String(error))
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.overrides)) {
    return corrupted(path, 'unexpected shape')
  }

  // 字段级校验：坏条目丢弃，不让它毒化路由（否则该成员每个请求都会炸）。
  const overrides: Record<string, Route> = {}
  const dropped: string[] = []
  for (const [name, route] of Object.entries(parsed.overrides)) {
    if (isRoute(route)) overrides[name] = route
    else dropped.push(name)
  }
  const defaultModel = parsed.defaultModel === undefined
    ? undefined
    : isRoute(parsed.defaultModel)
      ? parsed.defaultModel
      : (dropped.push('defaultModel'), undefined)

  const managed = parsed.managed === undefined ? undefined
    : Array.isArray(parsed.managed) && parsed.managed.every(id => typeof id === 'string' && id.length > 0)
      ? [...new Set(parsed.managed as string[])]
      : (dropped.push('managed'), undefined)
  const state: TeamModelState = { version: 1, defaultModel, overrides, ...(managed === undefined ? {} : { managed }) }
  if (dropped.length === 0) return { state }
  return {
    state,
    warning: `state file ${path} had ${dropped.length} invalid entr${dropped.length === 1 ? 'y' : 'ies'} (${dropped.join(', ')}); they were ignored`,
  }
}

function corrupted(path: string, reason: string): LoadedState {
  let warning = `state file ${path} is corrupted (${reason}); starting empty`
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
    warning += '; the original file was kept beside it'
  } catch {
    warning += '; the original file was left in place'
  }
  return { state: { version: 1, overrides: {} }, warning }
}

/** 原子写：先写 .tmp 再 rename。失败向上抛，调用方（工具）转成可读错误。 */
export function saveState(path: string, state: TeamModelState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
