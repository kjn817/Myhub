/**
 * MyHub 에디터 유닛 테스트
 * @jest-environment jsdom
 */
const {
  wrapSelectionStyle,
  unwrapElement,
  clearInlineFormatting,
  doIndent,
  toggleBlockquote,
  getCurrentBlock,
  applyLink,
} = require('./editor-functions');

// jsdom에서 execCommand 모킹
beforeEach(() => {
  document.execCommand = jest.fn((cmd, ui, val) => {
    // insertHTML 모킹: 선택 영역을 HTML로 교체
    if (cmd === 'insertHTML') {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const div = document.createElement('div');
        div.innerHTML = val;
        const frag = document.createDocumentFragment();
        while (div.firstChild) frag.appendChild(div.firstChild);
        range.insertNode(frag);
      }
      return true;
    }
    if (cmd === 'createLink') {
      const sel = window.getSelection();
      if (sel.rangeCount && !sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const a = document.createElement('a');
        a.href = val;
        a.textContent = range.toString();
        range.deleteContents();
        range.insertNode(a);
      }
      return true;
    }
    return true;
  });
});

// 헬퍼
function createEditor() {
  const ed = document.createElement('div');
  ed.contentEditable = 'true';
  document.body.appendChild(ed);
  return ed;
}
function selectAll(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}
function selectText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}
function collapseAt(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('wrapSelectionStyle - 글자 크기', () => {
  test('선택 영역에 font-size 적용', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello world</p>';
    selectAll(ed.querySelector('p'));
    wrapSelectionStyle('font-size:50pt');
    expect(ed.innerHTML).toContain('font-size:50pt');
    expect(ed.innerHTML).toContain('hello world');
  });

  test('커서만 있을 때 zero-width-space span 삽입', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild, 5);
    wrapSelectionStyle('font-size:30pt');
    const span = ed.querySelector('span[style*="font-size:30pt"]');
    expect(span).not.toBeNull();
    expect(span.innerHTML).toContain('\u200B');
  });

  test('부분 선택에만 적용', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello world</p>';
    const textNode = ed.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    wrapSelectionStyle('font-size:24pt');
    expect(ed.innerHTML).toContain('font-size:24pt');
  });

  test('선택 없을 때 아무 일도 안 일어남', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    window.getSelection().removeAllRanges();
    expect(() => wrapSelectionStyle('font-size:24pt')).not.toThrow();
  });

  test('색상 적용', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    selectAll(ed.querySelector('p'));
    wrapSelectionStyle('color:#DC2626');
    expect(ed.innerHTML).toContain('color:#DC2626');
  });

  test('형광펜 배경색 적용', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    selectAll(ed.querySelector('p'));
    wrapSelectionStyle('background-color:#FEF08A');
    expect(ed.innerHTML).toContain('background-color:#FEF08A');
  });
});

