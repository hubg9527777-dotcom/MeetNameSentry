/**
 * MeetNameSentry v1.0.2 — 独立后台健康监护 (Chrome MV3 Service Worker)
 * 职责只有：检查 Meet 页面是否已挂载巡检脚本、缺失时补注入、健康实例超时未轮询时唤醒。
 * 不访问参会者名单/姓名，不请求跨网站权限，不直接执行任何移出操作。
 */
'use strict';

const HEALTH_PROTOCOL = 'MNS_HEALTH_V1';
const ALARM_NAME = 'mns-health-monitor-v1';
const ALARM_MINUTES = 0.5;    // Chrome 120+ 支持每 30 秒；不是实时保证
const STALE_CYCLE_MS = 25_000;
const STALE_PATROL_MS = 45_000; // 循环存活不等于名单已读取；实际巡检缺失时也发安全唤醒
const RETRY_COOLDOWN_MS = 45_000;
const WAIT_FOR_REPLY_MS = 3_000;
const MEET_URL = 'https://meet.google.com/*';

// 后台名单辅助：全新安装默认启用；手动关闭后保留关闭状态。
const RAF_EXPERIMENT_PROTOCOL = 'MNS_RAF_EXP_V102';
const RAF_EXPERIMENT_ID = 'mns-raf-exp-v102';
const RAF_EXPERIMENT_KEY = 'mnsRafExperimentEnabled';
const RAF_DEFAULT_ENABLED = true; // 首次安装：无需再进实验页手动开启；尊重已保存的 false
const RAF_EXPERIMENT_FILE = 'mns-raf-experiment-main.js';
// Chrome/DOM 异常文本可能附带 Meet URL；只保留已知错误类型的短名称。
function safeErrorKind(error) {
  const name = error?.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}(?:Error|Exception)$/.test(name) ? name : 'unexpected-error';
}
let rafChangeQueue = Promise.resolve();

function serializedExperimentChange(fn) {
  const result = rafChangeQueue.then(fn);
  rafChangeQueue = result.catch(() => {});
  return result;
}

async function getRafRegistration() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ids:[RAF_EXPERIMENT_ID]});
  return scripts.some((s) => s.id === RAF_EXPERIMENT_ID);
}

