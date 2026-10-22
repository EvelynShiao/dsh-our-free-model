/**
 * The provider adapter.
 *
 * It satisfies the harness adapter contract structurally — `registerAdapter`
 * validates by calling the methods, not by an `instanceof` test — which is what
 * lets this plugin mount on more than one kernel line without importing a
 * version-pinned adapter base class.
 *
 * Two routes are published from one adapter instance, because the harness groups
 * the model picker strictly by provider route and offers no other grouping
 * field: `our-free-model` carries what this egress can use right now, and
 * `our-free-model-region` carries what the gateway refuses on this egress. A
 * group with no models is dropped from the picker by the client, so a user whose
 * VPN unlocks the region-gated models sees one group, and a user without sees
 * the second group labelled as such.
 *
 * @module src/adapter.js
 */

import { applyFingerprint, baseModelId, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, repairToolPairing } from './messages.js'
import { CODE, UpstreamError, postStreamed } from './http.js'
/* 2026-10-14：OpenCode v2 门禁（session 必须服务端注册）之后，免费车道唯一的合法通道。
   见 src/opencode-bridge.js 头部注释。 */
import { bridgeStream, readService, hasOpencodeCli, BRIDGE_HINT } from './opencode-bridge.js'
import { postSealedStreamed } from './eac.js'
import { postKiloStreamed } from './kilo.js'
import { postAggregateStreamed, isAggregateEntry } from './aggregate.js'
import { finishReason, readStream, windowTokens } from './stream.js'
import { DEFAULT_LEVEL, MIN_BUDGET, budgetFor, defaultEffortFor, effortPatchFor, effortsFor, resolveLevel } from './effort.js'
import { createChannel } from './channel.js'
import { recoveryPolicy, canRecover, canRecoverSilentStop, recoveryMessages, continuationMessages, checkpointFits, addUsage, createBlockTracker } from './recovery.js'
import { isEacEntry, isKiloEntry } from './catalog.js'
import { isComboEntry, comboChain } from './combos.js'
import { applyTokenSavers, saverConfig } from './token-saver/index.js'
import { classifyFailure, describeVerdict, shouldAdvance } from './route/classify.js'
import { FALLBACK_IMAGE_PRICING } from './image-pricing.js'

export const ROUTE_MAIN = 'our-free-model'
export const ROUTE_REGION = 'our-free-model-region'

/** Group headings — the only strings the picker shows as a section title. */
export const ROUTE_LABELS = {
  [ROUTE_MAIN]: 'Our Free Model',
  [ROUTE_REGION]: 'Our Free Model · region-limited',
}

const STYLE_FOR_WIRE = { chat: 'chat', responses: 'flat', messages: 'claude' }

export class FreeModelAdapter {
  /**
   * @param {object} dependencies
   * @param {() => {catalog: Array<object>, membership: Record<string, string[]>, settings: object, attributionUserAgent: string}} dependencies.state
   * @param {(ref: object) => string | undefined} [dependencies.resolveImage]
   * @param {(record: object) => void} dependencies.recordUsage
   * @param {(record: object) => void} [dependencies.recordTurn]
   * @param {(message: string) => void} [dependencies.warn]
   */
  constructor(dependencies) {
    this.deps = dependencies
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
  }

  /**
   * A fully resolved policy, not a configuration fragment.
   *
   * Both the 0.1.5 and 0.1.7 kernels store this object verbatim instead of
   * running it through their policy resolver, and the backoff scheduler reads the
   * delay fields off the top level. Reporting them nested under `backoff` makes
   * every scheduled delay `NaN`, which the durable session log then rejects —
   * turning a recoverable transient failure into an aborted turn.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      // A regional refusal is a property of the egress, not a transient fault;
      // retrying it only spends quota. It is deliberately absent here. So is
      // RATE_LIMIT: this lane's 429 carries a *growing* retry-after, and the two
      // automatic retries turned every quota wall into three walls — the same
      // turn, paid thrice, arriving later (issue #13).
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * Resolve provider-side request-image pricing for one exact model route.
   *
   * 宿主 spill-policy 遇到 undefined 会放弃整条含图结果的落盘（issue #151）。
   * 免费出口没有统一视觉计价协议，提供同步估算以支持预算与落盘。
   *
   * Must stay synchronous: the token meter resolves it per measurement, with no
   * I/O window (issue #42).
   *
   * @param {string} _provider - a route passed to `registerAdapter()` for this instance.
   * @param {string} _model - exact model id passed to GenerateOptions.model.
   * @returns {typeof FALLBACK_IMAGE_PRICING} 视觉 Token 估算，不是厂商真实消耗。
   */
  imageRequestPricing(_provider, _model) {
    return FALLBACK_IMAGE_PRICING
  }

  /** Models this route advertises right now.
   * hiddenModels（2026-10-20）：设置里勾掉的模型不进选择页——
   * resolveModel 不过滤，旧会话里已选中的隐藏模型照常能跑。 */
  async listModels(provider) {
    const state = this.deps.state()
    const ids = new Set(state.membership[provider] ?? [])
    const hidden = new Set(Array.isArray(state.settings.hiddenModels) ? state.settings.hiddenModels : [])
    return state.catalog
      .filter(entry => ids.has(entry.id) && !hidden.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: describe(entry, state.settings),
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const state = this.deps.state()
    const entry = state.catalog.find(candidate => candidate.id === baseModelId(model))
    if (entry === undefined) {
      return {
        provider,
        id: baseModelId(model),
        name: baseModelId(model),
        context: { contextWindow: 131072 },
        defaultMaxTokens: 8192,
      }
    }
    // 以模型自身输出上限为准（2026-10-15）。设置里的 defaultMaxTokens 只在
    // 被显式设成正数时才收缩（0 / 缺省 = 跟随模型）；旧代码无条件 min 会把能写
    // 131072 的模型压到 32768。
    const configuredCeiling = Number(state.settings.defaultMaxTokens) || 0
    const ceiling = configuredCeiling > 0
      ? Math.min(entry.maxOutput, configuredCeiling)
      : entry.maxOutput
    const efforts = effortsFor(entry, undefined, state.settings.defaultMaxTokens)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ceiling,
      ...efforts === undefined ? {} : { reasoning: { efforts, defaultEffort: defaultEffortFor(entry) } },
    }
  }

