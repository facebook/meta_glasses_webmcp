/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure rigid-body engine for the Magic Ball.
//
// Everything here is geometry and arithmetic: vector/quaternion helpers, the
// icosahedral die, and the two contacts that matter — the flat viewing window
// and the spherical cavity behind it. No DOM, no WebMCP, no `Math.random()`:
// the caller passes an RNG into `shakeBody`, so a shake can be replayed.
//
// Coordinate system: +Z points at the viewer, +Y is up, the origin is the
// centre of the sphere. The window is the disc of the plane z = WIN_Z that
// falls inside the sphere; the answer the player reads is whichever face is
// lying flat against it.

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

// ─── Cavity ──────────────────────────────────────────────────────────
/** Inner radius of the sphere the die tumbles in. */
export const R = 200
/** Angular half-width of the window, measured from the +Z axis. */
const WIN_HALF = (33 * Math.PI) / 180
/** The window plane. Faces cannot pass beyond it. */
export const WIN_Z = R * Math.cos(WIN_HALF)
/** Radius of the window aperture in the plane z = WIN_Z. */
export const WIN_R = R * Math.sin(WIN_HALF)

// ─── Vec3 ────────────────────────────────────────────────────────────
export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  sc: (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (v: Vec3): number => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]),
  nrm: (v: Vec3): Vec3 => {
    const l = v3.len(v)
    return l < 1e-12 ? [0, 0, 0] : v3.sc(v, 1 / l)
  },
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
}

// ─── Quaternion ──────────────────────────────────────────────────────
function qMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]
}

function qConj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]]
}

function qNorm(q: Quat): Quat {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l < 1e-12 ? [1, 0, 0, 0] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

/** Rotation of `angle` radians about `axis`. */
function qAA(axis: Vec3, angle: number): Quat {
  const h = angle / 2
  const s = Math.sin(h)
  return qNorm([Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s])
}

export function qRot(q: Quat, v: Vec3): Vec3 {
  const p: Quat = [0, v[0], v[1], v[2]]
  const r = qMul(qMul(q, p), qConj(q))
  return [r[1], r[2], r[3]]
}

/** Shortest-arc interpolation, used to ease the die into its reading pose. */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  let end = b
  if (dot < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]]
    dot = -dot
  }
  if (dot > 0.9995) {
    return qNorm([
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ])
  }
  const theta = Math.acos(Math.min(1, dot))
  const st = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / st
  const wb = Math.sin(t * theta) / st
  return qNorm([
    a[0] * wa + end[0] * wb,
    a[1] * wa + end[1] * wb,
    a[2] * wa + end[2] * wb,
    a[3] * wa + end[3] * wb,
  ])
}

// ─── The die ─────────────────────────────────────────────────────────
/** Circumradius of the icosahedron. */
export const DIE_SCALE = 150
const PHI = (1 + Math.sqrt(5)) / 2
const ICO_NORM = Math.sqrt(1 + PHI * PHI)

export const VERTS: Vec3[] = (
  [
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ] as Vec3[]
).map((v): Vec3 => [
  (v[0] / ICO_NORM) * DIE_SCALE,
  (v[1] / ICO_NORM) * DIE_SCALE,
  (v[2] / ICO_NORM) * DIE_SCALE,
])

type Face = [number, number, number]

export const FACES: Face[] = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
]

/** How many answers the die can show. One per face. */
export const FACE_COUNT = FACES.length

// Make every face wind counter-clockwise seen from outside, so a face normal
// computed from its winding always points away from the centre.
for (let i = 0; i < FACES.length; i++) {
  const [ai, bi, ci] = FACES[i]
  const a = VERTS[ai]
  const b = VERTS[bi]
  const c = VERTS[ci]
  const n = v3.cross(v3.sub(b, a), v3.sub(c, a))
  const centroid = v3.sc(v3.add(v3.add(a, b), c), 1 / 3)
  if (v3.dot(n, centroid) < 0) FACES[i] = [ai, ci, bi]
}

/** Outward unit normal of each face, in the die's own frame. */
export const FACE_NORMALS: Vec3[] = FACES.map((face) => {
  const [a, b, c] = face.map((i) => VERTS[i])
  return v3.nrm(v3.cross(v3.sub(b, a), v3.sub(c, a)))
})

