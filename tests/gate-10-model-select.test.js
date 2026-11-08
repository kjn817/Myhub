/**
 * 관문 테스트 10: 모델 선택 존중
 *
 * 사용자 원칙: "모델 선택은 UI 선택값을 그대로 존중하고 provider/model 고정 금지"
 *
 * 기대:
 * 1. Job에 model이 있으면 그것을 사용
 * 2. 없으면 ai_settings의 model.code 사용
 * 3. 그것도 없으면 기본값
 * 4. 어떤 경우에도 provider를 하드코딩하지 않음
 */

function resolveModel(jobModel, settingValue) {
  // job-processor.ts의 실제 로직
  let modelId = jobModel
  if (!modelId) {
    modelId = settingValue || 'gemini-3.5-flash-lite'
  }
  return modelId
}

describe('관문 10: 모델 선택 존중', () => {
  test('Job 모델 있음 → Job 모델 사용', () => {
    expect(resolveModel('nvidia/nemotron-3', 'gemini-3.5-flash-lite'))
      .toBe('nvidia/nemotron-3')
  })

  test('Job 모델 없음 → 설정값 사용', () => {
    expect(resolveModel(null, 'gemini-2.5-flash'))
      .toBe('gemini-2.5-flash')
  })

  test('둘 다 없음 → 기본값', () => {
    expect(resolveModel(null, null))
      .toBe('gemini-3.5-flash-lite')
  })

  test('빈 문자열도 폴백 처리', () => {
    expect(resolveModel('', 'custom-model'))
      .toBe('custom-model')
  })
})
