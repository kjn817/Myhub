import { getSetting } from './ai-model-selection';
import {
  inspectEgress,
  inspectEgressKorean,
  type InspectEgressInput,
  type InspectEgressResult,
  type InspectEgressKoreanResult,
} from './privacy-gateway';

const PRIVACY_KOREAN_MODE_KEY = 'privacy.korean_mode';

type PrivacyKoreanMode = 'off' | 'shadow' | 'enforce';

async function getPrivacyKoreanMode(db: D1Database): Promise<PrivacyKoreanMode> {
  const v = await getSetting(db, PRIVACY_KOREAN_MODE_KEY);
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

export async function inspectAiChatEgress(
  db: D1Database,
  input: InspectEgressInput,
): Promise<InspectEgressResult | InspectEgressKoreanResult> {
  const koreanMode = await getPrivacyKoreanMode(db);
  if (koreanMode === 'off') {
    return inspectEgress(input);
  }
  const koreanEgress = await inspectEgressKorean({ ...input, mode: koreanMode });
  console.info('privacy_gateway_korean', {
    origin: input.origin,
    mode: koreanMode,
    decisions: koreanEgress.koreanDecisions.map((d) => `${d.type}:${d.action}:${d.scoreBand}`).join(','),
  });
  return koreanEgress;
}
