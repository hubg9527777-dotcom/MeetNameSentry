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
    querySelector: () => null,
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
    createTreeWalker: (row) => { let read = false; return { nextNode: () => {
      if (read) return null; read = true;
      return { nodeValue: row.textContent, parentElement: row };
    } }; },
  };
  const context = vm.createContext({
    window: {}, document, NodeFilter: { SHOW_TEXT: 4 }, AbortController, Set, Map, Date, Object,
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
      norm, evaluate, readRow, containsCompleteMarker, findRemoveItem, findConfirmButton, kick, dismissOverlays, openMenu,
      peopleToggle, findRowsRaw, findMoreButton, ensurePeoplePanel, attachListObserver, runCycle, tick,
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

test('AA 紧贴中文姓名前后允许通过，包括全角大小写', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['AA张三', 'AA李四', '王五AA', 'aa张三', '王五aA', 'ＡＡ王五', '王五ＡＡ']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, true, name);
  }
});

test('AA 作为独立标记允许通过，可用空格、括号、横线或表情隔开', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['AA 张三', '张三 AA', 'AA-张三', '张三-AA', '张三(AA)', '[AA]张三', '🌸AA张三', 'AA🌸张三']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, true, name);
  }
});

test('阻止拼写尾部包含 aa 的英文词误放行：jdka laa', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['张AA三', 'AA', 'AA---', '🌸AA🌸', '张AA三四', 'AABBB', 'jdka laa', 'laa', 'BAA', 'aaalice', 'AAlice', 'AliceAA', 'xAAy', 'aa123', '123aa', 'BAA1', 'xAA', 'AA9张三', 'éaa', 'AAéva', '1AA张三', '张三AA2']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, false, name);
  }
});

test('多个候选位置时跳过英文词内部的伪命中，仍接受后面的真标记', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['AA张三 jdka laa', 'xAAy 张三-AA', 'AAlice 王五AA']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, true, name);
  }
});

test('多个必需标记仍为任一匹配，通过时必须保持完整边界', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA，BB' });
  for (const name of ['AA张三', 'BB王五', '王五-BB']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, true, name);
  }
  for (const name of ['laa lbb', 'aabb123', 'xAAy xBBy']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, false, name);
  }
});

test('关键词白名单的英文缩写同样不允许词内部分匹配', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA', keywordWhitelist: 'TA' });
  for (const name of ['TA 老师', '老师TA', 'ＡＡ张三']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, true, name);
  }
  for (const name of ['lta', 'star', 'talented', 'rta123']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, false, name);
  }
});

test('中文白名单继续支持姓名内部包含匹配，精确白名单优先', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA', keywordWhitelist: '助教', exactWhitelist: 'AliceAA\n张三' });
  assert.equal(h.api.evaluate({ nameN: h.api.norm('我们的助教小李') }).ok, true);
  assert.equal(h.api.evaluate({ nameN: h.api.norm('张三') }).ok, true);
  // 精确白名单只按完整姓名处理，不能自动放行更长的英语单词。
  assert.equal(h.api.evaluate({ nameN: h.api.norm('AliceAA') }).ok, true);
  assert.equal(h.api.evaluate({ nameN: h.api.norm('xAliceAA') }).ok, false);
});

test('不能通过插入零宽字符或全角字母绕过标记边界', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['l\u200baa', 'lａａ', 'ＡＡlice', 'a\u200daalice']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(name) }).ok, false, name);
  }
});


test('严格必需标记不能夹在姓名中部，也不能单独冒充姓名；白名单保持独立标记行为', () => {
  const h = harness();
  h.api.applyConfig({ requiredKeywords: 'AA', keywordWhitelist: 'TA' });
  for (const n of ['张AA三', '张三 AA 李四', 'AA', 'AA--', '[AA]', 'AA 12345', 'Aa123张三', '王五AA张三']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(n) }).ok, false, n);
  }
  for (const n of ['🌸AA张三', 'AA🌸张三', '张三(AA)', '[AA]张三', 'AA-John', 'John-AA', '张三 TA 李四']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(n) }).ok, true, n);
  }
});

test('中文必需关键词仍按原来的包含语义判断，不会因英文 AA 新规则而误移出', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: '助教' });
  for (const n of ['我是助教小李', '助教张三', '张三助教']) {
    assert.equal(h.api.evaluate({ nameN: h.api.norm(n) }).ok, true, n);
  }
  assert.equal(h.api.evaluate({ nameN: h.api.norm('张三') }).ok, false);
});

