import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "quota-tracker";
const defaultSettings = {
  credits: {},       // { apiLabel: number }
  modelCosts: {},    // { apiLabel: { modelName: costPerMessage } }
  activeModel: "",
  apiLabel: "default",
  knownLabels: ["default"],
  autoDeduct: true,
  creditEvents: {}, // { apiLabel: { type: 'manual'|'deduct', amount, remaining, time } }
};

function getSettings() {
  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = structuredClone(defaultSettings);
  }
  const settings = extension_settings[extensionName];
  for (const key of Object.keys(defaultSettings)) {
    const def = defaultSettings[key];
    const cur = settings[key];
    const defIsObject = def !== null && typeof def === "object";
    const curIsObject = cur !== null && typeof cur === "object";
    // Repair leftover values from an older version of this extension where
    // a field had a different shape (e.g. "credits" used to be a plain
    // number, now it's an object keyed by API label).
    if (cur === undefined || (defIsObject && !curIsObject)) {
      settings[key] = structuredClone(def);
    }
  }

  // Repair fields left over from older versions of this extension that used
  // a different shape (e.g. `credits` used to be a single number instead of
  // a per-API-label object). Without this, writing to e.g. credits["x"]
  // throws once the stored value is a primitive instead of an object.
  const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlainObject(settings.credits)) settings.credits = {};
  if (!isPlainObject(settings.modelCosts)) settings.modelCosts = {};
  if (!isPlainObject(settings.creditEvents)) settings.creditEvents = {};
  if (!Array.isArray(settings.knownLabels)) settings.knownLabels = ["default"];

  return settings;
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

