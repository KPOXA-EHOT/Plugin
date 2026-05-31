(function () {
  var root = document.getElementById("smartpoint-mosaic-page-root");
  if (!root) return;

  var map = null;
  var baseLayer = null;
  var baseMaps = {};
  var layers = [];
  var firstFitDone = false;
  var activeBaseMap = "Esri Satellite";
  var BASE_MAP_NAMES = [
    "Esri Satellite", "Esri Streets", "Esri Topo", "OpenStreetMap", "OpenStreetMap HOT",
    "OpenStreetMap DE", "Topo", "Light", "Dark", "Voyager"
  ];

  var state = {
    items: [],
    selected: {},
    order: [],
    opacity: {},
    loading: false,
    status: "Завантаження всіх ортофото...",
    creating: false,
    created: false
  };

  function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== "") {
      document.cookie.split(";").forEach(function (cookie) {
        cookie = cookie.trim();
        if (cookie.substring(0, name.length + 1) === (name + "=")) {
          cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
        }
      });
    }
    return cookieValue;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>\"']/g, function (c) {
      return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
    });
  }

  function requestJson(url, options) {
    options = options || {};
    options.credentials = "same-origin";
    options.headers = Object.assign({"X-CSRFToken": getCookie("csrftoken") || ""}, options.headers || {});
    return fetch(url, options).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          if (/^\s*</.test(text || "")) throw new Error("Endpoint не знайдено або WebODM повернув HTML. Перезапустіть WebODM і натисніть Ctrl+F5.");
          throw new Error(text || "Request failed");
        });
      }
      return response.json();
    });
  }

  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      if (!document.querySelector('link[href*="leaflet.css"]')) {
        var css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(css);
      }
      var script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Не вдалося завантажити Leaflet.")); };
      document.head.appendChild(script);
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
    return window.L.tileLayer(url, tileOptions);
  }

  function createBaseMapLayers() {
    return {
      "Esri Satellite": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles &copy; Esri", maxZoom: 19 }),
      "Esri Streets": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles &copy; Esri", maxZoom: 17 }),
      "Esri Topo": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles &copy; Esri", maxZoom: 17 }),
      "OpenStreetMap": createBaseTileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
      "OpenStreetMap HOT": createBaseTileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors, HOT", maxZoom: 19 }),
      "OpenStreetMap DE": createBaseTileLayer("https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
      "Topo": createBaseTileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenTopoMap contributors", maxZoom: 17 }),
      "Light": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 20, subdomains: "abcd" }),
      "Dark": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 20, subdomains: "abcd" }),
      "Voyager": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 20, subdomains: "abcd" })
    };
  }

  function updateStatus(text) {
    state.status = text;
    renderListOnly();
  }

  function forceMapResize() {
    [50, 200, 600, 1200].forEach(function (delay) {
      window.setTimeout(function () { if (map) map.invalidateSize(true); }, delay);
    });
  }

  function setBaseMap(name) {
    if (!window.L || !map) return;
    baseMaps = createBaseMapLayers();
    var nextLayer = baseMaps[name] || baseMaps.OpenStreetMap || baseMaps["Esri Satellite"];
    if (!nextLayer) return;
    if (baseLayer) {
      try { map.removeLayer(baseLayer); } catch (_) {}
    }
    baseLayer = nextLayer;
    activeBaseMap = name;
    baseLayer.on("tileerror", function () {
      updateStatus("Не вдалося завантажити базову карту: " + activeBaseMap + ". Спробуйте OpenStreetMap.");
    });
    baseLayer.addTo(map);
    forceMapResize();
  }

  function clearOverlayLayers() {
    layers.forEach(function (layer) { try { map.removeLayer(layer); } catch (_) {} });
    layers = [];
  }

  function initMap() {
    var el = document.getElementById("smartpoint-mosaic-map");
    if (!el || !window.L) return;

    if (map && (!map.getContainer || map.getContainer() !== el)) {
      try { map.remove(); } catch (_) {}
      map = null;
      baseLayer = null;
      layers = [];
    }

    if (map) {
      forceMapResize();
      return;
    }

    map = window.L.map(el, { center: [48.7, 31.2], zoom: 6, zoomControl: true, attributionControl: true });
    setBaseMap(activeBaseMap);
    map.on("moveend", function () { renderListOnly(); });
    forceMapResize();
  }

  function bbox() {
    if (!map) return "";
    var b = map.getBounds();
    if (!b) return "";
    var values = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    if (!values.every(Number.isFinite)) return "";
    if (values[0] >= values[2] || values[1] >= values[3]) return "";
    return values.join(",");
  }

  function applyItems(items, autoSelect) {
    state.items = items || [];
    state.selected = {};
    state.order = [];
    state.opacity = {};
    state.items.forEach(function (item) {
      state.selected[item.id] = !!autoSelect;
      state.order.push(item.id);
      state.opacity[item.id] = 75;
    });
  }

  function loadAllOrthophotos() {
    state.loading = true;
    state.status = "Завантаження всіх ортофото...";
    render();
    requestJson("/plugins/Smartpoint/api/mosaic/tasks/")
      .then(function (json) {
        var items = json.tasks || [];
        applyItems(items, false);
        state.status = items.length ? "Доступно ортофото: " + items.length + ". Оберіть 2 або більше." : "Ортофото не знайдено.";
        state.loading = false;
        render();
        refreshMapLayers(false);
        fitToAllItemBounds();
      })
      .catch(function (error) {
        state.loading = false;
        state.status = error.message || String(error);
        render();
      });
  }

  function loadAreaOrthophotos() {
    if (!map) {
      state.status = "Карта ще не готова. Зачекайте секунду і повторіть.";
      render();
      return;
    }
    var currentBbox = bbox();
    if (!currentBbox) {
      state.status = "Карта ще не готова для пошуку по району. Натисніть Ctrl+F5 або зачекайте секунду.";
      render();
      forceMapResize();
      return;
    }
    state.loading = true;
    state.status = "Пошук ортофото в районі карти...";
    render();
    requestJson("/plugins/Smartpoint/api/mosaic/orthophotos/?bbox=" + encodeURIComponent(currentBbox))
      .then(function (json) {
        var items = json.orthophotos || json.tasks || [];
        applyItems(items, false);
        state.status = items.length ? "Знайдено ортофото в районі: " + items.length : "У цьому районі ортофото не знайдено.";
        state.loading = false;
        render();
        refreshMapLayers(false);
      })
      .catch(function (error) {
        state.loading = false;
        state.status = error.message || String(error);
        render();
      });
  }

  function orderedItems() {
    var byId = {};
    state.items.forEach(function (i) { byId[i.id] = i; });
    return state.order.map(function (id) { return byId[id]; }).filter(Boolean);
  }

  function selectedOrderedItems() {
    return orderedItems().filter(function (item) { return state.selected[item.id]; });
  }

  function move(id, direction) {
    if (state.creating || state.created) return;
    var idx = state.order.indexOf(id);
    if (idx < 0) return;
    var next = idx + direction;
    if (next < 0 || next >= state.order.length) return;
    var tmp = state.order[idx];
    state.order[idx] = state.order[next];
    state.order[next] = tmp;
    render();
    refreshMapLayers(false);
  }

  function fitToItem(item) {
    if (!map || !window.L || !item || !item.bounds || item.bounds.length !== 4) return;
    try {
      var bounds = window.L.latLngBounds([[item.bounds[1], item.bounds[0]], [item.bounds[3], item.bounds[2]]]);
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 });
      forceMapResize();
    } catch (_) {}
  }

  function toggle(id) {
    if (state.creating || state.created) return;
    state.selected[id] = !state.selected[id];
    var item = state.items.filter(function (x) { return x.id === id; })[0];
    render();
    refreshMapLayers(false);
    if (item) fitToItem(item);
  }

  function fitToBoundsList(items) {
    if (!map || !window.L || !items.length) return;
    var rects = [];
    items.forEach(function (item) {
      if (item.bounds && item.bounds.length === 4) {
        rects.push(window.L.rectangle([[item.bounds[1], item.bounds[0]], [item.bounds[3], item.bounds[2]]]));
      }
    });
    if (!rects.length) return;
    try {
      var group = window.L.featureGroup(rects);
      map.fitBounds(group.getBounds(), { padding: [25, 25] });
      forceMapResize();
    } catch (_) {}
  }

  function fitToAllItemBounds() {
    fitToBoundsList(state.items.filter(function (item) { return item.bounds && item.bounds.length === 4; }));
  }

  function refreshMapLayers(doFit) {
    if (!map || !window.L) return;
    clearOverlayLayers();
    var visible = selectedOrderedItems();
    visible.forEach(function (item, index) {
      var z = 100 + (visible.length - index);
      if (item.tile_url) {
        var layer = window.L.tileLayer(item.tile_url, {
          maxZoom: 28,
          maxNativeZoom: 22,
          opacity: Number(state.opacity[item.id] || 75) / 100,
          zIndex: z
        });
        layer.on("tileerror", function () { console.warn("Smartpoint mosaic tile missing", item.task_name || item.id); });
        layer.addTo(map);
        layers.push(layer);
      }
      if (item.bounds && item.bounds.length === 4) {
        var rect = window.L.rectangle([[item.bounds[1], item.bounds[0]], [item.bounds[3], item.bounds[2]]], { weight: 1, fill: false, zIndex: z + 100 });
        rect.addTo(map);
        layers.push(rect);
      }
    });
    if (doFit && !firstFitDone && visible.length) {
      firstFitDone = true;
      fitToBoundsList(visible);
    }
    forceMapResize();
  }

  function createMosaic() {
    if (state.creating || state.created) return;
    var selected = selectedOrderedItems();
    if (selected.length < 2) return updateStatus("Оберіть мінімум 2 ортофото.");
    var payload = { layers: selected.map(function (item, index) {
      return { task_id: item.id, project_id: item.project_id, opacity: Number(state.opacity[item.id] || 75), order: index };
    }) };
    state.creating = true;
    state.status = "Створення об’єднаного ортофото... Шарів: " + payload.layers.length;
    render();
    requestJson("/plugins/Smartpoint/api/mosaic/create/", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    }).then(function (json) {
      state.creating = false;
      state.created = true;
      state.status = json.message || "Об’єднане ортофото створено.";
      if (json.task_name) state.status += "\nНова задача: " + json.task_name;
      state.status += "\nКнопку створення заблоковано. Поверніться назад або оновіть сторінку для нового об’єднання.";
      render();
    }).catch(function (error) {
      state.creating = false;
      state.status = "Помилка створення мозаїки: " + (error.message || String(error));
      render();
    });
  }

  function layerPositionLabel(index, total) {
    if (total <= 1) return "Єдиний шар";
    if (index === 0) return "Верхній шар";
    if (index === total - 1) return "Нижній шар";
    return "Середній шар";
  }

  function renderListOnly() {
    var status = document.getElementById("smartpoint-mosaic-status");
    if (status) status.textContent = state.status || "";
  }

  function renderMapPicker() {
    return '<div class="smartpoint-mosaic-map-layer-picker">' +
      '<button id="smartpoint-mosaic-map-layer-toggle" type="button" class="btn btn-default"><i class="fa fa-map"></i> Карта: ' + escapeHtml(activeBaseMap) + '</button>' +
      '<div class="smartpoint-mosaic-map-layer-menu">' + BASE_MAP_NAMES.map(function (name) {
        return '<button type="button" class="smartpoint-mosaic-map-layer-option' + (activeBaseMap === name ? ' active' : '') + '" data-layer-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
      }).join("") + '</div></div>';
  }

  function render() {
    root.innerHTML = '' +
      '<div class="smartpoint-mosaic-page">' +
        '<div class="smartpoint-mosaic-topbar">' +
          '<div class="smartpoint-mosaic-title-row"><button type="button" class="btn btn-default" id="smartpoint-mosaic-back"' + (state.creating ? ' disabled' : '') + '>Назад</button><h3>Об’єднання ортофото</h3></div>' +
          '<div class="smartpoint-mosaic-top-actions">' + renderMapPicker() + '</div>' +
        '</div>' +
        '<div class="smartpoint-mosaic-workspace">' +
          '<div class="smartpoint-mosaic-map" id="smartpoint-mosaic-map"></div>' +
          '<aside class="smartpoint-mosaic-side">' +
            '<div class="smartpoint-mosaic-side-head">' +
              '<h4>Ортофото</h4>' +
              '<button type="button" class="btn btn-default btn-sm" id="smartpoint-mosaic-all"><i class="fa fa-list"></i> Всі ортофото</button> ' +
              '<button type="button" class="btn btn-default btn-sm" id="smartpoint-mosaic-refresh"><i class="fa fa-search"></i> Пошук у районі карти</button>' +
            '</div>' +
            '<div class="smartpoint-mosaic-list">' + renderItems() + '</div>' +
            '<div class="smartpoint-mosaic-footer">' +
              '<button type="button" class="btn btn-primary btn-block" id="smartpoint-mosaic-create"' + ((state.creating || state.created || selectedOrderedItems().length < 2) ? ' disabled' : '') + '>' + (state.creating ? 'Створення...' : 'Створити об’єднане ортофото') + '</button>' +
              '<div class="smartpoint-mosaic-status" id="smartpoint-mosaic-status">' + escapeHtml(state.status) + '</div>' +
            '</div>' +
          '</aside>' +
        '</div>' +
      '</div>';

    document.getElementById("smartpoint-mosaic-back").onclick = function () { if (!state.creating) window.history.back(); };
    document.getElementById("smartpoint-mosaic-all").onclick = function () { if (!state.creating) loadAllOrthophotos(); };
    document.getElementById("smartpoint-mosaic-refresh").onclick = function () { if (!state.creating) loadAreaOrthophotos(); };
    document.getElementById("smartpoint-mosaic-create").onclick = createMosaic;

    var picker = root.querySelector(".smartpoint-mosaic-map-layer-picker");
    var toggleButton = document.getElementById("smartpoint-mosaic-map-layer-toggle");
    if (toggleButton && picker) toggleButton.onclick = function (event) { event.preventDefault(); event.stopPropagation(); picker.classList.toggle("open"); };
    Array.prototype.forEach.call(root.querySelectorAll(".smartpoint-mosaic-map-layer-option"), function (button) {
      button.onclick = function () { setBaseMap(button.getAttribute("data-layer-name")); if (picker) picker.classList.remove("open"); render(); };
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-toggle-layer]"), function (el) { el.onchange = function () { toggle(this.getAttribute("data-toggle-layer")); }; });
    Array.prototype.forEach.call(root.querySelectorAll("[data-move-up]"), function (el) { el.onclick = function () { move(this.getAttribute("data-move-up"), -1); }; });
    Array.prototype.forEach.call(root.querySelectorAll("[data-move-down]"), function (el) { el.onclick = function () { move(this.getAttribute("data-move-down"), 1); }; });
    Array.prototype.forEach.call(root.querySelectorAll("[data-opacity-layer]"), function (el) {
      el.oninput = function () {
        var id = this.getAttribute("data-opacity-layer");
        state.opacity[id] = Number(this.value || 75);
        var label = root.querySelector('[data-opacity-label="' + id + '"]');
        if (label) label.textContent = "Прозорість: " + state.opacity[id] + "%";
        refreshMapLayers(false);
      };
    });
    initMap();
    refreshMapLayers(false);
  }

  function renderItems() {
    if (state.loading) return '<div class="soft-tools-muted">Завантаження...</div>';
    if (!state.items.length) return '<div class="soft-tools-muted">Немає знайдених ортофото.</div>';
    var ordered = orderedItems();
    return ordered.map(function (item, index) {
      var active = !!state.selected[item.id];
      var opacity = Number(state.opacity[item.id] || 75);
      return '' +
        '<div class="smartpoint-mosaic-item' + (active ? ' active' : '') + '">' +
          '<label><input type="checkbox" data-toggle-layer="' + escapeHtml(item.id) + '" ' + (active ? 'checked' : '') + ((state.creating || state.created) ? ' disabled' : '') + '> ' +
            '<span class="smartpoint-mosaic-item-title">' + escapeHtml(item.task_name || item.id) + '</span></label>' +
          '<div class="smartpoint-mosaic-item-meta">' + escapeHtml(item.project_name || '') + '</div>' +
          '<div class="smartpoint-mosaic-item-meta">' + (active ? layerPositionLabel(selectedOrderedItems().indexOf(item), selectedOrderedItems().length) : 'Вимкнений шар') + '</div>' +
          '<div class="smartpoint-mosaic-opacity"><label data-opacity-label="' + escapeHtml(item.id) + '">Прозорість: ' + opacity + '%</label>' +
          '<input type="range" min="0" max="100" step="5" value="' + opacity + '" data-opacity-layer="' + escapeHtml(item.id) + '"' + ((state.creating || state.created) ? ' disabled' : '') + '></div>' +
          '<div class="smartpoint-mosaic-item-actions">' +
            '<button type="button" class="btn btn-default btn-xs" data-move-up="' + escapeHtml(item.id) + '"' + ((state.creating || state.created) ? ' disabled' : '') + '>↑ вище</button>' +
            '<button type="button" class="btn btn-default btn-xs" data-move-down="' + escapeHtml(item.id) + '"' + ((state.creating || state.created) ? ' disabled' : '') + '>↓ нижче</button>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  ensureLeaflet().then(function () {
    render();
    loadAllOrthophotos();
  }).catch(function (error) {
    state.status = error.message || String(error);
    render();
  });
})();