test('Unicode 不可见字符不可在英文名字内制造假 AA 边界', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const invisible of ['\u2063', '\u2064', '\u00ad', '\u034f', '\u061c', '\u180e', '\u200b', '\u200d', '\u202e', '\uFE0F', '\uFEFF']) {
    for (const n of [`AA${invisible}lice`, `l${invisible}aa`, `AA${invisible}123`]) {
      assert.equal(h.api.evaluate({ nameN: h.api.norm(n) }).ok, false, JSON.stringify(n));
    }
  }
});

test('有可见昵称时不从辅助 aria-label 意外读取 AA；两种姓名来源冲突时停止猜测', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const withLabelMeta = element('jdka laa', [], { 'aria-label': 'jdka laa AA' });
  assert.equal(h.api.readRow(withLabelMeta, '').nameN, 'jdka laa');
  assert.equal(h.api.evaluate(h.api.readRow(withLabelMeta, '')).ok, false);
  const misleading = element('jdka laa', [], { 'aria-label': 'AA李四' });
  assert.equal(h.api.readRow(misleading, ''), null);
  const ordinary = element('AA李四', [], { 'aria-label': 'AA李四, microphone muted' });
  assert.equal(h.api.readRow(ordinary, '').nameN, 'aa李四');
});

test('姓名的 (You)/(presentation) 后缀不能直接伪造豁免', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const r1 = element('jdka laa (You)', [], { 'aria-label': 'jdka laa (You)', 'data-participant-id': 'user2' });
  const r2 = element('jdka laa (presentation)', [], { 'aria-label': 'jdka laa (presentation)', 'data-participant-id': 'user3' });
  for (const row of [r1, r2]) {
    const info = h.api.readRow(row, 'my-self-id');
    assert.equal(info.isSelf, false);
    assert.equal(info.isPresentation, false);
    assert.equal(h.api.evaluate(info).ok, false);
  }
  const r3 = element('AA张三', [], { 'aria-label': 'AA张三', 'data-participant-id': 'my-self-id' });
  assert.equal(h.api.readRow(r3, 'my-self-id').isSelf, true);
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

for (const malformed of [{ enabled: 'false' }, { dryRun: 'false' }, { exactWhitelist: {} }, { requiredKeywords: 'x'.repeat(8193) }]) {
  test(`设置窗口拒绝异常配置而不重新保存：${Object.keys(malformed)[0]}`, () => {
    const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, { value: '', addEventListener() {} }]));
    let saved = false;
    const context = {
      document: { getElementById: (id) => fields[id] }, TextEncoder,
      chrome: { runtime: {}, storage: { sync: {
        get: (defaults, cb) => cb({ ...defaults, ...malformed }),
        set: () => { saved = true; },
      } } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
    assert.equal(fields.enabled.disabled, true);
    assert.equal(fields.dryRun.disabled, true);
    assert.equal(saved, false);
    assert.match(fields.status.textContent, /配置格式异常/);
  });
}

// 补充复审回归案例：设置窗口关闭、头像缩写、不可见文字、主持人标记。
function rowWithPieces(h, pieces, label = '') {
  const row = element('', [], { 'aria-label': label });
  const nodes = pieces.map(({ text, hidden = false }) => {
    const parentElement = element();
    parentElement.parentElement = row;
    if (hidden) parentElement.getClientRects = () => [];
    return { nodeValue: text, parentElement };
  });
  h.document.createTreeWalker = () => {
    let i = 0;
    return { nextNode: () => nodes[i++] || null };
  };
  return row;
}

test('头像单字母不能被当作显示姓名并导致误移出', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const row = rowWithPieces(h, [{ text: 'A' }, { text: 'AA张三' }, { text: '已静音' }], 'AA张三, 已静音');
  const info = h.api.readRow(row, '');
  assert.ok(info === null || h.api.evaluate(info).ok, '头像缩写不得造成合规姓名违规');
});

test('隐藏的辅助文字不能覆盖显示姓名', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const row = rowWithPieces(h, [{ text: 'jdka laa', hidden: true }, { text: 'AA张三' }], 'AA张三');
  const info = h.api.readRow(row, '');
  assert.ok(info === null || h.api.evaluate(info).ok, '隐藏行首文字不得造成误判');
});