  /**
   * Bind model metadata and the dispatch closure to one state snapshot, so a
   * catalog refresh arriving mid-turn cannot mix one generation's capacities
   * with another's endpoint table.
   */
  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === baseModelId(model)) ?? null
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, entry, snapshot),
    }
  }

  /**
   * @param {object} options - GenerateOptions
   * @param {object|null} pinned - catalog row frozen by `prepareCall`, if any
   * @param {object} [snapshot] - state generation frozen by `prepareCall`
   */
  stream(options, pinned, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal }, pinned, snapshot)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    // 原生生成器把 return 排在 pending next 后；先取消请求才能立即退出。
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  /**
   * One turn: a combo walks its chain, everything else is a single model.
   *
   * A combo is a virtual model, so it reaches here as a pinned catalog row like
   * any other; the only difference is that its row carries a chain instead of an
   * endpoint. Resolving that here — rather than at the picker or the gateway —
   * means both callers get the failover for free.
   */
  async * runStream(options, pinned, snapshot) {
    const modelId = baseModelId(options.model)
    const entry = pinned ?? snapshot.catalog.find(candidate => candidate.id === modelId) ?? null
    if (entry !== null && isComboEntry(entry)) {
      yield * this.runCombo(options, entry, snapshot)
      return
    }
    yield * this.runSingle(options, entry, snapshot, {})
  }

  /**
   * Walk a combo's chain until one candidate produces output.
   *
   * The commit rule is the whole design. Chunks are held in a buffer until the
   * first answer-bearing delta, so a candidate that fails before that point is
   * discarded whole: the caller never saw a byte of it, and switching models is
   * invisible. Reasoning deltas are deliberately *not* a commit — "thought for a
   * minute, then hit a quota wall" is the single most valuable case to fail over,
   * and the held thinking is dropped along with the rest of the discarded try.
   *
   * Once an answer delta has been handed over the answer is the caller's, and a
   * later failure ends the turn the normal way — the single-model recovery path
   * inside `runSingle` still gets its continuation attempt first.
   */
  async * runCombo(options, entry, snapshot) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const rejectedTurn = attempts => {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts, origin: 'harness' })
    }
    if (settings.enabled === false) {
      rejectedTurn(0)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model is switched off in its settings page', code: 'CONFIG_DISABLED' } } }
      return
    }
    const candidates = comboChain(entry, snapshot.catalog)
    if (candidates.length === 0) {
      rejectedTurn(0)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `the chain "${entry.name}" has no model available on this egress`, code: CODE.server } } }
      return
    }
    const tried = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const iterator = this.runSingle(options, candidate, snapshot, {
        wire: wireOf(candidate),
        turnModel: entry.id,
        recordTurn: false,
        allowAdvance: true,
      })
      let committed = false
      let result
      const held = []
      while (true) {
        const row = await iterator.next()
        if (row.done === true) { result = row.value; break }
        if (committed) { yield row.value; continue }
        held.push(row.value)
        if (commitsAnswer(row.value)) {
          committed = true
          for (const chunk of held) yield chunk
          held.length = 0
        }
      }
      if (committed) {
        this.deps.recordTurn?.({ at: started, model: entry.id, ok: result?.ok === true, recovered: result?.recovered === true, attempts: index + 1, origin: 'harness' })
        return
      }
      if (result?.advance !== true) {
        // Not a candidate fault — an abort, or a failure that arrived after the
        // single-model recovery budget was spent. Hand the caller the real
        // ending instead of pretending another model could have saved it.
        for (const chunk of held) yield chunk
        rejectedTurn(index + 1)
        return
      }
      const reason = result.verdict === null || result.verdict === undefined ? 'failed' : describeVerdict(result.verdict)
      tried.push(`${candidate.id} (${reason})`)
      this.deps.warn?.(`our-free-model: chain "${entry.name}" advanced past ${candidate.id} — ${reason}`)
    }
    rejectedTurn(candidates.length)
    yield { type: 'finish', reason: { kind: 'error', failure: {
      message: `the chain "${entry.name}" exhausted every candidate: ${tried.join('; ')}`,
      code: CODE.server,
    } } }
  }

  /**
   * One model's turn — the original single-lane path.
   *
   * @param {object} [plan] - `{ wire?, turnModel?, recordTurn?, allowAdvance? }`.
   *   `turnModel` re-attributes the logical turn, so a combo's link is recorded
   *   physically under its own id while the turn belongs to the chain;
   *   `recordTurn: false` leaves the turn record to the caller; `allowAdvance`
   *   makes a pre-output failure report itself as advanceable instead of ending
   *   the turn outright.
   * @returns the turn's own summary, which only a combo caller reads.
   */
  /**
   * 免费车道的本地 opencode 代发（2026-10-14）。
   *
   * 为什么不直连 zen：OpenCode v2 网关只认它服务端注册过的真实会话，伪造身份
   * （UA 任意版本 / 四个 session 头 / 真 projectID）一律 403。这里把整轮对话渲染成
   * 一段 prompt，交给本机 opencode 后台服务的「会话内 generate」代发——它是真客户端，
   * 身份天然合法。代价：这条通道是**一次性纯文本**（无工具、无图片、无原生流式），
   * 我们把文本切片 yield，界面上看起来仍是逐段吐字。
   */
  async * runBridge(options, entry, started) {
    /* 2026-10-15：服务改成「按需启动」——平时不跑，省下 145~250 MB。
       service.json 不在是正常状态（服务停掉时它会被删），只要本机装了
       opencode 客户端就继续走 bridgeStream，由它把服务拉起来。 */
    if (readService() === null && !hasOpencodeCli()) {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 0, origin: 'harness' })
      yield { type: 'finish', reason: { kind: 'error', failure: { message: BRIDGE_HINT, code: 'BRIDGE_UNAVAILABLE' } } }
      return
    }
    const prompt = renderBridgePrompt(options.messages, entry, options.tools)
    /* 2026-10-22：与 bridgeStream 的 900s guard 同步放宽（见 opencode-bridge.js 注释）。
       实测重任务轮次 1300~3500 秒，300s 会在上游仍在正常生成时把整轮掐死。 */
    const signal = options.signal === undefined
      ? AbortSignal.timeout(900000)
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, AbortSignal.timeout(900000)]) : options.signal)

    /* 事件 → 队列 → generator：上游是一次性整段返回，所以先攒整段、
       解析出工具调用后再按块吐（2026-10-15 工具协议改造）。 */
    const queue = []
    let wake = null
    let failure = null
    let ended = false
    const nudge = () => { if (wake !== null) { const fn = wake; wake = null; fn() } }
    const push = (item) => { queue.push(item); nudge() }
    const segments = []
    const run = bridgeStream({
      modelId: entry.id,
      prompt,
      signal,
      onDelta: (delta) => { if (typeof delta === 'string' && delta !== '') segments.push({ kind: 'text', text: delta }) },
      onReasoning: (delta) => { if (typeof delta === 'string' && delta !== '') segments.push({ kind: 'reasoning', text: delta }) },
    })
    run.then(() => { ended = true; push(null) }, (error) => { failure = error; ended = true; push(null) })

    let current = null
    let index = 0
    let sawText = false
    let sawToolCall = false
    let sawReasoning = false
    const closeCurrent = function* () {
      if (current !== null) {
        if (current.kind === 'text' && current.block.text !== '') {
          yield { type: 'block-end', index: current.index, block: current.block }
        } else if (current.kind === 'reasoning' && current.block.text !== '') {
          yield { type: 'block-end', index: current.index, block: current.block }
        } else if (current.kind === 'tool-call') {
          try { JSON.parse(current.block.arguments === '' ? '{}' : current.block.arguments) } catch { current.block.arguments = '{}' }
          yield { type: 'block-end', index: current.index, block: { type: 'tool-call', id: current.block.id, name: current.block.name, arguments: current.block.arguments } }
        }
      }
      current = null
    }

    /* 等整段拿完，解析成块序列再吐。上游无真流式，首字延迟本来就受制于整段返回。 */
    while (true) {
      if (queue.length === 0) {
        if (ended) break
        await new Promise((resolve) => { wake = resolve })
        continue
      }
      const item = queue.shift()
      if (item === null) break
    }
    const parsed = parseBridgeToolCalls(segments)
    for (const seg of parsed) {
      if (seg.kind === 'tool-call') {
        yield * closeCurrent()
        current = { kind: 'tool-call', index: index++, block: { type: 'tool-call', id: `call_${index}_${Math.random().toString(36).slice(2, 10)}`, name: seg.name, arguments: seg.arguments } }
        sawToolCall = true
        yield { type: 'block-start', index: current.index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: current.index, id: current.block.id, name: seg.name, argumentsDelta: seg.arguments }
        yield * closeCurrent()
        continue
      }
      if (seg.kind === 'reasoning') {
        if (current === null || current.kind !== 'reasoning') {
          yield * closeCurrent()
          current = { kind: 'reasoning', index: index++, block: { type: 'reasoning', text: '' } }
          sawReasoning = true
          yield { type: 'block-start', index: current.index, blockType: 'reasoning' }
        }
        current.block.text += seg.text
        yield { type: 'reasoning-delta', index: current.index, text: seg.text }
        continue
      }
      /* text：先在标记处切开过的纯文本 */
      if (current === null || current.kind !== 'text') {
        yield * closeCurrent()
        current = { kind: 'text', index: index++, block: { type: 'text', text: '' } }
        yield { type: 'block-start', index: current.index, blockType: 'text' }
      }
      current.block.text += seg.text
      if (seg.text.trim() !== '') sawText = true
      yield { type: 'text-delta', index: current.index, text: seg.text }
    }
    yield * closeCurrent()
    try { await run; failure = null } catch (error) { failure = error }

    if (failure !== null && !sawText && !sawToolCall) {
      /* 2026-10-18：这条失败路径此前不留任何痕迹，线上只能看到一句 fetch failed，
         排查时无法区分「服务没起来」「起来了但立刻死」「端口探测误判」。把决策依据
         一次性记全：耗时、当前 service.json、CLI 是否在、信号是否已中止。 */
      const service = readService()
      this.deps.warn?.(
        `our-free-model: bridge 失败 model=${entry.id} elapsedMs=${Date.now() - started}`
        + ` service=${service === null ? 'none' : service.url}`
        + ` cli=${hasOpencodeCli()} aborted=${options.signal?.aborted === true}`
        + ` reason=${String(failure?.message ?? failure)}`,
      )
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 1, origin: 'harness' })
      yield {
        type: 'finish',
        reason: {
          kind: options.signal?.aborted === true ? 'aborted' : 'error',
          failure: { message: `our free model（本地 opencode 代发）失败：${String(failure?.message ?? failure)}`, code: 'BRIDGE_FAILED' },
        },
      }
      return
    }
    this.deps.recordTurn?.({ at: started, model: entry.id, ok: failure === null, recovered: false, attempts: 1, origin: 'harness' })
    if (failure !== null) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `本地 opencode 代发中途失败：${String(failure?.message ?? failure)}`, code: 'STREAM_CUT' } } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async * runSingle(options, entry, snapshot, plan = {}) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const turnModel = plan.turnModel ?? baseModelId(options.model)
    const recordRejectedTurn = () => {
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok: false,
        recovered: false,
        attempts: 0,
        origin: 'harness',
      })
    }

    if (settings.enabled === false) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model is switched off in its settings page', code: 'CONFIG_DISABLED' } } }
      return { advance: false, verdict: null, ok: false }
    }
    if (entry === null) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `our free model does not serve "${options.model}" on this egress`, code: CODE.server } } }
      return { advance: false, verdict: null, ok: false }
    }

    const sealed = isEacEntry(entry)
    const kilo = isKiloEntry(entry)
    const aggregate = isAggregateEntry(entry)
    /* 2026-10-14 免费车道改造：OpenCode v2 网关要求 session 为其服务端注册的真实会话，
       伪造身份一律 403（实测 UA/四个 session 头/project 全试过）。这一条纯免费车道
       （既不是 EAC/kilo 吸收渠道，也不是聚合行）改走本地 opencode 服务代发；
       kilo/aggregate/EAC 走原路不动。settings.bridgeLocalOpencode === false 可关。 */
    if (!sealed && !kilo && !aggregate && settings.bridgeLocalOpencode !== false) {
      yield * this.runBridge(options, entry, started)
      return { advance: false, verdict: null, ok: true }
    }
    // The absorbed channels speak the Chat wire regardless of what their ids
    // resemble; only the free lane splits endpoints per model, and an aggregate
    // row carries the wire its provider actually serves.
    const wire = plan.wire ?? wireOf(entry)
    const style = STYLE_FOR_WIRE[wire]
    const warnings = []
    const resolveImage = this.deps.resolveImage
    const messages = repairToolPairing(options.messages ?? [])
    const budget = budgetFor(options.reasoningEffort, entry, options.maxTokens, settings.defaultMaxTokens)
    const declared = toToolDefs(options.tools, style)
    const policy = recoveryPolicy(settings.streamRecovery)
    const session = sessionForConversation(options.sessionId)
    const recoveryId = mintRequestId()
    let attemptMessages = messages
    let attemptBudget = budget
    let nextIndex = 0
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const blocks = createBlockTracker()
    let turnRecorded = false
    const finishTurn = (ok, recovered = false, attempts = 1) => {
      if (turnRecorded) return
      turnRecorded = true
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok,
        recovered,
        attempts,
        origin: 'harness',
      })
    }

    // One pipeline report per dispatch build, so the usage record can carry what
    // the token savers measured for the body that actually shipped.
    let attemptSavings = null

    // 一次逻辑回合的丢弃内容告警只由首个 payload 收集。检查点估算和续写段都要另建
    // 一份 payload，共用同一个数组会让 `image-dropped` 按 build 次数重复累积，还会
    // 让已经交出去的首段样本跟着后面的 build 一起变长。
    const payloadFor = (input, ceiling, recovering, sink, savingsSink) => {
      const payload = buildPayload(wire, entry.id, input, options, ceiling, resolveImage, sink)
      if (declared.length > 0) payload.tools = declared
      if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) payload.temperature = options.temperature
      if (wire !== 'responses' && Array.isArray(options.stop) && options.stop.length > 0) payload.stop = options.stop
      if (recovering) payload.tool_choice = wire === 'messages' ? { type: 'none' } : 'none'
      // Both absorbed channels carry a declared thinking menu whose level is
      // the real control on the wire: the selected level rides the request as
      // the model's own effort field (a JSON merge patch, ZCode's declaration
      // shape). The free lane keeps its token-budget behaviour untouched.
      if (sealed || kilo) {
        const patch = effortPatchFor(options.reasoningEffort, entry)
        if (patch !== null) Object.assign(payload, patch)
      }
      if (sealed) applySealedPacingHint(payload)
      // The token savers run last, after every other mutation, so the byte counts
      // they report and the fingerprint's rename map both describe the body that
      // actually ships. Applied on estimation builds too — the checkpoint size
      // gate has to measure the payload it is gating, not a fatter draft of it.
      const savings = applyTokenSavers(payload, wire, saverConfig(settings))
      if (savingsSink !== undefined) savingsSink.report = savings
      return payload
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.signal?.aborted === true) {
        finishTurn(false, false, attempt)
        if (attempt > 0) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
        return { advance: false, verdict: null, ok: false }
      }
      const attemptStarted = Date.now()
      const recovering = attempt === 1
      const savingsSink = {}
      const payload = payloadFor(attemptMessages, attemptBudget, recovering, recovering ? [] : warnings, savingsSink)
      attemptSavings = savingsSink.report ?? null
      // The absorbed channels have no tool-name gate; their models see the
      // caller's tools exactly as declared, so the fingerprint pass is free-lane
      // only. The aggregate lane is somebody else's gateway entirely — renaming
      // its tools to this lane's decoy quartet would break the caller's calls.
      const renameMap = sealed || kilo || aggregate ? new Map() : applyFingerprint(payload, wire === 'messages' ? 'claude' : style === 'flat')
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const remainingMs = Math.max(1, policy.totalTimeoutMs - (attemptStarted - started))
      let expired = false
      const timeoutMs = recovering ? Math.min(policy.maxContinuationMs, remainingMs) : remainingMs
      const timer = policy.enabled ? setTimeout(() => {
        expired = true
        controller.abort()
      }, timeoutMs) : undefined
      timer?.unref?.()
      const channel = createChannel()
      const request = (sealed
        ? postSealedTurn(this.deps, payload, controller.signal, value => channel.push(value))
        : kilo
          ? postKiloStreamed({ body: payload, signal: controller.signal, onData: value => channel.push(value) })
          : aggregate
            ? postAggregateStreamed({
              config: settings.aggregate ?? {},
              providerId: entry.providerId,
              modelId: entry.modelId,
              body: payload,
              signal: controller.signal,
              onData: value => channel.push(value),
            })
            : postStreamed({
          path: endpointFor(entry.id), body: payload, session,
          requestId: attempt === 0 ? recoveryId : mintRequestId(),
          attributionUserAgent: snapshot.attributionUserAgent,
          signal: controller.signal,
          onData: value => channel.push(value),
        }))
        .then(() => channel.push(undefined))
        .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))
      let firstDeltaAt
      let delivered = false
      let sawAnswer = false
      let recorded = false
      let continuationScheduled = false
      let partialOutcome
      let usageAdded = false
      const record = (ok, outcome, extra = {}) => {
        if (recorded) return
        recorded = true
        const usage = outcome?.sawUsage === true ? outcome.usage : undefined
        this.deps.recordUsage({
          at: attemptStarted,
          model: entry.id,
          effort: resolveLevel(options.reasoningEffort, entry)?.id ?? '',
          ok,
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          reasoning: usage?.reasoningTokens ?? 0,
          cacheRead: usage?.cacheReadTokens ?? 0,
          decodeTokens: ok ? windowTokens(usage, outcome?.sawReasoning === true) : 0,
          ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - attemptStarted,
          decodeMs: firstDeltaAt === undefined ? 0 : Date.now() - firstDeltaAt,
          origin: 'harness',
          recoveryId,
          attempt,
          elapsedMs: Date.now() - attemptStarted,
          ...recovering ? { recoveryAttempt: true } : {},
          ...outcome?.sawUsage === true ? {} : { noUsage: true },
          ...warnings.length === 0 ? {} : { warnings },
          ...savingsFields(attemptSavings),
          ...extra,
        })
      }
      /**
       * Whether another model could answer this failure.
       *
       * Three things veto it, and each one is a different kind of "no": the
       * caller did not ask for a chain, the caller walked away, or this model
       * already put an *answer* on the wire — a switch after that point would
       * splice two models' prose together in front of the user.
       *
       * The veto reads `sawAnswer`, not `delivered`, on purpose. `delivered`
       * also covers reasoning deltas, but a combo holds those in its own
       * buffer and drops them whole when it advances — the user never saw
       * them, so they must not pin the chain to a model that hit a quota wall
       * after a minute of thinking ("thought for a minute, then hit the wall"
       * is the single most valuable case to fail over). Answer-bearing output
       * — visible text or a streamed tool call — is what `commitsAnswer`
       * commits on, and once committed the combo ignores `advance` anyway, so
       * this predicate and the commit rule stay two views of one definition.
       */
      const advanceVerdict = (code, message, status) => {
        if (plan.allowAdvance !== true || options.signal?.aborted === true || sawAnswer) return { advance: false, verdict: null }
        const verdict = classifyFailure({ status, code, message })
        return { advance: shouldAdvance(verdict), verdict }
      }
      try {
        const reader = readStream(channel.read(), wire, renameMap, () => Date.now(), {
          startIndex: nextIndex, checkpointLimit: policy.checkpointLimit,
          onState: value => { partialOutcome = value },
        })
        let outcome
        try {
          while (true) {
            const row = await reader.next()
            if (row.done) { outcome = row.value; break }
            if (options.signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
            const chunk = row.value
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') sawAnswer = true
            // 续写禁用工具；网关不遵守时也不把工具块交给宿主执行。
            if (recovering && (chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')) {
              throw new UpstreamError('our free model continuation unexpectedly requested a tool', 'STREAM_CUT')
            }
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              delivered = true
              if (firstDeltaAt === undefined) firstDeltaAt = Date.now()
            }
            blocks.accept(chunk)
            yield chunk
          }
        } finally {
          await reader.return()
        }
        nextIndex = outcome.nextIndex
        totalUsage = addUsage(totalUsage, outcome.usage, outcome.sawUsage)
        usageAdded = true
        if (options.signal?.aborted === true) {
          record(false, outcome, { aborted: true })
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
          return { advance: false, verdict: null, ok: false }
        }
        const reason = outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish)
        // finishReason 是兜底映射，failed/cancelled 也会落成 stop：正常收尾的判定必须显式查原 token。
        const elapsed = Date.now() - started
        const interrupted = canRecover(outcome, policy, elapsed)
        // 正文撞输出上限被截断（finish=length）：把已出正文回灌成 assistant 轮、
        // 用剩余预算自动续写一次，替代宿主提示的「发送继续」手动接力（#28）。
        // 只在首段触发（recovering 段自己也撞墙就如实报 max-tokens，不无限续），
        // 且不与断流/空停续写共用 attempt 名额以外的路径。
        const maxTokensCut = policy.enabled && !recovering && reason.kind === 'max-tokens' && outcome.brokenToolCall !== true
          && outcome.sawText === true && outcome.sawToolCall !== true
          && typeof outcome.answerText === 'string' && outcome.answerText.trim() !== ''
        const silentStop = !interrupted && !maxTokensCut && reason.kind === 'stop'
          // 无 token 的正常收尾（message_stop / response.done 不带 status）也算停收；failed、length 这类有 token 的收尾仍被挡在外面。
          && (outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish))
          && canRecoverSilentStop(outcome, policy, elapsed)
        if (!recovering && (interrupted || silentStop || maxTokensCut)) {
          const remainingTokens = budget - (outcome.sawUsage ? outcome.usage.outputTokens ?? 0 : 0)
          const continuationBudget = Math.min(remainingTokens, policy.maxOutputTokens)
          const nextMessages = maxTokensCut
            ? continuationMessages(messages, outcome.answerText)
            : recoveryMessages(messages, outcome.reasoningText)
          if (continuationBudget >= MIN_BUDGET
            && checkpointFits(payloadFor(nextMessages, continuationBudget, true, []), entry, maxTokensCut ? outcome.answerText : outcome.reasoningText, continuationBudget)) {
            record(false, outcome, { truncated: true, recoveryScheduled: true })
            this.deps.warn?.(maxTokensCut
              ? 'our-free-model: the answer hit the output token ceiling; continuing once from where it stopped'
              : silentStop
                ? 'our-free-model: a stopped turn held only its reasoning; continuing once from its checkpoint'
                : 'our-free-model: interrupted reasoning; continuing once from its checkpoint')
            attemptMessages = nextMessages
            attemptBudget = continuationBudget
            continuationScheduled = true
            continue
          }
        }
        const failedEnding = outcome.finish === 'failed' || outcome.finish === 'cancelled'
        const normalEnding = outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish)
        if (outcome.sawFinish !== true || failedEnding || (recovering && (!sawAnswer
          || outcome.sawToolCall === true || reason.kind !== 'stop' || !normalEnding))) {
          const seconds = Math.round((Date.now() - started) / 1000)
          const code = recovering || delivered || outcome.sawToolCall === true ? 'STREAM_CUT'
            : failedEnding ? CODE.server : CODE.transport
          const message = recovering
            ? `our free model continuation ended without a complete answer after ${seconds}s; automatic recovery exhausted`
            : failedEnding ? `our free model upstream response ended with status ${outcome.finish}`
            : delivered || outcome.sawToolCall === true
              ? `our free model closed the stream after ${seconds}s, before its finish token; automatic recovery was not safe`
              : 'our free model closed the stream before its finish token, without answering; retrying'
          record(false, outcome, { truncated: true })
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
          return { ok: false, ...advanceVerdict(code, message, undefined) }
        }
        if (outcome.sawText !== true && outcome.sawToolCall !== true && outcome.sawReasoning !== true && reason.kind === 'stop') {
          record(false, outcome)
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model returned an empty response', code: CODE.empty } } }
          return { ok: false, ...advanceVerdict(CODE.empty, 'empty response') }
        }
        record(true, outcome, recovering ? { recovered: reason.kind === 'stop' } : {})
        finishTurn(true, recovering && reason.kind === 'stop', attempt + 1)
        yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason }
        if (warnings.length > 0) this.deps.warn?.(`our-free-model: dropped unsupported content for ${entry.id}: ${warnings.join(', ')}`)
        return { advance: false, verdict: null, ok: true, recovered: recovering && reason.kind === 'stop' }
      } catch (error) {
        if (error?.code === CODE.region) this.deps.onRegionBlocked?.(entry.id)
        const aborted = options.signal?.aborted === true
        let failure = toFailure(error)
        if (!aborted && (recovering || expired)) {
          failure = { ...failure, code: recovering || delivered || partialOutcome?.sawToolCall === true ? 'STREAM_CUT' : CODE.timeout,
            message: expired
              ? `our free model reached its ${Math.round(timeoutMs / 1000)}s time limit before its finish token${recovering ? ', during the continuation from its checkpoint' : ''}`
              : `our free model continuation failed: ${failure.message}` }
        }
        if (!usageAdded) totalUsage = addUsage(totalUsage, partialOutcome?.usage, partialOutcome?.sawUsage)
        record(false, partialOutcome, { ...(recovering || expired) ? { truncated: true } : {}, ...aborted ? { aborted: true } : {} })
        finishTurn(false, false, attempt + 1)
        for (const chunk of blocks.close()) yield chunk
        if (recovering || partialOutcome?.sawUsage === true) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } }
        return {
          ok: false,
          ...aborted
            ? { advance: false, verdict: null }
            : advanceVerdict(failure.code, failure.message, failure.status),
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        controller.abort()
        await request
        if (!recorded) record(false, partialOutcome, { aborted: true })
        if (!continuationScheduled && !turnRecorded) finishTurn(false, false, attempt + 1)
      }
    }
  }
}

