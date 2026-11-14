# Changelog

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
