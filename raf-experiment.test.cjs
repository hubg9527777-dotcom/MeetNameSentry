'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const mainSource = fs.readFileSync(path.join(__dirname,'mns-raf-experiment-main.js'),'utf8');
const bgSource = fs.readFileSync(path.join(__dirname,'background.js'),'utf8');

function bridgeHarness({hidden = false, pathname='/abc-defg-hij', blockedRAF = false} = {}) {
  const timers = new Map(), nativeQueue = new Map(), listeners = new Map();
  let seq = 0, frameSeq = 0, time = 250;
  const nativeRAF = (fn) => { nativeQueue.set(++frameSeq, fn); return frameSeq; };
  const nativeCAF = (id) => {nativeQueue.delete(id);};
  const window = {requestAnimationFrame: nativeRAF, cancelAnimationFrame: nativeCAF};
  if (blockedRAF) Object.defineProperty(window,'requestAnimationFrame',{value:nativeRAF,writable:false,configurable:false});
  const document = {
    hidden,
    addEventListener(ev, fn) {listeners.set(ev, fn);},
    removeEventListener(ev, fn) {if (listeners.get(ev) === fn) listeners.delete(ev);},
  };
  const context = vm.createContext({
    window, document, location:{pathname},
    performance: {now: () => time},
    Date, Map, TypeError,
    setTimeout(fn, delay) {const id=++seq; timers.set(id,{fn,delay}); return id;},
    clearTimeout(id) {timers.delete(id);},
  });
  vm.runInContext(mainSource, context);
  return {
    window, document, timers, nativeQueue, nativeRAF, nativeCAF, listeners,
    controller: window.__MNS_RAF_ISOLATED_EXP_V102__,
    triggerTimer() {const task=[...timers.entries()][0]; assert.ok(task,'no timer');timers.delete(task[0]);time+=task[1].delay;task[1].fn();},
    triggerFrame() {const task=[...nativeQueue.entries()][0]; assert.ok(task,'no native frame');nativeQueue.delete(task[0]);time+=16;task[1](time);},
    setHidden(value) {document.hidden=value; listeners.get('visibilitychange')?.();},
  };
}

test('实验 MAIN world 脚本仅对标准 Meet 房间生效，不碰首页', () => {
  const h=bridgeHarness({pathname:'/'});
  assert.equal(h.controller, undefined);
  assert.equal(h.window.requestAnimationFrame,h.nativeRAF);
});

test('MAIN world 无法安装全部 Hook 时立即回滚，且不得报告 active', () => {
  const h=bridgeHarness({blockedRAF:true});
  assert.equal(h.window.requestAnimationFrame,h.nativeRAF);
  assert.equal(h.window.cancelAnimationFrame,h.nativeCAF);
  assert.equal(h.listeners.size,0);
  assert.equal(h.controller,undefined);
});

test('不同会议文档的 rAF 桥互相隔离，停止一处不会影响另一处', () => {
  const a=bridgeHarness({hidden:true}), b=bridgeHarness({hidden:true});
  a.window.requestAnimationFrame(()=>{});
  b.window.requestAnimationFrame(()=>{});
  a.triggerTimer();
  assert.equal(a.controller.status().fallbackDelivered,1);
  assert.equal(b.controller.status().fallbackDelivered,0);
  a.controller.stop();
  assert.equal(b.controller.active,true);
  b.triggerTimer();
  assert.equal(b.controller.status().fallbackDelivered,1);
});

test('前台仍走真实 rAF，不产生额外定时器', () => {
  const h=bridgeHarness();let calls=0;
  const id=h.window.requestAnimationFrame(() => calls++);
  assert.ok(id < 0);
  assert.equal(h.timers.size,0);
  h.triggerFrame();
  assert.equal(calls,1);
  assert.equal(h.controller.status().nativeDelivered,1);
  assert.equal(h.controller.status().fallbackDelivered,0);
});

test('隐藏页面的 rAF 由可取消的 timer 执行，且不伪造 document.hidden', () => {
  const h=bridgeHarness({hidden:true});let calls=0;
  h.window.requestAnimationFrame(() => calls++);
  assert.equal(h.timers.size,1);
  h.triggerTimer();
  assert.equal(calls,1);
  assert.equal(h.controller.status().fallbackDelivered,1);
  assert.equal(h.controller.status().visibilitySpoofed,false);
  assert.equal(h.document.hidden,true);
});

test('前台提交而隐藏前未执行的原生 rAF 能回退执行且不重复调用', () => {
  const h=bridgeHarness();let calls=0;
  h.window.requestAnimationFrame(() => calls++);
  h.setHidden(true);
  assert.equal(h.timers.size,1);
  h.triggerTimer();
  assert.equal(calls,1);
  assert.equal(h.nativeQueue.size,0);
  assert.equal(h.controller.status().fallbackDelivered,1);
});

