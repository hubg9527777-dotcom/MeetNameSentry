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
    matches: (selector) => selector.includes(':disabled') ? !!attributes.disabled : selector === 'button, [role="button"]' ? attributes.role === 'button' : selector.includes('menu') && attributes.role === 'menu',
    querySelectorAll: (selector) => selector.includes('checkbox') ? [] : children,
    contains: (other) => children.includes(other),
    closest: () => null,
    focus() {}, click() {}, dispatchEvent() {},
  };
}

function harness() {
  const callbacks = [], logs = [], observers = [], timers = [];
  const document = {
    querySelectorAll: () => [], getElementById: () => null,
    body: element(), documentElement: element(), activeElement: null,
  };
  const context = vm.createContext({
    window: {}, document, AbortController, Set, Map, Date, Object,
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(root) { this.root = root; } disconnect() { this.disconnected = true; } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    chrome: { runtime: { id: 'test' }, storage: { sync: { get: (_defaults, cb) => callbacks.push(cb) } } },
    console: Object.fromEntries(['warn', 'log', 'info', 'error'].map((k) => [k, (...args) => logs.push(args)])),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    KeyboardEvent: class {},
  });
  let source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const start = source.indexOf('  /* ════════════════════════ 12. 启动');
  assert.ok(start > 0);
  source = source.slice(0, start) + `
    globalThis.api = {
      applyConfig, loadConfig, onStorageChanged, cfg, state, assertActive, locateTarget,
      norm, evaluate, findRemoveItem, findConfirmButton, kick, dismissOverlays, openMenu,
      peopleToggle, findRowsRaw, ensurePeoplePanel, attachListObserver, runCycle, tick,
      revision: () => configRevision, ready: () => configReady,
      rows: (rows) => { readRows = () => rows; },
      wait: (fn) => { waitFor = fn; },
      menu: (fn) => { openMenu = fn; },
    };
    hud.set = () => {};
  })();`;
  vm.runInContext(source, context);
  return { api: context.api, callbacks, context, document, logs, observers, timers };
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


test('首次读取默认关闭试运行，可正常执行移出', async () => {
  const h = harness();
  const pending = h.api.loadConfig();
  h.callbacks[0]({});
  await pending;
  assert.equal(h.api.cfg.enabled, true);
  assert.equal(h.api.cfg.dryRun, false);
  const f = kickFixture(h);
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 1);
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
  test(`设置界面正确显示${Object.hasOwn(stored, 'dryRun') ? '已有实际移出设置' : '首次默认关闭试运行'}`, () => {
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
    assert.equal(fields.dryRun.checked, stored.dryRun ?? false);
    assert.equal(fields.enabled.disabled, false);
    assert.equal(saved, false);
  });
}


function panelFixture(h, attributes = { role: 'button', 'data-panel-id': '1' }) {
  const button = element('', [], attributes);
  const root = element();
  const row = element('Alice');
  row.parentElement = root;
  row.closest = (selector) => selector === '[role="list"]' ? root : null;
  let rows = [], clicks = 0;
  root.querySelectorAll = () => rows;
  button.click = () => { clicks++; };
  h.document.querySelectorAll = (selector) => {
    if (selector === 'button, [role="button"]') return [button];
    if (selector === '[data-panel-id="1"]') return [root];
    if (selector === '[role="list"] [role="listitem"]') return rows;
    return [];
  };
  h.api.applyConfig({ dryRun: false });
  h.api.wait(async (probe) => probe());
  return { button, row, root, clicks: () => clicks, show: () => { rows = [row]; }, hide: () => { rows = []; } };
}

test('聊天面板已开也自动点击参与者按钮，并等待名单渲染', async () => {
  const h = harness(), p = panelFixture(h);
  const chat = element('', [], { role: 'button', 'data-panel-id': '2', 'aria-pressed': 'true' });
  const query = h.document.querySelectorAll;
  h.document.querySelectorAll = (selector) => selector === 'button, [role="button"]' ? [p.button, chat] : query(selector);
  h.api.wait(async (probe) => { p.show(); return probe(); });
  assert.equal(await h.api.ensurePeoplePanel(), true);
  assert.equal(p.clicks(), 1);
  assert.equal(h.api.state.openAttempts.length, 0);
});

test('隐藏旧按钮不遮蔽右上角可见按钮', () => {
  const h = harness(), p = panelFixture(h);
  const hidden = element('', [], { role: 'button', 'data-panel-id': '1' });
  hidden.getClientRects = () => [];
  h.document.querySelectorAll = (selector) => selector === 'button, [role="button"]' ? [hidden, p.button] : [];
  assert.equal(h.api.peopleToggle(), p.button);
});

for (const attr of ['aria-label', 'title', 'data-tooltip-text']) {
  test(`参与者按钮通过 ${attr} 识别`, () => {
    const h = harness(), p = panelFixture(h, { role: 'button', [attr]: '显示参与者' });
    assert.equal(h.api.peopleToggle(), p.button);
  });
}

test('只有实际群组图标和人数时识别参与者按钮，不按人数猜测', () => {
  const h = harness(), p = panelFixture(h, { role: 'button' });
  p.button.querySelectorAll = () => [element('group', [], { class: 'google-symbols' })];
  assert.equal(h.api.peopleToggle(), p.button);
  p.button.querySelectorAll = () => [element('2')];
  assert.equal(h.api.peopleToggle(), null);
});

test('两个同样可见的参与者按钮拒绝猜测', () => {
  const h = harness(), p = panelFixture(h);
  h.document.querySelectorAll = () => [p.button, element('', [], { role: 'button', 'data-panel-id': '1' })];
  assert.equal(h.api.peopleToggle(), null);
});

test('隐藏旧列表不阻止识别重新渲染的可见列表', () => {
  const h = harness(), p = panelFixture(h);
  const hidden = element(); hidden.getClientRects = () => [];
  p.root.querySelectorAll = () => [hidden];
  const query = h.document.querySelectorAll;
  h.document.querySelectorAll = (selector) => selector === '[role="list"] [role="listitem"]' ? [p.row] : query(selector);
  assert.equal(h.api.findRowsRaw()[0], p.row);
});

test('参与者面板已展开但尚未渲染，不再点击关闭', async () => {
  const h = harness(), p = panelFixture(h, { role: 'button', 'data-panel-id': '1', 'aria-expanded': 'true' });
  assert.equal(await h.api.ensurePeoplePanel(), false);
  assert.equal(p.clicks(), 0);
  p.show();
  assert.equal(await h.api.ensurePeoplePanel(), true);
});

test('打开失败只对面板退避，手动打开立即恢复', async () => {
  const h = harness(), p = panelFixture(h);
  h.api.state.openAttempts = [Date.now(), Date.now(), Date.now()];
  assert.equal(await h.api.ensurePeoplePanel(), false);
  assert.ok(h.api.state.panelRetryAt > Date.now());
  assert.equal(h.api.state.pausedUntil, 0);
  p.show();
  assert.equal(await h.api.ensurePeoplePanel(), true);
  assert.equal(h.api.state.panelRetryAt, 0);
});

test('等待名单时关闭扩展不得继续返回巡检就绪', async () => {
  const h = harness(), p = panelFixture(h);
  h.api.wait(async (probe) => { p.show(); h.api.applyConfig({ enabled: false }); return probe(); });
  assert.equal(await h.api.ensurePeoplePanel(), false);
});

test('输入、后台、已有对话框、关闭巡检时不抢面板', async () => {
  for (const mode of ['typing', 'hidden', 'dialog', 'disabled']) {
    const h = harness(), p = panelFixture(h);
    if (mode === 'typing') {
      h.document.activeElement = { tagName: 'INPUT' };
      h.api.state.lastInput = Date.now();
    }
    if (mode === 'hidden') h.document.hidden = true;
    if (mode === 'disabled') h.api.applyConfig({ enabled: false });
    if (mode === 'dialog') {
      const query = h.document.querySelectorAll;
      h.document.querySelectorAll = (selector) => selector.includes('alertdialog') && selector.includes('aria-modal') ? [element()] : query(selector);
    }
    assert.equal(await h.api.ensurePeoplePanel(), false, mode);
    assert.equal(p.clicks(), 0, mode);
  }
});

test('面板连续重试有节流，避免反复开关', async () => {
  const h = harness(), p = panelFixture(h);
  await h.api.ensurePeoplePanel();
  await h.api.ensurePeoplePanel();
  assert.equal(p.clicks(), 1);
});

test('列表卸载后解绑，重新打开重绑并重置扫描覆盖', () => {
  const h = harness(), p = panelFixture(h);
  p.show(); h.api.attachListObserver();
  assert.equal(h.observers.length, 1);
  h.api.state.coverage = '1/20';
  h.api.state.lastSweepAt = Date.now();
  p.hide(); h.api.attachListObserver();
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.api.state.observedList, null);
  p.show(); h.api.attachListObserver();
  assert.equal(h.observers.length, 2);
  assert.equal(h.api.state.coverage, null);
  assert.equal(h.api.state.lastSweepAt, 0);
});

