/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared game state API — one source of truth for the card on screen and for
// the agent tools. Mirrors the pattern in 20-questions and tictactoe: this
// layer owns the rules and the clock, mcp.ts owns the contract with the model.
//
// The important invariant lives here rather than in mcp.ts: during half two the
// page holds the secret and the agent has to ask for it, and during half one
// the agent never learns it at all. Scoring is decided on this side of the
// tool boundary, so the agent cannot award itself a point.
import { COMPUTER_CARDS, PLAYER_CARDS, type Card } from './deck.ts'
import {
  CARDS_PER_HALF,
  HALF_SECONDS,
  MAX_CLUE_REJECTS,
  SCORE_CORRECT,
  SCORE_VIOLATION,
  dealHalves,
  findViolation,
  isCorrectGuess,
  tokens,
  violates,
} from './engine.ts'

/**
 * `half1` — human clues, agent guesses. `half2` — agent clues, human guesses.
 * `intermission` sits between them with the clock stopped so the agent can read
 * the score out loud without burning half two's time.
 */
export type Phase = 'idle' | 'half1' | 'intermission' | 'half2' | 'over'

export type Feedback = 'correct' | 'violation' | 'skip' | null

/** A burned half-one card, and which of its words did it. */
export interface Struck {
  secret: string
  banned: string[]
  /** The deck's spelling of the banned word that was said. */
  word: string
  /**
   * What was actually spoken. Usually the same word, but when it is part of the
   * secret itself ("scare" on SCARECROW) the card has to show which part.
   */
  said: string
}

export interface GameState {
  phase: Phase
  secondsLeft: number
  /** Points scored while YOU were the clue-giver (half one). */
  youScore: number
  /** Points scored while the AGENT was the clue-giver (half two). */
  aiScore: number
  /** 1-based position of the current card within its half. */
  cardNumber: number
  cardsInHalf: number
  card: Card | null
  /** True in half one, where the page shows the secret to the human. */
  secretOnScreen: boolean
  /**
   * Half two: is the agent holding this card's secret.
   *
   * The page hands it over by itself now — with the result that ends half one,
   * and with the result that closes each card — so this is true from the moment
   * the card comes up rather than after the agent asks. Making it ask cost a
   * tool round it does not have; see the turn-taking note in mcp.ts.
   */
  drawn: boolean
  /** Half two: clues rejected for the current card. */
  rejects: number
  /**
   * The clock has run out but the play in flight has not been resolved yet.
   *
   * Ending the half the instant the timer hits zero throws away answers that
   * were already earned: in live testing the human gave a clue, the agent spent
   * twenty seconds reasoning, and its correct guess landed on a half that had
   * closed underneath it. The player got nothing and was told nothing. So the
   * whistle goes, and the ball already in play still completes.
   */
  expired: boolean
  /** Bumped on every card change so the renderer knows to re-flip. */
  flipToken: number
  /**
   * The word that just left the table, when the human never got to see it.
   *
   * Half two is played against a row of blanks, and until this existed the card
   * simply flipped to the next one — so the answer to what you had just been
   * guessing at was never actually shown to you. Set on the same tick as the
   * flip; the renderer fills the blanks in with it before spinning the card.
   */
  reveal: string | null
  /**
   * The half-one card a banned word just killed, held back for the strike.
   *
   * The state has already moved on to the next word by the time the renderer
   * runs, so the face it needs to draw — the dead word and its banned list with
   * the offending entry marked — has to travel with the transition or it is
   * gone. Half two never sets this: the human is looking at blanks there and
   * has never seen the banned list, so there is nothing on screen to strike.
   */
  struck: Struck | null
  /**
   * The word that was just guessed right, held back for the win animation.
   *
   * Same reason as `struck`: the renderer runs after the state has already
   * dealt the next card, so the word being celebrated has to travel with the
   * transition or it is gone. Set in both halves — a correct guess is worth the
   * same beat whichever side of the table found it.
   */
  solved: string | null
  feedback: Feedback
  /** Recent one-line events, newest last, for the on-screen ticker. */
  log: string[]
}

type Listener = (state: GameState) => void

export type Fail = 'no_game' | 'wrong_phase' | 'game_over' | 'not_drawn'

export interface Outcome {
  ok: boolean
  error?: Fail
  /** The banned word that was said, when one was. */
  violation?: string
  /** The spoken word that tripped `violation`. */
  said?: string
  correct?: boolean
  /** Set when this action closed the card out. */
  cardBurned?: boolean
  /** Set when this action was the last of the half. */
  halfEnded?: boolean
  gameEnded?: boolean
  state: GameState
}

