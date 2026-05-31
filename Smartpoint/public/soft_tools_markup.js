(function () {
  var root = document.getElementById("soft-tools-markup-root");
  if (!root) return;

  var sessionId = root.getAttribute("data-session-id");
  var map = null;
  var mapMarkers = [];
  var baseLayer = null;
  var orthophotoLayer = null;
  var orthophotoLayerKey = "";
  var renderedViewMode = null;
  var suppressNextImageClick = false;
  var autoSaveTimer = null;
  var autoSaveRevision = 0;
  var enhancePollTimer = null;
  var pointSearchRunToken = 0;
  var GALLERY_COLUMNS_STORE_KEY = "soft_tools_gallery_columns";
  var GALLERY_SORT_STORE_KEY = "soft_tools_gallery_sort";
  var GALLERY_SORT_DIRECTION_STORE_KEY = "soft_tools_gallery_sort_direction";
  var GALLERY_POINTS_FIRST_STORE_KEY = "soft_tools_gallery_points_first";
  var ENHANCEMENT_MODE_STORE_KEY = "soft_tools_enhancement_mode";
  var POINT_SEARCH_METHOD_STORE_KEY = "soft_tools_point_search_method";
  var POINT_SEARCH_CANDIDATE_LIMIT = 5;
  var BASE_MAP_NAMES = [
    "Esri Satellite",
    "Esri Streets",
    "Esri Topo",
    "Esri Terrain",
    "Esri NatGeo",
    "Esri Light Gray",
    "Esri Dark Gray",
    "OpenStreetMap",
    "OpenStreetMap HOT",
    "OpenStreetMap DE",
    "Topo",
    "Light",
    "Dark",
    "Voyager"
  ];

  function normalizeGalleryColumns(value) {
    var columns = parseInt(String(value == null ? "" : value), 10);
    if (!Number.isFinite(columns)) return 6;
    return Math.max(2, Math.min(8, columns));
  }

  function galleryCardHeight(columns) {
    return {
      2: 360,
      3: 300,
      4: 240,
      5: 200,
      6: 170,
      7: 150,
      8: 135
    }[normalizeGalleryColumns(columns)] || 170;
  }

  function loadGalleryColumns() {
    try {
      return normalizeGalleryColumns(window.localStorage.getItem(GALLERY_COLUMNS_STORE_KEY));
    } catch (_) {
      return 6;
    }
  }

  function storeGalleryColumns(columns) {
    try {
      window.localStorage.setItem(GALLERY_COLUMNS_STORE_KEY, String(normalizeGalleryColumns(columns)));
    } catch (_) {}
  }

  function normalizeGallerySort(value) {
    value = String(value || "").trim();
    return ["default", "name", "date", "similarity"].indexOf(value) !== -1 ? value : "default";
  }

  function loadGallerySort() {
    try {
      return normalizeGallerySort(window.localStorage.getItem(GALLERY_SORT_STORE_KEY));
    } catch (_) {
      return "default";
    }
  }

  function storeGallerySort(value) {
    try {
      window.localStorage.setItem(GALLERY_SORT_STORE_KEY, normalizeGallerySort(value));
    } catch (_) {}
  }

  function normalizeGallerySortDirection(value) {
    return String(value || "").toLowerCase() === "desc" ? "desc" : "asc";
  }

  function loadGallerySortDirection() {
    try {
      return normalizeGallerySortDirection(window.localStorage.getItem(GALLERY_SORT_DIRECTION_STORE_KEY));
    } catch (_) {
      return "asc";
    }
  }

  function storeGallerySortDirection(value) {
    try {
      window.localStorage.setItem(GALLERY_SORT_DIRECTION_STORE_KEY, normalizeGallerySortDirection(value));
    } catch (_) {}
  }

  function loadGalleryPointsFirst() {
    try {
      return window.localStorage.getItem(GALLERY_POINTS_FIRST_STORE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function storeGalleryPointsFirst(value) {
    try {
      window.localStorage.setItem(GALLERY_POINTS_FIRST_STORE_KEY, value ? "1" : "0");
    } catch (_) {}
  }

  function normalizePointSearchMethod(value) {
    value = String(value || "").trim().toLowerCase();
    return ["akaze", "sift", "orb"].indexOf(value) !== -1 ? value : "akaze";
  }

  function loadPointSearchMethod() {
    try {
      return normalizePointSearchMethod(window.localStorage.getItem(POINT_SEARCH_METHOD_STORE_KEY));
    } catch (_) {
      return "akaze";
    }
  }

  function storePointSearchMethod(value) {
    try {
      window.localStorage.setItem(POINT_SEARCH_METHOD_STORE_KEY, normalizePointSearchMethod(value));
    } catch (_) {}
  }

  function pointSearchMethodLabel(value) {
    value = normalizePointSearchMethod(value);
    if (value === "sift") return "Точний (SIFT)";
    if (value === "orb") return "Базовий (ORB)";
    return "Швидкий (AKAZE)";
  }

  function normalizeEnhancementMode(value) {
    value = String(value || "").trim().toLowerCase();
    return ["light", "medium", "maximum"].indexOf(value) !== -1 ? value : "medium";
  }

  function loadEnhancementMode() {
    try {
      return normalizeEnhancementMode(window.localStorage.getItem(ENHANCEMENT_MODE_STORE_KEY));
    } catch (_) {
      return "medium";
    }
  }

  function storeEnhancementMode(value) {
    try {
      window.localStorage.setItem(ENHANCEMENT_MODE_STORE_KEY, normalizeEnhancementMode(value));
    } catch (_) {}
  }

  function enhancementModeLabel(value) {
    value = normalizeEnhancementMode(value);
    if (value === "light") return "Легке";
    if (value === "maximum") return "Максимальне";
    return "Середнє";
  }

  var state = {
    session: null,
    images: [],
    viewMode: "gallery",
    phase: "prepare",
    galleryColumns: loadGalleryColumns(),
    gallerySort: loadGallerySort(),
    gallerySortDirection: loadGallerySortDirection(),
    galleryPointsFirst: loadGalleryPointsFirst(),
    galleryScrollTop: 0,
    enhancementMode: loadEnhancementMode(),
    gallerySelection: {},
    galleryProcessing: {},
    pointSearch: {
      mode: false,
      choosingMethod: false,
      running: false,
      currentJob: null,
      queue: [],
      progress: { done: 0, total: 0 },
      sourceImageId: null,
      method: loadPointSearchMethod(),
      results: {},
      candidates: {}
    },
    preparationLocked: false,
    enhanceJob: null,
    activeImageId: null,
    compareMode: "split",
    compareSplit: 50,
    compareView: { scale: 1, panX: 0, panY: 0 },
    points: [],
    activePointId: null,
    rawSrs: "EPSG:4326",
    mapView: { lat: 48.7, lng: 31.2, zoom: 6 },
    activeBaseMap: "Esri Satellite",
    imageView: { scale: 1, panX: 0, panY: 0 },
    busy: false,
    enhancing: false,
    saveStatus: "saved",
    saveError: "",
    elevation: null,
    orthophotos: [],
    orthophotosLoading: false,
    activeOrthophoto: null,
    message: "",
    error: ""
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

  function requestJson(url, options) {
    options = options || {};
    options.credentials = "same-origin";
    options.headers = Object.assign({
      "X-CSRFToken": getCookie("csrftoken") || ""
    }, options.headers || {});
    return fetch(url, options).then(function (response) {
      var contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        return response.text().then(function (text) {
          if (/^\s*</.test(text || "")) {
            if (url.indexOf("/enhance/") !== -1 || url.indexOf("/restore/") !== -1) {
              throw new Error("Сервер ще не підхопив новий endpoint плагіна. Перезапустіть WebODM/процес плагіна і оновіть сторінку.");
            }
            throw new Error("Сервер повернув HTML замість JSON. Перевірте, що ви залогінені в WebODM, і перезавантажте сторінку після оновлення плагіна.");
          }
          throw new Error(text || "Request failed");
        });
      }
      if (contentType.indexOf("application/json") === -1) {
        return response.text().then(function (text) {
          if (/^\s*</.test(text || "")) {
            if (url.indexOf("/enhance/") !== -1 || url.indexOf("/restore/") !== -1) {
              throw new Error("Сервер ще не підхопив новий endpoint плагіна. Перезапустіть WebODM/процес плагіна і оновіть сторінку.");
            }
            throw new Error("Сервер повернув HTML замість JSON. Перевірте сесію WebODM і перезавантажте сторінку.");
          }
          throw new Error(text || "Unexpected server response");
        });
      }
      return response.json();
    });
  }

  function imageUrl(kind, image) {
    var field = kind === "preview" ? "preview" : kind === "original_preview" ? "original_preview" : "filename";
    return "/plugins/Smartpoint/session/" + encodeURIComponent(sessionId) + "/" + kind + "/" + encodeURIComponent(image[field]);
  }

  function activeImage() {
    return state.images.find(function (image) { return image.id === state.activeImageId; }) || state.images[0] || null;
  }

  function activePoint() {
    return state.points.find(function (point) { return point.id === state.activePointId; }) || null;
  }

  function selectedImageIds() {
    return Object.keys(state.gallerySelection || {}).filter(function (imageId) {
      return !!state.gallerySelection[imageId];
    });
  }

  function enhancedImageCount() {
    return state.images.filter(function (image) { return !!image.enhanced; }).length;
  }

  function selectedImages() {
    var selected = state.gallerySelection || {};
    return state.images.filter(function (image) { return !!selected[image.id]; });
  }

  function selectedEnhanceableImages() {
    return selectedImages().filter(function (image) { return !image.enhanced; });
  }

  function selectedRestorableImages() {
    return selectedImages().filter(function (image) { return !!image.enhanced; });
  }

  function pointSearchState() {
    return state.pointSearch || {
      mode: false,
      choosingMethod: false,
      running: false,
      currentJob: null,
      queue: [],
      progress: { done: 0, total: 0 },
      sourceImageId: null,
      method: loadPointSearchMethod(),
      results: {},
      candidates: {}
    };
  }

  function resetPointSearch() {
    var search = pointSearchState();
    pointSearchRunToken += 1;
    var method = normalizePointSearchMethod(search.method);
    setState({
      pointSearch: {
        mode: false,
        choosingMethod: false,
        running: false,
        currentJob: null,
        queue: [],
        progress: { done: 0, total: 0 },
        sourceImageId: null,
        method: method,
        results: search.results || {},
        candidates: search.candidates || {}
      },
      message: "",
      error: ""
    });
  }

  function imageOriginalIndex(image) {
    var index = state.images.indexOf(image);
    return index < 0 ? 0 : index;
  }

  function imageNameSortValue(image) {
    return String(image.source_name || image.filename || "").toLowerCase();
  }

  function imageDateSortValue(image) {
    if (image && image.captured_at) {
      var captured = new Date(image.captured_at);
      if (!Number.isNaN(captured.getTime())) return captured.getTime();
    }
    if (image && image.kind === "video_frame") {
      var videoIndex = Number(image.video_index || 0);
      var frameSeconds = Number(image.frame_seconds);
      var frameIndex = Number(image.frame_index || 0);
      if (Number.isFinite(frameSeconds)) return (videoIndex * 1000000000) + Math.round(frameSeconds * 1000);
      if (Number.isFinite(frameIndex)) return (videoIndex * 1000000000) + frameIndex;
    }
    return imageOriginalIndex(image);
  }

  function imageSimilaritySortValue(image) {
    var search = pointSearchState();
    var result = search.results && search.results[image.id];
    if (search.sourceImageId === image.id) return Number.POSITIVE_INFINITY;
    return result ? Number(result.score || 0) : -1;
  }

  function firstPointNumberForImage(imageId) {
    var first = Number.POSITIVE_INFINITY;
    state.points.forEach(function (point, pointIndex) {
      var hasObservation = (point.observations || []).some(function (observation) {
        return observation.image_id === imageId;
      });
      if (hasObservation) first = Math.min(first, pointIndex + 1);
    });
    return first;
  }

  function firstSuggestedPointNumberForImage(imageId) {
    var search = pointSearchState();
    var candidates = search.candidates && search.candidates[imageId];
    if (!Array.isArray(candidates) || !candidates.length) return Number.POSITIVE_INFINITY;

    return candidates.reduce(function (first, candidate) {
      var number = Number(candidate.point_number);
      if (!Number.isFinite(number) && candidate.point_id) {
        var pointIndex = state.points.findIndex(function (point) {
          return String(point.id) === String(candidate.point_id);
        });
        if (pointIndex >= 0) number = pointIndex + 1;
      }
      return Number.isFinite(number) ? Math.min(first, number) : first;
    }, Number.POSITIVE_INFINITY);
  }

  function galleryPointPriorityForImage(imageId) {
    var actualPoint = firstPointNumberForImage(imageId);
    if (Number.isFinite(actualPoint)) {
      return { group: 0, number: actualPoint };
    }

    var suggestedPoint = firstSuggestedPointNumberForImage(imageId);
    if (Number.isFinite(suggestedPoint)) {
      return { group: 1, number: suggestedPoint };
    }

    return { group: 2, number: Number.POSITIVE_INFINITY };
  }

  function compareGalleryImages(a, b, sortMode, direction) {
    var multiplier = direction === "desc" ? -1 : 1;
    if (sortMode === "name") {
      var nameResult = imageNameSortValue(a).localeCompare(imageNameSortValue(b), undefined, { numeric: true, sensitivity: "base" });
      if (nameResult) return nameResult * multiplier;
    } else if (sortMode === "date") {
      var dateResult = imageDateSortValue(a) - imageDateSortValue(b);
      if (dateResult) return dateResult * multiplier;
    } else if (sortMode === "similarity") {
      var similarityResult = imageSimilaritySortValue(b) - imageSimilaritySortValue(a);
      if (similarityResult) return similarityResult;
    }
    return imageOriginalIndex(a) - imageOriginalIndex(b);
  }

  function orderedGalleryImages() {
    var search = pointSearchState();
    var results = search.results || {};
    var sortMode = normalizeGallerySort(state.gallerySort);
    var direction = normalizeGallerySortDirection(state.gallerySortDirection);
    if (sortMode === "default" && Object.keys(results).length) sortMode = "similarity";
    if (!state.galleryPointsFirst && sortMode === "default") return state.images;

    return state.images.slice().sort(function (a, b) {
      if (state.galleryPointsFirst) {
        var aPriority = galleryPointPriorityForImage(a.id);
        var bPriority = galleryPointPriorityForImage(b.id);
        if (aPriority.group !== bPriority.group) return aPriority.group - bPriority.group;
        if (aPriority.number !== bPriority.number) return aPriority.number - bPriority.number;
      }
      return compareGalleryImages(a, b, sortMode, direction);
    });
  }

  function hasImageObservations() {
    return state.points.some(function (point) {
      return (point.observations || []).some(function (observation) {
        return !!observation.image_id;
      });
    });
  }

  function canEnterMarkup() {
    var enhanced = enhancedImageCount();
    return state.images.length > 0 && (enhanced === 0 || enhanced === state.images.length);
  }

  function currentEnhanceDone() {
    var job = state.enhanceJob;
    if (job && job.status === "running") return Number(job.done || 0);
    return enhancedImageCount();
  }

  function currentEnhanceTotal() {
    var job = state.enhanceJob;
    if (job && job.status === "running") return Number(job.total || state.images.length || 0);
    return state.images.length;
  }

  function makeId() {
    return "p_" + Math.random().toString(36).slice(2) + "_" + Date.now();
  }

  function setState(patch, options) {
    if (state.viewMode === "gallery" && patch && patch.galleryScrollTop === undefined) {
      patch = Object.assign({ galleryScrollTop: captureGalleryScrollTop() }, patch);
    }
    state = Object.assign({}, state, patch);
    render();
    if (options && options.persist) queueAutoSave();
  }

  function setAutoSaveState(patch) {
    state = Object.assign({}, state, patch);
    render();
  }

  function captureGalleryScrollTop() {
    var grid = root.querySelector(".soft-tools-gallery-grid");
    return grid ? grid.scrollTop : Number(state.galleryScrollTop || 0);
  }

  function restoreGalleryScroll() {
    if (state.viewMode !== "gallery") return;
    var grid = root.querySelector(".soft-tools-gallery-grid");
    if (!grid) return;
    grid.scrollTop = Number(state.galleryScrollTop || 0);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function validNumber(value) {
    if (value === null || value === undefined) return false;
    var text = String(value).trim().replace(",", ".");
    if (text === "") return false;
    return Number.isFinite(Number(text));
  }

  function parseNumber(value) {
    return Number(String(value).replace(",", "."));
  }

  function pointHasMap(point) {
    return point && validNumber(point.x) && validNumber(point.y);
  }

  function pointHasObservation(point) {
    return point && (point.observations || []).length > 0;
  }

  function pointObservationCount(point) {
    return point && Array.isArray(point.observations) ? point.observations.length : 0;
  }

  function pointQualityClass(point) {
    var count = pointObservationCount(point);
    if (count <= 0) return " soft-tools-gcp-quality-none";
    if (count === 1) return " soft-tools-gcp-quality-one";
    if (count === 2) return " soft-tools-gcp-quality-two";
    if (count === 3) return " soft-tools-gcp-quality-minimum";
    return " soft-tools-gcp-quality-good";
  }

  function pointIsReady(point) {
    return pointHasMap(point) && pointHasObservation(point);
  }

  function pointStatus(point) {
    if (pointIsReady(point)) return "ready";
    if (pointHasMap(point)) return "map_set";
    if (pointHasObservation(point)) return "image_set";
    return "draft";
  }

  function withPointStatus(point) {
    return Object.assign({}, point, { status: pointStatus(point) });
  }

  function readyPointCount() {
    return state.points.filter(pointIsReady).length;
  }

  function draftPointCount() {
    return state.points.filter(function (point) { return !pointIsReady(point); }).length;
  }

  function pointStatusLabel(point) {
    var status = pointStatus(point);
    if (status === "ready") return "готова";
    if (status === "map_set") return "потрібне фото";
    if (status === "image_set") return "потрібна карта";
    return "чернетка";
  }

  function compactGalleryMessage(message) {
    return String(message || "").replace(/\s+з файлу\s+[^.]+(?:\.[^\s.]+)?\.?/i, "").trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function captureMapView() {
    if (!map) return state.mapView;
    var center = map.getCenter();
    return {
      lat: center.lat,
      lng: center.lng,
      zoom: map.getZoom()
    };
  }

  function addPoint() {
    var unfinishedPoint = state.points.find(function (point) {
      return !pointIsReady(point);
    });
    if (unfinishedPoint) {
      setState({
        activePointId: unfinishedPoint.id,
        mapView: captureMapView(),
        message: "Завершіть активну чернетку перед створенням наступної точки.",
        error: ""
      });
      return;
    }

    var index = state.points.length + 1;
    var point = {
      id: makeId(),
      name: "GCP " + index,
      x: "",
      y: "",
      z: "0",
      observations: [],
      status: "draft"
    };
    setState({
      points: state.points.concat([point]),
      activePointId: point.id,
      mapView: captureMapView(),
      message: "Нова GCP-чернетка. Поставте її на карті, потім на фото.",
      error: ""
    }, { persist: true });
  }

  function openImage(imageId) {
    setState({
      viewMode: state.phase === "prepare" ? "compare" : "detail",
      activeImageId: imageId,
      galleryScrollTop: captureGalleryScrollTop(),
      imageView: { scale: 1, panX: 0, panY: 0 },
      compareMode: "split",
      compareSplit: 50,
      compareView: { scale: 1, panX: 0, panY: 0 },
      message: "",
      error: ""
    });
  }

  function openGallery() {
    setState({
      viewMode: "gallery",
      message: "",
      error: ""
    });
  }

  function updatePoint(pointId, patch) {
    state.points = state.points.map(function (point) {
      return point.id === pointId ? Object.assign({}, point, patch) : point;
    });
  }

  function updateActivePoint(field, value) {
    if (!state.activePointId) return;
    updatePoint(state.activePointId, withPointStatus(Object.assign({}, activePoint(), { [field]: value })));
    render();
    queueAutoSave();
  }

  function queueAutoSave() {
    autoSaveRevision += 1;
    var revision = autoSaveRevision;
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    if (state.saveStatus !== "saving") {
      setAutoSaveState({ saveStatus: "saving", saveError: "" });
    }
    autoSaveTimer = window.setTimeout(function () {
      autoSaveTimer = null;
      runAutoSave(revision);
    }, 600);
  }

  function runAutoSave(revision) {
    state.rawSrs = state.rawSrs || "EPSG:4326";
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/points/", {
      method: "POST",
      body: JSON.stringify({
        raw_srs: state.rawSrs,
        points: state.points
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      if (revision !== autoSaveRevision) return;
      setAutoSaveState({
        saveStatus: "saved",
        saveError: "",
        elevation: json && json.elevation ? json.elevation : state.elevation,
        preparationLocked: !!(json && json.preparation_locked)
      });
    }).catch(function (error) {
      if (revision !== autoSaveRevision) return;
      setAutoSaveState({ saveStatus: "error", saveError: error.message || String(error) });
    });
  }

  function removeMapPoint(pointId) {
    var point = state.points.find(function (candidate) { return candidate.id === pointId; });
    if (!point || !pointHasMap(point)) return;
    if (pointHasObservation(point)) {
      setState({
        activePointId: point.id,
        mapView: captureMapView(),
        error: "",
        message: "Спочатку видаліть позначки цієї GCP на кадрах."
      });
      return;
    }

    var nextPoints = state.points.filter(function (candidate) { return candidate.id !== pointId; });
    setState({
      points: nextPoints,
      activePointId: nextPoints.length ? nextPoints[nextPoints.length - 1].id : null,
      mapView: captureMapView(),
      error: "",
      message: "GCP-точку видалено з карти."
    }, { persist: true });
  }

  function removeObservationFromImage(pointId, imageId) {
    var removed = false;
    var nextActivePointId = state.activePointId;
    var nextPoints = [];

    state.points.forEach(function (candidate) {
      if (candidate.id !== pointId) {
        nextPoints.push(candidate);
        return;
      }

      var observations = (candidate.observations || []).filter(function (observation) {
        var keep = String(observation.image_id) !== String(imageId);
        if (!keep) removed = true;
        return keep;
      });
      if (!removed) {
        nextPoints.push(candidate);
        return;
      }
      if (!pointHasMap(candidate) && !observations.length) {
        if (nextActivePointId === candidate.id) nextActivePointId = null;
        return;
      }
      nextPoints.push(withPointStatus(Object.assign({}, candidate, { observations: observations })));
    });

    if (!removed) return;
    if (!nextActivePointId && nextPoints.length) nextActivePointId = nextPoints[nextPoints.length - 1].id;
    setState({
      points: nextPoints,
      activePointId: nextActivePointId,
      mapView: captureMapView(),
      error: "",
      message: "Позначку видалено тільки з цього кадру."
    }, { persist: true });
  }

  function ensurePoint() {
    var point = activePoint();
    if (point) return point;
    setState({ error: "Натисніть + перед розміткою." });
    return null;
  }

  function imageCoordinatesFromClient(clientX, clientY) {
    var image = activeImage();
    var element = document.getElementById("soft-tools-active-image");
    if (!image || !element) return null;

    var rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    var relativeX = clientX - rect.left;
    var relativeY = clientY - rect.top;
    if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) return null;

    var previewX = (relativeX / rect.width) * Number(image.preview_width || element.naturalWidth || image.width || 1);
    var previewY = (relativeY / rect.height) * Number(image.preview_height || element.naturalHeight || image.height || 1);

    return {
      image: image,
      px: Math.round(previewX * Number(image.scale_x || 1) * 1000) / 1000,
      py: Math.round(previewY * Number(image.scale_y || 1) * 1000) / 1000
    };
  }

  function updatePointObservation(pointId, imageId, px, py) {
    return state.points.map(function (candidate) {
      if (candidate.id !== pointId) return candidate;
      var observations = (candidate.observations || []).filter(function (observation) {
        return observation.image_id !== imageId;
      });
      observations.push({ image_id: imageId, px: px, py: py });
      return withPointStatus(Object.assign({}, candidate, { observations: observations }));
    });
  }

  function acceptPointSearchCandidate(pointId, imageId, px, py) {
    var search = pointSearchState();
    var candidates = Object.assign({}, search.candidates || {});
    candidates[imageId] = (candidates[imageId] || []).filter(function (candidate) {
      return candidate.point_id !== pointId;
    });
    var results = Object.assign({}, search.results || {});
    if (candidates[imageId].length) {
      results[imageId] = Object.assign({}, results[imageId] || {}, { count: candidates[imageId].length });
    } else {
      delete candidates[imageId];
      delete results[imageId];
    }

    setState({
      points: updatePointObservation(pointId, imageId, px, py),
      activePointId: pointId,
      pointSearch: Object.assign({}, search, { candidates: candidates, results: results }),
      error: "",
      message: "Знайдену точку підтверджено."
    }, { persist: true });
  }

  function bindActiveImageDraftToMapPoint(mapPointId) {
    var draft = activePoint();
    if (!draft || draft.id === mapPointId || pointHasMap(draft) || !pointHasObservation(draft)) return false;

    var draftObservations = (draft.observations || []).filter(function (observation) {
      return observation && observation.image_id;
    }).map(function (observation) {
      return Object.assign({}, observation);
    });
    if (!draftObservations.length) return false;

    var draftImageIds = {};
    draftObservations.forEach(function (observation) {
      draftImageIds[observation.image_id] = true;
    });

    var nextPoints = [];
    var didBind = false;
    state.points.forEach(function (candidate) {
      if (candidate.id === draft.id) return;
      if (candidate.id !== mapPointId) {
        nextPoints.push(candidate);
        return;
      }

      var observations = (candidate.observations || []).filter(function (observation) {
        return !draftImageIds[observation.image_id];
      }).concat(draftObservations);
      nextPoints.push(withPointStatus(Object.assign({}, candidate, { observations: observations })));
      didBind = true;
    });
    if (!didBind) return false;

    setState({
      points: nextPoints,
      activePointId: mapPointId,
      mapView: captureMapView(),
      error: "",
      message: "Позначку на фото прив'язано до існуючої GCP-точки."
    }, { persist: true });
    return true;
  }

  function addObservation(event) {
    var image = activeImage();
    var point = ensurePoint();
    if (!image || !point) return;

    if (event.defaultPrevented) return;
    if (suppressNextImageClick) {
      suppressNextImageClick = false;
      return;
    }

    var coordinates = imageCoordinatesFromClient(event.clientX, event.clientY);
    if (!coordinates) return;
    var nextPoints = updatePointObservation(point.id, image.id, coordinates.px, coordinates.py);

    setState({
      points: nextPoints,
      activePointId: point.id,
      error: "",
      message: pointHasMap(point) ? "GCP-точку прив'язано: карта + фото." : "Позначку на фото додано. Тепер поставте цю ж точку на карті."
    }, { persist: true });
  }

  function setActivePointMapCoordinate(lat, lng) {
    var point = ensurePoint();
    if (!point) return;
    var nextPoints = state.points.map(function (candidate) {
      if (candidate.id !== point.id) return candidate;
      return withPointStatus(Object.assign({}, candidate, {
        x: Number(lng).toFixed(8),
        y: Number(lat).toFixed(8),
        z: candidate.z || "0"
      }));
    });
    setState({
      points: nextPoints,
      activePointId: point.id,
      mapView: captureMapView(),
      error: "",
      message: pointHasObservation(point) ? "GCP-точку прив'язано: карта + фото." : "Координату на карті додано. Тепер поставте цю ж точку на фото."
    }, { persist: true });
  }

  function setImageZoom(nextScale, anchor) {
    var imageView = state.imageView || { scale: 1, panX: 0, panY: 0 };
    var stage = document.getElementById("soft-tools-image-stage");
    var scale = clamp(nextScale, 0.5, 6);
    var nextView = Object.assign({}, imageView, { scale: scale, panX: 0, panY: 0 });

    if (stage && anchor) {
      var rect = stage.getBoundingClientRect();
      var anchorX = anchor.clientX - rect.left;
      var anchorY = anchor.clientY - rect.top;
      var imageX = (stage.scrollLeft + anchorX) / imageView.scale;
      var imageY = (stage.scrollTop + anchorY) / imageView.scale;
      applyImageView(nextView);
      stage.scrollLeft = Math.max(0, (imageX * scale) - anchorX);
      stage.scrollTop = Math.max(0, (imageY * scale) - anchorY);
      state.imageView = Object.assign({}, nextView, { panX: stage.scrollLeft, panY: stage.scrollTop });
      return;
    }

    applyImageView(nextView);
  }

  function resetImageView() {
    var stage = document.getElementById("soft-tools-image-stage");
    applyImageView({ scale: 1, panX: 0, panY: 0 });
    if (stage) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  }

  function normalizeCompareView(view) {
    var scale = clamp(Number((view || {}).scale || 1), 1, 8);
    return {
      scale: scale,
      panX: scale <= 1 ? 0 : Number((view || {}).panX || 0),
      panY: scale <= 1 ? 0 : Number((view || {}).panY || 0)
    };
  }

  function compareTransformStyle(view) {
    view = normalizeCompareView(view);
    return "translate(" + view.panX + "px, " + view.panY + "px) scale(" + view.scale + ")";
  }

  function applyCompareView(view) {
    var nextView = normalizeCompareView(view);
    var content = root.querySelector(".soft-tools-compare-content");
    var value = root.querySelector(".soft-tools-compare-zoom-value");
    var zoomOut = document.getElementById("soft-tools-compare-zoom-out");
    var zoomReset = document.getElementById("soft-tools-compare-zoom-reset");
    state.compareView = nextView;
    if (content) content.style.transform = compareTransformStyle(nextView);
    if (value) value.textContent = Math.round(nextView.scale * 100) + "%";
    if (zoomOut) zoomOut.disabled = nextView.scale <= 1.001;
    if (zoomReset) zoomReset.disabled = nextView.scale <= 1.001 && !nextView.panX && !nextView.panY;
  }

  function setCompareZoom(nextScale, anchor) {
    var current = normalizeCompareView(state.compareView);
    var viewport = root.querySelector(".soft-tools-compare-stage");
    var scale = clamp(nextScale, 1, 8);
    var nextView = { scale: scale, panX: current.panX, panY: current.panY };

    if (viewport && anchor) {
      var rect = viewport.getBoundingClientRect();
      var centerX = rect.left + rect.width / 2;
      var centerY = rect.top + rect.height / 2;
      nextView.panX = (anchor.clientX - centerX) - (scale * ((anchor.clientX - centerX - current.panX) / current.scale));
      nextView.panY = (anchor.clientY - centerY) - (scale * ((anchor.clientY - centerY - current.panY) / current.scale));
    }

    applyCompareView(nextView);
  }

  function observationsForImage(imageId) {
    var observations = [];
    state.points.forEach(function (point) {
      (point.observations || []).forEach(function (observation) {
        if (observation.image_id === imageId) {
          observations.push({ point: point, observation: observation });
        }
      });
    });
    return observations;
  }

  function badgesForImage(imageId) {
    var badges = [];
    state.points.forEach(function (point, pointIndex) {
      var hasObservation = (point.observations || []).some(function (observation) {
        return observation.image_id === imageId;
      });
      if (!hasObservation) return;
      badges.push({
        point: point,
        number: pointIndex + 1
      });
    });
    return badges;
  }

  function selectedPointStats(point) {
    if (!point) return "Немає активної точки";
    return pointStatusLabel(point) + ": " + (point.observations || []).length + " фото-позначок" + (pointHasMap(point) ? ", карта є" : ", карти немає");
  }

  function saveStatusLabel() {
    if (state.saveStatus === "saving") return "Збереження...";
    if (state.saveStatus === "error") return "Помилка збереження";
    var elevation = state.elevation || {};
    var filled = Number(elevation.filled_count || 0);
    var cached = Number(elevation.cached_count || 0);
    var missing = Number(elevation.missing_count || 0);
    if (filled > 0) return "Збережено · висоти SRTM";
    if (cached > 0) return "Збережено · SRTM cache";
    if (missing > 0) return "Збережено · " + missing + " точок без висоти";
    return "Збережено";
  }

  function generateGcp(download) {
    state.rawSrs = state.rawSrs || "EPSG:4326";
    setState({ busy: true, message: "", error: "" });
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/gcp/", {
      method: "POST",
      body: JSON.stringify({
        raw_srs: state.rawSrs,
        points: state.points
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      setState({
        busy: false,
        elevation: json && json.elevation ? json.elevation : state.elevation,
        message: "GCP-файл згенеровано: " + json.entries_count + " прив'язок."
      });
      if (download) window.location.href = json.download_url;
    }).catch(function (error) {
      setState({ busy: false, error: error.message || String(error) });
    });
  }

  function toggleGallerySelection(imageId) {
    var image = state.images.find(function (candidate) { return candidate.id === imageId; });
    if (!image || image.enhanced) return;
    var selection = Object.assign({}, state.gallerySelection || {});
    selection[imageId] = !selection[imageId];
    if (!selection[imageId]) delete selection[imageId];
    setState({ gallerySelection: selection, error: "" });
  }

  function selectAllGalleryImages() {
    var selection = {};
    state.images.forEach(function (image) {
      if (!image.enhanced) selection[image.id] = true;
    });
    setState({ gallerySelection: selection, error: "" });
  }

  function clearGallerySelection() {
    setState({ gallerySelection: {}, error: "" });
  }

  function scheduleEnhancePoll() {
    if (enhancePollTimer) window.clearTimeout(enhancePollTimer);
    enhancePollTimer = window.setTimeout(pollEnhanceStatus, 1000);
  }

  function applyEnhanceStatus(json) {
    var job = json && json.job;
    var processing = {};
    if (job && job.status === "running") {
      (job.image_ids || []).forEach(function (imageId) {
        var image = state.images.find(function (candidate) { return candidate.id === imageId; });
        if (imageId && !(image && image.enhanced)) processing[imageId] = true;
      });
    }
    setState({
      images: (json && json.images) || state.images,
      points: ((json && json.points) || state.points).map(withPointStatus),
      enhanceJob: job || null,
      galleryProcessing: processing,
      busy: !!(job && job.status === "running"),
      enhancing: !!(job && job.status === "running"),
      message: job && job.status === "running" ? ("Покращення " + (job.enhancement_label || enhancementModeLabel(state.enhancementMode)) + ": " + Number(job.done || 0) + " / " + Number(job.total || 0)) : "",
      error: job && job.status === "error" ? ((job.errors || []).join("; ") || "Помилка покращення.") : ""
    });
    if (job && job.status === "running") scheduleEnhancePoll();
  }

  function pollEnhanceStatus() {
    enhancePollTimer = null;
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/enhance/status/")
      .then(applyEnhanceStatus)
      .catch(function (error) {
        setState({ busy: false, enhancing: false, error: error.message || String(error) });
      });
  }

  function enterMarkup() {
    if (!canEnterMarkup()) {
      setState({ error: "Покращте всі кадри або скасуйте x4 перед розміткою." });
      return;
    }
    setState({
      phase: "markup",
      viewMode: "gallery",
      gallerySelection: {},
      message: "Оберіть кадр для GCP-розмітки.",
      error: ""
    });
  }

  function enhanceQueue(queue, progressDone, progressTotal) {
    if (!queue.length) {
      setState({
        busy: false,
        enhancing: false,
        galleryProcessing: {},
        gallerySelection: {},
        message: "Покращення завершено: " + progressTotal + " / " + progressTotal + ".",
        error: ""
      });
      return;
    }

    var image = queue[0];
    var processing = {};
    processing[image.id] = true;
    setState({
      galleryProcessing: processing,
      message: "Покращення " + progressDone + " / " + progressTotal + ": " + image.filename,
      error: ""
    });

    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/enhance/", {
      method: "POST",
      body: JSON.stringify({
        all: false,
        image_ids: [image.id]
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      state.images = json.images || state.images;
      state.points = (json.points || state.points).map(withPointStatus);
      enhanceQueue(queue.slice(1), progressDone + 1, progressTotal);
    }).catch(function (error) {
      setState({
        busy: false,
        enhancing: false,
        galleryProcessing: {},
        error: error.message || String(error)
      });
    });
  }

  function enhanceImages(applyAll) {
    if (state.enhancing || state.busy) return;
    if (state.preparationLocked) {
      setState({ error: "Покращення заблоковано: вже є GCP-позначки на кадрах." });
      return;
    }
    if (!applyAll && !selectedImageIds().length) {
      setState({ error: "Оберіть хоча б одне зображення для покращення." });
      return;
    }
    var queue = applyAll
      ? state.images.filter(function (image) { return !image.enhanced; })
      : selectedEnhanceableImages();
    if (!queue.length) {
      setState({ error: "Вибрані кадри вже покращені." });
      return;
    }

    setState({
      busy: true,
      enhancing: true,
      message: "Покращення " + enhancementModeLabel(state.enhancementMode) + ": " + (applyAll ? enhancedImageCount() : 0) + " / " + (applyAll ? state.images.length : queue.length),
      error: ""
    });
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/enhance/", {
      method: "POST",
      body: JSON.stringify({
        all: !!applyAll,
        image_ids: queue.map(function (image) { return image.id; }),
        enhancement_mode: normalizeEnhancementMode(state.enhancementMode)
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      applyEnhanceStatus({ job: json.job, images: state.images, points: state.points, message: state.message });
    }).catch(function (error) {
      setState({ busy: false, enhancing: false, error: error.message || String(error) });
    });
  }

  function restoreImages(restoreAll) {
    if (state.enhancing || state.busy) return;
    if (state.preparationLocked) {
      setState({ error: "Скасування x4 заблоковано: вже є GCP-позначки на кадрах." });
      return;
    }
    var targets = restoreAll
      ? state.images.filter(function (image) { return !!image.enhanced; })
      : selectedRestorableImages();
    if (!restoreAll && !selectedImageIds().length) {
      setState({ error: "Оберіть хоча б одне зображення для скасування x4." });
      return;
    }
    if (!targets.length) {
      setState({ error: "Немає покращених кадрів для скасування." });
      return;
    }
    setState({ busy: true, message: "Скасування x4...", error: "" });
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/restore/", {
      method: "POST",
      body: JSON.stringify({
        all: !!restoreAll,
        image_ids: targets.map(function (image) { return image.id; })
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      setState({
        images: json.images || state.images,
        points: (json.points || state.points).map(withPointStatus),
        busy: false,
        gallerySelection: {},
        message: json.message || ("Скасовано x4: " + json.restored_count + "."),
        error: ""
      });
    }).catch(function (error) {
      setState({ busy: false, error: error.message || String(error) });
    });
  }

  function loadPointSearchImage(image) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var sourceWidth = Number(image.preview_width || img.naturalWidth || 1);
        var sourceHeight = Number(image.preview_height || img.naturalHeight || 1);
        var maxSide = 900;
        var scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
        var width = Math.max(1, Math.round(sourceWidth * scale));
        var height = Math.max(1, Math.round(sourceHeight * scale));
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, width, height);
        var pixels = ctx.getImageData(0, 0, width, height).data;
        var gray = new Float32Array(width * height);
        for (var i = 0, j = 0; i < pixels.length; i += 4, j += 1) {
          gray[j] = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        }
        resolve({
          image: image,
          width: width,
          height: height,
          scale: scale,
          gray: gray
        });
      };
      img.onerror = function () {
        reject(new Error("Не вдалося прочитати зображення для пошуку."));
      };
      img.src = imageUrl("preview", image);
    });
  }

  function pointSearchTemplate(sourceData, entry) {
    var sourceImage = sourceData.image;
    var previewX = Number(entry.observation.px) / Number(sourceImage.scale_x || 1);
    var previewY = Number(entry.observation.py) / Number(sourceImage.scale_y || 1);
    var centerX = Math.round(previewX * sourceData.scale);
    var centerY = Math.round(previewY * sourceData.scale);
    var radius = 40;
    var size = radius * 2 + 1;
    var left = centerX - radius;
    var top = centerY - radius;
    if (left < 0 || top < 0 || left + size >= sourceData.width || top + size >= sourceData.height) return null;

    var values = [];
    var sum = 0;
    for (var y = 0; y < size; y += 2) {
      for (var x = 0; x < size; x += 2) {
        var value = sourceData.gray[(top + y) * sourceData.width + left + x];
        values.push(value);
        sum += value;
      }
    }
    var mean = sum / Math.max(values.length, 1);
    var norm = 0;
    for (var i = 0; i < values.length; i += 1) {
      var delta = values[i] - mean;
      values[i] = delta;
      norm += delta * delta;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm < 1) return null;

    return {
      pointId: entry.point.id,
      pointNumber: state.points.findIndex(function (point) { return point.id === entry.point.id; }) + 1,
      size: size,
      sampleStep: 2,
      values: values,
      mean: mean,
      norm: norm
    };
  }

  function matchPointSearchTemplate(targetData, template) {
    var best = { score: -1, x: 0, y: 0 };
    var size = template.size;
    var sampleStep = template.sampleStep;
    var scanStep = 5;
    if (targetData.width < size || targetData.height < size) return null;

    for (var top = 0; top <= targetData.height - size; top += scanStep) {
      for (var left = 0; left <= targetData.width - size; left += scanStep) {
        var sum = 0;
        var count = 0;
        for (var y = 0; y < size; y += sampleStep) {
          for (var x = 0; x < size; x += sampleStep) {
            sum += targetData.gray[(top + y) * targetData.width + left + x];
            count += 1;
          }
        }
        var mean = sum / Math.max(count, 1);
        var dot = 0;
        var norm = 0;
        var sampleIndex = 0;
        for (var sy = 0; sy < size; sy += sampleStep) {
          for (var sx = 0; sx < size; sx += sampleStep) {
            var delta = targetData.gray[(top + sy) * targetData.width + left + sx] - mean;
            dot += template.values[sampleIndex] * delta;
            norm += delta * delta;
            sampleIndex += 1;
          }
        }
        norm = Math.sqrt(norm) * template.norm;
        var score = norm > 0 ? dot / norm : -1;
        if (score > best.score) {
          best = {
            score: score,
            x: left + size / 2,
            y: top + size / 2
          };
        }
      }
    }

    if (best.score < 0.70) return null;
    return {
      point_id: template.pointId,
      point_number: template.pointNumber,
      px: Math.round((best.x / targetData.scale) * Number(targetData.image.scale_x || 1) * 1000) / 1000,
      py: Math.round((best.y / targetData.scale) * Number(targetData.image.scale_y || 1) * 1000) / 1000,
      preview_x: best.x / targetData.scale,
      preview_y: best.y / targetData.scale,
      score: Math.round(best.score * 1000) / 1000
    };
  }

  function startPointSearchMode() {
    var method = normalizePointSearchMethod(pointSearchState().method);
    var search = pointSearchState();
    if (search.choosingMethod && !search.running) {
      resetPointSearch();
      return;
    }
    if (search.choosingMethod && search.running) {
      setState({
        pointSearch: Object.assign({}, search, { mode: false, choosingMethod: false }),
        message: "Пошук триває: " + Number((search.progress || {}).done || 0) + "/" + Number((search.progress || {}).total || 0) + ".",
        error: ""
      });
      return;
    }
    if (search.mode && !search.running) {
      resetPointSearch();
      return;
    }
    setState({
      pointSearch: Object.assign({}, search, {
        mode: false,
        choosingMethod: true,
        method: method
      }),
      message: search.running ? "Оберіть метод для наступного пошуку в черзі." : "Оберіть метод пошуку точок.",
      error: ""
    });
  }

  function choosePointSearchMethod(method) {
    method = normalizePointSearchMethod(method);
    storePointSearchMethod(method);
    var search = pointSearchState();
    setState({
      pointSearch: Object.assign({}, search, {
        mode: true,
        choosingMethod: false,
        sourceImageId: null,
        method: method,
        results: search.running ? search.results : {},
        candidates: search.running ? search.candidates : {}
      }),
      message: (search.running ? "Оберіть фото для додавання в чергу. Метод: " : "Оберіть фото, на якому вже є точки. Метод: ") + pointSearchMethodLabel(method) + ".",
      error: ""
    });
  }

  function pointSearchBatchSize(method) {
    method = normalizePointSearchMethod(method);
    if (method === "sift") return 6;
    if (method === "orb") return 12;
    return 10;
  }

  function imagePointIds(imageId) {
    var ids = {};
    state.points.forEach(function (point) {
      (point.observations || []).forEach(function (observation) {
        if (String(observation.image_id) === String(imageId)) ids[String(point.id)] = true;
      });
    });
    return ids;
  }

  function pointSearchCandidateCount(candidates, targetIds) {
    var total = 0;
    var allowed = null;
    if (targetIds && targetIds.length) {
      allowed = {};
      targetIds.forEach(function (imageId) {
        allowed[String(imageId)] = true;
      });
    }
    Object.keys(candidates || {}).forEach(function (imageId) {
      if (allowed && !allowed[String(imageId)]) return;
      total += (candidates[imageId] || []).length;
    });
    return total;
  }

  function orderedPointSearchTargetIds(sourceImageId, sourcePointIds) {
    var sourceIndex = state.images.findIndex(function (image) {
      return String(image.id) === String(sourceImageId);
    });
    if (sourceIndex < 0) return [];
    var ids = [];
    for (var distance = 1; distance < state.images.length; distance += 1) {
      [-distance, distance].forEach(function (delta) {
        var index = sourceIndex + delta;
        if (index < 0 || index >= state.images.length) return;
        var image = state.images[index];
        if (!image || String(image.id) === String(sourceImageId)) return;
        var existing = imagePointIds(image.id);
        var hasMissingPoint = Object.keys(sourcePointIds).some(function (pointId) {
          return !existing[pointId];
        });
        if (hasMissingPoint) ids.push(image.id);
      });
    }
    return ids;
  }

  function stopCurrentPointSearch() {
    var search = pointSearchState();
    if (!search.running) return;
    pointSearchRunToken += 1;
    setState({
      pointSearch: Object.assign({}, search, {
        running: false,
        currentJob: null,
        progress: { done: Number((search.progress || {}).done || 0), total: Number((search.progress || {}).total || 0) }
      }),
      message: "Поточний пошук зупинено. Переходжу до наступного в черзі.",
      error: ""
    });
    window.setTimeout(processPointSearchQueue, 0);
  }

  function cancelAllPointSearch() {
    var search = pointSearchState();
    pointSearchRunToken += 1;
    setState({
      pointSearch: Object.assign({}, search, {
        mode: false,
        choosingMethod: false,
        running: false,
        currentJob: null,
        queue: [],
        progress: { done: 0, total: 0 }
      }),
      message: "Пошук скасовано.",
      error: ""
    });
  }

  function createPointSearchJob(sourceImageId, method) {
    var sourceImage = state.images.find(function (image) { return image.id === sourceImageId; });
    var sourceEntries = observationsForImage(sourceImageId);
    if (!sourceImage || !sourceEntries.length) {
      setState({ error: "На цьому фото немає точок для пошуку." });
      return null;
    }
    var sourcePointIds = {};
    sourceEntries.forEach(function (entry) {
      sourcePointIds[String(entry.point.id)] = true;
    });
    var targetIds = orderedPointSearchTargetIds(sourceImageId, sourcePointIds);
    if (!targetIds.length) {
      setState({ error: "Немає фото, де ці точки ще не позначені." });
      return null;
    }
    return {
      id: makeId(),
      sourceImageId: sourceImageId,
      method: normalizePointSearchMethod(method),
      targetIds: targetIds,
      done: 0,
      total: targetIds.length,
      candidateLimit: POINT_SEARCH_CANDIDATE_LIMIT,
      candidateCount: 0
    };
  }

  function runPointSearch(sourceImageId) {
    var method = normalizePointSearchMethod(pointSearchState().method);
    var job = createPointSearchJob(sourceImageId, method);
    if (!job) return;
    var search = pointSearchState();
    var queue = (search.queue || []).concat([job]);
    setState({
      pointSearch: Object.assign({}, search, {
        mode: false,
        choosingMethod: false,
        queue: queue,
        method: method,
        sourceImageId: search.running ? search.sourceImageId : sourceImageId
      }),
      message: search.running
        ? ("Додано в чергу: " + pointSearchMethodLabel(method) + ", до " + job.candidateLimit + " кандидатів.")
        : ("Пошук додано: " + pointSearchMethodLabel(method) + ", до " + job.candidateLimit + " кандидатів."),
      error: ""
    });
    window.setTimeout(processPointSearchQueue, 0);
  }

  function processPointSearchQueue() {
    var search = pointSearchState();
    if (search.running) return;
    var queue = (search.queue || []).slice();
    var job = queue.shift();
    if (!job) return;
    var token = pointSearchRunToken + 1;
    pointSearchRunToken = token;
    setState({
      pointSearch: Object.assign({}, search, {
        queue: queue,
        currentJob: job,
        mode: !!search.mode,
        choosingMethod: !!search.choosingMethod,
        running: true,
        sourceImageId: job.sourceImageId,
        method: (search.mode || search.choosingMethod) ? search.method : job.method,
        progress: { done: 0, total: job.total }
      }),
      message: "Шукаю точки " + pointSearchMethodLabel(job.method) + ": 0/" + job.candidateLimit + " кандидатів, перевірено 0/" + job.total + " фото" + (queue.length ? ". У черзі: " + queue.length + "." : "."),
      error: ""
    });
    runPointSearchJob(job, token, 0);
  }

  function runPointSearchJob(job, token, offset) {
    if (token !== pointSearchRunToken) return;
    var batchSize = pointSearchBatchSize(job.method);
    var batch = (job.targetIds || []).slice(offset, offset + batchSize);
    if (!batch.length) {
      var finishedSearch = pointSearchState();
      setState({
        pointSearch: Object.assign({}, finishedSearch, {
          running: false,
          currentJob: null,
          progress: { done: job.total, total: job.total }
        }),
        message: "Пошук завершено: знайдено " + pointSearchCandidateCount(pointSearchState().candidates || {}, job.targetIds) + "/" + job.candidateLimit + " кандидатів.",
        error: ""
      });
      window.setTimeout(processPointSearchQueue, 0);
      return;
    }
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/point-search/", {
      method: "POST",
      body: JSON.stringify({
        source_image_id: job.sourceImageId,
        method: job.method,
        target_image_ids: batch,
        points: state.points
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      if (token !== pointSearchRunToken) return;
      var results = json.results || {};
      var candidates = json.candidates || {};
      var nextOffset = Math.min(offset + batch.length, job.total);
      var currentSearch = pointSearchState();
      var mergedResults = Object.assign({}, currentSearch.results || {}, results);
      var mergedCandidates = Object.assign({}, currentSearch.candidates || {}, candidates);
      var queueLength = (currentSearch.queue || []).length;
      var foundCount = pointSearchCandidateCount(mergedCandidates, job.targetIds);
      var reachedLimit = foundCount >= Number(job.candidateLimit || POINT_SEARCH_CANDIDATE_LIMIT);
      setState({
        pointSearch: Object.assign({}, currentSearch, {
          mode: !!currentSearch.mode,
          choosingMethod: !!currentSearch.choosingMethod,
          running: !reachedLimit,
          currentJob: reachedLimit ? null : currentSearch.currentJob,
          sourceImageId: job.sourceImageId,
          method: (currentSearch.mode || currentSearch.choosingMethod) ? currentSearch.method : normalizePointSearchMethod(json.method || job.method),
          results: mergedResults,
          candidates: mergedCandidates,
          progress: { done: nextOffset, total: job.total }
        }),
        message: reachedLimit
          ? ("Поточний пошук завершено: знайдено " + foundCount + "/" + job.candidateLimit + " кандидатів.")
          : ("Шукаю точки " + pointSearchMethodLabel(job.method) + ": " + foundCount + "/" + job.candidateLimit + " кандидатів, перевірено " + nextOffset + "/" + job.total + " фото" + (queueLength ? ". У черзі: " + queueLength + "." : ".")),
        error: ""
      });
      if (reachedLimit) {
        window.setTimeout(processPointSearchQueue, 0);
        return;
      }
      runPointSearchJob(job, token, nextOffset);
    }).catch(function (error) {
      if (token !== pointSearchRunToken) return;
      setState({
        pointSearch: Object.assign({}, pointSearchState(), { running: false, currentJob: null }),
        error: error.message || String(error)
      });
      window.setTimeout(processPointSearchQueue, 0);
    });
  }

  function goToTask() {
    state.rawSrs = state.rawSrs || "EPSG:4326";
    setState({ busy: true, message: "", error: "" });
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/task/", {
      method: "POST",
      body: JSON.stringify({
        raw_srs: state.rawSrs,
        points: state.points
      }),
      headers: { "Content-Type": "application/json" }
    }).then(function (json) {
      window.location.href = json.redirect_url || ("/dashboard/?project_task_open=" + encodeURIComponent(json.project_id));
    }).catch(function (error) {
      setState({ busy: false, error: error.message || String(error) });
    });
  }

  function renderGallery() {
    return state.images.map(function (image, index) {
      var active = image.id === (activeImage() || {}).id ? " active" : "";
      var count = observationsForImage(image.id).length;
      return '' +
        '<button type="button" class="soft-tools-thumb' + active + '" data-image-id="' + escapeHtml(image.id) + '">' +
          '<img src="' + imageUrl("preview", image) + '" alt="">' +
          '<span class="soft-tools-thumb-title" title="' + escapeHtml(image.filename) + '">' + (index + 1) + ". " + escapeHtml(image.filename) + '</span>' +
          '<span class="soft-tools-thumb-meta">' + count + ' точок</span>' +
        '</button>';
    }).join("");
  }

  function renderGalleryPage() {
    var columns = normalizeGalleryColumns(state.galleryColumns);
    var hasReady = readyPointCount() > 0;
    var galleryMessage = compactGalleryMessage(state.message);
    var selectedCount = selectedImageIds().length;
    var enhancedCount = enhancedImageCount();
    var markupBlocked = !canEnterMarkup();
    var prepLocked = !!state.preparationLocked;
    var prepareMode = state.phase === "prepare";
    var enhanceableSelectedCount = selectedEnhanceableImages().length;
    var restorableSelectedCount = selectedRestorableImages().length;
    var title = prepareMode ? "Підготовка зображень - " + state.images.length : "Галерея розмітки - " + state.images.length;
    var hint = prepareMode ? "Покращте всі кадри або скасуйте x4 перед переходом до прив'язки." : "Оберіть фото або кадр, щоб перейти до розмітки з картою.";
    var progressText = enhancedCount + " / " + state.images.length + " x4";
    var columnOptions = "";
    for (var column = 2; column <= 8; column += 1) {
      columnOptions += '<option value="' + column + '"' + (column === columns ? " selected" : "") + '>' + column + '</option>';
    }
    var primaryButton = prepareMode
      ? '<button id="soft-tools-enter-markup" type="button" class="btn btn-primary btn-sm" ' + (state.busy || markupBlocked ? "disabled" : "") + '>Перейти до прив\'язки</button>'
      : '<button id="soft-tools-go-task" type="button" class="btn btn-primary btn-sm" ' + (state.busy ? "disabled" : "") + '>До задачі</button>';
    var prepareTools = prepareMode ? (
      '<div class="soft-tools-gallery-selection-tools">' +
        '<span class="soft-tools-gallery-selection-count">' + selectedCount + ' вибрано</span>' +
        '<button id="soft-tools-gallery-select-all" type="button" class="btn btn-default btn-sm" ' + (state.busy || !state.images.length ? "disabled" : "") + '>Всі</button>' +
        '<button id="soft-tools-gallery-clear-selection" type="button" class="btn btn-default btn-sm" ' + (state.busy || !selectedCount ? "disabled" : "") + '>Очистити</button>' +
        '<button id="soft-tools-enhance-selected" type="button" class="btn btn-default btn-sm" ' + (state.busy || prepLocked || !enhanceableSelectedCount ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити вибрані</button>' +
        '<button id="soft-tools-enhance-all" type="button" class="btn btn-primary btn-sm" ' + (state.busy || prepLocked || enhancedCount === state.images.length || !state.images.length ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити всі</button>' +
        '<button id="soft-tools-restore-selected" type="button" class="btn btn-default btn-sm" ' + (state.busy || prepLocked || !restorableSelectedCount ? "disabled" : "") + '>Скасувати вибрані</button>' +
        '<button id="soft-tools-restore-all" type="button" class="btn btn-default btn-sm" ' + (state.busy || prepLocked || !enhancedCount ? "disabled" : "") + '>Скасувати всі</button>' +
      '</div>'
    ) : "";
    var lockWarning = prepareMode && prepLocked
      ? '<div class="alert alert-warning soft-tools-alert">Покращення заблоковано: вже є GCP-позначки на кадрах.</div>'
      : '';

    return '' +
      '<div class="soft-tools-gallery-page">' +
        '<div class="soft-tools-gallery-page-header">' +
          '<div class="soft-tools-gallery-title-wrap">' +
            '<button id="soft-tools-go-task" type="button" class="btn btn-primary btn-sm" ' + (state.busy ? "disabled" : "") + '>До задачі</button>' +
            '<div>' +
              '<h3>\u0417\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u044c - ' + state.images.length + '</h3>' +
            '</div>' +
          '</div>' +
          (galleryMessage ? '<div class="soft-tools-gallery-header-message">' + escapeHtml(galleryMessage) + '</div>' : '<div class="soft-tools-gallery-header-message"></div>') +
          '<div class="soft-tools-gallery-tools">' +
            '<div class="soft-tools-gallery-hint">\u041e\u0431\u0435\u0440\u0456\u0442\u044c \u0444\u043e\u0442\u043e \u0430\u0431\u043e \u043a\u0430\u0434\u0440, \u0449\u043e\u0431 \u043f\u0435\u0440\u0435\u0439\u0442\u0438 \u0434\u043e \u0440\u043e\u0437\u043c\u0456\u0442\u043a\u0438 \u0437 \u043a\u0430\u0440\u0442\u043e\u044e.</div>' +
            '<div class="soft-tools-gallery-selection-tools">' +
              '<span class="soft-tools-gallery-selection-count">' + selectedCount + ' вибрано</span>' +
              '<button id="soft-tools-gallery-select-all" type="button" class="btn btn-default btn-sm" ' + (state.busy || !state.images.length ? "disabled" : "") + '>Всі</button>' +
              '<button id="soft-tools-gallery-clear-selection" type="button" class="btn btn-default btn-sm" ' + (state.busy || !selectedCount ? "disabled" : "") + '>Очистити</button>' +
              '<button id="soft-tools-enhance-selected" type="button" class="btn btn-default btn-sm" ' + (state.busy || !selectedCount ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити вибрані</button>' +
              '<button id="soft-tools-enhance-all" type="button" class="btn btn-primary btn-sm" ' + (state.busy || !state.images.length ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити всі</button>' +
            '</div>' +
            '<label class="soft-tools-gallery-columns" for="soft-tools-gallery-columns">' +
              '<span>\u041a\u043e\u043b\u043e\u043d\u043a\u0438</span>' +
              '<select id="soft-tools-gallery-columns" class="form-control input-sm">' + columnOptions + '</select>' +
            '</label>' +
          '</div>' +
        '</div>' +
        (state.error ? '<div class="alert alert-danger soft-tools-alert">' + escapeHtml(state.error) + '</div>' : '') +
        '<div class="soft-tools-gallery-grid" style="--soft-tools-gallery-columns:' + columns + ';--soft-tools-gallery-card-height:' + galleryCardHeight(columns) + 'px">' + state.images.map(function (image, index) {
          var badges = badgesForImage(image.id);
          var selected = state.gallerySelection && state.gallerySelection[image.id];
          var enhanced = image.enhanced ? " enhanced" : "";
          return '' +
            '<button type="button" class="soft-tools-gallery-card' + (selected ? " selected" : "") + enhanced + '" data-image-id="' + escapeHtml(image.id) + '">' +
              '<img src="' + imageUrl("preview", image) + '" alt="">' +
              '<span class="soft-tools-gallery-select" data-select-image-id="' + escapeHtml(image.id) + '" title="Вибрати для покращення">' + (selected ? '<i class="fa fa-check"></i>' : '') + '</span>' +
              (image.enhanced ? '<span class="soft-tools-gallery-enhanced" data-select-image-id="' + escapeHtml(image.id) + '">x4</span>' : '') +
              (badges.length ? '<span class="soft-tools-gallery-badges">' + badges.map(function (badge) {
                return '<span class="soft-tools-gcp-badge' + pointQualityClass(badge.point) + '">' + badge.number + '</span>';
              }).join("") + '</span>' : '') +
            '</button>';
        }).join("") + '</div>' +
      '</div>';
  }

  function renderGalleryPageV2() {
    var columns = normalizeGalleryColumns(state.galleryColumns);
    var hasReady = readyPointCount() > 0;
    var enhancedCount = enhancedImageCount();
    var markupBlocked = !canEnterMarkup();
    var prepLocked = !!state.preparationLocked;
    var prepareMode = state.phase === "prepare";
    var search = pointSearchState();
    var enhanceableSelectedCount = selectedEnhanceableImages().length;
    var selectedCount = enhanceableSelectedCount;
    var selectionLabel = state.enhancing ? ("Покращення " + currentEnhanceDone() + " / " + currentEnhanceTotal()) : (selectedCount + " вибрано");
    var title = prepareMode ? "Зображень: " + state.images.length : "Галерея розмітки: " + state.images.length;
    var enterMarkupHint = "Покращте всі кадри або скасуйте x4 перед переходом до прив'язки.";
    var columnOptions = "";
    for (var column = 2; column <= 8; column += 1) {
      columnOptions += '<option value="' + column + '"' + (column === columns ? " selected" : "") + '>' + column + '</option>';
    }
    var sortMode = normalizeGallerySort(state.gallerySort);
    var sortDirection = normalizeGallerySortDirection(state.gallerySortDirection);
    var sortOptions = [
      ["default", "Порядок"],
      ["name", "Назва"],
      ["date", "Дата"],
      ["similarity", "Схожість"]
    ].map(function (item) {
      return '<option value="' + item[0] + '"' + (sortMode === item[0] ? " selected" : "") + '>' + item[1] + '</option>';
    }).join("");

    var taskButton = '<button id="soft-tools-go-task" type="button" class="btn btn-default btn-sm" ' + (state.busy ? "disabled" : "") + '><i class="fa fa-arrow-left"></i> До задачі</button>';
    var primaryButton = prepareMode
      ? taskButton + '<span class="soft-tools-enter-markup-wrap" title="' + (markupBlocked ? escapeHtml(enterMarkupHint) : "") + '"><button id="soft-tools-enter-markup" type="button" class="btn btn-primary btn-sm" ' + (state.busy || markupBlocked ? "disabled" : "") + '>Перейти до прив\'язки</button></span>'
      : '<button id="soft-tools-go-task" type="button" class="btn btn-primary btn-sm" ' + (state.busy ? "disabled" : "") + '><i class="fa fa-arrow-left"></i> До задачі</button>';
    var prepareTools = prepareMode ? (
      '<div class="soft-tools-gallery-selection-tools">' +
        '<span class="soft-tools-gallery-selection-count">' + escapeHtml(selectionLabel) + '</span>' +
        '<label class="soft-tools-enhancement-mode" for="soft-tools-enhancement-mode">' +
          '<span>Покращення</span>' +
          '<select id="soft-tools-enhancement-mode" class="form-control input-sm" ' + (state.busy || prepLocked ? "disabled" : "") + '>' +
            '<option value="light"' + (normalizeEnhancementMode(state.enhancementMode) === "light" ? " selected" : "") + '>Легке</option>' +
            '<option value="medium"' + (normalizeEnhancementMode(state.enhancementMode) === "medium" ? " selected" : "") + '>Середнє</option>' +
            '<option value="maximum"' + (normalizeEnhancementMode(state.enhancementMode) === "maximum" ? " selected" : "") + '>Максимальне</option>' +
          '</select>' +
        '</label>' +
        '<button id="soft-tools-gallery-select-all" type="button" class="btn btn-default btn-sm" ' + (state.busy || enhancedCount === state.images.length || !state.images.length ? "disabled" : "") + '>Всі</button>' +
        '<button id="soft-tools-gallery-clear-selection" type="button" class="btn btn-default btn-sm" ' + (state.busy || !selectedCount ? "disabled" : "") + '>Очистити</button>' +
        '<button id="soft-tools-enhance-selected" type="button" class="btn btn-default btn-sm" ' + (state.busy || prepLocked || !enhanceableSelectedCount ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити вибрані</button>' +
        '<button id="soft-tools-enhance-all" type="button" class="btn btn-primary btn-sm" ' + (state.busy || prepLocked || enhancedCount === state.images.length || !state.images.length ? "disabled" : "") + '><i class="fa fa-magic"></i> Покращити всі</button>' +
        '<button id="soft-tools-restore-all" type="button" class="btn btn-default btn-sm" ' + (state.busy || prepLocked || !enhancedCount ? "disabled" : "") + '>Скасувати всі</button>' +
      '</div>'
    ) : "";
    var searchProgress = search.running && search.progress
      ? '<span class="soft-tools-point-search-progress">' + Number(search.progress.done || 0) + '/' + Number(search.progress.total || 0) + ((search.queue || []).length ? ' · черга ' + (search.queue || []).length : '') + '</span>'
      : '';
    var searchButtonLabel = search.running
      ? (search.choosingMethod ? "Скасувати вибір" : "Додати в чергу")
      : ((search.mode || search.choosingMethod) ? "Скинути пошук" : "Пошук точок");
    var stopSearchButton = search.running
      ? '<button id="soft-tools-stop-current-search" type="button" class="btn btn-default btn-sm">Зупинити пошук</button>'
      : '';
    var resetSearchButton = (!search.running && (search.mode || search.choosingMethod))
      ? '<button id="soft-tools-point-search-cancel" type="button" class="btn btn-default btn-sm">Скинути пошук</button>'
      : '';
    var searchTools = !prepareMode ? (
      '<div class="soft-tools-gallery-selection-tools">' +
        '<button id="soft-tools-point-search" type="button" class="btn btn-default btn-sm" ' + (!state.images.length ? "disabled" : "") + '><i class="fa fa-search"></i> ' + searchButtonLabel + '</button>' +
        searchProgress +
        stopSearchButton +
        resetSearchButton +
        (search.choosingMethod ? '<div class="soft-tools-point-search-menu">' +
          '<button type="button" class="btn btn-default btn-sm" data-point-search-method="sift" title="Краще тримає поворот, масштаб і складну перспективу">Точний (SIFT)</button>' +
          '<button type="button" class="btn btn-default btn-sm" data-point-search-method="akaze" title="Швидкий пошук для сусідніх фото і великих наборів">Швидкий (AKAZE)</button>' +
          '<button type="button" class="btn btn-default btn-sm" data-point-search-method="orb" title="Легкий базовий режим, якщо інші методи не підходять">Базовий (ORB)</button>' +
        '</div>' : '') +
      '</div>'
    ) : "";
    var sortTools = !prepareMode ? (
      '<div class="soft-tools-gallery-sort-tools">' +
        '<label class="soft-tools-gallery-sort" for="soft-tools-gallery-sort">' +
          '<span>Сортувати</span>' +
          '<select id="soft-tools-gallery-sort" class="form-control input-sm">' + sortOptions + '</select>' +
        '</label>' +
        '<button id="soft-tools-gallery-sort-direction" type="button" class="btn btn-default btn-sm soft-tools-icon-button" title="' + (sortDirection === "desc" ? "За спаданням" : "За зростанням") + '" aria-label="' + (sortDirection === "desc" ? "За спаданням" : "За зростанням") + '">' +
          '<i class="fa fa-sort-' + (sortDirection === "desc" ? "amount-desc" : "amount-asc") + '"></i>' +
        '</button>' +
        '<label class="soft-tools-gallery-points-first">' +
          '<input id="soft-tools-gallery-points-first" type="checkbox"' + (state.galleryPointsFirst ? " checked" : "") + '> ' +
          '<span>З точками зверху</span>' +
        '</label>' +
      '</div>'
    ) : "";
    var lockWarning = prepareMode && prepLocked
      ? '<div class="alert alert-warning soft-tools-alert">Покращення заблоковано: вже є GCP-позначки на кадрах.</div>'
      : '';
    var galleryImages = orderedGalleryImages();

    return '' +
      '<div class="soft-tools-gallery-page">' +
        '<div class="soft-tools-gallery-page-header">' +
          '<div class="soft-tools-gallery-title-wrap">' +
            primaryButton +
            '<h3>' + escapeHtml(title) + '</h3>' +
          '</div>' +
          '<div class="soft-tools-gallery-actions-row">' +
            prepareTools +
            searchTools +
            sortTools +
            '<label class="soft-tools-gallery-columns" for="soft-tools-gallery-columns">' +
              '<span>\u041a\u043e\u043b\u043e\u043d\u043a\u0438</span>' +
              '<select id="soft-tools-gallery-columns" class="form-control input-sm">' + columnOptions + '</select>' +
            '</label>' +
          '</div>' +
        '</div>' +
        (state.error ? '<div class="alert alert-danger soft-tools-alert">' + escapeHtml(state.error) + '</div>' : '') +
        (!state.error && state.message ? '<div class="alert alert-info soft-tools-alert">' + escapeHtml(state.message) + '</div>' : '') +
        lockWarning +
        '<div class="soft-tools-gallery-grid" style="--soft-tools-gallery-columns:' + columns + ';--soft-tools-gallery-card-height:' + galleryCardHeight(columns) + 'px">' + galleryImages.map(function (image) {
          var badges = badgesForImage(image.id);
          var selected = !image.enhanced && state.gallerySelection && state.gallerySelection[image.id];
          var processing = state.galleryProcessing && state.galleryProcessing[image.id] && !image.enhanced;
          var found = search.results && search.results[image.id];
          var searchClass = found ? " search-found" : (search.sourceImageId === image.id ? " search-source" : "");
          return '' +
            '<button type="button" class="soft-tools-gallery-card' + (selected ? " selected" : "") + (image.enhanced ? " enhanced" : "") + (processing ? " processing" : "") + searchClass + '" data-image-id="' + escapeHtml(image.id) + '">' +
              '<img src="' + imageUrl("preview", image) + '" alt="">' +
              (prepareMode && !image.enhanced && !processing ? '<span class="soft-tools-gallery-select" data-select-image-id="' + escapeHtml(image.id) + '" title="Вибрати для покращення">' + (selected ? '<i class="fa fa-check"></i>' : '') + '</span>' : '') +
              (processing ? '<span class="soft-tools-gallery-processing"><i class="fa fa-hourglass-half"></i></span>' : '') +
              (image.enhanced ? '<span class="soft-tools-gallery-enhanced">x4</span>' : '') +
              (found ? '<span class="soft-tools-gallery-found">' + found.count + '</span>' : '') +
              (badges.length ? '<span class="soft-tools-gallery-badges">' + badges.map(function (badge) {
                return '<span class="soft-tools-gcp-badge' + pointQualityClass(badge.point) + '">' + badge.number + '</span>';
              }).join("") + '</span>' : '') +
            '</button>';
        }).join("") + '</div>' +
      '</div>';
  }

  function pointHeaderSizeClass() {
    var count = state.points.length;
    if (count > 42) return " soft-tools-points-dense";
    if (count > 24) return " soft-tools-points-compact";
    if (count > 12) return " soft-tools-points-two-rows";
    return " soft-tools-points-one-row";
  }

  function renderPointRows() {
    if (!state.points.length) return '<div class="soft-tools-point-list soft-tools-point-list-empty"></div>';
    return '<div class="soft-tools-point-list">' + state.points.map(function (candidate, index) {
      var active = candidate.id === state.activePointId ? " active" : "";
      return '<button type="button" class="soft-tools-point-row' + active + pointQualityClass(candidate) + '" data-point-id="' + escapeHtml(candidate.id) + '">' +
        '<strong>' + (index + 1) + '</strong>' +
      '</button>';
    }).join("") + '</div>';
  }

  function formatOrthophotoLabel(item) {
    var date = item && item.created_at ? new Date(item.created_at) : null;
    if (date && !Number.isNaN(date.getTime())) {
      var year = date.getFullYear();
      var month = String(date.getMonth() + 1).padStart(2, "0");
      var day = String(date.getDate()).padStart(2, "0");
      var hours = String(date.getHours()).padStart(2, "0");
      var minutes = String(date.getMinutes()).padStart(2, "0");
      return "Task " + year + "-" + month + "-" + day + " " + hours + ":" + minutes;
    }
    return (item && item.task_name) || "Task";
  }

  function renderOrthophotoMenu() {
    var html = "";
    if (state.activeOrthophoto) {
      html += '<button type="button" class="soft-tools-orthophoto-option soft-tools-orthophoto-off" data-orthophoto-action="off">Вимкнути</button>';
    }
    if (state.orthophotosLoading) {
      html += '<span class="soft-tools-orthophoto-empty">Пошук...</span>';
    } else if (state.orthophotos.length) {
      html += state.orthophotos.map(function (item) {
        var active = state.activeOrthophoto && String(state.activeOrthophoto.id) === String(item.id) ? " active" : "";
        return '<button type="button" class="soft-tools-orthophoto-option' + active + '" data-orthophoto-id="' + escapeHtml(item.id) + '">' + escapeHtml(formatOrthophotoLabel(item)) + '</button>';
      }).join("");
    } else {
      html += '<span class="soft-tools-orthophoto-empty">Не знайдено</span>';
    }
    return html;
  }

  function renderComparePane() {
    var image = activeImage();
    if (!image) return '<div class="soft-tools-empty">Немає підготовлених зображень.</div>';
    var canCompareOriginal = !!(image.enhanced && image.original_preview);
    var split = Math.max(0, Math.min(100, Number(state.compareSplit || 50)));
    var compareView = normalizeCompareView(state.compareView);
    var aspectWidth = Number(image.preview_width || image.original_preview_width || 1);
    var aspectHeight = Number(image.preview_height || image.original_preview_height || 1);
    var aspectStyle = "--soft-tools-compare-aspect:" + aspectWidth + " / " + aspectHeight + ";";
    var transformStyle = "transform:" + compareTransformStyle(compareView);
    var zoomPercent = Math.round(compareView.scale * 100) + "%";
    var modeControls = canCompareOriginal
      ? '<span class="soft-tools-compare-note">До / після</span>'
      : '<span class="soft-tools-compare-note">' + (image.enhanced ? "Оригінальний preview ще не створено" : "Кадр ще не покращено") + '</span>';
    var zoomControls = '' +
      '<div class="soft-tools-compare-zoom">' +
        '<button id="soft-tools-compare-zoom-out" type="button" class="btn btn-default btn-sm" title="Віддалити" ' + (compareView.scale <= 1.001 ? "disabled" : "") + '><i class="fa fa-search-minus"></i></button>' +
        '<span class="soft-tools-compare-zoom-value">' + zoomPercent + '</span>' +
        '<button id="soft-tools-compare-zoom-in" type="button" class="btn btn-default btn-sm" title="Наблизити"><i class="fa fa-search-plus"></i></button>' +
        '<button id="soft-tools-compare-zoom-reset" type="button" class="btn btn-default btn-sm" title="Скинути масштаб" ' + (compareView.scale <= 1.001 && !compareView.panX && !compareView.panY ? "disabled" : "") + '><i class="fa fa-compress"></i></button>' +
      '</div>';
    var body = "";
    if (canCompareOriginal) {
      body = '' +
        '<div id="soft-tools-compare-viewport" class="soft-tools-compare-split" style="' + aspectStyle + '--soft-tools-compare-split:' + split + '%">' +
          '<div class="soft-tools-compare-content" style="' + transformStyle + '">' +
            '<span class="soft-tools-compare-label soft-tools-compare-label-before">Оригінал</span>' +
            '<span class="soft-tools-compare-label soft-tools-compare-label-after">x4</span>' +
            '<img class="soft-tools-compare-original" src="' + imageUrl("original_preview", image) + '" alt="">' +
            '<div class="soft-tools-compare-after">' +
              '<img src="' + imageUrl("preview", image) + '" alt="">' +
            '</div>' +
            '<button id="soft-tools-compare-divider" type="button" aria-label="Порівняння до і після"><span></span></button>' +
          '</div>' +
        '</div>';
    } else {
      body = '<div id="soft-tools-compare-viewport" class="soft-tools-compare-single-wrap" style="' + aspectStyle + '"><div class="soft-tools-compare-content" style="' + transformStyle + '"><img class="soft-tools-compare-single" src="' + imageUrl("preview", image) + '" alt=""></div></div>';
    }

    return '' +
      '<div class="soft-tools-compare-page">' +
        '<div class="soft-tools-pane-header soft-tools-compare-header">' +
          '<button id="soft-tools-back-gallery" type="button" class="btn btn-default btn-sm"><i class="fa fa-th"></i> Галерея</button>' +
          modeControls +
          zoomControls +
        '</div>' +
        '<div class="soft-tools-compare-stage">' + body + '</div>' +
      '</div>';
  }

  function renderImagePane() {
    var image = activeImage();
    if (!image) return '<div class="soft-tools-empty">Немає підготовлених зображень.</div>';
    var imageView = state.imageView || { scale: 1, panX: 0, panY: 0 };
    var previewWidth = Number(image.preview_width || image.width || 1);
    var previewHeight = Number(image.preview_height || image.height || 1);
    var imageWidth = previewWidth * imageView.scale;
    var imageHeight = previewHeight * imageView.scale;
    var search = pointSearchState();
    var searchCandidates = (search.candidates && search.candidates[image.id]) || [];
    var dots = observationsForImage(image.id).map(function (entry) {
      var previewX = entry.observation.px / Number(image.scale_x || 1);
      var previewY = entry.observation.py / Number(image.scale_y || 1);
      var left = previewX * imageView.scale;
      var top = previewY * imageView.scale;
      var active = entry.point.id === state.activePointId ? " active" : "";
      var number = state.points.findIndex(function (point) { return point.id === entry.point.id; }) + 1;
      return '<span class="soft-tools-observation-dot' + active + pointQualityClass(entry.point) + '" data-point-id="' + escapeHtml(entry.point.id) + '" data-preview-x="' + previewX + '" data-preview-y="' + previewY + '" style="left:' + left + 'px;top:' + (top - 24) + 'px"><span class="soft-tools-pin-label">' + number + '</span></span>' +
        (active ? '<button type="button" class="soft-tools-observation-delete" data-point-id="' + escapeHtml(entry.point.id) + '" data-image-id="' + escapeHtml(image.id) + '" data-preview-x="' + previewX + '" data-preview-y="' + previewY + '" style="left:' + left + 'px;top:' + top + 'px">Видалити</button>' : '');
    }).join("") + searchCandidates.map(function (candidate) {
      var previewX = Number(candidate.px) / Number(image.scale_x || 1);
      var previewY = Number(candidate.py) / Number(image.scale_y || 1);
      var left = previewX * imageView.scale;
      var top = previewY * imageView.scale;
      return '<button type="button" class="soft-tools-suggested-dot" data-point-id="' + escapeHtml(candidate.point_id) + '" data-image-id="' + escapeHtml(image.id) + '" data-px="' + escapeHtml(candidate.px) + '" data-py="' + escapeHtml(candidate.py) + '" data-preview-x="' + previewX + '" data-preview-y="' + previewY + '" title="Підтвердити знайдену точку" style="left:' + left + 'px;top:' + (top - 24) + 'px"><span class="soft-tools-pin-label">' + escapeHtml(candidate.point_number) + '</span></button>';
    }).join("");

    return '' +
      '<div class="soft-tools-pane-header soft-tools-image-header' + pointHeaderSizeClass() + '">' +
        '<button id="soft-tools-back-gallery" type="button" class="btn btn-default btn-sm"><i class="fa fa-th"></i> Галерея</button>' +
        renderPointRows() +
        '<button id="soft-tools-add-point" type="button" class="btn btn-default soft-tools-icon-button" title="Створити точку" aria-label="Створити точку"><i class="fa fa-plus" aria-hidden="true"></i></button>' +
      '</div>' +
      '<div id="soft-tools-image-stage" class="soft-tools-image-stage">' +
        '<div class="soft-tools-image-wrap" style="width:' + imageWidth + 'px;height:' + imageHeight + 'px">' +
          '<img id="soft-tools-active-image" src="' + imageUrl("preview", image) + '" alt="" draggable="false">' +
          dots +
        '</div>' +
      '</div>';
  }

  function renderMapHeader() {
    var hasReady = readyPointCount() > 0;
    var saveStatusClass = " " + (state.saveStatus || "saved");
    var headerMessage = state.error || state.message || "";
    var headerMessageClass = state.error ? " error" : (state.message ? " info" : "");
    var layerOptions = BASE_MAP_NAMES.map(function (name) {
      var active = name === state.activeBaseMap ? " active" : "";
      return '<button type="button" class="soft-tools-map-layer-option' + active + '" data-layer-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
    }).join("");
    return '' +
      '<div class="soft-tools-pane-header soft-tools-map-header' + pointHeaderSizeClass() + '">' +
        '<div class="soft-tools-save-status' + saveStatusClass + '" title="' + escapeHtml(state.saveError || "") + '">' + escapeHtml(saveStatusLabel()) + '</div>' +
        '<div class="soft-tools-map-header-message' + headerMessageClass + '" title="' + escapeHtml(headerMessage) + '">' + escapeHtml(headerMessage) + '</div>' +
        '<div class="soft-tools-map-header-actions">' +
          '<div class="soft-tools-orthophoto-picker">' +
            '<button id="soft-tools-orthophoto-toggle" type="button" class="btn btn-default soft-tools-icon-button soft-tools-orthophoto-toggle" title="Ортофото" aria-expanded="false"><i class="fa fa-image"></i></button>' +
            '<div class="soft-tools-orthophoto-menu">' + renderOrthophotoMenu() + '</div>' +
          '</div>' +
          '<div class="soft-tools-map-layer-picker">' +
            '<button id="soft-tools-map-layer-toggle" type="button" class="btn btn-default soft-tools-icon-button" title="Обрати карту" aria-expanded="false"><i class="fa fa-map"></i></button>' +
            '<div class="soft-tools-map-layer-menu">' + layerOptions + '</div>' +
          '</div>' +
          '<button id="soft-tools-download-gcp" type="button" class="btn btn-default soft-tools-icon-button" title="Завантажити GCP" ' + (state.busy || !hasReady ? "disabled" : "") + '><i class="fa fa-download"></i></button>' +
        '</div>' +
      '</div>';
  }

  function renderMapPane() {
    var leafletOk = !!window.L;
    return '' +
      renderMapHeader() +
      (leafletOk
        ? '<div id="soft-tools-map" class="soft-tools-map"></div>'
        : '<div class="soft-tools-map-unavailable">Leaflet не завантажився на цій сторінці WebODM.</div>');
  }

  function getBaseMapNativeZoom(url, fallbackZoom) {
    var value = String(url || "");
    if (/World_Imagery\/MapServer/i.test(value)) return 17;
    if (/World_Street_Map\/MapServer/i.test(value)) return 17;
    if (/World_Topo_Map\/MapServer/i.test(value)) return 16;
    if (/World_Terrain_Base\/MapServer/i.test(value)) return 13;
    if (/NatGeo_World_Map\/MapServer/i.test(value)) return 13;
    if (/Canvas\/World_(Light|Dark)_Gray_Base\/MapServer/i.test(value)) return 16;
    if (/opentopomap\.org/i.test(value)) return 17;
    if (/openstreetmap\.de/i.test(value)) return 18;
    if (/tile\.openstreetmap\.org|openstreetmap\.fr\/hot/i.test(value)) return 19;
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
        maxZoom: 16
      }),
      "Esri Terrain": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 13
      }),
      "Esri NatGeo": createBaseTileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 13
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
        attribution: "&copy; OpenStreetMap contributors, HOT",
        maxZoom: 19
      }),
      "OpenStreetMap DE": createBaseTileLayer("https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 18
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
      "Voyager": createBaseTileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        maxZoom: 19,
        subdomains: "abcd"
      })
    };
  }

  function updateMapLayerPicker(name) {
    var toggle = document.getElementById("soft-tools-map-layer-toggle");
    if (toggle) toggle.setAttribute("title", "Карта: " + name);
    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-map-layer-option"), function (button) {
      button.classList.toggle("active", button.getAttribute("data-layer-name") === name);
    });
  }

  function setBaseMap(name) {
    var baseLayers = createBaseMapLayers();
    var nextLayer = baseLayers[name] || baseLayers["Esri Satellite"] || baseLayers.OpenStreetMap;
    if (!nextLayer) return;
    if (map && baseLayer) map.removeLayer(baseLayer);
    baseLayer = nextLayer;
    state.activeBaseMap = name;
    if (map) baseLayer.addTo(map);
    updateMapLayerPicker(name);
  }

  function mapBboxParam() {
    if (!map) return "";
    var bounds = map.getBounds();
    return [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
    ].join(",");
  }

  function syncOrthophotoLayer() {
    if (!map) return;
    var nextKey = state.activeOrthophoto && state.activeOrthophoto.tile_url
      ? String(state.activeOrthophoto.id || "") + "|" + String(state.activeOrthophoto.tile_url)
      : "";
    if (nextKey && nextKey === orthophotoLayerKey && orthophotoLayer) return;
    if (!nextKey && !orthophotoLayer && orthophotoLayerKey === "") return;
    if (orthophotoLayer) {
      map.removeLayer(orthophotoLayer);
      orthophotoLayer = null;
    }
    orthophotoLayerKey = nextKey;
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
    var menu = root.querySelector(".soft-tools-orthophoto-menu");
    if (!menu) return;
    menu.innerHTML = renderOrthophotoMenu();
    bindOrthophotoMenuEvents();
  }

  function loadOrthophotosForCurrentBounds() {
    var bbox = mapBboxParam();
    if (!bbox) return;
    state.orthophotosLoading = true;
    updateOrthophotoMenuDom();
    requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/orthophotos/?bbox=" + encodeURIComponent(bbox))
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

  function setOrthophoto(item) {
    var picker = root.querySelector(".soft-tools-orthophoto-picker");
    var toggle = document.getElementById("soft-tools-orthophoto-toggle");
    if (picker) picker.classList.remove("open");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    setState({
      activeOrthophoto: item,
      message: item ? formatOrthophotoLabel(item) : "Ортофото вимкнено.",
      error: "",
      mapView: captureMapView()
    });
  }

  function destroyMap() {
    if (map) {
      try {
        map.remove();
      } catch (_) {}
    }
    map = null;
    mapMarkers = [];
    baseLayer = null;
    orthophotoLayer = null;
    orthophotoLayerKey = "";
  }

  function syncMap() {
    var mapElement = document.getElementById("soft-tools-map");
    if (!window.L || !mapElement) return;
    var center = state.mapView;

    if (map && map.getContainer && map.getContainer() !== mapElement) {
      destroyMap();
    }

    if (!map) {
      map = L.map(mapElement, {
        zoomControl: true,
        attributionControl: true
      }).setView([center.lat, center.lng], center.zoom);

      var baseLayers = createBaseMapLayers();
      var activeBaseMap = baseLayers[state.activeBaseMap] ? state.activeBaseMap : (baseLayers["Esri Satellite"] ? "Esri Satellite" : "OpenStreetMap");
      baseLayer = baseLayers[activeBaseMap];
      state.activeBaseMap = activeBaseMap;
      if (baseLayer) baseLayer.addTo(map);

      map.on("click", function (event) {
        setActivePointMapCoordinate(event.latlng.lat, event.latlng.lng);
      });

      map.on("moveend", function () {
        var c = map.getCenter();
        state.mapView = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
      });
    }

    updateMapLayerPicker(state.activeBaseMap);
    syncOrthophotoLayer();

    mapMarkers.forEach(function (marker) {
      try {
        map.removeLayer(marker);
      } catch (_) {}
    });
    mapMarkers = [];

    state.points.forEach(function (candidate, index) {
      if (!pointHasMap(candidate)) return;
      var markerNumber = index + 1;
      var active = candidate.id === state.activePointId;
      var markerAction = "";
      if (active && pointHasObservation(candidate)) {
        markerAction = '<span class="soft-tools-map-delete-hint">Спочатку видаліть позначки на кадрах</span>';
      } else if (active) {
        markerAction = '<button type="button" class="soft-tools-map-delete" data-point-id="' + escapeHtml(candidate.id) + '">Видалити</button>';
      }
      var marker = L.marker([parseNumber(candidate.y), parseNumber(candidate.x)], {
        icon: L.divIcon({
          className: "soft-tools-map-marker-wrap",
          html: '<span class="soft-tools-map-marker' + (active ? ' active' : '') + pointQualityClass(candidate) + '"><span class="soft-tools-pin-label">' + markerNumber + '</span></span>' + markerAction,
          iconSize: [28, 34],
          iconAnchor: [14, 34]
        }),
        draggable: true,
        interactive: true
      }).addTo(map);
      marker.on("click", function (event) {
        if (window.L && L.DomEvent && event.originalEvent) L.DomEvent.stop(event.originalEvent);
        if (bindActiveImageDraftToMapPoint(candidate.id)) return;
        setState({ activePointId: candidate.id, mapView: captureMapView() });
      });
      var markerElement = marker.getElement ? marker.getElement() : marker._icon;
      var deleteButton = markerElement ? markerElement.querySelector(".soft-tools-map-delete") : null;
      if (deleteButton) {
        deleteButton.addEventListener("pointerdown", function (event) {
          if (window.L && L.DomEvent) L.DomEvent.stop(event);
          else {
            event.preventDefault();
            event.stopPropagation();
          }
        });
        deleteButton.addEventListener("click", function (event) {
          if (window.L && L.DomEvent) L.DomEvent.stop(event);
          else {
            event.preventDefault();
            event.stopPropagation();
          }
          removeMapPoint(candidate.id);
        });
      }
      marker.on("dragend", function () {
        var latLng = marker.getLatLng();
        var view = captureMapView();
        var nextPoints = state.points.map(function (point) {
          if (point.id !== candidate.id) return point;
          return withPointStatus(Object.assign({}, point, {
            x: Number(latLng.lng).toFixed(8),
            y: Number(latLng.lat).toFixed(8),
            z: point.z || "0"
          }));
        });
        setState({
          points: nextPoints,
          activePointId: candidate.id,
          mapView: view,
          error: "",
          message: "Координату на карті оновлено."
        }, { persist: true });
      });
      mapMarkers.push(marker);
    });

    setTimeout(function () {
      if (map) map.invalidateSize();
    }, 0);
  }

  function applyImageView(view) {
    var wrap = root.querySelector(".soft-tools-image-wrap");
    var image = activeImage();
    state.imageView = view;
    if (wrap && image) {
      wrap.style.width = (Number(image.preview_width || image.width || 1) * view.scale) + "px";
      wrap.style.height = (Number(image.preview_height || image.height || 1) * view.scale) + "px";
    }
    updateObservationDotPositions();
  }

  function updateObservationDotPositions() {
    var scale = (state.imageView || {}).scale || 1;
    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-observation-dot, .soft-tools-observation-delete, .soft-tools-suggested-dot"), function (control) {
      var previewX = Number(control.getAttribute("data-preview-x"));
      var previewY = Number(control.getAttribute("data-preview-y"));
      if (!Number.isFinite(previewX) || !Number.isFinite(previewY)) return;
      control.style.left = (previewX * scale) + "px";
      control.style.top = ((previewY * scale) - (control.classList.contains("soft-tools-observation-delete") ? 0 : 24)) + "px";
    });
  }

  function bindImageViewport() {
    var stage = document.getElementById("soft-tools-image-stage");
    var image = document.getElementById("soft-tools-active-image");
    if (!stage || !image) return;
    stage.scrollLeft = (state.imageView || {}).panX || 0;
    stage.scrollTop = (state.imageView || {}).panY || 0;

    stage.addEventListener("wheel", function (event) {
      event.preventDefault();
      var current = (state.imageView || {}).scale || 1;
      setImageZoom(current * (event.deltaY < 0 ? 1.12 : 0.89), {
        clientX: event.clientX,
        clientY: event.clientY
      });
    }, { passive: false });

    stage.addEventListener("click", function (event) {
      if (!suppressNextImageClick) return;
      suppressNextImageClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    stage.addEventListener("click", addObservation);

    stage.addEventListener("scroll", function () {
      state.imageView = Object.assign({}, state.imageView || { scale: 1 }, {
        panX: stage.scrollLeft,
        panY: stage.scrollTop
      });
    });

    stage.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.pointerType === "touch") return;
      if (event.target && event.target.closest && event.target.closest(".soft-tools-observation-dot, .soft-tools-observation-delete, .soft-tools-suggested-dot")) return;
      var lastX = event.clientX;
      var lastY = event.clientY;
      var moved = false;
      if (stage.setPointerCapture) {
        try { stage.setPointerCapture(event.pointerId); } catch (_) {}
      }
      stage.classList.add("panning");

      function onMove(moveEvent) {
        if (moveEvent.pointerId !== event.pointerId) return;
        var dx = moveEvent.clientX - lastX;
        var dy = moveEvent.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        stage.scrollLeft -= dx;
        stage.scrollTop -= dy;
        state.imageView = Object.assign({}, state.imageView || { scale: 1 }, {
          panX: stage.scrollLeft,
          panY: stage.scrollTop
        });
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
      }

      function onUp(upEvent) {
        if (upEvent.pointerId !== event.pointerId) return;
        stage.removeEventListener("pointermove", onMove);
        stage.removeEventListener("pointerup", onUp);
        stage.removeEventListener("pointercancel", onUp);
        if (stage.releasePointerCapture) {
          try { stage.releasePointerCapture(event.pointerId); } catch (_) {}
        }
        stage.classList.remove("panning");
        if (moved) {
          suppressNextImageClick = true;
          window.setTimeout(function () { suppressNextImageClick = false; }, 250);
        }
      }

      stage.addEventListener("pointermove", onMove);
      stage.addEventListener("pointerup", onUp);
      stage.addEventListener("pointercancel", onUp);
    });
  }

  function bindObservationDragging() {
    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-observation-dot"), function (dot) {
      dot.addEventListener("pointerdown", function (event) {
        if (event.button !== 0 || event.pointerType === "touch") return;
        event.preventDefault();
        event.stopPropagation();

        var pointId = dot.getAttribute("data-point-id");
        var image = activeImage();
        var moved = false;
        var lastCoordinates = null;
        if (dot.setPointerCapture) {
          try { dot.setPointerCapture(event.pointerId); } catch (_) {}
        }

        function onMove(moveEvent) {
          if (moveEvent.pointerId !== event.pointerId) return;
          moved = true;
          lastCoordinates = imageCoordinatesFromClient(moveEvent.clientX, moveEvent.clientY);
          if (!lastCoordinates || !image) return;
          dot.setAttribute("data-preview-x", String(lastCoordinates.px / Number(image.scale_x || 1)));
          dot.setAttribute("data-preview-y", String(lastCoordinates.py / Number(image.scale_y || 1)));
          updateObservationDotPositions();
        }

        function onUp(upEvent) {
          if (upEvent.pointerId !== event.pointerId) return;
          dot.removeEventListener("pointermove", onMove);
          dot.removeEventListener("pointerup", onUp);
          dot.removeEventListener("pointercancel", onUp);
          if (dot.releasePointerCapture) {
            try { dot.releasePointerCapture(event.pointerId); } catch (_) {}
          }
          if (!moved || !lastCoordinates || !image) {
            setState({ activePointId: pointId, mapView: captureMapView() });
            return;
          }
          dot.setAttribute("data-dragged", "1");
          setState({
            points: updatePointObservation(pointId, image.id, lastCoordinates.px, lastCoordinates.py),
            activePointId: pointId,
            error: "",
            message: "Позначку на фото оновлено."
          }, { persist: true });
        }

        dot.addEventListener("pointermove", onMove);
        dot.addEventListener("pointerup", onUp);
        dot.addEventListener("pointercancel", onUp);
      });
    });
  }

  function bindOrthophotoMenuEvents() {
    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-orthophoto-option"), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (button.getAttribute("data-orthophoto-action") === "off") {
          setOrthophoto(null);
          return;
        }
        var id = button.getAttribute("data-orthophoto-id");
        var item = state.orthophotos.find(function (candidate) {
          return String(candidate.id) === String(id);
        });
        if (item) setOrthophoto(item);
      });
    });
  }

  function bindEvents() {
    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-thumb"), function (button) {
      button.addEventListener("click", function () {
        openImage(button.getAttribute("data-image-id"));
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-gallery-card"), function (button) {
      button.addEventListener("click", function () {
        var imageId = button.getAttribute("data-image-id");
        if (pointSearchState().mode) {
          runPointSearch(imageId);
          return;
        }
        openImage(imageId);
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-gallery-select"), function (control) {
      control.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.phase !== "prepare") return;
        toggleGallerySelection(control.getAttribute("data-select-image-id"));
      });
    });

    var galleryColumns = document.getElementById("soft-tools-gallery-columns");
    if (galleryColumns) {
      galleryColumns.addEventListener("change", function () {
        var columns = normalizeGalleryColumns(galleryColumns.value);
        storeGalleryColumns(columns);
        setState({ galleryColumns: columns });
      });
    }

    var gallerySort = document.getElementById("soft-tools-gallery-sort");
    if (gallerySort) {
      gallerySort.addEventListener("change", function () {
        var sort = normalizeGallerySort(gallerySort.value);
        storeGallerySort(sort);
        setState({ gallerySort: sort });
      });
    }

    var gallerySortDirection = document.getElementById("soft-tools-gallery-sort-direction");
    if (gallerySortDirection) {
      gallerySortDirection.addEventListener("click", function () {
        var direction = normalizeGallerySortDirection(state.gallerySortDirection) === "desc" ? "asc" : "desc";
        storeGallerySortDirection(direction);
        setState({ gallerySortDirection: direction });
      });
    }

    var galleryPointsFirst = document.getElementById("soft-tools-gallery-points-first");
    if (galleryPointsFirst) {
      galleryPointsFirst.addEventListener("change", function () {
        var enabled = !!galleryPointsFirst.checked;
        storeGalleryPointsFirst(enabled);
        setState({ galleryPointsFirst: enabled });
      });
    }

    var goTaskButton = document.getElementById("soft-tools-go-task");
    if (goTaskButton) goTaskButton.addEventListener("click", goToTask);

    var enterMarkupButton = document.getElementById("soft-tools-enter-markup");
    if (enterMarkupButton) enterMarkupButton.addEventListener("click", enterMarkup);

    var selectAllButton = document.getElementById("soft-tools-gallery-select-all");
    if (selectAllButton) selectAllButton.addEventListener("click", selectAllGalleryImages);

    var clearSelectionButton = document.getElementById("soft-tools-gallery-clear-selection");
    if (clearSelectionButton) clearSelectionButton.addEventListener("click", clearGallerySelection);

    var enhancementMode = document.getElementById("soft-tools-enhancement-mode");
    if (enhancementMode) {
      enhancementMode.addEventListener("change", function () {
        var mode = normalizeEnhancementMode(enhancementMode.value);
        storeEnhancementMode(mode);
        setState({ enhancementMode: mode, message: "", error: "" });
      });
    }

    var enhanceSelectedButton = document.getElementById("soft-tools-enhance-selected");
    if (enhanceSelectedButton) enhanceSelectedButton.addEventListener("click", function () { enhanceImages(false); });

    var enhanceAllButton = document.getElementById("soft-tools-enhance-all");
    if (enhanceAllButton) enhanceAllButton.addEventListener("click", function () { enhanceImages(true); });

    var restoreAllButton = document.getElementById("soft-tools-restore-all");
    if (restoreAllButton) restoreAllButton.addEventListener("click", function () { restoreImages(true); });

    var pointSearchButton = document.getElementById("soft-tools-point-search");
    if (pointSearchButton) pointSearchButton.addEventListener("click", startPointSearchMode);

    var stopCurrentSearchButton = document.getElementById("soft-tools-stop-current-search");
    if (stopCurrentSearchButton) stopCurrentSearchButton.addEventListener("click", stopCurrentPointSearch);

    var pointSearchCancelButton = document.getElementById("soft-tools-point-search-cancel");
    if (pointSearchCancelButton) pointSearchCancelButton.addEventListener("click", resetPointSearch);

    Array.prototype.forEach.call(root.querySelectorAll("[data-point-search-method]"), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        choosePointSearchMethod(button.getAttribute("data-point-search-method"));
      });
    });

    var compareViewport = document.getElementById("soft-tools-compare-viewport");
    var compareDivider = document.getElementById("soft-tools-compare-divider");
    var compareContent = root.querySelector(".soft-tools-compare-content");
    var compareZoomOut = document.getElementById("soft-tools-compare-zoom-out");
    var compareZoomIn = document.getElementById("soft-tools-compare-zoom-in");
    var compareZoomReset = document.getElementById("soft-tools-compare-zoom-reset");
    if (compareZoomOut) compareZoomOut.addEventListener("click", function () { setCompareZoom((state.compareView || { scale: 1 }).scale / 1.25); });
    if (compareZoomIn) compareZoomIn.addEventListener("click", function () { setCompareZoom((state.compareView || { scale: 1 }).scale * 1.25); });
    if (compareZoomReset) compareZoomReset.addEventListener("click", function () { applyCompareView({ scale: 1, panX: 0, panY: 0 }); });
    if (compareViewport) {
      compareViewport.addEventListener("wheel", function (event) {
        event.preventDefault();
        var current = normalizeCompareView(state.compareView);
        setCompareZoom(current.scale * (event.deltaY < 0 ? 1.15 : 0.87), {
          clientX: event.clientX,
          clientY: event.clientY
        });
      }, { passive: false });

      compareViewport.addEventListener("pointerdown", function (event) {
        if (event.button !== 0 || (event.target && event.target.closest && event.target.closest("#soft-tools-compare-divider"))) return;
        var current = normalizeCompareView(state.compareView);
        if (current.scale <= 1.001) return;
        event.preventDefault();
        var startX = event.clientX;
        var startY = event.clientY;
        var startView = current;
        compareViewport.classList.add("panning");
        if (compareViewport.setPointerCapture) {
          try { compareViewport.setPointerCapture(event.pointerId); } catch (_) {}
        }

        function onMove(moveEvent) {
          if (moveEvent.pointerId !== event.pointerId) return;
          applyCompareView({
            scale: startView.scale,
            panX: startView.panX + moveEvent.clientX - startX,
            panY: startView.panY + moveEvent.clientY - startY
          });
        }

        function onUp(upEvent) {
          if (upEvent.pointerId !== event.pointerId) return;
          compareViewport.removeEventListener("pointermove", onMove);
          compareViewport.removeEventListener("pointerup", onUp);
          compareViewport.removeEventListener("pointercancel", onUp);
          if (compareViewport.releasePointerCapture) {
            try { compareViewport.releasePointerCapture(event.pointerId); } catch (_) {}
          }
          compareViewport.classList.remove("panning");
        }

        compareViewport.addEventListener("pointermove", onMove);
        compareViewport.addEventListener("pointerup", onUp);
        compareViewport.addEventListener("pointercancel", onUp);
      });
    }
    if (compareDivider && compareViewport) {
      function moveCompareDivider(event) {
        var rect = (compareContent || compareViewport).getBoundingClientRect();
        if (!rect.width) return;
        var percent = ((event.clientX - rect.left) / rect.width) * 100;
        state.compareSplit = Math.max(0, Math.min(100, percent));
        compareViewport.style.setProperty("--soft-tools-compare-split", state.compareSplit + "%");
      }

      compareDivider.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        event.stopPropagation();
        moveCompareDivider(event);
        if (compareDivider.setPointerCapture) {
          try { compareDivider.setPointerCapture(event.pointerId); } catch (_) {}
        }

        function onMove(moveEvent) {
          if (moveEvent.pointerId !== event.pointerId) return;
          moveCompareDivider(moveEvent);
        }

        function onUp(upEvent) {
          if (upEvent.pointerId !== event.pointerId) return;
          compareDivider.removeEventListener("pointermove", onMove);
          compareDivider.removeEventListener("pointerup", onUp);
          compareDivider.removeEventListener("pointercancel", onUp);
          if (compareDivider.releasePointerCapture) {
            try { compareDivider.releasePointerCapture(event.pointerId); } catch (_) {}
          }
        }

        compareDivider.addEventListener("pointermove", onMove);
        compareDivider.addEventListener("pointerup", onUp);
        compareDivider.addEventListener("pointercancel", onUp);
      });
    }

    var activeImageElement = document.getElementById("soft-tools-active-image");
    if (activeImageElement) activeImageElement.addEventListener("dragstart", function (event) { event.preventDefault(); });
    if (activeImageElement) activeImageElement.addEventListener("load", updateObservationDotPositions);

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-observation-dot"), function (dot) {
      dot.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (dot.getAttribute("data-dragged") === "1") {
          dot.setAttribute("data-dragged", "0");
          return;
        }
        setState({ activePointId: dot.getAttribute("data-point-id"), mapView: captureMapView() });
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-observation-delete"), function (button) {
      button.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        removeObservationFromImage(button.getAttribute("data-point-id"), button.getAttribute("data-image-id"));
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-suggested-dot"), function (button) {
      button.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        acceptPointSearchCandidate(
          button.getAttribute("data-point-id"),
          button.getAttribute("data-image-id"),
          Number(button.getAttribute("data-px")),
          Number(button.getAttribute("data-py"))
        );
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-point-row"), function (button) {
      button.addEventListener("click", function () {
        setState({ activePointId: button.getAttribute("data-point-id"), mapView: captureMapView(), message: "", error: "" });
      });
    });

    bindObservationDragging();
    bindImageViewport();
    updateObservationDotPositions();

    var backGalleryButton = document.getElementById("soft-tools-back-gallery");
    if (backGalleryButton) backGalleryButton.addEventListener("click", openGallery);

    var addButton = document.getElementById("soft-tools-add-point");
    if (addButton) addButton.addEventListener("click", addPoint);

    var orthophotoToggle = document.getElementById("soft-tools-orthophoto-toggle");
    var orthophotoPicker = root.querySelector(".soft-tools-orthophoto-picker");
    if (orthophotoToggle && orthophotoPicker) {
      orthophotoToggle.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var open = !orthophotoPicker.classList.contains("open");
        orthophotoPicker.classList.toggle("open", open);
        orthophotoToggle.setAttribute("aria-expanded", open ? "true" : "false");
        var mapLayerPicker = root.querySelector(".soft-tools-map-layer-picker");
        var mapLayerToggle = document.getElementById("soft-tools-map-layer-toggle");
        if (open && mapLayerPicker) mapLayerPicker.classList.remove("open");
        if (open && mapLayerToggle) mapLayerToggle.setAttribute("aria-expanded", "false");
        if (open) loadOrthophotosForCurrentBounds();
      });
    }
    bindOrthophotoMenuEvents();

    var mapLayerToggle = document.getElementById("soft-tools-map-layer-toggle");
    var mapLayerPicker = root.querySelector(".soft-tools-map-layer-picker");
    if (mapLayerToggle && mapLayerPicker) {
      mapLayerToggle.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var open = !mapLayerPicker.classList.contains("open");
        mapLayerPicker.classList.toggle("open", open);
        mapLayerToggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (open && orthophotoPicker) orthophotoPicker.classList.remove("open");
        if (open && orthophotoToggle) orthophotoToggle.setAttribute("aria-expanded", "false");
      });
    }

    Array.prototype.forEach.call(root.querySelectorAll(".soft-tools-map-layer-option"), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        setBaseMap(button.getAttribute("data-layer-name"));
        if (mapLayerPicker) mapLayerPicker.classList.remove("open");
        if (mapLayerToggle) mapLayerToggle.setAttribute("aria-expanded", "false");
      });
    });

    var workspace = root.querySelector(".soft-tools-workspace");
    if (workspace && (mapLayerPicker || orthophotoPicker) && workspace.getAttribute("data-soft-tools-bound") !== "1") {
      workspace.setAttribute("data-soft-tools-bound", "1");
      workspace.addEventListener("click", function (event) {
        if (event.target.closest(".soft-tools-map-layer-picker")) return;
        if (event.target.closest(".soft-tools-orthophoto-picker")) return;
        var currentMapLayerPicker = root.querySelector(".soft-tools-map-layer-picker");
        var currentMapLayerToggle = document.getElementById("soft-tools-map-layer-toggle");
        var currentOrthophotoPicker = root.querySelector(".soft-tools-orthophoto-picker");
        var currentOrthophotoToggle = document.getElementById("soft-tools-orthophoto-toggle");
        if (currentMapLayerPicker) currentMapLayerPicker.classList.remove("open");
        if (currentMapLayerToggle) currentMapLayerToggle.setAttribute("aria-expanded", "false");
        if (currentOrthophotoPicker) currentOrthophotoPicker.classList.remove("open");
        if (currentOrthophotoToggle) currentOrthophotoToggle.setAttribute("aria-expanded", "false");
      });
    }

    var downloadButton = document.getElementById("soft-tools-download-gcp");
    if (downloadButton) downloadButton.addEventListener("click", function () { generateGcp(true); });

  }

  function render() {
    if (state.viewMode !== "detail") {
      destroyMap();
    }

    if (state.viewMode === "gallery") {
      root.innerHTML = renderGalleryPageV2();
    } else if (state.viewMode === "compare") {
      root.innerHTML = renderComparePane();
    } else if (renderedViewMode === "detail" && root.querySelector(".soft-tools-review.detail")) {
      var imagePane = root.querySelector(".soft-tools-image-pane");
      var mapHeader = root.querySelector(".soft-tools-map-header");
      if (imagePane) imagePane.innerHTML = renderImagePane();
      if (mapHeader) mapHeader.outerHTML = renderMapHeader();
    } else {
      root.innerHTML = '' +
        '<div class="soft-tools-review detail">' +
          '<main class="soft-tools-workspace">' +
            '<section class="soft-tools-image-pane">' + renderImagePane() + '</section>' +
            '<section class="soft-tools-map-pane">' + renderMapPane() + '</section>' +
          '</main>' +
        '</div>';
    }
    renderedViewMode = state.viewMode;
    bindEvents();
    syncMap();
    restoreGalleryScroll();
  }

  root.innerHTML = '<div class="alert alert-info">Завантаження Soft Tools...</div>';
  requestJson("/plugins/Smartpoint/api/session/" + encodeURIComponent(sessionId) + "/")
    .then(function (session) {
      state.session = session;
      state.images = session.images || [];
      state.activeImageId = state.images.length ? state.images[0].id : null;
      state.points = (session.points || []).map(withPointStatus);
      state.elevation = session.elevation || null;
      var incompletePoint = state.points.find(function (point) { return !pointIsReady(point); });
      state.activePointId = incompletePoint ? incompletePoint.id : (state.points.length ? state.points[0].id : null);
      state.rawSrs = session.raw_srs || "EPSG:4326";
      state.preparationLocked = !!session.preparation_locked;
      state.message = session.message || "";
      render();
      pollEnhanceStatus();
    })
    .catch(function (error) {
      root.innerHTML = '<div class="alert alert-danger">' + escapeHtml(error.message || String(error)) + '</div>';
    });
})();