/** The co-paid reasoning models can burn minutes in the thinking channel on
 * turns that need seconds (observed: an entire small token budget spent on
 * reasoning for a one-line answer, first visible byte minutes late). The
 * effort menu owns the hard depth; this one-line prompt asks for pacing so a
 * turn does not sit silent while the model over-explores. Applied on every
 * sealed build, so the continuation and recovery payloads carry it too. */
const SEALED_PACING_HINT =
  'Avoid overthinking: keep your reasoning brief and proportionate to the task.'

function applySealedPacingHint(payload) {
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find(message => message?.role === 'system' && typeof message.content === 'string')
    if (system !== undefined) {
      system.content = system.content === '' ? SEALED_PACING_HINT : `${system.content}\n\n${SEALED_PACING_HINT}`
      return
    }
    payload.messages.unshift({ role: 'system', content: SEALED_PACING_HINT })
    return
  }
  if (typeof payload.system === 'string') {
    payload.system = payload.system === '' ? SEALED_PACING_HINT : `${payload.system}\n\n${SEALED_PACING_HINT}`
  }
}

/**
 * One co-paid-lane turn: unlock the sealed credential for this request frame
 * and hand it straight to the lane's poster. A host the gate refuses — or a
 * seal that does not open — is a non-retryable configuration state, not a
 * transport fault: `LANE_LOCKED` is deliberately outside the retryable set so
 * a locked host fails its turn once, with a plain message and no retry storm.
 */
