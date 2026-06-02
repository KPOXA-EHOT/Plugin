import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import uuid
import gzip
import hashlib
import html
import math
import struct
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
import rasterio
from affine import Affine
from app import models
from app.api.common import check_project_perms
from app.plugins import Menu, MountPoint, PluginBase
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.contrib.gis.geos import Polygon
from django.http import FileResponse, Http404, HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.utils.text import get_valid_filename
from django.views.decorators.http import require_GET, require_POST
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import ColorInterp, Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from rasterio.warp import transform as rio_transform
from rasterio.warp import transform_bounds


logger = logging.getLogger("app.logger")

MAX_PREVIEW_SIDE = 1800
REFERENCE_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".webp"}
PLUGIN_DIR = Path(__file__).resolve().parent
SOFT_TOOLS_DIR = PLUGIN_DIR
DELTA_3D_TILE_CONVERTER_DIR = SOFT_TOOLS_DIR / "bin" / "tile-converter"
DELTA_3D_TILE_CONVERTER_SCRIPT = DELTA_3D_TILE_CONVERTER_DIR / "node_modules" / "@loaders.gl" / "tile-converter" / "bin" / "converter.js"
DELTA_3D_SPECIAL_INDEX_NAME = "@specialIndexFileHASH128@"
DELTA_3D_SCENE_LAYER_NAME = "3dSceneLayer.json.gz"
ELEVATION_PROVIDER = "OpenTopoData SRTM90m"
ELEVATION_API_URL = "https://api.opentopodata.org/v1/srtm90m"
ELEVATION_TIMEOUT_SECONDS = 12


def extension_of(name):
    return os.path.splitext(name or "")[1].lower()


def safe_child(root, *parts):
    root_path = Path(root).resolve()
    child = root_path.joinpath(*parts).resolve()
    if root_path != child and root_path not in child.parents:
        raise Http404("Invalid path")
    return str(child)


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


def read_json_body(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        raise ValueError("Некоректний JSON-запит")


def save_uploaded_file(uploaded, destination_path):
    if hasattr(uploaded, "temporary_file_path"):
        try:
            temporary_path = uploaded.temporary_file_path()
        except Exception:
            temporary_path = None
        if temporary_path and os.path.isfile(temporary_path):
            shutil.copy2(temporary_path, destination_path)
            return

    if hasattr(uploaded, "open"):
        uploaded.open("rb")
    with open(destination_path, "wb+") as dst:
        for chunk in uploaded.chunks():
            dst.write(chunk)


def normalize_preview_array(array):
    array = np.asarray(array)
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=2)
    if array.shape[2] == 1:
        array = np.repeat(array, 3, axis=2)
    if array.shape[2] == 2:
        rgb = np.repeat(array[:, :, :1], 3, axis=2)
        array = np.concatenate([rgb, array[:, :, 1:2]], axis=2)
    if array.shape[2] > 4:
        array = array[:, :, :3]

    if array.dtype == np.uint8:
        return array

    out = array.astype(np.float32)
    rgb = out[:, :, :3]
    finite = np.isfinite(rgb)
    if finite.any():
        low = np.nanpercentile(rgb[finite], 2)
        high = np.nanpercentile(rgb[finite], 98)
        if high > low:
            rgb = np.clip((rgb - low) * 255.0 / (high - low), 0, 255)
        else:
            rgb = np.zeros_like(rgb)
    else:
        rgb = np.zeros_like(rgb)

    out[:, :, :3] = rgb
    if out.shape[2] == 4:
        alpha = out[:, :, 3]
        out[:, :, 3] = np.where(alpha == 0, 0, 255)
    return out.astype(np.uint8)


def raster_preview(source_path, preview_path):
    with rasterio.open(source_path) as dataset:
        width = dataset.width
        height = dataset.height
        scale = min(1.0, float(MAX_PREVIEW_SIDE) / float(max(width, height)))
        preview_width = max(1, int(round(width * scale)))
        preview_height = max(1, int(round(height * scale)))

        colorinterp = dataset.colorinterp
        indexes = [1]
        if len(colorinterp) >= 3:
            if ColorInterp.red in colorinterp and ColorInterp.green in colorinterp and ColorInterp.blue in colorinterp:
                indexes = [
                    colorinterp.index(ColorInterp.red) + 1,
                    colorinterp.index(ColorInterp.green) + 1,
                    colorinterp.index(ColorInterp.blue) + 1,
                ]
            else:
                indexes = [1, 2, 3]
        if ColorInterp.alpha in colorinterp:
            indexes.append(colorinterp.index(ColorInterp.alpha) + 1)

        data = dataset.read(
            indexes=indexes,
            out_shape=(len(indexes), preview_height, preview_width),
            resampling=Resampling.bilinear
        )
        image = normalize_preview_array(np.transpose(data, (1, 2, 0)))
        Image.fromarray(image).save(preview_path)

        crs = dataset.crs.to_string() if dataset.crs else ""
        transform = dataset.transform
        bounds = dataset.bounds
        bounds_wgs84 = None
        if dataset.crs:
            try:
                wgs_bounds = transform_bounds(dataset.crs, "EPSG:4326", bounds.left, bounds.bottom, bounds.right, bounds.top, densify_pts=21)
                bounds_wgs84 = [float(wgs_bounds[0]), float(wgs_bounds[1]), float(wgs_bounds[2]), float(wgs_bounds[3])]
            except Exception:
                bounds_wgs84 = None
        is_georeferenced = bool(dataset.crs and dataset.transform != Affine.identity())
        return {
            "width": width,
            "height": height,
            "preview_width": preview_width,
            "preview_height": preview_height,
            "preview_scale": scale,
            "crs": crs,
            "transform": list(transform)[:6],
            "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
            "bounds_wgs84": bounds_wgs84,
            "georeferenced": is_georeferenced,
            "kind": "raster"
        }


def image_preview(source_path, preview_path):
    with Image.open(source_path) as image:
        image = image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB")
        width, height = image.size
        scale = min(1.0, float(MAX_PREVIEW_SIDE) / float(max(width, height)))
        preview_width = max(1, int(round(width * scale)))
        preview_height = max(1, int(round(height * scale)))
        if scale < 1.0:
            image = image.resize((preview_width, preview_height), Image.LANCZOS)
        image.save(preview_path)
    return {
        "width": width,
        "height": height,
        "preview_width": preview_width,
        "preview_height": preview_height,
        "preview_scale": scale,
        "crs": "",
        "transform": None,
        "bounds": None,
        "bounds_wgs84": None,
        "georeferenced": False,
        "kind": "image"
    }


def create_preview(source_path, preview_path):
    try:
        return raster_preview(source_path, preview_path)
    except Exception:
        return image_preview(source_path, preview_path)


def warped_raster_preview(source_path, preview_path, dst_crs="EPSG:4326"):
    with rasterio.open(source_path) as dataset:
        if not dataset.crs:
            return raster_preview(source_path, preview_path)

        bounds = transform_bounds(
            dataset.crs,
            dst_crs,
            dataset.bounds.left,
            dataset.bounds.bottom,
            dataset.bounds.right,
            dataset.bounds.top,
            densify_pts=21
        )
        left, bottom, right, top = [float(value) for value in bounds]
        span_x = abs(right - left)
        span_y = abs(top - bottom)
        if span_x <= 0 or span_y <= 0:
            return raster_preview(source_path, preview_path)

        if span_x >= span_y:
            preview_width = MAX_PREVIEW_SIDE
            preview_height = max(1, int(round(MAX_PREVIEW_SIDE * span_y / span_x)))
        else:
            preview_height = MAX_PREVIEW_SIDE
            preview_width = max(1, int(round(MAX_PREVIEW_SIDE * span_x / span_y)))

        dst_transform = from_bounds(left, bottom, right, top, preview_width, preview_height)

        colorinterp = dataset.colorinterp
        indexes = [1]
        if len(colorinterp) >= 3:
            if ColorInterp.red in colorinterp and ColorInterp.green in colorinterp and ColorInterp.blue in colorinterp:
                indexes = [
                    colorinterp.index(ColorInterp.red) + 1,
                    colorinterp.index(ColorInterp.green) + 1,
                    colorinterp.index(ColorInterp.blue) + 1,
                ]
            else:
                indexes = [1, 2, 3]
        if ColorInterp.alpha in colorinterp:
            indexes.append(colorinterp.index(ColorInterp.alpha) + 1)

        data = np.zeros(
            (len(indexes), preview_height, preview_width),
            dtype=dataset.dtypes[indexes[0] - 1]
        )
        for output_index, source_index in enumerate(indexes):
            nodata = dataset.nodatavals[source_index - 1] if dataset.nodatavals else None
            band_interp = colorinterp[source_index - 1] if source_index - 1 < len(colorinterp) else None
            resampling = Resampling.nearest if band_interp == ColorInterp.alpha else Resampling.bilinear
            reproject(
                source=rasterio.band(dataset, source_index),
                destination=data[output_index],
                src_transform=dataset.transform,
                src_crs=dataset.crs,
                src_nodata=nodata,
                dst_transform=dst_transform,
                dst_crs=dst_crs,
                dst_nodata=0,
                resampling=resampling
            )

        image = normalize_preview_array(np.transpose(data, (1, 2, 0)))
        Image.fromarray(image).save(preview_path)

        return {
            "width": dataset.width,
            "height": dataset.height,
            "preview_width": preview_width,
            "preview_height": preview_height,
            "preview_scale": min(float(preview_width) / float(dataset.width), float(preview_height) / float(dataset.height)),
            "crs": dst_crs,
            "transform": list(dst_transform)[:6],
            "bounds": [left, bottom, right, top],
            "bounds_wgs84": [left, bottom, right, top],
            "georeferenced": True,
            "kind": "warped_raster"
        }


def raster_metadata_from_transform(width, height, crs, transform):
    corners = [
        transform * (0, 0),
        transform * (width, 0),
        transform * (width, height),
        transform * (0, height)
    ]
    xs = [float(point[0]) for point in corners]
    ys = [float(point[1]) for point in corners]
    bounds = [min(xs), min(ys), max(xs), max(ys)]
    bounds_wgs84 = None
    if crs:
        try:
            wgs_xs, wgs_ys = rio_transform(crs, "EPSG:4326", xs, ys)
            bounds_wgs84 = [float(min(wgs_xs)), float(min(wgs_ys)), float(max(wgs_xs)), float(max(wgs_ys))]
        except Exception:
            bounds_wgs84 = None
    return {
        "width": width,
        "height": height,
        "crs": crs,
        "transform": list(transform)[:6],
        "bounds": bounds,
        "bounds_wgs84": bounds_wgs84,
        "georeferenced": bool(crs and transform != Affine.identity()),
        "kind": "raster"
    }


def parse_point_pair(pair):
    ortho = pair.get("ortho") or {}
    return (
        float(ortho.get("x")),
        float(ortho.get("y")),
    )


def reference_pixel_to_world(reference_meta, x, y):
    transform_values = reference_meta.get("transform")
    if not transform_values:
        raise ValueError("Референс не має геоприв’язки")
    transform = Affine(*transform_values)
    world_x, world_y = transform * (x, y)
    return float(world_x), float(world_y)


def lonlat_to_world(lon, lat, target_crs):
    if not target_crs:
        return float(lon), float(lat)
    xs, ys = rio_transform("EPSG:4326", target_crs, [float(lon)], [float(lat)])
    return float(xs[0]), float(ys[0])


def solve_similarity(source, target):
    if len(source) != 2:
        raise ValueError("Для similarity-трансформації потрібно рівно 2 точки")

    p1, p2 = source
    q1, q2 = target
    dp = p2 - p1
    dq = q2 - q1
    source_len = np.linalg.norm(dp)
    target_len = np.linalg.norm(dq)
    if source_len <= 0 or target_len <= 0:
        raise ValueError("Пари точок вироджені або дублюються")

    scale = target_len / source_len
    source_angle = np.arctan2(dp[1], dp[0])
    target_angle = np.arctan2(dq[1], dq[0])
    theta = target_angle - source_angle
    cos_t = np.cos(theta) * scale
    sin_t = np.sin(theta) * scale

    matrix = np.array([
        [cos_t, -sin_t, 0.0],
        [sin_t, cos_t, 0.0],
    ], dtype=np.float64)
    translation = q1 - matrix[:, :2].dot(p1)
    matrix[:, 2] = translation
    return matrix


def solve_affine(source, target):
    if len(source) < 3:
        raise ValueError("Для affine-трансформації потрібно щонайменше 3 точки")

    rows = []
    values = []
    for (x, y), (world_x, world_y) in zip(source, target):
        rows.append([x, y, 1, 0, 0, 0])
        rows.append([0, 0, 0, x, y, 1])
        values.append(world_x)
        values.append(world_y)

    params, residuals, rank, _ = np.linalg.lstsq(np.asarray(rows), np.asarray(values), rcond=None)
    if rank < 6:
        raise ValueError("Пари точок вироджені або дублюються")
    return np.array([
        [params[0], params[1], params[2]],
        [params[3], params[4], params[5]],
    ], dtype=np.float64)


def transform_points(matrix, source):
    ones = np.ones((source.shape[0], 1), dtype=np.float64)
    homogeneous = np.concatenate([source, ones], axis=1)
    return homogeneous.dot(matrix.T)


def transform_xy(affine_transform, x, y):
    new_x, new_y = affine_transform * (float(x), float(y))
    return float(new_x), float(new_y)


