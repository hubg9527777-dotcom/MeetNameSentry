// Chrome MV3 Service Worker 行为隔离测试，不连接 Google Meet。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const room = (id = 5, url = 'https://meet.google.com/abc-defg-hij', extra = {}) =>
  ({ id, url, status: 'complete', ...extra });

function harness({tabs = [room()], onMessage, onInject, onBadge} = {}) {
  const handlers = {}, injections = [], messages = [], alarms = [], warnings = [];
  const wrapEvent = (name) => ({ addListener(fn) { handlers[name] = fn; } });
  const chrome = {
    action: { setBadgeText: async (o) => { if(onBadge) onBadge('text', o); },
      setBadgeBackgroundColor: async (o) => { if(onBadge) onBadge('color', o); } },
    runtime: {
      onInstalled: wrapEvent('installed'), onStartup: wrapEvent('startup'),
    },
    alarms: {
      get: async () => null,
      create: async (name, options) => { alarms.push({name, options}); },
      onAlarm: wrapEvent('alarm'),
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((t) => t.id === id),
      sendMessage: async (id, body) => {
        messages.push({id, body});
        if (onMessage) return onMessage(id, body);
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      onUpdated: wrapEvent('updated'), onActivated: wrapEvent('activated'),
      onRemoved: wrapEvent('removed'),
    },
    scripting: {
      executeScript: async (options) => {
        injections.push(options);
        if (onInject) return onInject(options);
        return [];
      },
    },
  };
  const context = vm.createContext({chrome, URL, Date, Promise, Number, Map,
    setTimeout, clearTimeout, console: { warn: (...args) => warnings.push(args) }});
  vm.runInContext(source + '\n globalThis.testable = { isMeetRoom, ensureHealth, scanMeetRooms, ensureAlarm, noListener };', context);
  return { api: context.testable, handlers, injections, messages, alarms, warnings, tabs };
}

test('严格匹配 Meet 会议链接，不注入首页、其他域名、相似主机及外站', () => {
  const h = harness();
  for (const url of ['https://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij/?authuser=0'])
    assert.equal(h.api.isMeetRoom(url), true, url);
  for (const url of ['https://meet.google.com/', 'https://meet.google.com/landing', 'https://meet.google.com/lookup/abc',
    'https://evil-meet.google.com/abc-defg-hij', 'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij', 'about:blank', ''])
    assert.equal(h.api.isMeetRoom(url), false, url);
});

test('当前 Meet 没有内容脚本时安全补注入一次（仅主框架、隔离世界）', async () => {
  const h = harness();
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'injected');
  assert.equal(h.injections.length, 1);
  const {files, world, target} = h.injections[0];
  assert.deepEqual(Array.from(files), ['content.js']);
  assert.equal(world, 'ISOLATED');
  assert.equal(target.tabId, 5);
  assert.equal(target.allFrames, false);
});

test('没有监听器且频繁触发时冷却去重，不会无限补注入', async () => {
  const h = harness();
  await h.api.ensureHealth(h.tabs[0]);
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'cooldown');
  assert.equal(h.injections.length, 1);
});

test('健康的内容脚本不重复注入或唤醒', async () => {
  const h = harness({ onMessage: () => ({protocol:'MNS_HEALTH_V1', alive:true, configReady:true,
    enabled:true, paused:false, busy:false, lastCycleAt: Date.now()}) });
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'healthy');
  assert.equal(h.messages.length, 1);
  assert.equal(h.injections.length, 0);
});

test('配置未就绪可以唤醒重试；已暂停或禁用的会议不强制恢复移出', async () => {
  for (const fields of [ {configReady:false, enabled:true}, {configReady:true, enabled:false},
    {configReady:true, enabled:true, paused:true}, {configReady:true, enabled:true, busy:true} ]) {
    const h = harness({onMessage: () => ({protocol:'MNS_HEALTH_V1', alive:true,
      lastCycleAt: Date.now() - 120_000, ...fields})});
    const expected = fields.configReady === false ? 'woken' : 'healthy';
    assert.equal(await h.api.ensureHealth(h.tabs[0]), expected);
    assert.equal(h.messages.length, expected === 'woken' ? 2 : 1);
    assert.equal(h.injections.length, 0);
  }
});

