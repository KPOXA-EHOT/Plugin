(function () {
  var root = document.getElementById("smartalign-cesium-root");
  if (!root) return;

  try { window.localStorage.setItem("soft_tools_sidebar_hidden", "1"); } catch (_) {}
  if (document.body) document.body.classList.add("soft-tools-sidebar-hidden");

  var projectId = root.getAttribute("data-project-id");
  var taskId = root.getAttribute("data-task-id");
  var alignUrl = root.getAttribute("data-align-url") || "";

  function api(path) {
    return "/plugins/Smartpoint/api/project/" + encodeURIComponent(projectId) + "/task/" + encodeURIComponent(taskId) + "/" + path;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function requestJson(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== "") {
      document.cookie.split(";").forEach(function (cookie) {
        var item = cookie.trim();
        if (item.substring(0, name.length + 1) === (name + "=")) {
          cookieValue = decodeURIComponent(item.substring(name.length + 1));
        }
      });
    }
    return cookieValue;
  }

  function postJson(path, payload) {
    return fetch(api(path), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCookie("csrftoken") || ""
      },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(text || "Request failed");
        });
      }
      return response.json();
    });
  }

  function statusText(status) {
    if (!status || !status.available) {
      return status && status.reason ? status.reason : "3D Tiles ще не готові.";
    }
    var reference = status.reference || {};
    var parts = ["3D Tiles готові"];
    if (reference.latitude != null && reference.longitude != null) {
      parts.push("lat " + Number(reference.latitude).toFixed(7));
      parts.push("lon " + Number(reference.longitude).toFixed(7));
    }
    if (reference.altitude != null) parts.push("alt " + Number(reference.altitude).toFixed(2) + " м");
    return parts.join(" · ");
  }

  function renderShell() {
    root.innerHTML =
      '<div class="smartalign-cesium-shell">' +
        '<div id="smartalign-cesium-viewer" class="smartalign-cesium-viewer"></div>' +
        '<div class="smartalign-cesium-panel">' +
          '<div id="smartalign-cesium-status" class="smartalign-cesium-status">Завантаження Cesium...</div>' +
          '<div class="smartalign-cesium-panel-row">' +
            '<button id="smartalign-cesium-back" type="button" class="btn btn-default btn-sm"><i class="fa fa-arrow-left"></i> Назад</button>' +
            '<button id="smartalign-cesium-regenerate" type="button" class="btn btn-default btn-sm"><i class="fa fa-refresh"></i> Оновити 3D Tiles</button>' +
          '</div>' +
          '<div class="smartalign-cesium-panel-row">' +
            '<label for="smartalign-cesium-height">Висота над землею</label>' +
            '<input id="smartalign-cesium-height" type="number" step="0.1" value="1">' +
            '<button id="smartalign-cesium-save-height" type="button" class="btn btn-warning btn-sm">Зберегти висоту</button>' +
          '</div>' +
          '<div class="smartalign-cesium-panel-row">' +
            '<button type="button" class="btn btn-default btn-xs" data-height-nudge="-5">-5 м</button>' +
            '<button type="button" class="btn btn-default btn-xs" data-height-nudge="-1">-1 м</button>' +
            '<button type="button" class="btn btn-default btn-xs" data-height-nudge="1">+1 м</button>' +
            '<button type="button" class="btn btn-default btn-xs" data-height-nudge="5">+5 м</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function setStatus(message, isError) {
    var node = document.getElementById("smartalign-cesium-status");
    if (!node) return;
    node.className = "smartalign-cesium-status" + (isError ? " smartalign-cesium-error" : "");
    node.innerHTML = escapeHtml(message);
  }

  function createBaseLayer() {
    return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      credit: "Tiles © Esri"
    }));
  }

  async function createViewer() {
    if (!window.Cesium) throw new Error("Cesium library не завантажилась");
    var terrainProvider = new Cesium.EllipsoidTerrainProvider();
    var esriTerrainUrl = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
    if (Cesium.ArcGISTiledElevationTerrainProvider && Cesium.ArcGISTiledElevationTerrainProvider.fromUrl) {
      try {
        terrainProvider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(esriTerrainUrl);
      } catch (e) {
        setStatus("Esri World Elevation terrain не завантажився: " + (e.message || e), true);
      }
    }
    if (terrainProvider instanceof Cesium.EllipsoidTerrainProvider && Cesium.ArcGISTiledElevationTerrainProvider && !Cesium.ArcGISTiledElevationTerrainProvider.fromUrl) {
      terrainProvider = new Cesium.ArcGISTiledElevationTerrainProvider({ url: esriTerrainUrl });
    }
    if (terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
      setStatus("Esri World Elevation terrain недоступний.", true);
    }

    var viewer = new Cesium.Viewer("smartalign-cesium-viewer", {
      terrainProvider: terrainProvider,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      baseLayer: createBaseLayer(),
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      fullscreenButton: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false
    });
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.screenSpaceCameraController.zoomEventTypes = [
      Cesium.CameraEventType.MIDDLE_DRAG,
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH
    ];
    viewer.scene.screenSpaceCameraController.tiltEventTypes = [
      Cesium.CameraEventType.RIGHT_DRAG,
      Cesium.CameraEventType.PINCH
    ];
    return viewer;
  }

  function heightValue() {
    var input = document.getElementById("smartalign-cesium-height");
    var value = input ? Number(input.value) : 1;
    return Number.isFinite(value) ? value : 1;
  }

  function verticalTranslation(reference, deltaMeters) {
    if (!window.Cesium || !reference || reference.latitude == null || reference.longitude == null || !Number.isFinite(deltaMeters)) {
      return Cesium.Matrix4.IDENTITY;
    }
    var origin = Cesium.Cartesian3.fromDegrees(Number(reference.longitude), Number(reference.latitude), Number(reference.altitude || 0));
    var up = Cesium.Cartesian3.normalize(origin, new Cesium.Cartesian3());
    var translation = Cesium.Cartesian3.multiplyByScalar(up, deltaMeters, new Cesium.Cartesian3());
    return Cesium.Matrix4.fromTranslation(translation);
  }

  function applyHeightOffset(tileset, status) {
    if (!tileset || !status) return;
    var baseHeight = Number(status.height_offset_m || 0);
    var currentHeight = heightValue();
    tileset.modelMatrix = verticalTranslation(status.reference || {}, currentHeight - baseHeight);
  }

  function setGenerating(isGenerating) {
    var button = document.getElementById("smartalign-cesium-regenerate");
    if (button) button.disabled = !!isGenerating;
  }

  async function loadTileset(viewer, status) {
    if (!status.available || !status.tileset_url) {
      setStatus(statusText(status), !status.generating);
      return null;
    }
    var tileset;
    if (Cesium.Cesium3DTileset.fromUrl) {
      tileset = await Cesium.Cesium3DTileset.fromUrl(status.tileset_url);
    } else {
      tileset = new Cesium.Cesium3DTileset({ url: status.tileset_url });
    }
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;
    applyHeightOffset(tileset, status);
    await viewer.zoomTo(tileset);
    setStatus(statusText(status), false);
    return tileset;
  }

  async function boot() {
    renderShell();
    var viewer = null;
    var tileset = null;
    var currentStatus = null;
    var pollTimer = null;

    async function refreshStatus() {
      currentStatus = await requestJson(api("cesium-3d/"));
      setGenerating(!!currentStatus.generating);
      if (currentStatus.available && !tileset) {
        tileset = await loadTileset(viewer, currentStatus);
      } else {
        setStatus(statusText(currentStatus), !currentStatus.available && !currentStatus.generating);
      }
      if (currentStatus.generating && !pollTimer) {
        pollTimer = window.setTimeout(function () {
          pollTimer = null;
          refreshStatus().catch(function (error) {
            setGenerating(false);
            setStatus(error.message || String(error), true);
          });
        }, 5000);
      }
    }

    document.getElementById("smartalign-cesium-back").addEventListener("click", function () {
      if (alignUrl) window.location.href = alignUrl;
      else window.history.back();
    });

    document.getElementById("smartalign-cesium-regenerate").addEventListener("click", function () {
      setStatus("Оновлюю Cesium preview з поточною висотою...", false);
      setGenerating(true);
      postJson("cesium-3d/preview/", { force: true }).then(function (json) {
        if (tileset && viewer) {
          try { viewer.scene.primitives.remove(tileset); } catch (_) {}
          tileset = null;
        }
        currentStatus = json.cesium || currentStatus;
        return refreshStatus();
      }).catch(function (error) {
        setStatus(error.message || String(error), true);
      }).finally(function () {
        setGenerating(!!(currentStatus && currentStatus.generating));
      });
    });

    document.getElementById("smartalign-cesium-save-height").addEventListener("click", function () {
      var value = heightValue();
      setStatus("Зберігаю висоту " + value.toFixed(2) + " м...", false);
      postJson("cesium-3d/height/", { height_offset_m: value }).then(function (json) {
        currentStatus = json.cesium || currentStatus;
        setStatus(statusText(currentStatus), false);
        return refreshStatus();
      }).catch(function (error) {
        setStatus(error.message || String(error), true);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-height-nudge]"), function (button) {
      button.addEventListener("click", function () {
        var input = document.getElementById("smartalign-cesium-height");
        var next = heightValue() + Number(button.getAttribute("data-height-nudge") || 0);
        input.value = String(Math.round(next * 10) / 10);
        applyHeightOffset(tileset, currentStatus);
      });
    });

    document.getElementById("smartalign-cesium-height").addEventListener("input", function () {
      applyHeightOffset(tileset, currentStatus);
    });

    try {
      currentStatus = await requestJson(api("cesium-3d/"));
      document.getElementById("smartalign-cesium-height").value = String(currentStatus.height_offset_m == null ? 1 : currentStatus.height_offset_m);
      viewer = await createViewer();
      tileset = await loadTileset(viewer, currentStatus);
      if (currentStatus.generating) {
        setGenerating(true);
        refreshStatus();
      }
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  boot();
})();
