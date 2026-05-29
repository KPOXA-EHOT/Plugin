
(function () {
  var root = document.getElementById("smartpoint-mosaic-page-root");
  if (!root) return;

  var map = null;
  var baseLayer = null;
  var layers = [];
  var state = {
    items: [],
    selected: {},
    order: [],
    loading: false,
    status: "Наведіть карту на потрібний район і натисніть “Оновити пошук”."
  };

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
          if (/^\s*</.test(text || "")) throw new Error("Endpoint не знайдено або WebODM повернув HTML. Перезапустіть WebODM і Force Reload.");
          throw new Error(text || "Request failed");
        });
      }
      return response.json();
    });
  }

  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      var script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = resolve;
      script.onerror = function () { reject(new Error("Не вдалося завантажити Leaflet.")); };
      document.head.appendChild(script);
    });
  }

  function baseMapLayer() {
    return window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22,
      attribution: "&copy; OpenStreetMap"
    });
  }

  function initMap() {
    var el = document.getElementById("smartpoint-mosaic-map");
    if (!el || map || !window.L) return;
    map = window.L.map(el, { center: [48.7, 31.2], zoom: 6 });
    baseLayer = baseMapLayer().addTo(map);
    map.on("moveend", function () { updateStatus("Карта змінена. Натисніть “Оновити пошук”."); });
    setTimeout(function () { map.invalidateSize(); }, 100);
  }

  function bbox() {
    var b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
  }

  function updateStatus(text) {
    state.status = text;
    renderListOnly();
  }

  function loadAreaOrthophotos() {
    if (!map) return;
    state.loading = true;
    state.status = "Пошук ортофото в районі карти...";
    render();
    requestJson("/plugins/Smartpoint/api/mosaic/orthophotos/?bbox=" + encodeURIComponent(bbox()))
      .then(function (json) {
        var items = json.orthophotos || json.tasks || [];
        state.items = items;
        state.selected = {};
        state.order = [];
        items.forEach(function (item) {
          state.selected[item.id] = true;
          state.order.push(item.id);
        });
        state.status = items.length ? "Знайдено ортофото: " + items.length : "У цьому районі ортофото не знайдено.";
        state.loading = false;
        render();
        refreshMapLayers();
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

  function move(id, direction) {
    var idx = state.order.indexOf(id);
    if (idx < 0) return;
    var next = idx + direction;
    if (next < 0 || next >= state.order.length) return;
    var tmp = state.order[idx];
    state.order[idx] = state.order[next];
    state.order[next] = tmp;
    render();
    refreshMapLayers();
  }

  function toggle(id) {
    state.selected[id] = !state.selected[id];
    render();
    refreshMapLayers();
  }

  function refreshMapLayers() {
    if (!map || !window.L) return;
    layers.forEach(function (layer) { try { map.removeLayer(layer); } catch (_) {} });
    layers = [];
    var visible = orderedItems().filter(function (item) { return state.selected[item.id]; });
    visible.forEach(function (item) {
      if (item.tile_url) {
        var layer = window.L.tileLayer(item.tile_url, { maxZoom: 22, opacity: 0.75 });
        layer.addTo(map);
        layers.push(layer);
      }
      if (item.bounds && item.bounds.length === 4) {
        var b = [[item.bounds[1], item.bounds[0]], [item.bounds[3], item.bounds[2]]];
        var rect = window.L.rectangle(b, { weight: 1, fill: false });
        rect.addTo(map);
        layers.push(rect);
      }
    });
    if (visible.length && visible[0].bounds && visible[0].bounds.length === 4) {
      try {
        var group = window.L.featureGroup(layers.filter(function (l) { return l.getBounds; }));
        if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [20, 20] });
      } catch (_) {}
    }
  }

  function createMosaic() {
    var selected = orderedItems().filter(function (item) { return state.selected[item.id]; });
    if (selected.length < 2) {
      updateStatus("Оберіть мінімум 2 ортофото.");
      return;
    }
    updateStatus("Створення об’єднаного ортофото...");
    requestJson("/plugins/Smartpoint/api/mosaic/create/", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ layers: selected.map(function (item) { return { task_id: item.id }; }) })
    }).then(function (json) {
      if (json.url) {
        state.status = "Готово.\n" + json.url;
      } else {
        state.status = json.message || "Запит виконано.";
      }
      render();
    }).catch(function (error) {
      state.status = error.message || String(error);
      render();
    });
  }

  function renderListOnly() {
    var status = document.getElementById("smartpoint-mosaic-status");
    if (status) status.textContent = state.status || "";
  }

  function render() {
    root.innerHTML = '' +
      '<div class="smartpoint-mosaic-page">' +
        '<div class="smartpoint-mosaic-topbar">' +
          '<div><h3>Об’єднання ортофото</h3><div class="soft-tools-muted">Карта + список ортофото в районі карти</div></div>' +
          '<div><button type="button" class="btn btn-default" id="smartpoint-mosaic-back">Назад</button></div>' +
        '</div>' +
        '<div class="smartpoint-mosaic-workspace">' +
          '<div class="smartpoint-mosaic-map" id="smartpoint-mosaic-map"></div>' +
          '<aside class="smartpoint-mosaic-side">' +
            '<div class="smartpoint-mosaic-side-head">' +
              '<h4>Ортофото в районі</h4>' +
              '<button type="button" class="btn btn-default btn-sm" id="smartpoint-mosaic-refresh"><i class="fa fa-refresh"></i> Оновити пошук</button>' +
            '</div>' +
            '<div class="smartpoint-mosaic-list">' + renderItems() + '</div>' +
            '<div class="smartpoint-mosaic-footer">' +
              '<button type="button" class="btn btn-primary btn-block" id="smartpoint-mosaic-create">Створити об’єднане ортофото</button>' +
              '<div class="smartpoint-mosaic-status" id="smartpoint-mosaic-status">' + escapeHtml(state.status) + '</div>' +
            '</div>' +
          '</aside>' +
        '</div>' +
      '</div>';

    document.getElementById("smartpoint-mosaic-back").onclick = function () { window.history.back(); };
    document.getElementById("smartpoint-mosaic-refresh").onclick = loadAreaOrthophotos;
    document.getElementById("smartpoint-mosaic-create").onclick = createMosaic;
    Array.prototype.forEach.call(root.querySelectorAll("[data-toggle-layer]"), function (el) {
      el.onchange = function () { toggle(this.getAttribute("data-toggle-layer")); };
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-move-up]"), function (el) {
      el.onclick = function () { move(this.getAttribute("data-move-up"), -1); };
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-move-down]"), function (el) {
      el.onclick = function () { move(this.getAttribute("data-move-down"), 1); };
    });
    initMap();
    refreshMapLayers();
  }

  function renderItems() {
    if (state.loading) return '<div class="soft-tools-muted">Завантаження...</div>';
    if (!state.items.length) return '<div class="soft-tools-muted">Немає знайдених ортофото.</div>';
    return orderedItems().map(function (item, index) {
      var active = state.selected[item.id];
      return '' +
        '<div class="smartpoint-mosaic-item' + (active ? ' active' : '') + '">' +
          '<label><input type="checkbox" data-toggle-layer="' + escapeHtml(item.id) + '" ' + (active ? 'checked' : '') + '> ' +
            '<span class="smartpoint-mosaic-item-title">' + escapeHtml(item.task_name || item.id) + '</span>' +
          '</label>' +
          '<div class="smartpoint-mosaic-item-meta">' + escapeHtml(item.project_name || '') + '</div>' +
          '<div class="smartpoint-mosaic-item-meta">' + (index + 1) + '. Верхній шар вище в списку</div>' +
          '<div class="smartpoint-mosaic-item-actions">' +
            '<button type="button" class="btn btn-default btn-xs" data-move-up="' + escapeHtml(item.id) + '">↑</button>' +
            '<button type="button" class="btn btn-default btn-xs" data-move-down="' + escapeHtml(item.id) + '">↓</button>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  ensureLeaflet().then(function () {
    render();
    loadAreaOrthophotos();
  }).catch(function (error) {
    state.status = error.message || String(error);
    render();
  });
})();