test('健康脚本长时间未巡检，只发唤醒消息，不执行第二次注入', async () => {
  const h = harness({onMessage: (id, body) => body.action === 'PING' ?
    ({protocol:'MNS_HEALTH_V1', alive:true, configReady:true, enabled:true,
      paused:false, busy:false, lastCycleAt: Date.now() - 80_000}) :
    ({protocol:'MNS_HEALTH_V1', alive:true}) });
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'woken');
  assert.deepEqual(h.messages.map(({body}) => body.action), ['PING','WAKE']);
  assert.equal(h.injections.length, 0);
});

test('没有响应的后台冻结页不盲目注入，避免重复踢人流程', async () => {
  const h = harness({onMessage: async () => {throw new Error('health-ping-timeout');}});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'unresponsive');
  assert.equal(h.injections.length, 0);
  const frozen = room(5, undefined, {frozen:true});
  assert.equal(await h.api.ensureHealth(frozen), 'skipped');
  const discarded = room(6, undefined, {discarded:true});
  assert.equal(await h.api.ensureHealth(discarded), 'skipped');
});

test('非本扩展协议的回复不应作为运行健康证据，也不强行注入', async () => {
  const h = harness({onMessage: () => ({protocol:'OTHER', alive:true})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'unverified');
  assert.equal(h.injections.length, 0);
});

test('对同一标签页并行巡检严格单飞，不会同时注入两个引擎', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({onInject: () => wait});
  const first = h.api.ensureHealth(h.tabs[0]);
  const second = h.api.ensureHealth(h.tabs[0]);
  release([]);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ['injected','injected']);
  assert.equal(h.injections.length, 1);
});

test('多个同 Profile Meet 标签页独立检测，只补缺失的那一页', async () => {
  const meetingTabs = [room(3),room(4,'https://meet.google.com/xyz-pqrs-abc'),
    room(5,'https://meet.google.com/')];
  const h = harness({tabs:meetingTabs,onMessage: async (id) => {
    if(id===3) return {protocol:'MNS_HEALTH_V1',alive:true};
    throw new Error('Receiving end does not exist');
  }});
  await h.api.scanMeetRooms();
  assert.equal(h.injections.length, 1);
  assert.equal(h.injections[0].target.tabId, 4);
});

test('导航完成、激活、定时警报触发再次自检', async () => {
  const h = harness();
  h.handlers.updated(5, {status:'complete'}, h.tabs[0]);
  h.handlers.activated({tabId:5});
  h.handlers.alarm({name:'other-alarm'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.injections.length, 1);
  h.handlers.alarm({name:'mns-health-monitor-v1'});
  await new Promise((r) => setImmediate(r));
  assert.ok(h.messages.length >= 2);
  h.handlers.removed(5);
});

test('启动时建立周期唤醒 alarm，不能依赖 Service Worker setInterval', async () => {
  const h = harness();
  await h.api.ensureAlarm();
  assert.ok(h.alarms.some((a) => a.name === 'mns-health-monitor-v1' && a.options.periodInMinutes === 0.5));
  assert.doesNotMatch(source, /setInterval\(/);
});

test('清单限制权限，并配置后台 Worker', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  assert.equal(m.version,'1.0.2');
  assert.deepEqual(m.permissions,['storage','scripting','alarms']);
  assert.deepEqual(m.host_permissions,['https://meet.google.com/*']);
  assert.equal(m.background.service_worker, 'background.js');
  assert.equal(m.permissions.includes('tabs'), false);
});


test('一个标签页快速导航到新 Meet 会议，应立即尝试新文档补注入', async () => {
  const h = harness();
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'injected');
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'cooldown');
  const nextRoom = room(5, 'https://meet.google.com/lmn-opqr-stu');
  assert.equal(await h.api.ensureHealth(nextRoom), 'injected');
  assert.equal(h.injections.length, 2);
});

test('同 URL 刷新触发 loading 时清除旧文档冷却，允许恢复新文档', async () => {
  const h = harness();
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'injected');
  h.handlers.updated(5, {status:'loading'}, {...h.tabs[0],status:'loading'});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'injected');
  assert.equal(h.injections.length, 2);
});

test('补注入报错时日志不泄露会议 URL', async () => {
  const h = harness({onInject: () => {throw new Error('Failed on https://meet.google.com/abc-defg-hij');}});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'failed');
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(h.warnings), /abc-defg-hij/);
});


