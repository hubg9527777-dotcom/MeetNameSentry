// 运行：node --test security.test.cjs；无第三方依赖，不连接真实会议。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function element(text = '', children = [], attributes = {}) {
  return {
    textContent: text, isConnected: true, children: [],
    getClientRects: () => [1],
    getAttribute: (key) => attributes[key] ?? null,
    matches: (selector) => selector.includes(':disabled') ? !!attributes.disabled : selector.includes('menu') && attributes.role === 'menu',
    querySelectorAll: (selector) => selector.includes('checkbox') ? [] : children,
    contains: (other) => children.includes(other),
    closest: () => null,
    focus() {}, click() {}, dispatchEvent() {},
  };
}

function harness() {
  const callbacks = [], logs = [];
  const document = {
    querySelectorAll: () => [], getElementById: () => null,
    body: element(), documentElement: element(), activeElement: null,
  };
  const context = vm.createContext({
    window: {}, document, AbortController, Set, Map, Date, Object,
    getComputedStyle: () => ({ visibility: 'visible' }),
    chrome: { runtime: { id: 'test' }, storage: { sync: { get: (_defaults, cb) => callbacks.push(cb) } } },
    console: Object.fromEntries(['warn', 'log', 'info', 'error'].map((k) => [k, (...args) => logs.push(args)])),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    KeyboardEvent: class {},
  });
  let source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const start = source.indexOf('  /* ════════════════════════ 12. 启动');
  assert.ok(start > 0);
  source = source.slice(0, start) + `
    globalThis.api = {
      applyConfig, loadConfig, onStorageChanged, cfg, state, assertActive, locateTarget,
      norm, evaluate, findRemoveItem, findConfirmButton, kick, dismissOverlays, openMenu,
      revision: () => configRevision, ready: () => configReady,
      rows: (rows) => { readRows = () => rows; },
      wait: (fn) => { waitFor = fn; },
      menu: (fn) => { openMenu = fn; },
    };
    hud.set = () => {};
  })();`;
  vm.runInContext(source, context);
  return { api: context.api, callbacks, context, document, logs };
}

test('配置读取失败时停止，不能退回默认自动移出', async () => {
  const h = harness();
  h.api.applyConfig({});
  const pending = h.api.loadConfig();
  assert.equal(h.api.ready(), false);
  h.context.chrome.runtime.lastError = { message: 'unavailable' };
  h.callbacks[0](undefined);
  await pending;
  assert.equal(h.api.cfg.enabled, false);
  assert.equal(h.api.ready(), false);
});

test('乱序读取不会恢复过期配置', async () => {
  const h = harness();
  const older = h.api.loadConfig(), newer = h.api.loadConfig();
  h.callbacks[1]({ enabled: false });
  h.callbacks[0]({ enabled: true });
  await Promise.all([older, newer]);
  assert.equal(h.api.cfg.enabled, false);
});

test('存储变更立即撤销授权，即使新的配置尚未返回', () => {
  const h = harness();
  h.api.applyConfig({});
  const rev = h.api.revision();
  h.api.onStorageChanged({ dryRun: { newValue: true } }, 'sync');
  assert.throws(() => h.api.assertActive(rev, 0), /aborted/);
});

test('异常类型配置拒绝执行', () => {
  const h = harness();
  assert.throws(() => h.api.applyConfig({ enabled: 'false' }), /invalid-config/);
  assert.throws(() => h.api.applyConfig({ requiredKeywords: {} }), /invalid-config/);
});

test('原有规范化及白名单判定保持兼容', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'ＡＡ，BB', exactWhitelist: 'Alice\nBob', keywordWhitelist: 'TA' });
  assert.equal(h.api.norm(' ＡＡ\u200b '), 'aa');
  for (const nameN of ['aa student', 'bb student', 'alice', 'ta helper']) {
    assert.equal(h.api.evaluate({ nameN }).ok, true);
  }
  assert.equal(h.api.evaluate({ nameN: 'mallory' }).ok, false);
});

test('额外移出文案只能完整匹配，歧义/隐藏/禁用项拒绝', () => {
  const h = harness();
  h.api.applyConfig({ extraRemoveLabels: '特殊移出' });
  const right = element('特殊移出');
  assert.equal(h.api.findRemoveItem(element('', [right])), right);
  assert.equal(h.api.findRemoveItem(element('', [element('特殊移出所有人')])), null);
  assert.equal(h.api.findRemoveItem(element('', [right, element('Remove from call')])), null);
  assert.equal(h.api.findRemoveItem(element('', [element('Remove from call', [], { disabled: true })])), null);
  const hidden = element('Remove from call'); hidden.getClientRects = () => [];
  assert.equal(h.api.findRemoveItem(element('', [hidden])), null);
});

test('未知确认按钮、举报和多个破坏性按钮不能触发确认', () => {
  const h = harness();
  assert.equal(h.api.findConfirmButton(element('', [element('Cancel'), element('Continue')])), null);
  assert.equal(h.api.findConfirmButton(element('', [element('Cancel'), element('Remove and report')])), null);
  assert.equal(h.api.findConfirmButton(element('', [element('Remove'), element('Remove all')])), null);
  const remove = element('Remove');
  assert.equal(h.api.findConfirmButton(element('', [element('Cancel'), remove])), remove);
});