async function registerRafExperiment() {
  if (await getRafRegistration()) return;
  await chrome.scripting.registerContentScripts([{
    id: RAF_EXPERIMENT_ID,
    matches: [MEET_URL],
    js: [RAF_EXPERIMENT_FILE],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}

async function unregisterRafExperiment() {
  if (await getRafRegistration())
    await chrome.scripting.unregisterContentScripts({ids: [RAF_EXPERIMENT_ID]});
}

// 已注册的 document_start 脚本并不会自动注入到注册前就打开的页面。
// 在用户主动开启实验后做 MAIN world 只读探测，缺失时仅注入同一份受控实验脚本。
// 下面的调用只能放在 serializedExperimentChange 管理的任务内，避免与关闭操作竞态。
async function rafBridgeInTab(tab, injectIfMissing) {
  if (isGoneOrFrozen(tab) || !isMeetRoom(tab.url)) return 'skipped';
  try {
    const inspect = async () => {
      const results = await chrome.scripting.executeScript({
        target: {tabId: tab.id, allFrames: false},
        world: 'MAIN',
        func: () => {
          const bridge = window.__MNS_RAF_ISOLATED_EXP_V102__;
          return {present: !!bridge, active: bridge?.active === true};
        },
      });
      return results?.[0]?.result || {present:false,active:false};
    };
    const current = await inspect();
    if (current.active) return 'active';
    if (!injectIfMissing) return current.present ? 'inactive' : 'missing';
    await chrome.scripting.executeScript({
      target: {tabId: tab.id, allFrames: false},
      world: 'MAIN',
      files: [RAF_EXPERIMENT_FILE],
    });
    const repaired = await inspect();
    return repaired.active ? 'injected' : 'not-activated';
  } catch (error) {
    // 不输出具体 URL、页面内容或姓名；补注入失败不影响原来的巡检。
    return 'injection-failed';
  }
}

async function inspectOpenRafRooms(injectIfMissing) {
  const tabs = await chrome.tabs.query({url:MEET_URL});
  const eligible = tabs.filter((t) => isMeetRoom(t.url) && !isGoneOrFrozen(t));
  const results = await Promise.all(eligible.map((tab) => rafBridgeInTab(tab, injectIfMissing)));
  return {checked:eligible.length, active:results.filter((r)=>r==='active'||r==='injected').length,
    missing:results.filter((r)=>r==='missing'||r==='inactive').length,
    failed:results.filter((r)=>r==='injection-failed'||r==='not-activated').length};
}

async function repairRafBridgeInOpenRooms() {
  return inspectOpenRafRooms(true);
}

// 导航完成后补注入，覆盖 Meet 使用站内路由、document_start 时路径尚未匹配等情况。
// 调用期间串行核对开关，确保用户关闭实验后不会再注入。
async function repairRafBridgeAfterNavigation(tab) {
  return serializedExperimentChange(async () => {
    const setting = await chrome.storage.local.get({[RAF_EXPERIMENT_KEY]:RAF_DEFAULT_ENABLED});
    if (setting[RAF_EXPERIMENT_KEY] !== true) return 'disabled';
    return rafBridgeInTab(tab, true);
  });
}

async function stopRafExperimentInOpenRooms() {
  // 关闭实验时，对当前已加载页面尽力恢复原生 rAF；建议仍刷新所有 Meet。
  let tabs;
  try { tabs = await chrome.tabs.query({url: MEET_URL}); }
  catch { return; }
  await Promise.allSettled(tabs.filter((t) => isMeetRoom(t.url) && !isGoneOrFrozen(t)).map(async (tab) => {
    // 没有桥接的页面无需注入任何控制代码；已有活动实例才恢复原生 rAF。
    if (await rafBridgeInTab(tab, false) !== 'active') return;
    await chrome.scripting.executeScript({
      target: {tabId:tab.id,allFrames:false}, world: 'MAIN',
      func: () => window.__MNS_RAF_ISOLATED_EXP_V102__?.stop?.(),
    });
  }));
}

async function setRafExperiment(enabled) {
  return serializedExperimentChange(async () => {
    if (enabled) {
      // 写入设置失败时撤销注册，避免实验在用户不知情时保持启用。
      // 已经启用时若 storage 写入失败，不应顺手注销原有正常注册。
      const wasRegistered = await getRafRegistration();
      if (!wasRegistered) await registerRafExperiment();
      try { await chrome.storage.local.set({[RAF_EXPERIMENT_KEY]: true}); }
      catch (error) {
        if (!wasRegistered) await unregisterRafExperiment();
        throw error;
      }
      // 关键修复：立刻覆盖已经打开的 Meet；无需等下次页面导航。
      // 即时注入可能发生在 Meet 初始化后，建议刷新以测试最完整的 document_start 行为。
      const rooms = await repairRafBridgeInOpenRooms().catch(() => ({checked:0,active:0,failed:1}));
      return {enabled:true,registered:await getRafRegistration(),reloadRequired:true,rooms};
    } else {
      await chrome.storage.local.set({[RAF_EXPERIMENT_KEY]: false});
      // 即使注销持久注入失败，也先停止当前页面的桥接，尊重关闭指令。
      try { await unregisterRafExperiment(); }
      finally { await stopRafExperimentInOpenRooms(); }
    }
    return {enabled, registered:await getRafRegistration(), reloadRequired:true};
  });
}

async function rafExperimentStatus() {
  return serializedExperimentChange(async () => {
    const setting = await chrome.storage.local.get({[RAF_EXPERIMENT_KEY]: RAF_DEFAULT_ENABLED});
    const enabled = setting[RAF_EXPERIMENT_KEY] === true;
    const registered = await getRafRegistration();
    const rooms = enabled ? await inspectOpenRafRooms(false).catch(() => ({checked:0,active:0,missing:0,failed:1})) : null;
    return {enabled, registered, rooms};
  });
}

async function reconcileRafExperiment() {
  if (!chrome.storage?.local || !chrome.scripting?.getRegisteredContentScripts) return;
  return serializedExperimentChange(async () => {
    const saved = await chrome.storage.local.get({[RAF_EXPERIMENT_KEY]:RAF_DEFAULT_ENABLED});
    if (saved[RAF_EXPERIMENT_KEY] === true) {
      await registerRafExperiment();
      await repairRafBridgeInOpenRooms().catch(() => {});
    } else {
      // 设置已关闭时也恢复仍打开的页面，避免 Worker 中断后的遗留桥接。
      try { await unregisterRafExperiment(); }
      finally { await stopRafExperimentInOpenRooms(); }
    }
  });
}


// MV3 Service Worker 会被挂起，因此不在这里用 setInterval。
// 这些 Map 只是当前 Worker 生命周期的临时去重状态，不记录用户信息。
const inFlight = new Map();
const recentInjection = new Map();

function isMeetRoom(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'meet.google.com' &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(u.pathname);
  } catch { return false; }
}

function isGoneOrFrozen(tab) {
  return !tab || !Number.isInteger(tab.id) || tab.discarded === true || tab.frozen === true ||
    tab.status === 'loading';
}

function withDeadline(task, delayMs = WAIT_FOR_REPLY_MS) {
  let timer;
  return Promise.race([
    task,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('health-ping-timeout')), delayMs); }),
  ]).finally(() => clearTimeout(timer));
}

