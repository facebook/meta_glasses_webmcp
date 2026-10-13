/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared state API — one source of truth for the canvas, the HUD, and the
// MCP tools. It owns the die, the answers printed on it, and the only fact
// that matters: whether the ball has finished settling, and therefore whether
// an answer exists yet.
//
// The invariant the whole example hangs on is that `answer` is `null` until
// the die has physically come to rest. Nothing — not the page, not the agent —
// can know the answer before the player can read it off the glass.

import {
  cloneBody,
  createBody,
  faceAtWindow,
  planTumble,
  qSlerp,
  readingPose,
  shakeBody,
  stepBody,
  FACE_COUNT,
  type Body,
  type Quat,
  type Tumble,
  type Vec3,
} from './physics'

export type Tone = 'affirmative' | 'noncommittal' | 'negative'

/** The twenty stock answers, one per face. */
export const MESSAGES: { text: string; tone: Tone }[] = [
  { text: 'Absolutely', tone: 'affirmative' },
  { text: 'Count on it', tone: 'affirmative' },
  { text: 'All signs say yes', tone: 'affirmative' },
  { text: 'Safe bet', tone: 'affirmative' },
  { text: 'Very likely', tone: 'affirmative' },
  { text: 'Looks promising', tone: 'affirmative' },
  { text: 'The stars agree', tone: 'affirmative' },
  { text: 'Go for it', tone: 'affirmative' },
  { text: 'Too murky to tell', tone: 'noncommittal' },
  { text: 'Try again tomorrow', tone: 'noncommittal' },
  { text: 'Hard to say', tone: 'noncommittal' },
  { text: 'Ask me once more', tone: 'noncommittal' },
  { text: 'Doubt it', tone: 'negative' },
  { text: 'Not a chance', tone: 'negative' },
  { text: 'The stars say no', tone: 'negative' },
  { text: 'Unlikely', tone: 'negative' },
  { text: 'I would not', tone: 'negative' },
  { text: 'The mist is thick', tone: 'noncommittal' },
  { text: 'No question', tone: 'affirmative' },
  { text: 'Yes', tone: 'affirmative' },
]

const TONE_BY_TEXT = new Map(MESSAGES.map((m) => [m.text.toLowerCase(), m.tone]))

/** The tone of one of the twenty stock replies, if `text` is one of them. */
export function toneFor(text: string): Tone | undefined {
  return TONE_BY_TEXT.get(text.trim().toLowerCase())
}

/**
 * An answer supplied from outside instead of read off the die.
 *
 * This is what the AI-oracle mode passes in: the words are painted onto
 * whichever face the look-ahead says will win, so the die still tumbles and
 * lands honestly — it is just carrying someone else's writing.
 */
export interface AnswerOverride {
  answer: string
  tone?: Tone
}

export type BallStatus =
  /** Nothing asked yet; the window is empty. */
  | 'idle'
  /** The die is tumbling. No answer exists. */
  | 'shaking'
  /** The die has stopped and is turning to face the glass. Still no answer. */
  | 'presenting'
  /** An answer is readable in the window. */
  | 'settled'
  /** The answer is fading out, leaving the window empty for the next question. */
  | 'clearing'

export interface Reading {
  question: string | null
  answer: string
  tone: Tone
}

export interface BallState {
  status: BallStatus
  /** The question being asked, or the last one asked. */
  question: string | null
  /** The answer showing in the window. `null` unless status is 'settled'. */
  answer: string | null
  tone: Tone | null
  /**
   * True while a fade-out has another shake waiting behind it.
   *
   * `clearing` covers two different beats — the linger running out, which ends
   * with an empty window, and a new question arriving, which ends with a die
   * rolling in. They look nothing alike and the page has to dress them
   * differently, so the distinction is public rather than buried in `queued`.
   */
  queuedShake: boolean
  /** Completed readings, oldest first. */
  history: Reading[]
}

const STEP_MS = 1000 / 60
/** How long the die takes to turn its landed face square to the window. */
const PRESENT_MS = 450
/**
 * How long the window stays dark after a shake before the die actually drops.
 *
 * `ask()` returns in microseconds, but the agent does not speak for seconds
 * afterwards — model latency, then TTS. Without a wait the die had landed and
 * been sitting there for a beat before the human heard a word, so the answer
 * arrived as a caption for something that had already happened.
 *
 * This and REPLAY_RATE below are the two dials for lining the die up with the
 * voice. Together they put a readable answer on the glass at a median of 3.9s,
 * which is roughly where a realtime model starts speaking. Tune both to your
 * agent. (SHAKE_SPIN in physics.ts is the third: more spin means a longer
 * tumble, so raising it lengthens this without either dial moving.)
 */
