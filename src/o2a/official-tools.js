/**
 * 官方 13 工具集（逐字捕获自 opencode 2.1 CLI）
 * 第二批完整注入时启用；当前精简版仅作占位
 * @module src/o2a/official-tools.js
 */

// 官方工具定义文本（来自 assets/opencode_tools.json）
// 完整版见上游 assets/opencode_tools.json，此处留空占位
export const V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell',
  'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch'
])

let officialTools
function loadOfficialTools() {
  if (officialTools !== undefined) return officialTools
  officialTools = new Map()
  // 精简版：不内嵌完整 JSON，第二批时从 assets 读取
  return officialTools
}

export function officialToolDefinition(name) {
  return loadOfficialTools().get(name)
}

/** Windows 下 shell 描述改为 powershell */
export function v2ShellDescription(base, platform = process.platform) {
  if (platform !== 'win32') return base
  return base.replace('on Linux using bash', 'on Windows using powershell')
}

/** 渲染单个官方工具（三种线形状） */
export function officialTool(shape, name) {
  const definition = officialToolDefinition(name)
  let description = `Agent tool ${name}`
  let parameters = { type: 'object', properties: {} }
  if (definition) {
    description = definition.description
    if (definition.parameters != null) parameters = structuredClone(definition.parameters)
  }
  if (name === 'shell') description = v2ShellDescription(description)
  if (shape === 'claude') return { name, description, input_schema: parameters }
  if (shape === 'flat') return { type: 'function', name, description, parameters }
  return { type: 'function', function: { name, description, parameters, strict: false } }
}

/** 完整官方工具集（第二批启用） */
export function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => officialTool(shape, name))
}

/** 判断某定义条目是否为需保留的客户端工具名 */
export function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (shape === 'chat') {
    const name = entry.function?.name
    return typeof name === 'string' && name !== '' ? name : null
  }
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (shape === 'flat') {
    if (type !== '' && type !== 'function' && type !== 'custom') return null
  } else if (shape === 'claude') {
    if (type !== '' && type !== 'custom') return null
  }
  const name = entry.name
  return typeof name === 'string' && name !== '' ? name : null
}