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
import {runInNewContext} from 'node:vm';
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
  const links = [...new Set([...landing.matchAll(/href="([^"]+)"/g)]
    .map(match => match[1])
    .filter(link => link.startsWith('./examples/') && link.endsWith('/')))];
  assert.deepEqual(links, EXAMPLES.map(example => `./examples/${example}/`));
  for (const base of ['https://example.com/', 'https://example.com/a/fork/']) {
    for (const [index, link] of links.entries()) {
      assert.equal(new URL(link, base).href, `${base}examples/${EXAMPLES[index]}/`);
    }
  }
});

test('uses shared artwork with accessible flip controls and no automatic GIF playback', () => {
  for (const example of EXAMPLES) {
    assert.ok(landing.includes(`src="./examples/${example}/demo-poster.webp"`));
    assert.ok(landing.includes(`src="./examples/${example}/install-qr.svg"`));
    assert.ok(landing.includes(`href="./examples/${example}/install-qr.svg"`));
  }
  const controls = [...landing.matchAll(/<button class="install-toggle"[^>]+aria-controls="([^"]+)"/g)].map(match => match[1]);
  assert.equal(controls.length, EXAMPLES.length);
  assert.equal(new Set(controls).size, EXAMPLES.length);
  for (const id of controls) assert.ok(landing.includes(`id="${id}"`));
  assert.equal([...landing.matchAll(/class="flip-face flip-back" aria-hidden="true" inert/g)].length, EXAMPLES.length);
  assert.doesNotMatch(landing, /src="[^"]+\.gif"|href="[^"]+\.gif"|class="card-icon"|Watch demo GIF/);
  assert.ok(landing.includes('https://wearables.developer.meta.com/docs/develop/webapps/setup/'));
});

function flipFixture() {
  function element(initial) {
    const attrs = new Map(Object.entries(initial));
    return {
      getAttribute: name => attrs.get(name),
      setAttribute: (name, value) => attrs.set(name, value),
    };
  }
  const cases = EXAMPLES.map((name, index) => {
    const front = {...element({'aria-hidden': 'false'}), inert: false};
    const back = {...element({'aria-hidden': 'true'}), inert: true};
    const classes = new Set();
    const preview = {
      classList: {toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)},
      querySelector: selector => selector === '.flip-front' ? front : back,
    };
    const label = {textContent: 'Install on glasses'};
    const fallback = {hidden: false};
    const card = {querySelector: selector => selector === 'h3' ? {textContent: name} : fallback};
    const handlers = new Map();
    const button = {
      ...element({'aria-expanded': 'false', 'aria-controls': `preview-${index}`}),
      hidden: true,
      querySelector: () => label,
      closest: () => card,
      addEventListener: (event, handler) => handlers.set(event, handler),
    };
    return {name, front, back, preview, classes, label, fallback, card, handlers, button};
  });
  const document = {
    querySelectorAll: () => cases.map(item => item.button),
    getElementById: id => cases.find(item => item.button.getAttribute('aria-controls') === id)?.preview ?? null,
  };
  return {cases, document};
}

function runFlipSetup(document) {
  const script = landing.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {document});
}

test('the shipped flip handler updates each label and accessible face state independently', () => {
  const {cases, document} = flipFixture();
  runFlipSetup(document);
  for (const item of cases) {
    assert.equal(item.button.hidden, false);
    assert.equal(item.fallback.hidden, true);
    item.handlers.get('click')();
    assert.equal(item.classes.has('is-flipped'), true);
    assert.equal(item.button.getAttribute('aria-expanded'), 'true');
    assert.equal(item.label.textContent, 'Back to preview');
    assert.equal(item.button.getAttribute('aria-label'), `Back to preview: ${item.name}`);
    assert.equal(item.front.inert, true);
    assert.equal(item.front.getAttribute('aria-hidden'), 'true');
    assert.equal(item.back.inert, false);
    assert.equal(item.back.getAttribute('aria-hidden'), 'false');
    for (const other of cases.filter(other => other !== item)) {
      assert.equal(other.button.getAttribute('aria-expanded'), 'false');
    }
    item.handlers.get('click')();
    assert.equal(item.classes.has('is-flipped'), false);
    assert.equal(item.button.getAttribute('aria-expanded'), 'false');
    assert.equal(item.label.textContent, 'Install on glasses');
    assert.equal(item.button.getAttribute('aria-label'), `Install on glasses: ${item.name}`);
    assert.equal(item.front.inert, false);
    assert.equal(item.front.getAttribute('aria-hidden'), 'false');
    assert.equal(item.back.inert, true);
    assert.equal(item.back.getAttribute('aria-hidden'), 'true');
  }
});

test('incomplete cards keep their QR fallback without preventing later cards from initializing', () => {
  for (const missing of ['preview', '.flip-front', '.flip-back', 'label', 'card', 'h3', '.install-fallback']) {
    const {cases, document} = flipFixture();
    const first = cases[0];
    if (missing === 'preview') first.preview = null;
    else if (missing === 'label') first.button.querySelector = () => null;
    else if (missing === 'card') first.button.closest = () => null;
    else if (missing.startsWith('.flip-')) {
      const query = first.preview.querySelector;
      first.preview.querySelector = selector => selector === missing ? null : query(selector);
    } else {
      const query = first.card.querySelector;
      first.card.querySelector = selector => selector === missing ? null : query(selector);
    }
    assert.doesNotThrow(() => runFlipSetup(document));
    assert.equal(first.button.hidden, true);
    assert.equal(first.fallback.hidden, false);
    assert.equal(first.handlers.size, 0);
    for (const item of cases.slice(1)) {
      assert.equal(item.button.hidden, false);
      assert.equal(item.fallback.hidden, true);
      item.handlers.get('click')();
      assert.equal(item.button.getAttribute('aria-expanded'), 'true');
    }
  }
});

test('links to public resources without adding external scripts or font dependencies', () => {
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
  assert.equal([...landing.matchAll(/<script>/g)].length, 1);
  assert.doesNotMatch(landing, /<script\b[^>]*src=|@import|@font-face/);
});