test('普通辅助文字 ghost 不能冒充主持人徽标', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const row = rowWithPieces(h, [{ text: 'jdka laa' }, { text: 'ghost' }], 'jdka laa');
  assert.equal(h.api.readRow(row, '').isHost, false);
});

test('试运行开关更改需立即调用存储，防止关闭弹窗丢失保护设置', () => {
  const listeners = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    value: '', checked: false, disabled: false,
    addEventListener(name, cb) { listeners.set(`${id}:${name}`, cb); },
  }]));
  const writes = [];
  const context = {
    document: { getElementById: (id) => fields[id], addEventListener() {} },
    TextEncoder,
    chrome: { runtime: {}, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (payload, cb) => { writes.push(payload); cb(); },
    } } },
    setTimeout: () => 123, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  fields.dryRun.checked = true;
  listeners.get('dryRun:change')();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].dryRun, true);
});

test('安全熔断期间，即使由正在进行的滚动扫描调用 kick，也绝不能继续移出', async () => {
  const h = harness(); h.api.applyConfig({ dryRun: false });
  const f = kickFixture(h);
  h.api.state.pausedUntil = Date.now() + 60_000;
  await h.api.kick({ ...f.target });
  assert.equal(f.clicks(), 0);
});

test('真实主持人标签仍豁免；ghost 不应误豁免', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const caption of ['Host', 'Co-host', 'Meeting host', 'Organizer', '主持人']) {
    const row = rowWithPieces(h, [{ text: 'jdka laa' }, { text: caption }], 'jdka laa');
    assert.equal(h.api.readRow(row, '').isHost, true, caption);
  }
});

test('只有头像字母且 aria-label 是更长姓名时，不能按字母误移出', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const row = rowWithPieces(h, [{ text: 'A' }], 'AA张三, 已静音');
  const info = h.api.readRow(row, '');
  assert.ok(info === null || h.api.evaluate(info).ok);
});

test('隐藏文本含于辅助标签时也不得覆盖真正姓名', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const row = rowWithPieces(h, [{ text: 'jdka laa', hidden: true }, { text: 'AA张三' }], 'jdka laa，AA张三');
  const info = h.api.readRow(row, '');
  assert.ok(info === null || h.api.evaluate(info).ok);
});

test('文本规则输入保留防抖，但在关闭弹窗的 pagehide 前提交最后修改', () => {
  const callbacks = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    value: '', checked: false, addEventListener(evt, cb) { callbacks.set(`${id}:${evt}`, cb); },
  }]));
  let pagehide = null;
  const writes = [];
  const context = {
    window: { addEventListener(evt, cb) { if (evt === 'pagehide') pagehide = cb; } },
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime: {}, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (payload, cb) => { writes.push(payload); cb(); },
    } } },
    setTimeout: () => 123, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  fields.requiredKeywords.value = 'BB';
  callbacks.get('requiredKeywords:input')();
  assert.equal(writes.length, 0);
  pagehide();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].requiredKeywords, 'BB');
});

// 2026-10-14 第二轮安全审计：漏洞回归，确保头像前缀不污染主持人/演示身份判定。
function withRowTexts(h, strings) {
  h.document.createTreeWalker = (row) => {
    let i = 0;
    const nodes = strings.map((nodeValue) => ({ nodeValue, parentElement: row }));
    return { nextNode: () => nodes[i++] || null };
  };
}

test('头像在前时完整昵称不能冒充主持人/演示身份', () => {
  for (const name of ['John Host', 'John (presentation)', 'Someone Moderator']) {
    const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
    withRowTexts(h, [name.charAt(0), name]);
    const row = element(name, [], { 'aria-label': name });
    const info = h.api.readRow(row, 'real-self-id');
    assert.equal(info.nameN, name.toLowerCase(), name);
    assert.equal(info.isHost, false, name);
    assert.equal(info.isPresentation, false, name);
    assert.equal(h.api.evaluate(info).ok, false, name);
  }
});

test('真实昵称后的独立主持人/演示徽标依旧识别', () => {
  for (const [badge, flag] of [['Co-host', 'isHost'], ['(presentation)', 'isPresentation']]) {
    const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
    withRowTexts(h, ['J', 'John Smith', badge]);
    const info = h.api.readRow(element('John Smith', [], { 'aria-label': 'John Smith' }));
    assert.equal(info.nameN, 'john smith');
    assert.equal(info[flag], true, badge);
  }
});