test('配置尚未就绪且页面周期停滞时，后台仅唤醒配置重试，不尝试踢人', async () => {
  const h = harness({onMessage: (_id, body) => body.action === 'PING' ?
    ({protocol:'MNS_HEALTH_V1',alive:true,configReady:false,enabled:false,
      busy:false,lastCycleAt: Date.now() - 60_000}) : ({protocol:'MNS_HEALTH_V1',alive:true})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'woken');
  assert.deepEqual(h.messages.map(({body}) => body.action), ['PING','WAKE']);
  assert.equal(h.injections.length, 0);
});


test('后台发现页面循环仍运行但名单超过45秒未有效巡检，也只唤醒原引擎', async () => {
  const h = harness({onMessage: (_id, body) => body.action === 'PING' ?
    ({protocol:'MNS_HEALTH_V1', alive:true, configReady:true, enabled:true,
      paused:false, busy:false, lastCycleAt:Date.now(), lastPatrolAt:Date.now()-120_000}) :
    ({protocol:'MNS_HEALTH_V1', alive:true}) });
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'woken');
  assert.deepEqual(h.messages.map(m => m.body.action), ['PING', 'WAKE']);
  assert.equal(h.injections.length, 0);
});

test('最近成功巡检或已暂停时不会因为名单心跳而强行恢复移出', async () => {
  for (const item of [
    { lastPatrolAt: Date.now(), paused: false },
    { lastPatrolAt: Date.now()-200_000, paused: true },
  ]) {
    const h = harness({onMessage: () => ({protocol:'MNS_HEALTH_V1', alive:true,
      configReady:true, enabled:true, busy:false, lastCycleAt: Date.now(), ...item})});
    assert.equal(await h.api.ensureHealth(h.tabs[0]), 'healthy');
    assert.equal(h.injections.length, 0);
  }
});


test('Claude 后台 BLIND：健康循环正常但名单不全时报告 blind，不多次 WAKE', async () => {
  const h = harness({onMessage: () => ({protocol:'MNS_HEALTH_V1',alive:true,
    configReady:true,enabled:true,paused:false,busy:false,
    lastCycleAt:Date.now(),lastPatrolAt:Date.now(),coverageStatus:'blind'})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'blind');
  assert.deepEqual(h.messages.map(m=>m.body.action), ['PING']);
  assert.equal(h.injections.length, 0);
});



test('Claude 后台徽标：blind 使用当前 tabId 设置黄色感叹号；恢复后清除', async () => {
  let blind = true;
  const badges=[];
  const h = harness({onBadge: (type, arg) => badges.push({type, arg}),
    onMessage: () => ({protocol:'MNS_HEALTH_V1',alive:true,
      configReady:true,enabled:true,paused:false,busy:false,
      lastCycleAt:Date.now(),lastPatrolAt:Date.now(),
      coverageStatus:blind?'blind':'count-consistent'})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'blind');
  assert.ok(badges.some(b=>b.type==='text' && b.arg.tabId===5 && b.arg.text==='!'));
  assert.ok(badges.some(b=>b.type==='color' && b.arg.color==='#ea8600'));
  blind=false;
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'healthy');
  assert.ok(badges.some(b=>b.type==='text' && b.arg.tabId===5 && b.arg.text===''));
});

test('Claude 后台徽标：禁用功能时无红黄盲区徽标', async () => {
  const badges=[];
  const h = harness({onBadge: (_, arg) => badges.push(arg),
    onMessage: () => ({protocol:'MNS_HEALTH_V1',alive:true,
      configReady:true,enabled:false,paused:false,busy:false,
      lastCycleAt:Date.now(),coverageStatus:'blind'})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]), 'healthy');
  assert.ok(badges.some(o=>o.text===''));
});


test('无健康回复的会议显示未知状态，而不是保留旧的绿灯或黄色盲区', async () => {
  const calls=[];
  const h=harness({onMessage:async()=>{throw new Error('health-ping-timeout');},
    onBadge:(kind,opt)=>calls.push({kind,...opt})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]),'unresponsive');
  assert.ok(calls.some((x)=>x.kind==='text' && x.text==='?' && x.tabId===5));
});

test('重新补注入内容脚本尚未完成 PING 时标记未知，不伪称巡检成功',async()=>{
  const calls=[];
  const h=harness({onBadge:(kind,opt)=>calls.push({kind,...opt})});
  assert.equal(await h.api.ensureHealth(h.tabs[0]),'injected');
  assert.ok(calls.some((x)=>x.kind==='text' && x.text==='?'));
});
