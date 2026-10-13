/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// MCP tool layer. Tools go into the local registry in `webmcp.ts`, which
// publishes them to `document.modelContext` when a host provides one.
//
// The hard part of this example is not shaking a ball, it is stopping the
// assistant from answering the question itself. A model asked "will it rain
// tomorrow?" wants to be helpful, and left to itself it will invent a verdict
// that has nothing to do with the die the human is watching tumble.
//
// The load-bearing decision is that `magic_ball_ask` returns the answer
// itself, in one call. It is deliberately not split into a shake tool and a
// fetch tool: two calls means a turn boundary between them, and a turn boundary
// is somewhere the model can start talking with nothing in hand. One call gives
// it no such moment — the first thing it can say, it can only say with the real
// answer already in front of it.
//
// It used to get that answer by blocking for the two seconds the die took to
// land, which made the assistant feel slow. It no longer needs to: `Ball.ask()`
// runs the whole tumble up front on a copy of the body (~0.1ms) and the page
// replays that exact trajectory. So the answer is real — decided by where the
// die lands, not by the model — and available immediately.
//
// Backing that up:
//   - The reading comes out of `planTumble()`, so the die on screen is going to
//     show precisely the string handed to the model. It is a look-ahead, not a
//     rigged outcome.
//   - Every result repeats `your_role`, because the freshest tool output is
//     what the model steers on and a description read once will not hold.
//
// All of the above describes the `die` mode, which is not what ships. The build
// runs in `ai` mode (see `mode.ts`): the model writes the verdict and the die is
// made to carry its words. Both variants of `magic_ball_ask` live here and
// exactly one is registered, chosen at build time, so the model can never see a
// description that contradicts what the page will do — and the page can never
// drift back to the other kind of ball mid-session.
//
// Tool order matters: a smoke test that calls the first registered tool with
// no arguments must hit a read-only one, so that one goes first.
import { registerTool } from './webmcp'
import type { Ball, BallState, Tone } from './ball'
import { MODE, type BallMode } from './mode'

const DIE_ROLE =
  'The BALL answers, not you. You are its hands and its voice: you shake it, you wait, and you ' +
  'read out whatever surfaces. You do not know the answer before the die stops moving, and neither ' +
  'does this page — it is a physics simulation, not an oracle you can query early. ' +
  'Never predict, guess, paraphrase, soften or explain away the answer, and never substitute your ' +
  'own opinion about the question. If the human wants your real view they will ask for it separately.'

const AI_ROLE =
  'YOU are the oracle. You decide what the ball says, and the die is made to land showing your ' +
  'words, so the `answer` you pass is exactly what the human reads through the glass. ' +
  'ANY question is valid. This ball is not limited to yes-or-no questions and you must never ' +
  'refuse one for not being yes-or-no, never ask the human to rephrase, and never offer to turn ' +
  'their question into a yes-or-no one. A "how much" question gets a quantity, a "when" question ' +
  'gets a time, a "what" question gets a thing. ' +
  'EVERYTHING goes through the ball. You have no voice apart from it: every reply you make is a ' +
  'shake and a verdict, with no exceptions. Call magic_ball_ask BEFORE you say anything, ' +
  'every time — you are not finished with a message until it has returned an answer and you have ' +
  'said that answer out loud. Follow-ups count — they will stop saying "ask the ' +
  'ball" after the first question and everything after it is still for the ball. A question ' +
  'pointed straight at you ("do you think...?") counts, and so does being asked to drop the act; ' +
  'answer both through the glass. If what they said is not a question at all, shake anyway and let ' +
  'the ball reply to it. Never answer as an assistant instead of shaking. ' +
  "Give your real read — if you think it is a yes, say a yes — but say it in the ball's voice: a " +
  'terse verdict, never advice, never a sentence, never a reason. You are a fortune-telling toy, ' +
  'not an assistant with an opinion to explain.'

const READ_VERBATIM =
  'This is what the die is showing the human through the glass. Say the `answer` field out loud ' +
  'word for word, right now, then stop. Do not add a verdict, a probability, a caveat, or an ' +
  'interpretation of what it means, and do not replace it with wording of your own. ' +
  'If you announced the shake before calling this, that did not count: the human has heard nothing ' +
  'until you say the answer.'

/**
 * Longest answer the die can carry. A 25-character answer already wraps to
 * three lines inside a face; past about this the renderer clips it against the
 * triangle.
 */
const MAX_ANSWER_CHARS = 30

const TONES = ['affirmative', 'noncommittal', 'negative'] as const satisfies readonly Tone[]

function reply(payload: Record<string, unknown>) {
  return JSON.stringify({ ok: true, ...payload })
}

function shakenPayload(reading: { question: string | null; answer: string; tone: Tone }) {
  return {
    status: 'shaking',
    question: reading.question,
    answer: reading.answer,
    tone: reading.tone,
  }
}

function settledPayload(state: BallState) {
  return {
    status: 'settled',
    question: state.question,
    answer: state.answer,
    tone: state.tone,
    readings_so_far: state.history.length,
  }
}