test('同一参会者行出现多个更多按钮时禁止随机选择', () => {
  const h = harness();
  const menu1 = element('more_vert', [], { role: 'button', 'aria-haspopup': 'menu' });
  const menu2 = element('more_horiz', [], { role: 'button', 'aria-haspopup': 'menu' });
  assert.equal(h.api.findMoreButton(element('', [menu1, menu2])), null);
  assert.equal(h.api.findMoreButton(element('', [menu1])), menu1);
  const a = element('more_vert', [], { role: 'button' });
  const b = element('more_horiz', [], { role: 'button' });
  assert.equal(h.api.findMoreButton(element('', [a, b])), null);
});

test('批量移出按钮必须拒绝，即使与单人移出同时出现', () => {
  const h = harness(); h.api.applyConfig({ extraRemoveLabels: '特殊移出' });
  for (const danger of ['Remove all participants from call', 'Remove everyone from call', '移出所有人']) {
    assert.equal(h.api.findRemoveItem(element('', [element(danger)])), null, danger);
    assert.equal(h.api.findRemoveItem(element('', [element('Remove from call'), element(danger)])), null, danger);
    assert.equal(h.api.findConfirmButton(element('', [element('Remove'), element(danger)])), null, danger);
  }
  assert.ok(h.api.findRemoveItem(element('', [element('Remove from call')])));
  assert.ok(h.api.findConfirmButton(element('', [element('Remove')])));
});


// 姓名规则只依赖当前 Meet 面板的显示名；无痕参会者没有稳定账户身份也应照常判定。
test('无痕/匿名参会者即使没有 participant-id，也依据显示姓名判断', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const [name, expected] of [
    ['AA张三', true], ['王五AA', true], ['AA-John', true],
    ['AAlice', false], ['AAJohn', false], ['jdka laa', false],
  ]) {
    const row = element(name, [], { 'aria-label': name }); // 没有账号 ID 或邮箱
    const info = h.api.readRow(row, '');
    assert.ok(info, name);
    assert.equal(info.key, `n:${h.api.norm(name)}`, name);
    assert.equal(h.api.evaluate(info).ok, expected, name);
  }
});

test('相同显示姓名有无临时 participant-id 时合规结论完全一致', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  for (const name of ['AA张三', '王五AA', 'AA-John', 'jdka laa', 'AAlice']) {
    const anonymous = h.api.readRow(element(name, [], { 'aria-label': name }), '');
    const session = h.api.readRow(element(name, [], {
      'aria-label': name, 'data-participant-id': `random-${name}`,
    }), 'different-self-id');
    assert.equal(h.api.evaluate(anonymous).ok, h.api.evaluate(session).ok, name);
  }
});

test('没有 id 且显示姓名相同的两个操作目标不能随机选其中之一', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  const name = 'jdka laa';
  const a = h.api.readRow(element(name, [], { 'aria-label': name }), '');
  const b = h.api.readRow(element(name, [], { 'aria-label': name }), '');
  h.api.rows([a, b]);
  assert.throws(() => h.api.locateTarget(a), /stale/);
});

// 本轮新增：验证异步配置写入不会把其它字段的旧安全状态覆盖回去。
test('文字配置更新和试运行切换互不覆盖，即使存储回调乱序', () => {
  const handlers = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun',
    'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    checked: false, value: '', addEventListener(kind, cb) { handlers.set(`${id}:${kind}`, cb); },
  }]));
  const writes = [], callbacks = [];
  let flush = null;
  const context = {
    window: { addEventListener() {} },
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime: {}, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (payload, cb) => { writes.push(payload); callbacks.push(cb); },
    } } },
    setTimeout: (fn) => { flush = fn; return 5; }, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  fields.exactWhitelist.value = 'AA张三';
  handlers.get('exactWhitelist:input')();
  flush();
  fields.dryRun.checked = true;
  handlers.get('dryRun:change')();
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[0]), ['exactWhitelist']);
  assert.deepEqual(Object.keys(writes[1]), ['dryRun']);
  assert.equal(writes[1].dryRun, true);
  callbacks[1](); callbacks[0]();
  assert.match(fields.status.textContent, /试运行/);
});