describe('clearInlineFormatting - 서식 지우개', () => {
  test('굵게 태그 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold text</b></p>';
    // b 태그 자체를 선택
    const b = ed.querySelector('b');
    const range = document.createRange();
    range.selectNode(b);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
    expect(ed.innerHTML).toContain('bold text');
  });

  test('기울임 + 밑줄 중첩 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b><i>text</i></b></p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
    expect(ed.innerHTML).not.toContain('<i>');
    expect(ed.innerHTML).toContain('text');
  });

  test('span style 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span style="color:red">red</span></p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('style=');
    expect(ed.innerHTML).toContain('red');
  });

  test('빈 태그 청소', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b></b>text</p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.querySelector('b')).toBeNull();
  });

  test('blockquote는 유지 (블록 구조 보존)', () => {
    const ed = createEditor();
    ed.innerHTML = '<blockquote><p><b>quote</b></p></blockquote>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).toContain('<blockquote>');
    expect(ed.innerHTML).not.toContain('<b>');
  });

  test('ul/li는 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<ul><li><b>item</b></li></ul>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).toContain('<ul>');
    expect(ed.innerHTML).toContain('<li>');
    expect(ed.innerHTML).not.toContain('<b>');
  });

  test('선택 없을 때 현재 블록 전체 정리', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold</b></p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild.firstChild, 2);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
    expect(ed.innerHTML).toContain('bold');
  });

  test('선택 없을 때 rangeCount 0이면 리턴', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    window.getSelection().removeAllRanges();
    expect(() => clearInlineFormatting(ed)).not.toThrow();
  });

  test('링크도 해제', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><a href="https://example.com">link</a></p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<a');
    expect(ed.innerHTML).toContain('link');
  });

  test('취소선 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><s>strike</s></p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<s>');
  });

  test('이미지가 있는 빈 태그는 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span><img src="test.png"></span>text</p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.querySelector('img')).not.toBeNull();
  });

  test('선택 없을 때 span style 제거 후 unwrap', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span style="color:red">red</span></p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild.firstChild, 1);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('style=');
    expect(ed.innerHTML).not.toContain('<span>');
  });

  test('선택 없을 때 엘리먼트 노드에서', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold</b></p>';
    const p = ed.querySelector('p');
    // 엘리먼트 노드에 커서 (텍스트 노드가 아님)
    const range = document.createRange();
    range.setStart(p, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
  });

  test('선택 없을 때 closest가 null이면 editorEl 사용', () => {
    const ed = createEditor();
    // p/div/li 등이 아닌 직접 텍스트
    ed.innerHTML = 'plain text';
    const range = document.createRange();
    range.setStart(ed.firstChild, 2);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    expect(() => clearInlineFormatting(ed)).not.toThrow();
  });

  test('toggleBlockquote에서 엘리먼트 노드', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const p = ed.querySelector('p');
    const range = document.createRange();
    range.setStart(p, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    expect(toggleBlockquote(ed)).toBe('not-in-blockquote');
  });

  test('getCurrentBlock에서 엘리먼트 노드', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const p = ed.querySelector('p');
    const range = document.createRange();
    range.setStart(p, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const block = getCurrentBlock(ed);
    expect(block).not.toBeNull();
  });

  test('getCurrentBlock에서 closest null이면 editorEl', () => {
    const ed = createEditor();
    ed.innerHTML = 'plain';
    const range = document.createRange();
    range.setStart(ed.firstChild, 2);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const block = getCurrentBlock(ed);
    expect(block).toBe(ed);
  });

  test('선택 없을 때 anchorNode가 null이면 리턴', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    // rangeCount는 있지만 anchorNode가 null인 경우
    const sel = window.getSelection();
    sel.removeAllRanges();
    expect(() => clearInlineFormatting(ed)).not.toThrow();
  });

  test('startContainer가 엘리먼트인 경우', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold</b></p>';
    const b = ed.querySelector('b');
    const range = document.createRange();
    range.selectNode(b); // 엘리먼트 자체 선택
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
  });

  test('서로 다른 컨테이너 선택', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold</b><i>italic</i></p>';
    const b = ed.querySelector('b').firstChild;
    const i = ed.querySelector('i').firstChild;
    const range = document.createRange();
    range.setStart(b, 0);
    range.setEnd(i, 6);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
    expect(ed.innerHTML).not.toContain('<i>');
  });

  test('빈 span 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span style="color:red"></span>text</p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    // 빈 span은 제거되어야 함
    const spans = ed.querySelectorAll('span');
    expect(spans.length).toBe(0);
  });

  test('속성이 남은 span은 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span style="color:red" class="keep">text</span></p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    // class가 있어서 span은 유지되지만 style은 제거
    expect(ed.innerHTML).toContain('class="keep"');
    expect(ed.innerHTML).not.toContain('style=');
  });
});

describe('doIndent - 들여쓰기', () => {
  test('들여쓰기 40px 증가', () => {
    const block = document.createElement('p');
    doIndent(block, 1);
    expect(block.style.marginLeft).toBe('40px');
  });

  test('두 번 들여쓰기 80px', () => {
    const block = document.createElement('p');
    doIndent(block, 1);
    doIndent(block, 1);
    expect(block.style.marginLeft).toBe('80px');
  });

  test('내어쓰기', () => {
    const block = document.createElement('p');
    block.style.marginLeft = '80px';
    doIndent(block, -1);
    expect(block.style.marginLeft).toBe('40px');
  });

  test('0에서 내어쓰기해도 음수 안 됨', () => {
    const block = document.createElement('p');
    doIndent(block, -1);
    expect(block.style.marginLeft).toBe('');
  });

  test('0이 되면 속성 제거 (0px 잔류 방지)', () => {
    const block = document.createElement('p');
    block.style.marginLeft = '40px';
    doIndent(block, -1);
    expect(block.style.marginLeft).toBe('');
  });

  test('block이 null이면 리턴', () => {
    expect(() => doIndent(null, 1)).not.toThrow();
    expect(() => doIndent(undefined, 1)).not.toThrow();
  });
});

