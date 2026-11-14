# dsh-team-models

**Per-teammate model selection for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Agent Teams.**

A Host-side Cordis bundle that gives every teammate its own model route: a team-wide
default model, plus agent-callable tools so the Team Lead — or a teammate itself — can
switch models at request time. No base modifications, no changes to the global default model.

> 中文说明见文末 [中文](#中文)。

## Why

In DSH Agent Teams, a teammate's model is **snapshotted at spawn** into its durable
`subagent/descriptor` event, and every later wake-up routes from that snapshot. The official
spawn chain does not accept a model parameter, and the generic session routes refuse model
switching for subagent-owned sessions (`session/agent-busy`); the desktop model picker hides
itself for teammate sessions.

The practical consequence: a teammate pinned to an exhausted quota — or to a model that is
simply wrong for its job — cannot be re-routed without tearing the team down.

## How it works

The plugin installs the official `installModelSelection` waterfalls on each **teammate's**
`agent.ctx` and resolves the route at request time:

```
per-teammate override  >  team default model  >  dispatch route (inherit Lead, unchanged)
```

- With nothing configured, every waterfall passes through untouched — behavior is identical
  to not having the plugin installed.
- Overrides and the team default live in `$DSH_HOME/storages/team-models/state.json`
  (atomic writes, field-level validation, corrupt files quarantined) and survive restarts.
- The plugin never writes the global default model and never introduces new session event
  types; it only appends the existing `model/selection` event as a best-effort echo.

## Install

Requires DSH `>=0.2.1-rc.5 <0.3.0` and Node `>=22.19`.

```bash
npm install
npm run build      # produces lib/index.js
```

Then mount it in a profile (e.g. `desktop`): add the package to the profile's
`dependencies` (a `link:` to this checkout works) and add `dsh-team-models` to
`dsh.profile.bundles`, then restart the host. The bundle's `cordis.patch.yml` inserts the
plugin row; if your loader rejects the bare package name, point the row's `name` at the
absolute path of the installed `lib/index.js`.

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

Model strings are `provider/model` with an optional `$reasoningLevel` suffix.

## Tools

| Tool | Caller | Effect |
|---|---|---|
| `team_model_list` | Lead / teammate | List the team default and each member's effective route + source |
| `team_model_set` | Lead: any teammate; teammate: itself only | Set a per-teammate override |
| `team_model_reset` | Lead: any/all; teammate: itself only | Clear overrides, fall back to default/dispatch |
| `team_model_default` | Lead only | Set or clear the team-wide default |

Identity is taken from the tool execution context (`exec.agent`), not from arguments, so a
teammate cannot spoof another member. Examples:

```jsonc
// Lead
{ "tool": "team_model_set", "target": "grader", "model": "provider-b/model-b$high" }
// Teammate (self only)
{ "tool": "team_model_set", "target": "grader", "model": "provider-b/model-b" }
```

Changes take effect on the teammate's **next step** (the prompt-assembly snapshot semantics
of the official model selection), without interrupting an in-flight request.

## Development

```bash
npm test           # vitest: routing precedence, identity matrix, storage, waterfalls
npm run typecheck  # tsc --noEmit
npm run build      # tsdown
```

The waterfall tests run against the real `installModelSelection` from
`@deepseek-ai/dsh-agent`, asserting both the zero-intervention passthrough and the override
behavior.

## Limitations

- Teammates only; the Lead's own model stays on the official path.
- No client UI in this release (Host half only).
- State is keyed by member name without a team dimension: two teams with identically named
  members would share overrides. Single-team deployments are the intended scope.
- Clearing an override falls back silently (the upstream notice waterfall early-returns when
  no selection is present); the request header still records the new route.
- Model strings are syntax-checked only; provider/model existence and reasoning-level
  support are validated by the provider at request time.
- Verified on DSH `0.2.1-rc.5`; other versions are not covered.

## Retirement

This plugin exists because upstream does not yet offer per-teammate model selection. If DSH
adds it (or lets `model/selection` override the descriptor), this plugin should be retired
rather than maintained in parallel.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

**给 DeepSeek Harness（DSH）Agent Teams 补上「每个队友自选模型」的外置 Host 插件。**

队友的模型在 spawn 时被快照进 durable 的 `subagent/descriptor`，之后每次唤醒都按它路由；
官方 spawn 链不接受模型参数，通用会话路由对 subagent 会话一律拒绝换模型，桌面选择器也对
队友隐藏。结果就是：队友被钉死在一条耗尽额度或不合适的路由上，只能拆队重建。

本插件在每个 **teammate** 的 `agent.ctx` 上安装官方 `installModelSelection` 的 waterfall，
请求期按 `成员覆盖 > 团队默认 > 派发路由` 解析；未配置时完全直通，行为与未装插件一致。
覆盖与团队默认落在 `$DSH_HOME/storages/team-models/state.json`（原子写、字段级校验、
坏文件隔离），跨重启存活；不碰全局默认模型，不新增事件类型。

四个 agent 工具：`team_model_list` / `team_model_set` / `team_model_reset` /
`team_model_default`。身份取自 `exec.agent`：Lead 可改任意队友，队友只能点名自己
（`allowSelfSelect=false` 可整体关闭队友自助）。改动在队友**下一个 step** 生效。

安装：`npm install && npm run build`，把包加进 profile 的 `dependencies` 与
`dsh.profile.bundles`（`dsh-team-models`），重启宿主。配置与工具示例见上文英文部分。

已知限制：仅覆盖 teammate；无客户端 UI；状态按成员名索引、无 team 维度（单团队场景适用）；
清除覆盖后回落不带提示；模型串只做语法校验。已在 DSH `0.2.1-rc.5` 上通过单测与真机行为门。
上游若原生支持 per-teammate 选择，本插件应退役而非并行维护。

MIT 许可。
