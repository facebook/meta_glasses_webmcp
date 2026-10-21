/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Deck vetting — the mechanical half of "is this card any good".
 *
 * Taste is not checkable, but four specific ways a Password card goes wrong
 * are, and all four are invisible by inspection because they come from how
 * `violates()` matches rather than from what the card says.
 *
 *   1. THE COMPOUND TAIL. Matching is by prefix in both directions, so a
 *      compound secret bans its own head for free (WATERMELON blocks "water")
 *      but not its tail — "melon" stays legal and ends the card in one word.
 *      Every sub-word of every secret is checked against a real dictionary.
 *   2. THE OVER-FIRING BAN. A short ban catches strangers: "star" fouls
 *      "start", "sand" fouls "sandwich". Each ban is run against a list of
 *      words a describer plausibly says.
 *   3. THE WASTED SLOT. A ban already covered by the secret's own prefix rule
 *      spends one of five slots on nothing.
 *   4. THE MALFORMED CARD. Wrong ban count, duplicates within a card, secrets
 *      colliding across the two pools.
 *
 *   vite-node test/vet-deck.mjs             # report
 *   vite-node test/vet-deck.mjs -- --strict # non-zero exit on any error
 */
import { readFileSync } from 'node:fs';

const { PLAYER_CARDS, COMPUTER_CARDS, DECK } = await import('../src/deck.ts');
const { violates } = await import('../src/engine.ts');

const strict = process.argv.includes('--strict');

/**
 * Short bans with no longer form to reach for. The four-character floor exists
 * so a ban catches a word family, but "wet" has no family — it matches exactly
 * and that is the most it can do. Blocking it anyway is right; flagging it is
 * noise.
 */
const SHORT_OK = new Set(['wet', 'art', 'pie', 'dry', 'hot', 'red', 'sun', 'bee', 'axe', 'bow', 'gym']);

/**
 * Fragments the compound check finds that are not real escapes. `/usr/share/
 * dict/words` is extremely permissive — it lists "tain", so FOUNTAIN reads as
 * "foun" + "tain". Nobody clues a fountain by saying "tain".
 */
const NOT_A_WORD_ANYONE_SAYS = new Set(['tain']);
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/** Real words, lowercased, 4+ letters — for the compound-tail hunt. */
let dictionary = new Set();
try {
  dictionary = new Set(
    readFileSync('/usr/share/dict/words', 'utf8')
      .split('\n')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 4 && /^[a-z]+$/.test(w)),
  );
} catch {
  warn('no /usr/share/dict/words — the compound-tail check was skipped');
}

/**
 * Words a clue-giver plausibly says about anything. A ban that catches one of
 * these fouls players for speaking ordinary English, which reads as a bug.
 */
const COMMON = `about above across after again against around because before behind below beside
between beyond during inside near onto outside over through under upon within without
someone something somewhere anyone anything everyone everything nobody nothing
start started starting begin beginning first second third last next another other
little large small tiny huge giant long short round square flat sharp smooth rough
people person child children adult family friend group team everybody
place thing stuff object item piece part whole half side edge corner middle
make made making take taken taking give given giving find found finding
keep kept holding carry carried move moved moving turn turned putting
look looking watch watched seeing hear heard listen sound noise
think thought know known remember forget
build built building break broken breaking
open opened close closed
sandwich handle handful handsome architect architecture ticket suitcase suitable
spinach standard startle sanded harbour beacon
morning evening today tomorrow yesterday
picture different important popular famous common usual normal special
kitchen bathroom bedroom garden street city town country world
water air earth metal wooden plastic paper glass
white black brown green colour bright dark
happy angry scared funny serious
money price expensive cheap
machine device gadget tool instrument equipment
animal plant human`
  .split(/\s+/)
  .filter(Boolean);

// ---------------------------------------------------------------- structure

const pools = [
  ['PLAYER_CARDS', PLAYER_CARDS],
  ['COMPUTER_CARDS', COMPUTER_CARDS],
];

for (const [name, pool] of pools) {
  if (pool.length !== 100) err(`${name} has ${pool.length} cards, expected 100`);
}
if (DECK.length !== 200) err(`DECK has ${DECK.length} cards, expected 200`);

const seen = new Map();
for (const [name, pool] of pools) {
  for (const c of pool) {
    if (seen.has(c.secret)) err(`"${c.secret}" appears in both ${seen.get(c.secret)} and ${name}`);
    seen.set(c.secret, name);
  }
}

