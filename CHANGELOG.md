# Changelog

## 0.1.1

- Adapt to DSH 0.2.2-rc.3: replace removed Team membership APIs and route
  waterfalls with subagent tree discovery and `agent.model.select()`.
- Initialize new and resumed children on `subagent/start`, gate Team tools by
  live mode, and dispose Agent registrations when the plugin unloads.
- Persist selection ownership so resets made while a member is cold restore
  its descriptor route on resume; retain version-1 state compatibility.
- Pin current DSH development dependencies and test the real AgentModel adapter.

## 0.1.0

Initial release.

- Per-teammate model overrides and a team-wide default model for DeepSeek Harness
  Agent Teams, applied at request time (`override > team default > dispatch route`).
- Four agent-callable tools: `team_model_list`, `team_model_set`,
  `team_model_reset`, `team_model_default`.
- Identity rules: the Team Lead may target any teammate; a teammate may only
  target itself (`allowSelfSelect` can disable teammate self-service entirely).
- Durable state under `$DSH_HOME/storages/team-models/state.json`, with
  field-level validation and corrupt-file quarantine.
- Zero intervention when nothing is configured; never touches the global
  default model; only appends the existing `model/selection` event.
- Verified against DSH `0.2.1-rc.5` (unit tests + on-device behavior gates).