async function postSealedTurn(deps, payload, signal, onData) {
  const credential = await Promise.resolve(deps.sealedCredential?.())
  if (credential === null || credential === undefined) throw new UpstreamError('this model lane is not available on this host', 'LANE_LOCKED')
  return postSealedStreamed({ credential, body: payload, signal, onData })
}

function buildPayload(wire, modelId, messages, options, budget, resolveImage, warnings) {
  if (wire === 'responses') {
    const input = toResponseInput(messages, resolveImage, warnings)
    return {
      model: modelId,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      stream: true,
      store: false,
      max_output_tokens: budget,
    }
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage, warnings)
    return {
      model: modelId,
      messages: shaped.messages,
      stream: true,
      max_tokens: budget,
      ...shaped.system === undefined ? {} : { system: shaped.system },
    }
  }
  const chat = toChatMessages(messages, resolveImage, warnings)
  return {
    model: modelId,
    messages: typeof options.system === 'string' && options.system !== ''
      ? [{ role: 'system', content: options.system }, ...chat]
      : chat,
    stream: true,
    max_tokens: budget,
  }
}

/**
 * Shape one thrown error into the harness's `LlmFailure` vocabulary.
 *
 * The harness writes this object straight into a durable session event, and that
 * log rejects anything that does not survive a lossless JSON round trip — an
 * Error instance, a `NaN`, an explicit `undefined` field. A rejected append
 * aborts the whole turn, so a malformed failure is strictly worse than a sparse
 * one: only the whitelisted fields are carried, each validated, and each dropped
 * rather than emitted in a degraded form.
 */
