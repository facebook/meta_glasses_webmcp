/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// MCP tool layer — turns the shared Game API into agent-callable tools. They
// go into the local registry in `webmcp.ts`, which publishes them to
// `document.modelContext` when a host provides one and otherwise just holds
// them.
//
// This file is where the example earns its keep. The game itself is trivial;
// making a small voice model play it *the right way round* is not. Every string
// below is a fix for a failure seen against a live model:
//
//   1. The agent decides IT holds the secret and makes the human guess.
//      → every result restates `your_role`.
//   2. The agent invents the human's answers and races through all twenty
//      alone. → every non-terminal result ends the turn with `next_action`.
//   3. The agent enumerates ("kitchen? bedroom? bathroom?") instead of halving
//      the field. → `strategy` coaches from the transcript the page already has.
//
// Descriptions are weak, tool results are strong: the freshest tool output is
// what the model actually steers on.
import { registerTool } from './webmcp'
import { MAX_QUESTIONS, normalizeAnswer, strategyNote } from './engine'
import { transcript, type Game, type GameState } from './game'

const ROLE =
  'YOU are the guesser. The HUMAN is thinking of a secret and only they know it. ' +
  'You ask THEM yes/no questions out loud; they answer out loud; you record each exchange here. ' +
  'This page is only a scoreboard — it does NOT know the secret and cannot answer anything. ' +
  'Never ask the page for an answer, never make the human do the guessing, and never invent what they said.'

// Yielding the floor is the whole job of a non-terminal result. Address the
// agent in the second person with a verb it can execute — a message that reads
// as something to relay ("Ask yes/no questions.") gets repeated to the user
// verbatim, and then the human is told to ask the questions.
const ASK_NEXT =
  'STOP CALLING TOOLS. Say your NEXT yes/no question out loud to the human, then END YOUR TURN and wait for ' +
  'them to answer it. Record their answer at the start of your next turn. Never assume or invent their answer.'

const OPENING_PLAN =
  'Aim to halve the possibilities with every question, so twenty questions can separate about a million ' +
  'things. A strong opening ladder: 1) Is it a physical object? 2) Is it alive? 3) Is it man-made? ' +
  '4) Could you hold it in one hand? 5) Is it found mostly indoors? 6) Does it need power? ' +
  '7) Do you use it to do a job? 8) Is it mostly metal? Only after those narrow the field should you ' +
  'ask about specific rooms or name specific objects. Never walk through rooms or categories one at a time.'

