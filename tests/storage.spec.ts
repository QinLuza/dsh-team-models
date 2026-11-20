import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadState, saveState, statePath } from '../src/storage.ts'

function tempFile(name = 'state.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'team-models-')), name)
}

describe('loadState', () => {
  it('returns an empty state for a missing file', () => {
    const loaded = loadState(tempFile())
    expect(loaded.state).toEqual({ version: 1, overrides: {} })
    expect(loaded.warning).toBeUndefined()
  })

  it('round-trips a saved state', () => {
    const path = tempFile()
    saveState(path, { version: 1, defaultModel: { provider: 'p', model: 'd' }, overrides: { grader: { provider: 'p', model: 'm$high' } } })
    const loaded = loadState(path)
    expect(loaded.state.defaultModel).toEqual({ provider: 'p', model: 'd' })
    expect(loaded.state.overrides.grader).toEqual({ provider: 'p', model: 'm$high' })
  })

  it('preserves managed session ownership across restarts and accepts older v1 files', () => {
    const path = tempFile()
    saveState(path, { version: 1, overrides: {}, managed: ['cold-child', 'cold-child'] })
    expect(loadState(path).state.managed).toEqual(['cold-child'])
    saveState(path, { version: 1, overrides: {} })
    expect(loadState(path).state.managed).toBeUndefined()
  })

  it('drops invalid ownership metadata without discarding valid routes', () => {
    const path = tempFile()
    writeFileSync(path, JSON.stringify({
      version: 1, overrides: { grader: { provider: 'p', model: 'm' } }, managed: [null],
    }), 'utf8')
    const loaded = loadState(path)
    expect(loaded.state.overrides.grader).toEqual({ provider: 'p', model: 'm' })
    expect(loaded.state.managed).toBeUndefined()
    expect(loaded.warning).toContain('managed')
  })

  it('drops entries whose route shape is invalid and reports them', () => {
    const path = tempFile()
    writeFileSync(path, JSON.stringify({
      version: 1,
      defaultModel: 'not-a-route',
      overrides: {
        grader: 'p/m',
        'data-eng': { provider: 'p', model: 'm' },
        empty: { provider: '', model: 'm' },
      },
    }), 'utf8')
    const loaded = loadState(path)
    expect(loaded.state.overrides).toEqual({ 'data-eng': { provider: 'p', model: 'm' } })
    expect(loaded.state.defaultModel).toBeUndefined()
    expect(loaded.warning).toMatch(/invalid entries/)
  })

  it('keeps a corrupted file beside it and starts empty', () => {
    const path = tempFile()
    writeFileSync(path, 'not-json{', 'utf8')
    const loaded = loadState(path)
    expect(loaded.state).toEqual({ version: 1, overrides: {} })
    expect(loaded.warning).toMatch(/corrupted/)
    expect(existsSync(path)).toBe(false) // 原文件被另存
  })

  it('moves an unexpected-shape file aside too', () => {
    const path = tempFile()
    writeFileSync(path, JSON.stringify({ version: 2, overrides: {} }), 'utf8')
    const loaded = loadState(path)
    expect(loaded.warning).toMatch(/corrupted/)
  })
})

describe('statePath', () => {
  it('uses DSH_HOME when it is set', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'D:/somewhere/dsh-home'
    try {
      expect(statePath()).toBe(join('D:/somewhere/dsh-home', 'storages', 'team-models', 'state.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('falls back when DSH_HOME is blank', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '   '
    try {
      expect(statePath()).toContain(join('.dsh', 'storages', 'team-models', 'state.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
