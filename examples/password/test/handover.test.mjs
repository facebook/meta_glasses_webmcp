/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Half-two handover tests, driven through the real tool layer.
 *
 * These exist because of a live failure on glasses: the agent took its first
 * half-two card and then went silent, and the human had to say "give me a hint"
 * to restart it. Nothing in the page was broken — the agent had simply been
 * told to speak and then call another tool, and speaking ends its turn. So the
 * things worth testing are not the rules but the *shape of the handover*: how
 * many tool calls stand between a card resolving and the agent being allowed to
 * talk, and what the page has already handed over by then.
 *
 * The page is loaded into jsdom and the tools are executed through
 * `getTools`/`executeTool`, so what is asserted here is the exact JSON a model
 * would see.
 *
 *   yarn workspace example-password test
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:5173/' });

// game.ts is DOM-free, but render.ts reads globals at import
// time, so the globals have to land before the dynamic imports below.
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Event = dom.window.Event;
global.CustomEvent = dom.window.CustomEvent;
global.EventTarget = dom.window.EventTarget;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

const { Game } = await import('../src/game.ts');
const { render } = await import('../src/render.ts');
const { registerTools } = await import('../src/mcp.ts');
const { HALF_SECONDS, blanks } = await import('../src/engine.ts');
const { getTools, executeTool } = await import('../src/webmcp.ts');

let passed = 0,
  failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds, so the assertions do not race the animation. */
