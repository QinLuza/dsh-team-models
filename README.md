# dsh-team-models

**Per-teammate model selection for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Agent Teams.**

A Host-side Cordis bundle that gives every teammate its own model route: a team-wide
default model, plus agent-callable tools so the Team Lead — or a teammate itself — can
switch models at request time. No base modifications, no changes to the global default model.

> 中文说明见文末 [中文](#中文)。

## Why

DSH 0.2.2 provides `agent.model.select()` for changing an Agent's next step. This
plugin exposes that capability as Team tools, with per-member authorization and a
persistent default for new and resumed teammates. The original dispatch route remains
in each teammate's descriptor and is restored when its plugin override is cleared.

## How it works

The plugin uses `subagents.rootOf()`, `namesOf()`, and `listDescendants()` for
membership and calls each **teammate's** `agent.model.select()` before its next step:

```
per-teammate override  >  team default model  >  dispatch route (inherit Lead, unchanged)
```

- With nothing configured, never-managed sessions keep their native model selection.
- Overrides, the default, and an optional `managed` Session ID list live in
  `$DSH_HOME/storages/team-models/state.json` (atomic writes, field validation,
  corrupt-file quarantine). Existing version-1 files remain readable.
- Ownership is saved before selecting a model. A reset while a teammate is cold
  restores its descriptor route through `agent.options` when it next resumes.
- New and resumed children are initialized synchronously on `subagent/start`, after
  runtime ownership exists and before their first prompt. External executions are excluded.
- Tools follow **Use Agent Teams** dynamically. Turning Team mode off restores live
  managed members to dispatch; turning it on reapplies their configured routes.
- Selections use the official durable `model/selection` event. No global default or
  custom Session event is written, and already-prepared requests keep their fixed route.

## Install

Requires DSH `>=0.2.2-rc.3 <0.3.0` and Node `>=22.19`. The compatibility tests
pin DSH `0.2.2-rc.3`; older APIs (`tryMembership` and selection waterfalls) are unsupported.

```bash
npm install
npm run build      # produces lib/index.js
```

Then install this built directory through DSH **Plugins > Add plugin**, or with
`plugin_manager` `install_bundle`. To install a self-contained artifact, run
`npm pack` and install the resulting tarball. The manager saves the dependency and
bundle selection; follow its result if a host restart is required. Building first is
necessary because the source repository does not contain `lib/index.js`.

## Configuration

All keys are optional (profile patch layer):

```yaml
- id: team-models
  name: 'dsh-team-models'
  config:
    defaultModel: 'provider/model$high'  # team default; unset = keep dispatch route
    allowSelfSelect: true                # false hides set/reset from teammates
    overrides:                           # first-run seed only; the state file wins later
      - member: grader
        model: 'provider/model'
```

Model strings are `provider/model` with an optional `$reasoningLevel` suffix. Since 0.2.0
an independent `effort` parameter is also accepted: passing `effort` alone changes only the
reasoning level of the member's current route (override > team default > live dispatch),
without re-naming the model. When the host model catalog exposes a model's supported
reasoning levels, unsupported levels are rejected up front with the supported list;
routes the catalog cannot resolve keep syntax-only validation (provider decides at request time).

## Tools

| Tool | Caller | Effect |
|---|---|---|
| `team_model_list` | Lead / teammate | List the team default and each member's effective route + source |
| `team_model_set` | Lead: any teammate; teammate: itself only | Set a per-teammate override (model and/or effort) |
| `team_model_reset` | Lead: any/all; teammate: itself only | Clear overrides, fall back to default/dispatch |
| `team_model_default` | Lead only | Set or clear the team-wide default (model and/or effort) |

Identity is taken from the tool execution context (`exec.agent`), not from arguments, so a
teammate cannot spoof another member. Examples:

```jsonc
// Lead: full route with a reasoning suffix
{ "tool": "team_model_set", "target": "grader", "model": "provider-b/model-b$high" }
// Lead: change only the reasoning level, keep grader's current model
{ "tool": "team_model_set", "target": "grader", "effort": "low" }
// Lead: team default model + effort as separate fields
{ "tool": "team_model_default", "model": "provider-b/model-b", "effort": "medium" }
// Teammate (self only)
{ "tool": "team_model_set", "target": "grader", "model": "provider-b/model-b" }
```

Changes take effect on the teammate's **next step** (the prompt-assembly snapshot semantics
of the official model selection), without interrupting an in-flight request.