test('已取消任务永远不执行，cAF 能转发真实原生 ID', () => {
  const h=bridgeHarness({hidden:true});let calls=0;
  const id=h.window.requestAnimationFrame(() => calls++);
  h.window.cancelAnimationFrame(id);
  assert.equal(h.timers.size,0);
  assert.equal(h.controller.status().pendingCallbacks,0);
  h.window.cancelAnimationFrame(123);
  assert.equal(calls,0);
});

test('主动停止能移除监听、恢复原生 API，并清空实验任务', () => {
  const h=bridgeHarness({hidden:true});
  h.window.requestAnimationFrame(() => {});
  assert.ok(h.controller.stop());
  assert.equal(h.controller.active,false);
  assert.equal(h.timers.size,0);
  assert.equal(h.listeners.size,0);
  assert.equal(h.window.requestAnimationFrame,h.nativeRAF);
  assert.equal(h.window.cancelAnimationFrame,h.nativeCAF);
  assert.equal(h.controller.stop(),false);
});

test('后台排队的替代帧在恢复可见时重新交给原生 rAF，且不重复触发', () => {
  const h=bridgeHarness({hidden:true});let calls=0;
  h.window.requestAnimationFrame(()=>calls++);
  assert.equal(h.timers.size,1);
  h.setHidden(false);
  assert.equal(h.timers.size,0);
  assert.equal(h.nativeQueue.size,1);
  h.triggerFrame();
  assert.equal(calls,1);
  assert.equal(h.controller.status().nativeDelivered,1);
  assert.equal(h.controller.status().fallbackDelivered,0);
});

test('原生帧尚未完成的页面恢复到可见状态时，不重复注册原生帧', () => {
  const h=bridgeHarness();let calls=0;
  h.window.requestAnimationFrame(()=>calls++);
  h.setHidden(true);
  h.setHidden(false);
  assert.equal(h.nativeQueue.size,1);
  assert.equal(h.timers.size,0);
  h.triggerFrame();
  assert.equal(calls,1);
});

test('关闭实验时不丢掉尚未执行的页面动画任务，而是迁回原生 rAF', () => {
  const h=bridgeHarness({hidden:true});let calls=0;
  h.window.requestAnimationFrame(()=>calls++);
  assert.ok(h.controller.stop());
  assert.equal(h.timers.size,0);
  assert.equal(h.nativeQueue.size,1);
  h.triggerFrame();
  assert.equal(calls,1);
});

test('反复装载相同桥脚本不能重复包装', () => {
  const h=bridgeHarness();
  const first=h.window.requestAnimationFrame;
  const context=vm.createContext({window:h.window,document:h.document,location:{pathname:'/abc-defg-hij'},Date,Map,TypeError,
    performance:{now:()=>0},setTimeout,clearTimeout});
  vm.runInContext(mainSource,context);
  assert.equal(h.window.requestAnimationFrame,first);
});