function noListener(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error));
}

// Chrome action badge 支持指定 tabId，不新增 tabs/notifications 权限，也不读取姓名。
// 没有健康回复不能继续保留旧的“正常”徽标；与名单缺失的黄色 ! 区分。
async function markUnverifiedBadge(tabId) {
  if (!chrome.action?.setBadgeText) return;
  try {
    await chrome.action.setBadgeText({tabId, text: '?'});
    if (chrome.action.setBadgeBackgroundColor)
      await chrome.action.setBadgeBackgroundColor({tabId, color: '#6b7280'});
  } catch { /* 标签页可能已被关闭，不影响其他会议 */ }
}

async function updateCoverageBadge(tabId, health) {
  if (!chrome.action?.setBadgeText) return;
  const enabled = health?.alive && health?.configReady && health?.enabled && !health?.paused;
  const blind = enabled && health.coverageStatus === 'blind';
  try {
    await chrome.action.setBadgeText({tabId, text: blind ? '!' : ''});
    if (blind && chrome.action.setBadgeBackgroundColor)
      await chrome.action.setBadgeBackgroundColor({tabId, color: '#ea8600'});
  } catch { /* 标签页已关闭或当前 Chrome 不支持 per-tab 徽标，不影响巡检 */ }
}

async function ensureHealth(tab) {
  if (isGoneOrFrozen(tab) || !isMeetRoom(tab.url)) return 'skipped';
  if (inFlight.has(tab.id)) return inFlight.get(tab.id);
  const run = (async () => {
    let health;
    try {
      health = await withDeadline(chrome.tabs.sendMessage(tab.id, {
        protocol: HEALTH_PROTOCOL,
        action: 'PING',
      }));
    } catch (error) {
      if (!noListener(error)) {
        // 超时、冻结或页面重建时可能只是响应延迟；不盲目启动第二引擎。
        await markUnverifiedBadge(tab.id);
        return 'unresponsive';
      }
      const now = Date.now();
      const lastTry = recentInjection.get(tab.id);
      if (lastTry && lastTry.url === tab.url && now - lastTry.time < RETRY_COOLDOWN_MS) {
        await markUnverifiedBadge(tab.id);
        return 'cooldown';
      }
      recentInjection.set(tab.id, { time: now, url: tab.url });
      try {
        // 永远在扩展隔离世界执行本地 content.js，不执行来自网页的字符串代码。
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          files: ['content.js'],
          world: 'ISOLATED',
        });
        await markUnverifiedBadge(tab.id); // 补注入后尚未 PING 验证，不假称健康。
        return 'injected';
      } catch (injectionError) {
        // 可能是页面导航、权限未生效或标签页已冻结；下轮按冷却策略重试。
        // 异常消息可能带会议 URL，不写入日志；这里只记录错误类型。
        console.warn('[MeetNameSentry Monitor] 未能恢复巡检脚本：', safeErrorKind(injectionError));
        await markUnverifiedBadge(tab.id);
        return 'failed';
      }
    }
    if (health?.protocol !== HEALTH_PROTOCOL || health.alive !== true) {
      await markUnverifiedBadge(tab.id);
      return 'unverified';
    }
    await updateCoverageBadge(tab.id, health);
    // 配置禁止执行、未初始化或处置中，都不允许后台强制开始新的移出流程。
    const staleCycle = Number.isFinite(health.lastCycleAt) &&
      Date.now() - health.lastCycleAt > STALE_CYCLE_MS;
    const stalePatrol = health.configReady && health.enabled &&
      Number.isFinite(health.lastPatrolAt) &&
      Date.now() - health.lastPatrolAt > STALE_PATROL_MS;
    // 空循环不再被误当作“巡检正常”：只唤醒同一引擎，不强行重复注入或踢人。
    if (!health.busy && (staleCycle || stalePatrol) &&
        (!health.configReady || (health.enabled && !health.paused))) {
      try {
        await withDeadline(chrome.tabs.sendMessage(tab.id, {
          protocol: HEALTH_PROTOCOL,
          action: 'WAKE',
        }));
        return 'woken';
      } catch { await markUnverifiedBadge(tab.id); return 'unresponsive'; }
    }
    return health.configReady && health.enabled && !health.paused &&
      health.coverageStatus === 'blind' ? 'blind' : 'healthy';
  })();
  inFlight.set(tab.id, run);
  try { return await run; }
  finally { if (inFlight.get(tab.id) === run) inFlight.delete(tab.id); }
}

