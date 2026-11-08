/**
 * 암호화 서비스 테스트
 * @jest-environment node
 */

const crypto = require('crypto').webcrypto;
global.crypto = crypto;

describe('crypto.ts', () => {
  let encryptContent, decryptContent, isEncrypted;
  const env = { MEMO_ENCRYPTION_KEY: 'test-encryption-key-12345' };
  
  beforeAll(() => {
    const { execSync } = require('child_process');
    execSync('npx esbuild src/services/crypto.ts --bundle --platform=node --format=cjs --outfile=/tmp/crypto-test.js',
      { cwd: '/home/hatch/workspace/myhub' });
    const mod = require('/tmp/crypto-test.js');
    encryptContent = mod.encryptContent;
    decryptContent = mod.decryptContent;
    isEncrypted = mod.isEncrypted;
  });
  
  test('encrypt/decrypt 왕복', async () => {
    const original = '민감한 메모 내용입니다';
    const encrypted = await encryptContent(env, original);
    expect(encrypted).not.toBe(original);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted(original)).toBe(false);
    const decrypted = await decryptContent(env, encrypted);
    expect(decrypted).toBe(original);
  });
  
  test('키 없으면 에러', async () => {
    await expect(encryptContent({}, 'test')).rejects.toThrow('MEMO_ENCRYPTION_KEY');
  });
  
  test('빈 문자열', async () => {
    const encrypted = await encryptContent(env, '');
    const decrypted = await decryptContent(env, encrypted);
    expect(decrypted).toBe('');
  });
});