function getModelCosts() {
  const settings = getSettings();
  const key = apiKey();
  if (!settings.modelCosts[key]) settings.modelCosts[key] = {};
  return settings.modelCosts[key];
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

function recordCreditEvent(type, amount, remaining) {
  const settings = getSettings();
  settings.creditEvents[apiKey()] = {
    type,
    amount,
    remaining,
    time: new Date().toLocaleTimeString(),
  };
  saveSettings();
}

function getCreditEvent() {
  const settings = getSettings();
  return settings.creditEvents[apiKey()] || null;
}

function calcRemaining() {
  const settings = getSettings();
  const cost = getModelCosts()[settings.activeModel];
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
  return val ? String(val).trim() : null;
}

function findApiKeyInput() {
  let found = null;
  $("input:visible").each(function () {
    const id = (this.id || "").toLowerCase();
    if (!found && id.includes("api_key")) {
      found = $(this);
    }
  });
  return found;
}

// Returns a label based on whatever we can currently see in the UI.
// Priority:
//   1. A key currently being typed/pasted (last 6 chars, never the full key)
//   2. The active secret's name from ST's own Secrets Manager, read off the
//      key field's placeholder text, e.g. "บันทึก API Key แล้ว (Claude)" -> "Claude"
//   3. A named Connection Profile
//   4. Chat completion source + custom base URL
// Note: a saved key's real value is hidden by ST, so #1 only works for a
// key that hasn't been saved yet. Once saved, #2 (the Secrets Manager name)
// is the reliable source, since ST shows which saved secret is active.
function detectApiLabel() {
  const $keyInput = findApiKeyInput();
  if ($keyInput) {
    const keyVal = $keyInput.val();
    if ($keyInput.is(":focus") && keyVal && keyVal.trim().length >= 6) {
      return `key:${keyVal.trim().slice(-6)}`;
    }
    const placeholder = $keyInput.attr("placeholder") || "";
    const match = placeholder.match(/\(([^)]+)\)/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  const $profileSel = $("#connection_profiles");
  if ($profileSel.length) {
    const text = $profileSel.find("option:selected").text().trim();
    if (text && text !== "<None>" && text.toLowerCase() !== "none") {
      return text;
    }
  }

  const source = $("#chat_completion_source").length ? $("#chat_completion_source").val() : null;
  const baseUrl = $("#custom_api_url_text").length ? $("#custom_api_url_text").val() : null;
  if (source) {
    return baseUrl ? `${source} · ${baseUrl}` : source;
  }
  return null;
}

function syncApiContext() {
  try {
    const detected = detectApiLabel();
    if (detected) switchToLabel(detected);
  } catch (e) {
    console.error("[QuotaTracker] Error in syncApiContext", e);
  }

  // ST may repopulate the model dropdown asynchronously after switching
  // API/profile/key, so re-check shortly after instead of only reacting
  // to a 'change' event that may never fire on a programmatic update.
  setTimeout(() => {
    try {
      const val = readModelFromDom();
      if (val && getSettings().activeModel !== val) {
        getSettings().activeModel = val;
        saveSettings();
        updateDisplay();
      }
    } catch (e) {
      console.error("[QuotaTracker] Error refreshing model after API change", e);
    }
  }, 400);
}

let lastPolledApiLabel = null;

function pollApiLabel() {
  try {
    const detected = detectApiLabel();
    if (detected && detected !== lastPolledApiLabel) {
      lastPolledApiLabel = detected;
      switchToLabel(detected);
      setTimeout(() => {
        const val = readModelFromDom();
        if (val && getSettings().activeModel !== val) {
          getSettings().activeModel = val;
          saveSettings();
          updateDisplay();
        }
      }, 400);
    }
  } catch (e) {
    console.error("[QuotaTracker] Error polling API label", e);
  }
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
  const $tbody = $("#qt-model-table-body");
  if (!$tbody.length) return;
  $tbody.empty();
  for (const [name, cost] of Object.entries(getModelCosts())) {
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

  const debugLine = `<div class="qt-hint">API: "${escapeHtml(apiKey())}" | โมเดล: "${escapeHtml(settings.activeModel || "")}"</div>`;

  if (!settings.activeModel) {
    $box.html(`<i>ยังไม่รู้จักโมเดลปัจจุบัน — ลองเลือก/พิมพ์โมเดลในช่องด้านบนอีกครั้ง</i>${debugLine}`);
    return;
  }

  const cost = getModelCosts()[settings.activeModel];
  if (cost === undefined) {
    $box.html(`
      <div>โมเดลปัจจุบัน: <b>${escapeHtml(settings.activeModel)}</b> — ยังไม่ได้ตั้งราคา</div>
      <div class="qt-row">
        <input type="number" id="qt-quick-cost" class="text_pole" min="0" step="0.0001" placeholder="ค่าใช้จ่าย/ข้อความ" />
        <button id="qt-quick-cost-save" class="menu_button">บันทึกราคา</button>
      </div>
      ${debugLine}
    `);
  } else {
    $box.html(`โมเดลปัจจุบัน: <b>${escapeHtml(settings.activeModel)}</b> — ${cost} เครดิต/ข้อความ${debugLine}`);
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

function renderCreditsDisplay() {
  $("#qt-credits-value").text(`${getCredits().toLocaleString()} เครดิต`);

  const $log = $("#qt-credits-log");
  const event = getCreditEvent();
  if (!event) {
    $log.text("ยังไม่มีประวัติการเปลี่ยนแปลง");
  } else if (event.type === "manual") {
    $log.html(`บันทึกด้วยมือ ตอน ${event.time} — เหลือ ${event.remaining.toLocaleString()}`);
  } else {
    $log.html(`<span class="qt-deduction-amount">-${event.amount}</span> เครดิต (อัตโนมัติ) ตอน ${event.time} — เหลือ ${event.remaining.toLocaleString()}`);
  }
}

function updateDisplay() {
  const settings = getSettings();
  renderLabelSelect();

  // Don't touch the credits edit input while it's open/focused, so a
  // background poll/refresh can't wipe an unsaved edit before Save is clicked.
  if (!$("#qt-credits-edit-row").is(":visible")) {
    renderCreditsDisplay();
  }

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
}

function flashCredits() {
  const $el = $("#qt-credits-value");
  $el.addClass("qt-flash");
  setTimeout(() => $el.removeClass("qt-flash"), 1200);
}

function deductForOneMessage() {
  const settings = getSettings();
  const cost = getModelCosts()[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) return;

  const newCredits = Math.max(0, getCredits() - cost);
  setCredits(newCredits);
  recordCreditEvent("deduct", cost, newCredits);
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
        <label>เครดิตคงเหลือ (ของ API นี้)</label>
        <div id="qt-credits-display" class="qt-row qt-credits-display">
          <span id="qt-credits-value" class="qt-credits-value"></span>
          <button id="qt-credits-edit-btn" class="menu_button">แก้ไข</button>
        </div>
        <div id="qt-credits-edit-row" class="qt-row" style="display:none;">
          <input type="number" id="qt-credits-input" class="text_pole" min="0" step="0.01" placeholder="เช่น 500" />
          <button id="qt-credits-save" class="menu_button">บันทึก</button>
          <button id="qt-credits-cancel" class="menu_button">ยกเลิก</button>
        </div>
        <small id="qt-credits-log" class="qt-hint"></small>
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
  // All handlers use delegated binding off document (namespaced .qt) instead
  // of binding straight to the element. This is bound once and keeps working
  // even if ST re-renders #rm_api_block and our panel gets re-appended,
  // which could otherwise leave click handlers attached to a detached/stale
  // copy of a button while the visible one silently does nothing.
  $(document).off("click.qt", "#qt-credits-edit-btn").on("click.qt", "#qt-credits-edit-btn", function () {
    $("#qt-credits-input").val(getCredits());
    $("#qt-credits-display").hide();
    $("#qt-credits-edit-row").show();
    $("#qt-credits-input").trigger("focus").trigger("select");
  });

  $(document).off("click.qt", "#qt-credits-cancel").on("click.qt", "#qt-credits-cancel", function () {
    $("#qt-credits-edit-row").hide();
    $("#qt-credits-display").show();
  });

  $(document).off("click.qt", "#qt-credits-save").on("click.qt", "#qt-credits-save", function () {
    const val = parseFloat($("#qt-credits-input").val());
    if (isNaN(val) || val < 0) {
      toastr.warning("กรอกจำนวนเครดิตให้ถูกต้องก่อน");
      return;
    }
    setCredits(val);
    recordCreditEvent("manual", null, val);
    $("#qt-credits-edit-row").hide();
    $("#qt-credits-display").show();
    updateDisplay();
    toastr.success("บันทึกเครดิตแล้ว");
  });

  $(document).off("change.qt", "#qt-api-label-select").on("change.qt", "#qt-api-label-select", function () {
    const val = $(this).val();
    if (val === "__new__") {
      $("#qt-api-new-row").show();
      $("#qt-api-label-input").val("").trigger("focus");
      return;
    }
    $("#qt-api-new-row").hide();
    lastPolledApiLabel = val;
    switchToLabel(val);
  });

  $(document).off("click.qt", "#qt-api-label-save").on("click.qt", "#qt-api-label-save", function () {
    const val = $("#qt-api-label-input").val().trim();
    if (!val) {
      toastr.warning("กรอกชื่อ API ก่อน");
      return;
    }
    $("#qt-api-new-row").hide();
    lastPolledApiLabel = val;
    switchToLabel(val);
    toastr.success("เพิ่มแล้ว");
  });

  $(document).off("click.qt", "#qt-api-label-delete").on("click.qt", "#qt-api-label-delete", function () {
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

  $(document).off("click.qt", "#qt-add-model").on("click.qt", "#qt-add-model", function () {
    const name = $("#qt-new-model-name").val().trim();
    const cost = parseFloat($("#qt-new-model-cost").val());
    if (!name || isNaN(cost) || cost < 0) {
      toastr.warning("กรอกชื่อโมเดลและค่าใช้จ่ายให้ถูกต้องก่อน");
      return;
    }
    const settings = getSettings();
    getModelCosts()[name] = cost;
    if (!settings.activeModel) settings.activeModel = name;
    saveSettings();
    $("#qt-new-model-name").val("");
    $("#qt-new-model-cost").val("");
    updateDisplay();
  });

  $(document).off("click.qt", ".qt-delete-model").on("click.qt", ".qt-delete-model", function () {
    const name = $(this).data("model");
    delete getModelCosts()[name];
    saveSettings();
    updateDisplay();
  });

  $(document).off("click.qt", "#qt-quick-cost-save").on("click.qt", "#qt-quick-cost-save", function () {
    const cost = parseFloat($("#qt-quick-cost").val());
    if (isNaN(cost) || cost < 0) {
      toastr.warning("กรอกราคาให้ถูกต้องก่อน");
      return;
    }
    const settings = getSettings();
    getModelCosts()[settings.activeModel] = cost;
    saveSettings();
    updateDisplay();
  });

  $(document).off("change.qt", "#qt-autodeduct-checkbox").on("change.qt", "#qt-autodeduct-checkbox", function () {
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
    .off("input.qt change.qt", 'input[id*="api_key"]')
    .on("input.qt change.qt", 'input[id*="api_key"]', syncApiContext);
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

  try {
    const detectedModel = readModelFromDom();
    if (detectedModel) getSettings().activeModel = detectedModel;

    const detectedApi = detectApiLabel();
    if (detectedApi) {
      addKnownLabel(detectedApi);
      getSettings().apiLabel = detectedApi;
      lastPolledApiLabel = detectedApi;
    }
  } catch (e) {
    console.error("[QuotaTracker] Error during initial detection", e);
  }

  tryInject();
  setInterval(pollApiLabel, 1500);

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
});