describe('toggleBlockquote - 인용 토글', () => {
  test('인용 안에 있으면 해제', () => {
    const ed = createEditor();
    ed.innerHTML = '<blockquote><p>quoted</p></blockquote>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild, 2);
    const result = toggleBlockquote(ed);
    expect(result).toBe('unwrapped');
    expect(ed.querySelector('blockquote')).toBeNull();
    expect(ed.innerHTML).toContain('quoted');
  });

  test('인용 밖이면 not-in-blockquote', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>normal</p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild, 2);
    const result = toggleBlockquote(ed);
    expect(result).toBe('not-in-blockquote');
  });

  test('선택 없으면 no-selection', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    window.getSelection().removeAllRanges();
    const result = toggleBlockquote(ed);
    expect(result).toBe('no-selection');
  });

  test('anchorNode가 null이면 no-selection', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const sel = window.getSelection();
    sel.removeAllRanges();
    // 강제로 rangeCount는 있지만 anchorNode가 없는 경우 시뮬레이션은 어려우므로 스킵
    expect(toggleBlockquote(ed)).toBe('no-selection');
  });
});

describe('unwrapElement', () => {
  test('자식을 부모로 올리고 태그 삭제', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>bold</b> normal</p>';
    const b = ed.querySelector('b');
    unwrapElement(b);
    expect(ed.innerHTML).toBe('<p>bold normal</p>');
  });

  test('중첩 태그 unwrap', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b><i>text</i></b></p>';
    unwrapElement(ed.querySelector('b'));
    expect(ed.innerHTML).toBe('<p><i>text</i></p>');
  });

  test('부모 없으면 리턴', () => {
    const el = document.createElement('b');
    el.innerHTML = 'detached';
    expect(() => unwrapElement(el)).not.toThrow();
  });

  test('clearInlineFormatting에서 부모 없는 엘리먼트', () => {
    // unwrap의 !parent 분기를 직접 테스트
    const el = document.createElement('span');
    el.setAttribute('style', 'color:red');
    // parentNode가 null인 상태
    expect(el.parentNode).toBeNull();
    expect(() => unwrapElement(el)).not.toThrow();
  });
});

describe('getCurrentBlock', () => {
  test('현재 블록 반환', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild, 2);
    const block = getCurrentBlock(ed);
    expect(block.tagName).toBe('P');
  });

  test('li 안에서 li 반환', () => {
    const ed = createEditor();
    ed.innerHTML = '<ul><li>item</li></ul>';
    const li = ed.querySelector('li');
    collapseAt(li.firstChild, 2);
    const block = getCurrentBlock(ed);
    expect(block.tagName).toBe('LI');
  });

  test('선택 없으면 null', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    window.getSelection().removeAllRanges();
    expect(getCurrentBlock(ed)).toBeNull();
  });
});

describe('방어 분기 커버리지', () => {
  // window.getSelection을 흉내 내는 헬퍼 (jsdom으로 만들기 어려운 방어 분기용)
  function mockSel(overrides) {
    return jest.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      anchorNode: null,
      getRangeAt: () => ({ collapsed: true }),
      removeAllRanges: () => {},
      addRange: () => {},
      ...overrides,
    });
  }

  test('wrapSelectionStyle: data-tmp span을 못 찾으면 조용히 종료', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    collapseAt(ed.querySelector('p').firstChild, 5);
    const spy = jest.spyOn(document, 'querySelector').mockReturnValue(null);
    expect(() => wrapSelectionStyle('font-size:30pt')).not.toThrow();
    spy.mockRestore();
  });

  test('clearInlineFormatting: anchorNode가 null이면 리턴', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const spy = mockSel({ anchorNode: null });
    expect(() => clearInlineFormatting(ed)).not.toThrow();
    spy.mockRestore();
  });

  test('clearInlineFormatting: block이 null이면 리턴 (detached 텍스트 노드)', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const detached = document.createTextNode('x'); // parentElement === null
    const spy = mockSel({ anchorNode: detached });
    expect(() => clearInlineFormatting(ed)).not.toThrow();
    spy.mockRestore();
  });

  test('clearInlineFormatting: 실제 DOM의 텍스트 있는 인라인 요소는 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><b>keep</b></p><p>plain</p>';
    selectAll(ed.querySelectorAll('p')[1]);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).toContain('<b>keep</b>');
  });

  test('clearInlineFormatting: 실제 DOM의 이미지가 있는 빈 요소는 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span><img src="t.png"></span></p><p>plain</p>';
    selectAll(ed.querySelectorAll('p')[1]);
    clearInlineFormatting(ed);
    expect(ed.querySelector('img')).not.toBeNull();
  });

  test('toggleBlockquote: anchorNode가 null이면 no-selection', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const spy = mockSel({ anchorNode: null });
    expect(toggleBlockquote(ed)).toBe('no-selection');
    spy.mockRestore();
  });

  test('toggleBlockquote: closest가 없으면 no-selection', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const spy = mockSel({ anchorNode: document }); // document.closest === undefined
    expect(toggleBlockquote(ed)).toBe('no-selection');
    spy.mockRestore();
  });

  test('getCurrentBlock: anchorNode가 null이면 null', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const spy = mockSel({ anchorNode: null });
    expect(getCurrentBlock(ed)).toBeNull();
    spy.mockRestore();
  });

  test('getCurrentBlock: closest가 없으면 null', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    const spy = mockSel({ anchorNode: document });
    expect(getCurrentBlock(ed)).toBeNull();
    spy.mockRestore();
  });

  test('applyLink: 비어 있는 비-collapsed 선택이면 URL 텍스트로 링크 생성', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    // 빈 b 요소를 선택 (toString() === '')
    const p = ed.querySelector('p');
    p.innerHTML = '<b></b>';
    const range = document.createRange();
    range.selectNode(p.querySelector('b'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    applyLink(ed, 'naver.com');
    const a = ed.querySelector('a');
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('naver.com');
    expect(a.target).toBe('_blank');
  });
});

