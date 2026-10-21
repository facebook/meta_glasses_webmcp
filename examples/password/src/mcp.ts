/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// MCP tool layer — the contract that makes a small voice model play a
// two-sided word game the right way round. The rules live in game.ts; this file
// is the part that survives contact with a live model.
//
// Three things it has to defend against, and the shape each defence takes:
//
//   1. Role drift. The direction of play inverts at half time, so `your_role`
//      and `half` ride on every single result. The page title says it too.
//   2. Fabrication. In half one the agent reports the human's words, and it
//      would be much easier for it to invent them. The referee is the page, so
//      `heard` and `guess` are fused into one call — there is no path to a
//      point that skips the check — and the tool says so loudly.
//   3. Turn hogging. Both halves are conversations with a clock, and the model
//      would happily call tools in a loop. Every non-terminal result ends with
//      a `next_action` that tells it to stop and speak.
//   4. Going quiet. The mirror image of 3, and the one that cost a live game.
//      Speech is what ends the model's turn, so "say this, then call that"
//      never gets as far as the tool — the agent speaks, the turn closes, and
//      nothing else happens until the human talks again. On glasses the agent
//      took its first half-two card, said it was taking over, and sat there;
//      the player had to say "give me a hint" to restart it, once per card.
//      So in half two the page never asks it to speak and then act. Each
//      result that closes a card hands over the next word in the same
//      payload, and every `next_action` there has the same shape: clear your
//      clue first, then say one line carrying everything you owe them.
//
// Descriptions are weak, tool results are strong: the freshest tool output is
// what the model actually steers on.
import { registerTool } from './webmcp.ts'
import { CARDS_PER_HALF, HALF_SECONDS, MAX_CLUE_REJECTS, formatClock } from './engine.ts'
import type { Fail, Game, GameState } from './game.ts'

const ROLE_HALF1 =
  'HALF ONE. YOU are the GUESSER. The card is on the human’s screen, not yours — you do NOT know ' +
  'the word and must never pretend to. They describe it out loud; you report what they said and guess. ' +
  'Never describe anything yourself, never ask them to guess, and never invent their words.'

const ROLE_HALF2 =
  'HALF TWO. YOU are the CLUE-GIVER. The page has handed you the word and its five banned words. ' +
  'You describe it out loud without using any of them; the HUMAN guesses out loud. ' +
  'NEVER speak the word itself, and NEVER read the banned words out loud — not as a clue, not to ' +
  'explain that you are stuck, not to tell them what you are avoiding. They are guessing at a row of ' +
  'blanks; saying any of it simply gives them the answer. ' +
  'Every clue must be cleared by password_say_clue BEFORE you speak it. ' +
  'Each new word is handed to you automatically as the last one finishes — you never have to ask for ' +
  'one, and you must never end a turn holding a word you have not clued.'

const ROLE_IDLE =
  'No round running. This game has two halves that swap roles: first the HUMAN describes words and YOU ' +
  'guess, then YOU describe and THEY guess. Call password_new_game when they ask to play.'

function roleFor(phase: GameState['phase']): string {
  if (phase === 'half1') return ROLE_HALF1
  if (phase === 'half2') return ROLE_HALF2
  if (phase === 'intermission') {
    return (
      'HALF TIME. The clock is stopped and the roles have swapped: you are the CLUE-GIVER now and the ' +
      'human guesses. The page has already handed you your first word — clear a clue for it with ' +
      'password_say_clue, and half two’s clock starts when that clue clears.'
    )
  }
  return ROLE_IDLE
}

const LISTEN_AGAIN =
  'STOP CALLING TOOLS. Say your guess out loud as a question, then END YOUR TURN and listen for more ' +
  'clues. Call this tool again with ONLY the new words they say next — not the ones you already sent.'

const CLUE_AGAIN =
  'STOP CALLING TOOLS. Now say ONE short line out loud: anything you still owe them about the card that ' +
  'just finished, and then this cleared clue, word for word. Then END YOUR TURN and wait for them to ' +
  'guess. Report their guess at the start of your next turn.'

/**
 * The half-two instruction, everywhere a card has just closed and a new word is
 * already in the agent's hands.
 *
 * The ordering is the whole point: clue first, speak once, speak last. The
 * reason is spelled out rather than asserted, because a model that understands
 * *why* it must not speak yet holds the line better than one told to obey.
 */
