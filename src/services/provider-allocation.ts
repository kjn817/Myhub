export const PROVIDER_DATA_USE = {
  groq: 'no-train',
  'workers-ai': 'no-train',
  gemini: 'may-use',
  nvidia: 'may-use',
} as const

export type ProviderDataUse = (typeof PROVIDER_DATA_USE)[keyof typeof PROVIDER_DATA_USE]

export function dataUseRank(provider: string): number {
  const u = (PROVIDER_DATA_USE as Record<string, string>)[provider]
  return u === 'no-train' ? 0 : u === 'may-use' ? 1 : 2
}
