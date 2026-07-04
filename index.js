import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "quota-tracker";
const defaultSettings = {
  credits: {},      // { profileKey: number }
  modelCosts: {},   // { modelName: costPerMessage }
  activeModel: "",
  currentProfile: "default",
  autoDeduct: true,
  lastAction: "",
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

function profileKey() {
  const settings = getSettings();
  return settings.currentProfile || "default";
}

function getCredits() {
  const settings = getSettings();
  const key = profileKey();
  return settings.credits[key] || 0;
}

function setCredits(value) {
  const settings = getSettings();
  const key = profileKey();
  settings.credits[key] = value;
  saveSettings();
}

function calcRemaining() {
  const settings = getSettings();
  const cost = settings.modelCosts[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) return null;
  return Math.floor(getCredits() / cost);
}

// ---- Detect current model from the native ST UI (best-effort) ----
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

function readProfileFromDom() {
  const $sel = $("#connection_profiles");
  if ($sel.length) {
    const text = $sel.find("option:selected").text().trim();
    const val = $sel.val();
    return text || val || null;
  }
  return null;
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

function onProfileEvent(data) {
  let name = null;
  if (typeof data === "string") name = data;
  else if (data && typeof data === "object") name = data.name || data.id || null;
  if (!name) name = readProfileFromDom();
  const settings = getSettings();
  settings.currentProfile = name || "default";
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

function updateDisplay() {
  const settings = getSettings();
  $("#qt-profile-name").text(profileKey());
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

  $("#qt-log").text(settings.lastAction || "");
}

function deductForOneMessage(reason = "AI ตอบกลับสำเร็จ") {
  const settings = getSettings();
  const cost = settings.modelCosts[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) {
    settings.lastAction = `ไม่ได้หัก (ยังไม่ได้ตั้งค่าโมเดล/ราคา) — ${new Date().toLocaleTimeString()}`;
    saveSettings();
    updateDisplay();
    return;
  }
  const current = getCredits();
  setCredits(Math.max(0, current - cost));
  settings.lastAction = `หัก ${cost} เครดิต (${reason}) — เหลือ ${getCredits()} — ${new Date().toLocaleTimeString()}`;
  saveSettings();
  updateDisplay();
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
    deductForOneMessage("AI ตอบกลับสำเร็จ");
  } catch (e) {
    console.error("[QuotaTracker] Error in onMessageReceived", e);
  }
}

const panelHtml = `
<div id="quota-tracker-panel" class="quota-tracker-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>📊 Quota Tracker — <span id="qt-profile-name">default</span></b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="qt-section">
        <label for="qt-credits-input">เครดิตคงเหลือ (ของโปรไฟล์นี้)</label>
        <input type="number" id="qt-credits-input" class="text_pole" min="0" step="0.01" placeholder="เช่น 500" />
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

      <div class="qt-section qt-row">
        <button id="qt-manual-deduct" class="menu_button">หักมือ 1 ข้อความ</button>
        <button id="qt-reset" class="menu_button">รีเซ็ตทั้งหมด</button>
      </div>

      <div class="qt-section">
        <h4 id="qt-remaining-display" class="qt-remaining"></h4>
        <small id="qt-log" class="qt-log"></small>
      </div>
    </div>
  </div>
</div>
`;

function bindPanelEvents() {
  $("#qt-credits-input").off("input").on("input", function () {
    setCredits(parseFloat($(this).val()) || 0);
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
    updateDisplay();
  });

  $("#qt-manual-deduct").off("click").on("click", function () {
    deductForOneMessage("หักมือ");
  });

  $("#qt-reset").off("click").on("click", function () {
    if (!confirm("รีเซ็ตเครดิตและรายการโมเดลทั้งหมด?")) return;
    extension_settings[extensionName] = structuredClone(defaultSettings);
    saveSettings();
    updateDisplay();
  });

  // Best-effort sync with ST's own model pickers / connection profile select.
  $(document)
    .off("change.qt", 'select[id^="model_"][id$="_select"]')
    .on("change.qt", 'select[id^="model_"][id$="_select"]', onModelChanged);
  $(document)
    .off("input.qt change.qt", "#custom_model_id")
    .on("input.qt change.qt", "#custom_model_id", onModelChanged);
  $(document)
    .off("change.qt", "#connection_profiles")
    .on("change.qt", "#connection_profiles", function () {
      onProfileEvent(readProfileFromDom());
    });
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
    // Fallback: nothing found after ~10s, attach at end of body
    // so the feature is still usable and visible instead of silently failing.
    console.warn("[QuotaTracker] Could not find #rm_api_block, falling back to <body>.");
    injectPanel(document.body);
  }
}

jQuery(async () => {
  getSettings();
  const detectedProfile = readProfileFromDom();
  if (detectedProfile) getSettings().currentProfile = detectedProfile;
  const detectedModel = readModelFromDom();
  if (detectedModel) getSettings().activeModel = detectedModel;

  tryInject();

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  if (event_types.CONNECTION_PROFILE_LOADED) {
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, onProfileEvent);
  }
});