function clueThenSpeak(owed: string) {
  return (
    'Do NOT speak yet — speaking ends your turn, and anything you have not called for by then waits ' +
    'until the human talks again. Clear a clue for the new word with password_say_clue in this same ' +
    `turn. Then say ONE short line that ${owed}.`
  )
}

function toolError(reason: string, phase?: GameState['phase']) {
  const body = phase ? `${reason}\n\n${roleFor(phase)}` : reason
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

/** Turn a rejected state transition into the sentence the model needs. */
function explain(error: Fail, state: GameState) {
  // Half time is not a mistake, it is a handover, and it is the one transition
  // the agent cannot see coming: if the clock expires between turns its last
  // instruction was "listen", so it sits there until the human speaks. When it
  // finally does call something, answer with the kickoff rather than an error —
  // an isError here makes the model apologise instead of starting half two.
  if (state.phase === 'intermission') return reply(state, halfTail(state))

  switch (error) {
    case 'no_game':
      return toolError('No round in progress. Call password_new_game first.', state.phase)
    case 'game_over':
      return toolError(
        'The game is over. Read out the final score, and call password_new_game only if they want another.',
      )
    case 'not_drawn':
      return toolError('Re-read your word with password_draw_card first.', state.phase)
    case 'wrong_phase':
      return toolError(
        `That tool belongs to the other half. ${
          state.phase === 'half1'
            ? 'Right now the HUMAN is describing and you are guessing — use password_guess_word.'
            : 'Right now YOU are describing — use password_say_clue and password_report_guess.'
        }`,
        state.phase,
      )
  }
}

/**
 * The word the page is currently holding out to the agent, if any.
 *
 * Spread into every half-two result that puts a new card up, so the agent is
 * never in the position of knowing a card exists but not what is on it. Empty
 * in half one, where the whole game is that it does not get told.
 */
function handover(state: GameState) {
  if (!state.card || !state.drawn || state.secretOnScreen) return {}
  return {
    // The prohibition travels with the payload, not just in the role block. A
    // live game had the agent read the word and the whole banned list out loud
    // — the human was guessing at blanks and simply had the answer handed to
    // them. Nothing in the page can stop that: `password_say_clue` gates what
    // the agent asks to have cleared, not what it actually says. The only
    // defence is that these two fields never appear without this next to them.
    never_say_aloud:
      'your_word and banned_words below are FOR YOUR EYES ONLY. Saying the word out loud ends the ' +
      'card. Reading the banned list out loud — even to explain that you are stuck — hands them the ' +
      'five most obvious routes to the answer. They see only blanks and they are guessing: everything ' +
      'you speak must be a cleared clue and nothing else.',
    your_word: state.card.secret,
    banned_words: state.card.banned,
    clue_attempts_left: MAX_CLUE_REJECTS - state.rejects + 1,
  }
}

/**
 * The sentence pointing at the word just handed over — but only when there is
 * one. At full time there is no next card, and a result that closes the game
 * while promising another word is how an agent ends up clueing at nobody.
 */
function nextWordNote(state: GameState) {
  return state.card && state.drawn && !state.secretOnScreen
    ? ' The next word is already yours, in your_word.'
    : ''
}

/** Every successful result carries the same scoreboard header. */
function reply(state: GameState, extra: Record<string, unknown>) {
  const running = state.phase === 'half1' || state.phase === 'half2'
  return JSON.stringify({
    ok: true,
    half: state.phase,
    your_role: roleFor(state.phase),
    ...(running
      ? {
          time_left: state.expired
            ? '0:00 — TIME IS UP. This card is the last play of the half; it still counts, ' +
              'and the half closes the moment it resolves.'
            : formatClock(state.secondsLeft),
          card: `${state.cardNumber} of ${state.cardsInHalf}`,
        }
      : {}),
    score: { your_clues: state.youScore, ai_clues: state.aiScore },
    ...extra,
  })
}

/**
 * The message-and-next-action pair for one card's result.
 *
 * When that card was the last of the half, the half-time text is *appended* to
 * the card's own message rather than replacing it. Spreading `halfTail` over
 * the top instead swallowed the lead, so on the sixth card the agent was told
 * the half had ended but never that it had just got the word.
 *
 * The same goes for what the agent says. `opener` is the card's own line in a
 * few words ("saying the word you got") and leads the half-time line; without
 * it the last card of half one went by without the word ever being said.
 */
function cardTail(lead: string, nextAction: string, ended: boolean, state: GameState, opener: string) {
  if (!ended) return { message: lead, next_action: nextAction }
  const tail = halfTail(state, opener)
  return { ...tail, message: `${lead} ${tail.message}` }
}

/** Shared tail for "the half just ended" results. */
function halfTail(state: GameState, opener = '') {
  if (state.phase === 'over') {
    const { youScore, aiScore } = state
    const verdict =
      youScore > aiScore
        ? 'The human is the better clue-giver.'
        : aiScore > youScore
          ? 'You are the better clue-giver.'
          : 'It is a tie.'
    return {
      game_over: true,
      message: `Full time. Their clues scored ${youScore}, yours scored ${aiScore}. ${verdict}`,
      next_action:
        `${opener ? `Start by ${opener}, then read` : 'Read'} the final score out loud in one short ` +
        'line and say who clued better. Stop calling tools unless they ask for another game.',
    }
  }
  return {
    half_over: true,
    ...handover(state),
    message:
      `Half one is done. Their clues scored ${state.youScore}. The clock is STOPPED, and the page has ` +
      'already dealt you the first word of half two — it is in your_word. You do not have to ask for it.',
    next_action: clueThenSpeak(
      `${opener ? `starts by ${opener}, then ` : ''}gives their half-one score, says you are the one ` +
        'describing now, and delivers that cleared clue. One breath, all of it — do not announce the ' +
        'handover and then stop, or they are left waiting on a card with nothing to go on. Half two’s ' +
        'clock starts when the clue clears, so take the time you need on it',
    ),
  }
}

export function registerTools(game: Game) {
  // ------------------------------------------------------------------ setup

  registerTool({
    name: 'password_new_game',
    description:
      'Start a round of Password. Two timed halves that swap roles: in half one the HUMAN describes ' +
      'words shown on their screen and YOU guess them; in half two the page gives YOU the words and the ' +
      'human guesses. Saying a banned word costs a point either way. ' +
      `Each half is ${CARDS_PER_HALF} cards and ${HALF_SECONDS} seconds. ` +
      'IMPORTANT: the clock starts the moment this returns, because the first card flips up on their ' +
      'screen immediately. Only call it when the human has actually asked to play, and start talking ' +
      'straight away — do not spend a turn asking whether they are ready.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
    execute: async () => {
      const state = game.newGame()
      return reply(state, {
        message: 'Half one. Their card is up and the clock is running.',
        next_action:
          'Say ONE short line that starts the half: tell them to describe the word on the card without ' +
          'saying any of the red words, for example "Card one — go!". Then END YOUR TURN and listen. ' +
          'When they have described it, call password_guess_word with their exact words and your guess.',
      })
    },
  })

  registerTool({
    name: 'password_read_state',
    description:
      'Read the scoreboard without affecting play: which half is running, the clock, both scores, and ' +
      'which card you are on. Use it if you have lost track of whose turn it is to describe. ' +
      'In half one it does NOT reveal the word — the page keeps that from you on purpose. In half two ' +
      'it repeats the word and banned list the page dealt you.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => {
      const state = game.getState()
      if (state.phase === 'idle') {
        return reply(state, {
          message: 'No round running.',
          next_action: 'Call password_new_game when the human asks to play.',
        })
      }
      if (state.phase === 'intermission' || state.phase === 'over') {
        return reply(state, halfTail(state))
      }
      // The secret is only ever echoed back in half two, where it is the
      // agent's own word to begin with.
      return reply(state, {
        ...handover(state),
        ...(state.phase === 'half1'
          ? {
              word_is_hidden_from_you:
                'The page will not tell you the word in half one. That is the game — listen to them.',
              next_action: LISTEN_AGAIN,
            }
          : {
              next_action: clueThenSpeak(
                'carries that clue. Reading the state is not a turn — they have heard nothing from you',
              ),
            }),
      })
    },
  })

  // ------------------------------------------------- half one: they clue

  registerTool({
    name: 'password_guess_word',
    description:
      'HALF ONE ONLY. Report what the human just said, word for word, together with your best guess at ' +
      'the hidden word. The page checks their words against the banned list and then judges your guess, ' +
      'so this one call does both jobs. ' +
      '`heard` MUST be their actual speech since your last call and nothing else — not a summary, not a ' +
      'paraphrase, and never words you imagined. Reporting speech they did not say is the worst thing you ' +
      'can do here: it invents fouls against them and it plays their side of the game for them. ' +
      'If they have not spoken since your last call, do not call this at all. ' +
      'If what they said was a request to give up — "skip", "pass", "I give up", "next card" — that is ' +
      'not a clue and does not belong here: call password_skip_card instead. ' +
      'A wrong guess costs nothing but time, so guess as soon as you have a real candidate. ' +
      'Call this, then say the outcome out loud — the result tells you whether you were right.',
    inputSchema: {
      type: 'object',
      properties: {
        heard: {
          type: 'string',
          description:
            'The human’s exact words since your last call. Verbatim. Include everything they said, ' +
            'including any word you suspect is banned — the page decides, not you.',
        },
        guess: {
          type: 'string',
          // Never a word that is in the deck. An example the model can mistake
          // for the answer is one it will sometimes just send — see the note on
          // `heard` in password_report_guess, where that cost a real point.
          description:
            'Your single best guess at the word. One word or short phrase, e.g. "harpoon" — that is ' +
            'a formatting example, not a hint, so never send it as your actual guess.',
        },
      },
      required: ['heard', 'guess'],
    },
    execute: async ({ heard, guess }: { heard?: string; guess?: string }) => {
      if (!heard || !String(heard).trim()) {
        return toolError(
          'heard is required — the human’s exact words since your last call. If they have not said ' +
            'anything yet, do not call this tool; end your turn and listen instead.',
          game.getState().phase,
        )
      }
      if (!guess || !String(guess).trim()) {
        return toolError(
          'guess is required. Send your best candidate even if you are unsure — a wrong guess is free.',
          game.getState().phase,
        )
      }

      const out = game.submitClue(String(heard), String(guess))
      if (!out.ok) return explain(out.error!, out.state)

      if (out.violation) {
        // Part of the secret itself ("scare" on SCARECROW) is a foul too. The
        // card is dead, so naming the word now gives nothing away — and without
        // it "you said SCARECROW" is a word nobody said.
        const said = out.said ?? out.violation
        const own = out.violation === out.state.struck?.secret
        const call = own
          ? `"${said}" is part of the word, which was ${out.violation}`
          : `they said the banned word "${out.violation}"`
        return reply(out.state, {
          result: 'foul',
          banned_word_they_said: out.violation,
          ...(own ? { they_said: said } : {}),
          ...cardTail(
            own
              ? `They said "${said}", which is part of the word itself — it was ${out.violation}. ` +
                  'That card is burned and they lose a point.'
              : `They said "${out.violation}". That card is burned and they lose a point.`,
            `Say ONE short line out loud calling the foul and naming the word — something like "ah, ` +
              (own
                ? `${said} is part of the word — it was ${out.violation}. Next card". `
                : `you said ${out.violation} — next card". `) +
              `The page is striking "${out.violation}" off the dead card as you speak and the next one ` +
              'flips up behind it, so name it rather than just saying they slipped. Then END YOUR TURN ' +
              'and listen.',
            Boolean(out.halfEnded),
            out.state,
            `calling the foul: ${call}`,
          ),
        })
      }

      if (out.correct) {
        const word = out.state.solved ?? String(guess)
        return reply(out.state, {
          result: 'correct',
          word_you_got: word,
          ...cardTail(
            out.halfEnded
              ? `You got it — it was ${word}.`
              : `You got it — it was ${word}. A new card is already up on their screen.`,
            'Say the word out loud so they know you have it, in one short excited line, and tell them ' +
              'the next card is up. Then END YOUR TURN and listen.',
            Boolean(out.halfEnded),
            out.state,
            `saying "${word}" out loud, excited that you got it`,
          ),
        })
      }

      return reply(out.state, {
        result: 'wrong',
        message: 'Not it. Same card, clock still running.',
        next_action: LISTEN_AGAIN,
      })
    },
  })

  // -------------------------------------------------- half two: you clue

  registerTool({
    name: 'password_draw_card',
    description:
      'HALF TWO fallback — you should never need this. The page deals you each word automatically: the ' +
      'result that ends half one carries your first one, and the result that closes each card carries ' +
      'the next. Both put it in `your_word`. Call this only if you have genuinely lost track of the word ' +
      'you are describing. It re-reads the same card, costs nothing, and does not touch the clock.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => {
      const out = game.drawCard()
      if (!out.ok) return explain(out.error!, out.state)
      return reply(out.state, {
        ...handover(out.state),
        // Deliberately not phrased as a sentence about the card. This used to
        // read `Describe "LIGHTHOUSE" without saying it and without saying any
        // of: beam, coast, …` — a fluent, speakable line with the answer and
        // every banned word already in it, sitting in a payload the model is
        // about to talk from. Naming no words at all removes the temptation;
        // they are already above in your_word / banned_words, under the
        // never_say_aloud warning.
        rules:
          'Describe the word in your_word out loud without speaking it, and without speaking any ' +
          'entry in banned_words. Word forms count: a ban on a noun also bans its plural and its ' +
          'adjective. Say nothing that has not come back cleared from password_say_clue.',
        next_action:
          'Clear a clue for this word with password_say_clue in this same turn. Do NOT speak first — ' +
          'a turn that ends without a clue leaves them staring at blanks.',
      })
    },
  })

  registerTool({
    name: 'password_say_clue',
    description:
      'HALF TWO ONLY. Clear a clue before you speak it. Send the exact sentence you intend to say. ' +
      'If it is clean the tool returns ok and you say it word for word. If it contains the word or any ' +
      'banned form, the clue is BLOCKED — you have not said it, the human heard nothing, and you must ' +
      'write a different one. ' +
      `You get ${MAX_CLUE_REJECTS} blocked clues per card; the next one burns the card and costs a point. ` +
      'Never speak a clue you have not cleared here, and never read the banned words out loud to explain ' +
      'why you are struggling.',
    inputSchema: {
      type: 'object',
      properties: {
        clue: {
          type: 'string',
          description:
            'The exact sentence you want to say out loud, in full. Not a summary of it — the words ' +
            'themselves, because those are what get checked.',
        },
      },
      required: ['clue'],
    },
    execute: async ({ clue }: { clue?: string }) => {
      if (!clue || !String(clue).trim()) {
        return toolError(
          'clue is required — the exact sentence you want to say out loud.',
          game.getState().phase,
        )
      }

      const out = game.vetClue(String(clue))
      if (!out.ok) return explain(out.error!, out.state)

      if (out.cardBurned) {
        return reply(out.state, {
          result: 'fouled_out',
          banned_word: out.violation,
          ...handover(out.state),
          ...cardTail(
            `"${out.violation}" again. You are out of attempts on that card — it is burned and costs ` +
              `you a point.${nextWordNote(out.state)}`,
            clueThenSpeak(
              'concedes the dead card in a few words without naming it, and delivers the new clue',
            ),
            Boolean(out.halfEnded),
            out.state,
            'conceding the dead card in a few words',
          ),
        })
      }

      if (out.violation) {
        return reply(out.state, {
          result: 'blocked',
          banned_word: out.violation,
          clue_attempts_left: out.rejectsLeft,
          message:
            `BLOCKED on "${out.violation}". You have NOT said this out loud and the human heard nothing. ` +
            'Do not apologise to them and do not mention the block.',
          next_action:
            `Write a completely different clue that avoids "${out.violation}" and every other banned form, ` +
            'and clear that one instead. Come at the word from another angle — who uses it, where you find ' +
            'it, what it feels like, what happens without it.',
        })
      }

      return reply(out.state, {
        result: 'cleared',
        approved_clue: String(clue).trim(),
        next_action: CLUE_AGAIN,
      })
    },
  })

  registerTool({
    name: 'password_report_guess',
    description:
      'HALF TWO ONLY. Report what the human just guessed, word for word. The page holds the word and ' +
      'decides whether they got it — you do not, and you cannot award the point yourself. ' +
      'Report every guess they make, even ones you are sure are wrong. Never report a guess they did ' +
      'not actually say. ' +
      'If they gave up instead of guessing — "skip", "pass", "I give up", "I don\'t know", "just tell ' +
      'me" — that is not a guess: call password_skip_card, which reveals the word for them.',
    inputSchema: {
      type: 'object',
      properties: {
        heard: {
          type: 'string',
          // This example used to read "is it a lighthouse" — and LIGHTHOUSE is a
          // card in the deck. Playing that card, the agent reported the human as
          // having guessed "lighthouse" when they had said nothing, and the page
          // dutifully awarded the point: it can referee whether a guess is right,
          // but it has no way to know whether it was ever spoken. The example is
          // now a word the deck does not contain, and `tools carry no deck words`
          // in the test suite keeps it that way as the deck grows.
          description:
            'The human’s exact guess, verbatim — if they said "uh, is it a harpoon", send exactly ' +
            'that. The example is a format, not a value: never send it as their guess. If they have ' +
            'not spoken a guess since your last call, do not call this tool at all.',
        },
      },
      required: ['heard'],
    },
    execute: async ({ heard }: { heard?: string }) => {
      if (!heard || !String(heard).trim()) {
        return toolError(
          'heard is required — what the human actually guessed. If they have not guessed yet, keep ' +
            'clueing instead of calling this.',
          game.getState().phase,
        )
      }

      const out = game.reportGuess(String(heard))
      if (!out.ok) return explain(out.error!, out.state)

      if (out.correct) {
        return reply(out.state, {
          result: 'correct',
          ...handover(out.state),
          ...cardTail(
            `They got it. Point to you.${nextWordNote(out.state)}`,
            clueThenSpeak('confirms they got that one, and delivers the clue for the next'),
            Boolean(out.halfEnded),
            out.state,
            'telling them they got that last one',
          ),
        })
      }

      return reply(out.state, {
        result: 'wrong',
        message: 'Not the word. Same card, clock still running.',
        next_action:
          'Do NOT speak yet. Clear a NEW clue with password_say_clue that comes at the word from a ' +
          'different angle, then say ONE short line: no, plus that new clue. Telling them no on its own ' +
          'ends your turn and stalls the card — the "no" and the next clue are one breath. Do not repeat ' +
          'the clue they already failed on.',
      })
    },
  })

  // ----------------------------------------------------------------- shared

  registerTool({
    name: 'password_skip_card',
    description:
      'Give up on the current card, reveal the word, and move to the next one. Free in points, but it ' +
      'costs you the clock, so skip early rather than after a long struggle. Works in either half. ' +
      'CALL THIS THE MOMENT THE HUMAN ASKS TO GIVE UP, in either half and whatever words they use — ' +
      '"skip", "pass", "I give up", "I don\'t know", "tell me", "what was it", "next card", "move on". ' +
      'That is a request, not a guess: do not put it through password_guess_word or ' +
      'password_report_guess, and do not keep clueing at someone who has asked you to stop. ' +
      'In half two you may also call it on your own when you cannot find a legal angle on the word. ' +
      'The result carries the answer in `revealed_word`, and the page shows it on the card.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
    execute: async () => {
      const out = game.skipCard()
      if (!out.ok) return explain(out.error!, out.state)
      const word = out.skipped!
      return reply(out.state, {
        result: 'skipped',
        revealed_word: word,
        ...handover(out.state),
        ...cardTail(
          `Card binned, no points lost. The word was "${word}" and the page has just shown it.`,
          out.state.phase === 'half1'
            ? // Half one: they were the ones describing, so they knew the word all
              // along. Saying it back is the acknowledgement, not a reveal.
              `Say ONE short line: "${word}" was the word, and you are moving on — something like ` +
                `"no worries, that was ${word} — next card". Then END YOUR TURN and listen.`
            : // Half two: they have spent the card looking at blanks. The page fills
              // them in as this returns, so the word gets said out loud alongside it
              // rather than left on screen unremarked.
              clueThenSpeak(
                `tells them the word was "${word}", and delivers the clue for the next one`,
              ),
          Boolean(out.halfEnded),
          out.state,
          `saying the word was "${word}"`,
        ),
      })
    },
  })
}