/** Distance from the die's centre to any face plane. */
export const FACE_INRADIUS = v3.dot(
  v3.sc(v3.add(v3.add(VERTS[FACES[0][0]], VERTS[FACES[0][1]]), VERTS[FACES[0][2]]), 1 / 3),
  FACE_NORMALS[0],
)

/** Radius of the in-circle of one triangular face — the space text has to fit. */
export const FACE_INCIRCLE = DIE_SCALE / (ICO_NORM * Math.sqrt(3))

/** Orientation that turns face `fi` to look straight at the viewer. */
function orientationForFace(fi: number): Quat {
  const n = FACE_NORMALS[fi]
  const dot = n[2] // dot(n, [0, 0, 1])
  if (dot > 0.9999) return [1, 0, 0, 0]
  if (dot < -0.9999) return [0, 1, 0, 0]
  const axis = v3.nrm(v3.cross(n, [0, 0, 1]))
  return qAA(axis, Math.acos(Math.max(-1, Math.min(1, dot))))
}

/**
 * Orientation that faces `fi` at the viewer *and* rolls it so its text reads
 * level. Physics alone leaves the die resting at an arbitrary spin about the
 * window normal, which is charming but often illegible; the state layer eases
 * into this pose once the die is asleep.
 */
export function faceUprightOrientation(fi: number): Quat {
  const faceQ = orientationForFace(fi)
  const [ai, bi] = FACES[fi]
  const right = v3.nrm(v3.sub(VERTS[bi], VERTS[ai]))
  const rotated = qRot(faceQ, right)
  return qNorm(qMul(qAA([0, 0, 1], -Math.atan2(rotated[1], rotated[0])), faceQ))
}

/** The pose that presents face `fi` centred in the window. */
export function readingPose(fi: number): { pos: Vec3; q: Quat } {
  return { pos: [0, 0, WIN_Z - FACE_INRADIUS], q: faceUprightOrientation(fi) }
}

// ─── Bodies ──────────────────────────────────────────────────────────
export interface Body {
  pos: Vec3
  vel: Vec3
  /** Orientation. */
  q: Quat
  /** Angular velocity, as an axis scaled by radians per step. */
  w: Vec3
  asleep: boolean
}

export function createBody(): Body {
  return { pos: [0, 0, -50], vel: [0, 0, 0], q: [1, 0, 0, 0], w: [0, 0, 0], asleep: true }
}

export function cloneBody(b: Body): Body {
  return {
    pos: [...b.pos],
    vel: [...b.vel],
    q: [...b.q],
    w: [...b.w],
    asleep: b.asleep,
  }
}

/** The die's vertices in world space, optionally scaled about its centre. */
export function worldVerts(b: Body, scale = 1): Vec3[] {
  return VERTS.map((v) => v3.add(b.pos, qRot(b.q, scale === 1 ? v : v3.sc(v, scale))))
}

/**
 * True when a face is squarely presented at the glass — i.e. when a player
 * would say the die has stopped.
 *
 * Deliberately looser than "in contact". The die never quite lands on the
 * window: contacts are intermittent (usually a single vertex at a time), so it
 * converges on the plane asymptotically and is still a few units short after
 * six seconds. What the eye reads as "stopped" is the face being square to the
 * viewer and close to the glass, which happens far earlier.
 */
export function isFlatOnWindow(b: Body): boolean {
  const fi = faceAtWindow(b)
  if (qRot(b.q, FACE_NORMALS[fi])[2] < 0.94) return false
  return b.pos[2] + FACE_INRADIUS > WIN_Z - 20
}

/** Index of the face currently lying against the window. */
export function faceAtWindow(b: Body): number {
  let best = 0
  let bestDot = -Infinity
  for (let fi = 0; fi < FACE_NORMALS.length; fi++) {
    const z = qRot(b.q, FACE_NORMALS[fi])[2]
    if (z > bestDot) {
      bestDot = z
      best = fi
    }
  }
  return best
}