function backgroundHarness({failStorage=false,failRegistration=false,failMainInjection=false,storageSeed={}} = {}) {
  const registered=new Map(), bridgeActive=new Map(), state={...storageSeed}, calls=[], listeners={};
  const event=(name)=>({addListener:(fn)=>{listeners[name]=fn;}});
  const tab={id:8,url:'https://meet.google.com/abc-defg-hij',status:'complete'};
  const chrome={
    runtime:{id:'mns-test',getURL:(f)=>`chrome-extension://mns-test/${f}`,onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message')},
    action:{setBadgeText: async()=>{}},
    alarms:{get:async()=>null,create:async()=>{},onAlarm:event('alarm')},
    tabs:{query:async()=>[tab],get:async()=>tab,sendMessage:async()=>{throw new Error('no listener');},onUpdated:event('updated'),onActivated:event('activated'),onRemoved:event('removed')},
    scripting:{
      getRegisteredContentScripts:async({ids})=>ids.map(id=>registered.get(id)).filter(Boolean),
      registerContentScripts:async(scripts)=>{if(failRegistration)throw new Error('register-failure');scripts.forEach(s=>registered.set(s.id,s));},
      unregisterContentScripts:async({ids})=>ids.forEach(id=>registered.delete(id)),
      executeScript:async(opts)=>{
        calls.push(opts);
        const tabId=opts.target.tabId;
        if (opts.files?.includes('mns-raf-experiment-main.js')) {
          if (failMainInjection) throw new Error('mock-main-injection-failed');
          bridgeActive.set(tabId,true);
          return [];
        }
        if (opts.func?.toString().includes('?.stop?.()')) {
          bridgeActive.set(tabId,false);
          return [{result:true}];
        }
        if (opts.func?.toString().includes('const bridge = window.__MNS_RAF_ISOLATED_EXP_V102__')) {
          const active=bridgeActive.get(tabId)===true;
          return [{result:{present:active,active}}];
        }
        return [];
      },
    },
    storage:{local:{
      get:async(defaults)=>({...defaults,...state}),
      set:async(values)=>{if(failStorage)throw new Error('storage-failure');Object.assign(state,values);},
    }},
  };
  const context=vm.createContext({chrome,URL,Promise,Date,Map,setTimeout,clearTimeout,console:{warn(){}}});
  vm.runInContext(bgSource+'\nglobalThis.rafAPI={setRafExperiment,rafExperimentStatus,reconcileRafExperiment};',context);
  return {api:context.rafAPI, registered, bridgeActive, state, calls, listeners,chrome};
}

test('首次安装默认开启并自动注册 MAIN world，不增加权限',async()=>{
  const h=backgroundHarness();
  const status=await h.api.rafExperimentStatus();
  assert.equal(status.enabled,true);
  assert.equal(status.registered,true);
  assert.equal(h.registered.size,1);
  assert.equal(h.bridgeActive.get(8),true);
  // 未写入过开关，也应按首次安装默认开启；注册不会被误认为用户明确选择。
  assert.equal(h.state.mnsRafExperimentEnabled,undefined);
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json')));
  assert.equal(manifest.version,'1.0.2');
  assert.deepEqual(manifest.permissions,['storage','scripting','alarms']);
});

test('手动开启时注册 document_start，且为已经打开的 Meet 立即补 MAIN world 注入',async()=>{
  const h=backgroundHarness();
  const enabled=await h.api.setRafExperiment(true);
  assert.equal(enabled.enabled,true);
  assert.equal(enabled.reloadRequired,true);
  assert.equal(h.state.mnsRafExperimentEnabled,true);
  assert.equal(h.registered.size,1);
  const script=[...h.registered.values()][0];
  assert.equal(script.world,'MAIN');
  assert.equal(script.runAt,'document_start');
  assert.equal(script.allFrames,false);
  assert.deepEqual(Array.from(script.js),['mns-raf-experiment-main.js']);
  assert.deepEqual(JSON.parse(JSON.stringify(enabled.rooms)),{checked:1,active:1,missing:0,failed:0});
  assert.equal(h.bridgeActive.get(8),true);
  assert.equal(h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length,1);
  assert.ok(h.calls.every(x=>x.world==='MAIN'));
});

test('关闭开关注销动态脚本并向仍运行的测试会话发送恢复请求',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  const disabled=await h.api.setRafExperiment(false);
  assert.equal(disabled.enabled,false);
  assert.equal(disabled.registered,false);
  assert.equal(h.state.mnsRafExperimentEnabled,false);
  assert.equal(h.bridgeActive.get(8),false);
  const lastCall=h.calls.at(-1);
  assert.equal(lastCall.world,'MAIN');
  assert.equal(lastCall.target.tabId,8);
});

test('存储失败或脚本注册失败时不应残留已启用状态',async()=>{
  const h=backgroundHarness({failStorage:true});
  await assert.rejects(h.api.setRafExperiment(true),/storage-failure/);
  // 初始默认开启已经成功注册：存储写失败时不能破坏原有已启用状态。
  assert.equal(h.registered.size,1);
  const h2=backgroundHarness({failRegistration:true});
  await assert.rejects(h2.api.setRafExperiment(true),/register-failure/);
  assert.equal(h2.state.mnsRafExperimentEnabled,undefined);
});

test('并发的开关切换序列化执行，最终状态由最后一项决定',async()=>{
  const h=backgroundHarness();
  await Promise.all([h.api.setRafExperiment(true),h.api.setRafExperiment(false)]);
  const status=await h.api.rafExperimentStatus();
  assert.equal(status.enabled,false);
  assert.equal(status.registered,false);
});

test('服务工作线程启动可从本地设置恢复实验注册，但不需要额外权限',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  h.registered.clear();
  await h.api.reconcileRafExperiment();
  assert.equal(h.registered.size,1);
});

test('只接受扩展本身的 popup.html 管理消息，拒绝其他发送者和未知操作',async()=>{
  const h=backgroundHarness();
  await h.api.rafExperimentStatus();
  assert.equal(h.listeners.message({protocol:'MNS_RAF_EXP_V102',action:'ENABLE'},{id:'external',url:'chrome-extension://external/popup.html'},()=>{}),false);
  assert.equal(h.listeners.message({protocol:'MNS_RAF_EXP_V102',action:'DANGER'},{id:'mns-test',url:'chrome-extension://mns-test/popup.html'},()=>{}),false);
  const response=await new Promise((resolve)=>{
    assert.equal(h.listeners.message({protocol:'MNS_RAF_EXP_V102',action:'ENABLE'},{id:'mns-test',url:'chrome-extension://mns-test/popup.html'},resolve),true);
  });
  assert.equal(response.ok,true);
  assert.equal(response.registered,true);
});


