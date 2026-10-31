/**
 * Availability probing.
 *
 * The gateway does not disclose which models this egress may use: the model
 * listing is a flat id list, and exclusion only appears when a request is
 * refused with a `RegionError`. Availability is therefore established by asking,
 * with the smallest request that can produce a verdict.
 *
 * Egress is watched alongside it because the answer is a property of the
 * network path, not of the account: turning a VPN on changes which models exist
 * for the user, and the picker has to follow without a restart. The cheapest
 * reliable signal is the public address the gateway itself sees.
 *
 * @module src/probe.js
 */

import { applyFingerprint, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { CODE, postStreamed } from './http.js'
import { egressFetch } from './egress.js'
/* 2026-10-14：免费车道改走本地 opencode 服务代发（OpenCode v2 门禁后唯一合法通道）。 */
import { bridgeGenerate, readService, ensureService, hasOpencodeCli, BRIDGE_IDLE_HINT } from './opencode-bridge.js'

/** Public-echo sources, tried in order; any one answering is enough. */
const ECHO_SOURCES = [
  { url: 'https://api.ipify.org?format=json', pick: payload => payload?.ip },
  { url: 'https://ipinfo.io/json', pick: payload => payload?.ip, extra: payload => payload?.country },
  { url: 'https://ipapi.co/json/', pick: payload => payload?.ip, extra: payload => payload?.country_code },
]

/** Verdicts the probe can return, and how each maps to picker membership. */
export const STATE = {
  available: 'available',
  regionBlocked: 'region-blocked',
  unavailable: 'unavailable',
  throttled: 'throttled',
  unknown: 'unknown',
}

const PING_PROMPT = 'ping'

/**
 * Ask the gateway for one model, once.
 *
 * @param {object} model - catalog entry
 * @param {object} options
 * @param {string} [options.attributionUserAgent]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state:string, detail?:string, latencyMs:number, ttftMs?:number}>}
 */
export async function probeModel(model, { attributionUserAgent, signal, timeoutMs = 45000 } = {}) {
  const started = Date.now()
  /* 2026-10-14：免费车道已被 OpenCode v2 门禁（伪造 session 一律 403），改走本地
     opencode 服务代发；探针必须走同一条道，否则界面上所有免费模型都会显示不可用。
     2026-10-15：服务改成按需启动，探针**只查不启**（autostart:false）——否则 15 分钟
     一轮的自动探测会把服务变回常驻，"平时不占内存"就白做了。服务没跑时报 unknown
     （模型仍留在列表里：computeMembership 只排除 unavailable），详情写明首次使用会
     自动拉起。 */
  /* 2026-10-28：活性判定改用 ensureService({autostart:false})——它内部会真连端口。
     此前裸调 readService()，服务已停但 ~/.config/opencode/service.json 那份陈旧
     备胎（只有 password、没有 url）仍让它返回 127.0.0.1:4096，于是探针跳过
     「服务未启动」这条干净分支，去连一个死端口，把 idle 说明换成了连接错误。 */
  const live = await ensureService({ autostart: false })
  if (live === null) {
    return {
      state: STATE.unknown,
      detail: hasOpencodeCli() ? BRIDGE_IDLE_HINT : '本机未安装 opencode 客户端；免费车道需要它代发',
      latencyMs: Date.now() - started,
    }
  }
  try {
    /* 2026-10-24 探针轻量化（用户点名「绕开不注入提示词」）：走 mute3——
       tools 全关 + skills 关，opencode 不再给探针会话注入 ~9600 字符的
       工具/skill 说明书（那是探针 token 开销的大头）。只发一个 'ping'。 */
    await bridgeGenerate({ modelId: model.id, prompt: 'ping', signal, autostart: false, agent: 'mute3' })
    return { state: STATE.available, latencyMs: Date.now() - started }
  } catch (error) {
    /* 2026-10-28（用户点名「测了失败还显示可用」）：失败必须分类，不能再一律
       记 unknown——unknown 不被 picker 过滤、徽章只是灰字，等于「看着可用」。
       bridge 抛的是普通 Error（状态码只写在文本里），stateOf 会从文本兜出来。 */
    const detail = String(error?.message ?? error).slice(0, 200)
    return {
      state: stateOf({ code: error?.code, status: error?.status, message: detail, unavailable: error?.unavailable }),
      detail,
      latencyMs: Date.now() - started,
    }
  }
  const session = sessionForConversation('probe:our-free-model')
  const wire = wireFor(model.id)
  const body = buildPing(model.id, wire)
  applyFingerprint(body, wire === 'responses')

  let firstDelta
  let streamError
  try {
    await postStreamed({
      path: endpointFor(model.id),
      body,
      session,
      requestId: mintRequestId(),
      attributionUserAgent,
      signal,
      timeoutMs,
      onData: payload => {
        // The lane answers some refusals inside a 200 stream — a `{"type":
        // "error"}` or `{"error": …}` frame arrives where the deltas were
        // expected (src/stream.js classifies the same frames for real turns).
        // Reading only "did a delta look like a delta" called such a stream
        // available, and a model that fails every honest turn sat in the picker
        // with a green badge.
        if (streamError === undefined && /"(?:type"\s*:\s*"error"|"error"\s*:)/.test(payload)) {
          try {
            const parsed = JSON.parse(payload)
            const failure = parsed?.error ?? (parsed?.type === 'error' ? parsed : undefined)
            if (failure !== undefined && failure !== null) {
              streamError = typeof failure.message === 'string' ? failure.message : 'upstream error'
              return
            }
          } catch { /* not JSON the lane emits; the delta regex below still runs */ }
        }
        if (firstDelta !== undefined) return
        if (/"(delta|content|text|output_item)"|response\.(output_item|output_text|function_call)/.test(payload)) firstDelta = Date.now()
      },
    })
    if (streamError !== undefined) {
      /* 2026-10-28：上游把拒绝放在 200 流里（EAC 对已下线模型就是先开流、再发
         一条不带 finish 标记的 `{"error":…}` 帧就断），这条分支此前也记 unknown，
         于是「模型已下线」永远不摘牌。 */
      return { state: stateOf({ message: streamError }), detail: streamError.slice(0, 200), latencyMs: Date.now() - started }
    }
    return { state: STATE.available, latencyMs: Date.now() - started, ttftMs: firstDelta === undefined ? undefined : firstDelta - started }
  } catch (error) {
    return {
      state: stateOf(error),
      detail: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(error),
      latencyMs: Date.now() - started,
    }
  }
}

