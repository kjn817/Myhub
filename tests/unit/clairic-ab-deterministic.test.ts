// Clairic A/B — deterministic (zero-LLM) baseline on the same eval set.
//
// The production default path for memory extraction is the deterministic
// `extractFacts` (fact-extract.ts): sentence split -> fact-sentence filter
// -> score -> top 5. This test measures what that path recovers from the
// exact memos the Clairic/LLM arms were measured on, so the doc can state
// what the current default already does — without any model call.
//
// Key-fact recovery: a key fact counts as recovered when some extracted
// fact contains it (or vice versa) after normalizeForDuplicate — the same
// normalizer the pipeline itself uses for near-duplicate checks.
//
// The recall floor is a regression guard, not a target: it must fail if
// the extractor degrades (e.g. the sentence splitter or the date/number
// scoring breaks), and it is set below the measured value with margin.
// Measured 2026-10-28: overall recall 1.00 (48/48, KO 1.00 / EN 1.00) — see
// docs/clairic-ab-20261028.md. That is sentence recall, not typed-field
// accuracy: the deterministic path returns sentences, it cannot answer
// "what is the date in ISO form" or "is an amount present" on its own.
import * as fs from 'fs'
import * as path from 'path'
import { extractFacts } from '../../src/services/fact-extract'
import { normalizeForDuplicate } from '../../src/services/memory-service'

interface EvalMemo {
  id: string
  lang: 'ko' | 'en'
  text: string
  key_facts: string[]
}

const EVAL_SET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/clairic-ab/eval-set.json'), 'utf8'),
) as { memos: EvalMemo[] }

function recovered(keyFact: string, facts: string[]): boolean {
  const nk = normalizeForDuplicate(keyFact)
  if (!nk) return false
  return facts.some((f) => {
    const nf = normalizeForDuplicate(f)
    return nf.includes(nk) || nk.includes(nf)
  })
}

describe('clairic-ab deterministic baseline (extractFacts)', () => {
  const memos = EVAL_SET.memos

  it('loads the 30-memo eval set (15 KO + 15 EN)', () => {
    expect(memos).toHaveLength(30)
    expect(memos.filter((m) => m.lang === 'ko')).toHaveLength(15)
    expect(memos.filter((m) => m.lang === 'en')).toHaveLength(15)
    for (const m of memos) expect(m.key_facts.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts 1-5 facts per memo, each grounded in the memo text', () => {
    for (const memo of memos) {
      const facts = extractFacts(memo.text, 5)
      // Canary: an extractor that returns nothing (or explodes) fails here.
      expect(facts.length).toBeGreaterThanOrEqual(1)
      expect(facts.length).toBeLessThanOrEqual(5)
      for (const f of facts) {
        // Every fact must come from the memo, not invented.
        expect(normalizeForDuplicate(memo.text)).toContain(normalizeForDuplicate(f))
      }
    }
  })

  it('recovers key facts at or above the regression floor', () => {
    let total = 0
    let hit = 0
    const byLang: Record<string, { total: number; hit: number }> = {
      ko: { total: 0, hit: 0 },
      en: { total: 0, hit: 0 },
    }
    for (const memo of memos) {
      const facts = extractFacts(memo.text, 5)
      for (const kf of memo.key_facts) {
        total += 1
        byLang[memo.lang].total += 1
        if (recovered(kf, facts)) {
          hit += 1
          byLang[memo.lang].hit += 1
        }
      }
    }
    const recall = hit / total
    const koRecall = byLang.ko.hit / byLang.ko.total
    const enRecall = byLang.en.hit / byLang.en.total
    // Reported for the A/B doc; the floor guards against regressions.
    console.log(
      `deterministic baseline key-fact recall: overall=${recall.toFixed(2)} ` +
        `(${hit}/${total}) ko=${koRecall.toFixed(2)} en=${enRecall.toFixed(2)}`,
    )
    expect(recall).toBeGreaterThanOrEqual(0.6)
    expect(koRecall).toBeGreaterThanOrEqual(0.6)
    expect(enRecall).toBeGreaterThanOrEqual(0.6)
  })
})