function toFailure(error) {
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error ?? 'our free model request failed')
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : CODE.transport
  const status = error?.status
  const retryAfter = error?.providerRetryAfterMs
  return {
    message,
    code,
    ...Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {},
    ...Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: Math.trunc(retryAfter) } : {},
  }
}

/**
 * Which wire serves one catalog row.
 *
 * The absorbed channels speak the Chat wire regardless of what their ids
 * resemble; an aggregate row carries the wire its provider actually serves; the
 * free lane splits its endpoints per model id.
 */
function wireOf(entry) {
  if (isAggregateEntry(entry)) return entry.wire ?? 'chat'
  if (isEacEntry(entry) || isKiloEntry(entry)) return 'chat'
  return wireFor(entry.id)
}

/**
 * Does this chunk carry an answer the caller would have to un-see?
 *
 * A combo may only abandon a candidate while the answer is still entirely
 * inside its own buffer. Reasoning deltas are excluded on purpose: thinking is
 * not the answer, and "thought for a minute, then hit a quota wall" is the
 * most valuable failure to fail over — the held thinking is dropped with the
 * rest of the discarded attempt, so the caller never learns it happened. A
 * `block-end` for a reasoning block is the tail of that same reasoning stream
 * (`closeAll` emits it when the SSE loop ends), so it does not commit either;
 * letting it commit would pin the chain one chunk before the failure it
 * exists to survive. Text commits only when it carries visible content, the
 * same bar `sawAnswer` uses, so whitespace noise cannot pin a chain either.
 */