function buildPing(modelId, wire) {
  if (wire === 'responses') {
    return {
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PING_PROMPT }] }],
      stream: true,
      store: false,
      max_output_tokens: 16,
    }
  }
  if (wire === 'messages') {
    return {
      model: modelId,
      messages: [{ role: 'user', content: PING_PROMPT }],
      stream: true,
      max_tokens: 16,
    }
  }
  return { model: modelId, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
}

/**
 * Map one probe failure onto a verdict.
 *
 * The line that matters is whether the gateway *named this model as something it
 * will not route*. Only those readings come from the answer itself: a refusal
 * whose message is about the model (`Model is unavailable`, `not supported`,
 * `no such model`), or a status whose whole meaning is the identifier in the body
 * we sent — 400 for a model it rejects, 404 for one it no longer has, 422 for a
 * route that refuses the pair. Those read as unavailable and the picker drops the
 * model.
 *
 * Everything else says nothing about the model and must not move it:
 * - 5xx, including 503, is the gateway's own trouble. It is the single most
 *   common thing an overloaded pooled account says, and this lane's own history
 *   has it returning 5xx for reasons that had nothing to do with the model
 *   (`src/effort.js` records an upstream 503 from an unknown request field).
 *   Its *words* must not be read as a verdict either: a reverse proxy answers a
 *   503 with the reason phrase "Service Unavailable", and matching that text
 *   took a working model out of the picker.
 * - 401/403/407 is the pooled credential, and 408/425/429 is capacity or
 *   transport — the next window can answer.
 * - no status at all (transport, abort, timeout, a stream that died before any
 *   header) means no answer was received.
 *
 * The asymmetry is deliberate: a stale entry in the picker costs the user one
 * failed turn they can retry, while a model that vanished on a hiccup costs the
 * `reprobe`-then-wait cycle the user has no visibility into.
 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])

/* 2026-10-28：stateOf 供离线套件直测（分类规则是纯函数，不碰网络）。 */
export const stateOfForTest = stateOf

