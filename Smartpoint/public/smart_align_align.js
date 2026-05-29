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
  var threeModel = null;
  var threeRaycaster = null;
  var threePointer = null;
  var threeAnimation = null;
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
    if (window.THREE && window.THREE.OBJLoader && window.THREE.OrbitControls) {
      return Promise.resolve();
    }
    if (threeLoading) {
      return new Promise(function (resolve, reject) {
        var started = Date.now();
        function wait() {
          if (window.THREE && window.THREE.OBJLoader && window.THREE.OrbitControls) resolve();
          else if (Date.now() - started > 15000) reject(new Error("3D viewer не завантажився"));
          else window.setTimeout(wait, 100);
        }
        wait();
      });
    }
    threeLoading = true;
    return loadScriptOnce("https://unpkg.com/three@0.128.0/build/three.min.js")
      .then(function () { return loadScriptOnce("https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js"); })
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

  function render3dViewerPanel() {
    var threeD = state.info && state.info.three_d || {};
    var viewer = threeD.viewer || {};
    var active = ensure3dPoint(state.activePoint);
    var mesh = active.mesh;
    var status = mesh
      ? "Mesh XYZ: " + [mesh.x, mesh.y, mesh.z].map(function (value) { return formatNumber(value, 3); }).join(", ")
      : "Клікніть по 3D моделі для mesh XYZ";
    return '' +
      '<section class="smartalign-panel">' +
        '<div class="smartalign-panel-head">' +
          '<div>' + render3dPointCounter() + '</div>' +
          '<div class="smartalign-panel-actions">' +
            '<button type="button" class="btn btn-default smartalign-icon-button smartalign-3d-add-point" title="Додати 3D точку"><i class="fa fa-plus"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="smartalign-3d-stage">' +
          '<div id="smartalign-3d-viewer" class="smartalign-3d-viewer" data-obj-url="' + escapeHtml(viewer.obj_url || "") + '"></div>' +
          '<div class="smartalign-3d-status">' + escapeHtml(state.threeError || status) + '</div>' +
        '</div>' +
      '</section>';
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

  function render3dMapPanel() {
    var alignment = state.info && state.info.alignment_3d;
    var resultStatus = alignment && alignment.method === "manual_similarity_3d"
      ? '<div class="smartalign-map-status">3D RMS: ' + escapeHtml(formatNumber(alignment.rms_error_m || alignment.rmse, 3)) + ' м</div>'
      : '<div class="smartalign-map-status">Клікніть ту саму точку на карті</div>';
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
        render3dPointTable() +
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
      root.innerHTML = '' +
        '<div class="smartalign-app">' +
          '<div class="smartalign-topbar">' +
            '<button type="button" class="btn btn-default smartalign-back" id="smartalign-back-ortho"><i class="fa fa-arrow-left"></i> Ортофото</button>' +
            '<div class="smartalign-toolbar">' +
              '<button type="button" class="btn btn-default" id="smartalign-3d-add-point"><i class="fa fa-plus"></i> Точка</button>' +
              '<button type="button" class="btn btn-primary" id="smartalign-3d-calculate" ' + (valid3dPairs().length >= 3 && !state.aligning3d ? "" : "disabled") + '><i class="fa fa-cube"></i> ' + (state.aligning3d ? "Розрахунок 3D..." : "Розрахувати 3D") + '</button>' +
              render3dAction() +
            '</div>' +
          '</div>' +
          '<div class="smartalign-workspace smartalign-workspace-3d">' +
            render3dViewerPanel() +
            render3dMapPanel() +
          '</div>' +
        '</div>';
      bindEvents();
      ensureLeafletThenSyncMap();
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
    threeScene = null;
    threeCamera = null;
    threeRenderer = null;
    threeControls = null;
    threeModel = null;
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
      .then(function () { init3dViewer(container, objUrl); })
      .catch(function (error) {
        state.threeError = error.message || String(error);
        render();
      });
  }

  function init3dViewer(container, objUrl) {
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

    var loader = new THREE.OBJLoader();
    loader.load(objUrl, function (object) {
      threeModel = object;
      object.traverse(function (child) {
        if (child.isMesh) {
          child.material = new THREE.MeshLambertMaterial({ color: 0xd8dde2, side: THREE.DoubleSide });
          child.geometry.computeBoundingBox();
          child.geometry.computeBoundingSphere();
        }
      });
      threeScene.add(object);
      fitCameraToObject(object);
    }, undefined, function (error) {
      state.threeError = "Не вдалося завантажити OBJ: " + (error && error.message ? error.message : "");
      render();
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

  function pick3dPoint(event, canvas) {
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
    if (!state.points3d.length) seed3dPointsFromOrtho();
    state.activePoint = Math.max(0, Math.min(state.activePoint, state.points3d.length - 1));
    render();
  }

  function calculate3dAlignment() {
    var pairs = valid3dPairs();
    if (pairs.length < 3) return;
    state.aligning3d = true;
    render();
    postJson("align-3d/", { points: pairs })
      .then(function (json) {
        state.info.alignment_3d = json.alignment_3d;
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
      loadOrthophotosForCurrentBounds();
    });

    syncAlignedOverlay();
    syncOrthophotoLayer();
    drawMapMarkers();
    loadOrthophotosForCurrentBounds();
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



