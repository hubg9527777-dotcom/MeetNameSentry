/*
 * MeetNameSentry v1.0.2 — 后台名单辅助的 rAF 调度桥。
 * MAIN world, document_start; 不伪造可见性、不修改名单、不点击、不读取姓名。
 * 目的：在 Meet 隐藏时为页面待处理 rAF 回调提供低频后备调度，帮助名单更新。
 * 注意：定时器不能强迫 Chrome 的合成器生成真实帧，不能保证后台可用。
 */
(() => {
  'use strict';
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(location.pathname)) return;
  const KEY = '__MNS_RAF_ISOLATED_EXP_V102__';
  if (window[KEY]?.active) return;

  const nativeRAF = window.requestAnimationFrame;
  const nativeCAF = window.cancelAnimationFrame;
  if (typeof nativeRAF !== 'function' || typeof nativeCAF !== 'function') return;

  const pending = new Map();
  let syntheticId = 0;
  let active = true;
  let nativeDelivered = 0;
  let fallbackDelivered = 0;
  let lastNativeAt = 0;
  let lastFallbackAt = 0;
  const startedAt = Date.now();
  const HIDDEN_FALLBACK_MS = 250; // 约 4fps 的后备调度；Chrome 仍可能限制后台计时器

  function finish(id, stamp, kind) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (kind === 'timer' && entry.native !== null) {
      try { nativeCAF.call(window, entry.native); } catch { /* best effort */ }
    }
    if (kind === 'native') { nativeDelivered++; lastNativeAt = Date.now(); }
    else { fallbackDelivered++; lastFallbackAt = Date.now(); }
    // 与浏览器原生 rAF 一样，回调中的异常不能阻止其他回调。
    entry.callback(stamp);
  }

  function wrappedRAF(callback) {
    if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame callback must be a function');
    if (!active) return nativeRAF.call(window, callback);

    // 负数 ID 避免与 Chrome 的正整数原生 requestAnimationFrame ID 混淆。
    const id = --syntheticId;
    const entry = {callback, native: null, timer: null};
    pending.set(id, entry);
    try {
      if (document.hidden) {
        entry.timer = setTimeout(() => finish(id, performance.now(), 'timer'), HIDDEN_FALLBACK_MS);
      } else {
        entry.native = nativeRAF.call(window, (stamp) => finish(id, stamp, 'native'));
        // 原生帧仍可交付时不安排任何额外 timer，避免影响前台性能。
      }
    } catch (error) {
      pending.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      throw error;
    }
    return id;
  }

  function wrappedCAF(id) {
    if (pending.has(id)) {
      const entry = pending.get(id);
      pending.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.native !== null) nativeCAF.call(window, entry.native);
      return;
    }
    return nativeCAF.call(window, id);
  }

  // 标签页由可见进入隐藏时，把已经提交给原生 rAF 的待处理任务切到 timer。
  // 只观察原生 visibilitychange，不阻断、不伪造任何 Google Meet 事件。
  function onVisibilityChange() {
    if (!active) return;
    for (const [id, entry] of pending) {
      if (document.hidden) {
        // 原生帧可能已被 Chrome 挂起：只为尚未回调的任务补一个低频后备计时器。
        if (entry.timer === null)
          entry.timer = setTimeout(() => finish(id, performance.now(), 'timer'), HIDDEN_FALLBACK_MS);
      } else {
        // 恢复可见后立即回到真正的浏览器帧，不让 250ms 的旧后备定时器拖延 UI。
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.native === null)
          entry.native = nativeRAF.call(window, (stamp) => finish(id, stamp, 'native'));
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function stop() {
    if (!active) return false;
    active = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    // 恢复页面 API，并把尚未回调的页面任务交回原生 rAF；不丢失 Meet 的待处理渲染。
    if (window.requestAnimationFrame === wrappedRAF) window.requestAnimationFrame = nativeRAF;
    if (window.cancelAnimationFrame === wrappedCAF) window.cancelAnimationFrame = nativeCAF;
    for (const entry of pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.native !== null) try { nativeCAF.call(window, entry.native); } catch { /* noop */ }
      try { nativeRAF.call(window, entry.callback); } catch { /* 页面已结束时只能安全放弃 */ }
    }
    pending.clear();
    return true;
  }

  const controller = Object.freeze({
    get active() { return active; },
    status() {
      return {
        active, hidden: document.hidden,
        startedAt, nativeDelivered, fallbackDelivered, lastNativeAt, lastFallbackAt,
        pendingCallbacks: pending.size, fallbackDelayMs: HIDDEN_FALLBACK_MS,
        visibilitySpoofed: false,
      };
    },
    stop,
  });
  // 初始化必须是全有或全无，避免只包了一半 rAF/cAF 却被标记为 active。
  try {
    window.requestAnimationFrame = wrappedRAF;
    window.cancelAnimationFrame = wrappedCAF;
    if (window.requestAnimationFrame !== wrappedRAF || window.cancelAnimationFrame !== wrappedCAF)
      throw new Error('raf-hook-not-installed');
    Object.defineProperty(window, KEY, {value: controller, configurable: true});
  } catch {
    active = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (window.requestAnimationFrame === wrappedRAF) window.requestAnimationFrame = nativeRAF;
    if (window.cancelAnimationFrame === wrappedCAF) window.cancelAnimationFrame = nativeCAF;
  }
})();
