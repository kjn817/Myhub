// AI 스튜디오 Clef 적용 (2026-10-15)
// 작업 분해, 복잡도 판단, 템플릿 매칭

import type { ClefInvoker } from './router';

export type BuildPlan = {
  steps: string[];
  complexity: 'simple' | 'medium' | 'complex';
  templateMatch: string | null;
  estimatedFiles: string[];
};

/**
 * 사용자 요청을 분석하여 빌드 계획 수립
 */
export async function planBuild(
  invoke: ClefInvoker,
  userRequest: string
): Promise<BuildPlan> {
  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: userRequest },
    questions: {
      complexity: {
        type: 'choice',
        instructions: '요청된 앱의 복잡도를 판단하라.',
        criteria: {
          simple: '단순한 단일 페이지 (계산기, 타이머)',
          medium: '중간 복잡도 (투두리스트, 메모장)',
          complex: '복잡한 앱 (게임, 대시보드, 다중 기능)',
        },
      } as any,
      template_match: {
        type: 'choice',
        instructions: '요청이 기존 템플릿과 일치하는지 판단하라.',
        criteria: {
          game: '게임 템플릿',
          calculator: '계산기 템플릿',
          todo: '투두리스트 템플릿',
          timer: '타이머 템플릿',
          memo: '메모장 템플릿',
          dashboard: '대시보드 템플릿',
          none: '템플릿 없음, 새로 생성',
        },
      } as any,
      file_structure: {
        type: 'choice',
        instructions: '필요한 파일 구조를 판단하라.',
        criteria: {
          single: '단일 HTML 파일로 충분',
          multi: '여러 파일 필요 (HTML+CSS+JS 분리)',
        },
      } as any,
    },
  } as any)) as any;

  const complexity = response?.answers?.complexity?.choice || 'medium';
  const templateMatch = response?.answers?.template_match?.choice;
  const fileStructure = response?.answers?.file_structure?.choice || 'single';

  // 복잡도에 따른 작업 단계 생성
  const steps = generateBuildSteps(complexity, templateMatch);

  return {
    steps,
    complexity: complexity as 'simple' | 'medium' | 'complex',
    templateMatch: templateMatch === 'none' ? null : templateMatch,
    estimatedFiles: fileStructure === 'multi' 
      ? ['index.html', 'style.css', 'app.js']
      : ['index.html'],
  };
}

function generateBuildSteps(complexity: string, templateMatch: string | undefined): string[] {
  if (templateMatch && templateMatch !== 'none') {
    return [
      '템플릿 로드 중',
      '사용자 요청에 맞게 커스터마이징',
      '최종 검증',
    ];
  }
  
  switch (complexity) {
    case 'simple':
      return [
        'HTML 구조 생성',
        '스타일 적용',
        '기능 구현',
      ];
    case 'complex':
      return [
        '요구사항 분석',
        'HTML 구조 설계',
        'CSS 스타일링',
        'JavaScript 로직 구현',
        '인터랙션 추가',
        '최종 테스트',
      ];
    default: // medium
      return [
        'HTML 구조 생성',
        'CSS 스타일링',
        'JavaScript 기능 구현',
        '최종 검증',
      ];
  }
}

/**
 * 생성된 코드의 품질을 Clef로 검증
 */
export async function validateGeneratedCode(
  invoke: ClefInvoker,
  userRequest: string,
  htmlContent: string
): Promise<{ valid: boolean; issues: string[] }> {
  const response = (await invoke({
    model: 'clef-flash',
    state: {
      current_message: userRequest,
      html_length: htmlContent.length,
      has_script: htmlContent.includes('<script'),
      has_style: htmlContent.includes('<style'),
    },
    questions: {
      completeness: {
        type: 'choice',
        instructions: '생성된 HTML이 요청을 충족하는지 판단하라.',
        criteria: {
          complete: '완전함, 요청 충족',
          incomplete: '불완전함, 누락 있음',
          broken: '깨짐, 실행 불가',
        },
      } as any,
    },
  } as any)) as any;

  const result = response?.answers?.completeness?.choice;
  return {
    valid: result === 'complete',
    issues: result === 'complete' ? [] : [result || 'unknown'],
  };
}
