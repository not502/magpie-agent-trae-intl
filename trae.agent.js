// Magpie runs this descriptor in moejs: no Node APIs, no fetch, no timers, no
// dynamic import, no import.meta.url. Keep this file import-free; a test asserts
// its literals agree with src/constants.mjs (which the Bun side imports).
//
// Contract: docs/design/interfaces.md §11.
// Fixed decisions: id `trae-intl`, display name `Trae (International)`.

export const agent = {
  id: 'trae-intl',
  name: 'Trae (International)',
  icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMy42OTIiIGZpbGw9IiMxQTFCMUQiLz48cGF0aCBkPSJNMTMuMjM1IDUuODI5VjQuMzMySDIuNzU4djUuOTg3aDEuNDk2djEuNDk2aDguOTgxVjUuODI4Wm0tMS40OTcgNC40OUg0LjI1NFY1LjgzaDcuNDg0djQuNDlaIiBmaWxsPSIjMzJGMDhDIi8+PHBhdGggZD0iTTYuOTM3IDYuOTkzIDUuODggOC4wNTEgNi45MzcgOS4xMSA3Ljk5NSA4LjA1IDYuOTM3IDYuOTkzWk05LjkzMSA2Ljk5MiA4Ljg3MyA4LjA1IDkuOTMxIDkuMTEgMTAuOTkgOC4wNSA5LjkzIDYuOTkyWiIgZmlsbD0iIzMyRjA4QyIvPjwvc3ZnPg==',
  dir: '$APPDATA/Trae',
  config: '~/.config/magpie-trae-intl/connection.json',
  format: 'json',
  ua: [],
  library: {
    instructions: '~/.trae/user_rules/magpie.md',
    mcp: '$APPDATA/Trae/User/mcp.json',
    mcpFormat: 'claude',
    skills: '~/.trae/skills',
  },
  notice:
    'Magpie models sync automatically while Magpie runs; reload the Trae window (or restart Trae once after the first install) to see catalog changes. Run `magpie-trae-intl status` for diagnostics. ' +
    'Magpie 运行时会自动同步模型目录；目录变化后请重新加载 Trae 窗口（首次启用后重启一次）。运行 `magpie-trae-intl status` 可查看连接与同步状态。',
};

/**
 * Pure mapping: Magpie gateway + models -> connection.json.
 * Must stay synchronous and allocation-only (the host budget is well under 1 s).
 * Returning no `model`/`effort`
 * keeps model selection inside Trae (connect-only agent).
 * @param {{ gateway: { v1: string, key: string }, models?: Array<{id: string, name?: string, context?: number, output?: number, images?: boolean, efforts?: string[]}> }} input
 * @returns {{version: 2, baseURL: string, gatewayKey: string, models: Array<{id: string, name: string, context: number, output: number, images: boolean, efforts: string[]}>}}
 * @throws {Error} `trae_gateway_required` when `gateway.v1` or `gateway.key` is missing.
 */
export function connect({ gateway, models } = {}) {
  if (
    !gateway ||
    typeof gateway.v1 !== 'string' ||
    gateway.v1.length === 0 ||
    typeof gateway.key !== 'string' ||
    gateway.key.length === 0
  ) {
    const error = new Error('trae_gateway_required');
    error.code = 'trae_gateway_required';
    throw error;
  }
  const list = Array.isArray(models) ? models : [];
  return {
    version: 2,
    baseURL: gateway.v1,
    gatewayKey: gateway.key,
    models: list
      .filter(model => model && typeof model.id === 'string' && model.id.length > 0)
      .map(model => ({
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        context: typeof model.context === 'number' && Number.isFinite(model.context) ? model.context : 0,
        output: typeof model.output === 'number' && Number.isFinite(model.output) ? model.output : 0,
        images: Boolean(model.images),
        efforts: Array.isArray(model.efforts) ? model.efforts.filter(value => typeof value === 'string') : [],
      })),
  };
}