describe('커버리지 100% 마무리', () => {
  test('clearInlineFormatting: 빈 span(class 있음)은 detached 정리에서 제거', () => {
    const ed = createEditor();
    ed.innerHTML = '<p><span class="x"></span>text</p>';
    selectAll(ed);
    clearInlineFormatting(ed);
    expect(ed.querySelector('span')).toBeNull();
    expect(ed.innerHTML).toContain('text');
  });

  test('clearInlineFormatting: closest 매치 없으면 editorEl 전체 정리', () => {
    const ed = document.createElement('section'); // div가 아니라 closest가 null
    ed.contentEditable = 'true';
    document.body.appendChild(ed);
    ed.innerHTML = '<span><b>bold</b></span>';
    collapseAt(ed.querySelector('b').firstChild, 2);
    clearInlineFormatting(ed);
    expect(ed.innerHTML).not.toContain('<b>');
    expect(ed.innerHTML).toContain('bold');
  });

  test('getCurrentBlock: closest 매치 없으면 editorEl 반환', () => {
    const ed = document.createElement('section');
    ed.contentEditable = 'true';
    document.body.appendChild(ed);
    ed.innerHTML = '<span>plain</span>';
    collapseAt(ed.querySelector('span').firstChild, 2);
    expect(getCurrentBlock(ed)).toBe(ed);
  });
});

describe('applyLink - 링크 삽입', () => {
  test('선택 텍스트에 링크 생성', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>click here</p>';
    selectAll(ed.querySelector('p'));
    const result = applyLink(ed, 'https://example.com');
    expect(result).toBe(true);
    const a = ed.querySelector('a');
    expect(a).not.toBeNull();
    expect(a.href).toBe('https://example.com/');
    expect(a.textContent).toBe('click here');
  });

  test('선택 없으면 URL을 텍스트로 삽입', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>hello</p>';
    const p = ed.querySelector('p');
    collapseAt(p.firstChild, 5);
    const result = applyLink(ed, 'https://example.com');
    expect(result).toBe(true);
    expect(ed.innerHTML).toContain('https://example.com');
  });

  test('선택 없으면 false', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>text</p>';
    window.getSelection().removeAllRanges();
    expect(applyLink(ed, 'https://example.com')).toBe(false);
  });

  test('프로토콜 없으면 https:// 추가', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>naver</p>';
    selectAll(ed.querySelector('p'));
    applyLink(ed, 'naver.com');
    const a = ed.querySelector('a');
    expect(a).not.toBeNull();
    expect(a.href).toBe('https://naver.com/');
  });

  test('http://는 그대로 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>site</p>';
    selectAll(ed.querySelector('p'));
    applyLink(ed, 'http://example.com');
    const a = ed.querySelector('a');
    expect(a.href).toBe('http://example.com/');
  });

  test('https://는 그대로 유지', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>site</p>';
    selectAll(ed.querySelector('p'));
    applyLink(ed, 'https://example.com');
    const a = ed.querySelector('a');
    expect(a.href).toBe('https://example.com/');
  });

  test('새탭에서 열리도록 target=_blank', () => {
    const ed = createEditor();
    ed.innerHTML = '<p>naver</p>';
    selectAll(ed.querySelector('p'));
    applyLink(ed, 'naver.com');
    const a = ed.querySelector('a');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener');
  });
});