// ─── Physics ─────────────────────────────────────────────────────────
const MASS = 1
const INERTIA = 0.4 * MASS * DIE_SCALE * DIE_SCALE
// "Gravity" pulls toward +Z, i.e. toward the window: the player is holding the
// ball with the window facing them, so the die falls into view.
//
// Gravity and damping are three times and twice the original demo's. That demo
// never had to decide when the die had stopped — it tumbled until the page went
// away — so a die that took six seconds to stop drifting cost nothing. Here a
// tool call waits on it, and these values bring the median answer down from
// 5.4s to about 2s without changing the character of the tumble. Gravity also
// scales the contact normal force, so friction and the righting torque that
// tips an edge-landing over both get stronger with it.
const GRAVITY = 0.12
const MU_FRICTION = 0.8
const MU_ROLLING = 0.12
const RESTITUTION = 0.2
const AIR_DAMP = 0.98
const BOUNCE_VEL = 0.4
const SLEEP_LIN = 0.008
const SLEEP_ANG = 0.004

/** Contact with the flat window: bounce, then settle, tip, and fall asleep. */
function resolveWindow(b: Body): void {
  const wv = worldVerts(b)
  let maxPen = 0
  const contacts: Vec3[] = []

  for (const v of wv) {
    if (v[2] < WIN_Z) continue
    if (Math.sqrt(v[0] * v[0] + v[1] * v[1]) > WIN_R) continue
    maxPen = Math.max(maxPen, v[2] - WIN_Z)
    contacts.push(v)
  }
  if (contacts.length === 0) return

  b.pos[2] -= maxPen
  const sp = v3.sc(
    contacts.reduce<Vec3>((a, c) => v3.add(a, c), [0, 0, 0]),
    1 / contacts.length,
  )

  if (b.vel[2] > BOUNCE_VEL) {
    b.vel[2] = -b.vel[2] * RESTITUTION
    const r = v3.sub(sp, b.pos)
    const vTan: Vec3 = [b.vel[0], b.vel[1], 0]
    const vtLen = v3.len(vTan)
    if (vtLen > 0.01) {
      const fDir = v3.sc(v3.nrm(vTan), -Math.min(MU_FRICTION * Math.abs(b.vel[2]), vtLen))
      b.vel = v3.add(b.vel, fDir)
      b.w = v3.add(b.w, v3.sc(v3.cross(r, fDir), 1 / INERTIA))
    }
    return
  }

  if (b.vel[2] > 0) b.vel[2] = 0
  const r = v3.sub(sp, b.pos)
  const N = MASS * GRAVITY

  // Torque from gravity about the contact point: this is what tips a die that
  // landed on an edge over onto a face.
  b.w = v3.add(b.w, v3.sc([-r[1] * N, r[0] * N, 0], 1 / INERTIA))

  const vContact = v3.add(b.vel, v3.cross(b.w, r))
  const vTan: Vec3 = [vContact[0], vContact[1], 0]
  const vtLen = v3.len(vTan)
  if (vtLen > 0.001) {
    const fDir = v3.sc(v3.nrm(vTan), -Math.min(MU_FRICTION * N, vtLen * 0.5))
    b.vel = v3.add(b.vel, v3.sc(fDir, 1 / MASS))
    b.w = v3.add(b.w, v3.sc(v3.cross(r, fDir), 1 / INERTIA))
  }

  const wLen = v3.len(b.w)
  if (wLen > 0.0005) {
    const rollDamp = Math.min((MU_ROLLING * N) / INERTIA, wLen)
    b.w = v3.add(b.w, v3.sc(b.w, -rollDamp / wLen))
  }

  if (v3.len(b.vel) < SLEEP_LIN && v3.len(b.w) < SLEEP_ANG) {
    b.vel = [0, 0, 0]
    b.w = [0, 0, 0]
    b.asleep = true
  }
}

/** Contact with the spherical wall: push out and bounce off. */
function resolveSphere(b: Body): void {
  for (const v of worldVerts(b)) {
    const d = v3.len(v)
    if (d <= R) continue
    const n = v3.sc(v, 1 / d)
    b.pos = v3.sub(b.pos, v3.sc(n, d - R))
    const vn = v3.dot(b.vel, n)
    if (vn <= 0) continue

    b.vel = v3.sub(b.vel, v3.sc(n, vn * (1 + RESTITUTION)))
    const r = v3.sub(v, b.pos)
    const vContact = v3.add(b.vel, v3.cross(b.w, r))
    const vTan = v3.sub(vContact, v3.sc(n, v3.dot(vContact, n)))
    const vtLen = v3.len(vTan)
    if (vtLen > 0.01) {
      const fDir = v3.sc(v3.nrm(vTan), -Math.min(MU_FRICTION * Math.abs(vn), vtLen * 0.3))
      b.vel = v3.add(b.vel, fDir)
      b.w = v3.add(b.w, v3.sc(v3.cross(r, fDir), 1 / INERTIA))
    }
  }
}