function stateOf(error) {
  switch (error?.code) {
    case CODE.region: return STATE.regionBlocked
    case CODE.quota: return STATE.throttled
    case CODE.timeout: return STATE.throttled
    default: break
  }
  const message = String(error?.message ?? '')
  /* 2026-10-31：地区墙先行——bridge 抛的错没有 code，opencode 对地区外模型在
     503 体里说 "This model is not available in your country"，只有这里能认出。 */
  if (/not available in your country/i.test(message)) return STATE.regionBlocked
  /* 2026-10-28：上游点名「这个模型不给你」的措辞，明确到足以摘牌，且不受 5xx
     guard 约束——EAC 对退役模型报 "reached its end of life"（装在 HTTP 200 的
     SSE 流里），对坏路由报 "Function … Not found for account"（账户级配置缺失）；
     opencode 网关对不存在的模型报 "Model unavailable: <id>"，点名了 id，不是
     反向代理那句笼统的 "Service Unavailable"。 */
  if (/end of life|not found for account|model unavailable|no such model|unknown model|invalid model|not supported/i.test(message)) return STATE.unavailable
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500
  /* 2026-10-31：不再用 /unavailable/i 兜底——opencode 的 503 响应体带
     `_tag:"ServiceUnavailableError"`，那个词命中它，把额度类错误全污染成
     「点名摘牌」。点名的措辞上面那条强正则已全覆盖，这里只信显式标记。 */
  const named = error?.unavailable === true
  if (named) return STATE.unavailable
  if (Number.isInteger(error?.status) && ROUTING_REFUSAL_STATUS.has(error.status)) return STATE.unavailable
  /* 2026-10-28（用户点名「测了失败还显示可用」）：5xx / 超时 / 连接失败这类
     「这次没答上来」不再落 unknown——unknown 是灰字「未探测」，看着像可用。
     改 throttled：红色「暂不可用」徽章、模型仍留在列表，额度或负载恢复后
     下一轮探测自愈。bridge 抛的是普通 Error，503 只出现在文本里（HTTP 5xx）。 */
  if (gatewayTrouble || /timed? ?out|timeout|time limit|fetch failed|econn|socket|http 5\d\d|aborted/i.test(message)) return STATE.throttled
  return STATE.unknown
}

/**
 * Resolve the public address the gateway will see, plus its country when an echo
 * discloses one. Fail-open: an absent answer simply means "no egress signal".
 */
export async function detectEgress({ signal, timeoutMs = 8000 } = {}) {
  for (const source of ECHO_SOURCES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const relayAbort = () => controller.abort()
    signal?.addEventListener('abort', relayAbort, { once: true })
    try {
      const response = await egressFetch(source.url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } })
      if (!response.ok) continue
      const payload = await response.json()
      const ip = source.pick(payload)
      if (typeof ip !== 'string' || ip === '') continue
      const country = source.extra?.(payload)
      return { ip, ...country === undefined ? {} : { country: String(country) } }
    } catch {
      // try the next echo
    } finally {
      // The deadline has to outlive the response head: response.json() is where
      // a slow echo used to stall past the 8s budget and freeze the probe loop.
      // And the caller's signal only borrowed this listener for this attempt.
      clearTimeout(timer)
      signal?.removeEventListener('abort', relayAbort)
    }
  }
  return undefined
}

/**
 * Probe a whole catalog with a bounded fan-out.
 *
 * Concurrency stays low on purpose: this lane accounts quota per session and
 * answers 429 with growing retry-after, so a wide burst would throttle the very
 * user whose availability we are establishing. A round probes every model —
 * partial rounds leave verdicts stale and the picker half-explained — and the
 * periodic loop holds *whole rounds* off while a quota backoff window is open
 * (the caller's concern, see index.js) instead of truncating this one.
 */
export async function probeCatalog(models, options = {}, onResult = () => {}, concurrency = 2) {
  const results = {}
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, async () => {
    while (cursor < models.length) {
      const index = cursor++
      const model = models[index]
      const result = await probeModel(model, options)
      results[model.id] = result
      onResult(model.id, result)
    }
  })
  await Promise.all(workers)
  return results
}
