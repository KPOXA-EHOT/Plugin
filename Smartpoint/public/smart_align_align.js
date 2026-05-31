(function () {
  var root = document.getElementById("smartalign-root");
  if (!root) return;

  var map = null;
  var baseLayer = null;
  var alignedOverlay = null;
  var orthophotoLayer = null;
  var mapMarkers = [];
  var leafletLoading = false;
  var suppressNextOrthoClick = false;
  var threeLoading = false;
  var threeScene = null;
  var threeCamera = null;
  var threeRenderer = null;
  var threeControls = null;
  var threeTransformControls = null;
  var threeModel = null;
  var threeGround = null;
  var threeRaycaster = null;
  var threePointer = null;
  var threeAnimation = null;
  var suppressNext3dPick = false;
  var BASE_MAP_NAMES = [
    "Esri Satellite", "Esri Streets", "Esri Topo", "Esri Terrain", "Esri NatGeo",
    "Esri Light Gray", "Esri Dark Gray", "OpenStreetMap", "OpenStreetMap HOT",
    "OpenStreetMap DE", "Topo", "Light", "Dark", "Voyager"
  ];

  var state = {
    projectId: root.getAttribute("data-project-id"),
    taskId: root.getAttribute("data-task-id"),
    info: null,
    mode: "ortho",
    activePoint: 0,
    points: [],
    points3d: [],
    applying: false,
    aligning3d: false,
    exportingDelta3d: false,
    replacing3d: false,
    restoring3d: false,
    activeBaseMap: "Esri Satellite",
    activeOrthophoto: null,
    orthophotos: [],
    orthophotosLoading: false,
    previewOpacity: 62,
    orthoView: { scale: 1, panX: 0, panY: 0 },
    mapView: { lat: 48.7, lng: 31.2, zoom: 6 },
    mapInitialFitDone: false,
    previewVisible: true,
    assetWriteDirty: false,
    placement3d: { offset_x: 0, offset_y: 0, offset_z: 0, yaw_deg: 0, scale: 1 },
    transformMode3d: "translate",
    threeLoaded: false,
    threeError: ""
  };

  function api(path) {
    return "/plugins/Smartpoint/api/project/" + encodeURIComponent(state.projectId) + "/task/" + encodeURIComponent(state.taskId) + "/" + path;
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

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function responseError(response, fallback) {
    return response.text().then(function (text) {
      if (/^\s*</.test(text || "")) {
        throw new Error("WebODM повернув HTML замість JSON. Перезапустіть WebODM після оновлення плагіна, потім натисніть Ctrl+F5 і повторіть дію.");
      }
      throw new Error(text || fallback);
    });
  }

  function requestJson(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (response) {
      if (!response.ok) return responseError(response, "Не вдалося завантажити дані.");
      return response.json();
    });
  }

  function loadScriptOnce(url) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + url + '"]');
      if (existing) {
        if (existing.getAttribute("data-loaded") === "1") resolve();
        else existing.addEventListener("load", resolve, { once: true });
        return;
      }
      var script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = function () {
        script.setAttribute("data-loaded", "1");
        resolve();
      };
      script.onerror = function () {
        reject(new Error("Не вдалося завантажити 3D viewer library"));
      };
      document.head.appendChild(script);
    });
  }

  function ensureThree() {
    if (window.THREE && window.THREE.OBJLoader && window.THREE.MTLLoader && window.THREE.OrbitControls && window.THREE.TransformControls) {
      return Promise.resolve();
    }
    if (threeLoading) {
      return new Promise(function (resolve, reject) {
        var started = Date.now();
        function wait() {
          if (window.THREE && window.THREE.OBJLoader && window.THREE.MTLLoader && window.THREE.OrbitControls && window.THREE.TransformControls) resolve();
          else if (Date.now() - started > 15000) reject(new Error("3D viewer не завантажився"));
          else window.setTimeout(wait, 100);
        }
        wait();
      });
    }
    threeLoading = true;
    return loadScriptOnce("https://unpkg.com/three@0.128.0/build/three.min.js")
      .then(function () { return loadScriptOnce("https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js"); })
      .then(function () { return loadScriptOnce("https://unpkg.com/three@0.128.0/examples/js/controls/TransformControls.js"); })
      .then(function () { return loadScriptOnce("https://unpkg.com/three@0.128.0/examples/js/loaders/MTLLoader.js"); })
      .then(function () { return loadScriptOnce("https://unpkg.com/three@0.128.0/examples/js/loaders/OBJLoader.js"); })
      .then(function () {
        state.threeLoaded = true;
        threeLoading = false;
      })
      .catch(function (error) {
        threeLoading = false;
        state.threeError = error.message || String(error);
        throw error;
      });
  }

  function emptyPoint() {
    return { ortho: null, reference: null };
  }

  function empty3dPoint() {
    return {
      id: "P" + (state.points3d.length + 1),
      mesh: null,
      world: null,
      height: 0,
      enabled: true
    };
  }

  function ensurePoint(index) {
    while (state.points.length <= index) state.points.push(emptyPoint());
    return state.points[index];
  }

  function ensure3dPoint(index) {
    while (state.points3d.length <= index) state.points3d.push(empty3dPoint());
    if (!state.points3d[index].id) state.points3d[index].id = "P" + (index + 1);
    return state.points3d[index];
  }

  function validPairs() {
    return state.points.filter(function (point) {
      return point && point.ortho && point.reference;
    });
  }

  function valid3dPairs() {
    return state.points3d.filter(function (point) {
      return point && point.enabled !== false && point.mesh && point.world &&
        point.world.lat != null && point.world.lng != null;
    }).map(function (point, index) {
      return {
        id: point.id || "P" + (index + 1),
        mesh: point.mesh,
        world: {
          lat: Number(point.world.lat),
          lon: Number(point.world.lng),
          height: Number(point.height || point.world.height || 0)
        },
        enabled: point.enabled !== false
      };
    });
  }

  function seed3dPointsFromOrtho() {
    if (state.info && state.info.alignment_3d && Array.isArray(state.info.alignment_3d.points)) {
      state.points3d = state.info.alignment_3d.points.map(function (point, index) {
        return {
          id: point.id || "P" + (index + 1),
          mesh: point.mesh || null,
          world: point.world ? { lat: point.world.lat, lng: point.world.lon || point.world.lng, height: point.world.height } : null,
          height: point.world ? Number(point.world.height || 0) : Number(point.height || 0),
          enabled: point.enabled !== false
        };
      });
      return;
    }
    state.points3d = state.points.map(function (point, index) {
      return {
        id: "P" + (index + 1),
        mesh: null,
        world: point && point.reference ? {
          lat: point.reference.lat,
          lng: point.reference.lng,
          height: 0
        } : null,
        height: 0,
        enabled: true
      };
    });
    if (!state.points3d.length) state.points3d.push(empty3dPoint());
  }

  function pointsChanged() {
    if (state.info) state.info.alignment = null;
    state.assetWriteDirty = true;
  }

  function imageOriginalPoint(event) {
    var img = event.currentTarget.querySelector("img");
    if (!img) return null;
    var rect = img.getBoundingClientRect();
    var meta = state.info.orthophoto;
    if (!meta || rect.width <= 0 || rect.height <= 0) return null;

    var x = (event.clientX - rect.left) / rect.width * meta.width;
    var y = (event.clientY - rect.top) / rect.height * meta.height;
    if (x < 0 || y < 0 || x > meta.width || y > meta.height) return null;
    return {
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000
    };
  }

  function markerStyle(point) {
    var position = markerPosition(point);
    if (!position) return "";
    return "left:" + position.left + "px;top:" + (position.top - 24) + "px;";
  }

  function markerPosition(point) {
    var meta = state.info.orthophoto;
    if (!point || !meta || !meta.width || !meta.height) return null;
    var previewWidth = Number(meta.preview_width || meta.width);
    var previewHeight = Number(meta.preview_height || meta.height);
    var scale = state.orthoView.scale || 1;
    return {
      left: point.x / meta.width * previewWidth * scale,
      top: point.y / meta.height * previewHeight * scale
    };
  }

  function pointQualityClass(index) {
    var residuals = state.info && state.info.alignment && state.info.alignment.residuals || [];
    var residual = typeof residuals[index] === "number" ? residuals[index] : null;
    if (residual == null) return "";
    if (residual < 1.5) return " good";
    if (residual < 5) return " ok";
    return " bad";
  }

  function renderPointCounter() {
    return '<div class="smartalign-point-strip">' + state.points.map(function (point, index) {
      var active = index === state.activePoint ? " active" : "";
      var complete = point && point.ortho && point.reference ? " complete" : "";
      return '<button type="button" class="smartalign-point-chip' + active + complete + pointQualityClass(index) + '" data-use-point="' + index + '" title="Точка ' + (index + 1) + '">' + (index + 1) + '</button>';
    }).join("") + '</div>';
  }

  function renderOrthoMarkers() {
    return state.points.map(function (point, index) {
      if (!point.ortho) return "";
      var position = markerPosition(point.ortho);
      var deleteButton = "";
      if (index === state.activePoint && position) {
        deleteButton = '<button type="button" class="smartalign-marker-delete" data-delete-point="' + index + '" style="left:' + position.left + 'px;top:' + (position.top - 30) + 'px">Видалити</button>';
      }
      return '<button class="smartalign-marker ' + (index === state.activePoint ? "active" : "") + '" data-point="' + index + '" style="' + markerStyle(point.ortho) + '" title="Точка ' + (index + 1) + '"><span class="smartalign-pin-label">' + (index + 1) + '</span></button>' + deleteButton;
    }).join("");
  }

  function renderOrthoPanel() {
    var meta = state.info.orthophoto;
    var previewWidth = Number(meta.preview_width || meta.width || 1);
    var previewHeight = Number(meta.preview_height || meta.height || 1);
    var scale = state.orthoView.scale || 1;
    var imageWidth = Math.max(1, Math.round(previewWidth * scale));
    var imageHeight = Math.max(1, Math.round(previewHeight * scale));
    return '' +
      '<section class="smartalign-panel">' +
        '<div class="smartalign-panel-head">' +
          renderPointCounter() +
          '<button type="button" class="btn btn-default smartalign-icon-button" id="smartalign-add-point" title="Додати точку"><i class="fa fa-plus"></i></button>' +
        '</div>' +
        '<div class="smartalign-image-stage" data-ortho-stage="1">' +
          '<div class="smartalign-image-frame" style="width:' + imageWidth + 'px;height:' + imageHeight + 'px;">' +
            '<img src="' + state.info.orthophoto_preview_url + '" alt="Ортофото" draggable="false">' + renderOrthoMarkers() +
          '</div>' +
        '</div>' +
      '</section>';
  }

  function renderOrthophotoMenu(alignment) {
    var html = "";
    if (state.activeOrthophoto) {
      html += '<button type="button" class="smartalign-orthophoto-option smartalign-orthophoto-off" data-orthophoto-action="off">Вимкнути ортофото задачі</button>';
    }
    if (state.orthophotosLoading) {
      html += '<span class="smartalign-orthophoto-empty">Пошук...</span>';
    } else if (state.orthophotos.length) {
      html += state.orthophotos.map(function (item) {
        var active = state.activeOrthophoto && String(state.activeOrthophoto.id) === String(item.id) ? " active" : "";
        return '<button type="button" class="smartalign-orthophoto-option' + active + '" data-orthophoto-id="' + escapeHtml(item.id) + '">' + escapeHtml(formatOrthophotoLabel(item)) + '</button>';
      }).join("");
    } else {
      html += '<span class="smartalign-orthophoto-empty">Не знайдено</span>';
    }
    return html;
  }

  function renderPreviewOpacityControl(alignment) {
    if (!alignment || !alignment.aligned_preview) return "";
    return '' +
      '<div class="smartalign-preview-opacity-picker">' +
        '<button id="smartalign-preview-opacity-toggle" type="button" class="btn btn-default smartalign-icon-button" title="Прозорість Smartpoint preview"><i class="fa fa-adjust"></i></button>' +
        '<div class="smartalign-preview-opacity-menu">' +
          '<input id="smartalign-preview-opacity" type="range" min="0" max="100" value="' + escapeHtml(state.previewOpacity) + '">' +
          '<span id="smartalign-preview-opacity-value">' + escapeHtml(state.previewOpacity) + '%</span>' +
        '</div>' +
      '</div>';
  }

  function formatOrthophotoLabel(item) {
    if (!item) return "Ортофото";
    if (item.task_name) return item.task_name;
    if (item.created_at) {
      var date = new Date(item.created_at);
      if (!Number.isNaN(date.getTime())) {
        return "Task " + date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      }
    }
    return "Task";
  }

  function renderReferencePanel() {
    var layerOptions = BASE_MAP_NAMES.map(function (name) {
      return '<button type="button" class="smartalign-map-layer-option' + (state.activeBaseMap === name ? " active" : "") + '" data-layer-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
    }).join("");
    var alignment = state.info && state.info.alignment;
    var resultStatus = alignment
      ? '<div class="smartalign-map-status">' + userResultText(alignment) + '</div>'
      : '<div class="smartalign-map-status"></div>';

    return '' +
      '<section class="smartalign-panel">' +
        '<div class="smartalign-panel-head">' +
          resultStatus +
          '<div class="smartalign-map-actions">' +
            '<div class="smartalign-map-layer-picker">' +
              '<button id="smartalign-map-layer-toggle" type="button" class="btn btn-default smartalign-icon-button" title="Обрати карту"><i class="fa fa-map"></i></button>' +
              '<div class="smartalign-map-layer-menu">' + layerOptions + '</div>' +
            '</div>' +
            '<div class="smartalign-orthophoto-picker">' +
              '<button id="smartalign-orthophoto-toggle" type="button" class="btn btn-default smartalign-icon-button" title="Ортофото-шари"><i class="fa fa-image"></i></button>' +
              '<div class="smartalign-orthophoto-menu">' + renderOrthophotoMenu(alignment) + '</div>' +
            '</div>' +
            renderPreviewOpacityControl(alignment) +
          '</div>' +
        '</div>' +
        '<div id="smartalign-map" class="smartalign-map">' + (!window.L ? '<div class="smartalign-empty">Завантаження карти...</div>' : '') + '</div>' +
      '</section>';
  }

  function render3dPointCounter() {
    return '<div class="smartalign-point-strip">' + state.points3d.map(function (point, index) {
      var active = index === state.activePoint ? " active" : "";
      var complete = point && point.mesh && point.world ? " complete" : "";
      return '<button type="button" class="smartalign-point-chip' + active + complete + '" data-use-point="' + index + '" title="3D точка ' + (index + 1) + '">' + (index + 1) + '</button>';
    }).join("") + '</div>';
  }

  function formatNumber(value, digits) {
    var number = Number(value);
    if (!Number.isFinite(number)) return "";
    return number.toFixed(digits == null ? 3 : digits);
  }

  function normalize3dPlacement(placement) {
    placement = placement || {};
    function number(name, fallback, min, max) {
      var value = Number(placement[name]);
      if (!Number.isFinite(value)) value = fallback;
      if (min != null) value = Math.max(min, value);
      if (max != null) value = Math.min(max, value);
      return value;
    }
    return {
      offset_x: number("offset_x", 0, -10000, 10000),
      offset_y: number("offset_y", 0, -10000, 10000),
      offset_z: number("offset_z", 0, -10000, 10000),
      yaw_deg: number("yaw_deg", 0, -180, 180),
      scale: number("scale", 1, 0.01, 100)
    };
  }

  function set3dPlacement(patch) {
    state.placement3d = normalize3dPlacement(Object.assign({}, state.placement3d || {}, patch || {}));
    apply3dPlacementPreview();
  }

  function render3dViewerPanel() {
    var threeD = state.info && state.info.three_d || {};
    var viewer = threeD.viewer || {};
    var placement = state.placement3d || {};
    var status = "3D від ортофото: X " + formatNumber(placement.offset_x || 0, 2) +
      " м, Y " + formatNumber(placement.offset_y || 0, 2) +
      " м, Z " + formatNumber(placement.offset_z || 0, 2) +
      " м, поворот " + formatNumber(placement.yaw_deg || 0, 1) +
      "°, масштаб " + formatNumber(placement.scale || 1, 3);
    return '' +
      '<section class="smartalign-panel">' +
        '<div class="smartalign-3d-stage">' +
          '<div id="smartalign-3d-viewer" class="smartalign-3d-viewer" data-obj-url="' + escapeHtml(viewer.obj_url || "") + '" data-resource-url="' + escapeHtml(viewer.resource_url || "") + '" data-mtl-path="' + escapeHtml(viewer.mtl_path || "") + '"></div>' +
          '<div class="smartalign-3d-status">' + escapeHtml(state.threeError || status) + '</div>' +
        '</div>' +
      '</section>';
  }

  function render3dTransformToolbar() {
    return '' +
      '<div class="smartalign-3d-toolbar-controls">' +
        '<div class="smartalign-3d-gizmo-tools">' +
          '<button type="button" class="btn btn-default btn-xs' + (state.transformMode3d === "translate" ? " active" : "") + '" data-3d-transform-mode="translate">Рух</button>' +
          '<button type="button" class="btn btn-default btn-xs' + (state.transformMode3d === "rotate" ? " active" : "") + '" data-3d-transform-mode="rotate">Поворот</button>' +
          '<button type="button" class="btn btn-default btn-xs' + (state.transformMode3d === "scale" ? " active" : "") + '" data-3d-transform-mode="scale">Масштаб</button>' +
        '</div>' +
        render3dPlacementControls() +
        '<button type="button" class="btn btn-default smartalign-icon-button" id="smartalign-3d-reset-placement" title="Скинути 3D підгонку"><i class="fa fa-refresh"></i></button>' +
      '</div>';
  }

  function render3dPointTable() {
    if (!state.points3d.length) return "";
    var rows = state.points3d.map(function (point, index) {
      var mesh = point.mesh || {};
      var world = point.world || {};
      var residuals = state.info && state.info.alignment_3d && state.info.alignment_3d.residuals || [];
      var residual = typeof residuals[index] === "number" ? residuals[index] : null;
      return '' +
        '<tr class="' + (index === state.activePoint ? "active" : "") + '">' +
          '<td><button type="button" class="btn btn-default btn-xs" data-use-point="' + index + '">P' + (index + 1) + '</button></td>' +
          '<td>' + escapeHtml(mesh.x == null ? "-" : [mesh.x, mesh.y, mesh.z].map(function (value) { return formatNumber(value, 3); }).join(", ")) + '</td>' +
          '<td>' + escapeHtml(world.lat == null ? "-" : [world.lat, world.lng].map(function (value) { return formatNumber(value, 7); }).join(", ")) + '</td>' +
          '<td><input type="number" step="0.01" class="smartalign-3d-height" data-height-point="' + index + '" value="' + escapeHtml(point.height || 0) + '"></td>' +
          '<td>' + escapeHtml(residual == null ? "-" : formatNumber(residual, 3) + " м") + '</td>' +
          '<td><button type="button" class="btn btn-danger btn-xs" data-delete-3d-point="' + index + '"><i class="fa fa-trash"></i></button></td>' +
        '</tr>';
    }).join("");
    return '' +
      '<div class="smartalign-3d-table-wrap">' +
        '<table class="smartalign-3d-table">' +
          '<thead><tr><th>Point</th><th>Mesh XYZ</th><th>Lat/Lng</th><th>Height</th><th>Error</th><th></th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>';
  }

  function render3dPlacementControls() {
    var placement = Object.assign({ offset_x: 0, offset_y: 0, offset_z: 0, yaw_deg: 0, scale: 1 }, state.placement3d || {});
    function input(name, label, step) {
      return '' +
        '<label class="smartalign-3d-placement-field">' +
          '<span>' + label + '</span>' +
          '<input type="number" step="' + step + '" data-3d-placement="' + name + '" value="' + escapeHtml(placement[name]) + '">' +
        '</label>';
    }
    return '' +
      '<div class="smartalign-3d-placement">' +
        '<div class="smartalign-3d-placement-grid">' +
          input("offset_x", "X м", "0.1") +
          input("offset_y", "Y м", "0.1") +
          input("offset_z", "Z м", "0.1") +
          input("yaw_deg", "Поворот °", "0.1") +
          input("scale", "Масштаб", "0.001") +
        '</div>' +
        '<div class="smartalign-3d-nudge">' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_y:1">Y +</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_y:-1">Y -</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_x:-1">X -</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_x:1">X +</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_z:1">Z +</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="offset_z:-1">Z -</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="yaw_deg:-1">↺</button>' +
          '<button type="button" class="btn btn-default btn-xs" data-3d-nudge="yaw_deg:1">↻</button>' +
        '</div>' +
      '</div>';
  }

  function render3dMapPanel() {
    var alignment = state.info && state.info.alignment_3d;
    var resultStatus = alignment
      ? '<div class="smartalign-map-status">3D підготовлено: ' + escapeHtml(localize3dMode(alignment.method || "")) + '</div>'
      : '<div class="smartalign-map-status">Базова 3D прив’язка береться з ортофото</div>';
    return '' +
      '<section class="smartalign-panel">' +
        '<div class="smartalign-panel-head">' +
          resultStatus +
          '<div class="smartalign-map-actions">' +
            '<div class="smartalign-map-layer-picker">' +
              '<button id="smartalign-map-layer-toggle" type="button" class="btn btn-default smartalign-icon-button" title="Обрати карту"><i class="fa fa-map"></i></button>' +
              '<div class="smartalign-map-layer-menu">' + BASE_MAP_NAMES.map(function (name) {
                return '<button type="button" class="smartalign-map-layer-option' + (state.activeBaseMap === name ? " active" : "") + '" data-layer-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
              }).join("") + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="smartalign-map" class="smartalign-map">' + (!window.L ? '<div class="smartalign-empty">Завантаження карти...</div>' : '') + '</div>' +
        render3dPlacementControls() +
      '</section>';
  }

  function localizeQuality(value) {
    var key = String(value || "").toUpperCase();
    if (key === "GOOD") return "добре";
    if (key === "ACCEPTABLE") return "прийнятно";
    if (key === "POOR") return "слабко";
    if (key === "FAILED") return "помилка";
    return value || "";
  }

  function localizeTransformType(value) {
    if (value === "similarity") return "поворот / масштаб / зсув";
    if (value === "affine") return "affine";
    return value || "";
  }

  function userResultText(alignment) {
    if (!alignment) return "";
    var rmse = Number(alignment.rmse || 0);
    var accuracy = rmse < 1.5 ? "точно" : rmse < 5 ? "потрібна перевірка" : "неточно";
    return "Прив’язка: " + escapeHtml(localizeQuality(alignment.quality)) + " · " + accuracy + " · похибка " + escapeHtml(rmse.toFixed(2)) + " м";
  }

  function alignmentHasRotation(alignment) {
    var transform = alignment && alignment.raster_transform;
    if (!transform || transform.length < 4) return false;
    return Math.abs(Number(transform[1] || 0)) > 0.000000001 || Math.abs(Number(transform[3] || 0)) > 0.000000001;
  }

  function formatBytes(value) {
    var bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  function formatBounds(bounds) {
    if (!bounds || bounds.length !== 4) return "";
    return bounds.map(function (value) {
      var number = Number(value);
      if (!Number.isFinite(number)) return "";
      return Math.abs(number) >= 1000 ? number.toFixed(2) : number.toFixed(4);
    }).join(", ");
  }

  function localizeCoordinateStatus(value) {
    if (value === "crs_like") return "CRS-like";
    if (value === "local") return "локальні";
    if (value === "different_crs_or_local") return "інша CRS або локальні";
    if (value === "unknown") return "невідомо";
    return value || "";
  }

  function localize3dMode(value) {
    if (value === "direct_crs") return "direct CRS";
    if (value === "local_orthophoto_bridge") return "через ортофото";
    if (value === "local_to_orthophoto_pixel_to_map") return "local -> orthophoto -> map";
    return value || "";
  }

  function render3dAsset(key, asset) {
    asset = asset || {};
    var label = asset.label || key.toUpperCase();
    if (!asset.exists) {
      return '<div class="smartalign-3d-asset missing"><span>' + escapeHtml(label) + '</span><strong>не знайдено</strong></div>';
    }
    var details = [];
    if (asset.path) details.push(escapeHtml(asset.path));
    var size = formatBytes(asset.size);
    if (size) details.push(escapeHtml(size));
    if (asset.coordinate_status) details.push('координати: ' + escapeHtml(localizeCoordinateStatus(asset.coordinate_status)));
    if (asset.bounds) details.push('bounds: ' + escapeHtml(formatBounds(asset.bounds)));
    if (asset.bounds_wgs84) details.push('WGS84: ' + escapeHtml(formatBounds(asset.bounds_wgs84)));
    if (asset.width && asset.height) details.push(escapeHtml(asset.width + "x" + asset.height));
    if (asset.points) details.push('points: ' + escapeHtml(asset.points));
    if (asset.bridge && asset.bridge.available) details.push('bridge: ' + escapeHtml(localize3dMode(asset.bridge.method || "local_orthophoto_bridge")));
    if (asset.error) details.push('помилка: ' + escapeHtml(asset.error));
    return '' +
      '<div class="smartalign-3d-asset found">' +
        '<span>' + escapeHtml(label) + '</span>' +
        '<strong>знайдено</strong>' +
        '<div>' + details.join(' · ') + '</div>' +
        (asset.diagnostic ? '<div>' + escapeHtml(asset.diagnostic) + '</div>' : '') +
      '</div>';
  }

  function render3dDiagnostics(threeD) {
    if (!threeD) return "";
    var assets = threeD.assets || {};
    var blockers = Array.isArray(threeD.blockers) ? threeD.blockers : [];
    var ortho = threeD.orthophoto || {};
    var assetHtml = ["obj", "glb", "laz", "ept", "dsm", "dtm"].map(function (key) {
      return render3dAsset(key, assets[key]);
    }).join("");
    var blockerHtml = blockers.length
      ? '<ul>' + blockers.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>'
      : "";
    var orthoDetails = [];
    if (ortho.crs) orthoDetails.push('CRS: ' + escapeHtml(ortho.crs));
    if (ortho.bounds) orthoDetails.push('bounds: ' + escapeHtml(formatBounds(ortho.bounds)));
    if (ortho.bounds_wgs84) orthoDetails.push('WGS84: ' + escapeHtml(formatBounds(ortho.bounds_wgs84)));
    if (threeD.mode) orthoDetails.push('3D режим: ' + escapeHtml(localize3dMode(threeD.mode)));
    return '' +
      '<div class="smartalign-3d-diagnostics">' +
        '<div class="smartalign-3d-summary ' + (threeD.available ? "available" : "blocked") + '">' + escapeHtml(threeD.reason || "") + '</div>' +
        (orthoDetails.length ? '<div class="smartalign-3d-ortho">' + orthoDetails.join(' · ') + '</div>' : '') +
        '<div class="smartalign-3d-assets">' + assetHtml + '</div>' +
        blockerHtml +
      '</div>';
  }

  function renderReplacementAction() {
    var alignment = state.info && state.info.alignment;
    var replacement = state.info && state.info.replacement;
    var replacementActive = replacement && replacement.active;
    if (replacementActive && (!alignment || !state.assetWriteDirty)) {
      return '<button type="button" class="btn btn-warning" id="smartalign-restore"><i class="fa fa-undo"></i> Відновити ортофото</button>';
    }
    if (!alignment) return "";
    return '<button type="button" class="btn btn-danger" id="smartalign-replace"><i class="fa fa-exchange"></i> Застосувати ортофото</button>';
  }

  function render3dAction() {
    var alignment = state.info && state.info.alignment;
    var threeD = state.info && state.info.three_d || {};
    var hasViewer = threeD.viewer && threeD.viewer.obj_url;
    var alignment3d = state.info && state.info.alignment_3d;
    var replacement3d = state.info && state.info.replacement_3d;
    var disabled = !alignment || !hasViewer || state.aligning3d;
    var title = "";
    if (!alignment) title = "Спочатку розрахуйте прив’язку ортофото";
    else if (!hasViewer) title = "OBJ модель недоступна";
    else title = "Окремо підготувати 3D прив’язку";

    var html = "";
    if (state.mode !== "3d") {
      html += '<button type="button" class="btn btn-default" id="smartalign-align3d" ' +
        (disabled ? "disabled " : "") +
        'title="' + escapeHtml(title) + '"><i class="fa fa-cube"></i> ' +
        (alignment3d ? "Оновити 3D" : "Прив’язати 3D") +
        '</button>';
    }

    if (alignment3d) {
      html += '<button type="button" class="btn btn-default" id="smartalign-replace3d" ' +
        (state.replacing3d ? "disabled " : "") +
        'title="Застосувати підготовлену 3D модель окремо від ортофото"><i class="fa fa-cubes"></i> ' +
        (state.replacing3d ? "Застосування 3D..." : "Застосувати 3D") +
        '</button>';
    }

    if (replacement3d && replacement3d.active) {
      html += '<button type="button" class="btn btn-warning" id="smartalign-restore3d" ' +
        (state.restoring3d ? "disabled " : "") +
        'title="Відновити оригінальну 3D модель"><i class="fa fa-undo"></i> ' +
        (state.restoring3d ? "Відновлення 3D..." : "Відновити 3D") +
        '</button>';
    }

    return html;
  }

  function canApplyAlignment() {
    return validPairs().length >= 2 && !state.applying;
  }

  function render() {
    if (!state.info) {
      root.innerHTML = '<div class="smartalign-loading"><i class="fa fa-circle-notch fa-spin"></i> Завантаження Smartpoint...</div>';
      return;
    }

    if (state.mode === "3d") {
      if (map) {
        map.remove();
        map = null;
        baseLayer = null;
        alignedOverlay = null;
        orthophotoLayer = null;
        mapMarkers = [];
      }
      root.innerHTML = '' +
        '<div class="smartalign-app">' +
          '<div class="smartalign-topbar">' +
            '<button type="button" class="btn btn-default smartalign-back" id="smartalign-back-ortho"><i class="fa fa-arrow-left"></i> Ортофото</button>' +
            '<div class="smartalign-toolbar">' +
              '<button type="button" class="btn btn-primary" id="smartalign-3d-calculate" ' + ((state.info && state.info.alignment && !state.aligning3d) ? "" : "disabled") + '><i class="fa fa-cube"></i> ' + (state.aligning3d ? "Збереження..." : "Зберегти 3D") + '</button>' +
              render3dTransformToolbar() +
              render3dAction() +
            '</div>' +
          '</div>' +
          '<div class="smartalign-workspace smartalign-workspace-3d">' +
            render3dViewerPanel() +
          '</div>' +
        '</div>';
      bindEvents();
      init3dViewerWhenReady();
      return;
    }

    dispose3dViewer();
    root.innerHTML = '' +
      '<div class="smartalign-app">' +
        '<div class="smartalign-topbar">' +
          '<a class="btn btn-default smartalign-back" href="/dashboard/?project_task_open=' + encodeURIComponent(state.projectId) + '"><i class="fa fa-arrow-left"></i> Назад</a>' +
          '<div class="smartalign-toolbar">' +
            '<button type="button" class="btn btn-default" id="smartalign-clear-points"><i class="fa fa-eraser"></i> Очистити</button>' +
            '<button type="button" class="btn btn-primary" id="smartalign-apply" ' + (canApplyAlignment() ? "" : "disabled") + '><i class="fa fa-crosshairs"></i> ' + (state.applying ? "Розрахунок..." : "Розрахувати прив’язку") + '</button>' +
            renderReplacementAction() +
            render3dAction() +
          '</div>' +
        '</div>' +
        '<div class="smartalign-workspace">' +
          renderOrthoPanel() +
          renderReferencePanel() +
        '</div>' +
      '</div>';

    bindEvents();
    ensureLeafletThenSyncMap();
  }

  function setOrthoZoom(nextScale, anchor) {
    var currentView = state.orthoView || { scale: 1, panX: 0, panY: 0 };
    var stage = root.querySelector("[data-ortho-stage]");
    var scale = Math.max(0.5, Math.min(6, nextScale));
    var nextView = { scale: scale, panX: 0, panY: 0 };

    if (stage && anchor) {
      var rect = stage.getBoundingClientRect();
      var anchorX = anchor.clientX - rect.left;
      var anchorY = anchor.clientY - rect.top;
      var imageX = (stage.scrollLeft + anchorX) / currentView.scale;
      var imageY = (stage.scrollTop + anchorY) / currentView.scale;
      state.orthoView = nextView;
      applyOrthoView();
      stage.scrollLeft = Math.max(0, (imageX * scale) - anchorX);
      stage.scrollTop = Math.max(0, (imageY * scale) - anchorY);
      state.orthoView = {
        scale: scale,
        panX: stage.scrollLeft,
        panY: stage.scrollTop
      };
      return;
    }

    state.orthoView = nextView;
    applyOrthoView();
  }

  function applyOrthoView() {
    var frame = root.querySelector(".smartalign-image-frame");
    var meta = state.info && state.info.orthophoto;
    var view = state.orthoView || { scale: 1 };
    if (frame && meta) {
      frame.style.width = (Number(meta.preview_width || meta.width || 1) * view.scale) + "px";
      frame.style.height = (Number(meta.preview_height || meta.height || 1) * view.scale) + "px";
    }
    Array.prototype.forEach.call(root.querySelectorAll(".smartalign-marker"), function (marker) {
      var index = parseInt(marker.getAttribute("data-point"), 10);
      var point = state.points[index] && state.points[index].ortho;
      if (!point) return;
      marker.setAttribute("style", markerStyle(point));
    });
    Array.prototype.forEach.call(root.querySelectorAll(".smartalign-marker-delete"), function (button) {
      var index = parseInt(button.getAttribute("data-delete-point"), 10);
      var point = state.points[index] && state.points[index].ortho;
      var position = markerPosition(point);
      if (!position) return;
      button.setAttribute("style", "left:" + position.left + "px;top:" + (position.top - 30) + "px");
    });
  }

  function dispose3dViewer() {
    if (threeAnimation) window.cancelAnimationFrame(threeAnimation);
    threeAnimation = null;
    if (threeRenderer) {
      try { threeRenderer.dispose(); } catch (_) {}
    }
    if (threeTransformControls) {
      try { threeTransformControls.detach(); threeTransformControls.dispose(); } catch (_) {}
    }
    threeScene = null;
    threeCamera = null;
    threeRenderer = null;
    threeControls = null;
    threeTransformControls = null;
    threeModel = null;
    threeGround = null;
    threeRaycaster = null;
    threePointer = null;
  }

  function init3dViewerWhenReady() {
    var container = document.getElementById("smartalign-3d-viewer");
    if (!container) return;
    var objUrl = container.getAttribute("data-obj-url");
    if (!objUrl) {
      state.threeError = "OBJ модель недоступна";
      return;
    }
    ensureThree()
      .then(function () {
        init3dViewer(container, objUrl, container.getAttribute("data-resource-url") || "", container.getAttribute("data-mtl-path") || "");
      })
      .catch(function (error) {
        state.threeError = error.message || String(error);
        render();
      });
  }

  function encodeResourcePath(path) {
    return String(path || "").split("/").map(function (part) {
      return encodeURIComponent(part);
    }).join("/");
  }

  function joinResourceUrl(baseUrl, path) {
    if (!baseUrl || !path) return "";
    return baseUrl.replace(/\/?$/, "/") + encodeResourcePath(path);
  }

  function objLoaderPromise(loader, url) {
    return new Promise(function (resolve, reject) {
      loader.load(url, resolve, undefined, reject);
    });
  }

  function load3dObjWithMaterials(objUrl, resourceUrl, mtlPath) {
    var materialPathPromise = mtlPath
      ? Promise.resolve(mtlPath)
      : fetch(objUrl, { credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) return "";
          return response.text();
        })
        .then(function (text) {
          var match = text.match(/^\s*mtllib\s+(.+)$/mi);
          return match ? match[1].trim() : "";
        })
        .catch(function () { return ""; });

    return materialPathPromise.then(function (resolvedMtlPath) {
      var objLoader = new THREE.OBJLoader();
      if (!resolvedMtlPath || !resourceUrl || !window.THREE.MTLLoader) {
        return objLoaderPromise(objLoader, objUrl);
      }

      var normalizedMtl = resolvedMtlPath.replace(/\\/g, "/");
      var slash = normalizedMtl.lastIndexOf("/");
      var mtlDir = slash >= 0 ? normalizedMtl.slice(0, slash + 1) : "";
      var mtlFile = slash >= 0 ? normalizedMtl.slice(slash + 1) : normalizedMtl;
      var mtlBaseUrl = joinResourceUrl(resourceUrl, mtlDir);
      var mtlLoader = new THREE.MTLLoader();
      mtlLoader.setCrossOrigin("anonymous");
      mtlLoader.setPath(mtlBaseUrl || resourceUrl);
      mtlLoader.setResourcePath(mtlBaseUrl || resourceUrl);

      return new Promise(function (resolve) {
        mtlLoader.load(encodeResourcePath(mtlFile), function (materials) {
          materials.preload();
          objLoader.setMaterials(materials);
          resolve(objLoaderPromise(objLoader, objUrl));
        }, undefined, function () {
          resolve(objLoaderPromise(objLoader, objUrl));
        });
      }).then(function (loaded) {
        return loaded;
      });
    });
  }

  function init3dViewer(container, objUrl, resourceUrl, mtlPath) {
    dispose3dViewer();
    state.threeError = "";
    var width = Math.max(320, container.clientWidth || 640);
    var height = Math.max(260, container.clientHeight || 480);
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x20242b);
    threeCamera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100000000);
    threeRenderer = new THREE.WebGLRenderer({ antialias: true });
    threeRenderer.setPixelRatio(window.devicePixelRatio || 1);
    threeRenderer.setSize(width, height);
    container.innerHTML = "";
    container.appendChild(threeRenderer.domElement);

    threeControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
    threeControls.enableDamping = true;
    threeRaycaster = new THREE.Raycaster();
    threePointer = new THREE.Vector2();

    var light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    threeScene.add(light);
    var directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(1, 1, 1);
    threeScene.add(directional);
    threeScene.add(new THREE.AxesHelper(50));

    load3dObjWithMaterials(objUrl, resourceUrl, mtlPath).then(function (object) {
      threeModel = object;
      object.traverse(function (child) {
        if (child.isMesh) {
          if (!child.material) {
            child.material = new THREE.MeshLambertMaterial({ color: 0xd8dde2, side: THREE.DoubleSide });
          } else if (Array.isArray(child.material)) {
            child.material.forEach(function (material) {
              material.side = THREE.DoubleSide;
              material.needsUpdate = true;
            });
          } else {
            child.material.side = THREE.DoubleSide;
            child.material.needsUpdate = true;
          }
          child.geometry.computeBoundingBox();
          child.geometry.computeBoundingSphere();
        }
      });
      threeScene.add(object);
      apply3dPlacementPreview();
      add3dGroundPlane(object);
      attach3dTransformControls(object);
      fitCameraToObject(object);
    }).catch(function (error) {
      state.threeError = "Не вдалося завантажити OBJ: " + (error && error.message ? error.message : "");
      render();
    });

    var dragStart = null;
    threeRenderer.domElement.addEventListener("pointerdown", function (event) {
      dragStart = { x: event.clientX, y: event.clientY, moved: false };
    });
    threeRenderer.domElement.addEventListener("pointermove", function (event) {
      if (!dragStart) return;
      if (Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y) > 4) {
        dragStart.moved = true;
        suppressNext3dPick = true;
      }
    });
    threeRenderer.domElement.addEventListener("pointerup", function () {
      if (dragStart && dragStart.moved) {
        suppressNext3dPick = true;
        window.setTimeout(function () { suppressNext3dPick = false; }, 300);
      }
      dragStart = null;
    });

    threeRenderer.domElement.addEventListener("click", function (event) {
      pick3dPoint(event, threeRenderer.domElement);
    });

    window.addEventListener("resize", resize3dViewer);
    animate3dViewer();
  }

  function fitCameraToObject(object) {
    var box = new THREE.Box3().setFromObject(object);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var maxSize = Math.max(size.x, size.y, size.z) || 1;
    var distance = maxSize * 1.8;
    threeCamera.position.set(center.x + distance, center.y - distance, center.z + distance);
    threeCamera.near = Math.max(maxSize / 10000, 0.01);
    threeCamera.far = maxSize * 10000;
    threeCamera.updateProjectionMatrix();
    threeControls.target.copy(center);
    threeControls.update();
  }

  function resize3dViewer() {
    var container = document.getElementById("smartalign-3d-viewer");
    if (!container || !threeRenderer || !threeCamera) return;
    var width = Math.max(320, container.clientWidth || 640);
    var height = Math.max(260, container.clientHeight || 480);
    threeCamera.aspect = width / height;
    threeCamera.updateProjectionMatrix();
    threeRenderer.setSize(width, height);
  }

  function animate3dViewer() {
    if (!threeRenderer || !threeScene || !threeCamera) return;
    threeAnimation = window.requestAnimationFrame(animate3dViewer);
    if (threeControls) threeControls.update();
    threeRenderer.render(threeScene, threeCamera);
  }

  function update3dStatusDom() {
    var status = root.querySelector(".smartalign-3d-status");
    if (!status) return;
    var placement = normalize3dPlacement(state.placement3d);
    status.textContent = state.threeError || (
      "3D від ортофото: X " + formatNumber(placement.offset_x, 2) +
      " м, Y " + formatNumber(placement.offset_y, 2) +
      " м, Z " + formatNumber(placement.offset_z, 2) +
      " м, поворот " + formatNumber(placement.yaw_deg, 1) +
      "°, масштаб " + formatNumber(placement.scale, 3)
    );
  }

  function sync3dPlacementInputs() {
    var placement = normalize3dPlacement(state.placement3d);
    Array.prototype.forEach.call(root.querySelectorAll("[data-3d-placement]"), function (input) {
      var key = input.getAttribute("data-3d-placement");
      if (placement[key] == null) return;
      input.value = String(Math.round(Number(placement[key]) * 1000) / 1000);
    });
    update3dStatusDom();
  }

  function apply3dPlacementPreview() {
    if (!threeModel) return;
    var placement = normalize3dPlacement(state.placement3d);
    threeModel.position.set(placement.offset_x, placement.offset_y, placement.offset_z);
    threeModel.rotation.z = placement.yaw_deg * Math.PI / 180;
    threeModel.scale.set(placement.scale, placement.scale, placement.scale);
    sync3dPlacementInputs();
  }

  function updatePlacementFrom3dModel() {
    if (!threeModel) return;
    var scale = (Number(threeModel.scale.x) + Number(threeModel.scale.y) + Number(threeModel.scale.z)) / 3;
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    threeModel.scale.set(scale, scale, scale);
    state.placement3d = normalize3dPlacement({
      offset_x: threeModel.position.x,
      offset_y: threeModel.position.y,
      offset_z: threeModel.position.z,
      yaw_deg: threeModel.rotation.z * 180 / Math.PI,
      scale: scale
    });
    sync3dPlacementInputs();
  }

  function update3dTransformControlsMode() {
    if (!threeTransformControls) return;
    var mode = state.transformMode3d || "translate";
    threeTransformControls.setMode(mode);
    threeTransformControls.showX = mode !== "rotate";
    threeTransformControls.showY = mode !== "rotate";
    threeTransformControls.showZ = true;
  }

  function attach3dTransformControls(object) {
    if (!window.THREE || !THREE.TransformControls || !threeCamera || !threeRenderer || !threeScene) return;
    threeTransformControls = new THREE.TransformControls(threeCamera, threeRenderer.domElement);
    threeTransformControls.attach(object);
    update3dTransformControlsMode();
    threeTransformControls.addEventListener("dragging-changed", function (event) {
      if (threeControls) threeControls.enabled = !event.value;
      if (!event.value) {
        suppressNext3dPick = true;
        window.setTimeout(function () { suppressNext3dPick = false; }, 300);
      }
    });
    threeTransformControls.addEventListener("objectChange", updatePlacementFrom3dModel);
    threeScene.add(threeTransformControls);
  }

  function threeMapTextureCenter() {
    var view = state.mapView || {};
    if (Number.isFinite(Number(view.lat)) && Number.isFinite(Number(view.lng))) {
      return { lat: Number(view.lat), lng: Number(view.lng) };
    }
    var bounds = state.info && state.info.orthophoto && state.info.orthophoto.bounds_wgs84;
    if (bounds && bounds.length === 4) {
      return {
        lat: (Number(bounds[1]) + Number(bounds[3])) / 2,
        lng: (Number(bounds[0]) + Number(bounds[2])) / 2
      };
    }
    return { lat: 48.7, lng: 31.2 };
  }

  function lonLatToTile(lng, lat, zoom) {
    var latRad = lat * Math.PI / 180;
    var scale = Math.pow(2, zoom);
    return {
      x: Math.floor((lng + 180) / 360 * scale),
      y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale)
    };
  }

  function esriSatelliteTileUrl(x, y, z) {
    return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/" + z + "/" + y + "/" + x;
  }

  function loadImageForCanvas(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = function () { resolve(image); };
      image.onerror = reject;
      image.src = url;
    });
  }

  function create3dMapCanvasTexture() {
    var center = threeMapTextureCenter();
    var zoom = 17;
    var tile = lonLatToTile(center.lng, center.lat, zoom);
    var tileSize = 256;
    var radius = 1;
    var canvas = document.createElement("canvas");
    canvas.width = tileSize * 3;
    canvas.height = tileSize * 3;
    var context = canvas.getContext("2d");
    var tasks = [];

    for (var dy = -radius; dy <= radius; dy += 1) {
      for (var dx = -radius; dx <= radius; dx += 1) {
        (function (offsetX, offsetY) {
          var url = esriSatelliteTileUrl(tile.x + offsetX, tile.y + offsetY, zoom);
          tasks.push(loadImageForCanvas(url).then(function (image) {
            context.drawImage(image, (offsetX + radius) * tileSize, (offsetY + radius) * tileSize, tileSize, tileSize);
          }));
        })(dx, dy);
      }
    }

    return Promise.all(tasks).then(function () {
      var texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    });
  }

  function add3dGroundPlane(object) {
    if (!window.THREE || !threeScene) return;
    var box = new THREE.Box3().setFromObject(object);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var planeSize = Math.max(size.x, size.y, size.z, 1) * 1.35;
    var geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    var fallbackMaterial = new THREE.MeshLambertMaterial({
      color: 0x384a36,
      opacity: 0.72,
      side: THREE.DoubleSide,
      transparent: true
    });
    threeGround = new THREE.Mesh(geometry, fallbackMaterial);
    threeGround.position.set(center.x, center.y, box.min.z - Math.max(planeSize * 0.002, 0.05));
    threeScene.add(threeGround);

    var grid = new THREE.GridHelper(planeSize, 20, 0x75a7ff, 0x4d5965);
    grid.rotation.x = Math.PI / 2;
    grid.position.copy(threeGround.position);
    grid.position.z += 0.02;
    threeScene.add(grid);

    create3dMapCanvasTexture().then(function (texture) {
      if (!threeGround) return;
      texture.anisotropy = threeRenderer ? threeRenderer.capabilities.getMaxAnisotropy() : 1;
      threeGround.material = new THREE.MeshLambertMaterial({
        map: texture,
        opacity: 0.76,
        side: THREE.DoubleSide,
        transparent: true
      });
    }).catch(function () {});
  }

  function pick3dPoint(event, canvas) {
    if (suppressNext3dPick) {
      suppressNext3dPick = false;
      return;
    }
    if (!threeModel || !threeRaycaster || !threeCamera || !threePointer) return;
    var rect = canvas.getBoundingClientRect();
    threePointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    threePointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    threeRaycaster.setFromCamera(threePointer, threeCamera);
    var meshes = [];
    threeModel.traverse(function (child) {
      if (child.isMesh) meshes.push(child);
    });
    var intersections = threeRaycaster.intersectObjects(meshes, false);
    if (!intersections.length) return;
    var point = intersections[0].point;
    ensure3dPoint(state.activePoint).mesh = {
      x: Math.round(point.x * 1000000) / 1000000,
      y: Math.round(point.y * 1000000) / 1000000,
      z: Math.round(point.z * 1000000) / 1000000
    };
    render();
  }

  function bindEvents() {
    var backOrtho = document.getElementById("smartalign-back-ortho");
    if (backOrtho) backOrtho.addEventListener("click", function () {
      state.mode = "ortho";
      render();
    });

    Array.prototype.forEach.call(root.querySelectorAll("#smartalign-3d-add-point, .smartalign-3d-add-point"), function (button) {
      button.addEventListener("click", function () {
        state.points3d.push(empty3dPoint());
        state.activePoint = state.points3d.length - 1;
        render();
      });
    });

    var calculate3d = document.getElementById("smartalign-3d-calculate");
    if (calculate3d) calculate3d.addEventListener("click", calculate3dAlignment);

    Array.prototype.forEach.call(root.querySelectorAll("[data-3d-transform-mode]"), function (button) {
      button.addEventListener("click", function () {
        state.transformMode3d = button.getAttribute("data-3d-transform-mode") || "translate";
        update3dTransformControlsMode();
        Array.prototype.forEach.call(root.querySelectorAll("[data-3d-transform-mode]"), function (item) {
          item.classList.toggle("active", item === button);
        });
      });
    });

    var resetPlacement = document.getElementById("smartalign-3d-reset-placement");
    if (resetPlacement) resetPlacement.addEventListener("click", function () {
      set3dPlacement({ offset_x: 0, offset_y: 0, offset_z: 0, yaw_deg: 0, scale: 1 });
    });

    Array.prototype.forEach.call(root.querySelectorAll("[data-3d-placement]"), function (input) {
      function updatePlacement() {
        var key = input.getAttribute("data-3d-placement");
        var patch = {};
        patch[key] = Number(input.value);
        set3dPlacement(patch);
      }
      input.addEventListener("input", updatePlacement);
      input.addEventListener("change", function () {
        updatePlacement();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll("[data-3d-nudge]"), function (button) {
      button.addEventListener("click", function () {
        var parts = String(button.getAttribute("data-3d-nudge") || "").split(":");
        var key = parts[0];
        var delta = Number(parts[1] || 0);
        var current = normalize3dPlacement(state.placement3d);
        var patch = {};
        patch[key] = Number(current[key] || 0) + delta;
        set3dPlacement(patch);
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll("[data-height-point]"), function (input) {
      function updateHeight() {
        var index = parseInt(input.getAttribute("data-height-point"), 10);
        ensure3dPoint(index).height = Number(input.value || 0);
      }
      input.addEventListener("input", updateHeight);
      input.addEventListener("change", updateHeight);
    });

    Array.prototype.forEach.call(root.querySelectorAll("[data-delete-3d-point]"), function (button) {
      button.addEventListener("click", function () {
        var index = parseInt(button.getAttribute("data-delete-3d-point"), 10);
        state.points3d.splice(index, 1);
        state.activePoint = Math.max(0, Math.min(state.activePoint, state.points3d.length - 1));
        render();
      });
    });

    var add = document.getElementById("smartalign-add-point");
    if (add) add.addEventListener("click", function () {
      state.points.push(emptyPoint());
      state.activePoint = state.points.length - 1;
      pointsChanged();
      render();
    });

    var clear = document.getElementById("smartalign-clear-points");
    if (clear) clear.addEventListener("click", function () {
      state.points = [];
      state.activePoint = 0;
      pointsChanged();
      render();
    });

    var apply = document.getElementById("smartalign-apply");
    if (apply) apply.addEventListener("click", applyAlignment);

    var replace = document.getElementById("smartalign-replace");
    if (replace) replace.addEventListener("click", applyReplacement);

    var restore = document.getElementById("smartalign-restore");
    if (restore) restore.addEventListener("click", restoreReplacement);

    var align3d = document.getElementById("smartalign-align3d");
    if (align3d) align3d.addEventListener("click", align3dModel);

    var replace3d = document.getElementById("smartalign-replace3d");
    if (replace3d) replace3d.addEventListener("click", replace3dModel);

    var restore3d = document.getElementById("smartalign-restore3d");
    if (restore3d) restore3d.addEventListener("click", restore3dModel);

    var opacityToggle = document.getElementById("smartalign-preview-opacity-toggle");
    var opacityPicker = root.querySelector(".smartalign-preview-opacity-picker");
    if (opacityToggle && opacityPicker) {
      opacityToggle.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var mapPicker = root.querySelector(".smartalign-map-layer-picker");
        var orthoPicker = root.querySelector(".smartalign-orthophoto-picker");
        if (mapPicker) mapPicker.classList.remove("open");
        if (orthoPicker) orthoPicker.classList.remove("open");
        opacityPicker.classList.toggle("open");
      });
    }

    var opacityInput = document.getElementById("smartalign-preview-opacity");
    if (opacityInput) {
      opacityInput.addEventListener("input", function () {
        state.previewOpacity = Math.max(0, Math.min(100, Number(opacityInput.value || 0)));
        state.previewVisible = state.previewOpacity > 0;
        var value = document.getElementById("smartalign-preview-opacity-value");
        if (value) value.textContent = state.previewOpacity + "%";
        syncAlignedOverlay();
      });
    }

    Array.prototype.forEach.call(root.querySelectorAll("[data-use-point]"), function (button) {
      button.addEventListener("click", function () {
        state.activePoint = parseInt(button.getAttribute("data-use-point"), 10);
        render();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll("[data-delete-point]"), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var index = parseInt(button.getAttribute("data-delete-point"), 10);
        state.points.splice(index, 1);
        state.activePoint = Math.max(0, Math.min(state.activePoint, state.points.length - 1));
        pointsChanged();
        render();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".smartalign-marker"), function (marker) {
      marker.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        state.activePoint = parseInt(marker.getAttribute("data-point"), 10);
        render();
      });
    });

    var orthoStage = root.querySelector("[data-ortho-stage]");
    if (orthoStage) {
      orthoStage.scrollLeft = (state.orthoView || {}).panX || 0;
      orthoStage.scrollTop = (state.orthoView || {}).panY || 0;

      orthoStage.addEventListener("wheel", function (event) {
        event.preventDefault();
        var current = (state.orthoView || {}).scale || 1;
        setOrthoZoom(current * (event.deltaY < 0 ? 1.12 : 0.89), {
          clientX: event.clientX,
          clientY: event.clientY
        });
      }, { passive: false });

      orthoStage.addEventListener("scroll", function () {
        state.orthoView = Object.assign({}, state.orthoView || { scale: 1 }, {
          panX: orthoStage.scrollLeft,
          panY: orthoStage.scrollTop
        });
      });

      orthoStage.addEventListener("pointerdown", function (event) {
        if (event.button !== 0 || event.pointerType === "touch") return;
        if (event.target && event.target.closest && event.target.closest(".smartalign-marker, .smartalign-marker-delete")) return;
        event.preventDefault();
        var lastX = event.clientX;
        var lastY = event.clientY;
        var moved = false;
        if (orthoStage.setPointerCapture) {
          try { orthoStage.setPointerCapture(event.pointerId); } catch (_) {}
        }
        orthoStage.classList.add("panning");

        function onMove(moveEvent) {
          if (moveEvent.pointerId !== event.pointerId) return;
          var dx = moveEvent.clientX - lastX;
          var dy = moveEvent.clientY - lastY;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          if (!moved) return;
          orthoStage.scrollLeft -= dx;
          orthoStage.scrollTop -= dy;
          state.orthoView = Object.assign({}, state.orthoView || { scale: 1 }, {
            panX: orthoStage.scrollLeft,
            panY: orthoStage.scrollTop
          });
          lastX = moveEvent.clientX;
          lastY = moveEvent.clientY;
        }

        function onUp(upEvent) {
          if (upEvent.pointerId !== event.pointerId) return;
          orthoStage.removeEventListener("pointermove", onMove);
          orthoStage.removeEventListener("pointerup", onUp);
          orthoStage.removeEventListener("pointercancel", onUp);
          if (orthoStage.releasePointerCapture) {
            try { orthoStage.releasePointerCapture(event.pointerId); } catch (_) {}
          }
          orthoStage.classList.remove("panning");
          if (moved) {
            suppressNextOrthoClick = true;
            window.setTimeout(function () { suppressNextOrthoClick = false; }, 250);
          }
        }

        orthoStage.addEventListener("pointermove", onMove);
        orthoStage.addEventListener("pointerup", onUp);
        orthoStage.addEventListener("pointercancel", onUp);
      });

      orthoStage.addEventListener("click", function (event) {
        if (!suppressNextOrthoClick) return;
        suppressNextOrthoClick = false;
        event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        else event.stopPropagation();
      }, true);

      orthoStage.addEventListener("click", function (event) {
        if (event.target.closest && event.target.closest(".smartalign-marker, .smartalign-marker-delete")) return;
        var point = imageOriginalPoint(event);
        if (!point) return;
        ensurePoint(state.activePoint).ortho = point;
        pointsChanged();
        render();
      });
    }

    bindLayerPickerEvents();
  }

  function applyAlignment() {
    var pairs = validPairs();
    if (pairs.length < 2) return;
    state.applying = true;
    render();

    fetch(api("apply/"), {
      method: "POST",
      body: JSON.stringify({ points: pairs }),
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCookie("csrftoken") || ""
      }
    }).then(function (response) {
      if (!response.ok) {
        return responseError(response, "Не вдалося розрахувати прив’язку.");
      }
      return response.json();
    }).then(function (json) {
      state.info.alignment = json.alignment;
      state.info.alignment_3d = null;
      state.assetWriteDirty = true;
      if (json.alignment && json.alignment.quality === "FAILED") {
        window.alert("Прив’язку створено, але якість слабка. Перевірте точки: похибка " + Number(json.alignment.rmse || 0).toFixed(2) + " м.");
      }
      render();
    }).catch(function (error) {
      window.alert(error.message || String(error));
    }).finally(function () {
      state.applying = false;
      render();
    });
  }

  function postJson(path, payload) {
    var options = {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRFToken": getCookie("csrftoken") || "" }
    };
    if (payload) {
      options.body = JSON.stringify(payload);
      options.headers["Content-Type"] = "application/json";
    }
    return fetch(api(path), {
      method: options.method,
      body: options.body,
      credentials: options.credentials,
      headers: options.headers
    }).then(function (response) {
      if (!response.ok) {
        return responseError(response, "Операцію не виконано.");
      }
      return response.json();
    });
  }

  function applyReplacement() {
    var alignment = state.info && state.info.alignment || {};
    var residuals = Array.isArray(alignment.residuals) ? alignment.residuals : [];
    var badCount = residuals.filter(function (value) { return Number(value) >= 5; }).length;
    var message = [
      "Записати smartalign-прив’язку ортофото у WebODM?",
      "",
      "Буде застосовано тільки ортофото. 3D модель лишиться без змін.",
      "",
      "Якість: " + localizeQuality(alignment.quality),
      "Похибка: " + Number(alignment.rmse || 0).toFixed(2) + " м",
      "Точок: " + (alignment.point_count || validPairs().length),
      "Поганих точок (>5 м): " + badCount,
      "",
      "Оригінальне ортофото буде збережено в backup."
    ].join("\n");
    if (!window.confirm(message)) return;
    root.classList.add("smartalign-busy");
    postJson("apply-replacement/")
      .then(function (json) {
        state.info.replacement = json.replacement;
        state.info.replacement_3d = json.replacement_3d;
        state.info.alignment = json.alignment || state.info.alignment;
        state.info.alignment_3d = json.alignment_3d || state.info.alignment_3d;
        state.info.three_d = json.three_d || state.info.three_d;
        state.assetWriteDirty = false;
        var warnings = Array.isArray(json.warnings) ? json.warnings : [];
        if (warnings.length) {
          window.alert("Ортофото оновлено, але є попередження:\n\n" + warnings.join("\n"));
        } else {
          window.alert("Ортофото оновлено в WebODM.");
        }
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        root.classList.remove("smartalign-busy");
      });
  }

  function restoreReplacement() {
    if (!window.confirm("Відновити оригінальне ортофото з backup?")) return;
    root.classList.add("smartalign-busy");
    postJson("restore-replacement/")
      .then(function (json) {
        state.info.replacement = json.replacement;
        state.info.replacement_3d = json.replacement_3d;
        state.info.alignment = json.alignment || state.info.alignment;
        state.info.alignment_3d = json.alignment_3d || state.info.alignment_3d;
        state.info.three_d = json.three_d || state.info.three_d;
        state.assetWriteDirty = true;
        var warnings = Array.isArray(json.warnings) && json.warnings.length ? "\n\n" + json.warnings.join("\n") : "";
        window.alert("Оригінальне ортофото відновлено." + warnings);
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        root.classList.remove("smartalign-busy");
      });
  }

  function align3dModel() {
    state.mode = "3d";
    if (state.info && state.info.alignment_3d && state.info.alignment_3d.placement) {
      state.placement3d = normalize3dPlacement(state.info.alignment_3d.placement);
    }
    if (!state.points3d.length) seed3dPointsFromOrtho();
    state.activePoint = Math.max(0, Math.min(state.activePoint, state.points3d.length - 1));
    render();
  }

  function calculate3dAlignment() {
    var pairs = valid3dPairs();
    state.aligning3d = true;
    render();
    var payload = pairs.length >= 3
      ? { points: pairs }
      : { placement: normalize3dPlacement(state.placement3d) };
    postJson("align-3d/", payload)
      .then(function (json) {
        state.info.alignment_3d = json.alignment_3d;
        if (json.alignment_3d && json.alignment_3d.placement) {
          state.placement3d = normalize3dPlacement(json.alignment_3d.placement);
        }
        if (json.alignment_3d && Array.isArray(json.alignment_3d.points)) {
          state.points3d = json.alignment_3d.points.map(function (point) {
            return {
              id: point.id,
              mesh: point.mesh || null,
              world: point.world ? { lat: point.world.lat, lng: point.world.lon || point.world.lng, height: point.world.height } : null,
              height: point.world ? Number(point.world.height || 0) : Number(point.height || 0),
              enabled: point.enabled !== false
            };
          });
        }
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        state.aligning3d = false;
        render();
      });
  }

  function delta3dExport() {
    state.exportingDelta3d = true;
    render();
    postJson("delta-3d/")
      .then(function (json) {
        state.info.alignment_3d = json.alignment_3d;
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        state.exportingDelta3d = false;
        render();
      });
  }

  function replace3dModel() {
    if (!window.confirm("Застосувати підготовлену Smartpoint 3D модель у WebODM? Оригінальна ODM 3D модель буде збережена в backup.")) return;
    state.replacing3d = true;
    render();
    postJson("replace-3d/")
      .then(function (json) {
        state.info.replacement_3d = json.replacement_3d;
        state.info.alignment_3d = json.alignment_3d || state.info.alignment_3d;
        state.info.three_d = json.three_d || state.info.three_d;
        window.alert("Smartpoint 3D модель застосовано окремо від ортофото.");
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        state.replacing3d = false;
        render();
      });
  }

  function restore3dModel() {
    if (!window.confirm("Відновити оригінальну ODM 3D модель з backup?")) return;
    state.restoring3d = true;
    render();
    postJson("restore-3d/")
      .then(function (json) {
        state.info.replacement_3d = json.replacement_3d;
        state.info.alignment_3d = json.alignment_3d || state.info.alignment_3d;
        state.info.three_d = json.three_d || state.info.three_d;
        window.alert("Оригінальну ODM 3D модель відновлено.");
        render();
      })
      .catch(function (error) {
        window.alert(error.message || String(error));
      })
      .finally(function () {
        state.restoring3d = false;
        render();
      });
  }

  function getBaseMapNativeZoom(value, fallbackZoom) {
    if (/World_Imagery\/MapServer/i.test(value)) return 17;
    if (/World_Street_Map\/MapServer/i.test(value)) return 17;
    if (/opentopomap\.org/i.test(value)) return 17;
    if (/tile\.openstreetmap\.org/i.test(value)) return 19;
    if (/basemaps\.cartocdn\.com/i.test(value)) return Math.min(fallbackZoom, 19);
    return fallbackZoom;
  }

  function createBaseTileLayer(url, options) {
    var tileOptions = Object.assign({}, options || {});
    var fallbackMaxZoom = Number(tileOptions.maxZoom);
    var nativeMaxZoom = Number.isFinite(fallbackMaxZoom) ? getBaseMapNativeZoom(url, fallbackMaxZoom) : fallbackMaxZoom;
    if (Number.isFinite(nativeMaxZoom)) {
      tileOptions.maxNativeZoom = nativeMaxZoom;
      tileOptions.maxZoom = nativeMaxZoom + 99;
    }
    return L.tileLayer(url, tileOptions);
  }

  function createBaseMapLayers() {
    return {
      "Esri Satellite": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 19
      }),
      "Esri Streets": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 17
      }),
      "Esri Topo": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 17
      }),
      "Esri Terrain": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 13
      }),
      "Esri NatGeo": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 16
      }),
      "Esri Light Gray": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 16
      }),
      "Esri Dark Gray": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 16
      }),
      "OpenStreetMap": createBaseTileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
      }),
      "OpenStreetMap HOT": createBaseTileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors, Tiles style by HOT",
        maxZoom: 19
      }),
      "OpenStreetMap DE": createBaseTileLayer("https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
      }),
      "Topo": createBaseTileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenTopoMap contributors",
        maxZoom: 17
      }),
      "Light": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        maxZoom: 20,
        subdomains: "abcd"
      }),
      "Dark": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        maxZoom: 20,
        subdomains: "abcd"
      }),
      "Voyager": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        maxZoom: 20,
        subdomains: "abcd"
      })
    };
  }

  function setBaseMap(name) {
    if (!window.L || !map) return;
    var baseLayers = createBaseMapLayers();
    var nextLayer = baseLayers[name] || baseLayers["Esri Satellite"] || baseLayers.OpenStreetMap;
    if (!nextLayer) return;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = nextLayer;
    state.activeBaseMap = name;
    baseLayer.addTo(map);
  }

  function bindLayerPickerEvents() {
    var toggle = document.getElementById("smartalign-map-layer-toggle");
    var picker = root.querySelector(".smartalign-map-layer-picker");
    var orthoPicker = root.querySelector(".smartalign-orthophoto-picker");
    var opacityPicker = root.querySelector(".smartalign-preview-opacity-picker");
    if (toggle && picker) {
      toggle.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (orthoPicker) orthoPicker.classList.remove("open");
        if (opacityPicker) opacityPicker.classList.remove("open");
        picker.classList.toggle("open");
      });
    }

    Array.prototype.forEach.call(root.querySelectorAll(".smartalign-map-layer-option"), function (button) {
      button.addEventListener("click", function () {
        setBaseMap(button.getAttribute("data-layer-name"));
        if (picker) picker.classList.remove("open");
        render();
      });
    });

    var orthoToggle = document.getElementById("smartalign-orthophoto-toggle");
    if (orthoToggle && orthoPicker) {
      orthoToggle.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (picker) picker.classList.remove("open");
        if (opacityPicker) opacityPicker.classList.remove("open");
        orthoPicker.classList.toggle("open");
      });
    }

    bindOrthophotoMenuEvents();
  }

  function bindOrthophotoMenuEvents() {
    var orthoPicker = root.querySelector(".smartalign-orthophoto-picker");
    Array.prototype.forEach.call(root.querySelectorAll(".smartalign-orthophoto-option"), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (button.getAttribute("data-orthophoto-action") === "off") {
          state.activeOrthophoto = null;
          syncOrthophotoLayer();
          if (orthoPicker) orthoPicker.classList.remove("open");
          updateOrthophotoMenuDom();
          return;
        }
        var id = button.getAttribute("data-orthophoto-id");
        var item = state.orthophotos.find(function (candidate) {
          return String(candidate.id) === String(id);
        });
        if (item) {
          state.activeOrthophoto = item;
          syncOrthophotoLayer();
        }
        if (orthoPicker) orthoPicker.classList.remove("open");
        updateOrthophotoMenuDom();
      });
    });
  }

  function ensureLeafletThenSyncMap() {
    if (window.L) {
      syncMap();
      return;
    }
    if (leafletLoading) return;
    leafletLoading = true;

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);

    var script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = function () {
      leafletLoading = false;
      syncMap();
    };
    script.onerror = function () {
      leafletLoading = false;
      var mapNode = document.getElementById("smartalign-map");
      if (mapNode) mapNode.innerHTML = '<div class="smartalign-empty">Leaflet не завантажився. Перевірте інтернет або локальні assets.</div>';
    };
    document.head.appendChild(script);
  }

  function initialMapViewFromOrthophoto() {
    if (state.mapInitialFitDone) return state.mapView;
    var bounds = state.info && state.info.orthophoto && state.info.orthophoto.bounds_wgs84;
    if (bounds && bounds.length === 4) {
      var lat = (Number(bounds[1]) + Number(bounds[3])) / 2;
      var lng = (Number(bounds[0]) + Number(bounds[2])) / 2;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat: lat, lng: lng, zoom: 16, bounds: bounds };
      }
    }
    return state.mapView;
  }

  function syncMap() {
    if (!window.L || !document.getElementById("smartalign-map")) return;
    if (map) {
      map.remove();
      map = null;
      baseLayer = null;
      alignedOverlay = null;
      orthophotoLayer = null;
      mapMarkers = [];
    }

    var initial = initialMapViewFromOrthophoto();
    state.mapView = { lat: initial.lat, lng: initial.lng, zoom: initial.zoom || state.mapView.zoom };

    map = L.map("smartalign-map", {
      zoomControl: true,
      attributionControl: true
    }).setView([state.mapView.lat, state.mapView.lng], state.mapView.zoom);

    setBaseMap(state.activeBaseMap);

    if (initial.bounds) {
      map.fitBounds([[initial.bounds[1], initial.bounds[0]], [initial.bounds[3], initial.bounds[2]]], { padding: [20, 20] });
      var fittedCenter = map.getCenter();
      state.mapView = { lat: fittedCenter.lat, lng: fittedCenter.lng, zoom: map.getZoom() };
    }
    state.mapInitialFitDone = true;

    map.on("click", function (event) {
      if (state.mode === "3d") {
        var point3d = ensure3dPoint(state.activePoint);
        point3d.world = {
          lat: Math.round(event.latlng.lat * 100000000) / 100000000,
          lng: Math.round(event.latlng.lng * 100000000) / 100000000,
          height: Number(point3d.height || 0)
        };
        render();
        return;
      }
      var point = ensurePoint(state.activePoint);
      point.reference = {
        lat: Math.round(event.latlng.lat * 100000000) / 100000000,
        lng: Math.round(event.latlng.lng * 100000000) / 100000000
      };
      pointsChanged();
      render();
    });

    map.on("moveend", function () {
      var center = map.getCenter();
      state.mapView = { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
      if (state.mode !== "3d") loadOrthophotosForCurrentBounds();
    });

    syncAlignedOverlay();
    syncOrthophotoLayer();
    drawMapMarkers();
    if (state.mode !== "3d") loadOrthophotosForCurrentBounds();
    setTimeout(function () {
      if (map) map.invalidateSize();
    }, 80);
  }

  function syncAlignedOverlay() {
    if (!map || !window.L) return;
    if (alignedOverlay) {
      map.removeLayer(alignedOverlay);
      alignedOverlay = null;
    }
    if (state.mode === "3d") return;
    if (!state.previewVisible || Number(state.previewOpacity || 0) <= 0) return;

    var alignment = state.info && state.info.alignment;
    var preview = alignment && alignment.aligned_preview;
    var bounds = preview && preview.bounds_wgs84;
    var url = preview && preview.url;
    if (!url || !bounds || bounds.length !== 4) return;

    alignedOverlay = L.imageOverlay(url + (url.indexOf("?") === -1 ? "?v=" : "&v=") + encodeURIComponent(preview.created_at || alignment.created_at || Date.now()), [
      [bounds[1], bounds[0]],
      [bounds[3], bounds[2]]
    ], {
      opacity: Math.max(0, Math.min(1, Number(state.previewOpacity || 0) / 100)),
      interactive: false,
      zIndex: 350
    }).addTo(map);
  }

  function mapBboxParam() {
    if (!map) return "";
    var bounds = map.getBounds();
    if (!bounds) return "";
    return [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
    ].join(",");
  }

  function syncOrthophotoLayer() {
    if (!map || !window.L) return;
    if (orthophotoLayer) {
      map.removeLayer(orthophotoLayer);
      orthophotoLayer = null;
    }
    if (state.mode === "3d") return;
    if (!state.activeOrthophoto || !state.activeOrthophoto.tile_url) return;
    var options = {
      opacity: 0.9,
      maxZoom: 28,
      zIndex: 300
    };
    if (state.activeOrthophoto.bounds && state.activeOrthophoto.bounds.length === 4) {
      options.bounds = [
        [state.activeOrthophoto.bounds[1], state.activeOrthophoto.bounds[0]],
        [state.activeOrthophoto.bounds[3], state.activeOrthophoto.bounds[2]]
      ];
    }
    orthophotoLayer = L.tileLayer(state.activeOrthophoto.tile_url, options).addTo(map);
  }

  function updateOrthophotoMenuDom() {
    var menu = root.querySelector(".smartalign-orthophoto-menu");
    if (!menu) return;
    menu.innerHTML = renderOrthophotoMenu(state.info && state.info.alignment);
    bindOrthophotoMenuEvents();
  }

  function loadOrthophotosForCurrentBounds() {
    var bbox = mapBboxParam();
    if (!bbox) return;
    state.orthophotosLoading = true;
    updateOrthophotoMenuDom();
    requestJson(api("orthophotos/?bbox=" + encodeURIComponent(bbox)))
      .then(function (json) {
        state.orthophotos = json.orthophotos || [];
        state.orthophotosLoading = false;
        updateOrthophotoMenuDom();
      })
      .catch(function () {
        state.orthophotos = [];
        state.orthophotosLoading = false;
        updateOrthophotoMenuDom();
      });
  }

  function drawMapMarkers() {
    if (!map || !window.L) return;
    mapMarkers.forEach(function (marker) { map.removeLayer(marker); });
    mapMarkers = [];

    var sourcePoints = state.mode === "3d" ? state.points3d : state.points;
    sourcePoints.forEach(function (point, index) {
      var reference = state.mode === "3d" ? point.world : point.reference;
      if (!reference || reference.lat == null || reference.lng == null) return;
      var marker = L.marker([reference.lat, reference.lng], {
        draggable: true,
        icon: L.divIcon({
          className: "smartalign-map-marker-wrap",
          html: '<span class="smartalign-map-marker' + (index === state.activePoint ? " active" : "") + '"><span class="smartalign-pin-label">' + (index + 1) + '</span></span>',
          iconSize: [24, 24],
          iconAnchor: [12, 24]
        })
      }).addTo(map);

      marker.on("click", function () {
        state.activePoint = index;
        render();
      });
      marker.on("dragend", function () {
        var latLng = marker.getLatLng();
        var nextReference = {
          lat: Math.round(latLng.lat * 100000000) / 100000000,
          lng: Math.round(latLng.lng * 100000000) / 100000000
        };
        if (state.mode === "3d") {
          nextReference.height = Number(point.height || 0);
          point.world = nextReference;
        } else {
          point.reference = nextReference;
          pointsChanged();
        }
        render();
      });

      mapMarkers.push(marker);
    });
  }

  function loadInfo() {
    render();
    fetch(api(""), { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) {
          return responseError(response, "Не вдалося завантажити задачу.");
        }
        return response.json();
      })
      .then(function (json) {
        state.info = json;
        if (json.alignment && Array.isArray(json.alignment.points)) {
          state.points = json.alignment.points.map(function (point) {
            return {
              ortho: point && point.ortho ? point.ortho : null,
              reference: point && point.reference ? point.reference : null
            };
          });
          state.activePoint = Math.max(0, state.points.length - 1);
        }
        if (json.alignment_3d && json.alignment_3d.placement) {
          state.placement3d = normalize3dPlacement(json.alignment_3d.placement);
        }
        var initial = initialMapViewFromOrthophoto();
        state.mapView = { lat: initial.lat, lng: initial.lng, zoom: initial.zoom || 16 };
        render();
      })
      .catch(function (error) {
        root.innerHTML = '<div class="alert alert-danger">' + escapeHtml(error.message || String(error)) + '</div>';
      });
  }

  loadInfo();
})();



