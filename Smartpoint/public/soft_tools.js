(function () {
  if (window.__softToolsPluginLoaded) return;
  window.__softToolsPluginLoaded = true;

  var React = window.React;
  var PluginsAPI = window.PluginsAPI;
  var $ = window.jQuery || window.$;
  var SIDEBAR_STORE_KEY = "soft_tools_sidebar_hidden";

  function loadSidebarHidden() {
    try {
      return window.localStorage.getItem(SIDEBAR_STORE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function storeSidebarHidden(hidden) {
    try {
      window.localStorage.setItem(SIDEBAR_STORE_KEY, hidden ? "1" : "0");
    } catch (_) {}
  }

  function triggerWindowResize() {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (_) {
      var event = document.createEvent("Event");
      event.initEvent("resize", true, true);
      window.dispatchEvent(event);
    }
  }

  function updateSidebarToggleButton(button, hidden) {
    if (!button) return;

    var label = hidden
      ? "\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u0438 \u043c\u0435\u043d\u044e"
      : "\u0421\u0445\u043e\u0432\u0430\u0442\u0438 \u043c\u0435\u043d\u044e";
    var icon = hidden ? "fa fa-bars" : "fa fa-expand";

    button.innerHTML = "<i class=\"" + icon + "\" aria-hidden=\"true\"></i> " + label;
    button.setAttribute("aria-pressed", hidden ? "true" : "false");
    button.setAttribute("title", label);
  }

  function applySidebarHidden(hidden, shouldResize) {
    if (!document.body) return;

    if (hidden) {
      document.body.classList.add("soft-tools-sidebar-hidden");
    } else {
      document.body.classList.remove("soft-tools-sidebar-hidden");
    }
    updateSidebarToggleButton(document.getElementById("soft-tools-sidebar-toggle"), !!hidden);
    if (shouldResize) triggerWindowResize();
  }

  function isElementVisible(element) {
    return !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  }

  function getCookieValue(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== "") {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i += 1) {
        var cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === (name + "=")) {
          cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
          break;
        }
      }
    }
    return cookieValue;
  }


  var DELTA_EXPORT_OPTIONS_PREFIX = "soft_tools_delta_export_options_";

  function safeParseJson(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function parsePossibleExportBody(body) {
    var data = {};
    if (!body) return data;

    if (typeof body === "object") {
      try {
        if (typeof FormData !== "undefined" && body instanceof FormData) {
          body.forEach(function (value, key) { data[key] = value; });
          return data;
        }
      } catch (_) {}

      try {
        if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
          body.forEach(function (value, key) { data[key] = value; });
          return data;
        }
      } catch (_) {}

      try {
        if (!(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
          for (var key in body) {
            if (Object.prototype.hasOwnProperty.call(body, key)) {
              data[key] = body[key];
            }
          }
          return data;
        }
      } catch (_) {}
    }

    if (typeof body === "string") {
      var parsed = safeParseJson(body);
      if (parsed && typeof parsed === "object") return parsed;

      try {
        var params = new URLSearchParams(body);
        params.forEach(function (value, key) { data[key] = value; });
      } catch (_) {}
    }

    return data;
  }

  function getProjectTaskFromUrl(url) {
    var raw = String(url || "");
    var match = raw.match(/\/api\/projects\/([^/]+)\/tasks\/([^/?#]+)/);
    if (!match) {
      match = raw.match(/\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/download\/orthophoto\.tif/);
    }
    if (!match) return null;
    return {
      projectId: decodeURIComponent(match[1]),
      taskId: decodeURIComponent(match[2])
    };
  }

  function normalizeCapturedExportOptions(options) {
    if (!options || typeof options !== "object") return null;

    if (typeof options.export_options === "string") {
      var parsedExportOptions = safeParseJson(options.export_options);
      if (parsedExportOptions && typeof parsedExportOptions === "object") {
        options.export_options = parsedExportOptions;
      }
    }

    var nested = options.export_options && typeof options.export_options === "object"
      ? options.export_options
      : options;

    var crop = nested.crop || options.crop || "";
    if (!crop) {
      for (var prop in options) {
        if (!Object.prototype.hasOwnProperty.call(options, prop)) continue;
        var value = options[prop];
        if (typeof value === "string" && value.toUpperCase().indexOf("POLYGON") === 0) {
          crop = value;
          break;
        }
      }
    }

    var assetType = nested.asset_type || options.asset_type || "";
    var format = nested.format || options.format || "";

    var looksLikeOrthophoto =
      String(assetType || "").toLowerCase() === "orthophoto" ||
      String(format || "").toLowerCase() === "gtiff" ||
      String(crop || "").toUpperCase().indexOf("POLYGON") === 0;

    if (!looksLikeOrthophoto) return null;

    var result = {};
    var keys = ["epsg", "proj", "expression", "format", "rescale", "color_map", "hillshade", "asset_type", "name", "crop"];
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (nested[key] !== undefined && nested[key] !== null && nested[key] !== "") {
        result[key] = nested[key];
      } else if (options[key] !== undefined && options[key] !== null && options[key] !== "") {
        result[key] = options[key];
      }
    }

    if (crop && !result.crop) result.crop = crop;
    if (!result.asset_type) result.asset_type = "orthophoto";
    if (!result.format) result.format = "gtiff";

    return result;
  }

  function storeDeltaExportOptions(context, options) {
    if (!context || !context.projectId || !context.taskId || !options) return;
    try {
      var key = DELTA_EXPORT_OPTIONS_PREFIX + context.projectId + "_" + context.taskId;
      window.localStorage.setItem(key, JSON.stringify(options));
    } catch (_) {}
  }

  function loadDeltaExportOptions(context) {
    if (!context || !context.projectId || !context.taskId) return {};
    try {
      var key = DELTA_EXPORT_OPTIONS_PREFIX + context.projectId + "_" + context.taskId;
      var parsed = safeParseJson(window.localStorage.getItem(key) || "");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function captureStandardRasterExport(url, body) {
    var context = getProjectTaskFromUrl(url) || deltaExportContext;
    var parsed = parsePossibleExportBody(body);
    var normalized = normalizeCapturedExportOptions(parsed);
    if (context && normalized) storeDeltaExportOptions(context, normalized);
  }

  function installDeltaExportCaptureHooks() {
    if (window.__softToolsDeltaExportCaptureInstalled) return;
    window.__softToolsDeltaExportCaptureInstalled = true;

    if (window.fetch) {
      var originalFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : (input && input.url);
          var body = init && init.body;
          if (body) captureStandardRasterExport(url, body);
        } catch (_) {}
        return originalFetch.apply(this, arguments);
      };
    }

    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      var originalOpen = window.XMLHttpRequest.prototype.open;
      var originalSend = window.XMLHttpRequest.prototype.send;

      window.XMLHttpRequest.prototype.open = function (method, url) {
        this.__softToolsDeltaExportUrl = url;
        return originalOpen.apply(this, arguments);
      };

      window.XMLHttpRequest.prototype.send = function (body) {
        try {
          captureStandardRasterExport(this.__softToolsDeltaExportUrl, body);
        } catch (_) {}
        return originalSend.apply(this, arguments);
      };
    }

    if (window.jQuery && window.jQuery.ajax) {
      var originalAjax = window.jQuery.ajax;
      window.jQuery.ajax = function (urlOrOptions, maybeOptions) {
        try {
          var ajaxOptions = typeof urlOrOptions === "object" ? urlOrOptions : (maybeOptions || {});
          var ajaxUrl = typeof urlOrOptions === "string" ? urlOrOptions : ajaxOptions.url;
          if (ajaxOptions && ajaxOptions.data) {
            captureStandardRasterExport(ajaxUrl, ajaxOptions.data);
          }
        } catch (_) {}
        return originalAjax.apply(this, arguments);
      };
    }
  }

  installDeltaExportCaptureHooks();

  var deltaExportContext = null;
  var delta3dExportContext = null;

  function parseTaskDownloadHref(href) {
    var match = String(href || "").match(/\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/download\/([^?#]+)/);
    if (!match) return null;
    return {
      projectId: match[1],
      taskId: match[2],
      asset: decodeURIComponent(match[3] || "")
    };
  }

  function rememberOrthophotoExportContext(event) {
    var target = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!target) return;

    var href = target.getAttribute("href") || "";
    var download = parseTaskDownloadHref(href);
    if (!download || download.asset !== "orthophoto.tif") {
      if (download) {
        deltaExportContext = null;
      }
      return;
    }

    deltaExportContext = {
      projectId: download.projectId,
      taskId: download.taskId
    };
  }

  function findDeltaModalSaveButton(modal) {
    var footer = modal.querySelector(".modal-footer") || modal;
    var buttons = footer.querySelectorAll("button");
    for (var i = buttons.length - 1; i >= 0; i -= 1) {
      var button = buttons[i];
      if (button.id === "soft-tools-delta-export-button") continue;
      var text = String(button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (
        button.className.indexOf("btn-primary") !== -1 ||
        text.indexOf("завантажити") !== -1 ||
        text.indexOf("download") !== -1
      ) {
        return button;
      }
    }
    return null;
  }

  function runDeltaOrthophotoExport(button) {
    if (!deltaExportContext || !deltaExportContext.projectId || !deltaExportContext.taskId) {
      window.alert("Smartpoint: не вдалося визначити задачу для Delta експорту.");
      return;
    }

    var originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Delta...';

    var deltaOptions = loadDeltaExportOptions(deltaExportContext);

    // Last fallback: collect visible export modal fields.
    try {
      var modal = button.closest ? button.closest(".export-asset-dialog, .modal-dialog, .modal") : null;
      if (modal) {
        var fields = modal.querySelectorAll("input, select, textarea");
        for (var i = 0; i < fields.length; i += 1) {
          var field = fields[i];
          var key = field.getAttribute("name") || field.getAttribute("id");
          if (!key) continue;
          if ((field.type === "checkbox" || field.type === "radio") && !field.checked) continue;
          if (field.value !== undefined && field.value !== null && String(field.value) !== "") {
            deltaOptions[key] = field.value;
          }
        }
      }
    } catch (_) {}

    fetch(
      "/plugins/Smartpoint/api/projects/" +
        encodeURIComponent(deltaExportContext.projectId) +
        "/tasks/" +
        encodeURIComponent(deltaExportContext.taskId) +
        "/orthophoto/delta/",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "X-CSRFToken": getCookieValue("csrftoken") || "",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(deltaOptions || {})
      }
    ).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(text || "Delta export failed.");
        });
      }
      return response.json();
    }).then(function (json) {
      if (!json || !json.url) throw new Error("Delta export returned an invalid response.");
      var filename = json.filename ? "?filename=" + encodeURIComponent(json.filename) : "";
      window.location.href = json.url + filename;
    }).catch(function (error) {
      window.alert(error.message || String(error));
    }).finally(function () {
      button.disabled = false;
      button.innerHTML = originalHtml;
    });
  }

  function ensureDeltaExportButton() {
    if (!deltaExportContext) return;

    var modals = document.querySelectorAll(".export-asset-dialog, .modal-dialog");
    for (var i = 0; i < modals.length; i += 1) {
      var modal = modals[i];
      if (modal.querySelector("#soft-tools-delta-export-button")) continue;

      var title = String((modal.querySelector(".modal-title") || modal.querySelector("h4") || {}).textContent || "").toLowerCase();
      if (
        title.indexOf("ортофото") === -1 &&
        title.indexOf("orthophoto") === -1
      ) {
        continue;
      }

      var saveButton = findDeltaModalSaveButton(modal);
      if (!saveButton || !saveButton.parentNode) continue;

      var button = document.createElement("button");
      button.type = "button";
      button.id = "soft-tools-delta-export-button";
      button.className = "btn btn-primary soft-tools-delta-export-button";
      button.innerHTML = '<i class="fa fa-download"></i> Delta';
      button.title = "Delta COG GeoTIFF";
      button.addEventListener("click", function () {
        runDeltaOrthophotoExport(this);
      });
      saveButton.parentNode.insertBefore(button, saveButton.nextSibling);
    }
  }

  function closeDelta3dExportDialog() {
    var backdrop = document.getElementById("soft-tools-delta3d-backdrop");
    if (backdrop && backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
  }

  function runDelta3dExport(button) {
    if (!delta3dExportContext || !delta3dExportContext.projectId || !delta3dExportContext.taskId) {
      window.alert("Smartpoint: не вдалося визначити задачу для 3D Delta експорту.");
      return;
    }

    var originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 3D Модель Delta...';

    fetch(
      "/plugins/Smartpoint/api/projects/" +
        encodeURIComponent(delta3dExportContext.projectId) +
        "/tasks/" +
        encodeURIComponent(delta3dExportContext.taskId) +
        "/3d/delta/",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "X-CSRFToken": getCookieValue("csrftoken") || ""
        }
      }
    ).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(text || "3D Delta export failed.");
        });
      }
      return response.json();
    }).then(function (json) {
      if (!json || !json.url) throw new Error("3D Delta export returned an invalid response.");
      var filename = json.filename ? "?filename=" + encodeURIComponent(json.filename) : "";
      window.location.href = json.url + filename;
      closeDelta3dExportDialog();
    }).catch(function (error) {
      window.alert(error.message || String(error));
    }).finally(function () {
      button.disabled = false;
      button.innerHTML = originalHtml;
    });
  }

  function openDelta3dExportDialog(context) {
    delta3dExportContext = context || delta3dExportContext;
    closeDelta3dExportDialog();

    var backdrop = document.createElement("div");
    backdrop.id = "soft-tools-delta3d-backdrop";
    backdrop.className = "soft-tools-modal-backdrop";

    var modal = document.createElement("div");
    modal.className = "soft-tools-modal soft-tools-delta3d-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    var header = document.createElement("div");
    header.className = "soft-tools-modal-header";
    header.innerHTML = '<h4>3D Модель</h4>';

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "soft-tools-icon-button";
    closeButton.setAttribute("aria-label", "Закрити");
    closeButton.innerHTML = "&times;";
    closeButton.addEventListener("click", closeDelta3dExportDialog);
    header.appendChild(closeButton);

    var body = document.createElement("div");
    body.className = "soft-tools-modal-body soft-tools-delta3d-modal-body";

    var footer = document.createElement("div");
    footer.className = "soft-tools-modal-footer";

    var cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn btn-default";
    cancelButton.textContent = "Скасувати";
    cancelButton.addEventListener("click", closeDelta3dExportDialog);

    var deltaButton = document.createElement("button");
    deltaButton.type = "button";
    deltaButton.className = "btn btn-primary";
    deltaButton.innerHTML = '<i class="fa fa-cube"></i> 3D Модель Delta';
    deltaButton.addEventListener("click", function () {
      runDelta3dExport(this);
    });

    footer.appendChild(cancelButton);
    footer.appendChild(deltaButton);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", function (event) {
      if (event.target === backdrop) closeDelta3dExportDialog();
    });
    document.body.appendChild(backdrop);
  }

  function buildDelta3dMenuItem(context) {
    var li = document.createElement("li");
    li.className = "soft-tools-3d-model-menu-item";

    var link = document.createElement("a");
    link.href = "#";
    link.setAttribute("data-soft-tools-3d-model", "1");
    link.setAttribute("data-project-id", context.projectId);
    link.setAttribute("data-task-id", context.taskId);
    link.innerHTML = '<i class="fa fa-cube"></i> 3D Модель';
    li.appendChild(link);
    return li;
  }

  function ensureDelta3dDownloadMenuItem() {
    var anchors = document.querySelectorAll('a[href*="/api/projects/"][href*="/download/orthophoto.tif"]');
    for (var i = 0; i < anchors.length; i += 1) {
      var anchor = anchors[i];
      var context = parseTaskDownloadHref(anchor.getAttribute("href") || "");
      if (!context) continue;

      var row = anchor.closest ? (anchor.closest("li") || anchor) : anchor;
      if (!row || !row.parentNode) continue;
      if (row.nextElementSibling && row.nextElementSibling.className.indexOf("soft-tools-3d-model-menu-item") !== -1) {
        continue;
      }
      if (row.parentNode.querySelector('.soft-tools-3d-model-menu-item a[data-task-id="' + context.taskId + '"]')) {
        continue;
      }
      row.parentNode.insertBefore(buildDelta3dMenuItem(context), row.nextSibling);
    }
  }

  function handleDelta3dMenuClick(event) {
    var target = event.target && event.target.closest ? event.target.closest("a[data-soft-tools-3d-model]") : null;
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();

    var dropdown = target.closest ? target.closest(".dropdown.open, .btn-group.open") : null;
    if (dropdown) {
      dropdown.classList.remove("open");
      var toggle = dropdown.querySelector("[aria-expanded]");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    }

    openDelta3dExportDialog({
      projectId: target.getAttribute("data-project-id"),
      taskId: target.getAttribute("data-task-id")
    });
  }

  function initDeltaExportButton() {
    document.addEventListener("click", rememberOrthophotoExportContext, true);
    document.addEventListener("click", handleDelta3dMenuClick, true);
    var observer = new MutationObserver(function () {
      try {
        ensureDelta3dDownloadMenuItem();
        ensureDeltaExportButton();
      } catch (_) {}
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    ensureDelta3dDownloadMenuItem();
  }

  function findAddProjectButton() {
    var labels = [
      "add project",
      "\u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043f\u0440\u043e\u0435\u043a\u0442",
      "\u0434\u043e\u0434\u0430\u0442\u0438 \u043f\u0440\u043e\u0435\u043a\u0442"
    ];
    var root = document.querySelector("[data-dashboard]") || document.getElementById("dashboard-app") || document;
    var dashboardAddButton = root.querySelector(".add-button .btn-primary");
    if (isElementVisible(dashboardAddButton)) return dashboardAddButton;

    var candidates = root.querySelectorAll("button, a");

    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (candidate.id === "soft-tools-sidebar-toggle" || !isElementVisible(candidate)) continue;

      var text = String(candidate.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      for (var j = 0; j < labels.length; j += 1) {
        if (text.indexOf(labels[j]) !== -1) return candidate;
      }
    }

    return null;
  }

  function ensureSidebarToggleButton() {
    if (!document.body) return false;

    var existing = document.getElementById("soft-tools-sidebar-toggle");
    if (existing) {
      updateSidebarToggleButton(existing, document.body.classList.contains("soft-tools-sidebar-hidden"));
      return true;
    }

    var addProjectButton = findAddProjectButton();
    if (!addProjectButton || !addProjectButton.parentNode) return false;

    var button = document.createElement("button");
    button.type = "button";
    button.id = "soft-tools-sidebar-toggle";
    button.className = "btn btn-primary btn-sm soft-tools-layout-toggle";
    updateSidebarToggleButton(button, loadSidebarHidden());
    button.addEventListener("click", function () {
      var hidden = !document.body.classList.contains("soft-tools-sidebar-hidden");
      storeSidebarHidden(hidden);
      applySidebarHidden(hidden, true);
    });

    addProjectButton.parentNode.insertBefore(button, addProjectButton);
    return true;
  }

  function initSidebarToggle() {
    applySidebarHidden(loadSidebarHidden(), false);

    var attempts = 0;
    var maxAttempts = 80;

    function mount() {
      try {
        attempts += 1;
        if (ensureSidebarToggleButton() || attempts >= maxAttempts) return;
        window.setTimeout(mount, 250);
      } catch (_) {}
    }

    mount();
  }

  function safeInitSidebarToggle() {
    try {
      initSidebarToggle();
    } catch (_) {}
  }

  function getTaskViewerContext() {
    var match = String(window.location.pathname || "").match(/\/(map|3d)\/project\/([^/]+)\/task\/([^/]+)\/?$/);
    if (!match) return null;

    return {
      type: match[1],
      projectId: match[2],
      taskId: match[3]
    };
  }

  function buildDashboardTaskUrl(projectId) {
    return "/dashboard/?project_task_open=" + encodeURIComponent(projectId);
  }

  function ensureTaskViewerBackButton() {
    var context = getTaskViewerContext();
    if (!context) return false;

    var title = document.querySelector(context.type === "map" ? ".map-title" : ".model-title");
    if (!title || title.querySelector(".soft-tools-viewer-back")) return !!title;

    var link = document.createElement("a");
    link.className = "btn btn-default btn-sm soft-tools-viewer-back";
    link.href = buildDashboardTaskUrl(context.projectId);
    link.title = "Назад до задач";
    link.innerHTML = '<i class="fa fa-arrow-left" aria-hidden="true"></i> Назад';

    title.insertBefore(link, title.firstChild);
    return true;
  }

  function initTaskViewerBackButton() {
    var attempts = 0;
    var maxAttempts = 80;

    function mount() {
      attempts += 1;
      try {
        if (ensureTaskViewerBackButton() || attempts >= maxAttempts) return;
      } catch (_) {
        if (attempts >= maxAttempts) return;
      }
      window.setTimeout(mount, 250);
    }

    mount();

    if (!getTaskViewerContext()) return;
    var observer = new MutationObserver(function () {
      try {
        ensureTaskViewerBackButton();
      } catch (_) {}
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if ($) {
    $(safeInitSidebarToggle);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInitSidebarToggle);
  } else {
    safeInitSidebarToggle();
  }

  initTaskViewerBackButton();

  initDeltaExportButton();

  if (!React || !PluginsAPI || !PluginsAPI.Dashboard || !$) return;

  var IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng", ".nef"];
  var VIDEO_EXTENSIONS = [".mp4", ".mov", ".lrv", ".ts", ".avi", ".mkv"];
  var OVERLAP_OPTIONS = [100, 95, 90, 85, 83, 80, 75, 72, 70, 65, 60, 50];
  var DEFAULT_CAPTURE_HEIGHT_METERS = 120;
  var STORE_KEY = "soft_tools_new_task_options";

  function extensionOf(name) {
    var value = String(name || "").toLowerCase();
    var dot = value.lastIndexOf(".");
    return dot >= 0 ? value.substring(dot) : "";
  }

  function isImageFile(file) {
    var type = String(file && file.type || "").toLowerCase();
    return type.indexOf("image/") === 0 || IMAGE_EXTENSIONS.indexOf(extensionOf(file && file.name)) !== -1;
  }

  function isVideoFile(file) {
    var type = String(file && file.type || "").toLowerCase();
    return type.indexOf("video/") === 0 || VIDEO_EXTENSIONS.indexOf(extensionOf(file && file.name)) !== -1;
  }

  function normalizeOverlapPercent(value) {
    var number = parseInt(String(value == null ? "" : value).trim(), 10);
    if (!Number.isFinite(number)) return 80;
    return Math.max(1, Math.min(100, number));
  }

  function normalizeCaptureHeightMeters(value) {
    var number = parseFloat(String(value == null ? "" : value).trim().replace(",", "."));
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_CAPTURE_HEIGHT_METERS;
    return Math.max(1, Math.min(5000, Math.round(number)));
  }

  function getPhotoBaseStep(overlapPercent) {
    if (overlapPercent >= 90) return 1;
    if (overlapPercent >= 80) return 2;
    if (overlapPercent >= 70) return 3;
    if (overlapPercent >= 60) return 4;
    return 5;
  }

  function getVideoBaseIntervalSeconds(overlapPercent) {
    if (overlapPercent >= 100) return 0.25;
    if (overlapPercent >= 95) return 0.35;
    if (overlapPercent >= 90) return 0.5;
    if (overlapPercent >= 85) return 0.7;
    if (overlapPercent >= 83) return 0.8;
    if (overlapPercent >= 80) return 1.0;
    if (overlapPercent >= 75) return 1.25;
    if (overlapPercent >= 72) return 1.4;
    if (overlapPercent >= 70) return 1.5;
    if (overlapPercent >= 65) return 1.8;
    if (overlapPercent >= 60) return 2.0;
    return 2.5;
  }

  function getCaptureHeightFactor(captureHeightMeters) {
    return Math.max(0.65, Math.min(2.2, Math.sqrt(normalizeCaptureHeightMeters(captureHeightMeters) / 120)));
  }

  function selectedCountByStep(count, step) {
    if (count <= 0) return 0;
    if (step <= 1) return count;
    var selected = 0;
    for (var i = 0; i < count; i += 1) {
      if (i === 0 || i % step === 0) selected += 1;
    }
    if ((count - 1) % step !== 0) selected += 1;
    return selected;
  }

  function estimateVideoLimit(durationSeconds, overlapPercent, captureHeightMeters) {
    if (overlapPercent >= 100) return 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

    var interval = Math.max(
      0.2,
      Math.min(6, getVideoBaseIntervalSeconds(overlapPercent) * getCaptureHeightFactor(captureHeightMeters))
    );
    return Math.max(12, Math.min(4000, Math.round(durationSeconds / interval)));
  }

  function loadStoredOptions() {
    try {
      var stored = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
      return {
        overlapPercent: normalizeOverlapPercent(stored.overlapPercent),
        captureHeightMeters: normalizeCaptureHeightMeters(stored.captureHeightMeters)
      };
    } catch (_) {
      return {
        overlapPercent: 80,
        captureHeightMeters: DEFAULT_CAPTURE_HEIGHT_METERS
      };
    }
  }

  function storeOptions(options) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(options));
    } catch (_) {}
  }

  function upsertOption(options, name, value) {
    var list = Array.isArray(options) ? options : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].name === name) {
        list[i].value = value;
        return list;
      }
    }
    list.push({ name: name, value: value });
    return list;
  }

  function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== "") {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i += 1) {
        var cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === (name + "=")) {
          cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
          break;
        }
      }
    }
    return cookieValue;
  }

  function compactTaskInfo(taskInfo) {
    var selectedNode = taskInfo && taskInfo.selectedNode ? taskInfo.selectedNode : {};
    return {
      name: taskInfo && taskInfo.name ? taskInfo.name : "",
      options: taskInfo && Array.isArray(taskInfo.options) ? taskInfo.options : [],
      selectedNode: {
        id: selectedNode.id,
        key: selectedNode.key
      },
      resizeMode: taskInfo && taskInfo.resizeMode,
      resizeSize: taskInfo && taskInfo.resizeSize,
      alignTo: taskInfo && taskInfo.alignTo
    };
  }

  function prepareFiles(files, options) {
    var formData = new FormData();
    Array.prototype.forEach.call(files || [], function (file) {
      formData.append("files", file, file.name);
    });
    formData.append("overlap_percent", normalizeOverlapPercent(options.overlapPercent));
    formData.append("capture_height_meters", normalizeCaptureHeightMeters(options.captureHeightMeters));
    if (options.projectId) formData.append("project_id", options.projectId);
    if (options.taskInfo) formData.append("task_info", JSON.stringify(compactTaskInfo(options.taskInfo)));

    return fetch("/plugins/Smartpoint/prepare/", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: {
        "X-CSRFToken": getCookie("csrftoken") || ""
      }
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(text || "Не вдалося підготувати файли.");
        });
      }
      return response.json();
    });
  }

  function patchTaskCreationAjax() {
    if ($.__softToolsAjaxPatched) return;
    $.__softToolsAjaxPatched = true;

    var originalAjax = $.ajax;
    $.ajax = function (urlOrOptions, maybeOptions) {
      var options = typeof urlOrOptions === "object"
        ? urlOrOptions
        : Object.assign({}, maybeOptions || {}, { url: urlOrOptions });

      try {
        var method = String(options.type || options.method || "GET").toUpperCase();
        var url = String(options.url || "");
        var state = window.__softToolsNewTaskOptions;

        if (
          state &&
          method === "POST" &&
          /\/api\/projects\/[^/]+\/tasks\/?$/.test(url) &&
          typeof options.data === "string"
        ) {
          var payload = JSON.parse(options.data);
          if (payload && payload.partial === true) {
            if (state.videoCount > 0 && state.videoLimit != null) {
              payload.options = upsertOption(payload.options, "video-limit", state.videoLimit);
            }

            options = Object.assign({}, options, {
              data: JSON.stringify(payload)
            });

            if (typeof urlOrOptions === "object") {
              urlOrOptions = options;
            } else {
              maybeOptions = options;
            }
          }
        }
      } catch (_) {}

      return typeof urlOrOptions === "object"
        ? originalAjax.call(this, urlOrOptions)
        : originalAjax.call(this, urlOrOptions, maybeOptions);
    };
  }

  patchTaskCreationAjax();

  function projectIdFromElement(element) {
    var project = element && element.closest ? element.closest(".project-list-item") : null;
    var marker = project ? project.querySelector(".soft-tools-project-marker[data-project-id]") : null;
    var id = marker ? marker.getAttribute("data-project-id") : window.__softToolsLastProjectId;
    var parsed = parseInt(String(id || ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  class SoftToolsProjectMarker extends React.Component {
    componentDidMount() {
      window.__softToolsLastProjectId = this.props.projectId;
    }

    render() {
      return React.createElement("span", {
        className: "soft-tools-project-marker",
        "data-project-id": this.props.projectId,
        style: { display: "none" }
      });
    }
  }

  class SoftToolsFooterButton extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        busy: false,
        error: ""
      };
    }

    componentDidMount() {
      this.mountFooterButton();
    }

    componentDidUpdate() {
      this.mountFooterButton();
      this.updateFooterButton();
    }

    componentWillUnmount() {
      if (this.footerButton && this.footerButton.parentNode) {
        this.footerButton.parentNode.removeChild(this.footerButton);
      }
      this.footerButton = null;
    }

    setPlaceholder = (element) => {
      this.placeholder = element;
    };

    getProjectId() {
      return projectIdFromElement(this.placeholder);
    }

    prepareCurrentSelection = () => {
      var context = window.__softToolsNewTaskContext || {};
      var files = Array.isArray(context.files) ? context.files : [];
      var options = context.options || {};
      var projectId = this.getProjectId();

      if (!files.length) {
        window.alert("Спочатку виберіть фото або відео стандартною кнопкою WebODM, налаштуйте перекриття, потім натисніть Smartpoint.");
        return;
      }
      if (!projectId) {
        window.alert("Smartpoint: project id is missing.");
        return;
      }
      this.setState({ busy: true, error: "" });
      prepareFiles(files, {
        projectId: projectId,
        overlapPercent: normalizeOverlapPercent(options.overlapPercent),
        captureHeightMeters: normalizeCaptureHeightMeters(options.captureHeightMeters),
        taskInfo: this.props.taskInfo || context.taskInfo || null
      }).then((json) => {
        storeOptions({
          overlapPercent: normalizeOverlapPercent(options.overlapPercent),
          captureHeightMeters: normalizeCaptureHeightMeters(options.captureHeightMeters)
        });
        window.location.href = json.markup_url;
      }).catch((error) => {
        this.setState({ busy: false, error: error.message || String(error) });
        window.alert(error.message || String(error));
      });
    };

    mountFooterButton() {
      if (this.footerButton && !document.body.contains(this.footerButton)) {
        this.footerButton = null;
      }
      if (!this.placeholder || this.footerButton) return;
      var panel = this.placeholder.closest ? this.placeholder.closest(".new-task-panel") : null;
      if (!panel) return;

      var confirmButton = null;
      var primaryButtons = panel.querySelectorAll(".form-group .text-right .btn-primary");
      for (var i = 0; i < primaryButtons.length; i += 1) {
        if (primaryButtons[i].closest(".new-task-panel") === panel) {
          confirmButton = primaryButtons[i];
          break;
        }
      }
      if (!confirmButton || !confirmButton.parentNode) return;

      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-warning soft-tools-footer-button";
      button.title = "Прив'язка до місцевості";
      button.addEventListener("click", this.prepareCurrentSelection);
      confirmButton.parentNode.insertBefore(button, confirmButton);
      this.footerButton = button;
      this.updateFooterButton();
    }

    updateFooterButton() {
      if (!this.footerButton) return;
      this.footerButton.disabled = this.state.busy || this.props.filesCount < 1;
      this.footerButton.innerHTML = '<i class="fa fa-magic"></i> ' + (this.state.busy ? "\u041f\u0456\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430..." : "Прив'язка до місцевості");
    }

    render() {
      return React.createElement("span", { ref: this.setPlaceholder, className: "soft-tools-footer-placeholder" });
    }
  }

  class SoftToolsNewTaskPanelItem extends React.Component {
    constructor(props) {
      super(props);
      var stored = loadStoredOptions();
      this.state = {
        overlapPercent: stored.overlapPercent,
        captureHeightMeters: stored.captureHeightMeters,
        videoDurations: {}
      };
    }

    componentDidMount() {
      this.probeVideoDurations();
      this.publishState();
    }

    componentDidUpdate(prevProps, prevState) {
      if (prevProps.filesCount !== this.props.filesCount) {
        this.probeVideoDurations();
      }
      if (
        prevState.overlapPercent !== this.state.overlapPercent ||
        prevState.captureHeightMeters !== this.state.captureHeightMeters ||
        prevState.videoDurations !== this.state.videoDurations ||
        prevProps.filesCount !== this.props.filesCount
      ) {
        this.publishState();
      }
    }

    getFiles() {
      if (!this.props.getFiles) return [];
      var files = this.props.getFiles();
      return Array.isArray(files) ? files : Array.prototype.slice.call(files || []);
    }

    getSummary() {
      var files = this.getFiles();
      var images = files.filter(isImageFile);
      var videos = files.filter(isVideoFile);
      var totalVideoDuration = videos.reduce((sum, file) => {
        var key = this.videoKey(file);
        var duration = this.state.videoDurations[key];
        return sum + (Number.isFinite(duration) ? duration : 0);
      }, 0);
      return { files: files, images: images, videos: videos, totalVideoDuration: totalVideoDuration };
    }

    videoKey(file) {
      return [file && file.name || "", file && file.size || 0, file && file.lastModified || 0].join(":");
    }

    probeVideoDurations() {
      var summary = this.getSummary();
      summary.videos.forEach((file) => {
        var key = this.videoKey(file);
        if (this.state.videoDurations[key] != null || !window.URL || !window.URL.createObjectURL) return;

        var video = document.createElement("video");
        var objectUrl = window.URL.createObjectURL(file);
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          var duration = Number(video.duration);
          window.URL.revokeObjectURL(objectUrl);
          this.setState((state) => ({
            videoDurations: Object.assign({}, state.videoDurations, {
              [key]: Number.isFinite(duration) ? duration : 0
            })
          }));
        };
        video.onerror = () => {
          window.URL.revokeObjectURL(objectUrl);
          this.setState((state) => ({
            videoDurations: Object.assign({}, state.videoDurations, { [key]: 0 })
          }));
        };
        video.src = objectUrl;
      });
    }

    buildLaunchState() {
      var summary = this.getSummary();
      var overlapPercent = normalizeOverlapPercent(this.state.overlapPercent);
      var captureHeightMeters = normalizeCaptureHeightMeters(this.state.captureHeightMeters);
      var photoStep = Math.max(1, Math.round(getPhotoBaseStep(overlapPercent) * getCaptureHeightFactor(captureHeightMeters)));
      var selectedImageCount = selectedCountByStep(summary.images.length, photoStep);
      var videoLimit = estimateVideoLimit(summary.totalVideoDuration, overlapPercent, captureHeightMeters);

      return {
        overlapPercent: overlapPercent,
        captureHeightMeters: captureHeightMeters,
        imageCount: summary.images.length,
        selectedImageCount: selectedImageCount,
        filteredImageCount: Math.max(0, summary.images.length - selectedImageCount),
        photoStep: photoStep,
        videoCount: summary.videos.length,
        totalVideoDuration: summary.totalVideoDuration,
        videoLimit: videoLimit
      };
    }

    publishState() {
      var launchState = this.buildLaunchState();
      window.__softToolsNewTaskOptions = launchState;
      window.__softToolsNewTaskContext = {
        files: this.getFiles(),
        taskInfo: this.props.taskInfo || null,
        options: launchState
      };
      storeOptions({
        overlapPercent: launchState.overlapPercent,
        captureHeightMeters: launchState.captureHeightMeters
      });
    }

    setOverlap = (event) => {
      this.setState({ overlapPercent: normalizeOverlapPercent(event.target.value) });
    };

    setCaptureHeight = (event) => {
      this.setState({ captureHeightMeters: normalizeCaptureHeightMeters(event.target.value) });
    };

    render() {
      var launchState = this.buildLaunchState();
      if (!launchState.imageCount && !launchState.videoCount) return null;

      var videoText = launchState.videoCount > 0
        ? (launchState.videoLimit == null
          ? "Відео: буде використано стандартне витягання кадрів ODM, бо тривалість ще не визначена."
          : "Відео: у стандартну задачу буде додано ODM параметр video-limit = " + launchState.videoLimit + ".")
        : "Відео не вибрано.";

      var photoText = launchState.imageCount > 0
        ? "Фото: розрахунок дає " + launchState.selectedImageCount + " з " + launchState.imageCount + " зображень, крок " + launchState.photoStep + "."
        : "Фото не вибрано.";

      return React.createElement("div", { className: "soft-tools-new-task" },
        React.createElement("div", { className: "form-group soft-tools-form-row" },
          React.createElement("label", { className: "col-sm-2 control-label" }, "Перекриття / щільність"),
          React.createElement("div", { className: "col-sm-10" },
            React.createElement("select", {
              className: "form-control",
              value: launchState.overlapPercent,
              onChange: this.setOverlap
            }, OVERLAP_OPTIONS.map((value) =>
              React.createElement("option", { key: value, value: value }, value + "%")
            ))
          ),
        ),
        React.createElement("div", { className: "form-group soft-tools-form-row" },
          React.createElement("label", { className: "col-sm-2 control-label" }, "Висота зйомки, м"),
          React.createElement("div", { className: "col-sm-10" },
            React.createElement("input", {
              className: "form-control",
              min: "1",
              max: "5000",
              step: "1",
              type: "number",
              value: launchState.captureHeightMeters,
              onChange: this.setCaptureHeight
            })
          )
        ),
        React.createElement("div", { className: "form-group soft-tools-summary-row" },
          React.createElement("div", { className: "col-sm-offset-2 col-sm-10" },
            React.createElement("div", { className: "soft-tools-summary" },
              React.createElement("div", null, React.createElement("strong", null, photoText)),
              React.createElement("div", null, React.createElement("strong", null, videoText))
            )
          )
        ),
        React.createElement(SoftToolsFooterButton, {
          filesCount: this.props.filesCount,
          taskInfo: this.state.taskInfo
        })
      );
    }
  }

  PluginsAPI.Dashboard.addNewTaskButton(function (args) {
    return React.createElement(SoftToolsProjectMarker, {
      projectId: args.projectId
    });
  });

  PluginsAPI.Dashboard.addNewTaskPanelItem(function () {
    return SoftToolsNewTaskPanelItem;
  });


  function softToolsMosaicRemoveDuplicateButtons() {
    var buttons = document.querySelectorAll('.soft-tools-mosaic-button, #soft-tools-mosaic-button');
    for (var i = 1; i < buttons.length; i += 1) {
      if (buttons[i] && buttons[i].parentNode) buttons[i].parentNode.removeChild(buttons[i]);
    }
  }

  function softToolsMosaicOpen() {
    window.location.href = '/plugins/Smartpoint/mosaic/';
  }

  function softToolsMosaicInstallButton() {
    var existing = document.getElementById('soft-tools-mosaic-button');
    var importButtons = Array.prototype.slice.call(document.querySelectorAll('button, a')).filter(function (el) {
      return /Імпортувати|Import/i.test(String(el.textContent || ''));
    });
    if (!importButtons.length) return;
    var importButton = importButtons[0];
    if (!existing) {
      existing = document.createElement(importButton.tagName === 'A' ? 'a' : 'button');
      existing.id = 'soft-tools-mosaic-button';
      existing.type = 'button';
      existing.href = 'javascript:void(0)';
      existing.className = importButton.className + ' soft-tools-mosaic-button';
      existing.innerHTML = '<i class="fa fa-object-group"></i> Об’єднати ортофото';
      existing.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        softToolsMosaicOpen();
      });
      importButton.parentNode.insertBefore(existing, importButton.nextSibling);
    }
    softToolsMosaicRemoveDuplicateButtons();
  }

  function softToolsMosaicStartObserver() {
    softToolsMosaicInstallButton();
    if (window.__softToolsMosaicObserver) return;
    window.__softToolsMosaicObserver = new MutationObserver(function () {
      softToolsMosaicInstallButton();
    });
    window.__softToolsMosaicObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', softToolsMosaicStartObserver);
  } else {
    softToolsMosaicStartObserver();
  }

})();




/* Smartpoint Mosaic page redirect override */
(function () {
  function patchMosaicButtons() {
    var buttons = document.querySelectorAll('#soft-tools-mosaic-button, .soft-tools-mosaic-button, #smartpoint-mosaic-button, .smartpoint-mosaic-button, [data-smartpoint-mosaic-button]');
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.getAttribute('data-smartpoint-page-patched') === '1') return;
      button.setAttribute('data-smartpoint-page-patched', '1');
      button.onclick = function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.location.href = '/plugins/Smartpoint/mosaic/';
        return false;
      };
    });
  }
  patchMosaicButtons();
  if (window.MutationObserver) {
    new MutationObserver(patchMosaicButtons).observe(document.documentElement, { childList: true, subtree: true });
  }
  window.setInterval(patchMosaicButtons, 1200);
})();
