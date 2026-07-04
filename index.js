import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "quota-tracker";
const defaultSettings = {
  credits: {},       // { apiLabel: number }
  modelCosts: {},    // { modelName: costPerMessage }
  activeModel: "",
  apiLabel: "default",
  knownLabels: ["default"],
  autoDeduct: true,
  lastDeduction: null, // { amount, remaining, time } | null
};

function getSettings() {
  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = structuredClone(defaultSettings);
  }
  for (const key of Object.keys(defaultSettings)) {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = structuredClone(defaultSettings[key]);
    }
  }
  return extension_settings[extensionName];
}

function saveSettings() {
  saveSettingsDebounced();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function apiKey() {
  const settings = getSettings();
  return settings.apiLabel || "default";
}

function addKnownLabel(label) {
  const settings = getSettings();
  if (!settings.knownLabels.includes(label)) {
    settings.knownLabels.push(label);
    saveSettings();
  }
}

function switchToLabel(label) {
  const settings = getSettings();
  addKnownLabel(label);
  settings.apiLabel = label;
  saveSettings();
  updateDisplay();
}

function getCredits() {
  const settings = getSettings();
  return settings.credits[apiKey()] || 0;
}

function setCredits(value) {
  const settings = getSettings();
  settings.credits[apiKey()] = value;
  saveSettings();
}

function calcRemaining() {
  const settings = getSettings();
  const cost = settings.modelCosts[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) return null;
  return Math.floor(getCredits() / cost);
}

// ---- Best-effort detection of the active model / API from the native ST UI ----
function readModelFromDom() {
  let val = null;
  $('select[id^="model_"][id$="_select"]:visible').each(function () {
    if ($(this).val()) val = $(this).val();
  });
  if (!val) {
    const $custom = $("#custom_model_id");
    if ($custom.length && $custom.val()) val = $custom.val();
  }
  return val || null;
}

function findApiKeyInput() {
  const $candidates = $('input[id*="api_key" i]:visible');
  return $candidates.length ? $candidates.first() : null;
}

// Returns a label based on whatever we can currently see in the UI.
// Priority: named Connection Profile > freshly typed API key (last 6 chars,
// never the full key) > source + base URL.
// Note: once a key is saved, ST hides its real value behind a placeholder,
// so this can only "see" a key while it's actively being typed/pasted in.
// For already-saved keys, use the dropdown in the panel to switch manually.
function detectApiLabel() {
  const $profileSel = $("#connection_profiles");
  if ($profileSel.length) {
    const text = $profileSel.find("option:selected").text().trim();
    if (text && text !== "<None>" && text.toLowerCase() !== "none") {
      return text;
    }
  }

  const source = $("#chat_completion_source").length ? $("#chat_completion_source").val() : null;
  const baseUrl = $("#custom_api_url_text").length ? $("#custom_api_url_text").val() : null;

  const $keyInput = findApiKeyInput();
  const keyVal = $keyInput ? $keyInput.val() : "";
  if (keyVal && keyVal.trim().length >= 6) {
    const suffix = keyVal.trim().slice(-6);
    return `${source || "custom"} · key:${suffix}`;
  }

  if (source) {
    return baseUrl ? `${source} · ${baseUrl}` : source;
  }
  return null;
}

function syncApiContext() {
  const detected = detectApiLabel();
  if (detected) switchToLabel(detected);

  // ST may repopulate the model dropdown asynchronously after switching
  // API/profile/key, so re-check shortly after instead of only reacting
  // to a 'change' event that may never fire on a programmatic update.
  setTimeout(() => {
    const val = readModelFromDom();
    if (val && getSettings().activeModel !== val) {
      getSettings().activeModel = val;
      saveSettings();
      updateDisplay();
    }
  }, 400);
}

function onModelChanged() {
  const val = readModelFromDom();
  if (!val) return;
  const settings = getSettings();
  if (settings.activeModel === val) return;
  settings.activeModel = val;
  saveSettings();
  updateDisplay();
}

// ---- Rendering ----
function renderModelTable() {
  const settings = getSettings();
  const $tbody = $("#qt-model-table-body");
  if (!$tbody.length) return;
  $tbody.empty();
  for (const [name, cost] of Object.entries(settings.modelCosts)) {
    const row = $(`
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${cost}</td>
        <td><button class="menu_button qt-delete-model" data-model="${escapeHtml(name)}">ลบ</button></td>
      </tr>
    `);
    $tbody.append(row);
  }
}

function renderActiveModelBox() {
  const settings = getSettings();
  const $box = $("#qt-active-model-box");
  if (!$box.length) return;

  if (!settings.activeModel) {
    $box.html(`<i>ยังไม่รู้จักโมเดลปัจจุบัน — ลองเลือก/พิมพ์โมเดลในช่องด้านบนอีกครั้ง</i>`);
    return;
  }

  const cost = settings.modelCosts[settings.activeModel];
  if (cost === undefined) {
    $box.html(`
      <div>โมเดลปัจจุบัน: <b>${escapeHtml(settings.activeModel)}</b> — ยังไม่ได้ตั้งราคา</div>
      <div class="qt-row">
        <input type="number" id="qt-quick-cost" class="text_pole" min="0" step="0.0001" placeholder="ค่าใช้จ่าย/ข้อความ" />
        <button id="qt-quick-cost-save" class="menu_button">บันทึกราคา</button>
      </div>
    `);
  } else {
    $box.html(`โมเดลปัจจุบัน: <b>${escapeHtml(settings.activeModel)}</b> — ${cost} เครดิต/ข้อความ`);
  }
}

function renderLabelSelect() {
  const settings = getSettings();
  const $select = $("#qt-api-label-select");
  if (!$select.length) return;
  $select.empty();
  for (const label of settings.knownLabels) {
    const selected = label === apiKey() ? "selected" : "";
    $select.append(`<option value="${escapeHtml(label)}" ${selected}>${escapeHtml(label)}</option>`);
  }
  $select.append(`<option value="__new__">+ เพิ่มชื่อใหม่...</option>`);
}

function updateDisplay() {
  const settings = getSettings();
  renderLabelSelect();
  $("#qt-credits-input").val(getCredits());
  $("#qt-autodeduct-checkbox").prop("checked", settings.autoDeduct);
  renderModelTable();
  renderActiveModelBox();

  const remaining = calcRemaining();
  const $result = $("#qt-remaining-display");
  if (remaining === null) {
    $result.text("เลือกโมเดลและกำหนดค่าใช้จ่ายก่อน เพื่อคำนวณ");
  } else {
    $result.text(`เล่นได้อีกประมาณ ${remaining.toLocaleString()} ข้อความ`);
  }

  const $deduction = $("#qt-deduction-log");
  if (settings.lastDeduction) {
    const { amount, remaining: rem, time } = settings.lastDeduction;
    $deduction.html(`<span class="qt-deduction-amount">-${amount}</span> เครดิต ตอน ${time} — คงเหลือ ${rem}`);
  } else {
    $deduction.text("ยังไม่มีการหักเครดิต");
  }
}

function flashCredits() {
  const $el = $("#qt-credits-input");
  $el.addClass("qt-flash");
  setTimeout(() => $el.removeClass("qt-flash"), 1200);
}

function deductForOneMessage() {
  const settings = getSettings();
  const cost = settings.modelCosts[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) return;

  const newCredits = Math.max(0, getCredits() - cost);
  setCredits(newCredits);
  settings.lastDeduction = {
    amount: cost,
    remaining: newCredits,
    time: new Date().toLocaleTimeString(),
  };
  saveSettings();
  updateDisplay();
  flashCredits();
}

// Only fires when a character/AI message is actually added to the chat.
// If a generation fails, times out, or errors out ("ติดแดง"), no message is
// ever added, so this handler never runs and credits stay untouched.
function onMessageReceived(mesId) {
  const settings = getSettings();
  if (!settings.autoDeduct) return;
  try {
    const context = getContext();
    const message = context.chat[mesId];
    if (!message || message.is_user || message.is_system) return;
    deductForOneMessage();
  } catch (e) {
    console.error("[QuotaTracker] Error in onMessageReceived", e);
  }
}

const panelHtml = `
<div id="quota-tracker-panel" class="quota-tracker-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Quota Tracker</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <div class="qt-section">
        <label for="qt-api-label-select">API/บัญชีปัจจุบัน</label>
        <div class="qt-row">
          <select id="qt-api-label-select" class="text_pole"></select>
          <button id="qt-api-label-delete" class="menu_button" title="ลบชื่อนี้ออกจากรายการ">ลบ</button>
        </div>
        <div id="qt-api-new-row" class="qt-row" style="display:none;">
          <input type="text" id="qt-api-label-input" class="text_pole" placeholder="ชื่อ API ใหม่ เช่น gemai-claude" />
          <button id="qt-api-label-save" class="menu_button">เพิ่ม</button>
        </div>
        <small class="qt-hint">พิมพ์/วางคีย์ใหม่ในช่อง API Key จะเพิ่มเข้ารายการนี้ให้เองอัตโนมัติ ถ้าเป็นคีย์เก่าที่บันทึกไว้แล้ว เลือกจากดรอปดาวน์นี้แทนได้เลย</small>
      </div>

      <div class="qt-section">
        <label for="qt-credits-input">เครดิตคงเหลือ (ของ API นี้)</label>
        <div class="qt-row">
          <input type="number" id="qt-credits-input" class="text_pole" min="0" step="0.01" placeholder="เช่น 500" />
          <button id="qt-credits-save" class="menu_button">บันทึก</button>
        </div>
        <small id="qt-deduction-log" class="qt-hint"></small>
      </div>

      <div class="qt-section">
        <div id="qt-active-model-box" class="qt-active-model-box"></div>
      </div>

      <div class="qt-section">
        <label>เพิ่ม/แก้ราคาโมเดล (ชื่อ + ค่าใช้จ่ายต่อ 1 ข้อความ)</label>
        <div class="qt-row">
          <input type="text" id="qt-new-model-name" class="text_pole" placeholder="ชื่อโมเดล" />
          <input type="number" id="qt-new-model-cost" class="text_pole" min="0" step="0.0001" placeholder="ค่าใช้จ่าย/ข้อความ" />
          <button id="qt-add-model" class="menu_button">บันทึก</button>
        </div>
      </div>

      <div class="qt-section">
        <table class="qt-table">
          <thead><tr><th>โมเดล</th><th>ค่าใช้จ่าย/ข้อความ</th><th></th></tr></thead>
          <tbody id="qt-model-table-body"></tbody>
        </table>
      </div>

      <div class="qt-section qt-checkbox-row">
        <label>
          <input type="checkbox" id="qt-autodeduct-checkbox" />
          หักเครดิตอัตโนมัติเมื่อ AI ตอบกลับสำเร็จ (ติดแดงจะไม่หัก)
        </label>
      </div>

      <div class="qt-section">
        <h4 id="qt-remaining-display" class="qt-remaining"></h4>
      </div>
    </div>
  </div>
</div>
`;

function bindPanelEvents() {
  $("#qt-credits-save").off("click").on("click", function () {
    const val = parseFloat($("#qt-credits-input").val());
    if (isNaN(val) || val < 0) {
      toastr.warning("กรอกจำนวนเครดิตให้ถูกต้องก่อน");
      return;
    }
    setCredits(val);
    updateDisplay();
    toastr.success("บันทึกเครดิตแล้ว");
  });

  $("#qt-api-label-select").off("change").on("change", function () {
    const val = $(this).val();
    if (val === "__new__") {
      $("#qt-api-new-row").show();
      $("#qt-api-label-input").val("").trigger("focus");
      return;
    }
    $("#qt-api-new-row").hide();
    switchToLabel(val);
  });

  $("#qt-api-label-save").off("click").on("click", function () {
    const val = $("#qt-api-label-input").val().trim();
    if (!val) {
      toastr.warning("กรอกชื่อ API ก่อน");
      return;
    }
    $("#qt-api-new-row").hide();
    switchToLabel(val);
    toastr.success("เพิ่มแล้ว");
  });

  $("#qt-api-label-delete").off("click").on("click", function () {
    const settings = getSettings();
    const current = apiKey();
    if (current === "default") {
      toastr.warning("ลบชื่อ default ไม่ได้");
      return;
    }
    if (!confirm(`ลบ "${current}" ออกจากรายการ? (เครดิตของชื่อนี้จะหายไปด้วย)`)) return;
    settings.knownLabels = settings.knownLabels.filter((l) => l !== current);
    delete settings.credits[current];
    settings.apiLabel = "default";
    saveSettings();
    updateDisplay();
  });

  $("#qt-add-model").off("click").on("click", function () {
    const name = $("#qt-new-model-name").val().trim();
    const cost = parseFloat($("#qt-new-model-cost").val());
    if (!name || isNaN(cost) || cost < 0) {
      toastr.warning("กรอกชื่อโมเดลและค่าใช้จ่ายให้ถูกต้องก่อน");
      return;
    }
    const settings = getSettings();
    settings.modelCosts[name] = cost;
    if (!settings.activeModel) settings.activeModel = name;
    saveSettings();
    $("#qt-new-model-name").val("");
    $("#qt-new-model-cost").val("");
    updateDisplay();
  });

  $(document).off("click", ".qt-delete-model").on("click", ".qt-delete-model", function () {
    const name = $(this).data("model");
    const settings = getSettings();
    delete settings.modelCosts[name];
    saveSettings();
    updateDisplay();
  });

  $(document).off("click", "#qt-quick-cost-save").on("click", "#qt-quick-cost-save", function () {
    const cost = parseFloat($("#qt-quick-cost").val());
    if (isNaN(cost) || cost < 0) {
      toastr.warning("กรอกราคาให้ถูกต้องก่อน");
      return;
    }
    const settings = getSettings();
    settings.modelCosts[settings.activeModel] = cost;
    saveSettings();
    updateDisplay();
  });

  $("#qt-autodeduct-checkbox").off("change").on("change", function () {
    const settings = getSettings();
    settings.autoDeduct = $(this).prop("checked");
    saveSettings();
  });

  // Best-effort sync with ST's own model pickers / API source / profile /
  // key controls. These fire automatically and switch the whole panel over
  // (credits + deduction log) with no confirmation needed.
  $(document)
    .off("change.qt", 'select[id^="model_"][id$="_select"]')
    .on("change.qt", 'select[id^="model_"][id$="_select"]', onModelChanged);
  $(document)
    .off("input.qt change.qt", "#custom_model_id")
    .on("input.qt change.qt", "#custom_model_id", onModelChanged);
  $(document)
    .off("change.qt", "#connection_profiles, #chat_completion_source, #custom_api_url_text")
    .on("change.qt", "#connection_profiles, #chat_completion_source, #custom_api_url_text", syncApiContext);
  $(document)
    .off("input.qt change.qt", 'input[id*="api_key" i]')
    .on("input.qt change.qt", 'input[id*="api_key" i]', syncApiContext);
}

function injectPanel(container) {
  if ($("#quota-tracker-panel").length) return;
  $(container).append(panelHtml);
  bindPanelEvents();
  updateDisplay();
}

function tryInject(retries = 20) {
  if ($("#quota-tracker-panel").length) return;
  const container = document.querySelector("#rm_api_block") || document.querySelector("#rm_api_key_block");
  if (container) {
    injectPanel(container);
  } else if (retries > 0) {
    setTimeout(() => tryInject(retries - 1), 500);
  } else {
    console.warn("[QuotaTracker] Could not find #rm_api_block, falling back to <body>.");
    injectPanel(document.body);
  }
}

jQuery(async () => {
  getSettings();

  const detectedModel = readModelFromDom();
  if (detectedModel) getSettings().activeModel = detectedModel;

  const detectedApi = detectApiLabel();
  if (detectedApi) {
    addKnownLabel(detectedApi);
    getSettings().apiLabel = detectedApi;
  }

  tryInject();

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
});