test('检测状态区分脚本已注册与当前页面真正桥接已运行',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  h.bridgeActive.clear();
  let status=await h.api.rafExperimentStatus();
  assert.equal(status.registered,true);
  assert.equal(status.enabled,true);
  assert.equal(status.rooms.checked,1);
  assert.equal(status.rooms.active,0);
  assert.equal(status.rooms.missing,1);
  await h.api.reconcileRafExperiment();
  status=await h.api.rafExperimentStatus();
  assert.equal(status.rooms.active,1);
  assert.equal(status.rooms.missing,0);
});

test('重复执行恢复时先读桥接状态，不能向同一个页面重复注入',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  const initial=h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length;
  await h.api.reconcileRafExperiment();
  assert.equal(h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length,initial);
});

test('导航完成后发现已注册但当前页面缺桥，能够补注入',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  h.bridgeActive.clear();
  h.listeners.updated(8,{status:'complete'},{id:8,url:'https://meet.google.com/abc-defg-hij',status:'complete'});
  // repairRafBridgeAfterNavigation 通过异步序列队列运行。
  for(let i=0;i<15 && !h.bridgeActive.get(8);i++) await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.bridgeActive.get(8),true);
});

test('用户明确关闭后，导航和重启都不允许补注入 rAF 桥',async()=>{
  const h=backgroundHarness({storageSeed:{mnsRafExperimentEnabled:false}});
  h.listeners.updated(8,{status:'complete'},{id:8,url:'https://meet.google.com/abc-defg-hij',status:'complete'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.bridgeActive.size,0);
  assert.equal(h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length,0);
  const status=await h.api.rafExperimentStatus();
  assert.equal(status.enabled,false);
  assert.equal(status.registered,false);
  assert.equal(h.state.mnsRafExperimentEnabled,false);
});

test('已有开启记录在后台工作线程恢复后仍保持开启',async()=>{
  const h=backgroundHarness({storageSeed:{mnsRafExperimentEnabled:true}});
  const status=await h.api.rafExperimentStatus();
  assert.equal(status.enabled,true);
  assert.equal(status.registered,true);
  assert.equal(h.bridgeActive.get(8),true);
});

test('MAIN world 补注入失败时不影响启用设置与内容脚本巡检',async()=>{
  const h=backgroundHarness({failMainInjection:true});
  const enabled=await h.api.setRafExperiment(true);
  assert.equal(enabled.registered,true);
  assert.equal(enabled.rooms.active,0);
  assert.equal(enabled.rooms.failed,1);
  assert.equal(h.state.mnsRafExperimentEnabled,true);
});

test('开启后再次关闭，后续定时自检不得重新激活页面桥接',async()=>{
  const h=backgroundHarness();
  await h.api.setRafExperiment(true);
  await h.api.setRafExperiment(false);
  assert.equal(h.bridgeActive.get(8),false);
  const before=h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length;
  h.listeners.alarm({name:'mns-health-monitor-v1'});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.calls.filter(x=>x.files?.includes('mns-raf-experiment-main.js')).length,before);
});


test('来自 Meet 内容脚本或已删除的旧实验页的设置修改请求被拒绝',async()=>{
  const h=backgroundHarness();
  assert.equal(h.listeners.message({protocol:'MNS_RAF_EXP_V102',action:'ENABLE'},
    {id:'mns-test',url:'https://meet.google.com/abc-defg-hij'},()=>{}),false);
  assert.equal(h.listeners.message({protocol:'MNS_RAF_EXP_V102',action:'ENABLE'},
    {id:'mns-test',url:'chrome-extension://mns-test/raf-experiment.html'},()=>{}),false);
  assert.equal(h.registered.size,0);
});


test('此前已经注册时，ENABLE 存储失败仍保持原有注册', async () => {
  const h=backgroundHarness({failStorage:true});
  await h.api.rafExperimentStatus(); // 等待 Worker 启动时的自动默认注册完成
  assert.equal(h.registered.size,1);
  await assert.rejects(h.api.setRafExperiment(true),/storage-failure/);
  assert.equal(h.registered.size,1);
});

test('明确关闭的设置在 Worker 恢复时会停止遗留的 MAIN world 桥接',async()=>{
  const h=backgroundHarness({storageSeed:{mnsRafExperimentEnabled:false}});
  h.bridgeActive.set(8,true);
  await h.api.reconcileRafExperiment();
  assert.equal(h.bridgeActive.get(8),false);
  assert.equal(h.registered.size,0);
});