function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** What the token savers measured for one dispatched body, as usage-record fields. */
function savingsFields(report) {
  if (report === null || report === undefined) return {}
  const saved = Number(report.saved) || 0
  const promptInjected = report.prompt?.injected === true
  if (saved === 0 && promptInjected !== true) return {}
  return {
    savings: {
      saved,
      bytesBefore: Number(report.bytesBefore) || 0,
      // Carried alongside the other two, not derived from them later: the panel
      // shows "before → after", and an after of 0 beside a before of 2599 reads
      // as "the body became empty" rather than "this field was never recorded".
      bytesAfter: Number(report.bytesAfter) || 0,
      blocks: Array.isArray(report.rtk?.hits) ? report.rtk.hits.length : 0,
      ...promptInjected ? { prompt: report.prompt.families ?? [] } : {},
    },
  }
}

/**
 * The `/model` popup's detail line. The composer renders only the model name, so
 * the capacities that matter for choosing a model — modality, window, whether an
 * effort menu exists — have to fit here.
 *
 * A model that cannot switch its thinking off names the shared ceiling outright:
 * on that lane the rung is not only the answer's budget, and a picker that
 * implied otherwise is how "why is it cut off at 8K when my ceiling is 32K" gets
 * asked.
 */
function describe(entry, settings) {
  const parts = [entry.vision ? 'vision + text input' : 'text input', `${Math.round(entry.contextWindow / 1024)}K context`]
  // A chain's own detail line: which models it will try, in order. Without it a
  // combo in the picker looks like one more model with no endpoint behind it.
  if (isComboEntry(entry)) {
    parts.push(`${entry.combo.length}-model chain: ${entry.combo.join(' -> ')}`)
    if (entry.strategy === 'round-robin') parts.push('rotating start')
    return parts.join(' · ')
  }
  if (entry.reasoning === true) {
    // A declared menu is the model's own level list on the wire — naming the
    // levels is the honest detail line; "budget" would describe the free lane's
    // ladder, which is exactly what a menu model does not use.
    if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      parts.push(`thinking levels: ${entry.efforts.join(' / ')}`)
    } else {
      const rung = Math.round(budgetFor(DEFAULT_LEVEL, entry, undefined, settings?.defaultMaxTokens) / 1024)
      parts.push(entry.canDisableThinking === false
        ? `thinking always on · ${rung}K default ceiling, shared with the answer`
        : 'tunable thinking budget')
    }
  }
  return parts.join(' · ')
}

