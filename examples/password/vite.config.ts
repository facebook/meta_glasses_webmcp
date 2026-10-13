/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// HTTPS is opt-in via PW_CERT_DIR, for a browser that will not load a
// plain-HTTP dev server: point it at a directory holding key.pem and cert.pem,
// and set PW_HTTPS_HOST to the name on the certificate. This example uses the
// same switches as `examples/magic-ball` (MB_) and `examples/20-questions`
// (Q20_) under a PW_ prefix, so all three can be served side by side.
//
//   PW_CERT_DIR=$PWD/certs PW_HTTPS_HOST=pw.example.com \
//     yarn dev --host --port 5173 --strictPort
//
// Off by default: every other way of running this example wants plain HTTP.
const certDir = process.env.PW_CERT_DIR
// The name on the certificate. HMR has to be told it too — vite otherwise
// points the websocket at localhost, which the certificate does not cover, and
// the page loads fine but never hot-reloads.
const httpsHost = process.env.PW_HTTPS_HOST ?? 'pw.example.com'

export default defineConfig({
  server: certDir
    ? {
        https: {
          key: readFileSync(`${certDir}/key.pem`),
          cert: readFileSync(`${certDir}/cert.pem`),
        },
        hmr: { host: httpsHost, protocol: 'wss' },
      }
    : {},
})
