/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {copyFileSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const EXAMPLES = Object.freeze([
  'todo',
  'market',
  'solitaire',
  'magic-ball',
  'password',
  '20-questions',
]);

export const SHARED_ASSETS = Object.freeze([
  'demo-poster.webp',
  'demo.gif',
  'install-qr.svg',
]);

export function assembleSite(sourceRoot, outputRoot) {
  const landing = readFileSync(resolve(sourceRoot, '.github/pages/index.html'));
  const builds = EXAMPLES.map(name => ({
    name,
    path: resolve(sourceRoot, 'examples', name, 'dist'),
  }));
  for (const build of builds) {
    if (!statSync(build.path, {throwIfNoEntry: false})?.isDirectory()) {
      throw new Error(`Required example build is missing or not a directory: ${build.name}/dist`);
    }
    for (const asset of SHARED_ASSETS) {
      const path = resolve(sourceRoot, 'examples', build.name, asset);
      if (!statSync(path, {throwIfNoEntry: false})?.isFile()) {
        throw new Error(`Required shared example asset is missing or not a file: ${build.name}/${asset}`);
      }
    }
  }
  if (resolve(sourceRoot) === resolve(outputRoot)) {
    throw new Error('Site output must be separate from the source directory');
  }

  mkdirSync(outputRoot, {recursive: true});
  writeFileSync(resolve(outputRoot, 'index.html'), landing);
  for (const build of builds) {
    const destination = resolve(outputRoot, 'examples', build.name);
    cpSync(build.path, destination, {recursive: true});
    for (const asset of SHARED_ASSETS) {
      copyFileSync(
        resolve(sourceRoot, 'examples', build.name, asset),
        resolve(destination, asset),
      );
    }
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  assembleSite(process.cwd(), resolve('_site'));
}
