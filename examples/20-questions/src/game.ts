/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared game state API — the single source of truth for both the UI and the
// MCP tools. Mirrors the "one state API feeds UI + agent" pattern from the
// tictactoe / connect-four examples.
//
// The mechanics live here; the agent-facing contract (role reminders, next
// actions, strategy coaching) lives in mcp.ts. This layer never speaks to the
// agent and never knows the secret.
import {
  type Answer,
  type Exchange,
  MAX_QUESTIONS,
  answerCaption,
  questionKey,
} from './engine'

export type Status = 'idle' | 'playing' | 'out_of_questions' | 'won' | 'revealed'

/** What the orb should flash for the transition that produced this state. */
export interface OrbEvent {
  kind: Answer | 'gold'
  caption: string
}

/**
 * The question or guess the agent has just said out loud and the human has not
 * answered yet. The assistant handles each turn with a sub-agent that keeps no
 * memory between turns, so on the next turn a bare "yes" can only be tied to
 * its question by the page.
 */
export interface Pending {
  kind: 'question' | 'guess'
  text: string
}

export interface GameState {
  status: Status
  /** Questions spent. A guess is free and does not count. */
  used: number
  asked: Exchange[]
  /** Only ever set from what the human told the agent, never inferred. */
  secret: string | null
  lastEvent: OrbEvent | null
  pending: Pending | null
}

type Listener = (state: GameState) => void

export interface RecordOutcome {
  ok: boolean
  /** Present when the record was rejected, for the tool layer to relay. */
  error?: string
  answer?: Answer
  /** True when this question is already in the transcript. */
  duplicate?: boolean
  outOfQuestions?: boolean
  state: GameState
}

export interface GuessOutcome {
  ok: boolean
  error?: string
  correct?: boolean
  /** 'won' once confirmed, 'lost' when the last question is spent. */
  result?: 'won' | 'lost' | null
  state: GameState
}

export class Game {
  private state: GameState
  private listeners = new Set<Listener>()

  constructor() {
    this.state = this.freshState('idle')
  }

  private freshState(status: Status): GameState {
    return { status, used: 0, asked: [], secret: null, lastEvent: null, pending: null }
  }

  getState(): GameState {
    return this.state
  }

  questionsLeft(): number {
    return MAX_QUESTIONS - this.state.used
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private set(next: GameState) {
    this.state = next
    for (const fn of this.listeners) fn(next)
  }

  /** Reset the scoreboard to twenty. The secret stays in the human's head. */
  startGame(): GameState {
    this.set({ ...this.freshState('playing'), lastEvent: { kind: 'gold', caption: '20' } })
    return this.state
  }

  /**
   * Log one question the agent asked out loud and the answer the human gave.
   * Re-recording any question already asked is a no-op rather than an error —
   * see the note in mcp.ts about why that matters.
   */
  recordAnswer(question: string | undefined, answer: Answer, summary?: string): RecordOutcome {
    if (this.state.status === 'idle') {
      return { ok: false, error: 'no_game', state: this.state }
    }
    if (this.state.status !== 'playing') {
      return { ok: false, error: 'game_over', state: this.state }
    }
    const pending = this.state.pending?.kind === 'question' ? this.state.pending.text : ''
    question = String(question ?? '').trim() || pending
    if (!question) {
      return { ok: false, error: 'no_question', state: this.state }
    }

    // Any question already in the transcript is a no-op, not only the latest:
    // the assistant often re-sends the whole history of answers each turn.
    const key = questionKey(question)
    const prev = this.state.asked.find((q) => questionKey(q.question) === key)
    if (prev) {
      return { ok: true, answer: prev.answer, duplicate: true, state: this.state }
    }

    const used = this.state.used + 1
    const asked = [...this.state.asked, { n: used, question: question.trim(), answer }]
    const outOfQuestions = used >= MAX_QUESTIONS
    this.set({
      ...this.state,
      used,
      asked,
      status: outOfQuestions ? 'out_of_questions' : 'playing',
      lastEvent: { kind: answer, caption: answerCaption(question, answer, summary) },
      pending: null,
    })
    return { ok: true, answer, outOfQuestions, state: this.state }
  }

  /**
   * Log a guess and whether the human confirmed it. A wrong guess is free: it
   * appears in the transcript but does not spend a question.
   */
  recordGuess(guess: string | undefined, correct: boolean): GuessOutcome {
    if (this.state.status === 'idle') {
      return { ok: false, error: 'no_game', state: this.state }
    }
    if (this.state.status === 'won' || this.state.status === 'revealed') {
      return { ok: false, error: 'game_over', state: this.state }
    }

    const pending = this.state.pending?.kind === 'guess' ? this.state.pending.text : ''
    const trimmed = String(guess ?? '').trim() || pending
    if (!trimmed) {
      return { ok: false, error: 'no_guess', state: this.state }
    }
    // A replayed wrong guess is a no-op, like a replayed answer. Only wrong
    // guesses can be in the transcript while the game is still open.
    if (!correct && this.hasAsked({ kind: 'guess', text: trimmed })) {
      if (this.state.pending?.kind === 'guess') this.set({ ...this.state, pending: null })
      const lost = this.state.status === 'out_of_questions'
      return { ok: true, correct: false, result: lost ? 'lost' : null, state: this.state }
    }
    const caption = correct
      ? 'YES!'
      : answerCaption(`is it ${trimmed}`, 'no', `not ${trimmed.replace(/^(a|an|the)\s+/i, '')}`)
    const asked = [
      ...this.state.asked,
      {
        n: (correct ? '✓' : '✗') as '✓' | '✗',
        question: `GUESS: ${trimmed}`,
        answer: (correct ? 'yes' : 'no') as Answer,
      },
    ]

    if (correct) {
      this.set({
        ...this.state,
        asked,
        status: 'won',
        secret: trimmed,
        lastEvent: { kind: 'yes', caption },
        pending: null,
      })
      return { ok: true, correct: true, result: 'won', state: this.state }
    }

    const lost = this.state.status === 'out_of_questions'
    this.set({ ...this.state, asked, lastEvent: { kind: 'no', caption }, pending: null })
    return { ok: true, correct: false, result: lost ? 'lost' : null, state: this.state }
  }

  /** Whether the transcript already holds this question or guess. */
  hasAsked(item: Pending): boolean {
    const key = questionKey(item.kind === 'guess' ? `GUESS: ${item.text}` : item.text)
    return this.state.asked.some((q) => questionKey(q.question) === key)
  }

  /** Remember what the agent is about to say out loud, for the next turn. */
  setPending(pending: Pending | null): GameState {
    this.set({ ...this.state, pending })
    return this.state
  }

  /** End the round and record what the human says the secret was. */
  endGame(secret?: string): GameState {
    const named = String(secret ?? '').trim()
    this.set({
      ...this.state,
      status: 'revealed',
      secret: named || this.state.secret,
      lastEvent: { kind: 'gold', caption: '' },
    })
    return this.state
  }
}

/** Compact transcript for agent tool output. */
export function transcript(state: GameState): string {
  if (!state.asked.length) return '(nothing asked yet)'
  return state.asked.map((a) => `${a.n}. ${a.question} — ${a.answer}`).join('\n')
}