/**
 * Ring buffer of every tool invocation and how it ended.
 *
 * A rejected call is invisible from the page: the ball does not move and
 * nothing reaches the screen, so "the agent said an error occurred" is all you
 * get, with no way to tell a malformed call from a tool that never fired. On a
 * headset that is a long round trip to find out. Exposed as
 * `window.MagicBall.log`; read it over CDP after a failed attempt.
 */
export interface CallRecord {
  tool: string
  args: unknown
  ok: boolean
  detail: string
}

const CALL_LOG_LIMIT = 25
export const callLog: CallRecord[] = []

function record(tool: string, args: unknown, ok: boolean, detail: string) {
  callLog.push({ tool, args, ok, detail })
  if (callLog.length > CALL_LOG_LIMIT) callLog.shift()
}

export function registerTools(ball: Ball, mode: BallMode = MODE): void {
  const role = mode === 'ai' ? AI_ROLE : DIE_ROLE

  function toolError(reason: string) {
    return { content: [{ type: 'text' as const, text: `${reason}\n\n${role}` }], isError: true }
  }

  registerTool({
    name: 'magic_ball_read_answer',
    description:
      'Re-read the answer already showing in the ball’s window, without shaking it again. ' +
      'You do NOT need this after magic_ball_ask — that call returns the answer itself. ' +
      'Use this only when the human shook the ball by hand (clicking it shakes it too) and you need ' +
      'to see what came up, or when you want to check what is on screen right now. If a shake is in ' +
      'progress it waits for the die to stop. ' +
      'Calling it before anything has been asked reports an empty window, not an answer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      if (ball.getState().status === 'idle') {
        return reply({
          status: 'idle',
          answer: null,
          your_role: role,
          message: 'The window is empty. Nothing has been asked yet.',
          next_action: `Ask the human what they want to know, then pass it to magic_ball_ask${
            mode === 'ai' ? ' along with the verdict you decide on.' : '.'
          }`,
        })
      }

      // whenSettled only ever resolves idle or settled — it forces a settle
      // rather than handing back a null answer.
      const state = await ball.whenSettled()
      return reply({
        ...settledPayload(state),
        your_role: role,
        next_action: READ_VERBATIM,
      })
    },
  })

  // ─── The two `ask` variants ────────────────────────────────────────
  // Same name, different contract. Only one is registered at a time, so the
  // model never sees a description that contradicts what the page will do.
  const registerDieAsk = () =>
    registerTool({
      name: 'magic_ball_ask',
      description:
        'Put a yes-or-no question to the Magic Ball. This shakes the ball and returns the answer ' +
        'the 20-sided die is going to land on. One call does the whole thing; there is no second ' +
        'tool to fetch the result with, and nothing to wait for. ' +
        'Use it whenever the human asks the ball something, asks you to shake it, or says "ask ' +
        'again" — for "ask again", pass the same question again. ' +
        'The `answer` it returns is the real one, physically decided by where the die lands. Say it ' +
        'straight away and word for word: the die is still tumbling on screen as you speak, and it ' +
        'will come to rest showing exactly this. You could not have known it before this call ' +
        'returned, so never pre-empt it, and never keep an answer of your own alongside it. ' +
        'The ball only answers yes-or-no questions. If the human asks something open-ended ("what ' +
        'should I have for lunch?"), say so and offer to rephrase it as a yes-or-no question rather ' +
        'than shaking on it.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The human’s yes-or-no question, in their words, e.g. "Will I get the job?". ' +
              'It is shown on screen under the ball. Do not invent one they did not ask.',
          },
        },
        required: ['question'],
      },
      execute: async ({ question }: { question?: string }) => {
        if (!question || !String(question).trim()) {
          return toolError(
            'question is required — the yes-or-no question the human actually asked. ' +
              'If they only said "shake it", ask them what they want to know first.',
          )
        }

        // Returns in microseconds with the real reading: the tumble has already
        // been simulated, the page is only playing it back now.
        const reading = ball.ask(String(question))

        return reply({
          ...shakenPayload(reading),
          your_role: DIE_ROLE,
          message: 'Shaken. The die is on its way to this answer.',
          next_action: READ_VERBATIM,
        })
      },
    })

  const registerAiAsk = () =>
    registerTool({
      name: 'magic_ball_ask',
      description:
        'Put ANY question to the Magic Ball and decide what it answers. YOU are the oracle: pass ' +
        'the verdict as `answer` and the die is made to land showing exactly those words. One call ' +
        'does the whole thing and there is nothing to wait for. ' +
        'The question does NOT have to be yes-or-no. Never refuse a question for not being ' +
        'yes-or-no, never reply "that is not a yes-or-no question", never ask the human to rephrase ' +
        'it, and never offer to turn it into a yes-or-no question. Just answer it. ' +
        'CALL THIS BEFORE YOU SAY ANYTHING. You may not reply to the human until this call has ' +
        'returned — it is the first thing you do with every message they send, not something you ' +
        'do after answering. You are finished with a message only once this has returned an ' +
        '`answer` AND you have said that answer out loud; a turn where you only talk leaves the ' +
        'human watching a ball that never moved. ' +
        'EVERY reply you make goes through this call — there is no exception and no other kind of ' +
        'turn. Follow-ups included: they will stop saying "ask the ball" after the first question ' +
        'and everything after it is still for the ball. A question aimed straight at you ("do you ' +
        'think my wife will like it?") is one for the ball, and so is "seriously, what do you ' +
        'actually think?" and "stop being the ball for a second" — shake on those too. If they say ' +
        'something that is not a question at all, shake anyway and let the ball reply to it. ' +
        '"How much will GPU prices go down this year?" -> "Not much". ' +
        '"What should I have for lunch?" -> "Something fried". ' +
        '"When will the build be green?" -> "Not today". ' +
        '"Will the demo work?" -> "Good luck". ' +
        'Give your genuine read. If you think the answer is yes, say a yes; if you think it is no, ' +
        'say a no. Do not retreat into "Too murky to tell" to dodge committing — save that for ' +
        'when you honestly cannot say. ' +
        'Say it the way a Magic Ball would: about four words at most, a verdict and nothing else. ' +
        'Reach for one of the twenty stock replies when one genuinely fits ("Absolutely", ' +
        '"Doubt it", "Try again tomorrow"), and coin your own when none does. ' +
        'After it returns, say those same words out loud and stop. Never explain the answer, never ' +
        'justify it, and never follow it with a sentence of real advice — if the human wants that, ' +
        'they can ask you outside the ball.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The human’s question, in their words, whatever form it takes — yes-or-no, "how ' +
              'much", "when", "what", anything. If what they said was not a question, pass what ' +
              'they said. It is shown on screen under the ball. ' +
              'Do not invent one they did not ask and do not reword theirs.',
          },
          answer: {
            type: 'string',
            description:
              'What YOU have decided the ball says: about four words at most and no more than ' +
              `${MAX_ANSWER_CHARS} characters, because it is painted onto a face of the die and has ` +
              'to fit. A verdict, not a sentence — "Not much", "Good luck", "Count on it", ' +
              '"Not this year". No trailing full stop, no explanation.',
          },
          tone: {
            type: 'string',
            enum: ['affirmative', 'noncommittal', 'negative'],
            description:
              'How the answer lands, which colours the on-screen readout green, yellow or red. ' +
              'Optional — one of the twenty stock replies is recognised automatically.',
          },
        },
        required: ['question', 'answer'],
      },
      execute: async ({
        question,
        answer,
        tone,
      }: {
        question?: string
        answer?: string
        tone?: string
      }) => {
        const args = { question, answer, tone }
        if (!question || !String(question).trim()) {
          record('magic_ball_ask', args, false, 'missing question')
          return toolError(
            'question is required — the question the human actually asked. ' +
              'If they only said "shake it", ask them what they want to know first.',
          )
        }

        const verdict = String(answer ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.!]+$/, '')
        if (!verdict) {
          record('magic_ball_ask', args, false, 'missing answer')
          return toolError(
            'answer is required in this mode — YOU decide what the ball says. Give a short ' +
              'verdict of about four words, such as "Not much" or "All signs say yes".',
          )
        }
        if (verdict.length > MAX_ANSWER_CHARS) {
          record('magic_ball_ask', args, false, `answer ${verdict.length} chars`)
          return toolError(
            `answer is ${verdict.length} characters and will not fit on a face of the die. ` +
              `Cut it to ${MAX_ANSWER_CHARS} or fewer — a verdict, not a sentence. ` +
              'Something like "Not much" or "I would not".',
          )
        }
        record('magic_ball_ask', args, true, verdict)

        const reading = ball.ask(String(question), {
          answer: verdict,
          tone: TONES.find((t) => t === tone),
        })

        return reply({
          ...shakenPayload(reading),
          your_role: AI_ROLE,
          message: 'Shaken. The die is on its way to the answer you chose.',
          next_action: READ_VERBATIM,
        })
      },
    })

  if (mode === 'ai') registerAiAsk()
  else registerDieAsk()

  registerTool({
    name: 'magic_ball_history',
    description:
      'List the questions asked of the ball this session and what it answered, oldest first. Use it ' +
      'when the human asks what they already asked or what it said before. It does not shake the ' +
      'ball and does not spend anything.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => {
      const state = ball.getState()
      if (state.history.length === 0) {
        return reply({
          readings: [],
          your_role: role,
          message: 'The ball has not answered anything yet this session.',
        })
      }
      return reply({
        readings: state.history.map((r, i) => ({
          n: i + 1,
          question: r.question ?? '(shaken without a question)',
          answer: r.answer,
          tone: r.tone,
        })),
        your_role: role,
        next_action:
          'Summarise briefly if they asked for a recap. Quote the answers exactly; do not reword them.',
      })
    },
  })
}