/* ── 本地 opencode 代发：对话渲染 + 切片（2026-10-14）──────────────────────── */

/* ── 桥接工具协议（2026-10-15）：把文本流里的 [调用工具 名字：{json}] 解析成真事件 ── */

/** 桥接车道可用的工具说明（进 prompt 的说明书）。 */
function renderToolCatalog(tools) {
  const list = Array.isArray(tools) ? tools.filter((t) => t && typeof t.name === 'string' && t.name !== '') : []
  if (list.length === 0) return ''
  const lines = list.map((tool) => {
    const params = tool.parameters ?? tool.input_schema ?? tool.inputSchema
    let schema = ''
    try { schema = params === undefined || params === null ? '' : JSON.stringify(params) } catch { schema = '' }
    const desc = typeof tool.description === 'string' ? tool.description.slice(0, 300) : ''
    return `- ${tool.name}${desc === '' ? '' : `：${desc}`}${schema === '' ? '' : `（参数 schema：${schema.slice(0, 600)}）`}`
  })
  return lines.join('\n')
}

/**
 * 给桥接 prompt 补工具协议段：有工具时教模型怎么"调用"，
 * 没工具时保留旧约束（别凭空编工具）。
 */
function bridgeToolPreamble(tools) {
  const catalog = renderToolCatalog(tools)
  if (catalog === '') {
    return '（以上是一整轮的完整对话。请以 Assistant 身份直接回复最后一条 User 消息。本次对话没有提供任何工具，不要编造工具调用，不要复述本段说明。）'
  }
  return `（以上是一整轮的完整对话。请以 Assistant 身份直接回复最后一条 User 消息。

重要：下面的工具属于**对话宿主**，不在你的内置工具列表里，也不要用你的任何内置工具去完成它们——你的内置工具对这个对话环境一无所知。宿主工具只能通过文本协议调用，由宿主执行后把结果发回来。

宿主提供的工具：
${catalog}

需要调用宿主工具时，输出一行且仅一行，格式严格为：
[调用工具 工具名：{"参数名":"值"}]
其中 JSON 是该工具的调用参数。输出这行之后立即停止，等待工具结果。不要在同一个回复里既调用工具又给出最终回答；不要调用一次后继续编造工具的返回结果；不要因为"内置工具列表里没有它"而拒绝——宿主工具本来就不在内置列表里。一次只调用一个工具。不要复述本段说明。）`
}

