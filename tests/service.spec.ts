import { describe, expect, it, vi } from 'vitest'
import { TeamModelService } from '../src/service.ts'
import type { TeamEnv } from '../src/service.ts'
import type { Membership, TeamModelState } from '../src/types.ts'

const ROSTER = [
  { name: 'lead', role: 'lead' as const },
  { name: 'grader', role: 'teammate' as const },
  { name: 'data-eng', role: 'teammate' as const },
]

function makeEnv(caller: Membership, roster = ROSTER): { env: TeamEnv; echoed: string[] } {
  const echoed: string[] = []
  const env: TeamEnv = {
    caller,
    members: () => roster,
    echo: (member, route) => {
      echoed.push(`${member}=${route.provider}/${route.model}`)
    },
  }
  return { env, echoed }
}

/** 没有队友的 root 会话（上游也把它判成 lead）。 */
const SOLO_ROSTER = [{ name: 'lead', role: 'lead' as const }]

function makeService(state: TeamModelState, allowSelfSelect = true) {
  const persist = vi.fn((next: TeamModelState) => { saved = next })
  let saved: TeamModelState = state
  const service = new TeamModelService(state, allowSelfSelect, persist)
  return { service, persist, saved: () => saved }
}

describe('TeamModelService.list', () => {
  it('marks every row dispatch when there is no configuration', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    const value = service.list(env)
    expect(value.defaultModel).toBeUndefined()
    expect(value.rows.map((row) => row.source)).toEqual(['dispatch', 'dispatch', 'dispatch'])
    expect(value.rows.every((row) => row.model === undefined)).toBe(true)
  })

  it('shows override and default sources per member', () => {
    const { service } = makeService({
      version: 1,
      defaultModel: { provider: 'p', model: 'default' },
      overrides: { grader: { provider: 'p', model: 'override' } },
    })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    const value = service.list(env)
    expect(value.defaultModel).toBe('p/default')
    expect(value.rows.find((row) => row.name === 'grader')).toMatchObject({ model: 'p/override', source: 'override' })
    expect(value.rows.find((row) => row.name === 'data-eng')).toMatchObject({ model: 'p/default', source: 'default' })
    // Lead 行不归本插件管
    expect(value.rows.find((row) => row.name === 'lead')?.model).toBeUndefined()
  })
})

describe('TeamModelService.set', () => {
  it('lead sets any teammate: persists, echoes, returns the row', () => {
    const { service, persist } = makeService({ version: 1, overrides: {} })
    const { env, echoed } = makeEnv({ role: 'lead', name: 'lead' })
    const row = service.set(env, 'grader', { provider: 'p', model: 'm' })
    expect(row).toEqual({ name: 'grader', role: 'teammate', model: 'p/m', source: 'override' })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(echoed).toEqual(['grader=p/m'])
    expect(service.routeFor('grader')).toEqual({ provider: 'p', model: 'm' })
  })

  it('teammate sets itself', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.set(env, 'grader', { provider: 'p', model: 'm' })).not.toThrow()
  })

  it('teammate cannot set another member', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.set(env, 'data-eng', { provider: 'p', model: 'm' })).toThrow(/only target itself/)
  })

  it('teammate cannot self-select when allowSelfSelect=false', () => {
    const { service } = makeService({ version: 1, overrides: {} }, false)
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.set(env, 'grader', { provider: 'p', model: 'm' })).toThrow(/allowSelfSelect=false/)
  })

  it('rejects the lead as a target and unknown names', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    expect(() => service.set(env, 'lead', { provider: 'p', model: 'm' })).toThrow(/Lead model is not managed/)
    expect(() => service.set(env, 'stranger', { provider: 'p', model: 'm' })).toThrow(/not a teammate/)
  })

  it('a failed set does not persist or echo', () => {
    const { service, persist } = makeService({ version: 1, overrides: {} })
    const { env, echoed } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.set(env, 'data-eng', { provider: 'p', model: 'm' })).toThrow()
    expect(persist).not.toHaveBeenCalled()
    expect(echoed).toEqual([])
  })
})

describe('TeamModelService.reset', () => {
  it('lead clears one override', () => {
    const { service, persist } = makeService({
      version: 1,
      overrides: { grader: { provider: 'p', model: 'm' } },
    })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    expect(service.reset(env, 'grader')).toEqual({ cleared: ['grader'] })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(service.routeFor('grader')).toBeUndefined()
  })

  it('lead clears every override by omitting target', () => {
    const { service } = makeService({
      version: 1,
      overrides: {
        grader: { provider: 'p', model: 'm' },
        'data-eng': { provider: 'p', model: 'm2' },
      },
    })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    expect(service.reset(env, undefined).cleared.sort()).toEqual(['data-eng', 'grader'])
  })

  it('teammate clears only itself', () => {
    const { service } = makeService({
      version: 1,
      overrides: { grader: { provider: 'p', model: 'm' } },
    })
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(service.reset(env, 'grader')).toEqual({ cleared: ['grader'] })
    expect(() => service.reset(env, 'data-eng')).toThrow(/only target itself/)
  })

  it('teammate may not clear every override by omitting target', () => {
    const { service } = makeService({
      version: 1,
      overrides: {
        grader: { provider: 'p', model: 'm' },
        'data-eng': { provider: 'p', model: 'm2' },
      },
    })
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.reset(env, undefined)).toThrow(/must name itself/)
    // 别人的 override 仍在
    expect(service.routeFor('data-eng')).toEqual({ provider: 'p', model: 'm2' })
  })

  it('a solo lead (no teammates) may not clear every override', () => {
    const { service } = makeService({ version: 1, overrides: { grader: { provider: 'p', model: 'm' } } })
    const { env } = makeEnv({ role: 'lead', name: 'lead' }, SOLO_ROSTER)
    expect(() => service.reset(env, undefined)).toThrow(/no teammates/)
  })

  it('does not persist when nothing was cleared', () => {
    const { service, persist } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    expect(service.reset(env, 'grader')).toEqual({ cleared: [] })
    expect(persist).not.toHaveBeenCalled()
  })
})

describe('TeamModelService.setDefault', () => {
  it('lead sets and clears the team default', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'lead', name: 'lead' })
    expect(service.setDefault(env, { provider: 'p', model: 'm' })).toEqual({ defaultModel: 'p/m' })
    expect(service.routeFor('grader')).toEqual({ provider: 'p', model: 'm' })
    expect(service.setDefault(env, undefined)).toEqual({})
    expect(service.routeFor('grader')).toBeUndefined()
  })

  it('a teammate may not change the team default', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'teammate', name: 'grader' })
    expect(() => service.setDefault(env, { provider: 'p', model: 'm' })).toThrow(/only the Team Lead/)
  })

  it('a solo lead (no teammates) may not set the team default', () => {
    const { service } = makeService({ version: 1, overrides: {} })
    const { env } = makeEnv({ role: 'lead', name: 'lead' }, SOLO_ROSTER)
    expect(() => service.setDefault(env, { provider: 'p', model: 'm' })).toThrow(/no teammates/)
  })
})
