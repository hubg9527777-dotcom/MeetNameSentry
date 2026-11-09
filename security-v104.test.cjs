'use strict';
// v1.0.4 regression/security guard: native Node tests; no Meet, credentials or network required.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const read = (file) => fs.readFileSync(path.join(dir,file),'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('v1.0.4: manifest, popup, content and worker advertise a consistent fixed version', () => {
  assert.equal(manifest.version, '1.0.4');
  assert.match(read('popup.html'), />v1\.0\.4<\/span>/);
  assert.match(read('content.js'), /version:\s*'1\.0\.4'/);
  assert.match(read('content.js'), /巡检引擎已挂载 v1\.0\.4/);
  assert.match(read('background.js'), /MeetNameSentry v1\.0\.4/);
  assert.match(read('mns-raf-experiment-main.js'), /MeetNameSentry v1\.0\.4/);
  for (const file of ['background.js','content.js','popup.html','mns-raf-experiment-main.js']) {
    assert.doesNotMatch(read(file), /v1\.0\.3|['"]1\.0\.3['"]/);
  }
});

test('v1.0.4: keep persistent rAF registration identifiers for existing users', () => {
  assert.match(read('background.js'), /RAF_EXPERIMENT_KEY\s*=\s*'mnsRafExperimentEnabled'/);
  assert.match(read('background.js'), /RAF_DEFAULT_ENABLED\s*=\s*true/);
  assert.match(read('background.js'), /RAF_EXPERIMENT_ID\s*=\s*'mns-raf-exp-v102'/);
  assert.match(read('background.js'), /RAF_EXPERIMENT_FILE\s*=\s*'mns-raf-experiment-main\.js'/);
  assert.match(read('popup.js'), /MNS_RAF_EXP_V102/);
});

test('v1.0.4: extension permissions, local script-only execution and no network export', () => {
  assert.deepEqual(manifest.permissions, ['storage','scripting','alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*']);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  for (const file of ['content.js','background.js','popup.js','mns-raf-experiment-main.js']) {
    const source=read(file);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(|\bfetch\s*\(|\bXMLHttpRequest\s*\(/);
  }
});

test('v1.0.4: popup management message validates its origin and removes error text', () => {
  const src=read('background.js');
  assert.match(src, /sender\?\.url\s*!==\s*settingsURL\s*\|\|\s*sender\?\.tab/);
  assert.match(src, /sendResponse\(\{ok:false,error:safeErrorKind\(error\)\}\)/);
  assert.doesNotMatch(src, /sendResponse\(\{ok:false,error:error\?\.name/);
});

test('v1.0.4: .gitignore covers common secrets and generated files', () => {
  const src=read('.gitignore');
  for (const pattern of ['.env','*.pem','*.key','*.p8','.npmrc','.pypirc','*.sqlite','*.log','*.zip'])
    assert.ok(src.split(/\r?\n/).includes(pattern), 'missing .gitignore pattern '+pattern);
});

test('v1.0.4: icon SVG does not contain active scripts or remote media', () => {
  const src=read('icons/icon.svg');
  assert.doesNotMatch(src, /<script\b|<foreignObject\b|\bon\w+\s*=|<image\b|<use\b|\bhref\s*=|\burl\(\s*https?:/i);
});