/**
 * 桥接文本流增量解析器。
 * 在 (text|reasoning) 混合流里认 `[调用工具 名字：{json}]`，
 * 命中后把标记前后的纯文本照常吐出，把标记本身转成 tool-call 块。
 * 设计约束：桥接上游是一次性整段返回，所以这里拿到的是"已知的全部文本"，
 * 解析按整段做、按块切，不需要真流式状态机。
 */
function parseBridgeToolCalls(segments) {
  /* segments: [{kind:'text'|'reasoning', text}] —— 顺序即上游输出顺序。
     2026-10-16 修复：上游 delta 可能把标记从中间切开（比如 '[调用工具' 和
     ' pwsh：{…}]' 各到一段），逐段解析会瞎。先按 kind 把相邻段粘成整段再解析。 */
  const merged = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    const text = typeof seg?.text === 'string' ? seg.text : ''
    if (text === '') continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.kind === seg.kind) last.text += text
    else merged.push({ kind: seg.kind, text })
  }
  const MARK = '[调用工具'
  const out = []
  for (const seg of merged) {
    if (seg.kind === 'reasoning') { out.push(seg); continue }
    let rest = seg.text ?? ''
    while (rest !== '') {
      const at = rest.indexOf(MARK)
      if (at === -1) { out.push({ kind: 'text', text: rest }); rest = ''; break }
      if (at > 0) out.push({ kind: 'text', text: rest.slice(0, at) })
      /* JSON 参数里可能含 "]"（比如命令串），所以不能见 ] 就收——
         从最近的 ] 逐个往后试，能把 body 解析成「名字 + 合法 JSON」的那个才算闭合。 */
      let closedAt = -1
      for (let pos = rest.indexOf(']', at); pos !== -1; pos = rest.indexOf(']', pos + 1)) {
        const candidate = rest.slice(at + MARK.length, pos).trim()
        const sepAt = candidate.indexOf('：')
        const name = sepAt === -1 ? candidate : candidate.slice(0, sepAt).trim()
        const argsRaw = sepAt === -1 ? '' : candidate.slice(sepAt + 1).trim()
        try { JSON.parse(argsRaw === '' ? '{}' : argsRaw) } catch { continue }
        closedAt = pos
        break
      }
      if (closedAt === -1) {
        /* 没有能闭合的位置：可能是截断。整段吐回文本，不再解析。 */
        out.push({ kind: 'text', text: rest.slice(at) })
        rest = ''
        break
      }
      const body = rest.slice(at + MARK.length, closedAt).trim()
      rest = rest.slice(closedAt + 1)
      const sep = body.indexOf('：')
      const name = sep === -1 ? body.trim() : body.slice(0, sep).trim()
      const argsRaw = sep === -1 ? '' : body.slice(sep + 1).trim()
      let args = '{}'
      try { args = JSON.stringify(JSON.parse(argsRaw === '' ? '{}' : argsRaw)) } catch { args = null }
      if (name === '' || args === null) {
        /* 名字为空或 JSON 解不开：当普通文本处理，不能给宿主一个坏调用 */
        out.push({ kind: 'text', text: `${MARK}${body}]` })
      } else {
        out.push({ kind: 'tool-call', name, arguments: args })
      }
    }
  }
  return out
}

/**
 * 把 DSH 的消息数组渲染成给本地 opencode 的一次性 prompt。
 * 图片/附件只留占位说明（代发通道是纯文本）；总量有上限，防止把本地服务压死。
 */
function renderBridgePrompt(messages, entry, tools) {
  const parts = []
  const LIMIT = 400000
  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role ?? 'user'
    const label = role === 'assistant' ? 'Assistant' : role === 'system' ? 'System' : role === 'tool' ? 'Tool' : 'User'
    const body = (Array.isArray(message?.content) ? message.content : []).map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (typeof block.text === 'string' && block.text !== '') return block.text
      if (block.type === 'tool-call') return `[调用工具 ${block.name ?? ''}：${String(block.arguments ?? '').slice(0, 400)}]`
      if (block.type === 'tool-result') return `[工具结果：${String(block.text ?? '').slice(0, 1500)}]`
      if (block.type === 'file' || block.type === 'image') return `[${block.type} 附件——本地 opencode 代发通道暂不支持]`
      return ''
    }).filter((line) => line !== '').join('\n')
    if (body === '') continue
    const line = `${label}: ${body}`
    total += line.length
    if (total > LIMIT) break
    parts.push(line)
  }
  parts.push(bridgeToolPreamble(tools))
  return parts.join('\n\n')
}

/** 把整段文本切成小片，模拟流式吐字。 */
function splitForStream(text, size = 220) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length > 0 ? out : ['']
}