test('先后修改多个文本字段不会丢失前一个未提交的值', () => {
  const handlers = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun',
    'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    checked: false, value: '', addEventListener(kind, cb) { handlers.set(`${id}:${kind}`, cb); },
  }]));
  const writes = [];
  let pagehide;
  const context = {
    window: { addEventListener: (kind, cb) => { if (kind === 'pagehide') pagehide = cb; } },
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime: {}, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (payload, cb) => { writes.push(payload); cb(); },
    } } },
    setTimeout: () => 5, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  fields.requiredKeywords.value = 'AA';
  handlers.get('requiredKeywords:input')();
  fields.exactWhitelist.value = 'AA张三';
  handlers.get('exactWhitelist:input')();
  pagehide();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].requiredKeywords, 'AA');
  assert.equal(writes[0].exactWhitelist, 'AA张三');
  assert.equal(Object.hasOwn(writes[0], 'dryRun'), false);
});

test('隐藏或不存在的昵称不允许单靠 aria-label 触发移出', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  withRowTexts(h, []);
  const row = element('', [], { 'aria-label': 'jdka laa, muted' });
  assert.equal(h.api.readRow(row, ''), null);
});

test('没有辅助标签时不能把头像缩写当成姓名', () => {
  const h = harness(); h.api.applyConfig({ requiredKeywords: 'AA' });
  withRowTexts(h, ['A', 'AA张三']);
  const row = element('', [], {});
  assert.equal(h.api.readRow(row, ''), null);
});

test('多个更多图标只能完整匹配，不可接受类似图标的普通文字', () => {
  const h = harness();
  const fake = element('more_vert_not_a_real_icon', [], { role: 'button' });
  assert.equal(h.api.findMoreButton(element('', [fake])), null);
});

test('失败的旧存储请求必须显式提示，不能由较新成功请求静默掩盖', () => {
  const handlers = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun',
    'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    checked: false, value: '', addEventListener(kind, cb) { handlers.set(`${id}:${kind}`, cb); },
  }]));
  const callbacks = [];
  const runtime = {};
  const context = {
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (_payload, cb) => callbacks.push(cb),
    } } },
    setTimeout: () => 5, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  handlers.get('dryRun:change')();
  handlers.get('enabled:change')();
  runtime.lastError = { message: 'quota' };
  callbacks[0]();
  delete runtime.lastError;
  callbacks[1]();
  assert.match(fields.status.textContent, /保存失败/);
});

test('超出 Chrome sync 8KiB 单项容量不得谎称保存成功', () => {
  const handlers = new Map();
  const fields = Object.fromEntries(['status', 'size', 'enabled', 'dryRun',
    'requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels'].map((id) => [id, {
    checked: false, value: '', addEventListener(kind, cb) { handlers.set(`${id}:${kind}`, cb); },
  }]));
  let writes = 0;
  const context = {
    document: { getElementById: (id) => fields[id] }, TextEncoder,
    chrome: { runtime: {}, storage: { sync: {
      get: (defaults, cb) => cb(defaults),
      set: (_payload, cb) => { writes++; cb(); },
    } } },
    setTimeout: () => 5, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
  fields.exactWhitelist.value = '张'.repeat(3000);
  handlers.get('exactWhitelist:input')();
  handlers.get('exactWhitelist:change')();
  assert.equal(writes, 0);
  assert.match(fields.status.textContent, /保存失败/);
});

test('西语/葡语/法语/意语等批量移出不能命中单人移出或确认', () => {
  const h = harness(); h.api.applyConfig({ extraRemoveLabels: 'eliminar a todos de la llamada' });
  for (const phrase of [
    'Eliminar a todos de la llamada', 'Quitar todos los participantes de la llamada',
    'Remover todos da chamada', 'Excluir todos os participantes da reunião',
    'Supprimer tous les participants de l’appel', 'Rimuovi tutti dalla chiamata',
    'Remove all members', '全員を通話から削除', '모든 참가자 내보내기',
  ]) {
    assert.equal(h.api.findRemoveItem(element('', [element(phrase)])), null, phrase);
    assert.equal(h.api.findConfirmButton(element('', [element('Remove'), element(phrase)])), null, phrase);
  }
  assert.ok(h.api.findRemoveItem(element('', [element('Remove from call')])), '单人移出继续可用');
  assert.ok(h.api.findConfirmButton(element('', [element('Remove')])), '单人确认继续可用');
});
