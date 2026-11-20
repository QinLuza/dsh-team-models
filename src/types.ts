/** 类型定义（本文件只放类型，不放运行时代码）。 */

/** 一条 provider/model 路由，可带推理等级。 */
export interface Route {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 一个 Team 成员的确切身份（由子代理树的运行时归属确定）。 */
export interface Membership {
  role: 'lead' | 'teammate'
  name: string
}

/** 持久化的团队模型状态（$DSH_HOME/storages/team-models/state.json）。 */
export interface TeamModelState {
  version: 1
  defaultModel?: Route
  overrides: Record<string, Route>
  /** Sessions with plugin-written durable selections; retained until dispatch is restored. */
  managed?: string[]
}

/** 成员生效路由的来源。 */
export type RouteSource = 'override' | 'default' | 'dispatch'

/** team_model_list 的一行。 */
export interface TeamModelRow {
  name: string
  role: 'lead' | 'teammate'
  /** 仅当本插件为该成员供路由时出现（Lead 行不带）。 */
  model?: string
  source: RouteSource
}
