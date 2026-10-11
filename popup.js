// popup.js — 与 content.js 共用同一套 storage 字段与默认值
const DEFAULTS = {
  enabled: true,
  dryRun: false,
  requiredKeywords: 'AA',
  keywordWhitelist: '',
  exactWhitelist: '',
  extraRemoveLabels: '',
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const sizeEl = $('size');

// chrome.storage.sync 单个 key 上限约 8192 字节（含 key 名与 JSON 序列化开销）
const ITEM_LIMIT = 8192;
const byteLen = (s) => new TextEncoder().encode(s).length;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    dryRun: $('dryRun').checked,
    requiredKeywords: $('requiredKeywords').value,
    keywordWhitelist: $('keywordWhitelist').value,
    exactWhitelist: $('exactWhitelist').value,
    extraRemoveLabels: $('extraRemoveLabels').value,
  };
}

function writeForm(items) {
  $('enabled').checked = !!items.enabled;
  $('dryRun').checked = !!items.dryRun;
  for (const k of ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels']) {
    $(k).value = items[k] ?? '';
  }
}

function updateHints(payload) {
  const used = byteLen(payload.exactWhitelist) + 'exactWhitelist'.length + 2;
  sizeEl.textContent = used > ITEM_LIMIT * 0.6 ? `白名单 ${used}/${ITEM_LIMIT} 字节` : '';
}

let ready = false;
let timer = 0;
function scheduleSave() {
  if (!ready) return;
  clearTimeout(timer);
  setStatus('保存中…');
  timer = setTimeout(save, 350); // 防抖：输入时不频繁写 sync（sync 有写入频率配额）
}

function save() {
  if (!ready) return;
  const payload = readForm();
  updateHints(payload);
  chrome.storage.sync.set(payload, () => {
    const err = chrome.runtime.lastError;
    if (err) return setStatus(`保存失败：${err.message}`, 'err');
    if (!payload.requiredKeywords.trim()) return setStatus('已保存。未设置必需关键词，不会移出任何人。', 'warn');
    if (payload.dryRun) return setStatus('已保存。试运行中，不会真正移出。', 'warn');
    setStatus('已保存', 'ok');
  });
}

const fieldIds = Object.keys(DEFAULTS);
for (const id of fieldIds) $(id).disabled = true;

chrome.storage.sync.get(DEFAULTS, (items) => {
  if (chrome.runtime.lastError) {
    setStatus('读取配置失败，请重新打开设置。自动保存已停止。', 'err');
    return;
  }
  ready = true;
  for (const id of fieldIds) $(id).disabled = false;
  writeForm({ ...DEFAULTS, ...items });
  updateHints(readForm());
  if (!$('requiredKeywords').value.trim()) setStatus('未设置必需关键词，不会移出任何人。', 'warn');
});

for (const id of ['enabled', 'dryRun']) $(id).addEventListener('change', scheduleSave);
for (const id of ['requiredKeywords', 'keywordWhitelist', 'exactWhitelist', 'extraRemoveLabels']) {
  $(id).addEventListener('input', scheduleSave);
}
