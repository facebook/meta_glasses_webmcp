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

export interface GameState {
  status: Status
  /** Questions spent. A guess is free and does not count. */
  used: number
  asked: Exchange[]
  /** Only ever set from what the human told the agent, never inferred. */
  secret: string | null
  lastEvent: OrbEvent | null
}

type Listener = (state: GameState) => void

export interface RecordOutcome {
  ok: boolean
  /** Present when the record was rejected, for the tool layer to relay. */
  error?: string
  answer?: Answer
  /** True when this exact question was already the most recent record. */
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
    return { status, used: 0, asked: [], secret: null, lastEvent: null }
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
   * Re-recording the most recent question is a no-op rather than an error —
   * see the note in mcp.ts about why that matters.
   */
  recordAnswer(question: string, answer: Answer, summary?: string): RecordOutcome {
    if (this.state.status === 'idle') {
      return { ok: false, error: 'no_game', state: this.state }
    }
    if (this.state.status !== 'playing') {
      return { ok: false, error: 'game_over', state: this.state }
    }

    const prev = this.state.asked[this.state.asked.length - 1]
    if (prev && questionKey(prev.question) === questionKey(question)) {
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
    })
    return { ok: true, answer, outOfQuestions, state: this.state }
  }

  /**
   * Log a guess and whether the human confirmed it. A wrong guess is free: it
   * appears in the transcript but does not spend a question.
   */
  recordGuess(guess: string, correct: boolean): GuessOutcome {
    if (this.state.status === 'idle') {
      return { ok: false, error: 'no_game', state: this.state }
    }
    if (this.state.status === 'won' || this.state.status === 'revealed') {
      return { ok: false, error: 'game_over', state: this.state }
    }

    const trimmed = guess.trim()
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
      })
      return { ok: true, correct: true, result: 'won', state: this.state }
    }

    const lost = this.state.status === 'out_of_questions'
    this.set({ ...this.state, asked, lastEvent: { kind: 'no', caption } })
    return { ok: true, correct: false, result: lost ? 'lost' : null, state: this.state }
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
