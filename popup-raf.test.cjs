'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popupHTML = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
const popupSource = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');

function buildPopup({enabled = true, registered = enabled, replies = {}} = {}) {
  const ids = ['status', 'size', 'enabled', 'dryRun', 'requiredKeywords', 'keywordWhitelist',
    'exactWhitelist', 'extraRemoveLabels', 'rafEnabled', 'rafStatus'];
  const handlers = new Map();
  const fields = Object.fromEntries(ids.map(id=>[id, {
    value:'', checked:false, disabled:false, textContent:'', className:'',
    addEventListener(type, fn) {handlers.set(`${id}:${type}`,fn);},
  }]));
  const calls=[];
  let state={enabled,registered};
  const chrome={
    runtime:{
      id:'test',
      sendMessage:async (msg)=>{
        calls.push(msg);
        if (replies[msg.action]) return replies[msg.action](msg, state);
        if (msg.action==='STATUS')return {ok:true,...state};
        if (msg.action==='ENABLE') state={enabled:true,registered:true};
        if (msg.action==='DISABLE') state={enabled:false,registered:false};
        return {ok:true,...state};
      },
    },
    storage:{sync:{get:(defaults,callback)=>callback(defaults),set:(values,callback)=>callback()}},
  };
  vm.runInNewContext(popupSource,{chrome,document:{getElementById:id=>fields[id]},
    TextEncoder,window:{addEventListener(){}},setTimeout,clearTimeout});
  return {fields,calls,handlers,getState:()=>state,settle:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('正式设置界面：后台辅助开关在巡检与试运行之间，没有独立实验页链接',()=>{
  assert.ok(popupHTML.indexOf('id="enabled"') < popupHTML.indexOf('id="rafEnabled"'));
  assert.ok(popupHTML.indexOf('id="rafEnabled"') < popupHTML.indexOf('id="dryRun"'));
  assert.match(popupHTML,/隐藏 Meet 时继续帮助更新人员名单/);
  assert.match(popupHTML,/不会自动弹出会议画面/);
  assert.doesNotMatch(popupHTML,/href=["']raf-experiment\.html/);
  assert.doesNotMatch(popupHTML,/后台 rAF 渲染独立实验/);
  assert.equal(fs.existsSync(path.join(__dirname,'raf-experiment.html')),false);
});

test('正式界面首次打开：默认开启、显示已开启且不向 AA 规则同步存储写入',async()=>{
  const h=buildPopup();
  assert.equal(h.fields.rafEnabled.disabled,true,'状态未核实之前禁止操作');
  await h.settle();
  assert.equal(h.fields.rafEnabled.checked,true);
  assert.equal(h.fields.rafEnabled.disabled,false);
  assert.match(h.fields.rafStatus.textContent,/已开启/);
  assert.deepEqual(h.calls.map(c=>c.action),['STATUS']);
});

test('曾手动关闭辅助的用户，下次打开仍显示关闭，不会强制再开启',async()=>{
  const h=buildPopup({enabled:false,registered:false});
  await h.settle();
  assert.equal(h.fields.rafEnabled.checked,false);
  assert.match(h.fields.rafStatus.textContent,/已关闭/);
  assert.deepEqual(h.calls.map(c=>c.action),['STATUS']);
});

test('从弹窗关闭后台辅助：实际发送 DISABLE，切换时锁定开关防止重复指令',async()=>{
  let release;
  const h=buildPopup({replies:{DISABLE:()=>new Promise(r=>{release=r;})}});
  await h.settle();
  h.fields.rafEnabled.checked=false;
  h.handlers.get('rafEnabled:change')();
  assert.equal(h.fields.rafEnabled.disabled,true);
  h.handlers.get('rafEnabled:change')();
  assert.deepEqual(h.calls.map(c=>c.action),['STATUS','DISABLE']);
  release({ok:true,enabled:false,registered:false});
  await h.settle();
  assert.equal(h.fields.rafEnabled.checked,false);
  assert.equal(h.fields.rafEnabled.disabled,false);
  assert.match(h.fields.rafStatus.textContent,/已关闭/);
});

test('关闭后再次开启：直接向 Worker 发送 ENABLE，不打开其他窗口',async()=>{
  const h=buildPopup({enabled:false,registered:false});
  await h.settle();
  h.fields.rafEnabled.checked=true;
  h.handlers.get('rafEnabled:change')();
  await h.settle();
  assert.deepEqual(h.calls.map(c=>c.action),['STATUS','ENABLE']);
  assert.equal(h.fields.rafEnabled.checked,true);
  assert.match(h.fields.rafStatus.textContent,/已开启/);
});

test('切换失败时不得假装已保存：恢复此前核实的状态',async()=>{
  const h=buildPopup({replies:{DISABLE:()=>({ok:false,error:'storage-failure'})}});
  await h.settle();
  h.fields.rafEnabled.checked=false;
  h.handlers.get('rafEnabled:change')();
  await h.settle();
  assert.equal(h.fields.rafEnabled.checked,true);
  assert.equal(h.fields.rafEnabled.disabled,false);
  assert.match(h.fields.rafStatus.textContent,/保存失败/);
});

test('后台状态读取失败：禁止可交互开关，避免误显示已保存状态',async()=>{
  const h=buildPopup({replies:{STATUS:()=>Promise.reject(Error('worker-unavailable'))}});
  await h.settle();
  assert.equal(h.fields.rafEnabled.disabled,true);
  assert.match(h.fields.rafStatus.textContent,/无法读取状态/);
});

test('背景注册状态不一致时不谎称辅助已生效',async()=>{
  const h=buildPopup({enabled:true,registered:false});
  await h.settle();
  assert.equal(h.fields.rafEnabled.checked,true);
  assert.match(h.fields.rafStatus.textContent,/同步中/);
});