async function waitFor(pred, timeout = 2500, step = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

const game = new Game();
game.subscribe(render);
registerTools(game);

const tools = new Map(getTools().map((t) => [t.name, t]));

/** Call a tool the way a host would, and parse the JSON the model would read. */
async function call(name, args = {}) {
  const raw = await executeTool(name, args);
  const text = typeof raw === 'string' ? raw : (raw?.content?.[0]?.text ?? JSON.stringify(raw));
  try {
    return JSON.parse(typeof text === 'string' && text.startsWith('"') ? JSON.parse(text) : text);
  } catch {
    return { _unparsed: text };
  }
}

/** What the card face currently reads, spaces stripped: "_ _ _" -> "___". */
const faceText = () => document.getElementById('secret').textContent.replace(/\s+/g, '');

// A token that can never be a secret or a banned word: `violates` needs four
// characters on the shorter side, so a three-letter nonsense word is always
// clean, in `heard` and in a clue alike.
const CLEAN = 'zzz';

/** The banned-list items currently marked as the word that burned the card. */
const struckItems = () => [...document.querySelectorAll('#banned li.struck')];

console.log('\nThe deal — fixed pools, random within them');

const { PLAYER_CARDS, COMPUTER_CARDS, DECK: FULL_DECK } = await import('../src/deck.ts');
const playerWords = new Set(PLAYER_CARDS.map((c) => c.secret));
const computerWords = new Set(COMPUTER_CARDS.map((c) => c.secret));

check(
  'the two pools share no card',
  [...playerWords].every((w) => !computerWords.has(w)),
  [...playerWords].filter((w) => computerWords.has(w)).join(', '),
);
check(
  'and together they are the whole deck, with nothing counted twice',
  playerWords.size + computerWords.size === FULL_DECK.length &&
    new Set(FULL_DECK.map((c) => c.secret)).size === FULL_DECK.length,
  `player ${playerWords.size} + computer ${computerWords.size} vs deck ${FULL_DECK.length}`,
);

// Deal a pile of games straight from the engine: the halves must always come
// from their own pool, and across many deals the words must actually vary.
const { dealHalves: deal } = await import('../src/engine.ts');
const firstSeen = new Set();
const secondSeen = new Set();
let crossed = null;
for (let i = 0; i < 200; i++) {
  const { first, second } = deal(PLAYER_CARDS, COMPUTER_CARDS);
  for (const c of first) {
    firstSeen.add(c.secret);
    if (!playerWords.has(c.secret)) crossed ??= `half one dealt ${c.secret}`;
  }
  for (const c of second) {
    secondSeen.add(c.secret);
    if (!computerWords.has(c.secret)) crossed ??= `half two dealt ${c.secret}`;
  }
}
check('over 200 deals, half one only ever draws player cards', crossed === null, crossed ?? '');
check('and half two only ever draws computer cards', crossed === null, crossed ?? '');
check(
  'the deal is random, not a fixed slice — both pools get well covered',
  firstSeen.size > playerWords.size * 0.9 && secondSeen.size > computerWords.size * 0.9,
  `saw ${firstSeen.size}/${playerWords.size} player and ${secondSeen.size}/${computerWords.size} computer words`,
);

console.log('\nThe HUD — clock only, and not before the round');

const app = document.getElementById('app');
check(
  'the clock and scoreboard are hidden before a round starts',
  app.classList.contains('pregame'),
  `app classes: ${app.className || 'none'}`,
);

// The half-name and card-count chips that used to flank the clock are gone.
// Worth pinning: `render` writes the HUD on every state change, so a stray
// reference to either would throw on the first paint rather than degrade.
const hudIds = [...document.getElementById('hud').children].map((c) => c.id);
check('the HUD holds the clock and nothing else', hudIds.join(',') === 'clock', `children: ${hudIds.join(', ') || 'none'}`);
check('and no chip markup survives', document.querySelectorAll('#hud .chip').length === 0);

console.log('\nThe tool schemas — no example the model can mistake for an answer');

// A live game had the agent report the human as guessing "lighthouse" when they
// had said nothing at all. The card was LIGHTHOUSE, and `password_report_guess`
// advertised `heard` with the example "is it a lighthouse" — so the model filled
// the field from the schema rather than from the room, and the page awarded the
// point, because it can judge whether a guess is right but not whether it was
// spoken. Any deck word reachable as an example is the same trap, so this checks
// the whole deck against every description the model ever sees.
const { DECK } = await import('../src/deck.ts');
const schemaText = [...tools.values()]
  .map((t) => `${t.description ?? ''} ${JSON.stringify(t.inputSchema ?? {})}`)
  .join(' ')
  .toLowerCase();
const leaked = DECK.map((c) => c.secret).filter((s) => new RegExp(`\\b${s.toLowerCase()}\\b`).test(schemaText));
check(
  'no deck word appears in any tool description or schema',
  leaked.length === 0,
  `leaked: ${leaked.join(', ')}`,
);

console.log('\nBefore the round — the idle card asks for no magic phrase');

check(
  'the shipped markup does not tell them to say "let’s play"',
  !/let.s play/i.test(html),
  'index.html still carries the phrase',
);
check(
  'and neither does the idle face the renderer paints',
  await waitFor(() => !/let.s play/i.test(document.getElementById('eyebrow').textContent)),
  document.getElementById('eyebrow').textContent,
);

console.log('\nHalf one — a banned word burns the card and is struck off it');

await call('password_new_game');
check('half one starts on card 1', game.getState().phase === 'half1' && game.getState().cardNumber === 1);
check(
  'and the clock and scoreboard come in with it',
  !document.getElementById('app').classList.contains('pregame'),
  `app classes: ${document.getElementById('app').className || 'none'}`,
);
check('half one shows the word, not blanks', faceText().length > 0 && !faceText().includes('_'));

// Send the banned word on its own: `findViolation` scans token by token, so a
// bare ban is the one input whose verdict cannot depend on the rest of the
// sentence. Which ban comes back is read off the result rather than assumed.
const burned = game.getState().card;
const foul = await call('password_guess_word', { heard: burned.banned[0], guess: CLEAN });
check('the foul is called', foul.result === 'foul', JSON.stringify(foul).slice(0, 200));

const said = foul.banned_word_they_said;
check(
  'the burned card is held up rather than flipped straight away',
  faceText() === burned.secret,
  `face read "${faceText()}", expected "${burned.secret}"`,
);
check(
  'the word they said is struck through on it',
  struckItems().length === 1 && struckItems()[0].textContent === said,
  `struck: ${JSON.stringify(struckItems().map((li) => li.textContent))}, said "${said}"`,
);
check(
  'the agent is told to name that word out loud',
  new RegExp(said, 'i').test(foul.next_action ?? ''),
  foul.next_action,
);

const afterFoul = game.getState().card.secret;
check(
  'then the table turns over to the next word',
  await waitFor(() => faceText() === afterFoul),
  `face read "${faceText()}", expected "${afterFoul}"`,
);
check('and the strike does not survive the flip', struckItems().length === 0);

console.log('\nHalf one — play the rest out so half two can be tested');

let lastOfHalfOne = null;
let lastSecretOfHalfOne = '';
// Three left: the foul above burned card one and advanced the hand.
for (let i = 0; i < 3; i++) {
  const secret = game.getState().card.secret;
  lastSecretOfHalfOne = secret;
  lastOfHalfOne = await call('password_guess_word', { heard: CLEAN, guess: secret });
  check(`card ${i + 2} scored`, lastOfHalfOne.result === 'correct', JSON.stringify(lastOfHalfOne).slice(0, 200));
}

console.log('\nHalf time — the handover that stalled on device');

check('half one reported over', lastOfHalfOne.half_over === true);
check(
  'the page hands over the first half-two word with the half-time result',
  typeof lastOfHalfOne.your_word === 'string' && lastOfHalfOne.your_word.length > 0,
  'no your_word in the result that ended half one',
);
check(
  'the banned list comes with it',
  Array.isArray(lastOfHalfOne.banned_words) && lastOfHalfOne.banned_words.length === 5,
);
check('the page marks the card as already drawn', game.getState().drawn === true);
check(
  'the agent is told to clear a clue before it speaks',
  /password_say_clue/.test(lastOfHalfOne.next_action ?? ''),
  lastOfHalfOne.next_action,
);
check(
  'the half-time line starts with the word it just got',
  lastOfHalfOne.next_action?.includes(`saying "${lastSecretOfHalfOne}" out loud`),
  lastOfHalfOne.next_action,
);
check(
  'the agent is NOT told to speak first and call a tool afterwards',
  !/then call password_/i.test(lastOfHalfOne.next_action ?? ''),
  lastOfHalfOne.next_action,
);
check(
  'one utterance is asked for: the score and the clue together',
  /score/i.test(lastOfHalfOne.next_action ?? '') && /clue/i.test(lastOfHalfOne.next_action ?? ''),
  lastOfHalfOne.next_action,
);

// Only that it does not move. It used to also assert the reading was still a
// full HALF_SECONDS, which held for no better reason than that half one used to
// finish inside one wall-clock second — the strike hold above spends more than
// that, so half one's clock now ticks before the handover. What matters here is
// that the intermission is untimed; half two's own clock is reset by
// `startClock` when the first clue clears, and the assertion below catches that.
// Half time used to draw a placard reading HALF TIME, which tested as an
// interstitial to wait out rather than a cue to start guessing. It now comes up
// already showing the card the human is about to guess at.
check(
  'half time shows half two’s first word as blanks, not a HALF TIME placard',
  await waitFor(() => faceText() === blanks(lastOfHalfOne.your_word).replace(/\s+/g, '')),
  `face read "${faceText()}"`,
);
check(
  'and it tells them it is their turn to guess',
  /guess/i.test(document.getElementById('eyebrow').textContent ?? ''),
  document.getElementById('eyebrow').textContent,
);

const atHalfTime = game.getState().secondsLeft;
await sleep(1200);
check(
  'half two’s clock is still stopped while the agent composes',
  game.getState().secondsLeft === atHalfTime,
  `secondsLeft moved ${atHalfTime} -> ${game.getState().secondsLeft}`,
);

console.log('\nThe first clue starts half two');

const firstWord = game.getState().card.secret;
const cleared = await call('password_say_clue', { clue: CLEAN });
check('the clue clears', cleared.result === 'cleared', JSON.stringify(cleared).slice(0, 200));
check('half two is now running', game.getState().phase === 'half2');
check(
  'the clock started with the clue',
  await waitFor(() => game.getState().secondsLeft < HALF_SECONDS),
  `secondsLeft ${game.getState().secondsLeft}`,
);
check(
  'the card now shows blanks for the human',
  await waitFor(() => faceText() === blanks(firstWord).replace(/\s+/g, '')),
  faceText(),
);

console.log('\nA card resolving — the word is revealed, the next one is handed over');

const resolved = await call('password_report_guess', { heard: firstWord });
check('the guess is judged correct', resolved.result === 'correct');
check(
  'the resolved word animates into the blanks before the card flips',
  await waitFor(() => faceText() === firstWord),
  `face read "${faceText()}", expected "${firstWord}"`,
);

// A correct guess spins each letter green, left to right. The letters have to
// be their own elements for that to be possible at all — an inline text node
// cannot be rotated — and every one must finish before the card turns over.
const letters = () => [...document.querySelectorAll('#secret .ch')];
check(
  'the won word is split into one element per letter',
  letters().length === firstWord.length,
  `${letters().length} letter elements for a ${firstWord.length}-letter word`,
);
check(
  'every letter ends up spun green',
  await waitFor(() => letters().length > 0 && letters().every((l) => l.classList.contains('spun'))),
  `spun ${letters().filter((l) => l.classList.contains('spun')).length}/${letters().length}`,
);

const secondWord = game.getState().card.secret;
check(
  'the next word is handed over in the same result',
  resolved.your_word === secondWord,
  `your_word=${resolved.your_word}, card=${secondWord}`,
);
check('the next card is already drawn', game.getState().drawn === true);
check(
  'and again the agent clears a clue before speaking',
  /password_say_clue/.test(resolved.next_action ?? '') && !/then call password_/i.test(resolved.next_action ?? ''),
  resolved.next_action,
);
check(
  'the card flips on to the next word’s blanks',
  await waitFor(() => faceText() === blanks(secondWord).replace(/\s+/g, '')),
  faceText(),
);

console.log('\nA skipped card reveals too, and hands the next one over');

const skipped = await call('password_skip_card');
check('the skip is accepted', skipped.result === 'skipped');
check(
  'the skipped word is shown before it goes',
  await waitFor(() => faceText() === secondWord),
  faceText(),
);
check(
  'the word after it comes with the skip result',
  skipped.your_word === game.getState().card?.secret,
  `your_word=${skipped.your_word}`,
);

// A second round has to reach the screen. `freshState()` zeroes `flipToken`,
// so newGame() reading the token *after* the reset pinned every game at 1 —
// render.ts repaints the face only when the token changes, so the second game
// dealt a new word and left the previous one up. The demo recorder found this
// by re-dealing 200 times and reading the same word off the page every time.
// Last, because it starts rounds: the tests above assert on an idle page.
console.log('\nHalf one — saying part of the word burns the card, and the word is struck');

await call('password_new_game');
// Cards are dealt at random, so skip to one long enough to have a proper
// prefix that still clears the four-character floor.
for (let i = 0; i < 3 && game.getState().card.secret.length < 5; i++) await call('password_skip_card');
const partCard = game.getState().card;
const part = partCard.secret.slice(0, partCard.secret.length - 1).toLowerCase();
const partFoul = await call('password_guess_word', { heard: `it is used to ${part} things`, guess: CLEAN });
check(
  'the foul is called on the word itself',
  partFoul.result === 'foul' && partFoul.banned_word_they_said === partCard.secret,
  JSON.stringify(partFoul).slice(0, 200),
);
check('and the result names what they actually said', partFoul.they_said === part, partFoul.they_said);
check(
  'the secret on the card is struck, not a banned word',
  document.getElementById('secret').classList.contains('struck') && struckItems().length === 0,
  `secret classes: ${document.getElementById('secret').className}`,
);
check(
  'the card says which part was said',
  document.getElementById('eyebrow').textContent.includes(`"${part}"`),
  document.getElementById('eyebrow').textContent,
);
check(
  'the agent is told it was part of the word',
  /part of the word/.test(partFoul.next_action ?? ''),
  partFoul.next_action,
);

console.log('\nThe last card of half one finishes spinning before half two repaints');

await call('password_new_game');
for (let i = 1; i < game.getState().cardsInHalf; i++) {
  await call('password_guess_word', { heard: CLEAN, guess: game.getState().card.secret });
}
const finalWord = game.getState().card.secret;
await call('password_guess_word', { heard: CLEAN, guess: finalWord });
// The agent's first half-two clue, arriving while the win is still spinning.
await call('password_say_clue', { clue: CLEAN });
await sleep(100);
check(
  'the won word is still on the card after the first clue',
  faceText() === finalWord && document.getElementById('eyebrow').textContent === 'Got it',
  `face "${faceText()}", eyebrow "${document.getElementById('eyebrow').textContent}"`,
);
check(
  'and it spins green',
  await waitFor(() => document.querySelectorAll('#secret .ch.spun').length === finalWord.length),
);
const halfTwoWord = game.getState().card.secret;
check(
  'then the card turns over to half two',
  await waitFor(() => faceText() === blanks(halfTwoWord).replace(/\s+/g, '')) &&
    /describing/i.test(document.getElementById('eyebrow').textContent),
  `face "${faceText()}", eyebrow "${document.getElementById('eyebrow').textContent}"`,
);

console.log('\nAccents — PIÑATA is spelled right and matched either way');

const { isCorrectGuess } = await import('../src/engine.ts');
check('the deck spells it PIÑATA', FULL_DECK.some((c) => c.secret === 'PIÑATA'));
check('"piñata" is a correct guess', isCorrectGuess('is it a piñata', 'PIÑATA'));
check('"pinata" is a correct guess', isCorrectGuess('pinata', 'PIÑATA'));
check('the Ñ hides behind a blank like any letter', blanks('PIÑATA') === '_ _ _ _ _ _', blanks('PIÑATA'));

console.log('\nA second new game — the card on screen has to change with it');

await call('password_new_game');
const regameWord = game.getState().card?.secret ?? '';
await waitFor(() => faceText() === regameWord);
const regameToken = game.getState().flipToken;

// The deal is shuffled, so a re-deal can land on the same card. Deal until the
// engine hands over a different word, then see whether the screen followed.
let regameNext = regameWord;
let regameNextToken = regameToken;
for (let i = 0; i < 40 && regameNext === regameWord; i++) {
  await call('password_new_game');
  regameNext = game.getState().card?.secret ?? '';
  regameNextToken = game.getState().flipToken;
}
check(
  'the flip token keeps climbing across games',
  regameNextToken > regameToken,
  `first ${regameToken}, second ${regameNextToken}`,
);
check(
  'and the face follows the engine to the new word',
  await waitFor(() => faceText() === regameNext),
  `engine holds ${regameNext}, screen reads ${faceText()}`,
);

game.dispose();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
