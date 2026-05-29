import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
import gzip
import hashlib
import struct
import tempfile
import zipfile
from urllib.parse import urlencode
from urllib.request import urlopen
from io import BytesIO
from datetime import datetime
from pathlib import Path

from app import models
from app.api.common import check_project_perms, get_and_check_project
from app.plugins import Menu, MountPoint, PluginBase
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.contrib.gis.geos import Polygon
from django.http import FileResponse, Http404, HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.utils.text import get_valid_filename
from django.views.decorators.http import require_GET, require_POST
from nodeodm.models import ProcessingNode
from PIL import Image, ImageFilter, ImageOps
import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform as rio_transform

try:
    from .smartalign_backend import SmartAlignMixin
except ImportError:
    from smartalign_backend import SmartAlignMixin


logger = logging.getLogger("app.logger")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng", ".nef"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".lrv", ".ts", ".avi", ".mkv"}
OVERLAP_OPTIONS = [100, 95, 90, 85, 83, 80, 75, 72, 70, 65, 60, 50]
DEFAULT_CAPTURE_HEIGHT_METERS = 120
MAX_PREVIEW_SIDE = 2200
UKRAINIAN_LOCALE = "uk"
UKRAINIAN_LABEL_JS_ENTRY = "    'uk': '\\u0423\\u043a\\u0440\\u0430\\u0457\\u043d\\u0441\\u044c\\u043a\\u0430'"
PLUGIN_DIR = Path(__file__).resolve().parent
ESRGAN_DIR = os.environ.get("SOFT_TOOLS_ESRGAN_DIR", str(PLUGIN_DIR / "bin" / "realesrgan"))
ESRGAN_MODEL = "realesrgan-x4plus"
ESRGAN_SCALE = "4"
ESRGAN_TILE = "128"
ENHANCEMENT_MODES = {
    "light": {"label": "Легке", "tile": "256"},
    "medium": {"label": "Середнє", "tile": "128"},
    "maximum": {"label": "Максимальне", "tile": "0"}
}
DEFAULT_ENHANCEMENT_MODE = "medium"
SHARPEN_RADIUS = 2.0
SHARPEN_PERCENT = 160
SHARPEN_THRESHOLD = 2
SHARPEN_BLEND = 0.50
DELTA_COMPRESSION = "DEFLATE"
DELTA_BLOCKSIZE = 512
DELTA_RESAMPLING = "NEAREST"
DELTA_ALLOWED_AUTO_EPSG = {32636, 32637}
DELTA_3D_TILE_CONVERTER_DIR = PLUGIN_DIR / "bin" / "tile-converter"
DELTA_3D_TILE_CONVERTER_SCRIPT = DELTA_3D_TILE_CONVERTER_DIR / "node_modules" / "@loaders.gl" / "tile-converter" / "bin" / "converter.js"
DELTA_3D_SPECIAL_INDEX_NAME = "@specialIndexFileHASH128@"
DELTA_3D_SCENE_LAYER_NAME = "3dSceneLayer.json.gz"
PYTHON_PACKAGES_DIR = PLUGIN_DIR / "bin" / "python-packages"
ELEVATION_PROVIDER = "OpenTopoData SRTM90m"
ELEVATION_API_URL = "https://api.opentopodata.org/v1/srtm90m"
ELEVATION_BATCH_SIZE = 50
ELEVATION_TIMEOUT_SECONDS = 12


def ensure_ukrainian_locale_enabled():
    try:
        webodm_root = Path(settings.BASE_DIR)
        locale_dir = webodm_root / "locale" / UKRAINIAN_LOCALE / "LC_MESSAGES"
        if not locale_dir.exists():
            return

        msgfmt_path = webodm_root.parent / "python39" / "Tools" / "i18n" / "msgfmt.py"
        if msgfmt_path.exists():
            for domain in ("django", "djangojs"):
                po_path = locale_dir / "{}.po".format(domain)
                mo_path = locale_dir / "{}.mo".format(domain)
                if po_path.exists() and (
                    not mo_path.exists() or po_path.stat().st_mtime > mo_path.stat().st_mtime
                ):
                    subprocess.run(
                        [sys.executable, str(msgfmt_path), "-o", str(mo_path), str(po_path)],
                        check=True,
                        cwd=str(webodm_root)
                    )

        locales_path = webodm_root / "LOCALES"
        if locales_path.exists():
            raw_locales = locales_path.read_text(encoding="utf-8").strip()
            locales = raw_locales.split() if raw_locales else []
            if UKRAINIAN_LOCALE not in locales:
                locales.append(UKRAINIAN_LOCALE)
                locales_path.write_text(" ".join(locales) + "\n", encoding="utf-8")

        app_root = webodm_root.parent.parent
        i18n_path = app_root / "i18n.js"
        if i18n_path.exists():
            i18n_text = i18n_path.read_text(encoding="utf-8")
            if not re.search(r"['\"]uk['\"]\s*:", i18n_text):
                marker = "\n}\n\nmodule.exports"
                if marker in i18n_text:
                    i18n_text = i18n_text.replace(marker, ",\n" + UKRAINIAN_LABEL_JS_ENTRY + marker, 1)
                    i18n_path.write_text(i18n_text, encoding="utf-8")
    except Exception:
        logger.exception("Smartpoint could not enable Ukrainian locale")


ensure_ukrainian_locale_enabled()


def extension_of(name):
    return os.path.splitext(name or "")[1].lower()


def is_image_name(name):
    return extension_of(name) in IMAGE_EXTENSIONS


def is_video_name(name):
    return extension_of(name) in VIDEO_EXTENSIONS


def is_text_name(name):
    return extension_of(name) == ".txt"


def normalize_overlap_percent(value):
    try:
        parsed = int(str(value or "").strip())
    except ValueError:
        return 80
    return max(1, min(100, parsed))


def normalize_capture_height_meters(value):
    try:
        parsed = float(str(value or "").strip().replace(",", "."))
    except ValueError:
        return DEFAULT_CAPTURE_HEIGHT_METERS
    if parsed <= 0:
        return DEFAULT_CAPTURE_HEIGHT_METERS
    return max(1, min(5000, round(parsed)))


def parse_bbox(value):
    try:
        west, south, east, north = [float(v) for v in str(value or "").split(",")]
    except ValueError:
        raise ValueError("Invalid bbox")
    if west >= east or south >= north:
        raise ValueError("Invalid bbox")
    return west, south, east, north


def bbox_intersects(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def normalize_gcp_srs(value):
    raw_srs = str(value or "EPSG:4326").strip()
    if raw_srs.upper() in ("EPSG:4326", "WGS84", "WGS 84"):
        return "+proj=longlat +datum=WGS84 +no_defs"
    return raw_srs


def is_wgs84_lonlat_srs(value):
    raw_srs = str(value or "").strip().lower()
    return (
        raw_srs in ("epsg:4326", "wgs84", "wgs 84") or
        "+proj=longlat" in raw_srs or
        "+proj=latlong" in raw_srs
    )


def is_missing_gcp_elevation(value):
    try:
        return abs(float(value)) < 0.000001
    except (TypeError, ValueError):
        return True


def get_photo_base_step(overlap_percent):
    if overlap_percent >= 90:
        return 1
    if overlap_percent >= 80:
        return 2
    if overlap_percent >= 70:
        return 3
    if overlap_percent >= 60:
        return 4
    return 5


def get_video_base_interval_seconds(overlap_percent):
    if overlap_percent >= 100:
        return 0.25
    if overlap_percent >= 95:
        return 0.35
    if overlap_percent >= 90:
        return 0.5
    if overlap_percent >= 85:
        return 0.7
    if overlap_percent >= 83:
        return 0.8
    if overlap_percent >= 80:
        return 1.0
    if overlap_percent >= 75:
        return 1.25
    if overlap_percent >= 72:
        return 1.4
    if overlap_percent >= 70:
        return 1.5
    if overlap_percent >= 65:
        return 1.8
    if overlap_percent >= 60:
        return 2.0
    return 2.5


def get_capture_height_factor(capture_height_meters):
    normalized = normalize_capture_height_meters(capture_height_meters)
    return max(0.65, min(2.2, (normalized / 120.0) ** 0.5))


def unique_filename(directory, filename):
    filename = get_valid_filename(filename or "file")
    stem, ext = os.path.splitext(filename)
    candidate = filename
    index = 1
    while os.path.exists(os.path.join(directory, candidate)):
        candidate = "{}_{}{}".format(stem, index, ext)
        index += 1
    return candidate


def safe_child(root, *parts):
    root_path = Path(root).resolve()
    child = root_path.joinpath(*parts).resolve()
    if root_path != child and root_path not in child.parents:
        raise Http404("Invalid path")
    return str(child)


def save_uploaded_file(uploaded, destination_path):
    temporary_path = None
    if hasattr(uploaded, "temporary_file_path"):
        try:
            temporary_path = uploaded.temporary_file_path()
        except Exception:
            temporary_path = None

    if temporary_path and os.path.isfile(temporary_path):
        with open(temporary_path, "rb") as src, open(destination_path, "wb") as dst:
            shutil.copyfileobj(src, dst)
        return

    try:
        if hasattr(uploaded, "open"):
            uploaded.open("rb")
        with open(destination_path, "wb+") as dst:
            for chunk in uploaded.chunks():
                dst.write(chunk)
    except ValueError as e:
        raise ValueError("Cannot read uploaded file '{}': {}".format(uploaded.name, e))


def parse_exif_datetime(value):
    if not value:
        return ""
    raw = str(value).strip()
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).isoformat()
        except ValueError:
            continue
    return ""


def import_plugin_opencv():
    if PYTHON_PACKAGES_DIR.exists():
        packages_path = str(PYTHON_PACKAGES_DIR)
        if packages_path not in sys.path:
            sys.path.insert(0, packages_path)
    try:
        import cv2
        import numpy as np
        return cv2, np
    except Exception as e:
        raise ValueError("OpenCV is not available in this WebODM environment: {}".format(e))


def normalize_enhancement_mode(value):
    mode = str(value or "").strip().lower()
    if mode in ENHANCEMENT_MODES:
        return mode
    return DEFAULT_ENHANCEMENT_MODE