/** Advance one fixed step. A sleeping body is left alone. */
export function stepBody(b: Body): void {
  if (b.asleep) return

  b.vel[2] += GRAVITY
  b.vel = v3.sc(b.vel, AIR_DAMP)
  b.w = v3.sc(b.w, AIR_DAMP)
  b.pos = v3.add(b.pos, b.vel)

  const wl = v3.len(b.w)
  if (wl > 1e-8) b.q = qNorm(qMul(qAA(v3.sc(b.w, 1 / wl), wl), b.q))

  resolveWindow(b)
  resolveSphere(b)
}

// ─── Look-ahead ──────────────────────────────────────────────────────
/**
 * How long the die must hold a squarely-presented face before the tumble is
 * over. The solver's own `asleep` test is far stricter than the eye — air
 * damping needs several seconds to fall below it, long after the die has
 * visibly stopped — so these decide it instead. The linear tolerance is loose
 * on purpose: what is left by then is a slow drift along the glass, which the
 * reading-pose ease cancels anyway.
 */
const CALM_FRAMES = 6
const CALM_LINEAR = 0.4
const CALM_ANGULAR = 0.006

/** Hard cap on a tumble, in fixed 60Hz steps. 240 = four seconds. */
export const MAX_TUMBLE_STEPS = 240

export interface Tumble {
  /** The face that ends up presented at the window. */
  face: number
  /** How many fixed steps it takes to get there. */
  steps: number
}

/**
 * Run a whole tumble on a copy of the body and report where it ends up.
 *
 * `stepBody` is deterministic and draws no randomness of its own, so the live
 * body replaying the same number of steps from the same throw lands on exactly
 * this face — verified bit-identical across ragged frame batching. That is what
 * lets the answer be known before the first frame is drawn: the die is not
 * being steered toward a chosen answer, the simulation has simply already been
 * run. Costs ~0.1ms.
 */
export function planTumble(start: Body): Tumble {
  const b = cloneBody(start)
  let calm = 0
  for (let step = 1; step <= MAX_TUMBLE_STEPS; step++) {
    stepBody(b)
    const settled = isFlatOnWindow(b) && v3.len(b.vel) < CALM_LINEAR && v3.len(b.w) < CALM_ANGULAR
    calm = settled ? calm + 1 : 0
    if (b.asleep || calm >= CALM_FRAMES) return { face: faceAtWindow(b), steps: step }
  }
  return { face: faceAtWindow(b), steps: MAX_TUMBLE_STEPS }
}

/**
 * Peak initial angular velocity per axis, in radians per step.
 *
 * Raising this is the dial for how much the die visibly spins on its way down.
 * It is not free: `AIR_DAMP` has to bleed the spin off before `isFlatOnWindow`
 * will hold for CALM_FRAMES, so a faster die spends longer settling and more
 * throws end on the MAX_TUMBLE_STEPS backstop instead of coming to rest on
 * their own. Measured over 200 seeded shakes — median steps, then backstop rate:
 *
 *   0.06 →  93, 1%    0.10 → 101, 3%    0.14 → 121, 5%
 *   0.20 → 132, 12%   0.30 → 148, 13%
 *
 * 0.14 is a bit over twice the original throw and still lands 19 in 20 under
 * its own steam. Past that the curve turns over: the die is spinning too hard
 * to go quiet inside four seconds and the backstop starts doing the work.
 */
const SHAKE_SPIN = 0.14

/** Throw the die back into the cavity with a random tumble. */
export function shakeBody(b: Body, rng: () => number): void {
  b.pos = [0, 0, -R * 0.3]
  b.q = qAA([rng() || 0.1, rng() || 0.1, rng() || 0.1], rng() * 4)
  b.vel = [(rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6, 0.3 + rng() * 0.3]
  b.w = [
    (rng() - 0.5) * SHAKE_SPIN,
    (rng() - 0.5) * SHAKE_SPIN,
    (rng() - 0.5) * SHAKE_SPIN,
  ]
  b.asleep = false
}
