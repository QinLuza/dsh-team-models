import { describe, expect, it } from 'vitest'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'

/**
 * 直接对着上游 `installModelSelection` 验证两个承重行为：
 * I-1 无路由时 request config 逐字段直通；有路由时 request 被覆盖（并清掉继承 effort）。
 */
function fakeAgentCtx() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  }
  return { ctx, handlers }
}

describe('installModelSelection waterfall (I-1 + override)', () => {
  it('passes the request through untouched when no route is configured', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx as never, selection)

    const assemble = handlers.get('system-prompt/assemble')!
    const assembled = await assemble({ variables: { keep: 1 } }, {}, async () => ({ variables: { keep: 1 } }))
    expect(assembled).toEqual({ variables: { keep: 1 } })
    expect(selection.assembled).toBeUndefined()

    const request = handlers.get('agent/request')!
    const original = { provider: 'lead-provider', model: 'lead-model', reasoningEffort: 'high' }
    const resolved = await request({}, async () => original)
    expect(resolved).toEqual(original) // 逐字段一致，包括继承的 effort

    dispose()
    expect(handlers.size).toBe(0)
  })

  it('overrides the request route and clears an inherited effort', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    const selection: ModelSelectionRef = { current: { provider: 'p', model: 'm' }, assembled: undefined }
    installModelSelection(ctx as never, selection)

    const assemble = handlers.get('system-prompt/assemble')!
    const assembled = await assemble({ variables: {} }, {}, async () => ({ variables: {} }))
    expect(assembled).toEqual({ variables: { provider: 'p', model: 'm' } })

    const request = handlers.get('agent/request')!
    const resolved = await request({}, async () => ({ provider: 'lead-provider', model: 'lead-model', reasoningEffort: 'high' }))
    expect(resolved).toEqual({ provider: 'p', model: 'm' })
  })

  it('applies a reasoning effort only when one is selected', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    const selection: ModelSelectionRef = {
      current: { provider: 'p', model: 'm', reasoningEffort: 'low' as ModelSelection['reasoningEffort'] },
      assembled: undefined,
    }
    installModelSelection(ctx as never, selection)

    await handlers.get('system-prompt/assemble')!({ variables: {} }, {}, async () => ({ variables: {} }))
    const resolved = await handlers.get('agent/request')!({}, async () => ({ provider: 'lead-provider', model: 'lead-model' }))
    expect(resolved).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('a dynamic getter follows route changes on the next step (请求期判定)', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    let route: { provider: string; model: string } | undefined
    const selection: ModelSelectionRef = {
      get current() {
        return route
      },
      assembled: undefined,
    }
    installModelSelection(ctx as never, selection)
    const assemble = handlers.get('system-prompt/assemble')!
    const request = handlers.get('agent/request')!

    // 第一步：无配置 → 直通
    await assemble({ variables: {} }, {}, async () => ({ variables: {} }))
    expect(await request({}, async () => ({ provider: 'lead', model: 'lead' }))).toEqual({ provider: 'lead', model: 'lead' })

    // 第二步前配置出现 → 下一 step 即跟随
    route = { provider: 'p', model: 'm' }
    await assemble({ variables: {} }, {}, async () => ({ variables: {} }))
    expect(await request({}, async () => ({ provider: 'lead', model: 'lead' }))).toEqual({ provider: 'p', model: 'm' })

    // 第三步前配置清除 → 回到直通
    route = undefined
    await assemble({ variables: {} }, {}, async () => ({ variables: {} }))
    expect(await request({}, async () => ({ provider: 'lead', model: 'lead' }))).toEqual({ provider: 'lead', model: 'lead' })
  })

  it('adds no [model changed] notice when no route is configured (I-1 pre-step half)', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(ctx as never, selection)

    await handlers.get('system-prompt/assemble')!({ variables: {} }, {}, async () => ({ variables: {} }))
    const preStep = handlers.get('agent/pre-step')!
    const agent = { session: { requestHeader: () => ({ config: { provider: 'lead', model: 'lead' } }) } }
    const decision = { kind: 'admit', messages: [] as unknown[] }
    const result = await preStep(
      { agent, messages: [], signal: { aborted: false }, step: 2 },
      async () => decision,
    )
    expect(result).toBe(decision)
  })

  it('adds exactly one [model changed] notice when the route differs from the persisted header', async () => {
    const { ctx, handlers } = fakeAgentCtx()
    const selection: ModelSelectionRef = { current: { provider: 'p', model: 'm' }, assembled: undefined }
    installModelSelection(ctx as never, selection)

    await handlers.get('system-prompt/assemble')!({ variables: {} }, {}, async () => ({ variables: {} }))
    const preStep = handlers.get('agent/pre-step')!
    const agent = { session: { requestHeader: () => ({ config: { provider: 'lead', model: 'lead' } }) } }
    const decision = { kind: 'admit', messages: [] as unknown[] }
    const result = await preStep(
      { agent, messages: [], signal: { aborted: false }, step: 2 },
      async () => decision,
    ) as { messages: Array<{ content: Array<{ text: string }> }> }
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.content[0]?.text).toContain('model changed')
  })
})