function toolError(reason: string, withRole = false) {
  const body = withRole ? `${reason}\n\n${ROLE}` : reason
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

/** Serialise a result, folding in the coaching the transcript supports. */
function reply(state: GameState, extra: Record<string, unknown>, coach = false) {
  const note = coach ? strategyNote(state.asked) : null
  return JSON.stringify({ ok: true, ...extra, ...(note ? { strategy: note } : {}) })
}

export function registerTools(game: Game) {
  registerTool({
    name: 'twenty_questions_start_game',
    description:
      'Begin a round of 20 Questions in which the HUMAN thinks of a secret and YOU, the assistant, guess it ' +
      'by asking them yes/no questions. This resets the scoreboard to 20. ' +
      "ONLY call this when the human has actually asked to play — a greeting like 'hello' is not a request " +
      'for a game, so just greet them back. ' +
      'IMPORTANT: this page does NOT hold a secret and cannot answer questions. It only counts your questions ' +
      'and keeps the transcript. The secret lives in the human’s head. You must ask THEM, out loud, and ' +
      'wait for them to speak each answer. ' +
      'Pacing: ask one question per conversational turn, then stop and wait. ' +
      'Start fast — "let’s play" is enough to begin. Call this and then prompt them AND ask your first ' +
      'question in the same spoken turn. Never burn a turn on "tell me when you’re ready". ' +
      'If a game is already running this changes nothing and returns it; pass restart=true only when ' +
      'the human explicitly asks to start over.',
    inputSchema: {
      type: 'object',
      properties: {
        restart: {
          type: 'boolean',
          description:
            'true only when the human explicitly asks to start over. Without it a game already ' +
            'running is left alone and returned.',
        },
      },
    },
    annotations: { destructiveHint: true },
    execute: async ({ restart }: { restart?: boolean } = {}) => {
      // The assistant hands each turn to a sub-agent with no memory of the game, and it reaches
      // for this tool first; resetting on every turn threw away the answers so far.
      const current = game.getState()
      if (!restart && (current.status === 'playing' || current.status === 'out_of_questions')) {
        return reply(
          current,
          {
            status: current.status,
            already_running: 'A game is already running, so nothing was reset.',
            questions_used: current.used,
            questions_left: game.questionsLeft(),
            history: transcript(current),
            your_role: ROLE,
            next_action:
              'If this request carries the human’s answer to your last question, record it now with ' +
              `twenty_questions_record_answer. Then ${ASK_NEXT}`,
          },
          true,
        )
      }
      const state = game.startGame()
      return reply(state, {
        your_role: ROLE,
        questions_left: MAX_QUESTIONS,
        strategy: OPENING_PLAN,
        message: 'Scoreboard reset. 20 questions.',
        next_action:
          'Say ONE short spoken turn that does BOTH of these together: tell them to lock in any person, ' +
          'place or thing, AND immediately ask your first yes/no question. For example: "Lock something in ' +
          '— is it a physical object?" Do NOT spend a turn asking whether they are ready and do NOT wait ' +
          'for them to confirm; they will pick while you are talking, and their reply to your first ' +
          'question is the confirmation. Then end your turn and wait for that answer.',
      })
    },
  })

  registerTool({
    name: 'twenty_questions_record_answer',
    description:
      'Log one question you asked the human out loud together with the answer THEY gave, and tick the counter ' +
      'down. Call this at the START of your turn, right after they have answered — it records the question ' +
      'from your previous turn, not the one you are about to ask. ' +
      'NEVER call this with an answer you made up, assumed, or predicted. If the human has not actually spoken ' +
      'an answer yet, do not call it at all. Recording invented answers plays the game without them and is the ' +
      'single worst thing you can do here. ' +
      'Call it at most once per conversational turn. After it returns, ask your next question out loud and end ' +
      'your turn. ' +
      "ALWAYS pass `summary`: a two-or-three-word phrase naming what you learned, such as 'not alive', " +
      "'man-made', 'handheld' or 'no electricity'. The orb displays it, so it must read as a fact you now " +
      'know rather than as the word yes or no.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The exact yes/no question you asked the human out loud.',
        },
        answer: {
          type: 'string',
          enum: ['yes', 'no', 'maybe'],
          description: 'What the HUMAN actually said, normalised to yes, no, or maybe.',
        },
        summary: {
          type: 'string',
          description:
            'A two-or-three-word phrase stating what you now KNOW, which the orb displays. ' +
            "Write the fact, not the reply: 'is it alive?' + no becomes 'not alive'; " +
            "'is it man-made?' + yes becomes 'man-made'; 'does it need electricity?' + no becomes " +
            "'no electricity'; 'could you hold it in one hand?' + yes becomes 'handheld'. " +
            'Keep it under about twenty characters and never repeat the whole question.',
        },
      },
      required: ['question', 'answer'],
    },
    execute: async ({
      question,
      answer,
      summary,
    }: {
      question?: string
      answer?: string
      summary?: string
    }) => {
      if (!question || !String(question).trim()) {
        return toolError('question is required — the exact yes/no question you asked the human.')
      }
      // Require a real value rather than coercing: if the agent must report
      // what the human said, make fabrication structurally hard.
      const norm = normalizeAnswer(answer)
      if (!norm) {
        return toolError(
          "answer must be what the HUMAN actually said, as 'yes', 'no', or 'maybe'. " +
            'If they said something else, ask them to answer yes or no and record it next turn. ' +
            'Do not guess on their behalf.',
          true,
        )
      }

      const outcome = game.recordAnswer(String(question), norm, summary)
      if (!outcome.ok) {
        return toolError(
          outcome.error === 'no_game'
            ? 'No game in progress. Call twenty_questions_start_game first.'
            : 'Game is over. Call twenty_questions_start_game for a new round.',
        )
      }

      // Observed live: the agent narrates "let me log that", then logs the same
      // question a second time in one turn, burning two questions for one
      // answer. Swallow the duplicate as ok:true — an error here makes it
      // apologise to the user about the scoreboard.
      if (outcome.duplicate) {
        return reply(outcome.state, {
          recorded: outcome.answer,
          already_recorded: true,
          questions_left: game.questionsLeft(),
          your_role: ROLE,
          turn_is_over: true,
          message: 'You already recorded that exact question. Nothing double-counted.',
          next_action: ASK_NEXT,
        })
      }

      if (outcome.outOfQuestions) {
        return reply(outcome.state, {
          recorded: outcome.answer,
          questions_left: 0,
          out_of_questions: true,
          message: 'That was question twenty. You are out of questions.',
          next_action:
            'Say your single final guess out loud. When the human tells you whether it was right, ' +
            'call twenty_questions_record_guess with that outcome.',
        })
      }

      return reply(
        outcome.state,
        {
          recorded: outcome.answer,
          questions_left: game.questionsLeft(),
          your_role: ROLE,
          turn_is_over: true,
          message: `Recorded. ${game.questionsLeft()} questions left.`,
          next_action: ASK_NEXT,
        },
        true,
      )
    },
  })

  registerTool({
    name: 'twenty_questions_record_guess',
    description:
      'Log a guess at the human’s secret and whether they confirmed it. Say the guess out loud first, ' +
      'wait for the human to tell you if it is right, and only then call this with correct set to what they ' +
      'said. Never set correct yourself — you cannot know. A wrong guess is free and does not use up a ' +
      'question, so guess whenever you have a real candidate. A correct guess ends the round.',
    inputSchema: {
      type: 'object',
      properties: {
        guess: { type: 'string', description: "The thing you guessed, e.g. 'a bicycle'." },
        correct: {
          type: 'boolean',
          description: 'Whether the HUMAN confirmed the guess was right.',
        },
      },
      required: ['guess', 'correct'],
    },
    execute: async ({ guess, correct }: { guess?: string; correct?: boolean }) => {
      if (!guess || !String(guess).trim()) return toolError('guess is required.')
      if (typeof correct !== 'boolean') {
        return toolError(
          'correct must be true or false — whether the HUMAN confirmed your guess. ' +
            'Only call this after they have told you. Never decide it yourself.',
          true,
        )
      }

      const outcome = game.recordGuess(String(guess), correct)
      if (!outcome.ok) {
        return toolError(
          outcome.error === 'no_game'
            ? 'No game in progress. Call twenty_questions_start_game first.'
            : 'Game is already over. Call twenty_questions_start_game for a new round.',
        )
      }

      // Terminal results omit the keep-going directive, or the agent loops
      // after winning.
      if (outcome.result === 'won') {
        return reply(outcome.state, {
          correct: true,
          result: 'won',
          questions_used: outcome.state.used,
          message: `Correct in ${outcome.state.used} questions.`,
          next_action:
            'Celebrate briefly in one line. Stop calling tools unless they want another round.',
        })
      }
      if (outcome.result === 'lost') {
        return reply(outcome.state, {
          correct: false,
          result: 'lost',
          questions_used: outcome.state.used,
          message: 'Wrong, and there are no questions left.',
          next_action:
            'Concede in one line and ask the human what it was. When they tell you, ' +
            'call twenty_questions_end_game with it.',
        })
      }

      return reply(
        outcome.state,
        {
          correct: false,
          questions_left: game.questionsLeft(),
          your_role: ROLE,
          turn_is_over: true,
          message: `Wrong. That guess was free — ${game.questionsLeft()} questions still left.`,
          next_action: ASK_NEXT,
        },
        true,
      )
    },
  })

  registerTool({
    name: 'twenty_questions_read_state',
    description:
      'Read the scoreboard without spending a question: status, questions used and left, and the full ' +
      'transcript of what you asked and what the human answered. Use it to avoid repeating yourself or to ' +
      're-read the constraints before guessing. It does NOT reveal the secret — the page never knows it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => {
      const state = game.getState()
      if (state.status === 'idle') {
        return reply(state, {
          status: 'no_game',
          your_role: ROLE,
          message: 'No game running.',
          next_action: 'Call twenty_questions_start_game when the human asks to play.',
        })
      }
      const playing = state.status === 'playing'
      return reply(
        state,
        {
          status: state.status,
          questions_used: state.used,
          questions_left: game.questionsLeft(),
          history: transcript(state),
          ...(state.secret ? { secret: state.secret } : {}),
          ...(playing
            ? {
                your_role: ROLE,
                next_action:
                  'Use this to avoid repeating a question. If you have already recorded an answer ' +
                  `this turn, ${ASK_NEXT}`,
              }
            : {}),
        },
        playing,
      )
    },
  })

  registerTool({
    name: 'twenty_questions_end_game',
    description:
      'End the round and record what the secret turned out to be, after the human tells you. Use this when ' +
      'you give up, when you run out of questions and guessed wrong, or when they want to stop early.',
    inputSchema: {
      type: 'object',
      properties: {
        secret: {
          type: 'string',
          description: 'What the human says their secret was, if they said.',
        },
      },
    },
    annotations: { destructiveHint: true },
    execute: async ({ secret }: { secret?: string }) => {
      if (game.getState().status === 'idle') return toolError('No game in progress.')
      const state = game.endGame(secret)
      return reply(state, {
        result: 'revealed',
        secret: state.secret,
        questions_used: state.used,
        message: state.secret ? `Noted — it was ${state.secret}.` : 'Round ended.',
        next_action:
          'Acknowledge it in one line. Stop calling tools unless they want another round.',
      })
    },
  })
}