class Plugin(SmartAlignMixin, PluginBase):
    def main_menu(self):
        return [Menu("Smartpoint", self.public_url(""), "fa fa-crosshairs fa-fw")]

    def include_js_files(self):
        return ["soft_tools.js", "smart_align.js", "orthophoto_mosaic.js", "orthophoto_mosaic_page.js"]

    def include_css_files(self):
        return ["soft_tools.css", "smart_align.css", "orthophoto_mosaic.css", "orthophoto_mosaic_page.css"]

    def app_mount_points(self):
        @login_required
        def dashboard(request):
            return render(request, self.template_path("dashboard.html"), {
                "title": "Smartpoint"
            })

        @login_required
        def orthophoto_mosaic_page(request):
            return render(request, self.template_path("orthophoto_mosaic.html"), {
                "title": "Об’єднання ортофото"
            })

        @login_required
        @require_POST
        def prepare(request):
            try:
                session = self.prepare_session(request)
                return JsonResponse(session)
            except ValueError as e:
                logger.exception("Smartpoint prepare failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        def markup(request, session_id):
            session = self.load_session(session_id)
            return render(request, self.template_path("markup.html"), {
                "title": "Smartpoint Markup",
                "session_id": session["id"],
                "project_id": session.get("project_id", "")
            })

        @login_required
        @require_GET
        def session_file(request, session_id, kind, filename):
            session_dir = self.session_dir(session_id)
            file_kind = "prepared_original" if kind == "original" else "preview_original" if kind == "original_preview" else kind
            file_path = safe_child(session_dir, file_kind, filename)
            if not os.path.isfile(file_path):
                raise Http404("File not found")
            content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
            return FileResponse(open(file_path, "rb"), content_type=content_type)

        @login_required
        @require_GET
        def session_data(request, session_id):
            return JsonResponse(self.load_session(session_id))

        @login_required
        @require_GET
        def mosaic_tasks(request):
            tasks = models.Task.objects.filter(
                available_assets__contains="{orthophoto.tif}"
            ).select_related("project").order_by("-created_at")[:200]

            items = []
            for task in tasks:
                try:
                    check_project_perms(request, task.project)
                except Exception:
                    continue
                extent = task.orthophoto_extent.extent if task.orthophoto_extent else None
                items.append({
                    "id": str(task.id),
                    "project_id": task.project_id,
                    "project_name": task.project.name,
                    "task_name": task.name,
                    "created_at": task.created_at.isoformat() if task.created_at else "",
                    "bounds": list(extent) if extent else None,
                    "tile_url": "/api/projects/{}/tasks/{}/orthophoto/tiles/{{z}}/{{x}}/{{y}}.png".format(task.project_id, task.id)
                })
            return JsonResponse({"tasks": items})

        @login_required
        @require_GET
        def mosaic_orthophotos(request):
            try:
                bbox = parse_bbox(request.GET.get("bbox"))
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            bounds_geom = Polygon.from_bbox(bbox)
            tasks = models.Task.objects.filter(
                available_assets__contains="{orthophoto.tif}",
                orthophoto_extent__isnull=False,
                orthophoto_extent__intersects=bounds_geom
            ).select_related("project").order_by("-created_at")[:120]
            items = []
            for task in tasks:
                try:
                    check_project_perms(request, task.project)
                except Exception:
                    continue
                extent = task.orthophoto_extent.extent if task.orthophoto_extent else None
                if not extent or not bbox_intersects(bbox, extent):
                    continue
                items.append({
                    "id": str(task.id),
                    "project_id": task.project_id,
                    "project_name": task.project.name,
                    "task_name": task.name,
                    "created_at": task.created_at.isoformat() if task.created_at else "",
                    "bounds": list(extent),
                    "tile_url": "/api/projects/{}/tasks/{}/orthophoto/tiles/{{z}}/{{x}}/{{y}}.png".format(task.project_id, task.id)
                })
            return JsonResponse({"orthophotos": items})

        @login_required
        @require_POST
        def mosaic_create(request):
            payload = self.read_json_body(request)
            layers = payload.get("layers", [])
            if not isinstance(layers, list) or len(layers) < 2:
                return HttpResponseBadRequest("Select at least 2 orthophotos")
            return JsonResponse({
                "success": False,
                "message": "Список шарів отримано. Merge backend буде підключено наступним етапом.",
                "layers": layers
            })

        @login_required
        @require_GET
        def orthophotos(request, session_id):
            self.load_session(session_id)
            try:
                bbox = parse_bbox(request.GET.get("bbox"))
            except ValueError as e:
                return HttpResponseBadRequest(str(e))

            bounds_geom = Polygon.from_bbox(bbox)
            tasks = models.Task.objects.filter(
                available_assets__contains="{orthophoto.tif}",
                orthophoto_extent__isnull=False,
                orthophoto_extent__intersects=bounds_geom
            ).select_related("project").order_by("-created_at")[:80]

            items = []
            for task in tasks:
                try:
                    check_project_perms(request, task.project)
                except Exception:
                    continue
                extent = task.orthophoto_extent.extent if task.orthophoto_extent else None
                if not extent or not bbox_intersects(bbox, extent):
                    continue
                items.append({
                    "id": str(task.id),
                    "project_id": task.project_id,
                    "project_name": task.project.name,
                    "task_name": task.name,
                    "created_at": task.created_at.isoformat() if task.created_at else "",
                    "bounds": list(extent),
                    "tile_url": "/api/projects/{}/tasks/{}/orthophoto/tiles/{{z}}/{{x}}/{{y}}.png".format(task.project_id, task.id)
                })

            return JsonResponse({"orthophotos": items})

        @login_required
        @require_POST
        def save_points(request, session_id):
            session = self.load_session(session_id)
            payload = self.read_json_body(request)
            points = payload.get("points", [])
            if not isinstance(points, list):
                return HttpResponseBadRequest("Invalid points")
            session["points"] = points
            session["raw_srs"] = str(payload.get("raw_srs") or session.get("raw_srs") or "EPSG:4326").strip()
            if self.session_has_image_observations(session):
                session["preparation_locked"] = True
            self.save_session(session)
            _, entries_count, elevation = self.write_gcp_file(session)
            self.save_session(session)
            return JsonResponse({
                "success": True,
                "points_count": len(points),
                "entries_count": entries_count,
                "elevation": elevation,
                "preparation_locked": bool(session.get("preparation_locked"))
            })

        @login_required
        @require_POST
        def generate_gcp(request, session_id):
            session = self.load_session(session_id)
            payload = self.read_json_body(request)
            if "points" in payload:
                session["points"] = payload.get("points") or []
            if "raw_srs" in payload:
                session["raw_srs"] = str(payload.get("raw_srs") or "EPSG:4326").strip()
            self.save_session(session)
            gcp_path, entries_count, elevation = self.write_gcp_file(session)
            self.save_session(session)
            return JsonResponse({
                "success": True,
                "entries_count": entries_count,
                "elevation": elevation,
                "download_url": "/plugins/{}/api/session/{}/gcp/download/".format(self.get_name(), session_id),
                "path": gcp_path
            })

        @login_required
        @require_POST
        def point_search(request, session_id):
            try:
                session = self.load_session(session_id)
                payload = self.read_json_body(request)
                if "points" in payload:
                    session["points"] = payload.get("points") or []
                source_image_id = str(payload.get("source_image_id") or "").strip()
                search_method = str(payload.get("method") or "").strip()
                target_image_ids = payload.get("target_image_ids")
                if target_image_ids is not None and not isinstance(target_image_ids, list):
                    return HttpResponseBadRequest("Invalid target_image_ids")
                results, candidates = self.find_point_search_candidates(session, source_image_id, search_method, target_image_ids)
                return JsonResponse({
                    "success": True,
                    "method": self.normalize_point_search_method(search_method),
                    "results": results,
                    "candidates": candidates
                })
            except ValueError as e:
                logger.exception("Smartpoint point search failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_POST
        def enhance_images(request, session_id):
            try:
                session = self.load_session(session_id)
                payload = self.read_json_body(request)
                image_ids = payload.get("image_ids") or []
                apply_all = bool(payload.get("all"))
                enhancement_mode = normalize_enhancement_mode(payload.get("enhancement_mode"))
                job = self.start_enhance_job(session, image_ids=image_ids, apply_all=apply_all, enhancement_mode=enhancement_mode)
                return JsonResponse({"success": True, "job": job})
            except ValueError as e:
                logger.exception("Smartpoint image enhancement failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_GET
        def enhance_status(request, session_id):
            session = self.load_session(session_id)
            return JsonResponse({
                "success": True,
                "job": self.load_enhance_job(session_id),
                "images": session.get("images", []),
                "points": session.get("points", []),
                "message": session.get("message", "")
            })

        @login_required
        @require_POST
        def restore_images(request, session_id):
            try:
                session = self.load_session(session_id)
                payload = self.read_json_body(request)
                image_ids = payload.get("image_ids") or []
                restore_all = bool(payload.get("all"))
                session, restored_count = self.restore_session_images(session, image_ids=image_ids, restore_all=restore_all)
                self.save_session(session)
                return JsonResponse({
                    "success": True,
                    "restored_count": restored_count,
                    "images": session.get("images", []),
                    "points": session.get("points", []),
                    "message": session.get("message", "")
                })
            except ValueError as e:
                logger.exception("Smartpoint image restore failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_GET
        def download_gcp(request, session_id):
            session = self.load_session(session_id)
            gcp_path = safe_child(self.session_dir(session["id"]), "gcp_list.txt")
            self.write_gcp_file(session)
            self.save_session(session)
            response = FileResponse(open(gcp_path, "rb"), as_attachment=True, filename="gcp_list.txt", content_type="text/plain; charset=utf-8")
            return response

        @login_required
        @require_POST
        def go_to_task(request, session_id):
            try:
                session = self.load_session(session_id)
                payload = self.read_json_body(request)
                if "points" in payload:
                    session["points"] = payload.get("points") or []
                if "raw_srs" in payload:
                    session["raw_srs"] = str(payload.get("raw_srs") or "EPSG:4326").strip()
                task = self.create_or_update_webodm_draft_task(request, session)
                self.delete_session(session["id"])
                return JsonResponse({
                    "success": True,
                    "task_id": str(task.id),
                    "project_id": task.project_id,
                    "redirect_url": "/dashboard/?project_task_open={}".format(task.project_id)
                })
            except ValueError as e:
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_POST
        def delta_orthophoto_export(request, project_id, task_id):
            try:
                task = self.get_export_task(request, project_id, task_id)
                export = self.create_delta_orthophoto_export(task)
                return JsonResponse({
                    "success": True,
                    "url": "/plugins/{}/api/delta/{}/download/".format(self.get_name(), export["id"]),
                    "filename": export["filename"]
                })
            except ValueError as e:
                logger.exception("Smartpoint Delta orthophoto export failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_POST
        def delta_3d_export(request, project_id, task_id):
            try:
                task = self.get_export_task(request, project_id, task_id)
                export = self.create_delta_3d_export(task)
                return JsonResponse({
                    "success": True,
                    "url": "/plugins/{}/api/delta/{}/download/".format(self.get_name(), export["id"]),
                    "filename": export["filename"]
                })
            except ValueError as e:
                logger.exception("Smartpoint Delta 3D export failed")
                return HttpResponseBadRequest(str(e))

        @login_required
        @require_GET
        def download_delta_export(request, export_id):
            export = self.load_delta_export(export_id)
            task = self.get_export_task(request, export["project_id"], export["task_id"])
            filename = request.GET.get("filename") or export.get("filename") or "orthophoto_delta.tif"
            filename = get_valid_filename(filename)
            if not task:
                raise Http404("Task not found")
            path = export["path"]
            if not os.path.isfile(path):
                raise Http404("Export file not found")
            return FileResponse(
                open(path, "rb"),
                as_attachment=True,
                filename=filename,
                content_type=export.get("content_type") or "image/tiff"
            )

        return [
            MountPoint("$", dashboard),
            MountPoint("prepare/$", prepare),
            MountPoint("mosaic/$", orthophoto_mosaic_page),
            MountPoint("session/(?P<session_id>[^/]+)/markup/$", markup),
            MountPoint("session/(?P<session_id>[^/]+)/(?P<kind>prepared|preview|original|original_preview)/(?P<filename>.+)$", session_file),
            MountPoint("api/session/(?P<session_id>[^/]+)/$", session_data),
            MountPoint("api/session/(?P<session_id>[^/]+)/orthophotos/$", orthophotos),
            MountPoint("api/session/(?P<session_id>[^/]+)/points/$", save_points),
            MountPoint("api/session/(?P<session_id>[^/]+)/gcp/$", generate_gcp),
            MountPoint("api/session/(?P<session_id>[^/]+)/point-search/$", point_search),
            MountPoint("api/session/(?P<session_id>[^/]+)/enhance/$", enhance_images),
            MountPoint("api/session/(?P<session_id>[^/]+)/enhance/status/$", enhance_status),
            MountPoint("api/session/(?P<session_id>[^/]+)/restore/$", restore_images),
            MountPoint("api/session/(?P<session_id>[^/]+)/gcp/download/$", download_gcp),
            MountPoint("api/session/(?P<session_id>[^/]+)/task/$", go_to_task),
            MountPoint("api/projects/(?P<project_id>[^/]+)/tasks/(?P<task_id>[^/]+)/orthophoto/delta/$", delta_orthophoto_export),
            MountPoint("api/projects/(?P<project_id>[^/]+)/tasks/(?P<task_id>[^/]+)/3d/delta/$", delta_3d_export),
            MountPoint("api/delta/(?P<export_id>[0-9a-f-]+)/download/$", download_delta_export),
            MountPoint("api/mosaic/tasks/$", mosaic_tasks),
            MountPoint("api/mosaic/orthophotos/$", mosaic_orthophotos),
            MountPoint("api/mosaic/create/$", mosaic_create)
        ] + self.smartalign_mount_points()

    def session_dir(self, session_id):
        if not re.match(r"^[0-9a-f-]+$", session_id or ""):
            raise Http404("Invalid session id")
        return self.get_persistent_path("sessions", session_id)

    def sessions_root(self):
        return self.get_persistent_path("sessions")

    def session_json_path(self, session_id):
        return safe_child(self.session_dir(session_id), "session.json")

    def enhance_job_path(self, session_id):
        return safe_child(self.session_dir(session_id), "enhance_job.json")

    def load_session(self, session_id):
        path = self.session_json_path(session_id)
        if not os.path.isfile(path):
            raise Http404("Session not found")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_session(self, session):
        os.makedirs(self.session_dir(session["id"]), exist_ok=True)
        with open(self.session_json_path(session["id"]), "w", encoding="utf-8") as f:
            json.dump(session, f, ensure_ascii=False, indent=2)

    def load_enhance_job(self, session_id):
        path = self.enhance_job_path(session_id)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            logger.warning("Could not read Smartpoint enhance job %s", path)
            return None

    def save_enhance_job(self, session_id, job):
        os.makedirs(self.session_dir(session_id), exist_ok=True)
        with open(self.enhance_job_path(session_id), "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False, indent=2)

    def cleanup_sessions(self, keep_session_id=None):
        root = self.sessions_root()
        if not os.path.isdir(root):
            return

        for name in os.listdir(root):
            if keep_session_id and name == keep_session_id:
                continue
            if not re.match(r"^[0-9a-f-]+$", name or ""):
                continue
            try:
                path = safe_child(root, name)
                if os.path.isdir(path):
                    shutil.rmtree(path)
            except Exception as e:
                logger.warning("Could not remove Smartpoint session %s: %s", name, e)

    def delete_session(self, session_id):
        try:
            path = self.session_dir(session_id)
            if os.path.isdir(path):
                shutil.rmtree(path)
        except Exception as e:
            logger.warning("Could not remove Smartpoint session %s: %s", session_id, e)

    def delta_exports_root(self):
        return self.get_persistent_path("delta_exports")

    def delta_export_dir(self, export_id):
        if not re.match(r"^[0-9a-f-]+$", export_id or ""):
            raise Http404("Invalid export id")
        return safe_child(self.delta_exports_root(), export_id)

    def delta_export_json_path(self, export_id):
        return safe_child(self.delta_export_dir(export_id), "export.json")

    def cleanup_delta_exports(self):
        root = self.delta_exports_root()
        if not os.path.isdir(root):
            return

        now = datetime.utcnow().timestamp()
        for name in os.listdir(root):
            if not re.match(r"^[0-9a-f-]+$", name or ""):
                continue
            try:
                path = safe_child(root, name)
                if os.path.isdir(path) and now - os.path.getmtime(path) > 24 * 60 * 60:
                    shutil.rmtree(path)
            except Exception as e:
                logger.warning("Could not remove Smartpoint Delta export %s: %s", name, e)

    def load_delta_export(self, export_id):
        path = self.delta_export_json_path(export_id)
        if not os.path.isfile(path):
            raise Http404("Export not found")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def get_export_task(self, request, project_id, task_id):
        try:
            task = models.Task.objects.select_related("project").get(pk=task_id, project_id=project_id)
        except models.Task.DoesNotExist:
            raise Http404("Task not found")
        check_project_perms(request, task.project)
        return task

    def get_delta_orthophoto_source(self, task):
        try:
            source = task.get_asset_file_or_stream("orthophoto.tif")
        except FileNotFoundError:
            source = None
        if not source or not isinstance(source, str) or not os.path.isfile(source):
            raise ValueError("Orthophoto GeoTIFF is not available")
        return source

    def find_gdal_tool(self, tool_name):
        candidates = [shutil.which(tool_name)]
        webodm_root = Path(settings.BASE_DIR)
        apps_root = webodm_root.parent
        for osgeo_dir in (
            apps_root / "python39" / "Lib" / "site-packages" / "osgeo",
            apps_root / "ODX" / "venv" / "Lib" / "site-packages" / "osgeo",
            apps_root / "ODX" / "SuperBuild" / "install" / "bin",
        ):
            candidates.append(str(osgeo_dir / "{}.exe".format(tool_name)))
            candidates.append(str(osgeo_dir / tool_name))

        for candidate in candidates:
            if candidate and os.path.isfile(os.path.abspath(candidate)):
                return os.path.abspath(candidate)
        raise ValueError("{} was not found".format(tool_name))

    def gdal_environment(self):
        env = os.environ.copy()
        webodm_root = Path(settings.BASE_DIR)
        apps_root = webodm_root.parent
        osgeo_dirs = [
            apps_root / "python39" / "Lib" / "site-packages" / "osgeo",
            apps_root / "ODX" / "venv" / "Lib" / "site-packages" / "osgeo",
            apps_root / "ODX" / "SuperBuild" / "install" / "bin",
        ]
        path_entries = [str(path) for path in osgeo_dirs if path.exists()]
        env["PATH"] = os.pathsep.join(path_entries + [env.get("PATH", "")])

        for osgeo_dir in osgeo_dirs:
            gdal_data = osgeo_dir / "data" / "gdal"
            proj_lib = osgeo_dir / "data" / "proj"
            plugins = osgeo_dir / "gdalplugins"
            if gdal_data.exists():
                env.setdefault("GDAL_DATA", str(gdal_data))
            if proj_lib.exists():
                env.setdefault("PROJ_LIB", str(proj_lib))
            if plugins.exists():
                env.setdefault("GDAL_DRIVER_PATH", str(plugins))
        return env

    def detect_delta_nodata(self, source_path):
        with rasterio.open(source_path) as dataset:
            has_alpha = any(getattr(color, "name", "") == "alpha" for color in dataset.colorinterp)
            if dataset.nodata is not None:
                return dataset.nodata
            if not has_alpha:
                return 0
        return None

    def detect_delta_epsg(self, source_path):
        with rasterio.open(source_path) as dataset:
            if dataset.crs is None:
                raise ValueError("Orthophoto Delta export needs georeferenced source data")
            source_epsg = dataset.crs.to_epsg()
            if source_epsg in DELTA_ALLOWED_AUTO_EPSG:
                return source_epsg

            center_x = (dataset.bounds.left + dataset.bounds.right) / 2.0
            center_y = (dataset.bounds.bottom + dataset.bounds.top) / 2.0
            lon, lat = rio_transform(dataset.crs, CRS.from_epsg(4326), [center_x], [center_y])
            longitude = lon[0]
            latitude = lat[0]
            zone = int((longitude + 180.0) / 6.0) + 1
            epsg = 32600 + zone if latitude >= 0 else 32700 + zone
            if epsg not in DELTA_ALLOWED_AUTO_EPSG:
                raise ValueError("Delta auto UTM supports EPSG:32636 and EPSG:32637 only")
            return epsg

    def run_gdal(self, args):
        completed = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.gdal_environment()
        )
        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or "").strip()
            raise ValueError(message or "GDAL command failed")

    def create_delta_orthophoto_export(self, task):
        self.cleanup_delta_exports()
        source_path = self.get_delta_orthophoto_source(task)
        target_epsg = self.detect_delta_epsg(source_path)
        nodata = self.detect_delta_nodata(source_path)

        export_id = str(uuid.uuid4())
        export_dir = self.delta_export_dir(export_id)
        os.makedirs(export_dir, exist_ok=True)

        filename = get_valid_filename("{}_orthophoto_delta.tif".format(task.name or "task"))
        output_path = safe_child(export_dir, filename)
        warp_path = safe_child(export_dir, "orthophoto_delta.vrt")

        gdalwarp = self.find_gdal_tool("gdalwarp")
        gdal_translate = self.find_gdal_tool("gdal_translate")

        self.run_gdal([
            gdalwarp,
            "-of", "VRT",
            "-t_srs", "EPSG:{}".format(target_epsg),
            "-r", DELTA_RESAMPLING.lower(),
            "-multi",
            source_path,
            warp_path
        ])

        translate_args = [
            gdal_translate,
            "-of", "COG",
            "-co", "BLOCKSIZE={}".format(DELTA_BLOCKSIZE),
            "-co", "COMPRESS={}".format(DELTA_COMPRESSION),
            "-co", "PREDICTOR=2",
            "-co", "BIGTIFF=IF_SAFER",
            "-co", "NUM_THREADS=ALL_CPUS",
            "-co", "RESAMPLING={}".format(DELTA_RESAMPLING),
            "--config", "GDAL_NUM_THREADS", "ALL_CPUS",
            "--config", "GDAL_TIFF_INTERNAL_MASK", "YES",
        ]
        if nodata is not None:
            translate_args += ["-a_nodata", str(nodata)]
        translate_args += [warp_path, output_path]
        self.run_gdal(translate_args)

        export = {
            "id": export_id,
            "project_id": str(task.project_id),
            "task_id": str(task.id),
            "path": output_path,
            "filename": filename,
            "epsg": target_epsg,
            "compression": DELTA_COMPRESSION,
            "blocksize": DELTA_BLOCKSIZE,
            "nodata": nodata
        }
        with open(self.delta_export_json_path(export_id), "w", encoding="utf-8") as f:
            json.dump(export, f, ensure_ascii=False, indent=2)
        return export

    def find_delta_3d_obj2tiles(self):
        webodm_root = Path(settings.BASE_DIR)
        apps_root = webodm_root.parent
        candidates = [
            apps_root / "ODX" / "SuperBuild" / "install" / "bin" / "Obj2Tiles.exe",
            apps_root / "ODX" / "SuperBuild" / "install" / "bin" / "Obj2Tiles",
            Path(shutil.which("Obj2Tiles") or ""),
            Path(shutil.which("Obj2Tiles.exe") or "")
        ]
        for candidate in candidates:
            if candidate and str(candidate) and candidate.is_file():
                return str(candidate.resolve())
        raise ValueError("Obj2Tiles.exe was not found")

    def find_delta_3d_node(self):
        candidates = [
            Path(shutil.which("node") or ""),
            Path(r"C:\Program Files\nodejs\node.exe"),
            Path(r"C:\Program Files (x86)\nodejs\node.exe")
        ]
        for candidate in candidates:
            if candidate and str(candidate) and candidate.is_file():
                return str(candidate.resolve())
        raise ValueError("Node.js was not found")

    def find_delta_3d_converter(self):
        if DELTA_3D_TILE_CONVERTER_SCRIPT.is_file():
            return str(DELTA_3D_TILE_CONVERTER_SCRIPT.resolve())
        raise ValueError("tile-converter was not found inside the Smartpoint plugin")

    def get_smartalign_delta_3d_source(self, task):
        delta_manifest_path = task.assets_path("smartalign", "softtools_3d", "delta_source", "manifest.json")
        webodm_manifest_path = task.assets_path("smartalign", "softtools_3d", "webodm_model", "manifest.json")

        def read_manifest(path):
            if not os.path.isfile(path):
                return None
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError):
                return None

        delta_manifest = read_manifest(delta_manifest_path)
        webodm_manifest = read_manifest(webodm_manifest_path)

        reference_path = (delta_manifest or {}).get("reference_lla") or task.assets_path(
            "smartalign",
            "softtools_3d",
            "delta_source",
            "reference_lla.json"
        )
        if not os.path.isfile(reference_path):
            return None

        if webodm_manifest and webodm_manifest.get("active") is not False:
            axis_convention = webodm_manifest.get("axis_convention")
            if axis_convention and axis_convention != "webodm_xy_z_height":
                raise ValueError("SmartAlign WebODM 3D source has incompatible axis convention: {}".format(axis_convention))
            source_obj = webodm_manifest.get("source_obj") or task.assets_path(
                "smartalign",
                "softtools_3d",
                "webodm_model",
                "odm_textured_model_geo.obj"
            )
            if os.path.isfile(source_obj):
                return {
                    "source_obj": source_obj,
                    "reference_path": reference_path,
                    "manifest_path": webodm_manifest_path,
                    "manifest": webodm_manifest,
                    "source_kind": "SmartAlign WebODM Z-up",
                    "axis_convention": "webodm_xy_z_height",
                    "obj2tiles_flags": []
                }

        if not delta_manifest or delta_manifest.get("active") is False:
            return None

        axis_convention = delta_manifest.get("axis_convention")
        if axis_convention and axis_convention != "obj2tiles_xz_y_height":
            raise ValueError("SmartAlign 3D source has incompatible axis convention: {}".format(axis_convention))

        source_obj = delta_manifest.get("source_obj") or task.assets_path(
            "smartalign",
            "softtools_3d",
            "delta_source",
            "odm_textured_model_geo.obj"
        )
        if not os.path.isfile(source_obj):
            return None

        return {
            "source_obj": source_obj,
            "reference_path": reference_path,
            "manifest_path": delta_manifest_path,
            "manifest": delta_manifest,
            "source_kind": "SmartAlign Delta Y-up",
            "axis_convention": "obj2tiles_xz_y_height",
            "obj2tiles_flags": delta_manifest.get("obj2tiles_flags") or ["--y-up-to-z-up"]
        }

    def get_delta_3d_source_obj(self, task):
        smartalign_source = self.get_smartalign_delta_3d_source(task)
        if smartalign_source:
            return smartalign_source["source_obj"]

        candidates = [
            task.assets_path("odm_texturing", "odm_textured_model_geo.obj"),
            task.assets_path("odm_texturing_25d", "odm_textured_model_geo.obj"),
            task.assets_path("odm_texturing", "odm_textured_model.obj"),
            task.assets_path("odm_texturing_25d", "odm_textured_model.obj")
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        raise ValueError("Textured OBJ model is not available")

    def read_delta_3d_reference_lla(self, task):
        smartalign_source = self.get_smartalign_delta_3d_source(task)
        if smartalign_source:
            json_candidates = [smartalign_source["reference_path"]]
        else:
            json_candidates = [
                task.assets_path("opensfm", "reference_lla.json"),
                task.task_path("opensfm", "reference_lla.json")
            ]
        for candidate in json_candidates:
            if not os.path.isfile(candidate):
                continue
            try:
                with open(candidate, "r", encoding="utf-8") as f:
                    reference = json.load(f)
                latitude = float(reference.get("latitude"))
                longitude = float(reference.get("longitude"))
                altitude = float(reference.get("altitude") or 0)
                return {
                    "path": candidate,
                    "latitude": latitude,
                    "longitude": longitude,
                    "altitude": altitude
                }
            except (TypeError, ValueError, json.JSONDecodeError) as e:
                raise ValueError("reference_lla.json has invalid coordinates: {}".format(e))

        proj_path = task.assets_path("odm_georeferencing", "proj.txt")
        coords_path = task.assets_path("odm_georeferencing", "coords.txt")
        if not os.path.isfile(proj_path) or not os.path.isfile(coords_path):
            raise ValueError("3D Delta export needs reference_lla.json or odm_georeferencing/proj.txt + coords.txt")

        with open(proj_path, "r", encoding="utf-8") as f:
            proj_text = f.read().strip()
        with open(coords_path, "r", encoding="utf-8") as f:
            coord_lines = [line.strip() for line in f.readlines() if line.strip()]
        if len(coord_lines) < 2:
            raise ValueError("odm_georeferencing/coords.txt does not contain a coordinate offset")

        parts = coord_lines[1].split()
        if len(parts) < 2:
            raise ValueError("odm_georeferencing/coords.txt has invalid coordinate values")
        try:
            offset_x = float(parts[0])
            offset_y = float(parts[1])
            lon, lat = rio_transform(CRS.from_string(proj_text), CRS.from_epsg(4326), [offset_x], [offset_y])
        except Exception as e:
            raise ValueError("Could not convert ODM coordinate offset to WGS84: {}".format(e))

        return {
            "path": coords_path,
            "latitude": lat[0],
            "longitude": lon[0],
            "altitude": 0.0
        }

    def run_delta_3d_process(self, args, cwd=None, env=None):
        completed = subprocess.run(
            args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env or os.environ.copy()
        )
        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or "").strip()
            raise ValueError(message or "{} failed".format(os.path.basename(args[0])))

    def set_delta_3d_tileset_gltf_up_axis(self, tileset_path, axis):
        if axis not in ("Y", "Z"):
            return
        with open(tileset_path, "r", encoding="utf-8") as f:
            tileset = json.load(f)
        asset = tileset.get("asset")
        if not isinstance(asset, dict):
            asset = {}
            tileset["asset"] = asset
        asset["gltfUpAxis"] = axis
        with open(tileset_path, "w", encoding="utf-8") as f:
            json.dump(tileset, f, ensure_ascii=False, indent=2)

    def find_delta_3d_slpk_file(self, root_path):
        preferred = os.path.join(root_path, "3d-delta.slpk")
        if os.path.isfile(preferred):
            return preferred
        if not os.path.isdir(root_path):
            return ""
        for name in os.listdir(root_path):
            if name.lower().endswith(".slpk"):
                return os.path.join(root_path, name)
        return ""

    def delta_3d_is_gzip_bytes(self, payload):
        return len(payload) >= 2 and payload[:2] == b"\x1f\x8b"

    def delta_3d_normalize_hash_name(self, name):
        normalized = name.replace("\\", "/")
        if normalized == DELTA_3D_SCENE_LAYER_NAME:
            return normalized
        return normalized.lower()

    def delta_3d_compose_hash_file(self, file_records):
        rows = []
        for file_name, header_offset in file_records:
            digest = hashlib.md5(self.delta_3d_normalize_hash_name(file_name).encode("utf-8")).digest()
            rows.append((digest, digest + struct.pack("<Q", header_offset)))
        rows.sort(key=lambda row: (
            int.from_bytes(row[0][:8], byteorder="little", signed=False),
            int.from_bytes(row[0][8:16], byteorder="little", signed=False)
        ))
        return b"".join(row for _, row in rows)

    def delta_3d_clone_zip_info(self, source_info):
        target = zipfile.ZipInfo(source_info.filename, date_time=source_info.date_time)
        target.comment = source_info.comment
        target.extra = source_info.extra
        target.internal_attr = source_info.internal_attr
        target.external_attr = source_info.external_attr
        target.create_system = source_info.create_system
        target.create_version = source_info.create_version
        target.extract_version = source_info.extract_version
        target.flag_bits = source_info.flag_bits
        target.volume = getattr(source_info, "volume", 0)
        target.compress_type = zipfile.ZIP_STORED
        return target

    def repair_delta_3d_slpk_archive(self, slpk_path):
        if not os.path.isfile(slpk_path):
            raise ValueError("SLPK file was not created")

        temp_fd, temp_path = tempfile.mkstemp(prefix="soft-tools-slpk-", suffix=".slpk", dir=os.path.dirname(slpk_path))
        os.close(temp_fd)
        rewritten = False

        try:
            with zipfile.ZipFile(slpk_path, "r") as source_zip, zipfile.ZipFile(
                temp_path,
                "w",
                compression=zipfile.ZIP_STORED,
                allowZip64=True
            ) as target_zip:
                file_records = []
                source_infos = [info for info in source_zip.infolist() if info.filename != DELTA_3D_SPECIAL_INDEX_NAME]

                for source_info in source_infos:
                    payload = source_zip.read(source_info.filename)
                    if source_info.filename.lower().endswith(".gz") and not self.delta_3d_is_gzip_bytes(payload):
                        payload = gzip.compress(payload)
                        rewritten = True

                    target_zip.writestr(self.delta_3d_clone_zip_info(source_info), payload)
                    target_info = target_zip.getinfo(source_info.filename)
                    file_records.append((source_info.filename, target_info.header_offset))

                try:
                    existing_index = source_zip.read(DELTA_3D_SPECIAL_INDEX_NAME)
                except KeyError:
                    existing_index = None

                hash_payload = self.delta_3d_compose_hash_file(file_records)
                if existing_index != hash_payload:
                    rewritten = True

                index_info = zipfile.ZipInfo(DELTA_3D_SPECIAL_INDEX_NAME)
                index_info.compress_type = zipfile.ZIP_STORED
                target_zip.writestr(index_info, hash_payload)

            if rewritten:
                os.replace(temp_path, slpk_path)
            else:
                os.remove(temp_path)
            return slpk_path
        except Exception:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
            raise

    def create_delta_3d_export(self, task):
        self.cleanup_delta_exports()
        alignment = self.load_json(task, "alignment.json") if hasattr(self, "load_json") else None
        if alignment and hasattr(self, "align_3d_model"):
            self.align_3d_model(task)
        alignment_3d = self.load_json(task, "alignment_3d.json") if hasattr(self, "load_json") else None
        if alignment_3d and hasattr(self, "prepare_smartalign_softtools_3d_artifacts"):
            artifacts = self.prepare_smartalign_softtools_3d_artifacts(task, alignment_3d)
            alignment_3d["softtools_3d"] = artifacts
            self.save_json(task, "alignment_3d.json", alignment_3d)
            self.save_json(task, "transform_3d.json", alignment_3d)
        smartalign_source = self.get_smartalign_delta_3d_source(task)
        source_obj = self.get_delta_3d_source_obj(task)
        reference = self.read_delta_3d_reference_lla(task)
        obj2tiles_flags = smartalign_source.get("obj2tiles_flags", ["--y-up-to-z-up"]) if smartalign_source else ["--y-up-to-z-up"]
        obj2tiles = self.find_delta_3d_obj2tiles()
        node = self.find_delta_3d_node()
        converter = self.find_delta_3d_converter()

        export_id = str(uuid.uuid4())
        export_dir = self.delta_export_dir(export_id)
        tiles_root = safe_child(export_dir, "3d_tiles", "model")
        slpk_root = safe_child(export_dir, "slpk")
        os.makedirs(tiles_root, exist_ok=True)
        os.makedirs(slpk_root, exist_ok=True)

        self.run_delta_3d_process([
            obj2tiles,
            source_obj,
            tiles_root,
            "--divisions",
            "1",
            "--lat",
            str(reference["latitude"]),
            "--lon",
            str(reference["longitude"]),
            "--alt",
            str(reference["altitude"])
        ] + obj2tiles_flags, cwd=os.path.dirname(source_obj), env=self.gdal_environment())

        tileset_path = safe_child(tiles_root, "tileset.json")
        if not os.path.isfile(tileset_path):
            raise ValueError("Obj2Tiles completed but did not create tileset.json")
        gltf_up_axis = "Z" if smartalign_source and smartalign_source.get("axis_convention") == "webodm_xy_z_height" else "Y"
        self.set_delta_3d_tileset_gltf_up_axis(tileset_path, gltf_up_axis)

        self.run_delta_3d_process([
            node,
            converter,
            "--input-type",
            "3DTILES",
            "--tileset",
            tileset_path,
            "--name",
            "3d-delta",
            "--output",
            slpk_root,
            "--split-nodes",
            "--egm",
            "None",
            "--quiet",
            "--no-draco"
        ], cwd=str(DELTA_3D_TILE_CONVERTER_DIR), env=os.environ.copy())

        slpk_path = self.find_delta_3d_slpk_file(slpk_root)
        if not slpk_path:
            raise ValueError("tile-converter completed but did not create an SLPK file")
        self.repair_delta_3d_slpk_archive(slpk_path)

        filename = get_valid_filename("{}_{}_3d_delta.slpk".format(task.name or "task", export_id[:8]))
        output_path = safe_child(export_dir, filename)
        shutil.move(slpk_path, output_path)

        export = {
            "id": export_id,
            "kind": "3d_delta",
            "project_id": str(task.project_id),
            "task_id": str(task.id),
            "path": output_path,
            "filename": filename,
            "content_type": "application/octet-stream",
            "source_obj": source_obj,
            "reference": reference,
            "source_kind": smartalign_source.get("source_kind", "ODM") if smartalign_source else "ODM",
            "axis_convention": smartalign_source.get("axis_convention", "odm_default") if smartalign_source else "odm_default",
            "tileset_gltf_up_axis": gltf_up_axis,
            "obj2tiles_flags": obj2tiles_flags
        }
        with open(self.delta_export_json_path(export_id), "w", encoding="utf-8") as f:
            json.dump(export, f, ensure_ascii=False, indent=2)
        return export

    def read_json_body(self, request):
        if not request.body:
            return {}
        try:
            return json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            raise ValueError("Invalid JSON")

    def normalize_point_search_method(self, value):
        method = str(value or "").strip().lower()
        if method in ("sift", "akaze", "orb"):
            return method
        return "akaze"

    def create_point_search_feature_tools(self, cv2, method):
        method = self.normalize_point_search_method(method)
        if method == "sift":
            if not hasattr(cv2, "SIFT_create"):
                raise ValueError("SIFT is not available in this OpenCV build")
            return {
                "method": "sift",
                "label": "SIFT",
                "detector": cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.025, edgeThreshold=12, sigma=1.6),
                "matcher": cv2.BFMatcher(cv2.NORM_L2, crossCheck=False),
                "ratio": 0.72,
                "max_matches": 650,
                "min_keypoints": 24,
                "min_matches": 24,
                "min_inliers": 14,
                "min_inlier_ratio": 0.20,
                "ransac_reprojection": 5.0
            }
        if method == "akaze":
            if not hasattr(cv2, "AKAZE_create"):
                raise ValueError("AKAZE is not available in this OpenCV build")
            return {
                "method": "akaze",
                "label": "AKAZE",
                "detector": cv2.AKAZE_create(threshold=0.0008, nOctaves=4, nOctaveLayers=4),
                "matcher": cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False),
                "ratio": 0.78,
                "max_matches": 500,
                "min_keypoints": 18,
                "min_matches": 18,
                "min_inliers": 11,
                "min_inlier_ratio": 0.18,
                "ransac_reprojection": 5.0
            }
        return {
            "method": "orb",
            "label": "ORB",
            "detector": cv2.ORB_create(nfeatures=6000, scaleFactor=1.2, nlevels=8, edgeThreshold=19, patchSize=31),
            "matcher": cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False),
            "ratio": 0.75,
            "max_matches": 450,
            "min_keypoints": 24,
            "min_matches": 24,
            "min_inliers": 14,
            "min_inlier_ratio": 0.20,
            "ransac_reprojection": 5.0
        }

    def find_point_search_candidates(self, session, source_image_id, search_method=None, target_image_ids=None):
        cv2, np = import_plugin_opencv()
        feature_tools = self.create_point_search_feature_tools(cv2, search_method)
        detector = feature_tools["detector"]
        matcher = feature_tools["matcher"]

        images = session.get("images") or []
        image_map = {str(image.get("id")): image for image in images}
        source_image = image_map.get(str(source_image_id))
        if not source_image:
            raise ValueError("Source image not found")
        target_filter = None
        if target_image_ids:
            target_filter = {str(image_id) for image_id in target_image_ids if image_id}

        source_entries = []
        for point_index, point in enumerate(session.get("points") or []):
            for observation in point.get("observations") or []:
                if str(observation.get("image_id")) != str(source_image_id):
                    continue
                try:
                    px = float(observation.get("px"))
                    py = float(observation.get("py"))
                except (TypeError, ValueError):
                    continue
                source_entries.append({
                    "point": point,
                    "point_index": point_index,
                    "px": px,
                    "py": py
                })
                break
        if not source_entries:
            raise ValueError("The selected image has no points to search")

        session_dir = self.session_dir(session["id"])

        def image_preview_path(image):
            preview_name = image.get("preview")
            if not preview_name:
                raise ValueError("Image preview is missing")
            return safe_child(session_dir, "preview", preview_name)

        def read_gray(path):
            try:
                data = np.fromfile(path, dtype=np.uint8)
            except Exception:
                raise ValueError("Could not read image preview")
            gray = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError("Could not read image preview")
            height, width = gray.shape[:2]
            max_side = 1600.0
            scale = min(1.0, max_side / float(max(width, height)))
            if scale < 1.0:
                gray = cv2.resize(gray, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
            return gray, scale

        def image_observation_point_ids(image_id):
            point_ids = set()
            for point in session.get("points") or []:
                for observation in point.get("observations") or []:
                    if str(observation.get("image_id")) == str(image_id):
                        point_ids.add(str(point.get("id")))
            return point_ids

        def preview_point(image, px, py, cv_scale):
            scale_x = float(image.get("scale_x") or 1)
            scale_y = float(image.get("scale_y") or 1)
            return (px / scale_x) * cv_scale, (py / scale_y) * cv_scale

        def prepared_point(image, preview_x, preview_y, cv_scale):
            scale_x = float(image.get("scale_x") or 1)
            scale_y = float(image.get("scale_y") or 1)
            return (preview_x / cv_scale) * scale_x, (preview_y / cv_scale) * scale_y

        def refine_candidate(source_gray, target_gray, source_x, source_y, target_x, target_y):
            patch_radius = 30
            search_radius = 60
            sx = int(round(source_x))
            sy = int(round(source_y))
            tx = int(round(target_x))
            ty = int(round(target_y))
            if (
                sx - patch_radius < 0 or sy - patch_radius < 0 or
                sx + patch_radius + 1 > source_gray.shape[1] or
                sy + patch_radius + 1 > source_gray.shape[0] or
                tx - search_radius < 0 or ty - search_radius < 0 or
                tx + search_radius + 1 > target_gray.shape[1] or
                ty + search_radius + 1 > target_gray.shape[0]
            ):
                return target_x, target_y, None

            patch = source_gray[sy - patch_radius:sy + patch_radius + 1, sx - patch_radius:sx + patch_radius + 1]
            search = target_gray[ty - search_radius:ty + search_radius + 1, tx - search_radius:tx + search_radius + 1]
            if patch.std() < 4 or search.std() < 4:
                return target_x, target_y, None
            response = cv2.matchTemplate(search, patch, cv2.TM_CCOEFF_NORMED)
            _, best_score, _, best_loc = cv2.minMaxLoc(response)
            refined_x = tx - search_radius + best_loc[0] + patch_radius
            refined_y = ty - search_radius + best_loc[1] + patch_radius
            return float(refined_x), float(refined_y), float(best_score)

        source_gray, source_cv_scale = read_gray(image_preview_path(source_image))
        source_keypoints, source_descriptors = detector.detectAndCompute(source_gray, None)
        if source_descriptors is None or len(source_keypoints) < feature_tools["min_keypoints"]:
            raise ValueError("Not enough visual features on the selected image for {}".format(feature_tools["label"]))

        source_points = []
        for entry in source_entries:
            sx, sy = preview_point(source_image, entry["px"], entry["py"], source_cv_scale)
            source_points.append((entry, sx, sy))

        results = {}
        candidates = {}
        for target_image in images:
            target_id = str(target_image.get("id"))
            if target_id == str(source_image_id):
                continue
            if target_filter is not None and target_id not in target_filter:
                continue

            existing_point_ids = image_observation_point_ids(target_id)
            searchable_points = [
                item for item in source_points
                if str(item[0]["point"].get("id")) not in existing_point_ids
            ]
            if not searchable_points:
                continue

            try:
                target_gray, target_cv_scale = read_gray(image_preview_path(target_image))
            except ValueError:
                continue
            target_keypoints, target_descriptors = detector.detectAndCompute(target_gray, None)
            if target_descriptors is None or len(target_keypoints) < feature_tools["min_keypoints"]:
                continue

            raw_matches = matcher.knnMatch(source_descriptors, target_descriptors, k=2)
            good_matches = []
            for pair in raw_matches:
                if len(pair) < 2:
                    continue
                first, second = pair
                if first.distance < feature_tools["ratio"] * second.distance:
                    good_matches.append(first)
            if len(good_matches) < feature_tools["min_matches"]:
                continue

            good_matches = sorted(good_matches, key=lambda match: match.distance)[:feature_tools["max_matches"]]
            src_pts = np.float32([source_keypoints[match.queryIdx].pt for match in good_matches]).reshape(-1, 1, 2)
            dst_pts = np.float32([target_keypoints[match.trainIdx].pt for match in good_matches]).reshape(-1, 1, 2)
            homography, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, feature_tools["ransac_reprojection"])
            if homography is None or mask is None:
                continue

            inliers = int(mask.ravel().sum())
            inlier_ratio = inliers / float(max(len(good_matches), 1))
            if inliers < feature_tools["min_inliers"] or inlier_ratio < feature_tools["min_inlier_ratio"]:
                continue
            source_inlier_points = src_pts[mask.ravel() == 1].reshape(-1, 2)
            source_hull = cv2.convexHull(source_inlier_points) if len(source_inlier_points) >= 3 else None

            found = []
            target_height, target_width = target_gray.shape[:2]
            for entry, source_x, source_y in searchable_points:
                if source_hull is not None:
                    hull_distance = cv2.pointPolygonTest(source_hull, (float(source_x), float(source_y)), True)
                    if hull_distance < -80:
                        continue
                transformed = cv2.perspectiveTransform(
                    np.float32([[[source_x, source_y]]]),
                    homography
                )[0][0]
                target_x = float(transformed[0])
                target_y = float(transformed[1])
                if target_x < 0 or target_y < 0 or target_x >= target_width or target_y >= target_height:
                    continue

                refined_x, refined_y, local_score = refine_candidate(
                    source_gray,
                    target_gray,
                    source_x,
                    source_y,
                    target_x,
                    target_y
                )
                if local_score is not None and local_score >= 0.35:
                    target_x, target_y = refined_x, refined_y

                px, py = prepared_point(target_image, target_x, target_y, target_cv_scale)
                if px < 0 or py < 0 or px >= float(target_image.get("width") or 0) or py >= float(target_image.get("height") or 0):
                    continue

                confidence = 0.35 + min(inlier_ratio, 0.85) * 0.45 + min(inliers, 80) / 80.0 * 0.20
                if local_score is not None:
                    confidence = confidence * 0.80 + max(0.0, min(local_score, 1.0)) * 0.20
                found.append({
                    "point_id": entry["point"].get("id"),
                    "point_number": entry["point_index"] + 1,
                    "px": round(px, 3),
                    "py": round(py, 3),
                    "score": round(min(confidence, 0.99), 3),
                    "method": "opencv-{}".format(feature_tools["method"])
                })

            if found:
                average_score = sum(float(item.get("score") or 0) for item in found) / len(found)
                results[target_id] = {
                    "count": len(found),
                    "score": round(average_score, 3),
                    "inliers": inliers,
                    "matches": len(good_matches)
                }
                candidates[target_id] = found

        return results, candidates

    def prepare_session(self, request):
        files = request.FILES.getlist("files")
        if not files:
            raise ValueError("No files uploaded")

        self.cleanup_sessions()

        overlap_percent = normalize_overlap_percent(request.POST.get("overlap_percent"))
        capture_height_meters = normalize_capture_height_meters(request.POST.get("capture_height_meters"))
        project_id = request.POST.get("project_id")
        task_info = {}
        if request.POST.get("task_info"):
            try:
                task_info = json.loads(request.POST.get("task_info"))
            except json.JSONDecodeError:
                task_info = {}

        session_id = str(uuid.uuid4())
        session_dir = self.session_dir(session_id)
        source_dir = os.path.join(session_dir, "source")
        prepared_dir = os.path.join(session_dir, "prepared")
        preview_dir = os.path.join(session_dir, "preview")
        os.makedirs(source_dir, exist_ok=True)
        os.makedirs(prepared_dir, exist_ok=True)
        os.makedirs(preview_dir, exist_ok=True)

        source_files = []
        images = []
        videos = []
        gcp_candidates = []
        for uploaded in files:
            filename = unique_filename(source_dir, uploaded.name)
            source_path = os.path.join(source_dir, filename)
            save_uploaded_file(uploaded, source_path)

            source_entry = {
                "filename": filename,
                "original_name": uploaded.name,
                "size": os.path.getsize(source_path),
                "kind": "image" if is_image_name(filename) else "video" if is_video_name(filename) else "other"
            }
            source_files.append(source_entry)
            if source_entry["kind"] == "image":
                images.append(source_entry)
            elif source_entry["kind"] == "video":
                videos.append(source_entry)
            elif is_text_name(filename):
                gcp_candidates.append(source_entry)

        prepared_images = self.prepare_images(session_id, images, overlap_percent, capture_height_meters)
        prepared_images += self.prepare_videos(session_id, videos, overlap_percent, capture_height_meters)

        if len(prepared_images) < 1:
            raise ValueError("No supported image or video files were prepared")

        imported_points, import_message = self.import_gcp_points(session_id, prepared_images, gcp_candidates)

        session = {
            "id": session_id,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "project_id": int(project_id) if str(project_id or "").isdigit() else None,
            "overlap_percent": overlap_percent,
            "capture_height_meters": capture_height_meters,
            "source_files": source_files,
            "images": prepared_images,
            "points": imported_points,
            "raw_srs": "EPSG:4326",
            "task_info": task_info
        }
        if import_message:
            session["message"] = import_message
        if imported_points:
            session["message"] = (session.get("message") or "") + " GCP-файл підтягнуто автоматично, але після x4-покращення координати можуть бути нестабільні. Перевірте точки вручну."
        self.save_session(session)
        if imported_points:
            self.write_gcp_file(session)
            self.save_session(session)
        return {
            "success": True,
            "session_id": session_id,
            "markup_url": "/plugins/{}/session/{}/markup/".format(self.get_name(), session_id),
            "prepared_count": len(prepared_images),
            "source_count": len(source_files)
        }

    def prepare_images(self, session_id, images, overlap_percent, capture_height_meters):
        if not images:
            return []

        session_dir = self.session_dir(session_id)
        source_dir = os.path.join(session_dir, "source")
        prepared_dir = os.path.join(session_dir, "prepared")
        preview_dir = os.path.join(session_dir, "preview")
        step = max(1, round(get_photo_base_step(overlap_percent) * get_capture_height_factor(capture_height_meters)))
        selected = []
        last_index = len(images) - 1

        for index, image in enumerate(images):
            if index == 0 or index % step == 0 or index == last_index:
                selected.append(image)

        result = []
        for image in selected:
            source_path = os.path.join(source_dir, image["filename"])
            prepared_name = unique_filename(prepared_dir, image["filename"])
            prepared_path = os.path.join(prepared_dir, prepared_name)
            shutil.copy2(source_path, prepared_path)
            preview_name, metadata = self.create_preview(prepared_path, preview_dir, prepared_name)
            result.append({
                "id": str(uuid.uuid4()),
                "kind": "photo",
                "filename": prepared_name,
                "source_name": image["original_name"],
                "captured_at": metadata.get("captured_at") or "",
                "preview": preview_name,
                "width": metadata["width"],
                "height": metadata["height"],
                "preview_width": metadata["preview_width"],
                "preview_height": metadata["preview_height"],
                "scale_x": metadata["scale_x"],
                "scale_y": metadata["scale_y"]
            })
        return result

    def prepare_videos(self, session_id, videos, overlap_percent, capture_height_meters):
        if not videos:
            return []

        ffmpeg = self.find_ffmpeg()
        if not ffmpeg:
            raise ValueError("FFmpeg executable was not found")

        session_dir = self.session_dir(session_id)
        source_dir = os.path.join(session_dir, "source")
        prepared_dir = os.path.join(session_dir, "prepared")
        preview_dir = os.path.join(session_dir, "preview")
        interval = max(0.2, min(6, get_video_base_interval_seconds(overlap_percent) * get_capture_height_factor(capture_height_meters)))
        fps = 1.0 / interval
        result = []

        for video_index, video in enumerate(videos, start=1):
            video_source = os.path.join(source_dir, video["filename"])
            stem = os.path.splitext(get_valid_filename(video["filename"]))[0]
            output_pattern = os.path.join(prepared_dir, "{}_frame_%06d.jpg".format(stem))
            completed = subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel", "error",
                    "-i", video_source,
                    "-vf", "fps={:.6f}".format(fps),
                    "-q:v", "2",
                    output_pattern
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True
            )
            if completed.returncode != 0:
                raise ValueError("Could not extract frames from {}: {}".format(video["original_name"], completed.stderr.strip()))

            frame_names = sorted([
                name for name in os.listdir(prepared_dir)
                if name.startswith("{}_frame_".format(stem)) and name.lower().endswith(".jpg")
            ])
            for frame_index, frame_name in enumerate(frame_names, start=1):
                frame_path = os.path.join(prepared_dir, frame_name)
                preview_name, metadata = self.create_preview(frame_path, preview_dir, frame_name)
                result.append({
                    "id": str(uuid.uuid4()),
                    "kind": "video_frame",
                    "filename": frame_name,
                    "source_name": video["original_name"],
                    "frame_index": frame_index,
                    "video_index": video_index,
                    "frame_seconds": round((frame_index - 1) * interval, 3),
                    "preview": preview_name,
                    "width": metadata["width"],
                    "height": metadata["height"],
                    "preview_width": metadata["preview_width"],
                    "preview_height": metadata["preview_height"],
                    "scale_x": metadata["scale_x"],
                    "scale_y": metadata["scale_y"]
                })
        return result

    def import_gcp_points(self, session_id, prepared_images, gcp_candidates):
        if not gcp_candidates:
            return [], ""

        session_dir = self.session_dir(session_id)
        source_dir = os.path.join(session_dir, "source")
        image_map = {}
        for image in prepared_images:
            for key in (image.get("filename"), image.get("source_name")):
                if key:
                    image_map[os.path.basename(key).lower()] = image

        for candidate in gcp_candidates:
            gcp_path = safe_child(source_dir, candidate["filename"])
            try:
                points, matched_count, skipped_count = self.parse_gcp_file(gcp_path, image_map)
            except ValueError as e:
                logger.warning("Could not import GCP file %s: %s", gcp_path, e)
                continue
            if points:
                message = "Імпортовано {} GCP-точок".format(len(points))
                if skipped_count:
                    message += " Пропущено {} позначок без відповідного кадру.".format(skipped_count)
                return points, message

        return [], "GCP-файл не вдалося імпортувати."

    def parse_gcp_file(self, gcp_path, image_map):
        with open(gcp_path, "r", encoding="utf-8-sig", errors="replace") as f:
            lines = [line.strip() for line in f.read().splitlines()]
        lines = [line for line in lines if line and not line.startswith("#")]
        if len(lines) < 2:
            raise ValueError("GCP file is empty")

        raw_srs = lines[0]
        transformer = self.create_gcp_transformer(raw_srs)
        grouped = {}
        skipped_count = 0
        matched_count = 0

        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 6:
                skipped_count += 1
                continue
            try:
                source_x = float(parts[0])
                source_y = float(parts[1])
                z = float(parts[2])
                px = float(parts[3])
                py = float(parts[4])
            except ValueError:
                skipped_count += 1
                continue

            filename = os.path.basename(" ".join(parts[5:])).lower()
            image = image_map.get(filename)
            if not image:
                skipped_count += 1
                continue

            lng, lat = transformer(source_x, source_y)
            key = "{:.4f}:{:.4f}:{:.3f}".format(source_x, source_y, z)
            if key not in grouped:
                grouped[key] = {
                    "id": str(uuid.uuid4()),
                    "name": "GCP {}".format(len(grouped) + 1),
                    "x": round(lng, 8),
                    "y": round(lat, 8),
                    "z": z,
                    "observations": []
                }
            grouped[key]["observations"].append({
                "image_id": image["id"],
                "px": px,
                "py": py
            })
            matched_count += 1

        if matched_count < 1:
            raise ValueError("No GCP entries matched prepared images")
        return list(grouped.values()), matched_count, skipped_count

    def create_gcp_transformer(self, raw_srs):
        if is_wgs84_lonlat_srs(raw_srs):
            return lambda x, y: (x, y)

        try:
            if hasattr(CRS, "from_user_input"):
                source_crs = CRS.from_user_input(raw_srs)
            else:
                source_crs = CRS.from_string(raw_srs)
        except Exception as e:
            raise ValueError("Unsupported GCP CRS: {}".format(e))

        target_crs = CRS.from_epsg(4326)

        def transform_coordinate(x, y):
            lngs, lats = rio_transform(source_crs, target_crs, [x], [y])
            return lngs[0], lats[0]

        return transform_coordinate

    def create_preview(self, image_path, preview_dir, prepared_name):
        with open(image_path, "rb") as image_file:
            image_bytes = image_file.read()

        with Image.open(BytesIO(image_bytes)) as opened:
            opened.load()
            captured_at = ""
            try:
                exif = opened.getexif()
                captured_at = parse_exif_datetime(exif.get(36867) or exif.get(36868) or exif.get(306))
            except Exception:
                captured_at = ""
            image = ImageOps.exif_transpose(opened).copy()

        width, height = image.size
        preview = image.convert("RGB")
        preview.thumbnail((MAX_PREVIEW_SIDE, MAX_PREVIEW_SIDE), Image.LANCZOS)
        preview_width, preview_height = preview.size
        preview_name = "{}.jpg".format(os.path.splitext(prepared_name)[0])
        preview_name = unique_filename(preview_dir, preview_name)
        preview_path = os.path.join(preview_dir, preview_name)
        preview.save(preview_path, quality=88, optimize=True)

        return preview_name, {
            "width": width,
            "height": height,
            "preview_width": preview_width,
            "preview_height": preview_height,
            "scale_x": width / float(preview_width or width),
            "scale_y": height / float(preview_height or height),
            "captured_at": captured_at
        }

    def enhance_session_images(self, session, image_ids=None, apply_all=False, enhancement_mode=None):
        if session.get("preparation_locked"):
            raise ValueError("Enhancement is blocked because GCP markup has started")
        enhancement_mode = normalize_enhancement_mode(enhancement_mode)
        enhancement_options = ENHANCEMENT_MODES[enhancement_mode]
        esrgan_tile = enhancement_options["tile"]
        images = session.get("images", [])
        if not images:
            raise ValueError("No prepared images to enhance")

        requested_ids = {str(image_id) for image_id in (image_ids or []) if image_id}
        selected = images if apply_all else [image for image in images if str(image.get("id")) in requested_ids]
        if not selected:
            raise ValueError("Select at least one image to enhance")
        selected = [image for image in selected if not image.get("enhanced")]
        if not selected:
            raise ValueError("Selected images are already enhanced")

        esrgan = self.find_esrgan()
        session_dir = self.session_dir(session["id"])
        prepared_dir = os.path.join(session_dir, "prepared")
        preview_dir = os.path.join(session_dir, "preview")
        backup_dir = os.path.join(session_dir, "prepared_original")
        original_preview_dir = os.path.join(session_dir, "preview_original")
        tmp_dir = os.path.join(session_dir, "enhance_tmp")
        os.makedirs(backup_dir, exist_ok=True)
        os.makedirs(original_preview_dir, exist_ok=True)
        os.makedirs(tmp_dir, exist_ok=True)

        enhanced_count = 0
        changed_sizes = {}
        try:
            for image in selected:
                old_width = int(image.get("width") or 0)
                old_height = int(image.get("height") or 0)
                original_name = image["filename"]
                extension = extension_of(original_name)
                if extension not in (".jpg", ".jpeg", ".png"):
                    raise ValueError("Enhancement supports JPG and PNG only: {}".format(original_name))

                prepared_path = safe_child(prepared_dir, original_name)
                if not os.path.isfile(prepared_path):
                    raise ValueError("Prepared image not found: {}".format(original_name))

                backup_path = safe_child(backup_dir, original_name)
                if not os.path.isfile(backup_path):
                    shutil.copy2(prepared_path, backup_path)
                if not image.get("original_preview"):
                    original_preview_name, original_metadata = self.create_preview(backup_path, original_preview_dir, original_name)
                    image["original_preview"] = original_preview_name
                    image["original_preview_width"] = original_metadata["preview_width"]
                    image["original_preview_height"] = original_metadata["preview_height"]

                source_path = backup_path
                tmp_stem = "{}_{}".format(os.path.splitext(get_valid_filename(original_name))[0], uuid.uuid4().hex)
                tmp_input = os.path.join(tmp_dir, tmp_stem + extension)
                tmp_esrgan = os.path.join(tmp_dir, tmp_stem + "_x4.png")
                tmp_sharp = os.path.join(tmp_dir, tmp_stem + "_x4_sharp" + extension)

                shutil.copy2(source_path, tmp_input)
                self.run_esrgan(esrgan, tmp_input, tmp_esrgan, esrgan_tile)
                self.apply_sharpen(tmp_esrgan, tmp_sharp)
                os.replace(tmp_sharp, prepared_path)

                preview_name, metadata = self.create_preview(prepared_path, preview_dir, original_name)
                image["preview"] = preview_name
                image["width"] = metadata["width"]
                image["height"] = metadata["height"]
                image["preview_width"] = metadata["preview_width"]
                image["preview_height"] = metadata["preview_height"]
                image["scale_x"] = metadata["scale_x"]
                image["scale_y"] = metadata["scale_y"]
                image["enhanced"] = True
                image["enhancement"] = {
                    "pipeline": "ESRGAN -> Sharpen",
                    "mode": enhancement_mode,
                    "mode_label": enhancement_options["label"],
                    "model": ESRGAN_MODEL,
                    "scale": int(ESRGAN_SCALE),
                    "tile": int(esrgan_tile),
                    "radius": SHARPEN_RADIUS,
                    "percent": SHARPEN_PERCENT,
                    "threshold": SHARPEN_THRESHOLD,
                    "blend": SHARPEN_BLEND
                }
                enhanced_count += 1

                if old_width and old_height and (old_width != metadata["width"] or old_height != metadata["height"]):
                    changed_sizes[image["id"]] = (
                        metadata["width"] / float(old_width),
                        metadata["height"] / float(old_height)
                    )
        finally:
            try:
                shutil.rmtree(tmp_dir)
            except Exception:
                logger.warning("Could not remove Smartpoint enhancement temp dir %s", tmp_dir)

        if changed_sizes:
            self.scale_observations(session, changed_sizes)
            self.write_gcp_file(session)

        session["message"] = "Покращено {} зображень: {}.".format(enhanced_count, enhancement_options["label"])
        return session, enhanced_count

    def start_enhance_job(self, session, image_ids=None, apply_all=False, enhancement_mode=None):
        if session.get("preparation_locked"):
            raise ValueError("Enhancement is blocked because GCP markup has started")
        enhancement_mode = normalize_enhancement_mode(enhancement_mode)
        current = self.load_enhance_job(session["id"])
        if current and current.get("status") == "running":
            return current

        images = session.get("images", [])
        requested_ids = {str(image_id) for image_id in (image_ids or []) if image_id}
        selected = images if apply_all else [image for image in images if str(image.get("id")) in requested_ids]
        selected = [image for image in selected if not image.get("enhanced")]
        if not selected:
            raise ValueError("Selected images are already enhanced")

        total = len(images) if apply_all else len(selected)
        done = len([image for image in images if image.get("enhanced")]) if apply_all else 0
        job = {
            "id": str(uuid.uuid4()),
            "status": "running",
            "apply_all": bool(apply_all),
            "image_ids": [image["id"] for image in selected],
            "done": done,
            "total": total,
            "current_id": "",
            "current": "",
            "enhancement_mode": enhancement_mode,
            "enhancement_label": ENHANCEMENT_MODES[enhancement_mode]["label"],
            "esrgan_tile": int(ENHANCEMENT_MODES[enhancement_mode]["tile"]),
            "errors": []
        }
        self.save_enhance_job(session["id"], job)
        worker = threading.Thread(target=self.run_enhance_job, args=(session["id"], job["id"]), daemon=True)
        worker.start()
        return job

    def run_enhance_job(self, session_id, job_id):
        job = self.load_enhance_job(session_id)
        if not job or job.get("id") != job_id:
            return

        for image_id in list(job.get("image_ids", [])):
            try:
                session = self.load_session(session_id)
                image = next((candidate for candidate in session.get("images", []) if candidate.get("id") == image_id), None)
                if not image or image.get("enhanced"):
                    if not job.get("apply_all"):
                        job["done"] = int(job.get("done") or 0) + 1
                    self.save_enhance_job(session_id, job)
                    continue

                job["current_id"] = image.get("id", "")
                job["current"] = image.get("filename", "")
                self.save_enhance_job(session_id, job)
                session, _ = self.enhance_session_images(
                    session,
                    image_ids=[image_id],
                    apply_all=False,
                    enhancement_mode=job.get("enhancement_mode")
                )
                self.save_session(session)
                if job.get("apply_all"):
                    job["done"] = len([candidate for candidate in session.get("images", []) if candidate.get("enhanced")])
                else:
                    job["done"] = int(job.get("done") or 0) + 1
                self.save_enhance_job(session_id, job)
            except Exception as e:
                logger.exception("Smartpoint enhance job failed for image %s", image_id)
                job["errors"].append(str(e))
                job["status"] = "error"
                job["current_id"] = ""
                job["current"] = ""
                self.save_enhance_job(session_id, job)
                return

        job["status"] = "done"
        job["current_id"] = ""
        job["current"] = ""
        job["done"] = int(job.get("total") or job.get("done") or 0)
        self.save_enhance_job(session_id, job)

    def restore_session_images(self, session, image_ids=None, restore_all=False):
        if session.get("preparation_locked"):
            raise ValueError("Restore is blocked because GCP markup has started")
        images = session.get("images", [])
        if not images:
            raise ValueError("No prepared images to restore")

        requested_ids = {str(image_id) for image_id in (image_ids or []) if image_id}
        selected = images if restore_all else [image for image in images if str(image.get("id")) in requested_ids]
        selected = [image for image in selected if image.get("enhanced")]
        if not selected:
            raise ValueError("Select at least one enhanced image to restore")

        session_dir = self.session_dir(session["id"])
        prepared_dir = os.path.join(session_dir, "prepared")
        preview_dir = os.path.join(session_dir, "preview")
        backup_dir = os.path.join(session_dir, "prepared_original")
        restored_count = 0
        changed_sizes = {}

        for image in selected:
            old_width = int(image.get("width") or 0)
            old_height = int(image.get("height") or 0)
            filename = image["filename"]
            backup_path = safe_child(backup_dir, filename)
            prepared_path = safe_child(prepared_dir, filename)
            if not os.path.isfile(backup_path):
                raise ValueError("Original image backup not found: {}".format(filename))

            shutil.copy2(backup_path, prepared_path)
            preview_name, metadata = self.create_preview(prepared_path, preview_dir, filename)
            image["preview"] = preview_name
            image["width"] = metadata["width"]
            image["height"] = metadata["height"]
            image["preview_width"] = metadata["preview_width"]
            image["preview_height"] = metadata["preview_height"]
            image["scale_x"] = metadata["scale_x"]
            image["scale_y"] = metadata["scale_y"]
            image["enhanced"] = False
            image.pop("enhancement", None)
            image.pop("original_preview", None)
            image.pop("original_preview_width", None)
            image.pop("original_preview_height", None)
            restored_count += 1

            if old_width and old_height and (old_width != metadata["width"] or old_height != metadata["height"]):
                changed_sizes[image["id"]] = (
                    metadata["width"] / float(old_width),
                    metadata["height"] / float(old_height)
                )

        if changed_sizes:
            self.scale_observations(session, changed_sizes)
            self.write_gcp_file(session)

        session["message"] = "Скасовано x4 для {} зображень.".format(restored_count)
        return session, restored_count

    def session_has_image_observations(self, session):
        for point in session.get("points", []):
            for observation in point.get("observations", []):
                if observation.get("image_id"):
                    return True
        return False

    def find_esrgan(self):
        esrgan_dir = os.path.abspath(ESRGAN_DIR)
        executable = os.path.join(esrgan_dir, "realesrgan-ncnn-vulkan.exe")
        models_dir = os.path.join(esrgan_dir, "models")
        model_bin = os.path.join(models_dir, ESRGAN_MODEL + ".bin")
        model_param = os.path.join(models_dir, ESRGAN_MODEL + ".param")
        if not os.path.isfile(executable):
            raise ValueError("Real-ESRGAN executable was not found: {}".format(executable))
        if not os.path.isdir(models_dir):
            raise ValueError("Real-ESRGAN models folder was not found: {}".format(models_dir))
        if not os.path.isfile(model_bin) or not os.path.isfile(model_param):
            raise ValueError("Real-ESRGAN model was not found: {}".format(ESRGAN_MODEL))
        return executable

    def run_esrgan(self, executable, input_path, output_path, tile=None):
        tile = str(ESRGAN_TILE if tile is None else tile)
        args = [
            executable,
            "-i", input_path,
            "-o", output_path,
            "-n", ESRGAN_MODEL,
            "-s", ESRGAN_SCALE,
            "-t", tile
        ]
        completed = subprocess.run(
            args,
            cwd=os.path.dirname(executable),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True
        )
        if completed.returncode != 0:
            raise ValueError("Real-ESRGAN failed: {}".format((completed.stderr or "").strip()))
        if not os.path.isfile(output_path):
            raise ValueError("Real-ESRGAN did not create output")

    def apply_sharpen(self, input_path, output_path):
        with Image.open(input_path) as opened:
            image = opened.convert("RGB")
            sharpened = image.filter(ImageFilter.UnsharpMask(
                radius=SHARPEN_RADIUS,
                percent=SHARPEN_PERCENT,
                threshold=SHARPEN_THRESHOLD
            ))
            sharpened = Image.blend(image, sharpened, SHARPEN_BLEND)

        extension = extension_of(output_path)
        if extension in (".jpg", ".jpeg"):
            sharpened.save(output_path, quality=95, optimize=True)
        elif extension == ".png":
            sharpened.save(output_path, optimize=True)
        else:
            raise ValueError("Unsupported enhanced image format: {}".format(extension))

    def scale_observations(self, session, image_scales):
        for point in session.get("points", []):
            for observation in point.get("observations", []):
                image_id = observation.get("image_id")
                if image_id not in image_scales:
                    continue
                scale_x, scale_y = image_scales[image_id]
                observation["px"] = round(float(observation.get("px") or 0) * scale_x, 3)
                observation["py"] = round(float(observation.get("py") or 0) * scale_y, 3)

    def elevation_cache_path(self):
        return self.get_persistent_path("elevation_cache.json")

    def load_elevation_cache(self):
        path = self.elevation_cache_path()
        if not os.path.isfile(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                cache = json.load(f)
            return cache if isinstance(cache, dict) else {}
        except Exception:
            logger.warning("Could not read Smartpoint elevation cache")
            return {}

    def save_elevation_cache(self, cache):
        path = self.elevation_cache_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False, indent=2)
        except Exception:
            logger.warning("Could not write Smartpoint elevation cache")

    def elevation_cache_key(self, lat, lng):
        return "{:.6f},{:.6f}".format(float(lat), float(lng))

    def request_srtm_elevations(self, locations):
        if not locations:
            return {}

        query = urlencode({
            "locations": "|".join("{:.8f},{:.8f}".format(lat, lng) for lat, lng, _key in locations)
        })
        url = "{}?{}".format(ELEVATION_API_URL, query)
        with urlopen(url, timeout=ELEVATION_TIMEOUT_SECONDS) as response:
            payload = response.read().decode("utf-8")
        data = json.loads(payload)
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            raise ValueError("OpenTopoData returned an invalid response")

        elevations = {}
        for index, result in enumerate(results):
            if index >= len(locations) or not isinstance(result, dict):
                continue
            elevation = result.get("elevation")
            if elevation is None:
                continue
            try:
                elevations[locations[index][2]] = float(elevation)
            except (TypeError, ValueError):
                continue
        return elevations

    def fill_session_gcp_elevations(self, session):
        points = session.get("points") or []
        summary = {
            "provider": ELEVATION_PROVIDER,
            "filled_count": 0,
            "cached_count": 0,
            "missing_count": 0,
            "requested_count": 0,
            "error": ""
        }
        if not points:
            session["elevation"] = summary
            return summary

        cache = self.load_elevation_cache()
        missing = []
        point_keys = {}
        cache_changed = False

        for point in points:
            if not isinstance(point, dict) or not is_missing_gcp_elevation(point.get("z")):
                continue
            try:
                lng = float(point.get("x"))
                lat = float(point.get("y"))
            except (TypeError, ValueError):
                summary["missing_count"] += 1
                continue
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                summary["missing_count"] += 1
                continue

            key = self.elevation_cache_key(lat, lng)
            point_keys[id(point)] = key
            cached = cache.get(key)
            if cached is not None:
                try:
                    point["z"] = round(float(cached), 3)
                    point["z_source"] = "srtm90m-cache"
                    summary["cached_count"] += 1
                    continue
                except (TypeError, ValueError):
                    cache.pop(key, None)
                    cache_changed = True

            missing.append((lat, lng, key, point))

        unique_locations = []
        seen_keys = set()
        for lat, lng, key, _point in missing:
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique_locations.append((lat, lng, key))

        fetched = {}
        try:
            for index in range(0, len(unique_locations), ELEVATION_BATCH_SIZE):
                batch = unique_locations[index:index + ELEVATION_BATCH_SIZE]
                fetched.update(self.request_srtm_elevations(batch))
                summary["requested_count"] += len(batch)
        except Exception as e:
            summary["error"] = str(e)
            logger.warning("Smartpoint SRTM elevation lookup failed: %s", e)

        for lat, lng, key, point in missing:
            elevation = fetched.get(key)
            if elevation is None:
                summary["missing_count"] += 1
                continue
            point["z"] = round(float(elevation), 3)
            point["z_source"] = "srtm90m"
            summary["filled_count"] += 1
            cache[key] = point["z"]
            cache_changed = True

        if cache_changed:
            self.save_elevation_cache(cache)

        session["elevation"] = summary
        return summary

    def find_ffmpeg(self):
        candidates = [
            shutil.which("ffmpeg"),
            os.path.join(settings.BASE_DIR, "..", "python39", "Scripts", "ffmpeg.exe"),
            os.path.join(settings.BASE_DIR, "..", "..", "python39", "Scripts", "ffmpeg.exe"),
            r"C:\WebODM\resources\app\apps\python39\Scripts\ffmpeg.exe"
        ]
        for candidate in candidates:
            if candidate and os.path.isfile(os.path.abspath(candidate)):
                return os.path.abspath(candidate)
        return None

    def write_gcp_file(self, session):
        elevation = self.fill_session_gcp_elevations(session)
        raw_srs = normalize_gcp_srs(session.get("raw_srs"))
        image_map = {image["id"]: image for image in session.get("images", [])}
        lines = [raw_srs]
        entries_count = 0

        for point in session.get("points", []):
            try:
                x = float(point.get("x"))
                y = float(point.get("y"))
                z = float(point.get("z") or 0)
            except (TypeError, ValueError):
                continue

            for observation in point.get("observations", []):
                image = image_map.get(observation.get("image_id"))
                if not image:
                    continue
                try:
                    px = float(observation.get("px"))
                    py = float(observation.get("py"))
                except (TypeError, ValueError):
                    continue
                lines.append("{} {} {} {} {} {}".format(x, y, z, round(px, 3), round(py, 3), image["filename"]))
                entries_count += 1

        gcp_path = safe_child(self.session_dir(session["id"]), "gcp_list.txt")
        with open(gcp_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return gcp_path, entries_count, elevation

    def create_or_update_webodm_draft_task(self, request, session):
        if not session.get("project_id"):
            raise ValueError("Project is missing")

        project = get_and_check_project(request, session["project_id"], ("change_project",))
        if len(session.get("images", [])) < 2:
            raise ValueError("At least 2 prepared images are required to create a task")

        gcp_path, entries_count, _ = self.write_gcp_file(session)

        task_info = session.get("task_info") or {}
        selected_node = task_info.get("selectedNode") or {}
        auto_processing_node = selected_node.get("key") == "auto" or not selected_node.get("id")
        processing_node = None
        if not auto_processing_node:
            try:
                processing_node = ProcessingNode.objects.get(pk=selected_node.get("id"))
            except ProcessingNode.DoesNotExist:
                raise ValueError("Selected processing node does not exist")

        task = None
        task_id = session.get("webodm_task_id")
        if task_id:
            try:
                existing = models.Task.objects.get(pk=task_id, project=project)
                if existing.partial and existing.status is None:
                    task = existing
            except models.Task.DoesNotExist:
                task = None

        if task is None:
            task = models.Task.objects.create(project=project, partial=True)

        task.name = task_info.get("name") or task.name or "Smartpoint task"
        task.options = task_info.get("options") or []
        task.processing_node = processing_node
        task.auto_processing_node = auto_processing_node
        task.resize_to = task_info.get("resizeSize") if task_info.get("resizeMode") == 1 else -1
        task.partial = True

        task.create_task_directories()
        prepared_dir = os.path.join(self.session_dir(session["id"]), "prepared")
        for image in session.get("images", []):
            src = safe_child(prepared_dir, image["filename"])
            dst = task.get_image_path(image["filename"])
            shutil.copy2(src, dst)
        if entries_count > 0 and os.path.isfile(gcp_path):
            shutil.copy2(gcp_path, task.get_image_path("gcp_list.txt"))

        task.images_count = len(task.scan_images())
        task.update_size()
        task.save()
        return task

