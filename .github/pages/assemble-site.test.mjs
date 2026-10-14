/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {assembleSite, EXAMPLES, SHARED_ASSETS} from './assemble-site.mjs';

const landing = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function fixture(t, omittedExample) {
  const root = mkdtempSync(join(tmpdir(), 'webmcp-pages-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, '.github/pages'), {recursive: true});
  writeFileSync(join(root, '.github/pages/index.html'), landing);
  for (const example of EXAMPLES) {
    if (example === omittedExample) continue;
    const dist = join(root, 'examples', example, 'dist');
    mkdirSync(join(dist, 'assets'), {recursive: true});
    writeFileSync(join(dist, 'index.html'), `<script src="./assets/${example}.js"></script>`);
    writeFileSync(join(dist, 'assets', `${example}.js`), `// ${example}`);
    for (const asset of SHARED_ASSETS) {
      writeFileSync(
        join(root, 'examples', example, asset),
        Buffer.concat([Buffer.from([0, 255, 254, 10]), Buffer.from(`${example}/${asset}`)]),
      );
    }
  }
  return root;
}

test('assembles the real landing page and all six example builds', t => {
  const root = fixture(t);
  const site = join(root, '_site');
  assembleSite(root, site);
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), landing);
  for (const example of EXAMPLES) {
    assert.equal(
      readFileSync(join(site, 'examples', example, 'index.html'), 'utf8'),
      `<script src="./assets/${example}.js"></script>`,
    );
    assert.equal(
      readFileSync(join(site, 'examples', example, 'assets', `${example}.js`), 'utf8'),
      `// ${example}`,
    );
    for (const asset of SHARED_ASSETS) {
      assert.deepEqual(
        readFileSync(join(site, 'examples', example, asset)),
        readFileSync(join(root, 'examples', example, asset)),
      );
    }
  }
  assert.equal(existsSync(join(site, '.github')), false);
});

test('fails clearly before creating output if an example build is missing or invalid', t => {
  const root = fixture(t, 'password');
  const site = join(root, '_site');
  const error = {message: 'Required example build is missing or not a directory: password/dist'};
  assert.throws(() => assembleSite(root, site), error);
  assert.equal(existsSync(site), false);
  mkdirSync(join(root, 'examples', 'password'));
  writeFileSync(join(root, 'examples', 'password', 'dist'), 'not a directory');
  assert.throws(() => assembleSite(root, site), error);
  assert.equal(existsSync(site), false);
});

test('fails clearly before creating output if shared artwork is missing or invalid', t => {
  for (const asset of SHARED_ASSETS) {
    const root = fixture(t);
    const site = join(root, '_site');
    const path = join(root, 'examples', 'todo', asset);
    const error = {message: `Required shared example asset is missing or not a file: todo/${asset}`};
    rmSync(path);
    assert.throws(() => assembleSite(root, site), error);
    assert.equal(existsSync(site), false);
    mkdirSync(path);
    assert.throws(() => assembleSite(root, site), error);
    assert.equal(existsSync(site), false);
  }
});

test('does not write the site over its source directory', t => {
  const root = fixture(t);
  assert.throws(() => assembleSite(root, root), /separate from the source/);
});

test('the Pages command assembles the same site from the public repository root', t => {
  const root = fixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./assemble-site.mjs', import.meta.url))],
    {cwd: root, encoding: 'utf8'},
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, '_site/index.html'), 'utf8'), landing);
});

test('every example link works at a nested project Pages or fork base', () => {
  const links = [...landing.matchAll(/href="([^"]+)"/g)]
    .map(match => match[1])
    .filter(link => link.startsWith('./examples/') && link.endsWith('/'));
  assert.deepEqual(links, EXAMPLES.map(example => `./examples/${example}/`));
  for (const base of ['https://example.com/', 'https://example.com/a/fork/']) {
    for (const [index, link] of links.entries()) {
      assert.equal(new URL(link, base).href, `${base}examples/${EXAMPLES[index]}/`);
    }
  }
});

test('uses each example\'s shared artwork without automatic animation', () => {
  for (const example of EXAMPLES) {
    assert.ok(landing.includes(`src="./examples/${example}/demo-poster.webp"`));
    assert.ok(landing.includes(`src="./examples/${example}/install-qr.svg"`));
  }
  assert.equal([...landing.matchAll(/<details class="install">/g)].length, EXAMPLES.length);
  assert.doesNotMatch(landing, /src="[^"]+\.gif"|href="[^"]+\.gif"|class="card-icon"|Watch demo GIF/);
  assert.ok(landing.includes('https://wearables.developer.meta.com/docs/develop/webapps/setup/'));
});

test('links to the public WebMCP docs, testing extension, and source', () => {
  const links = new Set([...landing.matchAll(/href="([^"]+)"/g)].map(match => match[1]));
  for (const url of [
    'https://wearables.developer.meta.com/docs/develop/webapps/agent-tools',
    'https://chromewebstore.google.com/detail/meta-ray-ban-display-simu/jpjlmmodokemlepklkdbimceggpbjcll',
    'https://github.com/facebook/meta_glasses_webmcp',
  ]) {
    assert.ok(links.has(url), `Missing public resource: ${url}`);
  }
  assert.match(landing, /Get the testing extension/);
  assert.equal([...landing.matchAll(/<h1\b/g)].length, 1);
  assert.match(landing, /href="#main"/);
  assert.match(landing, /<main id="main"/);
  assert.doesNotMatch(landing, /<script\b|@import|@font-face/);
});
