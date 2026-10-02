/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    open: false,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },
});
