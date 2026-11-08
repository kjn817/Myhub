/**
 * 시크릿 패턴 마스킹
 * API키, 카드번호, 비밀번호 등을 AI 전송 전에 마스킹
 */

// 카드번호 (Luhn 체크 포함, 13-19자리)
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

// API 키 패턴들
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // AWS 키
  { name: 'AWS_KEY', re: /AKIA[0-9A-Z]{16}/g },
  // GitHub 토큰
  { name: 'GITHUB_TOKEN', re: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  // 일반적인 API 키 (sk-...)
  { name: 'API_KEY', re: /sk-[A-Za-z0-9]{20,}/g },
  // password=, passwd=, pwd= 뒤의 값
  { name: 'PASSWORD', re: /(password|passwd|pwd)\s*[:=]\s*([^\s&;"']+)/gi },
  // Bearer 토큰
  { name: 'BEARER', re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*$/gim },
];

/**
 * Luhn 알고리즘으로 카드번호 검증
 */
function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * 텍스트에서 시크릿을 마스킹
 * @returns 마스킹된 텍스트와 발견된 시크릿 개수
 */
export function maskSecrets(text: string): { masked: string; count: number } {
  let masked = text;
  let count = 0;

  // 카드번호 (Luhn 검증)
  masked = masked.replace(CARD_RE, (m) => {
    if (luhnCheck(m)) {
      count++;
      return '[CARD_MASKED]';
    }
    return m;
  });

  // 기타 패턴
  for (const { name, re } of PATTERNS) {
    masked = masked.replace(re, (m) => {
      count++;
      return `[${name}_MASKED]`;
    });
  }

  return { masked, count };
}