## Development

```bash
npm test           # routing, authorization, storage, current DSH adapter and lifecycle
npm run typecheck  # tsc --noEmit
npm run build      # tsdown
```

Adapter tests exercise the plugin entry against the current DSH `AgentModel`,
including dispatch restoration, cold reset, first-prompt lifecycle ordering,
Team-mode gating, scoped unload, and unchanged native selections. Runtime membership
and tool registration use fixtures; the development dependencies pin the real API.

## Limitations

- Teammates only; the Lead's own model stays on the official path.
- No client UI in this release (Host half only).
- State is keyed by member name without a team dimension: two teams with identically named
  members would share overrides. Single-team deployments are the intended scope.
- A managed member needs an explicit dispatch provider/model in `agent.options` to
  restore its original route. An unavailable baseline is reported rather than fabricated.
- Selections are durable. Unloading removes tools and listeners but does not undo
  recorded choices; reset overrides and clear the default before uninstalling.
- Old 0.1.0 state files have no ownership metadata. Historical selections whose
  overrides were already removed cannot be distinguished from native choices; set
  and reset that member once to establish ownership before restoring dispatch.
- Model strings are validated against the host model catalog's reasoning levels when the
  adapter exposes them; routes the catalog cannot resolve fall back to syntax-only checks,
  with provider/model existence validated by the provider at request time.
- Compatibility tests target DSH `0.2.2-rc.3`; other versions are not covered.

## Retirement

This plugin supplies Team-facing tools and persistent defaults on top of the official
Agent model-selection API. If DSH provides equivalent Team tools and defaults, prefer
those rather than maintaining two independent sources of Team configuration.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

**给 DeepSeek Harness（DSH）Agent Teams 补上「每个队友自选模型」的外置 Host 插件。**

适配 DSH `0.2.2-rc.3`：使用官方 `agent.model.select()` 更新下一步模型，
通过 `subagents.rootOf / namesOf / listDescendants` 查询成员；不再使用旧版成员接口或
旧路由 waterfall。新建与冷恢复成员在运行时身份就绪后的 `subagent/start` 同步初始化。

路由优先级为 `成员覆盖 > 团队默认 > 派发路由`。未被插件管理的原生模型选择保持不变。
覆盖、默认值与可选的受管理 Session ID 列表持久化到
`$DSH_HOME/storages/team-models/state.json`，旧版 v1 文件仍可读取。成员离线期间重置覆盖，
会在下次恢复时从 `agent.options` 还原描述符中的派发模型。不碰全局默认模型，不新增事件类型。

四个 agent 工具：`team_model_list` / `team_model_set` / `team_model_reset` /
`team_model_default`。身份取自 `exec.agent`：Lead 可改任意队友，队友只能点名自己
（`allowSelfSelect=false` 可整体关闭队友自助）。改动在队友**下一个 step** 生效。

0.2.0 起支持**自选思考强度**：`team_model_set` / `team_model_default` 接受独立 `effort`
参数；只传 `effort` 即「只改思考强度、不动模型」，沿用该成员当前生效路由
（覆盖 > 团队默认 > 在线派发）。宿主模型目录暴露档位表时，非法档位会被当场拒绝并列出
可用档位（避免 kimi-k3 选「中」那类请求期才炸的事故）；目录解析不了的路由保持语法校验放行。
`$后缀` 与 `effort` 同时给出且冲突时报错。

安装：`npm ci && npm run build`，通过 DSH 插件管理器安装构建目录或 `npm pack` 生成的包。
工具随“使用 Agent Teams”开关生效；关闭 Team 模式时还原已管理的在线成员。

已知限制：仅覆盖可继续运行的本地 teammate；无客户端 UI；状态仍按成员名索引、无 team 维度，
适用于单团队；模型串在目录可解析时按档位表校验，解析不了时只做语法校验。派发模型必须包含明确的 provider/model。
旧 0.1.0 已删除覆盖的历史选择无法识别归属，可对该成员先设置再重置以还原派发模型。
官方选择是持久化的，卸载前应先重置覆盖并清除默认值。测试依赖固定为 DSH `0.2.2-rc.3`。
若上游提供同等 Team 工具与默认值管理，应优先使用上游功能。

MIT 许可。