test('运行周期在展开等待期间保持单飞，后续继续调度', async () => {
  const h = harness(), p = panelFixture(h);
  h.api.rows([]);
  let release;
  h.api.wait(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.api.tick();
  assert.equal(h.api.state.cycling, true);
  await h.api.tick();
  assert.equal(p.clicks(), 1);
  p.show(); release('ready');
  await pending;
  assert.equal(h.api.state.cycling, false);
  assert.ok(h.timers.some((timer) => timer.delay === 1500));
});

test('人工开面板不解除移出操作的安全熔断', async () => {
  const h = harness(), p = panelFixture(h);
  p.show(); h.api.rows([]);
  const until = Date.now() + 60000;
  h.api.state.pausedUntil = until;
  await h.api.runCycle();
  assert.equal(h.api.state.pausedUntil, until);
  assert.equal(p.clicks(), 0);
});

test('长期未就绪后手动打开，重新确认目标并恢复实际移出', async () => {
  const h = harness(), p = panelFixture(h);
  const f = kickFixture(h);
  h.api.state.openAttempts = [Date.now(), Date.now(), Date.now()];
  await h.api.runCycle();
  assert.ok(h.api.state.panelRetryAt > Date.now());
  assert.equal(f.clicks(), 0);
  p.show();
  await h.api.runCycle();
  assert.equal(h.api.state.panelRetryAt, 0);
  assert.equal(f.clicks(), 0); // 仍需第二次稳定目击，不因恢复跳过安全检查。
  h.api.state.suspects.get(f.target.key).first = Date.now() - 2000;
  await h.api.runCycle();
  assert.equal(f.clicks(), 1);
});


for (const activeElement of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
  test(`聊天输入框持续聚焦但停止操作后仍打开参与者面板：${activeElement.tagName || 'contenteditable'}`, async () => {
    const h = harness(), p = panelFixture(h);
    h.document.activeElement = activeElement;
    h.api.state.lastInput = Date.now() - 5000;
    h.api.wait(async (probe) => { p.show(); return probe(); });
    assert.equal(await h.api.ensurePeoplePanel(), true);
    assert.equal(p.clicks(), 1);
  });
}

test('实际输入后先等待，停顿3秒即使没有移走焦点也自动切换', async () => {
  const h = harness(), p = panelFixture(h);
  h.document.activeElement = { tagName: 'TEXTAREA' };
  h.api.state.lastInput = Date.now() - 1500;
  assert.equal(await h.api.ensurePeoplePanel(), false);
  assert.equal(p.clicks(), 0);
  h.api.state.lastInput = Date.now() - 3500;
  h.api.wait(async (probe) => { p.show(); return probe(); });
  assert.equal(await h.api.ensurePeoplePanel(), true);
  assert.equal(p.clicks(), 1);
});

test('首次焦点位于输入框但尚无操作，不会永久等待输入结束', async () => {
  const h = harness(), p = panelFixture(h);
  h.document.activeElement = { tagName: 'INPUT' };
  h.api.state.lastInput = 0;
  h.api.wait(async (probe) => { p.show(); return probe(); });
  assert.equal(await h.api.ensurePeoplePanel(), true);
  assert.equal(p.clicks(), 1);
});

test('已有明确开启的试运行设置保持不变', async () => {
  const h = harness();
  const pending = h.api.loadConfig();
  h.callbacks[0]({ dryRun: true });
  await pending;
  assert.equal(h.api.cfg.dryRun, true);
  const f = kickFixture(h);
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 0);
});

