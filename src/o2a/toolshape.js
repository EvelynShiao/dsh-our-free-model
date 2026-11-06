/**
 * opencode2api `internal/gateway/toolshape.go` 精简移植：
 * `renameAndCompleteTools` + `rewriteToolReferences`
 * 仅做：客户工具全改名 `clint_<sha12>` + 响应侧还原
 * 不注入 13 官方工具（第二批启用）
 * @module src/o2a/toolshape.js
 */
import { ToolRenameMap, CLIENT_TOOL_PREFIX, clientToolWireName } from './tool-renames.js'
import { renamableToolName } from './official-tools.js'

/**
 * 重塑工具列表：所有客户端工具改名为不透明 `clint_` 线名
 * @param {object} payload - 请求体，原地修改
 * @param {'chat'|'flat'|'claude'} shape - 线形状
 * @param {object} [options]
 * @param {Set<string>} [options.keep] - 已按官方定义声明的工具名集合（幂等：不再改名、不再注入）
 * @returns {{ renames: ToolRenameMap }} 重命名映射表
 */
export function renameAndCompleteTools(payload, shape, { keep } = {}) {
  if (shape !== 'chat' && shape !== 'flat' && shape !== 'claude') {
    return { renames: new ToolRenameMap() }
  }
  const renames = new ToolRenameMap()
  const used = new Set()
  const keepNames = keep instanceof Set ? keep : new Set()
  let items = Array.isArray(payload.tools) ? [...payload.tools] : []

  // Legacy functions → tools（兼容旧 OpenAI 格式）
  if ((shape === 'chat' || shape === 'flat') && Array.isArray(payload.functions)) {
    items = items.concat(convertLegacyFunctions(payload.functions, shape, renames, used))
    delete payload.functions
  }

  const shaped = []
  for (const item of items) {
    const name = renamableToolName(shape, item)
    if (name === null) { shaped.push(item); continue }
    // 已整形过的官方工具、已改名的线名直接保留
    if (keepNames.has(name) || name.startsWith(CLIENT_TOOL_PREFIX)) {
      shaped.push(item)
      continue
    }
    let wireName = renames.wireOf(name)
    if (wireName === undefined) {
      wireName = clientToolWireName(name, used)
      renames.add(name, wireName)
    }
    shaped.push(wireName !== name ? withToolName(shape, item, wireName) : item)
  }

  payload.tools = shaped
  rewriteToolReferences(payload, shape, renames)
  return { renames }
}

/** 浅拷贝替换工具名（不改原对象） */
function withToolName(shape, entry, name) {
  if (shape === 'chat') return { ...entry, function: { ...entry.function, name } }
  return { ...entry, name }
}

/** Legacy functions 转 wire 形状并改名 */
function convertLegacyFunctions(entries, shape, renames, used) {
  const converted = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (name === '') continue
    let wireName = renames.wireOf(name)
    if (wireName === undefined) {
      wireName = clientToolWireName(name, used)
      renames.add(name, wireName)
    }
    const description = typeof raw.description === 'string' ? raw.description : undefined
    const parameters = raw.parameters ?? { type: 'object', properties: {} }
    if (shape === 'chat') {
      const fn = { name: wireName, description, parameters }
      if (raw.strict !== undefined) fn.strict = raw.strict
      converted.push({ type: 'function', function: fn })
    } else {
      const tool = { type: 'function', name: wireName, description, parameters }
      if (raw.strict !== undefined) tool.strict = raw.strict
      converted.push(tool)
    }
  }
  return converted
}

/**
 * 重写所有出向引用：tool_choice、function_call、tool_calls、input
 * 浅拷贝：不改宿主共享的历史对象
 */
export function rewriteToolReferences(payload, shape, renames) {
  if (renames.size === 0) return
  const renamed = container => {
    if (!container || typeof container !== 'object') return null
    const name = container.name
    if (typeof name !== 'string') return null
    const wireName = renames.wireOf(name)
    return wireName !== undefined && wireName !== name ? wireName : null
  }

  if (shape === 'chat') {
    // tool_choice（含 function 子对象）
    const choice = objectOf(payload.tool_choice)
    if (choice) {
      if (choice.function && typeof choice.function === 'object') {
        const wire = renamed(choice.function)
        if (wire !== null) payload.tool_choice = { ...choice, function: { ...choice.function, name: wire } }
      } else {
        const wire = renamed(choice)
        if (wire !== null) payload.tool_choice = { ...choice, name: wire }
      }
    }
    // legacy function_call
    const call = objectOf(payload.function_call)
    if (call) {
      const wire = renamed(call)
      if (wire !== null) payload.function_call = { ...call, name: wire }
    }
    // messages[] 中的 function_call / tool_calls
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]
      if (!message || typeof message !== 'object') continue
      let next = null
      const fnCall = objectOf(message.function_call)
      if (fnCall) {
        const wire = renamed(fnCall)
        if (wire !== null) next = { ...message, function_call: { ...fnCall, name: wire } }
      }
      if (Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map(entry => {
          const fn = objectOf(entry?.function)
          if (!fn) return entry
          const wire = renamed(fn)
          return wire !== null ? { ...entry, function: { ...fn, name: wire } } : entry
        })
        if (calls.some((e, j) => e !== message.tool_calls[j])) {
          next = { ...(next ?? message), tool_calls: calls }
        }
      }
      if (next !== null) messages[i] = next
    }
    return
  }

  if (shape === 'flat') {
    // Responses tool_choice + allowed_tools
    const choice = objectOf(payload.tool_choice)
    if (choice) {
      let next = null
      const wire = renamed(choice)
      if (wire !== null) next = { ...choice, name: wire }
      if (Array.isArray(choice.allowed_tools)) {
        const allowed = choice.allowed_tools.map(entry => {
          if (!entry || typeof entry !== 'object') return entry
          const entryWire = renamed(entry)
          return entryWire !== null ? { ...entry, name: entryWire } : entry
        })
        if (allowed.some((e, j) => e !== choice.allowed_tools[j])) {
          next = { ...(next ?? choice), allowed_tools: allowed }
        }
      }
      if (next !== null) payload.tool_choice = next
    }
    // input[] 中的 function_call / custom_tool_call
    const input = Array.isArray(payload.input) ? payload.input : []
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i]
      const type = typeof item?.type === 'string' ? item.type : ''
      if (type !== 'function_call' && type !== 'custom_tool_call') continue
      const wire = renamed(item)
      if (wire !== null) input[i] = { ...item, name: wire }
    }
    return
  }

  // Anthropic Messages: tool_choice + content[] 中的 tool_use
  const choice = objectOf(payload.tool_choice)
  if (choice) {
    const wire = renamed(choice)
    if (wire !== null) payload.tool_choice = { ...choice, name: wire }
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const content = message.content.map(block => {
      if (block?.type !== 'tool_use') return block
      const wire = renamed(block)
      return wire !== null ? { ...block, name: wire } : block
    })
    if (content.some((b, j) => b !== message.content[j])) messages[i] = { ...message, content }
  }
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}