/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure 20 Questions helpers — no DOM, no framework. Importable from Node or tests.
//
// This page never knows the secret. It is a scoreboard: it counts questions,
// keeps the transcript, and derives a short caption for each answer. Everything
// here is a pure function over that transcript.

export type Answer = 'yes' | 'no' | 'maybe'

export const MAX_QUESTIONS = 20

/** One recorded exchange, or a guess (marked with a tick / cross). */
export interface Exchange {
  n: number | '✓' | '✗'
  question: string
  answer: Answer
}

/** Idempotency key for a question, so re-recording the same one is detectable. */
export function questionKey(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Accept whatever the human actually said, normalised to three buckets. */
export function normalizeAnswer(raw: unknown): Answer | null {
  const a = String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z ]/g, '')
  if (!a) return null
  if (/^(y|yes|yeah|yep|yup|correct|right|true|it is|sure)\b/.test(a)) return 'yes'
  if (/^(n|no|nope|nah|negative|wrong|false|it isnt|it is not)\b/.test(a)) return 'no'
  if (/^(maybe|sometimes|sort of|kind of|partly|unsure|dunno|i dont know|unknown|both)\b/.test(a)) {
    return 'maybe'
  }
  return null
}

// --- Answer captions -------------------------------------------------------
// The orb shows what was learned ("NOT ALIVE") rather than a bare "NO". The
// agent supplies that phrase via record_answer's `summary` — it understands the
// semantics far better than any rule could. The derivation below is only the
// fallback, and it deliberately gives up on anything long or oddly phrased
// rather than showing something garbled.

const LEAD_RE =
  /^(?:and |so |okay,?\s*|alright,?\s*|right,?\s*|well,?\s*|now,?\s*|next,?\s*|first,?\s*|question\s+\w+\s*[-—:,]*\s*)+/

export function deriveSummary(question: string, answer: Answer): string | null {
  let q = String(question || '')
    .toLowerCase()
    .replace(/[?!.]+\s*$/, '')
    .trim()
  q = q.replace(LEAD_RE, '')
  q = q.replace(/^(?:is|are|was|were)\s+(?:it|your secret|the secret|this|that)\s+/, '')
  q = q.replace(/^(?:does|do|did)\s+(?:it|your secret|you)\s+/, '')
  q = q.replace(/^(?:can|could|would|will|should)\s+(?:it|you)\s+/, '')
  q = q.replace(/^(?:it|your secret)\s+/, '')
  q = q.replace(/^something\s+(?:that\s+|which\s+)?/, '')
  q = q.replace(/^(?:a|an|the)\s+/, '')
  q = q.replace(/\s+/g, ' ').trim()

  // Anything this long stops being glanceable — fall back to yes/no.
  if (!q || q.split(' ').length > 4 || q.length > 22) return null
  if (answer === 'yes') return q
  if (answer === 'no') return `not ${q}`
  return `maybe ${q}`
}

/** Agent-supplied summary wins; then derivation; then a bare YES/NO. */
export function answerCaption(question: string, answer: Answer, summary?: string): string {
  const given = String(summary || '').trim()
  if (given && given.length <= 22) return given.toUpperCase()
  const derived = deriveSummary(question, answer)
  if (derived) return derived.toUpperCase()
  return answer.toUpperCase()
}

// --- Strategy coaching -----------------------------------------------------
// The page holds no knowledge of the secret, but it does hold the transcript —
// so it can see HOW the agent is searching and say something useful about it.
// Observed against a live model: it enumerates ("kitchen? bedroom? bathroom?
// cleaning? furniture?"), which peels off a thin slice per question, and only
// reaches near-50/50 splits like "handheld?" and "metal?" at Q13 and Q17. That
// loses games it should win by Q8.

interface Axis {
  hint: string
  re: RegExp
}

const AXES: Axis[] = [
  { hint: 'Is it alive?', re: /\balive\b|\bliving\b|\banimal\b|\bplant\b|\bcreature\b/ },
  { hint: 'Is it man-made?', re: /\bman-?made\b|\bmanufactur|\bnatural\b|\bartificial\b/ },
  {
    hint: 'Could you hold it in one hand?',
    re: /\bbigger\b|\blarger\b|\bsmaller\b|\bsize\b|\bhold it\b|\bin (your |one )?hand\b|\bfit in\b|\bbreadbox\b|\bmicrowave\b|\bcarry\b/,
  },
  {
    hint: 'Is it mostly made of metal?',
    re: /\bmetal\b|\bwood(en)?\b|\bplastic\b|\bglass\b|\bfabric\b|\bcloth\b|\bpaper\b|\brubber\b|\bmade of\b/,
  },
  {
    hint: 'Does it need power or batteries to work?',
    re: /\belectric|\bbatter|\bpower(ed)?\b|\bmotor\b|\bengine\b|\bplug\b/,
  },
  {
    hint: 'Do you use it to do a job, like a tool?',
    re: /\btool\b|\bused (for|to)\b|\bpurpose\b|\bdo a job\b|\bcut\b|\bwrite\b|\bfasten\b|\bmeasure\b/,
  },
  {
    hint: 'Is it usually found indoors?',
    re: /\bindoors?\b|\boutdoors?\b|\binside\b|\boutside\b|\bin a (house|home|building)\b/,
  },
  {
    hint: 'Does it have moving parts?',
    re: /\bmoving parts\b|\bhinge\b|\bfold\b|\bopens?\b|\bcloses?\b|\bswitch\b/,
  },
]

/** Narrow, low-yield questions: rooms and one-off category guesses. */
const ENUMERATION_RE =
  /\bkitchen\b|\bbedroom\b|\bbathroom\b|\bliving room\b|\bgarage\b|\boffice\b|\bbasement\b|\bcloset\b|\bgarden\b|\bfurniture\b|\bdecoration\b|\bcleaning\b/

export interface StrategyNote {
  high_value_axes_not_yet_asked?: string[]
  warning?: string
}

/** Coaching derived purely from what has been asked so far, or null if nothing to say. */
export function strategyNote(asked: Exchange[]): StrategyNote | null {
  const joined = asked.map((a) => String(a.question).toLowerCase()).join(' | ')
  const missing = AXES.filter((a) => !a.re.test(joined))
  const enumCount = asked.filter((a) => ENUMERATION_RE.test(String(a.question).toLowerCase())).length

  const note: StrategyNote = {}
  if (missing.length) note.high_value_axes_not_yet_asked = missing.map((a) => a.hint)
  if (enumCount >= 2) {
    note.warning =
      `You have asked ${enumCount} narrow room-or-category questions (kitchen, bedroom, furniture, ` +
      'cleaning, and the like). Each one eliminates only a sliver. Stop enumerating. Ask a question that ' +
      'splits everything still possible roughly in half — size, material, power, and function do that best.'
  }
  return Object.keys(note).length ? note : null
}