const THROW_DELAY_MS = 800
/**
 * Playback speed of the tumble, as a fraction of real time.
 *
 * Deliberately not a change to gravity: the physics constants are tuned over
 * 300 seeded shakes for a die that reliably settles flat, and `planTumble` has
 * already walked this exact trajectory to decide the answer. Slowing the
 * *replay* stretches the fall without touching a step of it, so the face that
 * lands is still the face the tool returned.
 */
const REPLAY_RATE = 0.72
/**
 * How long a verdict stays in the window before the ball empties itself.
 *
 * The page cannot see the agent thinking, and between the human speaking and
 * `ask` landing there are seconds of model latency during which a stale answer
 * would otherwise still be sitting there, looking like a reply to the question
 * just asked.
 */
const LINGER_MS = 7000
/**
 * How long the window takes to dissolve, whether it was the linger that ran out
 * or a new question that arrived.
 *
 * A question is the other trigger, which makes a shake read as three beats: the
 * old verdict fades, the window sits empty for an instant, and the die drops
 * back in.
 */
const FADE_MS = 400
const HISTORY_LIMIT = 20

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export class Ball {
  private readonly rng: () => number
  private readonly body: Body = createBody()
  /** Which message is printed on each face. Reshuffled on every shake. */
  private faces = MESSAGES.slice()

  private status: BallStatus = 'idle'
  private question: string | null = null
  private answer: string | null = null
  private tone: Tone | null = null
  /** The reading this shake is going to produce, known from the moment it is thrown. */
  private pending: Reading | null = null
  private readonly history: Reading[] = []

  /** The tumble decided at `ask()` time, which `tick()` is replaying. */
  private planned: Tumble | null = null
  private stepsReplayed = 0
  private lastTick = 0
  private accumulator = 0
  private presentFrom: { pos: Vec3; q: Quat } | null = null
  private presentTo: { pos: Vec3; q: Quat } | null = null
  private presentStart = 0
  /**
   * The next shake, decided but not yet visible. `ask()` fills this in and the
   * fade-out runs first; `tick()` applies it when the window is empty.
   */
  private queued: {
    body: Body
    plan: Tumble
    faces: { text: string; tone: Tone }[]
    question: string | null
  } | null = null
  private settledAt = 0
  private clearStart = 0
  /** Clock time the queued die is allowed to start falling. See THROW_DELAY_MS. */
  private throwAt = 0
  /** Drawing opacity for the die: 1 normally, ramped to 0 while clearing. */
  private opacity = 1

  private readonly listeners = new Set<(state: BallState) => void>()
  private readonly waiters = new Set<(state: BallState) => void>()

  constructor(rng: () => number = Math.random) {
    this.rng = rng
    this.faces = shuffled(MESSAGES, rng)
  }

  // ─── Reads ─────────────────────────────────────────────────────────
  getState(): BallState {
    return {
      status: this.status,
      question: this.question,
      answer: this.answer,
      tone: this.tone,
      queuedShake: this.queued !== null,
      history: this.history.slice(),
    }
  }

  /** Everything the renderer needs, without exposing the state machine. */
  view(): { body: Body; faces: string[]; visible: boolean; opacity: number } {
    return {
      body: this.body,
      faces: this.faces.map((m) => m.text),
      visible: this.status !== 'idle',
      opacity: this.opacity,
    }
  }

  subscribe(fn: (state: BallState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Resolve once an answer is readable, and never resolve without one.
   *
   * Returns immediately when the ball is idle or already settled. Otherwise it
   * waits for the die, and if the deadline passes it forces a settle rather
   * than resolving empty — a caller that blocks on this is doing so precisely
   * so it cannot be handed a null answer.
   */
  whenSettled(timeoutMs = 12_000): Promise<BallState> {
    if (this.status === 'settled' || this.status === 'idle') {
      return Promise.resolve(this.getState())
    }
    return new Promise((resolve) => {
      const done = (state: BallState) => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(state)
      }
      const timer = setTimeout(() => {
        this.settleNow()
        done(this.getState())
      }, timeoutMs)
      this.waiters.add(done)
    })
  }

  // ─── Writes ────────────────────────────────────────────────────────
  /**
   * Shake the ball and return the reading, immediately.
   *
   * The whole tumble is simulated here and now, on a copy of the body, so the
   * answer is known before the first frame is drawn — `tick()` then replays the
   * identical trajectory, and the die lands on exactly this face. The die is
   * not being steered toward a pre-chosen answer; the physics simply ran ahead
   * of the clock. It costs about 0.1ms.
   *
   * The returned answer is deliberately NOT put into `getState()` yet: the
   * caller may speak it, but the window stays blank until the die gets there.
   *
   * Pass `override` to supply the answer instead of letting the die choose one
   * — the words go onto the winning face, so the tumble is unchanged and still
   * genuinely decides *where* the die lands, just not *what it says*. The Ball
   * itself has no notion of which mode the page is in; it only knows whether it
   * was handed words.
   */
  ask(question?: string | null, override?: AnswerOverride | null): Reading {
    const text = question?.trim()

    // Decide the whole shake up front, on a scratch body, so the answer can be
    // returned now. The live body is deliberately left alone: it is still
    // showing the last verdict, and that has to fade out before this one rolls.
    const thrown = cloneBody(this.body)
    shakeBody(thrown, this.rng)
    const plan = planTumble(thrown)
    const faces = shuffled(MESSAGES, this.rng)

    const winner = plan.face % FACE_COUNT
    if (override) {
      const supplied = override.answer.trim()
      faces[winner] = {
        text: supplied,
        tone: override.tone ?? toneFor(supplied) ?? 'noncommittal',
      }
    }
    const message = faces[winner]

    this.queued = { body: thrown, plan, faces, question: text ? text : null }
    this.pending = { question: text ? text : null, answer: message.text, tone: message.tone }

    if (this.status === 'idle') {
      // Nothing on screen to clear — drop straight in.
      this.startQueued()
    } else {
      this.status = 'clearing'
      this.clearStart = this.lastTick
      this.opacity = 1
      this.emit()
    }

    return this.pending
  }

  /** Swap the faded-out die for the queued one and start the tumble. */
  private startQueued(): void {
    const next = this.queued
    if (!next) return
    this.queued = null

    this.body.pos = next.body.pos
    this.body.vel = next.body.vel
    this.body.q = next.body.q
    this.body.w = next.body.w
    this.body.asleep = next.body.asleep

    this.faces = next.faces
    this.planned = next.plan
    this.question = next.question
    this.answer = null
    this.tone = null
    this.status = 'shaking'
    this.presentFrom = null
    this.presentTo = null
    this.accumulator = 0
    this.stepsReplayed = 0
    // Anchored on the first tick rather than here, because `ask()` can land
    // before the loop has ever run and `lastTick` would still be 0.
    this.throwAt = 0
    this.opacity = 1
    this.emit()
  }

  /**
   * Empty the window immediately: no answer, no question, no die, no fade.
   *
   * Not part of the ask sequence — `ask()` dissolves the previous answer on its
   * own. This is the abrupt version, for resetting the page. The history is
   * untouched; only the display is cleared.
   */
  clear(): void {
    if (this.status === 'idle') return

    this.status = 'idle'
    this.question = null
    this.answer = null
    this.tone = null
    this.pending = null
    this.planned = null
    this.queued = null
    this.clearStart = 0
    this.throwAt = 0
    this.opacity = 1
    this.emit()
  }

  /**
   * Skip whatever is left of the fall and show the answer now.
   *
   * A hidden tab stops `requestAnimationFrame` dead, which would freeze the die
   * mid-air for a shake nobody is watching. The reading is already decided, so
   * there is nothing to lose by jumping to it.
   */
  settleNow(): void {
    if (this.status === 'clearing') {
      // A linger-fade with nothing behind it has no answer to jump to.
      if (!this.queued) return this.clear()
      this.startQueued()
    }
    if (this.status === 'settled' || this.status === 'idle') return
    const face = this.planned?.face ?? faceAtWindow(this.body)
    const pose = readingPose(face)
    this.body.pos = pose.pos
    this.body.q = pose.q
    this.body.vel = [0, 0, 0]
    this.body.w = [0, 0, 0]
    this.body.asleep = true
    this.presentFrom = null
    this.presentTo = null
    this.settle()
  }

  /** Advance the replay. `now` is a monotonic clock in milliseconds. */
  tick(now: number): void {
    const previous = this.lastTick
    this.lastTick = now

    if (this.status === 'shaking') {
      const plan = this.planned
      if (!plan) return this.beginPresenting(now)

      // Held before the drop, so the die is not already resting on the glass by
      // the time the agent speaks. The window is dark and empty for this beat.
      if (!this.throwAt) this.throwAt = now + THROW_DELAY_MS
      if (now < this.throwAt) return

      // Fixed timestep, so the die behaves the same on a 60Hz panel and a
      // 120Hz one — and, more importantly, so the replay is step-for-step the
      // trajectory `planTumble` already walked. REPLAY_RATE scales how much
      // clock time each step consumes; it changes the pace, never the path. The
      // clamp stops a backgrounded tab from flushing seconds of physics into a
      // single frame.
      this.accumulator += (previous ? Math.min(now - previous, 100) : STEP_MS) * REPLAY_RATE
      while (this.accumulator >= STEP_MS && this.stepsReplayed < plan.steps) {
        stepBody(this.body)
        this.stepsReplayed++
        this.accumulator -= STEP_MS
      }
      if (this.stepsReplayed >= plan.steps) this.beginPresenting(now)
      return
    }

    if (this.status === 'presenting') return this.stepPresenting(now)

    // An answer that has been up long enough starts dissolving on its own.
    if (this.status === 'settled' && now - this.settledAt > LINGER_MS) {
      this.status = 'clearing'
      this.clearStart = now
      this.emit()
      return
    }

    // Dissolving, either on the linger or because a question arrived. Whether
    // a die drops in afterwards depends only on whether one is queued.
    if (this.status === 'clearing') {
      if (!this.clearStart) this.clearStart = now
      const t = Math.min(1, (now - this.clearStart) / FADE_MS)
      this.opacity = 1 - t
      if (t >= 1) {
        this.clearStart = 0
        if (this.queued) this.startQueued()
        else this.clear()
      }
    }
  }

  // ─── Settling ──────────────────────────────────────────────────────
  /**
   * Physics leaves the die resting flat but rolled to an arbitrary angle, and
   * often nudged off-centre — legible on a desk, not through a 143px window.
   * Ease it into the reading pose instead of snapping, so it reads as the ball
   * presenting its answer rather than as a glitch.
   */
  private beginPresenting(now: number): void {
    const face = this.planned?.face ?? faceAtWindow(this.body)
    this.presentFrom = { pos: [...this.body.pos] as Vec3, q: [...this.body.q] as Quat }
    this.presentTo = readingPose(face)
    this.presentStart = now
    this.status = 'presenting'
    this.emit()
    this.stepPresenting(now)
  }

  private stepPresenting(now: number): void {
    const from = this.presentFrom
    const to = this.presentTo
    if (!from || !to) return

    const t = Math.min(1, (now - this.presentStart) / PRESENT_MS)
    const e = easeOutCubic(t)
    this.body.pos = [
      from.pos[0] + (to.pos[0] - from.pos[0]) * e,
      from.pos[1] + (to.pos[1] - from.pos[1]) * e,
      from.pos[2] + (to.pos[2] - from.pos[2]) * e,
    ]
    this.body.q = qSlerp(from.q, to.q, e)
    if (t < 1) return

    this.settle()
  }

  /**
   * Reveal the reading decided back at `ask()`. Nothing is chosen here — the
   * face the die is now showing and `pending` are the same face by
   * construction, and reading from `pending` keeps the window and whatever the
   * agent already said in step.
   */
  private settle(): void {
    const reading =
      this.pending ??
      (() => {
        // Only reachable if the ball was driven without ask(), e.g. a stray
        // settleNow(). Fall back to whatever is actually facing the glass.
        const m = this.faces[faceAtWindow(this.body) % FACE_COUNT]
        return { question: this.question, answer: m.text, tone: m.tone }
      })()

    this.status = 'settled'
    this.settledAt = this.lastTick
    this.opacity = 1
    this.answer = reading.answer
    this.tone = reading.tone
    this.history.push(reading)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()

    const state = this.getState()
    this.emit(state)
    for (const waiter of [...this.waiters]) waiter(state)
    this.waiters.clear()
  }

  private emit(state: BallState = this.getState()): void {
    for (const fn of this.listeners) fn(state)
  }
}