const LOG_LIMIT = 6

export class Game {
  private state: GameState
  private listeners = new Set<Listener>()
  private hands: { first: Card[]; second: Card[] } = { first: [], second: [] }
  private timer: number | null = null

  constructor() {
    this.state = this.freshState()
  }

  private freshState(): GameState {
    return {
      phase: 'idle',
      secondsLeft: HALF_SECONDS,
      youScore: 0,
      aiScore: 0,
      cardNumber: 0,
      cardsInHalf: CARDS_PER_HALF,
      card: null,
      secretOnScreen: false,
      drawn: false,
      rejects: 0,
      expired: false,
      flipToken: 0,
      reveal: null,
      struck: null,
      solved: null,
      feedback: null,
      log: [],
    }
  }

  getState(): GameState {
    return this.state
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<GameState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state)
  }

  private note(line: string) {
    this.set({ log: [...this.state.log, line].slice(-LOG_LIMIT) })
  }

  // The intermission belongs to the second hand: half time already has half
  // two's first card on the table, handed to the agent with the clock stopped.
  private hand(): Card[] {
    const second = this.state.phase === 'half2' || this.state.phase === 'intermission'
    return second ? this.hands.second : this.hands.first
  }

  // ---------------------------------------------------------------- the clock

  private startClock() {
    this.stopClock()
    this.set({ secondsLeft: HALF_SECONDS, expired: false })
    this.timer = globalThis.setInterval(() => {
      const next = this.state.secondsLeft - 1
      if (next <= 0) {
        // Stop the clock but leave the card live: the half closes on the next
        // play, so an answer already being reasoned about still counts.
        this.stopClock()
        this.set({ secondsLeft: 0, expired: true })
        this.note('Time — last play.')
        return
      }
      this.set({ secondsLeft: next })
    }, 1000)
  }

  private stopClock() {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer)
      this.timer = null
    }
  }

  // ------------------------------------------------------------ half plumbing

  /** Deal a fresh deck and open half one with card one already flipping in. */
  newGame(): GameState {
    this.stopClock()
    // Half one from the player pool, half two from the computer pool. Fixed
    // sets, freshly shuffled each game — see dealHalves.
    this.hands = dealHalves(PLAYER_CARDS, COMPUTER_CARDS)
    // Taken before the reset. `freshState()` puts the token back to 0, so
    // reading it afterwards makes every new game land on 1 — and render.ts only
    // repaints the card face when the token *changes*, so the second new game
    // of a session dealt a new word while leaving the old one on screen.
    const nextToken = this.state.flipToken + 1
    this.state = this.freshState()
    this.set({
      phase: 'half1',
      cardNumber: 1,
      card: this.hands.first[0] ?? null,
      secretOnScreen: true,
      reveal: null,
      struck: null,
      solved: null,
      flipToken: nextToken,
      log: ['Half one — your clue.'],
    })
    this.startClock()
    return this.state
  }

  /**
   * Close the running half. Half one hands off to an untimed intermission;
   * half two ends the game.
   *
   * The intermission is not an empty table any more: it comes up holding half
   * two's first card, already drawn. The agent is told the score and given its
   * word in the same result, so it can clear a clue and open the half in one
   * utterance instead of announcing the handover and then falling silent.
   */
  private endHalf(reveal: string | null, struck: Struck | null = null, solved: string | null = null) {
    this.stopClock()
    if (this.state.phase === 'half1') {
      const first = this.hands.second[0] ?? null
      this.set({
        phase: 'intermission',
        card: first,
        secretOnScreen: false,
        cardNumber: first ? 1 : 0,
        drawn: Boolean(first),
        rejects: 0,
        expired: false,
        reveal,
        struck,
        solved,
        flipToken: this.state.flipToken + 1,
      })
      this.note(`Half one done — you clued ${this.state.youScore}.`)
      return
    }
    this.set({
      phase: 'over',
      card: null,
      secretOnScreen: false,
      drawn: false,
      reveal,
      struck,
      solved,
      flipToken: this.state.flipToken + 1,
    })
    this.note(`Final — you ${this.state.youScore}, AI ${this.state.aiScore}.`)
  }

  /** Promote the stopped intermission into a running half two. */
  private beginHalf2() {
    if (this.state.phase !== 'intermission') return
    this.set({
      phase: 'half2',
      feedback: null,
      reveal: null,
      struck: null,
      solved: null,
      flipToken: this.state.flipToken + 1,
    })
    this.note('Half two — the AI clues.')
    this.startClock()
  }

  /** Move to the next card in the current half, or end the half. */
  private advance(feedback: Feedback, struck: Struck | null = null): boolean {
    // The card on its way out is the one that was just won.
    const solved = feedback === 'correct' ? (this.state.card?.secret ?? null) : null
    // Half two plays against blanks, so the word that is about to leave has to
    // be shown on its way out — the human has been staring at its shape and
    // otherwise never learns what it was.
    const reveal = this.state.secretOnScreen ? null : (this.state.card?.secret ?? null)

    // Time ran out while this card was live. It has just been scored, so the
    // half can close now — the ball in play completed.
    if (this.state.expired) {
      this.set({ feedback })
      this.endHalf(reveal, struck, solved)
      return true
    }
    const next = this.state.cardNumber + 1
    if (next > this.hand().length) {
      this.set({ feedback })
      this.endHalf(reveal, struck, solved)
      return true
    }
    this.set({
      cardNumber: next,
      card: this.hand()[next - 1],
      // Handed straight over in half two. Anywhere the agent has to ask for the
      // word is a tool round it cannot spend without going quiet first.
      drawn: this.state.phase !== 'half1',
      rejects: 0,
      feedback,
      reveal,
      struck,
      solved,
      flipToken: this.state.flipToken + 1,
    })
    return false
  }

  /**
   * A play that scored nothing and left the card up — a wrong guess, a blocked
   * clue. After time it still ends the half, or the agent could play on forever
   * past the whistle by simply never getting anything right.
   */
  private settle(): boolean {
    if (!this.state.expired) return false
    // Nothing was scored here, so the previous card's verdict is cleared before
    // the half closes — left set, it flashes the table green for a point that
    // was not just won.
    this.set({ feedback: null, struck: null, solved: null })
    // The card never resolved, but the half is closing on top of it, so a
    // hidden word still gets shown before the table clears.
    this.endHalf(this.state.secretOnScreen ? null : (this.state.card?.secret ?? null))
    return true
  }

  private award(points: number) {
    if (this.state.phase === 'half1') this.set({ youScore: this.state.youScore + points })
    else this.set({ aiScore: this.state.aiScore + points })
  }

  private reject(error: Fail): Outcome {
    return { ok: false, error, state: this.state }
  }

  // --------------------------------------------------- half one: you clue

  /**
   * The agent reports your words verbatim and takes a guess in the same call.
   * Fusing the two is the enforcement: there is no route to a point that skips
   * the referee. Banned words are checked first — a foul makes the guess moot.
   */
  submitClue(heard: string, guess: string): Outcome {
    if (this.state.phase === 'idle') return this.reject('no_game')
    if (this.state.phase === 'over') return this.reject('game_over')
    if (this.state.phase !== 'half1') return this.reject('wrong_phase')
    const card = this.state.card
    if (!card) return this.reject('wrong_phase')

    const violation = findViolation(heard, card)
    if (violation) {
      const said = tokens(heard).find((token) => violates(token, violation)) ?? violation
      this.award(SCORE_VIOLATION)
      this.note(`Foul — "${violation}". ${card.secret} burned.`)
      // The card they were looking at goes with the transition so the renderer
      // can strike the word they said before the table turns over. Naming it on
      // screen is safe here and nowhere else: the card is dead, so pointing at
      // one of its five routes gives nothing away.
      const halfEnded = this.advance('violation', {
        secret: card.secret,
        banned: card.banned,
        word: violation,
        said,
      })
      return { ok: true, violation, said, cardBurned: true, halfEnded, state: this.state }
    }

    if (isCorrectGuess(guess, card.secret)) {
      this.award(SCORE_CORRECT)
      this.note(`${card.secret} — got it.`)
      const halfEnded = this.advance('correct')
      return { ok: true, correct: true, halfEnded, state: this.state }
    }

    return { ok: true, correct: false, halfEnded: this.settle(), state: this.state }
  }

  // -------------------------------------------------- half two: agent clues

  /**
   * Re-read the word the page has already handed over.
   *
   * This used to be the only way the agent ever learned a word, and it was the
   * step the whole half fell down on: taking a card and clueing it are two
   * calls, and the agent would take the card, go quiet, and wait to be prompted
   * before saying anything. Now every result that puts a new card up carries
   * the word with it, and this is only a way back for an agent that lost it. It
   * changes nothing and it does not start the clock.
   */
  drawCard(): Outcome & { card?: Card } {
    if (this.state.phase === 'idle') return this.reject('no_game')
    if (this.state.phase === 'over') return this.reject('game_over')
    if (this.state.phase === 'half1') return this.reject('wrong_phase')
    if (!this.state.card) return this.reject('wrong_phase')
    this.set({ drawn: true })
    return { ok: true, card: this.state.card, state: this.state }
  }

  /**
   * Vet a clue the agent wants to speak. Rejection costs nothing but the clock
   * until the allowance runs out, at which point the card burns — otherwise the
   * agent could brute-force its way to a legal clue for free.
   */
  vetClue(clue: string): Outcome & { rejectsLeft?: number } {
    if (this.state.phase === 'idle') return this.reject('no_game')
    if (this.state.phase === 'over') return this.reject('game_over')
    if (this.state.phase === 'half1') return this.reject('wrong_phase')
    const card = this.state.card
    if (!card) return this.reject('wrong_phase')
    if (!this.state.drawn) return this.reject('not_drawn')

    // The first clue attempt of the half is what starts the clock — not the
    // moment the agent was handed the word. Composing a clue takes a reasoning
    // model tens of seconds, and half two is two minutes long; charging it for
    // thinking is what the stopped intermission exists to avoid. A blocked
    // attempt still starts it, so the rejection allowance keeps costing time.
    this.beginHalf2()

    const violation = findViolation(clue, card)
    if (!violation) {
      this.note(`AI: "${clue.trim()}"`)
      return { ok: true, state: this.state }
    }

    const rejects = this.state.rejects + 1
    this.set({ rejects })
    if (rejects > MAX_CLUE_REJECTS) {
      this.award(SCORE_VIOLATION)
      this.note(`AI fouled out on ${card.secret}.`)
      const halfEnded = this.advance('violation')
      return { ok: true, violation, cardBurned: true, halfEnded, state: this.state }
    }

    // Deliberately unnamed on screen. The card is still live and the human is
    // still guessing, so printing "Blocked — beam" would hand them one of the
    // five most obvious routes to the word. The agent gets the word it tripped
    // on in the tool result, where the human cannot see it.
    this.note(`Blocked. ${MAX_CLUE_REJECTS - rejects + 1} left.`)
    return {
      ok: true,
      violation,
      rejectsLeft: MAX_CLUE_REJECTS - rejects + 1,
      halfEnded: this.settle(),
      state: this.state,
    }
  }

  /** The agent reports your guess; the page, which holds the secret, judges it. */
  reportGuess(heard: string): Outcome {
    if (this.state.phase === 'idle') return this.reject('no_game')
    if (this.state.phase === 'over') return this.reject('game_over')
    if (this.state.phase !== 'half2') return this.reject('wrong_phase')
    const card = this.state.card
    if (!card) return this.reject('wrong_phase')

    if (isCorrectGuess(heard, card.secret)) {
      this.award(SCORE_CORRECT)
      this.note(`${card.secret} — they got it.`)
      const halfEnded = this.advance('correct')
      return { ok: true, correct: true, halfEnded, gameEnded: halfEnded, state: this.state }
    }
    const halfEnded = this.settle()
    return { ok: true, correct: false, halfEnded, gameEnded: halfEnded, state: this.state }
  }

  // ------------------------------------------------------------------ shared

  /** Bin the current card. Costs no points, only the clock. */
  skipCard(): Outcome & { skipped?: string } {
    if (this.state.phase === 'idle') return this.reject('no_game')
    if (this.state.phase === 'over') return this.reject('game_over')
    const card = this.state.card
    if (!card) return this.reject('wrong_phase')

    // Binning the word you were just handed is a real play, so it opens the
    // half the same way a clue attempt does.
    this.beginHalf2()

    // Capture the half before advancing: skipping the last card of half two is
    // the one skip that ends the game.
    const wasSecondHalf = this.state.phase === 'half2'
    this.note(`Skipped ${card.secret}.`)
    const halfEnded = this.advance('skip')
    return {
      ok: true,
      skipped: card.secret,
      halfEnded,
      gameEnded: halfEnded && wasSecondHalf,
      state: this.state,
    }
  }

  /** Stop the clock and tear down — for hot reload and for a manual reset. */
  dispose() {
    this.stopClock()
    this.listeners.clear()
  }
}