for (const c of DECK) {
  if (!/^\p{Lu}+$/u.test(c.secret)) err(`"${c.secret}" is not a single all-caps word`);
  if (c.banned.length !== 5) err(`"${c.secret}" has ${c.banned.length} banned words, expected 5`);
  const lower = c.banned.map((b) => b.toLowerCase());
  if (new Set(lower).size !== lower.length) err(`"${c.secret}" repeats a banned word`);
  for (const b of c.banned) {
    if (b.length < 4 && !SHORT_OK.has(b.toLowerCase())) {
      warn(`"${c.secret}" bans "${b}" (under 4 chars — matches exactly, never a family)`);
    }
  }
}

// ------------------------------------------------- 3. bans already implied

for (const c of DECK) {
  for (const b of c.banned) {
    if (violates(b, c.secret)) {
      warn(`"${c.secret}" wastes a slot on "${b}" — the secret's own prefix rule already blocks it`);
    }
  }
}

// ----------------------------------------------- 1. the compound-tail escape

/**
 * Combining forms that end a lot of English compounds and give the whole word
 * away on their own. The dictionary alone cannot find these — "scope" inside
 * STETHOSCOPE does not split into two dictionary words — and a raw substring
 * scan finds them buried under noise like "acier" inside GLACIER.
 */
const MORPHEMES = [
  'scope', 'meter', 'graph', 'phone', 'smith', 'cycle', 'marine', 'house', 'works', 'chute',
  'barrow', 'copter', 'melon', 'berry', 'cake', 'board', 'mower', 'coaster', 'bridge', 'flower',
  'burger', 'wheel', 'writer', 'glass', 'shoe', 'sock', 'chime', 'dial', 'rope', 'fish',
  'horse', 'ball', 'boat', 'bird', 'stone', 'wood', 'light', 'water', 'fire',
]

/**
 * Real compound splits: the secret cut in two, where both halves are words.
 * Catches WATERMELON -> water + melon without inventing "acier".
 */
function compoundParts(secret) {
  const s = secret.toLowerCase()
  const out = []
  for (let i = 3; i <= s.length - 3; i++) {
    const head = s.slice(0, i)
    const tail = s.slice(i)
    if (dictionary.has(head) && dictionary.has(tail)) out.push(head, tail)
  }
  for (const m of MORPHEMES) {
    if (s !== m && (s.endsWith(m) || s.startsWith(m))) out.push(m)
  }
  return [...new Set(out)].filter((w) => w.length >= 4 && !NOT_A_WORD_ANYONE_SAYS.has(w))
}

if (dictionary.size) {
  for (const c of DECK) {
    const forbidden = [c.secret, ...c.banned]
    const escapes = compoundParts(c.secret).filter((w) => !forbidden.some((f) => violates(w, f)))
    if (escapes.length) {
      err(`"${c.secret}" leaks — sits inside it and is still legal to say: ${escapes.join(', ')}`)
    }
  }
}

// -------------------------------------------------- 2. the over-firing ban

for (const c of DECK) {
  for (const b of c.banned) {
    const caught = COMMON.filter((w) => violates(w, b));
    // A ban legitimately catches its own family; flag only words that do not
    // share the ban's first four characters, i.e. genuine strangers.
    const strangers = caught.filter((w) => !w.startsWith(b.toLowerCase().slice(0, 4)) || w.length > b.length + 3);
    if (strangers.length) {
      warn(`"${c.secret}" bans "${b}", which also fouls: ${strangers.join(', ')}`);
    }
  }
}

// ------------------------------------------------------------------ report

const line = (s) => console.log(s);
line('');
line(`Deck: ${DECK.length} cards — ${PLAYER_CARDS.length} player, ${COMPUTER_CARDS.length} computer`);
line(`Dictionary: ${dictionary.size.toLocaleString()} words`);
line('');

if (errors.length) {
  line(`\x1b[31m${errors.length} error(s)\x1b[0m`);
  for (const e of errors) line(`  - ${e}`);
  line('');
}
if (warnings.length) {
  line(`\x1b[33m${warnings.length} warning(s)\x1b[0m`);
  for (const w of warnings) line(`  - ${w}`);
  line('');
}
if (!errors.length && !warnings.length) line('\x1b[32mclean\x1b[0m\n');

if (strict && errors.length) process.exit(1);