test('重复 key、目标换名或已合规均拒绝', () => {
  const h = harness();
  h.api.applyConfig({});
  const target = { key: 'p1', nameN: 'mallory' };
  h.api.rows([target, { ...target }]);
  assert.throws(() => h.api.locateTarget(target), /stale/);
  h.api.rows([{ ...target, nameN: 'eve' }]);
  assert.throws(() => h.api.locateTarget(target), /stale/);
  h.api.rows([{ ...target, isHost: true }]);
  assert.throws(() => h.api.locateTarget(target), /stale/);
});

function kickFixture(h, change) {
  let clicks = 0;
  const row = element(), moreBtn = element();
  const target = { row, moreBtn, key: 'p1', name: 'PRIVATE-NAME', nameN: 'private-name' };
  const remove = element('Remove from call'), confirm = element('Remove');
  const menu = element('', [remove]), dialog = element('Remove PRIVATE-NAME?', [confirm]);
  confirm.click = () => { clicks++; dialog.isConnected = false; };
  h.api.rows([target]);
  h.api.menu(async () => menu);
  let phase = 0;
  h.api.wait(async () => {
    if (++phase === 1) { change?.(h, target); return dialog; }
    return true;
  });
  return { target, clicks: () => clicks };
}

for (const [label, change] of [
  ['启用试运行', (h) => h.api.applyConfig({ dryRun: true })],
  ['清空规则', (h) => h.api.applyConfig({ dryRun: false, requiredKeywords: '' })],
  ['关闭巡检', (h) => h.api.applyConfig({ dryRun: false, enabled: false })],
  ['变更白名单', (h) => h.api.applyConfig({ dryRun: false, exactWhitelist: 'PRIVATE-NAME' })],
  ['用户接管', (h) => { h.api.state.lastInput = 1; }],
  ['目标换名', (_h, target) => { target.nameN = 'someone-else'; }],
]) {
  test(`对话框等待期间${label}，不得点击确认`, async () => {
    const h = harness(); h.api.applyConfig({ dryRun: false });
    const f = kickFixture(h, change);
    // 保存采集时的身份，模拟实际 readRows 的新对象。
    await h.api.kick({ ...f.target });
    assert.equal(f.clicks(), 0);
  });
}

test('正常移出路径通过且控制台不含姓名', async () => {
  const h = harness(); h.api.applyConfig({ dryRun: false });
  const f = kickFixture(h);
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 1);
  assert.equal(h.api.state.kicked, 1);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE-NAME'), false);
});

test('不接管已有菜单/对话框', async () => {
  const h = harness(); h.api.applyConfig({ dryRun: false });
  h.document.querySelectorAll = () => [element()];
  const f = kickFixture(h);
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 0);
});

test('用户接管后不清理浮层', async () => {
  const h = harness();
  const cancel = element('Cancel');
  let clicks = 0; cancel.click = () => clicks++;
  h.api.state.lastInput = 1;
  await h.api.dismissOverlays({ dialog: element('', [cancel]), menu: null }, 0);
  assert.equal(clicks, 0);
});

test('设置读取失败时禁用表单且不保存默认值', () => {
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, { value: '', addEventListener() {} }]));
  let saved = false;
  const context = {
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime: { lastError: { message: 'failure' } }, storage: { sync: { get: (_d, cb) => cb({}), set: () => { saved = true; } } } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  assert.equal(fields.enabled.disabled, true);
  assert.equal(saved, false);
  assert.match(fields.status.textContent, /读取配置失败/);
});

test('扩展资源存在，权限仅 storage，无远程脚本', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://meet.google.com/*']);
  const files = [manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((s) => s.js)];
  for (const file of files) assert.ok(fs.existsSync(path.join(__dirname, file)), file);
  const html = fs.readFileSync(path.join(__dirname, manifest.action.default_popup), 'utf8');
  assert.match(html, /<script src="popup\.js"><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/);
});


test('首次读取默认试运行，不点击任何移出按钮', async () => {
  const h = harness();
  const pending = h.api.loadConfig();
  h.callbacks[0]({});
  await pending;
  assert.equal(h.api.cfg.enabled, true);
  assert.equal(h.api.cfg.dryRun, true);
  const f = kickFixture(h);
  let menuOpened = false;
  h.api.menu(async () => { menuOpened = true; throw new Error('不应打开菜单'); });
  await h.api.kick({ ...f.target });
  assert.equal(menuOpened, false);
  assert.equal(f.clicks(), 0);
});

test('已有 dryRun=false 配置保留，仍可正常移出', async () => {
  const h = harness();
  const pending = h.api.loadConfig();
  h.callbacks[0]({ dryRun: false });
  await pending;
  assert.equal(h.api.cfg.dryRun, false);
  const f = kickFixture(h);
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 1);
});

for (const stored of [{}, { dryRun: false }]) {
  test(`设置界面正确显示${Object.hasOwn(stored, 'dryRun') ? '已有实际移出设置' : '首次默认试运行'}`, () => {
    const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, { value: '', addEventListener() {} }]));
    let saved = false;
    const context = {
      document: { getElementById: (id) => fields[id] }, TextEncoder,
      chrome: { runtime: {}, storage: { sync: {
        get: (defaults, cb) => cb({ ...defaults, ...stored }),
        set: () => { saved = true; },
      } } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
    assert.equal(fields.dryRun.checked, stored.dryRun ?? true);
    assert.equal(fields.enabled.disabled, false);
    assert.equal(saved, false);
  });
}