def solve_umeyama_3d(source, target, with_scale=True):
    source = np.asarray(source, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    if source.ndim != 2 or target.ndim != 2 or source.shape != target.shape or source.shape[1] != 3:
        raise ValueError("3D точки мають бути масивами Nx3")
    if source.shape[0] < 3:
        raise ValueError("Для 3D прив’язки потрібно щонайменше 3 пари точок")

    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    if np.linalg.matrix_rank(source_centered) < 2:
        raise ValueError("3D точки вироджені: виберіть точки в різних частинах моделі")

    covariance = (target_centered.T @ source_centered) / float(source.shape[0])
    u, singular_values, vt = np.linalg.svd(covariance)
    correction = np.eye(3, dtype=np.float64)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        correction[-1, -1] = -1

    rotation = u @ correction @ vt
    if with_scale:
        source_variance = np.mean(np.sum(source_centered ** 2, axis=1))
        if source_variance <= 0:
            raise ValueError("3D точки вироджені або дублюються")
        scale = float(np.trace(np.diag(singular_values) @ correction) / source_variance)
    else:
        scale = 1.0

    translation = target_mean - scale * rotation @ source_mean
    return scale, rotation, translation


def apply_similarity_3d(points, scale, rotation, translation):
    points = np.asarray(points, dtype=np.float64)
    return (scale * (rotation @ points.T)).T + translation


def format_coord(value):
    text = "{:.8f}".format(float(value)).rstrip("0").rstrip(".")
    if text == "-0":
        return "0"
    return text


def parse_obj_vertex(line):
    parts = line.strip().split()
    if len(parts) < 4 or parts[0] != "v":
        return None
    try:
        return float(parts[1]), float(parts[2]), float(parts[3]), parts[4:]
    except ValueError:
        return None


def quality_status(rmse):
    if rmse < 1.0:
        return "GOOD"
    if rmse < 3.0:
        return "ACCEPTABLE"
    if rmse < 10.0:
        return "POOR"
    return "FAILED"


def localize_quality(value):
    key = str(value or "").upper()
    if key == "GOOD":
        return "добре"
    if key == "ACCEPTABLE":
        return "прийнятно"
    if key == "POOR":
        return "слабко"
    if key == "FAILED":
        return "помилка"
    return value or ""


def localize_transform_type(value):
    if value == "similarity":
        return "поворот / масштаб / зсув"
    if value == "affine":
        return "affine"
    return value or ""


class SmartAlignMixin(object):
    def main_menu(self):
        return [Menu("Smartpoint", self.public_url(""), "fa fa-crosshairs fa-fw")]

    def include_js_files(self):
        return ["smart_align.js"]

    def include_css_files(self):
        return ["smart_align.css"]

    def smartalign_mount_points(self):
        @login_required
        def dashboard(request):
            return render(request, self.template_path("dashboard.html"), {
                "title": "Smartpoint"
            })

        @login_required
        def align_page(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            if "orthophoto.tif" not in (task.available_assets or []):
                raise Http404("У задачі немає orthophoto.tif")
            return render(request, self.template_path("align.html"), {
                "title": "Smartpoint",
                "project_id": project_id,
                "task_id": task_id
            })

        @login_required
        @require_GET
        def task_info(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                ortho_meta = self.ensure_orthophoto_preview(task)
            except ValueError as e:
                return HttpResponseBadRequest(str(e))

            return JsonResponse({
                "success": True,
                "project_id": str(task.project_id),
                "task_id": str(task.id),
                "task_name": task.name or "",
                "available_assets": task.available_assets or [],
                "orthophoto": ortho_meta,
                "orthophoto_preview_url": self.api_url(task, "file/orthophoto_preview.png"),
                "reference": self.load_reference_metadata(task),
                "alignment": self.load_alignment(task),
                "replacement": self.public_replacement_metadata(self.load_replacement(task)),
                "replacement_3d": self.public_replacement_3d_metadata(self.load_replacement_3d(task)),
                "alignment_3d": self.load_alignment_3d(task),
                "three_d": self.public_3d_status(task)
            })

        @login_required
        @require_GET
        def task_status(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            alignment_ready = bool(self.load_json(task, "alignment.json"))
            replacement_active = bool((self.load_replacement(task) or {}).get("active"))
            preprocessing_gcp = self.task_has_gcp_file(task)
            return JsonResponse({
                "success": True,
                "project_id": str(task.project_id),
                "task_id": str(task.id),
                "orthophoto_georeferenced": self.is_orthophoto_georeferenced(task),
                "alignment_ready": alignment_ready,
                "replacement_active": replacement_active,
                "preprocessing_gcp": preprocessing_gcp,
                "smartpoint_bound": preprocessing_gcp or alignment_ready or replacement_active
            })

        @login_required
        @require_GET
        def orthophotos(request, project_id, task_id):
            self.get_task(request, project_id, task_id)
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
        def upload_reference(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            uploaded = request.FILES.get("reference")
            if not uploaded:
                return HttpResponseBadRequest("Не передано файл референсу")
            if extension_of(uploaded.name) not in REFERENCE_EXTENSIONS:
                return HttpResponseBadRequest("Непідтримуваний формат референсу")

            output_dir = self.smartalign_dir(task)
            reference_dir = safe_child(output_dir, "reference")
            os.makedirs(reference_dir, exist_ok=True)

            filename = get_valid_filename(uploaded.name or "reference")
            source_path = safe_child(reference_dir, filename)
            save_uploaded_file(uploaded, source_path)

            preview_path = safe_child(output_dir, "reference_preview.png")
            try:
                metadata = create_preview(source_path, preview_path)
            except Exception as e:
                logger.exception("SmartAlign reference preview failed")
                return HttpResponseBadRequest("Не вдалося прочитати референс: {}".format(e))

            metadata.update({
                "id": str(uuid.uuid4()),
                "filename": filename,
                "path": source_path,
                "preview_url": self.api_url(task, "file/reference_preview.png")
            })
            metadata["preview_url"] = "{}?v={}".format(metadata["preview_url"], metadata["id"])
            self.save_json(task, "reference.json", metadata)
            return JsonResponse({"success": True, "reference": self.public_reference_metadata(metadata)})

        @login_required
        @require_POST
        def apply_alignment(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                payload = read_json_body(request)
                result = self.apply_alignment(task, payload.get("points") or [])
                return JsonResponse({"success": True, "alignment": result})
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign apply alignment failed")
                return HttpResponseBadRequest("SmartAlign не зміг виконати операцію: {}".format(e))

        @login_required
        @require_POST
        def align_3d(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                payload = read_json_body(request) if request.body else {}
                if payload.get("points"):
                    result = self.align_3d_model_from_points(task, payload.get("points") or [])
                else:
                    result = self.align_3d_model(task, payload.get("placement") or {})
                return JsonResponse({"success": True, "alignment_3d": result})
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign 3D alignment failed")
                return HttpResponseBadRequest("Не вдалося створити aligned 3D модель: {}".format(e))

        @login_required
        @require_POST
        def delta_3d(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                result = self.create_delta_3d_export(task)
                return JsonResponse({"success": True, "alignment_3d": result})
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign 3D Delta export failed")
                return HttpResponseBadRequest("SmartAlign 3D Delta export failed: {}".format(e))

        @login_required
        @require_POST
        def replace_3d(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.replace_webodm_3d_model(task)
                return JsonResponse({
                    "success": True,
                    "replacement_3d": replacement,
                    "alignment_3d": self.load_alignment_3d(task),
                    "three_d": self.public_3d_status(task)
                })
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign replace 3D failed")
                return HttpResponseBadRequest("SmartAlign replace 3D failed: {}".format(e))

        @login_required
        @require_POST
        def restore_3d(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.restore_webodm_3d_model(task)
                return JsonResponse({
                    "success": True,
                    "replacement_3d": replacement,
                    "alignment_3d": self.load_alignment_3d(task),
                    "three_d": self.public_3d_status(task)
                })
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign restore 3D failed")
                return HttpResponseBadRequest("SmartAlign restore 3D failed: {}".format(e))

        @login_required
        @require_POST
        def replace_orthophoto(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.replace_webodm_orthophoto(task)
                return JsonResponse({
                    "success": True,
                    "replacement": replacement,
                    "alignment": self.load_alignment(task)
                })
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign replace orthophoto failed")
                return HttpResponseBadRequest("Не вдалося замінити ортофото: {}".format(e))

        @login_required
        @require_POST
        def apply_replacement(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.replace_webodm_orthophoto(task)
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign apply orthophoto failed")
                return HttpResponseBadRequest("Не вдалося застосувати ортофото: {}".format(e))

            return JsonResponse({
                "success": True,
                "replacement": replacement,
                "replacement_3d": self.public_replacement_3d_metadata(self.load_replacement_3d(task)),
                "alignment": self.load_alignment(task),
                "alignment_3d": self.load_alignment_3d(task),
                "three_d": self.public_3d_status(task),
                "warnings": []
            })

        @login_required
        @require_POST
        def restore_orthophoto(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.restore_webodm_orthophoto(task)
                return JsonResponse({
                    "success": True,
                    "replacement": replacement,
                    "alignment": self.load_alignment(task)
                })
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign restore orthophoto failed")
                return HttpResponseBadRequest("Не вдалося відновити ортофото: {}".format(e))

        @login_required
        @require_POST
        def restore_replacement(request, project_id, task_id):
            task = self.get_task(request, project_id, task_id)
            try:
                replacement = self.restore_webodm_orthophoto(task)
            except ValueError as e:
                return HttpResponseBadRequest(str(e))
            except Exception as e:
                logger.exception("SmartAlign restore orthophoto failed")
                return HttpResponseBadRequest("Не вдалося відновити ортофото: {}".format(e))
            return JsonResponse({
                "success": True,
                "replacement": replacement,
                "replacement_3d": self.public_replacement_3d_metadata(self.load_replacement_3d(task)),
                "alignment": self.load_alignment(task),
                "alignment_3d": self.load_alignment_3d(task),
                "three_d": self.public_3d_status(task),
                "warnings": []
            })

        @login_required
        @require_GET
        def smartalign_file(request, project_id, task_id, filename):
            task = self.get_task(request, project_id, task_id)
            file_path = safe_child(self.smartalign_dir(task), filename)
            if not os.path.isfile(file_path):
                raise Http404("Файл не знайдено")
            content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
            as_attachment = request.GET.get("download") is not None
            return FileResponse(open(file_path, "rb"), as_attachment=as_attachment, filename=os.path.basename(file_path), content_type=content_type)

        @login_required
        @require_GET
        def source_3d_file(request, project_id, task_id, filename):
            task = self.get_task(request, project_id, task_id)
            source_obj = self.find_original_3d_obj_source(task)
            source_dir = os.path.dirname(source_obj)
            file_path = safe_child(source_dir, filename)
            if not os.path.isfile(file_path):
                raise Http404("Файл не знайдено")
            content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
            return FileResponse(open(file_path, "rb"), filename=os.path.basename(file_path), content_type=content_type)

        return [
            MountPoint("smartalign/$", dashboard),
            MountPoint("align/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/$", align_page),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/$", task_info),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/status/$", task_status),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/orthophotos/$", orthophotos),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/reference/$", upload_reference),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/apply/$", apply_alignment),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/align-3d/$", align_3d),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/delta-3d/$", delta_3d),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/replace-3d/$", replace_3d),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/restore-3d/$", restore_3d),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/apply-replacement/$", apply_replacement),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/replace/$", replace_orthophoto),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/restore-replacement/$", restore_replacement),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/restore/$", restore_orthophoto),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/source-3d/(?P<filename>.+)$", source_3d_file),
            MountPoint("api/project/(?P<project_id>[^/]+)/task/(?P<task_id>[^/]+)/file/(?P<filename>.+)$", smartalign_file)
        ]

    def get_task(self, request, project_id, task_id):
        try:
            task = models.Task.objects.select_related("project").get(pk=task_id, project=project_id)
        except Exception:
            raise Http404("Задачу не знайдено")
        check_project_perms(request, task.project)
        return task

    def smartalign_dir(self, task):
        path = task.assets_path("smartalign")
        os.makedirs(path, exist_ok=True)
        return path

    def api_url(self, task, tail):
        return "/plugins/{}/api/project/{}/task/{}/{}".format(self.get_name(), task.project_id, task.id, tail)

    def is_orthophoto_georeferenced(self, task):
        try:
            path = task.get_asset_download_path("orthophoto.tif")
            if not path or not os.path.isfile(path):
                return False
            with rasterio.open(path) as dataset:
                return bool(dataset.crs and dataset.transform != Affine.identity())
        except Exception:
            logger.warning("SmartAlign could not inspect orthophoto georeference", exc_info=True)
            return False

    def task_has_gcp_file(self, task):
        candidates = []
        for getter in (
            lambda: task.get_image_path("gcp_list.txt"),
            lambda: task.task_path("gcp_list.txt"),
            lambda: task.assets_path("gcp_list.txt"),
        ):
            try:
                candidates.append(getter())
            except Exception:
                pass
        return any(path and os.path.isfile(path) for path in candidates)

    def save_json(self, task, name, data):
        path = safe_child(self.smartalign_dir(task), name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return path

    def load_json(self, task, name):
        path = safe_child(self.smartalign_dir(task), name)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            logger.warning("SmartAlign could not read %s", path)
            return None

    def public_reference_metadata(self, metadata):
        if not metadata:
            return None
        cleaned = dict(metadata)
        cleaned.pop("path", None)
        return cleaned

    def load_reference_metadata(self, task):
        return self.public_reference_metadata(self.load_json(task, "reference.json"))

    def load_alignment(self, task):
        alignment = self.load_json(task, "alignment.json")
        if alignment:
            alignment = self.ensure_aligned_preview(task, alignment)
        return alignment

    def load_replacement(self, task):
        return self.load_json(task, "replacement.json")

    def load_replacement_3d(self, task):
        return self.load_json(task, "replacement_3d.json")

    def load_alignment_3d(self, task):
        alignment_3d = self.load_json(task, "alignment_3d.json")
        if not alignment_3d:
            return None
        cleaned = dict(alignment_3d)
        cleaned.pop("source_path", None)
        cleaned.pop("output_path", None)
        cleaned.pop("zip_path", None)
        return cleaned

    def get_3d_status(self, task):
        ortho_meta = None
        try:
            ortho_meta = self.ensure_orthophoto_preview(task)
        except Exception as e:
            ortho_error = str(e)
        else:
            ortho_error = None

        obj = self.inspect_first_asset(task, "OBJ", [
            ("odm_texturing/odm_textured_model_geo.obj", ("odm_texturing", "odm_textured_model_geo.obj")),
            ("odm_texturing_25d/odm_textured_model_geo.obj", ("odm_texturing_25d", "odm_textured_model_geo.obj")),
            ("odm_texturing/odm_textured_model.obj", ("odm_texturing", "odm_textured_model.obj")),
            ("odm_texturing_25d/odm_textured_model.obj", ("odm_texturing_25d", "odm_textured_model.obj")),
        ], lambda path: self.inspect_obj_asset(path, ortho_meta))
        glb = self.inspect_first_asset(task, "GLB", [
            ("odm_texturing/odm_textured_model_geo.glb", ("odm_texturing", "odm_textured_model_geo.glb")),
            ("odm_texturing_25d/odm_textured_model_geo.glb", ("odm_texturing_25d", "odm_textured_model_geo.glb")),
            ("odm_texturing/odm_textured_model.glb", ("odm_texturing", "odm_textured_model.glb")),
            ("odm_texturing_25d/odm_textured_model.glb", ("odm_texturing_25d", "odm_textured_model.glb")),
        ])
        laz = self.inspect_first_asset(task, "LAZ", [
            ("odm_georeferencing/odm_georeferenced_model.laz", ("odm_georeferencing", "odm_georeferenced_model.laz")),
            ("odm_georeferencing/odm_georeferenced_model.las", ("odm_georeferencing", "odm_georeferenced_model.las")),
        ])
        ept = self.inspect_first_asset(task, "EPT", [
            ("entwine_pointcloud/ept.json", ("entwine_pointcloud", "ept.json")),
        ], self.inspect_ept_asset)
        dsm = self.inspect_first_asset(task, "DSM", [
            ("odm_dem/dsm.tif", ("odm_dem", "dsm.tif")),
        ], self.inspect_raster_asset)
        dtm = self.inspect_first_asset(task, "DTM", [
            ("odm_dem/dtm.tif", ("odm_dem", "dtm.tif")),
        ], self.inspect_raster_asset)

        assets = {
            "obj": obj,
            "glb": glb,
            "laz": laz,
            "ept": ept,
            "dsm": dsm,
            "dtm": dtm
        }

        blockers = []
        available = False
        mode = None
        if obj.get("exists") and obj.get("coordinate_status") == "crs_like":
            available = True
            mode = "direct_crs"
            reason = "OBJ можна перенести вслід за ортофото; X/Y схожі на CRS ортофото, Z буде залишено без змін."
        elif obj.get("exists"):
            coords_offset = self.read_odm_georeferencing_coords(task)
            alignment = self.load_alignment(task)
            bridge = self.find_orthophoto_local_bridge(task, obj.get("bounds"), ortho_meta)
            if self.is_authoritative_orthophoto_bridge(bridge):
                available = True
                mode = "local_orthophoto_bridge"
                reason = "OBJ локальний; SmartAlign бере yaw з ортофото: local X/Y -> pixel ортофото -> SmartAlign map. Z буде залишено без змін."
                obj["bridge"] = bridge
            elif coords_offset and self.coords_offset_matches_alignment(coords_offset, alignment):
                available = True
                mode = "coords_offset"
                reason = "OBJ локальний, але ODM має coords.txt: local X/Y + CRS offset -> SmartAlign map. Z буде залишено без змін."
                obj["coords_offset"] = coords_offset
            else:
                if bridge.get("available"):
                    available = True
                    mode = "local_orthophoto_bridge"
                    reason = "OBJ локальний, але його можна перенести через ортофото: local X/Y -> pixel ортофото -> SmartAlign map. Z буде залишено без змін."
                    obj["bridge"] = bridge
                else:
                    blockers.append(obj.get("diagnostic") or "OBJ знайдено, але координати не схожі на CRS ортофото.")
                    if coords_offset and not self.coords_offset_matches_alignment(coords_offset, alignment):
                        blockers.append("coords.txt CRS ({}) не збігається з CRS прив'язки ({}).".format(coords_offset.get("crs") or "unknown", (alignment or {}).get("crs") or "unknown"))
                    if bridge.get("reason"):
                        blockers.append(bridge.get("reason"))
                    reason = "Пряме перенесення 3D недоступне: потрібен local->map transform або rebuild/pseudo-GCP шлях."
        else:
            blockers.append("OBJ-модель ODM не знайдена.")
            reason = "3D OBJ недоступний для прямого перенесення."
        if ortho_error:
            blockers.append("Не вдалося прочитати bounds ортофото: {}".format(ortho_error))

        viewer = None
        if obj.get("exists") and obj.get("name"):
            mtllib = self.read_obj_mtllib(self.find_original_3d_obj_source(task))
            viewer = {
                "obj_url": self.api_url(task, "source-3d/{}".format(obj.get("name"))),
                "resource_url": self.api_url(task, "source-3d/"),
                "name": obj.get("name"),
                "mtl_path": mtllib,
                "mtl_url": self.api_url(task, "source-3d/{}".format(mtllib)) if mtllib else ""
            }

        return {
            "available": available,
            "mode": mode,
            "source": obj.get("name"),
            "reason": reason,
            "blockers": blockers,
            "viewer": viewer,
            "orthophoto": {
                "crs": ortho_meta.get("crs") if ortho_meta else "",
                "bounds": ortho_meta.get("bounds") if ortho_meta else None,
                "bounds_wgs84": ortho_meta.get("bounds_wgs84") if ortho_meta else None,
                "error": ortho_error
            },
            "assets": assets
        }

    def find_orthophoto_local_bridge(self, task, obj_bounds=None, ortho_meta=None):
        if not ortho_meta:
            return {
                "available": False,
                "reason": "Немає metadata ортофото для local->pixel bridge."
            }

        width = int(ortho_meta.get("width") or 0)
        height = int(ortho_meta.get("height") or 0)
        if width <= 0 or height <= 0:
            return {
                "available": False,
                "reason": "Неможливо визначити розмір ортофото для local->pixel bridge."
            }

        local_meta = self.read_orthophoto_local_metadata(task)
        if local_meta and local_meta.get("bounds"):
            local_bounds = local_meta.get("bounds")
            compatible = True
            if obj_bounds and len(obj_bounds) == 4:
                compatible = self.bounds_compatible(obj_bounds, local_bounds) is True
            if compatible:
                left, bottom, right, top = [float(value) for value in local_bounds]
                if abs(right - left) > 0 and abs(top - bottom) > 0:
                    return {
                        "available": True,
                        "source": "orthophoto_geotransform" if local_meta.get("local_to_pixel_transform") else "odm_orthophoto_corners.txt",
                        "bounds": [left, bottom, right, top],
                        "orthophoto_size": [width, height],
                        "local_to_pixel_transform": local_meta.get("local_to_pixel_transform"),
                        "local_to_pixel_mapping": None if local_meta.get("local_to_pixel_transform") else "odm_corners_flip_xy",
                        "z_policy": "preserved",
                        "method": "local_to_orthophoto_pixel_to_map"
                    }

        bounds = self.read_orthophoto_local_bounds(task)
        source = "odm_orthophoto_corners.txt"
        if not bounds:
            bounds = obj_bounds
            source = "obj_bounds_fallback"
        if not bounds or len(bounds) != 4:
            return {
                "available": False,
                "reason": "Немає local bounds ортофото/OBJ для побудови bridge."
            }

        left, bottom, right, top = [float(value) for value in bounds]
        if abs(right - left) <= 0 or abs(top - bottom) <= 0:
            return {
                "available": False,
                "reason": "Local bounds вироджені, bridge небезпечний."
            }

        return {
            "available": True,
            "source": source,
            "bounds": [left, bottom, right, top],
            "orthophoto_size": [width, height],
            "local_to_pixel_transform": None,
            "local_to_pixel_mapping": "odm_corners_flip_xy" if source == "odm_orthophoto_corners.txt" else "bounds_top_left",
            "z_policy": "preserved",
            "method": "local_to_orthophoto_pixel_to_map"
        }

    def is_authoritative_orthophoto_bridge(self, bridge):
        return bool(
            bridge and
            bridge.get("available") and
            bridge.get("source") != "obj_bounds_fallback"
        )

    def read_orthophoto_local_metadata(self, task):
        replacement = self.load_replacement(task) or {}
        backup_path = replacement.get("backup_path") if replacement.get("active") else ""
        candidates = []
        if backup_path:
            candidates.append(backup_path)
        candidates.append(task.get_asset_download_path("orthophoto.tif"))

        for path in candidates:
            try:
                if not path or not os.path.isfile(path):
                    continue
                with rasterio.open(path) as dataset:
                    transform = dataset.transform
                    if transform == Affine.identity():
                        continue
                    local_to_pixel = ~transform
                    bounds = dataset.bounds
                    return {
                        "bounds": [float(bounds.left), float(bounds.bottom), float(bounds.right), float(bounds.top)],
                        "local_to_pixel_transform": list(local_to_pixel)[:6],
                        "source_path": path
                    }
            except Exception:
                logger.warning("SmartAlign could not read original orthophoto transform from %s", path, exc_info=True)

        bounds = self.read_orthophoto_local_bounds(task)
        if bounds:
            return {
                "bounds": bounds,
                "local_to_pixel_transform": None,
                "source_path": ""
            }
        return None

    def read_orthophoto_local_bounds(self, task):
        candidates = [
            task.assets_path("odm_orthophoto", "odm_orthophoto_corners.txt"),
        ]

        log = self.load_task_log(task)
        project_path = None
        if isinstance(log, dict):
            options = log.get("options") or {}
            project_path = options.get("project_path")
        if project_path:
            candidates.append(os.path.join(project_path, "odm_orthophoto", "odm_orthophoto_corners.txt"))

        for path in candidates:
            try:
                if not path or not os.path.isfile(path):
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    values = [float(value) for value in f.read().strip().split()]
                if len(values) >= 4:
                    left, bottom, right, top = values[:4]
                    return [float(left), float(bottom), float(right), float(top)]
            except Exception:
                logger.warning("SmartAlign could not read orthophoto local bounds from %s", path)
        return None

    def load_task_log(self, task):
        path = task.assets_path("log.json")
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            logger.warning("SmartAlign could not read task log %s", path)
            return None

    def inspect_first_asset(self, task, label, candidates, inspector=None):
        missing = []
        for relative_path, parts in candidates:
            path = task.assets_path(*parts)
            if not os.path.isfile(path):
                missing.append(relative_path)
                continue
            result = {
                "label": label,
                "exists": True,
                "name": os.path.basename(path),
                "path": relative_path,
                "size": os.path.getsize(path)
            }
            if inspector:
                try:
                    result.update(inspector(path) or {})
                except Exception as e:
                    result["error"] = str(e)
            return result
        return {
            "label": label,
            "exists": False,
            "missing": missing
        }

    def read_obj_mtllib(self, path):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    stripped = line.strip()
                    if stripped.lower().startswith("mtllib "):
                        return stripped[7:].strip()
        except Exception:
            return ""
        return ""

    def inspect_raster_asset(self, path):
        with rasterio.open(path) as dataset:
            meta = raster_metadata_from_transform(dataset.width, dataset.height, dataset.crs.to_string() if dataset.crs else "", dataset.transform)
            return {
                "width": meta.get("width"),
                "height": meta.get("height"),
                "crs": meta.get("crs"),
                "bounds": meta.get("bounds"),
                "bounds_wgs84": meta.get("bounds_wgs84"),
                "georeferenced": meta.get("georeferenced")
            }

    def inspect_ept_asset(self, path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        bounds = data.get("boundsConforming") or data.get("bounds")
        if isinstance(bounds, list) and len(bounds) >= 6:
            bounds_xy = [float(bounds[0]), float(bounds[1]), float(bounds[3]), float(bounds[4])]
        elif isinstance(bounds, list) and len(bounds) >= 4:
            bounds_xy = [float(value) for value in bounds[:4]]
        else:
            bounds_xy = None
        return {
            "bounds": bounds_xy,
            "points": data.get("points"),
            "schema": data.get("schema")
        }

    def inspect_obj_asset(self, path, ortho_meta):
        xs = []
        ys = []
        zs = []
        vertex_count = 0
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.startswith("v "):
                    continue
                vertex = parse_obj_vertex(line)
                if not vertex:
                    continue
                x, y, z, _rest = vertex
                vertex_count += 1
                xs.append(x)
                ys.append(y)
                zs.append(z)
                if len(xs) >= 5000:
                    break

        if len(xs) < 3:
            return {
                "vertex_sample_count": len(xs),
                "coordinate_status": "unknown",
                "diagnostic": "OBJ містить замало vertex-рядків для оцінки bounds."
            }

        bounds = [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]
        z_range = [float(min(zs)), float(max(zs))] if zs else None
        ortho_bounds = ortho_meta.get("bounds") if ortho_meta else None
        overlaps = self.bounds_overlap(bounds, ortho_bounds) if ortho_bounds else None
        compatible = self.bounds_compatible(bounds, ortho_bounds) if ortho_bounds else None
        max_abs_xy = max(abs(bounds[0]), abs(bounds[1]), abs(bounds[2]), abs(bounds[3]))
        span_x = abs(bounds[2] - bounds[0])
        span_y = abs(bounds[3] - bounds[1])

        if compatible is True:
            status = "crs_like"
            diagnostic = "OBJ X/Y перетинаються з bounds ортофото; пряме перенесення можна пробувати."
        elif max_abs_xy < 100000:
            status = "local"
            diagnostic = "OBJ X/Y виглядають локальними або неспівмірними з bounds ортофото."
        elif compatible is False:
            status = "different_crs_or_local"
            diagnostic = "OBJ X/Y не сумісні з bounds ортофото; без local->map bridge пряме перенесення небезпечне."
        else:
            status = "unknown"
            diagnostic = "Немає bounds ортофото для порівняння OBJ."

        return {
            "vertex_sample_count": len(xs),
            "bounds": bounds,
            "z_range": z_range,
            "span": [float(span_x), float(span_y)],
            "overlaps_orthophoto": overlaps,
            "compatible_with_orthophoto": compatible,
            "coordinate_status": status,
            "diagnostic": diagnostic
        }

    def bounds_overlap(self, bounds, reference_bounds):
        if not bounds or not reference_bounds or len(bounds) != 4 or len(reference_bounds) != 4:
            return None
        left, bottom, right, top = [float(value) for value in reference_bounds]
        width = abs(right - left)
        height = abs(top - bottom)
        padding_x = max(width * 0.50, 50.0)
        padding_y = max(height * 0.50, 50.0)
        obj_left, obj_bottom, obj_right, obj_top = [float(value) for value in bounds]
        return not (
            obj_right < left - padding_x or
            obj_left > right + padding_x or
            obj_top < bottom - padding_y or
            obj_bottom > top + padding_y
        )

    def bounds_compatible(self, bounds, reference_bounds):
        overlaps = self.bounds_overlap(bounds, reference_bounds)
        if overlaps is not True:
            return overlaps
        obj_left, obj_bottom, obj_right, obj_top = [float(value) for value in bounds]
        left, bottom, right, top = [float(value) for value in reference_bounds]
        obj_span_x = abs(obj_right - obj_left)
        obj_span_y = abs(obj_top - obj_bottom)
        ref_span_x = abs(right - left)
        ref_span_y = abs(top - bottom)
        if obj_span_x <= 0 or obj_span_y <= 0 or ref_span_x <= 0 or ref_span_y <= 0:
            return False
        ratio_x = obj_span_x / ref_span_x
        ratio_y = obj_span_y / ref_span_y
        return 0.10 <= ratio_x <= 10.0 and 0.10 <= ratio_y <= 10.0

    def public_3d_status(self, task):
        try:
            return self.get_3d_status(task)
        except Exception as e:
            return {
                "available": False,
                "reason": "Не вдалося виконати 3D diagnostics: {}".format(e),
                "assets": {}
            }

    def ensure_orthophoto_preview(self, task):
        source_path = task.get_asset_download_path("orthophoto.tif")
        if not os.path.isfile(source_path):
            raise ValueError("orthophoto.tif не знайдено")

        output_dir = self.smartalign_dir(task)
        preview_path = safe_child(output_dir, "orthophoto_preview.png")
        metadata_path = safe_child(output_dir, "orthophoto.json")

        if os.path.isfile(preview_path) and os.path.isfile(metadata_path):
            try:
                with open(metadata_path, "r", encoding="utf-8") as f:
                    metadata = json.load(f)
                if metadata.get("source_mtime") == os.path.getmtime(source_path):
                    metadata.pop("source", None)
                    return metadata
            except Exception:
                pass

        metadata = create_preview(source_path, preview_path)
        metadata.update({
            "source": source_path,
            "source_mtime": os.path.getmtime(source_path),
            "preview_url": self.api_url(task, "file/orthophoto_preview.png")
        })
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
        metadata.pop("source", None)
        return metadata

    def apply_alignment(self, task, points):
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError("Додайте щонайменше 2 пари точок")

        reference_meta = self.load_json(task, "reference.json")
        pairs = [parse_point_pair(point) for point in points]
        source = np.array([[x, y] for x, y in pairs], dtype=np.float64)
        ortho_meta = self.ensure_orthophoto_preview(task)
        target_crs = ortho_meta.get("crs") or "EPSG:4326"
        target = np.array([
            self.reference_point_to_world(point, reference_meta, target_crs)
            for point in points
        ], dtype=np.float64)

        if len(points) == 2:
            transform_type = "similarity"
            matrix = solve_similarity(source, target)
        else:
            transform_type = "affine"
            matrix = solve_affine(source, target)

        predicted = transform_points(matrix, source)
        errors = np.linalg.norm(predicted - target, axis=1)
        rmse = float(np.sqrt(np.mean(errors ** 2)))

        ortho_path = task.get_asset_download_path("orthophoto.tif")
        output_path = safe_child(self.smartalign_dir(task), "orthophoto_aligned.tif")
        report_path = safe_child(self.smartalign_dir(task), "report.json")
        report_html_path = safe_child(self.smartalign_dir(task), "report.html")

        raster_transform = Affine(matrix[0, 0], matrix[0, 1], matrix[0, 2], matrix[1, 0], matrix[1, 1], matrix[1, 2])
        self.write_aligned_orthophoto(ortho_path, output_path, target_crs, raster_transform)
        aligned_preview_path = safe_child(self.smartalign_dir(task), "aligned_preview.png")
        try:
            aligned_meta = warped_raster_preview(output_path, aligned_preview_path)
        except Exception:
            logger.warning("SmartAlign could not create warped aligned preview, falling back to plain preview", exc_info=True)
            aligned_meta = create_preview(output_path, aligned_preview_path)

        now = datetime.utcnow().isoformat() + "Z"
        alignment = {
            "created_at": now,
            "transform_type": transform_type,
            "matrix": matrix.tolist(),
            "raster_transform": list(raster_transform)[:6],
            "crs": target_crs,
            "reference_mode": self.reference_mode(points, reference_meta),
            "points": points,
            "point_count": len(points),
            "rmse": rmse,
            "residuals": [float(value) for value in errors],
            "quality": quality_status(rmse),
            "outputs": {
                "orthophoto_aligned": self.api_url(task, "file/orthophoto_aligned.tif?download=1"),
                "aligned_preview": self.api_url(task, "file/aligned_preview.png"),
                "report": self.api_url(task, "file/report.json?download=1"),
                "report_html": self.api_url(task, "file/report.html")
            },
            "aligned_preview": {
                "url": self.api_url(task, "file/aligned_preview.png"),
                "bounds_wgs84": aligned_meta.get("bounds_wgs84"),
                "width": aligned_meta.get("width"),
                "height": aligned_meta.get("height"),
                "kind": aligned_meta.get("kind"),
                "created_at": now
            }
        }

        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(alignment, f, ensure_ascii=False, indent=2)
        with open(report_html_path, "w", encoding="utf-8") as f:
            f.write(self.render_report_html(task, alignment))
        self.save_json(task, "alignment.json", alignment)
        old_3d_report = safe_child(self.smartalign_dir(task), "alignment_3d.json")
        if os.path.isfile(old_3d_report):
            os.remove(old_3d_report)
        return alignment

    def ensure_aligned_preview(self, task, alignment):
        aligned_path = safe_child(self.smartalign_dir(task), "orthophoto_aligned.tif")
        preview_path = safe_child(self.smartalign_dir(task), "aligned_preview.png")
        if not os.path.isfile(aligned_path):
            return alignment

        preview = alignment.get("aligned_preview") or {}
        if not os.path.isfile(preview_path) or not preview.get("bounds_wgs84") or preview.get("kind") != "warped_raster":
            try:
                aligned_meta = warped_raster_preview(aligned_path, preview_path)
                preview = {
                    "url": self.api_url(task, "file/aligned_preview.png"),
                    "bounds_wgs84": aligned_meta.get("bounds_wgs84"),
                    "width": aligned_meta.get("width"),
                    "height": aligned_meta.get("height"),
                    "kind": aligned_meta.get("kind"),
                    "created_at": datetime.utcnow().isoformat() + "Z"
                }
                alignment["aligned_preview"] = preview
                alignment.setdefault("outputs", {})["aligned_preview"] = preview["url"]
                self.save_json(task, "alignment.json", alignment)
            except Exception:
                logger.warning("SmartAlign could not create aligned preview")
        return alignment

    def reference_mode(self, points, reference_meta):
        for point in points:
            reference = point.get("reference") if isinstance(point, dict) else None
            if isinstance(reference, dict) and "lat" in reference and "lng" in reference:
                return "map"
        if reference_meta:
            return "uploaded_geotiff"
        return "unknown"

    def reference_point_to_world(self, point, reference_meta, target_crs):
        reference = point.get("reference") if isinstance(point, dict) else None
        if not isinstance(reference, dict):
            raise ValueError("Некоректна точка референсу")

        if "lat" in reference and "lng" in reference:
            return lonlat_to_world(reference.get("lng"), reference.get("lat"), target_crs)

        if not reference_meta:
            raise ValueError("Спочатку завантажте референсний GeoTIFF або використайте карту")
        if not reference_meta.get("georeferenced"):
            raise ValueError("Референс не має CRS/GeoTransform. Для створення aligned GeoTIFF потрібен геоприв’язаний GeoTIFF або карта.")
        world_x, world_y = reference_pixel_to_world(reference_meta, reference.get("x"), reference.get("y"))
        if reference_meta.get("crs") and reference_meta.get("crs") != target_crs:
            xs, ys = rio_transform(reference_meta.get("crs"), target_crs, [world_x], [world_y])
            return float(xs[0]), float(ys[0])
        return world_x, world_y

    def render_report_html(self, task, alignment):
        residual_rows = "\n".join(
            "<tr><td>{}</td><td>{:.4f}</td></tr>".format(index + 1, float(value))
            for index, value in enumerate(alignment.get("residuals") or [])
        )
        return """<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <title>Звіт SmartAlign</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }}
    table {{ border-collapse: collapse; margin-top: 12px; min-width: 360px; }}
    th, td {{ border: 1px solid #d0d5dd; padding: 6px 8px; text-align: left; }}
    th {{ background: #f2f4f7; }}
    code {{ background: #f2f4f7; padding: 2px 4px; }}
  </style>
</head>
<body>
  <h1>Звіт SmartAlign</h1>
  <p><strong>Задача:</strong> {task_name}</p>
  <p><strong>Створено:</strong> {created_at}</p>
  <p><strong>Якість:</strong> {quality}</p>
  <p><strong>Трансформація:</strong> {transform_type}</p>
  <p><strong>CRS:</strong> <code>{crs}</code></p>
  <p><strong>Пар точок:</strong> {point_count}</p>
  <p><strong>RMSE:</strong> {rmse:.4f}</p>
  <h2>Залишкові похибки</h2>
  <table>
    <thead><tr><th>Точка</th><th>Похибка</th></tr></thead>
    <tbody>{residual_rows}</tbody>
  </table>
</body>
</html>
""".format(
            task_name=html.escape(task.name or str(task.id)),
            created_at=html.escape(alignment.get("created_at") or ""),
            quality=html.escape(localize_quality(alignment.get("quality"))),
            transform_type=html.escape(localize_transform_type(alignment.get("transform_type"))),
            crs=html.escape(alignment.get("crs") or ""),
            point_count=int(alignment.get("point_count") or 0),
            rmse=float(alignment.get("rmse") or 0),
            residual_rows=residual_rows or "<tr><td colspan=\"2\">Немає даних</td></tr>"
        )

    def write_aligned_orthophoto(self, source_path, output_path, crs, transform):
        if not crs:
            raise ValueError("У референсі відсутній CRS")

        try:
            shutil.copy2(source_path, output_path)
            with rasterio.open(output_path, "r+") as dst:
                dst.crs = crs
                dst.transform = transform
                dst.update_tags(SMARTALIGN="true")
            return
        except Exception:
            logger.warning("SmartAlign could not update GeoTIFF metadata in-place, falling back to full rewrite", exc_info=True)
            if os.path.isfile(output_path):
                try:
                    os.remove(output_path)
                except OSError:
                    pass

        with rasterio.open(source_path) as src:
            profile = src.profile.copy()
            profile.update({
                "driver": "GTiff",
                "crs": crs,
                "transform": transform,
                "compress": "deflate"
            })
            with rasterio.open(output_path, "w", **profile) as dst:
                for index in range(1, src.count + 1):
                    for _block_index, window in src.block_windows(index):
                        dst.write(src.read(index, window=window), index, window=window)
                dst.update_tags(SMARTALIGN="true")

    def old_world_to_aligned_world_transform(self, task, alignment):
        old_values = None
        replacement = self.load_replacement(task) or {}
        backup_path = replacement.get("backup_path") if replacement.get("active") else ""
        if backup_path and os.path.isfile(backup_path):
            try:
                with rasterio.open(backup_path) as dataset:
                    old_values = list(dataset.transform)[:6]
            except Exception:
                logger.warning("SmartAlign could not read original orthophoto transform from backup %s", backup_path, exc_info=True)
        if not old_values:
            ortho_meta = self.ensure_orthophoto_preview(task)
            old_values = ortho_meta.get("transform")
        new_values = alignment.get("raster_transform")
        if not old_values:
            raise ValueError("Оригінальне ортофото не має GeoTransform. 3D-модель не можна надійно перенести вслід за ортофото.")
        if not new_values:
            raise ValueError("Спочатку створіть aligned GeoTIFF")
        old_transform = Affine(*old_values)
        new_transform = Affine(*new_values)
        if old_transform == Affine.identity():
            raise ValueError("Оригінальне ортофото має identity GeoTransform. 3D-модель не можна надійно перенести вслід за ортофото.")
        return new_transform * ~old_transform

    def read_odm_georeferencing_coords(self, task):
        path = task.assets_path("odm_georeferencing", "coords.txt")
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                lines = [line.strip() for line in f if line.strip()]
            if len(lines) < 2:
                return None
            offsets = [float(value) for value in lines[1].split()[:2]]
            if len(offsets) < 2:
                return None
            crs = self.crs_from_odm_coords_header(lines[0])
            return {
                "available": True,
                "source": "odm_georeferencing/coords.txt",
                "path": path,
                "header": lines[0],
                "offset": {"x": offsets[0], "y": offsets[1]},
                "crs": crs
            }
        except Exception:
            logger.warning("SmartAlign could not read ODM georeferencing coords from %s", path, exc_info=True)
            return None

    def crs_from_odm_coords_header(self, header):
        text = str(header or "").upper()
        match = re.search(r"UTM\s+(\d{1,2})([NS])?", text)
        if not match:
            return ""
        zone = int(match.group(1))
        if zone < 1 or zone > 60:
            return ""
        hemisphere = match.group(2) or "N"
        epsg = 32600 + zone if hemisphere == "N" else 32700 + zone
        return "EPSG:{}".format(epsg)

    def coords_offset_matches_alignment(self, coords_offset, alignment):
        coords_crs = str((coords_offset or {}).get("crs") or "").strip().upper()
        alignment_crs = str((alignment or {}).get("crs") or "").strip().upper()
        return not coords_crs or not alignment_crs or coords_crs == alignment_crs

    def find_3d_obj_source(self, task):
        candidates = [
            task.assets_path("odm_texturing", "odm_textured_model_geo.obj"),
            task.assets_path("odm_texturing_25d", "odm_textured_model_geo.obj"),
            task.assets_path("odm_texturing", "odm_textured_model.obj"),
            task.assets_path("odm_texturing_25d", "odm_textured_model.obj")
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        raise ValueError("OBJ-модель ODM не знайдена. Очікував odm_texturing/odm_textured_model_geo.obj або odm_textured_model.obj")

    def find_original_3d_obj_source(self, task, preferred=None):
        replacement = self.load_replacement_3d(task)
        backup_dir = replacement.get("backup_dir") if replacement and replacement.get("active") else ""
        if backup_dir:
            smartalign_root = Path(self.smartalign_dir(task)).resolve()
            backup_root = Path(backup_dir).resolve()
            if backup_root == smartalign_root or smartalign_root in backup_root.parents:
                candidates = [
                    backup_root / "odm_texturing" / "odm_textured_model_geo.obj",
                    backup_root / "odm_texturing_25d" / "odm_textured_model_geo.obj",
                    backup_root / "odm_texturing" / "odm_textured_model.obj",
                    backup_root / "odm_texturing_25d" / "odm_textured_model.obj"
                ]
                for candidate in candidates:
                    if candidate.is_file():
                        return str(candidate)

        if preferred and os.path.isfile(preferred):
            return preferred

        return self.find_3d_obj_source(task)

    def obj_vertices_match_orthophoto_bounds(self, obj_path, ortho_meta):
        bounds = ortho_meta.get("bounds")
        if not bounds or len(bounds) != 4:
            return True

        xs = []
        ys = []
        with open(obj_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.startswith("v "):
                    continue
                vertex = parse_obj_vertex(line)
                if not vertex:
                    continue
                xs.append(vertex[0])
                ys.append(vertex[1])
                if len(xs) >= 5000:
                    break
        if len(xs) < 3:
            return True

        obj_bounds = [min(xs), min(ys), max(xs), max(ys)]
        return self.bounds_compatible(obj_bounds, bounds) is True

    def copy_obj_sidecars(self, source_obj, output_dir):
        copied = []
        source_dir = os.path.dirname(source_obj)
        mtllibs = []
        with open(source_obj, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                stripped = line.strip()
                if stripped.lower().startswith("mtllib "):
                    mtllibs.extend(stripped.split()[1:])

        for mtllib in mtllibs:
            source_mtl = os.path.normpath(os.path.join(source_dir, mtllib))
            if not os.path.isfile(source_mtl):
                continue
            target_mtl = safe_child(output_dir, mtllib)
            os.makedirs(os.path.dirname(target_mtl), exist_ok=True)
            shutil.copy2(source_mtl, target_mtl)
            copied.append(target_mtl)

            with open(source_mtl, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) < 2:
                        continue
                    key = parts[0].lower()
                    if not (key.startswith("map_") or key in ("bump", "disp", "decal", "norm")):
                        continue
                    texture_name = parts[-1]
                    source_texture = os.path.normpath(os.path.join(os.path.dirname(source_mtl), texture_name))
                    if not os.path.isfile(source_texture):
                        source_texture = os.path.normpath(os.path.join(source_dir, texture_name))
                    if not os.path.isfile(source_texture):
                        continue
                    relative_texture = os.path.relpath(source_texture, source_dir)
                    target_texture = safe_child(output_dir, relative_texture)
                    os.makedirs(os.path.dirname(target_texture), exist_ok=True)
                    if not os.path.isfile(target_texture):
                        shutil.copy2(source_texture, target_texture)
                        copied.append(target_texture)
        return copied

    def write_aligned_obj(self, source_obj, output_obj, xy_transform):
        return self.write_aligned_obj_with_mapper(
            source_obj,
            output_obj,
            lambda x, y, z: transform_xy(xy_transform, x, y)
        )

    def write_aligned_obj_with_mapper(self, source_obj, output_obj, xy_mapper):
        vertex_count = 0
        with open(source_obj, "r", encoding="utf-8", errors="ignore") as src, open(output_obj, "w", encoding="utf-8", newline="") as dst:
            for line in src:
                if not line.startswith("v "):
                    dst.write(line)
                    continue
                vertex = parse_obj_vertex(line)
                if not vertex:
                    dst.write(line)
                    continue
                x, y, z, rest = vertex
                mapped = xy_mapper(x, y, z)
                if len(mapped) >= 3:
                    new_x, new_y, new_z = mapped[:3]
                else:
                    new_x, new_y = mapped[:2]
                    new_z = z
                values = ["v", format_coord(new_x), format_coord(new_y), format_coord(new_z)]
                values.extend(rest)
                dst.write(" ".join(values) + "\n")
                vertex_count += 1
        if vertex_count < 1:
            raise ValueError("OBJ не містить vertex-рядків")
        return vertex_count

    def local_orthophoto_to_map_mapper(self, bridge, alignment):
        bounds = bridge.get("bounds")
        size = bridge.get("orthophoto_size")
        if not bounds or len(bounds) != 4 or not size or len(size) != 2:
            raise ValueError("Немає параметрів local->orthophoto bridge")
        raster_values = alignment.get("raster_transform")
        if not raster_values:
            raise ValueError("Спочатку створіть aligned GeoTIFF")

        left, bottom, right, top = [float(value) for value in bounds]
        width, height = [float(value) for value in size]
        span_x = right - left
        span_y = top - bottom
        if span_x == 0 or span_y == 0 or width <= 0 or height <= 0:
            raise ValueError("Local bounds або розмір ортофото вироджені")
        pixel_to_map = Affine(*raster_values)
        local_to_pixel_values = bridge.get("local_to_pixel_transform")
        if local_to_pixel_values:
            local_to_pixel = Affine(*local_to_pixel_values)
            def mapper(x, y):
                pixel_x, pixel_y = transform_xy(local_to_pixel, float(x), float(y))
                return transform_xy(pixel_to_map, pixel_x, pixel_y)
            return mapper

        local_to_pixel_mapping = bridge.get("local_to_pixel_mapping")
        def mapper(x, y):
            if local_to_pixel_mapping == "odm_corners_flip_xy":
                pixel_x = (right - float(x)) / span_x * width
                pixel_y = (float(y) - bottom) / span_y * height
            else:
                pixel_x = (float(x) - left) / span_x * width
                pixel_y = (top - float(y)) / span_y * height
            return transform_xy(pixel_to_map, pixel_x, pixel_y)

        return mapper

    def local_orthophoto_to_map_scale(self, bridge, alignment):
        bounds = bridge.get("bounds")
        size = bridge.get("orthophoto_size")
        raster_values = alignment.get("raster_transform")
        if not bounds or len(bounds) != 4 or not size or len(size) != 2 or not raster_values:
            return 1.0
        local_to_pixel_values = bridge.get("local_to_pixel_transform")
        if local_to_pixel_values:
            combined = Affine(*raster_values) * Affine(*local_to_pixel_values)
            z_scale = float(abs(combined.a * combined.e - combined.b * combined.d) ** 0.5)
            if np.isfinite(z_scale) and z_scale > 0:
                return z_scale
            return 1.0

        left, bottom, right, top = [float(value) for value in bounds]
        width, height = [float(value) for value in size]
        span_x = right - left
        span_y = top - bottom
        if span_x == 0 or span_y == 0 or width <= 0 or height <= 0:
            return 1.0

        pixel_to_map = Affine(*raster_values)
        x_scale = float(np.hypot(pixel_to_map.a * width / span_x, pixel_to_map.d * width / span_x))
        y_scale = float(np.hypot(pixel_to_map.b * height / span_y, pixel_to_map.e * height / span_y))
        scales = [value for value in (x_scale, y_scale) if np.isfinite(value) and value > 0]
        if not scales:
            return 1.0
        return sum(scales) / float(len(scales))

    def softtools_3d_mapper_and_scale(self, task, source_obj, alignment_3d):
        alignment = self.load_alignment(task)
        if not alignment:
            raise ValueError("Спочатку створіть aligned GeoTIFF")

        if alignment_3d.get("method") == "direct_crs":
            values = alignment_3d.get("xy_transform")
            if values:
                xy_transform = Affine(*values)
            else:
                xy_transform = self.old_world_to_aligned_world_transform(task, alignment)
            z_scale = float(abs(xy_transform.a * xy_transform.e - xy_transform.b * xy_transform.d) ** 0.5)
            if not np.isfinite(z_scale) or z_scale <= 0:
                z_scale = 1.0
            return lambda x, y: transform_xy(xy_transform, x, y), z_scale

        if alignment_3d.get("method") == "coords_offset":
            coords_offset = alignment_3d.get("coords_offset") or self.read_odm_georeferencing_coords(task)
            if not coords_offset:
                raise ValueError("SmartAlign не знайшов odm_georeferencing/coords.txt для 3D")
            if not self.coords_offset_matches_alignment(coords_offset, alignment):
                raise ValueError("coords.txt CRS не збігається з CRS прив'язки")
            values = alignment_3d.get("xy_transform")
            if values:
                xy_transform = Affine(*values)
            else:
                xy_transform = self.old_world_to_aligned_world_transform(task, alignment)
            offset = coords_offset.get("offset") or {}
            offset_x = float(offset.get("x") or 0.0)
            offset_y = float(offset.get("y") or 0.0)
            z_scale = float(abs(xy_transform.a * xy_transform.e - xy_transform.b * xy_transform.d) ** 0.5)
            if not np.isfinite(z_scale) or z_scale <= 0:
                z_scale = 1.0
            return lambda x, y: transform_xy(xy_transform, float(x) + offset_x, float(y) + offset_y), z_scale

        bridge = alignment_3d.get("orthophoto_bridge")
        needs_fresh_bridge = (
            not bridge or
            not bridge.get("available") or
            bridge.get("method") == "local_affine_to_orthophoto_pixel_to_map" or
            (
                bridge.get("method") == "local_to_orthophoto_pixel_to_map" and
                not bridge.get("local_to_pixel_transform")
            )
        )
        if needs_fresh_bridge:
            ortho_meta = self.ensure_orthophoto_preview(task)
            obj_inspection = self.inspect_obj_asset(source_obj, ortho_meta)
            bridge = self.find_orthophoto_local_bridge(task, obj_inspection.get("bounds"), ortho_meta)
        if not bridge or not bridge.get("available"):
            raise ValueError("SmartAlign не має local->orthophoto bridge для 3D")
        return self.local_orthophoto_to_map_mapper(bridge, alignment), self.local_orthophoto_to_map_scale(bridge, alignment)

    def zip_directory(self, source_dir, output_zip):
        with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as archive:
            for root_dir, _dirs, files in os.walk(source_dir):
                for filename in files:
                    path = os.path.join(root_dir, filename)
                    if os.path.abspath(path) == os.path.abspath(output_zip):
                        continue
                    archive.write(path, os.path.relpath(path, source_dir))

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
        raise ValueError("tile-converter was not found inside Smartpoint/bin")

    def delta_3d_environment(self):
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

        temp_fd, temp_path = tempfile.mkstemp(prefix="smartalign-slpk-", suffix=".slpk", dir=os.path.dirname(slpk_path))
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

    def parse_delta_3d_obj_vertex(self, line):
        if not line.startswith("v "):
            return None
        parts = line.strip().split()
        if len(parts) < 4:
            return None
        try:
            return float(parts[1]), float(parts[2]), float(parts[3]), parts[4:]
        except ValueError:
            return None

    def format_delta_3d_obj_coord(self, value):
        formatted = "{:.9f}".format(float(value)).rstrip("0").rstrip(".")
        if formatted in ("", "-0"):
            return "0"
        return formatted

    def request_delta_3d_terrain_elevation(self, latitude, longitude):
        query = urlencode({
            "locations": "{:.7f},{:.7f}".format(float(latitude), float(longitude))
        })
        url = "{}?{}".format(ELEVATION_API_URL, query)
        with urlopen(url, timeout=ELEVATION_TIMEOUT_SECONDS) as response:
            payload = response.read().decode("utf-8")
        data = json.loads(payload)
        results = data.get("results") or []
        if not results:
            raise ValueError("terrain elevation response is empty")
        elevation = results[0].get("elevation")
        if elevation is None:
            raise ValueError("terrain elevation is missing")
        return float(elevation)

    def get_delta_3d_terrain_reference(self, latitude, longitude):
        try:
            elevation = self.request_delta_3d_terrain_elevation(latitude, longitude)
            return {
                "available": True,
                "provider": ELEVATION_PROVIDER,
                "elevation": elevation,
                "error": ""
            }
        except Exception as e:
            logger.warning("SmartAlign SRTM elevation lookup failed: %s", e)
            return {
                "available": False,
                "provider": ELEVATION_PROVIDER,
                "elevation": 0.0,
                "error": str(e)
            }

    def find_odm_dem_asset(self, task):
        candidates = [
            ("dtm", task.assets_path("odm_dem", "dtm.tif")),
            ("dsm", task.assets_path("odm_dem", "dsm.tif")),
        ]
        for kind, path in candidates:
            if os.path.isfile(path):
                return kind, path
        return None, None

    def get_odm_dem_elevation(self, task, map_x, map_y, crs_text):
        dem_kind, dem_path = self.find_odm_dem_asset(task)
        if not dem_path:
            return None
        with rasterio.open(dem_path) as dataset:
            sample_x = float(map_x)
            sample_y = float(map_y)
            if dataset.crs and crs_text and dataset.crs.to_string() != crs_text:
                xs, ys = rio_transform(CRS.from_string(crs_text), dataset.crs, [sample_x], [sample_y])
                sample_x = float(xs[0])
                sample_y = float(ys[0])
            row, col = dataset.index(sample_x, sample_y)
            if row < 0 or col < 0 or row >= dataset.height or col >= dataset.width:
                return None
            value = next(dataset.sample([(sample_x, sample_y)], masked=True))[0]
            if np.ma.is_masked(value):
                return None
            elevation = float(value)
            if not np.isfinite(elevation):
                return None
            nodata = dataset.nodata
            if nodata is not None and abs(elevation - float(nodata)) < 0.000001:
                return None
            return {
                "available": True,
                "provider": "ODM {}".format(dem_kind.upper()),
                "elevation": elevation,
                "path": dem_path,
                "crs": dataset.crs.to_string() if dataset.crs else "",
                "sample": {"x": sample_x, "y": sample_y}
            }

    def get_3d_origin_terrain_reference(self, task, map_x, map_y, crs_text, latitude, longitude):
        try:
            dem = self.get_odm_dem_elevation(task, map_x, map_y, crs_text)
            if dem:
                dem["fallback"] = ""
                return dem
        except Exception as e:
            logger.warning("SmartAlign could not sample ODM DEM for 3D origin: %s", e)
        return self.get_delta_3d_terrain_reference(latitude, longitude)

    def percentile_value(self, values, percent):
        if not values:
            return 0.0
        ordered = sorted(float(value) for value in values)
        index = int(round((len(ordered) - 1) * max(0.0, min(100.0, float(percent))) / 100.0))
        return ordered[index]

    def prepare_delta_3d_source(self, task, alignment_3d, delta_dir):
        source_obj = alignment_3d.get("output_path") or safe_child(
            self.smartalign_dir(task),
            "model_aligned",
            "odm_textured_model_smartalign.obj"
        )
        smartalign_root = Path(self.smartalign_dir(task)).resolve()
        source_path = Path(source_obj).resolve()
        if not source_path.is_file() or smartalign_root not in source_path.parents:
            raise ValueError("SmartAlign aligned OBJ is not available")

        crs_text = str(alignment_3d.get("crs") or "").strip()
        if not crs_text:
            raise ValueError("SmartAlign 3D alignment has no CRS")

        min_x = min_y = min_z = None
        max_x = max_y = max_z = None
        vertex_count = 0
        z_values = []
        with open(str(source_path), "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                vertex = self.parse_delta_3d_obj_vertex(line)
                if not vertex:
                    continue
                x, y, z, _extra = vertex
                min_x = x if min_x is None else min(min_x, x)
                max_x = x if max_x is None else max(max_x, x)
                min_y = y if min_y is None else min(min_y, y)
                max_y = y if max_y is None else max(max_y, y)
                min_z = z if min_z is None else min(min_z, z)
                max_z = z if max_z is None else max(max_z, z)
                z_values.append(z)
                vertex_count += 1
        if not vertex_count:
            raise ValueError("SmartAlign aligned OBJ has no vertices")

        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
        center_z = (min_z + max_z) / 2.0
        ground_z = self.percentile_value(z_values, 2.0)
        try:
            lon_values, lat_values = rio_transform(CRS.from_string(crs_text), CRS.from_epsg(4326), [center_x], [center_y])
            longitude = float(lon_values[0])
            latitude = float(lat_values[0])
        except Exception as e:
            raise ValueError("Could not convert SmartAlign 3D center to WGS84: {}".format(e))
        terrain = self.get_3d_origin_terrain_reference(task, center_x, center_y, crs_text, latitude, longitude)

        source_dir = os.path.dirname(str(source_path))
        prepared_dir = safe_child(delta_dir, "source")
        os.makedirs(prepared_dir, exist_ok=True)
        for name in os.listdir(source_dir):
            sidecar_path = os.path.join(source_dir, name)
            if os.path.isfile(sidecar_path):
                shutil.copy2(sidecar_path, safe_child(prepared_dir, name))

        prepared_obj = safe_child(prepared_dir, os.path.basename(str(source_path)))
        with open(str(source_path), "r", encoding="utf-8", errors="replace") as src, open(
            prepared_obj,
            "w",
            encoding="utf-8",
            newline=""
        ) as dst:
            for line in src:
                vertex = self.parse_delta_3d_obj_vertex(line)
                if not vertex:
                    dst.write(line)
                    continue
                x, y, z, extra = vertex
                coords = [
                    self.format_delta_3d_obj_coord(x - center_x),
                    self.format_delta_3d_obj_coord(z - ground_z),
                    self.format_delta_3d_obj_coord(y - center_y)
                ]
                dst.write("v {}\n".format(" ".join(coords + extra)))

        reference = {
            "latitude": latitude,
            "longitude": longitude,
            "altitude": terrain["elevation"],
            "terrain": terrain,
            "origin": {"x": center_x, "y": center_y, "z": ground_z, "crs": crs_text},
            "center": {"x": center_x, "y": center_y, "z": center_z, "crs": crs_text},
            "bounds": [min_x, min_y, min_z, max_x, max_y, max_z],
            "vertex_count": vertex_count,
            "z_policy": "ground_rebased_global_offset",
            "height_axis": "obj_y_from_aligned_z",
            "axis_mapping": {
                "obj_x": "aligned_map_x_minus_origin_x",
                "obj_y": "aligned_z_minus_ground_z",
                "obj_z": "aligned_map_y_minus_origin_y"
            },
            "ground_z_percentile": 2.0
        }
        with open(safe_child(prepared_dir, "reference_lla.json"), "w", encoding="utf-8") as f:
            json.dump({
                "latitude": latitude,
                "longitude": longitude,
                "altitude": terrain["elevation"]
            }, f, ensure_ascii=False, indent=2)
        return prepared_obj, reference

    def create_delta_3d_export(self, task):
        alignment_3d = self.load_json(task, "alignment_3d.json")
        if not alignment_3d:
            self.align_3d_model(task)
            alignment_3d = self.load_json(task, "alignment_3d.json")
        if not alignment_3d:
            raise ValueError("SmartAlign aligned 3D model is not available")

        delta_dir = safe_child(self.smartalign_dir(task), "delta_3d")
        if os.path.isdir(delta_dir):
            shutil.rmtree(delta_dir)
        os.makedirs(delta_dir, exist_ok=True)

        artifacts = self.prepare_smartalign_softtools_3d_artifacts(task, alignment_3d)
        source_obj = artifacts["delta_source"]["source_obj"]
        reference = artifacts["reference"]
        obj2tiles_flags = artifacts["delta_source"].get("obj2tiles_flags", ["--y-up-to-z-up"])
        obj2tiles = self.find_delta_3d_obj2tiles()
        node = self.find_delta_3d_node()
        converter = self.find_delta_3d_converter()

        tiles_root = safe_child(delta_dir, "3d_tiles", "model")
        slpk_root = safe_child(delta_dir, "slpk")
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
        ] + obj2tiles_flags, cwd=os.path.dirname(source_obj), env=self.delta_3d_environment())

        tileset_path = safe_child(tiles_root, "tileset.json")
        if not os.path.isfile(tileset_path):
            raise ValueError("Obj2Tiles completed but did not create tileset.json")

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

        build_id = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        filename = get_valid_filename("{}_{}_smartalign_3d_delta.slpk".format(task.name or "task", build_id))
        output_path = safe_child(self.smartalign_dir(task), filename)
        if os.path.isfile(output_path):
            os.remove(output_path)
        shutil.move(slpk_path, output_path)

        result = dict(alignment_3d)
        result["delta_3d"] = {
            "created_at": datetime.utcnow().isoformat() + "Z",
            "build_id": build_id,
            "path": output_path,
            "filename": filename,
            "source_obj": source_obj,
            "reference": reference,
            "source_kind": "SmartAlign Delta Y-up",
            "axis_convention": "obj2tiles_xz_y_height",
            "obj2tiles_flags": obj2tiles_flags,
            "outputs": {
                "slpk": self.api_url(task, "file/{}?download=1".format(filename)),
                "reference": self.api_url(task, "file/delta_3d/source/reference_lla.json?download=1")
            }
        }
        outputs = dict(result.get("outputs") or {})
        outputs["delta_slpk"] = result["delta_3d"]["outputs"]["slpk"]
        result["outputs"] = outputs
        self.save_json(task, "alignment_3d.json", result)
        self.save_json(task, "delta_3d.json", result["delta_3d"])

        public = dict(result)
        public.pop("source_path", None)
        public.pop("output_path", None)
        public.pop("zip_path", None)
        if public.get("delta_3d"):
            public["delta_3d"] = dict(public["delta_3d"])
            public["delta_3d"].pop("path", None)
            public["delta_3d"].pop("source_obj", None)
        return public

    def normalize_3d_placement(self, placement):
        if not isinstance(placement, dict):
            placement = {}

        def number(name, default, minimum=None, maximum=None):
            try:
                value = float(placement.get(name, default))
            except (TypeError, ValueError):
                value = float(default)
            if minimum is not None:
                value = max(float(minimum), value)
            if maximum is not None:
                value = min(float(maximum), value)
            return value

        return {
            "offset_x": number("offset_x", 0.0, -10000, 10000),
            "offset_y": number("offset_y", 0.0, -10000, 10000),
            "offset_z": number("offset_z", 0.0, -10000, 10000),
            "yaw_deg": number("yaw_deg", 0.0, -180, 180),
            "scale": number("scale", 1.0, 0.01, 100.0)
        }

    def placed_3d_mapper(self, base_mapper, placement, anchor_x, anchor_y):
        placement = self.normalize_3d_placement(placement)
        yaw = math.radians(float(placement.get("yaw_deg") or 0.0))
        cos_yaw = math.cos(yaw)
        sin_yaw = math.sin(yaw)
        scale = float(placement.get("scale") or 1.0)
        offset_x = float(placement.get("offset_x") or 0.0)
        offset_y = float(placement.get("offset_y") or 0.0)
        offset_z = float(placement.get("offset_z") or 0.0)

        def mapper(x, y, z):
            mapped_x, mapped_y = base_mapper(x, y)
            dx = (float(mapped_x) - anchor_x) * scale
            dy = (float(mapped_y) - anchor_y) * scale
            return (
                anchor_x + dx * cos_yaw - dy * sin_yaw + offset_x,
                anchor_y + dx * sin_yaw + dy * cos_yaw + offset_y,
                float(z) + offset_z
            )

        return mapper, placement

    def align_3d_model(self, task, placement=None):
        alignment = self.load_alignment(task)
        if not alignment:
            raise ValueError("Спочатку створіть aligned GeoTIFF")

        source_obj = self.find_original_3d_obj_source(task)
        ortho_meta = self.ensure_orthophoto_preview(task)
        obj_inspection = self.inspect_obj_asset(source_obj, ortho_meta)
        direct_crs = self.obj_vertices_match_orthophoto_bounds(source_obj, ortho_meta)
        bridge = None
        coords_offset = None
        xy_transform = None
        method = "direct_crs"
        if direct_crs:
            xy_transform = self.old_world_to_aligned_world_transform(task, alignment)
            xy_mapper = lambda x, y: transform_xy(xy_transform, x, y)
        else:
            bridge = self.find_orthophoto_local_bridge(task, obj_inspection.get("bounds"), ortho_meta)
            coords_offset = self.read_odm_georeferencing_coords(task)
            if self.is_authoritative_orthophoto_bridge(bridge):
                method = "local_orthophoto_bridge"
                xy_mapper = self.local_orthophoto_to_map_mapper(bridge, alignment)
            elif coords_offset and self.coords_offset_matches_alignment(coords_offset, alignment):
                xy_transform = self.old_world_to_aligned_world_transform(task, alignment)
                offset = coords_offset.get("offset") or {}
                offset_x = float(offset.get("x") or 0.0)
                offset_y = float(offset.get("y") or 0.0)
                method = "coords_offset"
                xy_mapper = lambda x, y: transform_xy(xy_transform, float(x) + offset_x, float(y) + offset_y)
            else:
                if not bridge.get("available"):
                    if coords_offset and not self.coords_offset_matches_alignment(coords_offset, alignment):
                        raise ValueError("OBJ-модель має coords.txt, але CRS coords.txt не збігається з CRS прив'язки.")
                    raise ValueError("OBJ-модель має локальні vertex-координати, але SmartAlign не знайшов local->orthophoto bridge. Потрібен odm_orthophoto_corners.txt або надійні OBJ bounds.")
                method = "local_orthophoto_bridge"
                xy_mapper = self.local_orthophoto_to_map_mapper(bridge, alignment)

        obj_bounds = obj_inspection.get("bounds") or [0, 0, 0, 0]
        try:
            anchor_source_x = (float(obj_bounds[0]) + float(obj_bounds[2])) / 2.0
            anchor_source_y = (float(obj_bounds[1]) + float(obj_bounds[3])) / 2.0
            anchor_x, anchor_y = xy_mapper(anchor_source_x, anchor_source_y)
        except Exception:
            anchor_x = anchor_y = 0.0
        placed_mapper, normalized_placement = self.placed_3d_mapper(
            xy_mapper,
            placement or {},
            float(anchor_x),
            float(anchor_y)
        )

        output_dir = safe_child(self.smartalign_dir(task), "model_aligned")
        os.makedirs(output_dir, exist_ok=True)

        output_obj = safe_child(output_dir, "odm_textured_model_smartalign.obj")
        vertex_count = self.write_aligned_obj_with_mapper(source_obj, output_obj, placed_mapper)
        copied_sidecars = self.copy_obj_sidecars(source_obj, output_dir)
        output_zip = safe_child(self.smartalign_dir(task), "model_aligned_obj.zip")
        self.zip_directory(output_dir, output_zip)

        result = {
            "created_at": datetime.utcnow().isoformat() + "Z",
            "kind": "obj_mesh",
            "method": method,
            "source": os.path.basename(source_obj),
            "source_path": source_obj,
            "output_path": output_obj,
            "zip_path": output_zip,
            "vertex_count": vertex_count,
            "z_policy": "preserved",
            "crs": alignment.get("crs"),
            "xy_transform": list(xy_transform)[:6] if xy_transform else None,
            "placement": normalized_placement,
            "placement_anchor": {"x": float(anchor_x), "y": float(anchor_y)},
            "coords_offset": coords_offset,
            "orthophoto_bridge": bridge,
            "sidecar_count": len(copied_sidecars),
            "outputs": {
                "obj": self.api_url(task, "file/model_aligned/odm_textured_model_smartalign.obj?download=1"),
                "zip": self.api_url(task, "file/model_aligned_obj.zip?download=1"),
                "transform": self.api_url(task, "file/transform_3d.json?download=1")
            }
        }
        result["softtools_3d"] = self.prepare_smartalign_softtools_3d_artifacts(task, result)
        self.save_json(task, "alignment_3d.json", result)
        self.save_json(task, "transform_3d.json", result)
        public = dict(result)
        public.pop("source_path", None)
        public.pop("output_path", None)
        public.pop("zip_path", None)
        return public

    def prepare_smartalign_softtools_3d_artifacts(self, task, alignment_3d):
        original_obj = self.find_original_3d_obj_source(task, alignment_3d.get("source_path"))
        if not os.path.isfile(original_obj):
            raise ValueError("Original ODM OBJ is not available")

        crs_text = str(alignment_3d.get("crs") or "").strip()
        if not crs_text:
            raise ValueError("SmartAlign 3D alignment has no CRS")

        aligned_obj = alignment_3d.get("output_path") or safe_child(
            self.smartalign_dir(task),
            "model_aligned",
            "odm_textured_model_smartalign.obj"
        )
        source_obj = original_obj
        sidecar_source_obj = original_obj
        xy_mapper = None
        z_scale = 1.0
        if aligned_obj and os.path.isfile(aligned_obj):
            source_obj = aligned_obj
            xy_mapper = lambda x, y: (float(x), float(y))
        elif alignment_3d.get("method") == "manual_similarity_3d":
            if not aligned_obj:
                raise ValueError("SmartAlign 3D aligned OBJ is not available")
            raise ValueError("SmartAlign 3D aligned OBJ is not available")
        else:
            xy_mapper, z_scale = self.softtools_3d_mapper_and_scale(task, source_obj, alignment_3d)

        min_x = min_y = min_z = None
        max_x = max_y = max_z = None
        vertex_count = 0
        z_values = []
        with open(source_obj, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                vertex = self.parse_delta_3d_obj_vertex(line)
                if not vertex:
                    continue
                x, y, z, _extra = vertex
                mapped_x, mapped_y = xy_mapper(x, y)
                min_x = mapped_x if min_x is None else min(min_x, mapped_x)
                max_x = mapped_x if max_x is None else max(max_x, mapped_x)
                min_y = mapped_y if min_y is None else min(min_y, mapped_y)
                max_y = mapped_y if max_y is None else max(max_y, mapped_y)
                min_z = z if min_z is None else min(min_z, z)
                max_z = z if max_z is None else max(max_z, z)
                z_values.append(z)
                vertex_count += 1

        if vertex_count < 1:
            raise ValueError("Original ODM OBJ has no vertices")

        origin_x = (min_x + max_x) / 2.0
        origin_y = (min_y + max_y) / 2.0
        ground_z = self.percentile_value(z_values, 2.0)
        try:
            lon_values, lat_values = rio_transform(CRS.from_string(crs_text), CRS.from_epsg(4326), [origin_x], [origin_y])
            longitude = float(lon_values[0])
            latitude = float(lat_values[0])
        except Exception as e:
            raise ValueError("Could not convert SmartAlign 3D origin to WGS84: {}".format(e))
        terrain = self.get_3d_origin_terrain_reference(task, origin_x, origin_y, crs_text, latitude, longitude)

        root_dir = safe_child(self.smartalign_dir(task), "softtools_3d")
        webodm_dir = safe_child(root_dir, "webodm_model")
        delta_dir = safe_child(root_dir, "delta_source")
        for folder in (webodm_dir, delta_dir):
            if os.path.isdir(folder):
                shutil.rmtree(folder)
            os.makedirs(folder, exist_ok=True)

        self.copy_obj_sidecars(sidecar_source_obj, webodm_dir)
        self.copy_obj_sidecars(sidecar_source_obj, delta_dir)

        webodm_obj = safe_child(webodm_dir, "odm_textured_model_geo.obj")
        delta_obj = safe_child(delta_dir, "odm_textured_model_geo.obj")

        def write_converted_obj(output_obj, axis_convention):
            written = 0
            with open(source_obj, "r", encoding="utf-8", errors="replace") as src, open(
                output_obj,
                "w",
                encoding="utf-8",
                newline=""
            ) as dst:
                for line in src:
                    vertex = self.parse_delta_3d_obj_vertex(line)
                    if not vertex:
                        dst.write(line)
                        continue
                    x, y, z, extra = vertex
                    mapped_x, mapped_y = xy_mapper(x, y)
                    rel_x = mapped_x - origin_x
                    rel_y = mapped_y - origin_y
                    rel_z = (z - ground_z) * z_scale
                    if axis_convention == "webodm_xy_z_height":
                        coords = [rel_x, rel_y, rel_z]
                    else:
                        # Obj2Tiles converts Y-up OBJ coordinates to Z-up as X, -Z, Y.
                        # Store northing as negative Z so the final Z-up Y axis keeps the SmartAlign orientation.
                        coords = [rel_x, rel_z, -rel_y]
                    values = ["v"] + [self.format_delta_3d_obj_coord(value) for value in coords]
                    values.extend(extra)
                    dst.write(" ".join(values) + "\n")
                    written += 1
            return written

        webodm_vertex_count = write_converted_obj(webodm_obj, "webodm_xy_z_height")
        delta_vertex_count = write_converted_obj(delta_obj, "obj2tiles_xz_y_height")

        reference_lla = {
            "latitude": latitude,
            "longitude": longitude,
            "altitude": terrain["elevation"]
        }
        reference_path = safe_child(delta_dir, "reference_lla.json")
        with open(reference_path, "w", encoding="utf-8") as f:
            json.dump(reference_lla, f, ensure_ascii=False, indent=2)

        created_at = datetime.utcnow().isoformat() + "Z"
        alignment_method = alignment_3d.get("method")
        rotation_source = "OBJ local X/Y -> orthophoto pixel X/Y -> SmartAlign raster_transform"
        if alignment_method == "manual_similarity_3d":
            rotation_source = "Manual 3D mesh XYZ -> map CRS XYZ similarity transform"
        elif alignment_method == "coords_offset":
            rotation_source = "OBJ local X/Y + ODM coords.txt offset -> SmartAlign raster_transform"
        elif alignment_method == "direct_crs":
            rotation_source = "OBJ CRS X/Y -> SmartAlign raster_transform"
        coords_offset = alignment_3d.get("coords_offset")
        public_coords_offset = dict(coords_offset) if isinstance(coords_offset, dict) else None
        if public_coords_offset:
            public_coords_offset.pop("path", None)
        common = {
            "active": True,
            "created_at": created_at,
            "source_task_id": str(task.id),
            "source_project_id": str(task.project_id),
            "source_obj_original": original_obj,
            "source_obj_aligned": source_obj if source_obj != original_obj else "",
            "alignment_created_at": alignment_3d.get("created_at"),
            "alignment_method": alignment_method,
            "map_crs": crs_text,
            "origin": {"x": origin_x, "y": origin_y, "z": ground_z, "crs": crs_text},
            "origin_lla": reference_lla,
            "bounds": [min_x, min_y, min_z, max_x, max_y, max_z],
            "horizontal_scale": z_scale,
            "z_scale": z_scale,
            "ground_z_percentile": 2.0,
            "z_policy": "ground_rebased_global_offset",
            "dem": terrain,
            "coords_offset": public_coords_offset,
            "rotation_source": rotation_source,
            "delta_y_up_mapping": "x=rel_x, y=rel_z, z=-rel_y; Obj2Tiles --y-up-to-z-up restores x/east, y/north, z/up"
        }
        webodm_manifest = dict(common)
        webodm_manifest.update({
            "axis_convention": "webodm_xy_z_height",
            "source_obj": webodm_obj,
            "vertex_count": webodm_vertex_count
        })
        delta_manifest = dict(common)
        delta_manifest.update({
            "axis_convention": "obj2tiles_xz_y_height",
            "source_obj": delta_obj,
            "reference_lla": reference_path,
            "vertex_count": delta_vertex_count,
            "obj2tiles_flags": ["--y-up-to-z-up"]
        })
        root_manifest = dict(common)
        root_manifest.update({
            "webodm_model": webodm_manifest,
            "delta_source": delta_manifest
        })
        for path, payload in (
            (safe_child(root_dir, "manifest.json"), root_manifest),
            (safe_child(webodm_dir, "manifest.json"), webodm_manifest),
            (safe_child(delta_dir, "manifest.json"), delta_manifest),
        ):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

        return {
            "ready": True,
            "created_at": created_at,
            "root_dir": root_dir,
            "reference": reference_lla,
            "webodm_model": {
                "dir": webodm_dir,
                "source_obj": webodm_obj,
                "axis_convention": "webodm_xy_z_height",
                "vertex_count": webodm_vertex_count,
                "manifest": safe_child(webodm_dir, "manifest.json")
            },
            "delta_source": {
                "dir": delta_dir,
                "source_obj": delta_obj,
                "reference_lla": reference_path,
                "axis_convention": "obj2tiles_xz_y_height",
                "vertex_count": delta_vertex_count,
                "manifest": safe_child(delta_dir, "manifest.json"),
                "obj2tiles_flags": ["--y-up-to-z-up"]
            },
            "outputs": {
                "manifest": self.api_url(task, "file/softtools_3d/manifest.json?download=1"),
                "delta_reference": self.api_url(task, "file/softtools_3d/delta_source/reference_lla.json?download=1")
            }
        }

    def write_softtools_ready_obj(self, source_obj, output_obj, reference, xy_mapper, z_scale):
        origin = reference.get("origin") or {}
        origin_x = float(origin.get("x"))
        origin_y = float(origin.get("y"))
        ground_z = float(origin.get("z"))
        vertex_count = 0
        with open(source_obj, "r", encoding="utf-8", errors="replace") as src, open(
            output_obj,
            "w",
            encoding="utf-8",
            newline=""
        ) as dst:
            for line in src:
                vertex = self.parse_delta_3d_obj_vertex(line)
                if not vertex:
                    dst.write(line)
                    continue
                x, y, z, extra = vertex
                mapped_x, mapped_y = xy_mapper(x, y)
                values = [
                    "v",
                    self.format_delta_3d_obj_coord(mapped_x - origin_x),
                    self.format_delta_3d_obj_coord(mapped_y - origin_y),
                    self.format_delta_3d_obj_coord((z - ground_z) * z_scale)
                ]
                values.extend(extra)
                dst.write(" ".join(values) + "\n")
                vertex_count += 1
        if vertex_count < 1:
            raise ValueError("Original ODM OBJ has no vertices")
        return vertex_count

    def prepare_softtools_3d_source(self, task, alignment_3d, work_dir):
        aligned_obj = alignment_3d.get("output_path") or safe_child(self.smartalign_dir(task), "model_aligned", "odm_textured_model_smartalign.obj")
        if not os.path.isfile(aligned_obj):
            raise ValueError("SmartAlign aligned OBJ is not available")
        source_obj = self.find_original_3d_obj_source(task, alignment_3d.get("source_path"))
        if not os.path.isfile(source_obj):
            raise ValueError("Original ODM OBJ is not available")

        prepared_dir = safe_child(work_dir, "odm_texturing")
        os.makedirs(prepared_dir, exist_ok=True)
        for name in os.listdir(os.path.dirname(source_obj)):
            source_path = os.path.join(os.path.dirname(source_obj), name)
            if os.path.isfile(source_path):
                shutil.copy2(source_path, safe_child(prepared_dir, name))

        prepared_obj = safe_child(prepared_dir, "odm_textured_model_geo.obj")
        _discard_obj, reference = self.prepare_delta_3d_source(task, alignment_3d, work_dir)
        xy_mapper, z_scale = self.softtools_3d_mapper_and_scale(task, source_obj, alignment_3d)
        vertex_count = self.write_softtools_ready_obj(source_obj, prepared_obj, reference, xy_mapper, z_scale)
        reference["vertex_count"] = vertex_count
        reference["geometry_policy"] = "smartalign_xy_transformed_odm_z_scaled"
        reference["z_scale"] = z_scale
        reference["target"] = "soft_tools_delta_export"
        return {
            "source_dir": prepared_dir,
            "source_obj": prepared_obj,
            "reference": reference
        }

    def parse_3d_control_points(self, task, points):
        if not isinstance(points, list):
            raise ValueError("Некоректний список 3D точок")
        alignment = self.load_alignment(task)
        ortho_meta = self.ensure_orthophoto_preview(task)
        target_crs = (alignment or {}).get("crs") or ortho_meta.get("crs") or "EPSG:4326"

        parsed = []
        local_points = []
        world_points = []
        for index, point in enumerate(points):
            if not isinstance(point, dict) or point.get("enabled") is False:
                continue
            mesh = point.get("mesh") or {}
            world = point.get("world") or {}
            reference = point.get("reference") or {}
            try:
                mesh_point = [
                    float(mesh.get("x")),
                    float(mesh.get("y")),
                    float(mesh.get("z")),
                ]
                lat = world.get("lat", reference.get("lat"))
                lon = world.get("lon", world.get("lng", reference.get("lng")))
                height = world.get("height", point.get("height", 0.0))
                map_x, map_y = lonlat_to_world(lon, lat, target_crs)
                world_point = [float(map_x), float(map_y), float(height)]
            except Exception:
                raise ValueError("3D точка {} має некоректні координати".format(index + 1))

            item = dict(point)
            item["id"] = item.get("id") or "P{}".format(len(parsed) + 1)
            item["mesh"] = {"x": mesh_point[0], "y": mesh_point[1], "z": mesh_point[2]}
            item["world"] = {
                "lat": float(lat),
                "lon": float(lon),
                "height": float(height),
                "x": world_point[0],
                "y": world_point[1],
                "z": world_point[2],
                "crs": target_crs
            }
            item["enabled"] = True
            parsed.append(item)
            local_points.append(mesh_point)
            world_points.append(world_point)

        if len(parsed) < 3:
            raise ValueError("Для 3D прив’язки потрібно щонайменше 3 увімкнені пари точок")
        return parsed, np.asarray(local_points, dtype=np.float64), np.asarray(world_points, dtype=np.float64), target_crs

    def write_3d_similarity_obj(self, source_obj, output_obj, scale, rotation, translation):
        vertex_count = 0
        with open(source_obj, "r", encoding="utf-8", errors="ignore") as src, open(output_obj, "w", encoding="utf-8", newline="") as dst:
            for line in src:
                if not line.startswith("v "):
                    dst.write(line)
                    continue
                vertex = parse_obj_vertex(line)
                if not vertex:
                    dst.write(line)
                    continue
                x, y, z, rest = vertex
                transformed = apply_similarity_3d(np.asarray([[x, y, z]], dtype=np.float64), scale, rotation, translation)[0]
                values = ["v", format_coord(transformed[0]), format_coord(transformed[1]), format_coord(transformed[2])]
                values.extend(rest)
                dst.write(" ".join(values) + "\n")
                vertex_count += 1
        if vertex_count < 1:
            raise ValueError("OBJ не містить vertex-рядків")
        return vertex_count

    def align_3d_model_from_points(self, task, points):
        source_obj = self.find_original_3d_obj_source(task)
        parsed_points, local_points, world_points, target_crs = self.parse_3d_control_points(task, points)
        scale, rotation, translation = solve_umeyama_3d(local_points, world_points, with_scale=True)
        predicted = apply_similarity_3d(local_points, scale, rotation, translation)
        errors = np.linalg.norm(predicted - world_points, axis=1)
        rmse = float(np.sqrt(np.mean(errors ** 2)))

        for point, error in zip(parsed_points, errors):
            point["error"] = float(error)

        output_dir = safe_child(self.smartalign_dir(task), "model_aligned_3d")
        os.makedirs(output_dir, exist_ok=True)
        output_obj = safe_child(output_dir, "odm_textured_model_smartalign3d.obj")
        vertex_count = self.write_3d_similarity_obj(source_obj, output_obj, scale, rotation, translation)
        copied_sidecars = self.copy_obj_sidecars(source_obj, output_dir)
        output_zip = safe_child(self.smartalign_dir(task), "model_aligned_3d_obj.zip")
        self.zip_directory(output_dir, output_zip)

        result = {
            "created_at": datetime.utcnow().isoformat() + "Z",
            "kind": "obj_mesh",
            "method": "manual_similarity_3d",
            "source": os.path.basename(source_obj),
            "source_path": source_obj,
            "output_path": output_obj,
            "zip_path": output_zip,
            "vertex_count": vertex_count,
            "sidecar_count": len(copied_sidecars),
            "crs": target_crs,
            "scale": float(scale),
            "rotation_matrix": rotation.tolist(),
            "translation": [float(value) for value in translation],
            "rms_error_m": rmse,
            "rmse": rmse,
            "residuals": [float(value) for value in errors],
            "point_count": len(parsed_points),
            "points": parsed_points,
            "z_policy": "manual_control_point_height",
            "outputs": {
                "obj": self.api_url(task, "file/model_aligned_3d/odm_textured_model_smartalign3d.obj?download=1"),
                "zip": self.api_url(task, "file/model_aligned_3d_obj.zip?download=1"),
                "transform": self.api_url(task, "file/transform_3d.json?download=1")
            }
        }
        result["softtools_3d"] = self.prepare_smartalign_softtools_3d_artifacts(task, result)
        self.save_json(task, "alignment_3d.json", result)
        self.save_json(task, "transform_3d.json", result)
        public = dict(result)
        public.pop("source_path", None)
        public.pop("output_path", None)
        public.pop("zip_path", None)
        return public

    def backup_3d_assets(self, task, model_dir, reference_path, replacement):
        backup_dir = replacement.get("backup_dir") if replacement else None
        if backup_dir and os.path.isdir(backup_dir):
            return backup_dir

        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        backup_dir = safe_child(self.smartalign_dir(task), "backups", "3d", timestamp)
        backup_model_dir = safe_child(backup_dir, "odm_texturing")
        os.makedirs(backup_model_dir, exist_ok=True)

        backed_model_files = []
        if os.path.isdir(model_dir):
            for name in os.listdir(model_dir):
                source_path = os.path.join(model_dir, name)
                if os.path.isfile(source_path):
                    shutil.copy2(source_path, safe_child(backup_model_dir, name))
                    backed_model_files.append(name)

        reference_backup = {
            "path": reference_path,
            "existed": os.path.isfile(reference_path),
            "relative_backup": ""
        }
        if reference_backup["existed"]:
            backup_reference_path = safe_child(backup_dir, "opensfm", "reference_lla.json")
            os.makedirs(os.path.dirname(backup_reference_path), exist_ok=True)
            shutil.copy2(reference_path, backup_reference_path)
            reference_backup["relative_backup"] = "opensfm/reference_lla.json"

        manifest = {
            "created_at": datetime.utcnow().isoformat() + "Z",
            "model_dir": model_dir,
            "model_files": backed_model_files,
            "reference": reference_backup
        }
        with open(safe_child(backup_dir, "backup_3d.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        return backup_dir

    def replace_webodm_3d_model(self, task):
        alignment_3d = self.load_json(task, "alignment_3d.json")
        if not alignment_3d:
            self.align_3d_model(task)
            alignment_3d = self.load_json(task, "alignment_3d.json")
        if not alignment_3d:
            raise ValueError("SmartAlign aligned 3D model is not available")

        target_model_dir = task.assets_path("odm_texturing")
        target_obj = safe_child(target_model_dir, "odm_textured_model_geo.obj")
        if not os.path.isdir(target_model_dir):
            raise ValueError("WebODM odm_texturing folder is not available")

        reference_dir = task.assets_path("opensfm")
        os.makedirs(reference_dir, exist_ok=True)
        reference_path = safe_child(reference_dir, "reference_lla.json")

        replacement = self.load_replacement_3d(task) or {}
        backup_dir = self.backup_3d_assets(task, target_model_dir, reference_path, replacement)

        artifacts = self.prepare_smartalign_softtools_3d_artifacts(task, alignment_3d)
        prepared_dir = artifacts["webodm_model"]["dir"]
        prepared_obj = artifacts["webodm_model"]["source_obj"]

        for name in os.listdir(target_model_dir):
            path = os.path.join(target_model_dir, name)
            if os.path.isfile(path):
                os.remove(path)
        for name in os.listdir(prepared_dir):
            if name == "manifest.json":
                continue
            source_path = os.path.join(prepared_dir, name)
            if os.path.isfile(source_path):
                shutil.copy2(source_path, safe_child(target_model_dir, name))
        if not os.path.isfile(target_obj):
            shutil.copy2(prepared_obj, target_obj)

        with open(reference_path, "w", encoding="utf-8") as f:
            json.dump({
                "latitude": artifacts["reference"]["latitude"],
                "longitude": artifacts["reference"]["longitude"],
                "altitude": artifacts["reference"]["altitude"]
            }, f, ensure_ascii=False, indent=2)

        replacement = {
            "active": True,
            "replaced_at": datetime.utcnow().isoformat() + "Z",
            "backup_dir": backup_dir,
            "model_dir": target_model_dir,
            "reference_path": reference_path,
            "prepared_dir": prepared_dir,
            "reference": artifacts["reference"],
            "webodm_model_ready": True,
            "soft_tools_delta_source_ready": True,
            "softtools_3d": artifacts
        }
        self.save_json(task, "replacement_3d.json", replacement)
        self.clear_3d_derivatives(task)
        return self.public_replacement_3d_metadata(replacement)

    def restore_webodm_3d_model(self, task):
        replacement = self.load_replacement_3d(task)
        if not replacement or not replacement.get("backup_dir"):
            raise ValueError("3D backup not found")

        backup_dir = replacement.get("backup_dir")
        manifest_path = safe_child(backup_dir, "backup_3d.json")
        if not os.path.isfile(manifest_path):
            raise ValueError("3D backup manifest not found")
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        target_model_dir = manifest.get("model_dir") or task.assets_path("odm_texturing")
        backup_model_dir = safe_child(backup_dir, "odm_texturing")
        if not os.path.isdir(backup_model_dir):
            raise ValueError("3D model backup folder not found")
        os.makedirs(target_model_dir, exist_ok=True)
        for name in os.listdir(target_model_dir):
            path = os.path.join(target_model_dir, name)
            if os.path.isfile(path):
                os.remove(path)
        for name in os.listdir(backup_model_dir):
            source_path = os.path.join(backup_model_dir, name)
            if os.path.isfile(source_path):
                shutil.copy2(source_path, safe_child(target_model_dir, name))

        reference = manifest.get("reference") or {}
        reference_path = reference.get("path") or task.assets_path("opensfm", "reference_lla.json")
        if reference.get("existed"):
            backup_reference = safe_child(backup_dir, reference.get("relative_backup") or "opensfm/reference_lla.json")
            if os.path.isfile(backup_reference):
                os.makedirs(os.path.dirname(reference_path), exist_ok=True)
                shutil.copy2(backup_reference, reference_path)
        elif os.path.isfile(reference_path):
            os.remove(reference_path)

        replacement["active"] = False
        replacement["restored_at"] = datetime.utcnow().isoformat() + "Z"
        self.save_json(task, "replacement_3d.json", replacement)
        self.clear_3d_derivatives(task)
        return self.public_replacement_3d_metadata(replacement)

    def public_replacement_3d_metadata(self, replacement):
        if not replacement:
            return None
        public = dict(replacement)
        public.pop("backup_dir", None)
        public.pop("model_dir", None)
        public.pop("reference_path", None)
        public.pop("prepared_dir", None)
        return public

    def clear_3d_derivatives(self, task):
        try:
            task.update_available_assets_field(commit=True)
        except Exception:
            logger.warning("SmartAlign could not update available assets after 3D replacement")

        try:
            task.clear_task_assets_cache()
        except Exception:
            logger.warning("SmartAlign could not clear task assets cache after 3D replacement")

    def replace_webodm_orthophoto(self, task):
        aligned_path = safe_child(self.smartalign_dir(task), "orthophoto_aligned.tif")
        if not os.path.isfile(aligned_path):
            raise ValueError("Спочатку створіть aligned GeoTIFF")

        original_path = task.get_asset_download_path("orthophoto.tif")
        if not os.path.isfile(original_path):
            raise ValueError("Оригінальне ортофото WebODM не знайдено")

        replacement = self.load_replacement(task) or {}
        backups_dir = safe_child(self.smartalign_dir(task), "backups")
        os.makedirs(backups_dir, exist_ok=True)

        backup_path = replacement.get("backup_path")
        if not backup_path or not os.path.isfile(backup_path):
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            backup_path = safe_child(backups_dir, "odm_orthophoto_before_smartalign_{}.tif".format(timestamp))
            shutil.copy2(original_path, backup_path)

        shutil.copy2(aligned_path, original_path)
        self.clear_orthophoto_derivatives(task)

        replacement = {
            "active": True,
            "replaced_at": datetime.utcnow().isoformat() + "Z",
            "backup_path": backup_path,
            "original_path": original_path,
            "aligned_path": aligned_path
        }
        self.save_json(task, "replacement.json", replacement)
        return self.public_replacement_metadata(replacement)

    def restore_webodm_orthophoto(self, task):
        replacement = self.load_replacement(task)
        if not replacement or not replacement.get("backup_path"):
            raise ValueError("Backup ортофото не знайдено")

        backup_path = replacement.get("backup_path")
        if not os.path.isfile(backup_path):
            raise ValueError("Backup-файл ортофото не знайдено")

        original_path = task.get_asset_download_path("orthophoto.tif")
        shutil.copy2(backup_path, original_path)
        self.clear_orthophoto_derivatives(task)

        replacement["active"] = False
        replacement["restored_at"] = datetime.utcnow().isoformat() + "Z"
        self.save_json(task, "replacement.json", replacement)
        return self.public_replacement_metadata(replacement)

    def public_replacement_metadata(self, replacement):
        if not replacement:
            return None
        public = dict(replacement)
        public.pop("backup_path", None)
        public.pop("original_path", None)
        public.pop("aligned_path", None)
        return public

    def clear_orthophoto_derivatives(self, task):
        candidates = [
            task.assets_path("orthophoto_tiles"),
            task.assets_path("odm_orthophoto", "odm_orthophoto.png"),
            task.assets_path("odm_orthophoto", "odm_orthophoto.mbtiles"),
            safe_child(self.smartalign_dir(task), "orthophoto_preview.png"),
            safe_child(self.smartalign_dir(task), "orthophoto.json")
        ]

        for path in candidates:
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                elif os.path.isfile(path):
                    os.remove(path)
            except Exception:
                logger.warning("SmartAlign could not remove derived file %s", path)

        try:
            task.update_available_assets_field(commit=True)
        except Exception:
            logger.warning("SmartAlign could not update available assets after replacement")

        try:
            task.clear_task_assets_cache()
        except Exception:
            logger.warning("SmartAlign could not clear task assets cache")

