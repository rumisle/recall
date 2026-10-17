// One tokenizer for the index, the query and the highlighter, so a highlight is always exactly what matched.
//
// A token is a run of letters and digits, lowercased with diacritics removed. CJK characters (no spaces between
// words) are one token each, and a query for a CJK word becomes a phrase of its characters, which matches the exact
// substring. Identifiers also yield their parts ("CommandPalette" -> command, palette; "utf8Decode" -> utf, 8,
// decode) so a search for one part finds the whole.

export interface Token {
  /** Normalized form. */
  text: string
  /** Offsets in the original string (UTF-16). */
  start: number
  end: number
  /** A part of an identifier, indexed in addition to the whole. */
  part?: true
}

/** Longer runs (base64, minified code) are not indexed. */
export const MAX_TOKEN = 64

const WORD = /[\p{L}\p{N}\p{M}]+/gu
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const MARKS = /\p{M}/gu
// Boundaries inside an identifier: aB, ABc (before the B), a1, 1a.
const PART = /\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+|[\p{L}\p{M}]+/gu

export function normalize(text: string) {
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase()
}

export function isCjk(token: string) {
  return CJK.test(token)
}

export function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const word of text.matchAll(WORD)) {
    const start = word.index
    if (CJK.test(word[0])) {
      // Split into CJK characters (one token each) and the other runs between them.
      let last = 0
      for (const run of word[0].matchAll(CJK_RUN)) {
        if (run.index > last) pushWord(out, word[0].slice(last, run.index), start + last)
        for (let i = 0; i < run[0].length; i++) {
          const code = run[0].codePointAt(i)!
          const char = String.fromCodePoint(code)
          out.push({ text: normalize(char), start: start + run.index + i, end: start + run.index + i + char.length })
          if (char.length === 2) i++
        }
        last = run.index + run[0].length
      }
      if (last < word[0].length) pushWord(out, word[0].slice(last), start + last)
      continue
    }
    pushWord(out, word[0], start)
  }
  return out
}

const ASCII = /^[a-zA-Z0-9]+$/
const PLAIN = /^(?:[a-z]+|[A-Z]?[a-z]*|[A-Z]+|[0-9]+)$/

function pushWord(out: Token[], word: string, start: number) {
  if (word.length > MAX_TOKEN) return
  const ascii = ASCII.test(word)
  const text = ascii ? word.toLowerCase() : normalize(word)
  if (!text) return
  out.push({ text, start, end: start + word.length })
  if (ascii && PLAIN.test(word)) return
  const parts = [...word.matchAll(PART)]
  if (parts.length < 2) return
  for (const part of parts) {
    const normalized = normalize(part[0])
    if (normalized) out.push({ text: normalized, start: start + part.index, end: start + part.index + part[0].length, part: true })
  }
}
