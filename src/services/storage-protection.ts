import { decryptContent, encryptContent, isEncrypted } from './crypto'
import { getSetting } from './ai-model-selection'

export { isEncrypted }

export const STORAGE_PROTECTION_SETTING_KEY = 'storage.protection'
export const STORAGE_PROTECTION_ON_VALUE = 'encrypted'
export const DECRYPT_FAILED_PLACEHOLDER = '[암호화된 메시지를 복호화할 수 없습니다]'

export async function isStorageEncryptionEnabled(db: D1Database): Promise<boolean> {
  const v = await getSetting(db, STORAGE_PROTECTION_SETTING_KEY)
  return v === STORAGE_PROTECTION_ON_VALUE
}

export async function protectText(env: any, text: string): Promise<string> {
  if (!text || isEncrypted(text)) return text
  return encryptContent(env, text)
}

export async function revealText(env: any, stored: string): Promise<string> {
  if (!stored || !isEncrypted(stored)) return stored
  return decryptContent(env, stored)
}

export async function revealTextOrPlaceholder(env: any, stored: string): Promise<string> {
  try {
    return await revealText(env, stored)
  } catch {
    return DECRYPT_FAILED_PLACEHOLDER
  }
}
