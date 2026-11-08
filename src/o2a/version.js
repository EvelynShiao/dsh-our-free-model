/**
 * opencode2api v1.4.6 移植版本常量
 * @module src/o2a/version.js
 */
export const O2A_VERSION = '1.4.7'
export const O2A_COMMIT = '58f56676ba1438adb30604b889bf36db2a1542a1'
export const O2A_REFERENCE = 'https://github.com/jasonxu114514/opencode2api'

/** v2 客户端版本（UA 唯一来源）。2026-11-08 轮换：2.1.1 → 2.2.6（@opencode/cli 当前真实最新版） */
export const V2_CLIENT_VERSION = '2.2.6'
export const CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`

/** v2 Chat 线无上限时的完成上限 */
export const V2_COMPLETION_LIMIT = 32000

/** 匿名免费道的固定凭据 */
export const ANONYMOUS_CREDENTIAL = 'public'