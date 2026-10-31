// 로컬 검증용 mock 프로바이더 — 라이브 호출을 하지 않는다.
//
// promptfooconfig.validate.yaml 전용. 각 테스트 케이스의 vars.mockOutput을
// 그대로 output으로 반환해, YAML 배선 + 어설션 동작을 라이브 없이 검증한다.
// 라이브 게이트(promptfooconfig.yaml)에는 쓰지 않는다.

'use strict';

class MockProvider {
  constructor(options) {
    this.options = options || {};
  }

  id() {
    return 'myhub-mock';
  }

  async callApi(prompt, context) {
    const vars = (context && context.vars) || {};
    if (typeof vars.mockOutput === 'string') {
      return { output: vars.mockOutput };
    }
    return { error: 'mock provider: vars.mockOutput is not set for this test case' };
  }
}

module.exports = MockProvider;