async function scanMeetRooms() {
  let tabs;
  try { tabs = await chrome.tabs.query({ url: MEET_URL }); }
  catch { return; }
  await Promise.allSettled(tabs.filter((tab) => isMeetRoom(tab.url)).map(ensureHealth));
  // Worker 定期自检：已注册并不等于页面已运行桥接。仅开启实验时补缺失实例。
  await serializedExperimentChange(async () => {
    const setting = await chrome.storage.local.get({[RAF_EXPERIMENT_KEY]:RAF_DEFAULT_ENABLED});
    if (setting[RAF_EXPERIMENT_KEY] !== true) return;
    await Promise.allSettled(tabs.filter((tab) => isMeetRoom(tab.url)).map((tab) => rafBridgeInTab(tab, true)));
  }).catch(() => {});
}

async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_MINUTES });
  } catch (error) {
    // Chrome 异常消息可能包含浏览器路径或 URL，日志仅记录错误类型。
    console.warn('[MeetNameSentry Monitor] 无法建立后台检查任务：', safeErrorKind(error));
  }
}

// 事件监听始终在 Worker 顶层注册，确保 Chrome 唤醒时能立即接收事件。
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); void scanMeetRooms(); void reconcileRafExperiment().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); void scanMeetRooms(); void reconcileRafExperiment().catch(() => {}); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void scanMeetRooms();
});
chrome.tabs.onUpdated.addListener((id, changed, tab) => {
  if (changed.status === 'loading' || changed.url) recentInjection.delete(id);
  if (changed.status === 'complete' || (changed.url && tab.status === 'complete')) {
    void ensureHealth(tab);
    if (isMeetRoom(tab.url)) void repairRafBridgeAfterNavigation(tab).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await ensureHealth(await chrome.tabs.get(tabId)); }
  catch { /* 标签页可能恰好被关闭 */ }
});
chrome.tabs.onRemoved.addListener((tabId) => { recentInjection.delete(tabId); inFlight.delete(tabId); });

// 仅扩展自己的弹窗设置页允许管理后台名单辅助；不接收网页或内容脚本的设置请求。
if (chrome.runtime.onMessage?.addListener) chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 即使来自本扩展的内容脚本，也不能通过此管理协议操作后台 rAF 桥。
  const settingsURL = chrome.runtime.getURL?.('popup.html');
  if (msg?.protocol !== RAF_EXPERIMENT_PROTOCOL || !settingsURL ||
      sender?.id !== chrome.runtime.id || sender?.url !== settingsURL ||
      !['STATUS','ENABLE','DISABLE'].includes(msg.action)) return false;
  const action = msg.action === 'STATUS' ? rafExperimentStatus() :
    setRafExperiment(msg.action === 'ENABLE');
  action.then((data) => sendResponse({ok:true,...data}),
    (error) => sendResponse({ok:false,error:error?.name || 'experiment-operation-failed'}));
  return true;
});

// 浏览器有时不保留 alarms；在 Worker 启动时做幂等检查。
void ensureAlarm();
void reconcileRafExperiment().catch(() => { /* 实验失败不影响巡检 */ });