test('右上角参与者按钮可通过 aria-labelledby 关联文字识别', () => {
  const h = harness(), p = panelFixture(h, { role: 'button', 'aria-labelledby': 'people-label' });
  h.document.getElementById = (id) => id === 'people-label' ? { textContent: '通话中的每个人' } : null;
  assert.equal(h.api.peopleToggle(), p.button);
});

test('真实 Meet 布局：隐藏标签参与者与“与所有人聊天”同时存在仍识别正确', async () => {
  const h = harness(), p = panelFixture(h, {
    role: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-labelledby': 'DPUxh-nav9Xe',
  });
  const chat = element('', [], { role: 'button', 'aria-label': '与所有人聊天' });
  const query = h.document.querySelectorAll;
  h.document.querySelectorAll = (selector) => selector === 'button, [role="button"]' ? [chat, p.button] : query(selector);
  h.document.getElementById = (id) => id === 'DPUxh-nav9Xe' ? { textContent: '参与者' } : null;
  assert.equal(h.api.peopleToggle(), p.button);
  h.api.wait(async (probe) => { p.show(); return probe(); });
  assert.equal(await h.api.ensurePeoplePanel(), true);
  assert.equal(p.clicks(), 1);
});

test('只有“与所有人聊天”时不得把它当参与者按钮', () => {
  const h = harness();
  h.document.querySelectorAll = () => [element('', [], { role: 'button', 'aria-label': '与所有人聊天' })];
  assert.equal(h.api.peopleToggle(), null);
});

test('英文 Chat with everyone 不会遮蔽 Participants', () => {
  const h = harness(), p = panelFixture(h, { role: 'button', 'aria-label': 'Participants' });
  h.document.querySelectorAll = () => [p.button, element('', [], { role: 'button', 'aria-label': 'Chat with everyone' })];
  assert.equal(h.api.peopleToggle(), p.button);
});
