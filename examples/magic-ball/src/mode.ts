/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Which of the two balls this page is.
//
// `ai`  — the shipped one. The agent decides what the ball says and the die is
//         made to carry its words. Questions do not have to be yes-or-no and
//         answers do not have to be one of the twenty.
// `die` — the fair one. A real tumble picks one of the twenty stock replies
//         and the agent reads back whatever face wins. Nobody, including the
//         agent, gets a say.
//
// Only `magic_ball_ask` differs between them: `Ball` is mode-agnostic,
// and the physics, the look-ahead and the rendering are identical either way.
//
// There is deliberately NO runtime switch — no toggle, no query parameter, no
// stored preference. The mode is a property of the build, because a ball that
// can quietly change which kind of ball it is produces exactly the confusing
// session this constant exists to prevent.
//
// Both sets of prompts are kept, so switching is a switch and not a rewrite.
// To ship the fair die instead, change three things:
//
//   1. `MODE` below                       -> 'die'
//   2. the `<title>` in index.html        -> the die title, in the comment above it
//   3. public/llms.txt                    -> replace with public/llms.die.md
//
// The tool descriptions need no change: both variants live in mcp.ts and the
// constant below picks which one registers.

export type BallMode = 'die' | 'ai'

export const MODE: BallMode = 'ai'
