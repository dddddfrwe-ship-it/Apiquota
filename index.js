import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "quota-tracker";
const defaultSettings = {
  credits: 0,
  models: {}, // { modelName: costPerMessage }
  activeModel: "",
  autoDeduct: true,
  lastAction: "",
};

function getSettings() {
  if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = structuredClone(defaultSettings);
  }
  for (const key of Object.keys(defaultSettings)) {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
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

function calcRemaining() {
  const settings = getSettings();
  const cost = settings.models[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) {
    return null;
  }
  return Math.floor(settings.credits / cost);
}

function renderModelOptions() {
  const settings = getSettings();
  const $select = $("#qt-active-model");
  $select.empty();
  $select.append(`<option value="">-- เลือกโมเดล --</option>`);
  for (const name of Object.keys(settings.models)) {
    const selected = name === settings.activeModel ? "selected" : "";
    $select.append(`<option value="${escapeHtml(name)}" ${selected}>${escapeHtml(name)}</option>`);
  }
}

function renderModelTable() {
  const settings = getSettings();
  const $tbody = $("#qt-model-table-body");
  $tbody.empty();
  for (const [name, cost] of Object.entries(settings.models)) {
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

function updateDisplay() {
  const settings = getSettings();
  $("#qt-credits-input").val(settings.credits);
  $("#qt-autodeduct-checkbox").prop("checked", settings.autoDeduct);
  renderModelOptions();
  renderModelTable();

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
  const cost = settings.models[settings.activeModel];
  if (!settings.activeModel || !cost || cost <= 0) {
    settings.lastAction = `ไม่ได้หัก (ยังไม่ได้ตั้งค่าโมเดล/ราคา) — ${new Date().toLocaleTimeString()}`;
    saveSettings();
    updateDisplay();
    return;
  }
  settings.credits = Math.max(0, settings.credits - cost);
  settings.lastAction = `หัก ${cost} เครดิต (${reason}) — เหลือ ${settings.credits} — ${new Date().toLocaleTimeString()}`;
  saveSettings();
  updateDisplay();
}

// This only fires when a character/AI message is actually added to the chat.
// If a generation fails, times out, or errors out ("ติดแดง"), no message is
// ever added, so this handler never runs and credits are left untouched.
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

function buildUi() {
  const html = `
  <div id="quota-tracker-settings" class="quota-tracker-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📊 API Quota Tracker</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="qt-section">
          <label for="qt-credits-input">เครดิตคงเหลือ (กรอกมือ)</label>
          <input type="number" id="qt-credits-input" class="text_pole" min="0" step="0.01" placeholder="เช่น 500" />
        </div>

        <div class="qt-section">
          <label>เพิ่มโมเดลใหม่ (ชื่อ + ค่าใช้จ่ายต่อ 1 ข้อความ)</label>
          <div class="qt-row">
            <input type="text" id="qt-new-model-name" class="text_pole" placeholder="ชื่อโมเดล เช่น claude-opus-4-8" />
            <input type="number" id="qt-new-model-cost" class="text_pole" min="0" step="0.0001" placeholder="ค่าใช้จ่าย/ข้อความ" />
            <button id="qt-add-model" class="menu_button">เพิ่ม</button>
          </div>
        </div>

        <div class="qt-section">
          <table class="qt-table">
            <thead>
              <tr><th>โมเดล</th><th>ค่าใช้จ่าย/ข้อความ</th><th></th></tr>
            </thead>
            <tbody id="qt-model-table-body"></tbody>
          </table>
        </div>

        <div class="qt-section">
          <label for="qt-active-model">โมเดลที่ใช้งานอยู่ตอนนี้ (ใช้คำนวณ)</label>
          <select id="qt-active-model" class="text_pole"></select>
        </div>

        <div class="qt-section qt-checkbox-row">
          <label>
            <input type="checkbox" id="qt-autodeduct-checkbox" />
            หักเครดิตอัตโนมัติเมื่อ AI ตอบกลับสำเร็จ (ถ้าพัง/แดง จะไม่หัก)
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

  $("#extensions_settings2").append(html);

  $("#qt-credits-input").on("input", function () {
    const settings = getSettings();
    settings.credits = parseFloat($(this).val()) || 0;
    saveSettings();
    updateDisplay();
  });

  $("#qt-add-model").on("click", function () {
    const name = $("#qt-new-model-name").val().trim();
    const cost = parseFloat($("#qt-new-model-cost").val());
    if (!name || isNaN(cost) || cost < 0) {
      toastr.warning("กรอกชื่อโมเดลและค่าใช้จ่ายให้ถูกต้องก่อน");
      return;
    }
    const settings = getSettings();
    settings.models[name] = cost;
    if (!settings.activeModel) settings.activeModel = name;
    saveSettings();
    $("#qt-new-model-name").val("");
    $("#qt-new-model-cost").val("");
    updateDisplay();
  });

  $(document).on("click", ".qt-delete-model", function () {
    const name = $(this).data("model");
    const settings = getSettings();
    delete settings.models[name];
    if (settings.activeModel === name) settings.activeModel = "";
    saveSettings();
    updateDisplay();
  });

  $("#qt-active-model").on("change", function () {
    const settings = getSettings();
    settings.activeModel = $(this).val();
    saveSettings();
    updateDisplay();
  });

  $("#qt-autodeduct-checkbox").on("change", function () {
    const settings = getSettings();
    settings.autoDeduct = $(this).prop("checked");
    saveSettings();
    updateDisplay();
  });

  $("#qt-manual-deduct").on("click", function () {
    deductForOneMessage("หักมือ");
  });

  $("#qt-reset").on("click", function () {
    if (!confirm("รีเซ็ตเครดิตและรายการโมเดลทั้งหมด?")) return;
    extension_settings[extensionName] = structuredClone(defaultSettings);
    saveSettings();
    updateDisplay();
  });
}

jQuery(async () => {
  getSettings();
  buildUi();
  updateDisplay();

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
});
