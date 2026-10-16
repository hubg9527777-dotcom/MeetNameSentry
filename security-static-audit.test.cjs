'use strict';
// 仅 Node 内置测试工具；不访问网络、不读取真实 Meet 姓名或配置。
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
const read = (f) => fs.readFileSync(path.join(dir,f),'utf8');
const runtime = ['background.js','content.js','popup.js','mns-raf-experiment-main.js'];

test('Manifest 版本、主机权限与最小化扩展权限保持固定', () => {
  assert.equal(manifest.manifest_version,3);
  assert.equal(manifest.version,'1.0.2');
  assert.deepEqual(manifest.permissions,['storage','scripting','alarms']);
  assert.deepEqual(manifest.host_permissions,['https://meet.google.com/*']);
  assert.equal(manifest.externally_connectable,undefined);
  assert.equal(manifest.web_accessible_resources,undefined);
});

test('扩展不得放宽默认 CSP 或引入网页可执行外链脚本', () => {
  assert.equal(manifest.content_security_policy,undefined);
  const html=read('popup.html');
  const sources=[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].map(m=>m[1]);
  assert.deepEqual(sources,['popup.js']);
  assert.doesNotMatch(html,/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i);
});

test('运行文件中不包含动态执行代码的危险入口', () => {
  for (const filename of runtime) {
    const js=read(filename);
    assert.doesNotMatch(js,/\beval\s*\(|\bnew\s+Function\s*\(|document\.write\s*\(|setTimeout\s*\(\s*["'`]/);
    assert.doesNotMatch(js,/\bfetch\s*\(|\bXMLHttpRequest\s*\(|\bnew\s+WebSocket\s*\(/);
  }
});

test('后台名单辅助必须使用本地 MAIN World 文件，不得伪装页面可见性', () => {
  const bg=read('background.js'), bridge=read('mns-raf-experiment-main.js');
  assert.match(bg,/RAF_EXPERIMENT_FILE\s*=\s*'mns-raf-experiment-main\.js'/);
  assert.match(bg,/world:\s*'MAIN'/);
  assert.match(bridge,/HIDDEN_FALLBACK_MS\s*=\s*250/);
  assert.doesNotMatch(bridge,/defineProperty\(\s*Document\.prototype/);
});

test('健康消息和后台辅助开关均校验内部发信来源', () => {
  assert.match(read('content.js'),/sender\?\.id\s*!==\s*chrome\.runtime\.id/);
  assert.match(read('background.js'),/sender\?\.url\s*!==\s*settingsURL/);
});

test('Git 忽略文件包含常见明文凭据与本机产物', () => {
  const ignore=read('.gitignore');
  for (const item of ['.env','*.pem','*.key','node_modules/','*.log']) assert.ok(ignore.includes(item));
});
