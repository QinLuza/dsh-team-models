import { describe, expect, it } from 'vitest'
import { checkSetTarget, effectiveRoute, formatRoute, parseRoute, routeSource } from '../src/core.ts'
import type { TeamModelState } from '../src/types.ts'

const EMPTY: TeamModelState = { version: 1, overrides: {} }

describe('parseRoute', () => {
  it('parses provider/model', () => {
    expect(parseRoute('provider-a/model-a')).toEqual({ provider: 'provider-a', model: 'model-a' })
  })

  it('parses the $reasoningLevel suffix', () => {
    expect(parseRoute('provider-a/model-a$high')).toEqual({
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseRoute('  provider-a/model-a  ')).toEqual({ provider: 'provider-a', model: 'model-a' })
  })

  it('rejects a bare model id', () => {
    const parsed = parseRoute('model-a')
    expect('error' in parsed && parsed.error).toMatch(/provider\/model/)
  })

  it('rejects an empty input', () => {
    const parsed = parseRoute('   ')
    expect('error' in parsed).toBe(true)
  })

  it('rejects a missing half', () => {
    expect('error' in parseRoute('provider-a/')).toBe(true)
    expect('error' in parseRoute('/model-a')).toBe(true)
  })

  it('rejects more than one slash', () => {
    const parsed = parseRoute('provider-a/model-a/extra')
    expect('error' in parsed && parsed.error).toMatch(/exactly one/)
  })

  it('rejects an empty level suffix', () => {
    expect('error' in parseRoute('provider-a/model-a$')).toBe(true)
  })

  it('rejects whitespace inside route halves', () => {
    expect('error' in parseRoute('provider a/model-a')).toBe(true)
  })
})

describe('formatRoute', () => {
  it('round-trips with the level suffix', () => {
    expect(formatRoute({ provider: 'p', model: 'm' })).toBe('p/m')
    expect(formatRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe('p/m$high')
  })
})

describe('effectiveRoute / routeSource (优先级真值表)', () => {
  const withDefault: TeamModelState = {
    version: 1,
    defaultModel: { provider: 'p', model: 'default' },
    overrides: { grader: { provider: 'p', model: 'override' } },
  }

  it('override wins over the team default', () => {
    expect(effectiveRoute(withDefault, 'grader')).toEqual({ provider: 'p', model: 'override' })
    expect(routeSource(withDefault, 'grader')).toBe('override')
  })

  it('default applies to a teammate without an override', () => {
    expect(effectiveRoute(withDefault, 'data-eng')).toEqual({ provider: 'p', model: 'default' })
    expect(routeSource(withDefault, 'data-eng')).toBe('default')
  })

  it('no config means no route (dispatch passthrough)', () => {
    expect(effectiveRoute(EMPTY, 'grader')).toBeUndefined()
    expect(routeSource(EMPTY, 'grader')).toBe('dispatch')
  })
})

describe('checkSetTarget (身份/越权矩阵)', () => {
  const teammates = ['grader', 'data-eng']
  const allow = true

  it('lead may target any teammate', () => {
    expect(checkSetTarget({ caller: { role: 'lead', name: 'lead' }, target: 'grader', allowSelfSelect: allow, teammates })).toEqual({ ok: true })
  })

  it('lead may not target itself', () => {
    const result = checkSetTarget({ caller: { role: 'lead', name: 'lead' }, target: 'lead', allowSelfSelect: allow, teammates })
    expect(result.ok).toBe(false)
  })

  it('lead may not target a non-teammate', () => {
    const result = checkSetTarget({ caller: { role: 'lead', name: 'lead' }, target: 'stranger', allowSelfSelect: allow, teammates })
    expect(result.ok).toBe(false)
  })

  it('teammate may target itself when allowSelfSelect is on', () => {
    expect(checkSetTarget({ caller: { role: 'teammate', name: 'grader' }, target: 'grader', allowSelfSelect: allow, teammates })).toEqual({ ok: true })
  })

  it('teammate may not target another member', () => {
    const result = checkSetTarget({ caller: { role: 'teammate', name: 'grader' }, target: 'data-eng', allowSelfSelect: allow, teammates })
    expect(result.ok).toBe(false)
  })

  it('teammate may not self-select when the deployment forbids it', () => {
    const result = checkSetTarget({ caller: { role: 'teammate', name: 'grader' }, target: 'grader', allowSelfSelect: false, teammates })
    expect(result.ok).toBe(false)
  })
})
