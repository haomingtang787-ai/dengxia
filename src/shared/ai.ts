export type AiConfigView = {
  configured: boolean
  baseUrl: string
  model: string
  visionModel: string
  hasKey: boolean
}

/** 默认用 DeepSeek；用户可以在「模型」里换成任何 OpenAI 兼容端点。 */
export const DEFAULT_AI = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
} as const

export type AiModelList = { models: string[] }

export type AiStatusResult = AiConfigView

export type AiTestResult = { reply: string }
