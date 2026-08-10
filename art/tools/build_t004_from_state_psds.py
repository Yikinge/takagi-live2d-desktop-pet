#!/usr/bin/env python3
"""Audit and export the two user-supplied t004 state PSDs non-destructively."""

from __future__ import annotations

import hashlib
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont
from psd_tools import PSDImage


ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "idle": ROOT / "art/source/takagi-idle-state-seethrough-t004.psd",
    "keyboard_active": ROOT
    / "art/source/takagi-keyboard-active-state-seethrough-t004.psd",
}
OUT = ROOT / "art/processed/t004-state-audit"
RUNTIME_OUT = ROOT / "public/models/takagi/overlays"
RUNTIME_SIZE = (1254, 1254)
UNIFIED_FRONT_HAIR_SOURCE = (
    ROOT / "art/source/takagi-front-hair-source-t004.png"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def alpha_stats(image: Image.Image) -> dict[str, object]:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    histogram = alpha.histogram()
    return {
        "alpha_bbox": alpha.getbbox(),
        "transparent_pixels": histogram[0],
        "opaque_pixels": histogram[255],
        "partial_alpha_pixels": sum(histogram[1:255]),
    }


def dilate(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    result = mask.astype(bool, copy=True)
    for _ in range(iterations):
        padded = np.pad(result, 1, mode="constant")
        result = np.logical_or.reduce(
            [
                padded[dy : dy + result.shape[0], dx : dx + result.shape[1]]
                for dy in range(3)
                for dx in range(3)
            ]
        )
    return result


def clean_small_alpha_components(
    image: Image.Image,
    *,
    threshold: int = 6,
    minimum_area: int = 24,
) -> Image.Image:
    """Remove isolated See-through speckles without flattening soft edges."""
    rgba = np.asarray(image.convert("RGBA")).copy()
    alpha = rgba[..., 3]
    foreground = alpha > threshold
    visited = np.zeros(foreground.shape, dtype=bool)
    keep = np.zeros(foreground.shape, dtype=bool)
    height, width = foreground.shape
    for y in range(height):
        for x in range(width):
            if not foreground[y, x] or visited[y, x]:
                continue
            pending: deque[tuple[int, int]] = deque([(x, y)])
            visited[y, x] = True
            component: list[tuple[int, int]] = []
            while pending:
                px, py = pending.popleft()
                component.append((px, py))
                for nx, ny in (
                    (px - 1, py - 1),
                    (px, py - 1),
                    (px + 1, py - 1),
                    (px - 1, py),
                    (px + 1, py),
                    (px - 1, py + 1),
                    (px, py + 1),
                    (px + 1, py + 1),
                ):
                    if (
                        0 <= nx < width
                        and 0 <= ny < height
                        and foreground[ny, nx]
                        and not visited[ny, nx]
                    ):
                        visited[ny, nx] = True
                        pending.append((nx, ny))
            if len(component) >= minimum_area:
                for px, py in component:
                    keep[py, px] = True
    # Retain the original antialiasing halo around accepted components.
    keep = dilate(keep, 2)
    rgba[..., 3] = np.where(keep, alpha, 0)
    return Image.fromarray(rgba, "RGBA")


def flood_closed_component(
    image: Image.Image,
    roi: tuple[int, int, int, int],
    seed: tuple[int, int],
    *,
    closure: int = 1,
) -> np.ndarray:
    """Select one dark-outlined component while preserving its antialiasing."""
    rgba = np.asarray(image.convert("RGBA"))
    red, green, blue, alpha = np.moveaxis(rgba, -1, 0)
    ink = (
        (alpha > 5)
        & (
            ((red < 110) & (green < 125) & (blue < 165))
            | ((red < 80) & (green < 95))
        )
    )
    closed_ink = dilate(ink, closure)
    left, top, right, bottom = roi
    allowed = np.zeros(alpha.shape, dtype=bool)
    allowed[top:bottom, left:right] = True
    free = allowed & ~closed_ink
    sx, sy = seed
    if not free[sy, sx]:
        raise RuntimeError(f"Mouse seed {seed} is not inside the closed component")
    component = np.zeros(alpha.shape, dtype=bool)
    component[sy, sx] = True
    pending: deque[tuple[int, int]] = deque([(sx, sy)])
    while pending:
        x, y = pending.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (
                0 <= nx < alpha.shape[1]
                and 0 <= ny < alpha.shape[0]
                and free[ny, nx]
                and not component[ny, nx]
            ):
                component[ny, nx] = True
                pending.append((nx, ny))
    outline = dilate(component, closure + 3) & ink & allowed
    selected = (component | outline) & (alpha > 0)
    # A closed subject may not touch the artificial ROI border. This catches
    # any future flood leak before it becomes a visible rectangular patch.
    border = np.zeros_like(selected)
    border[top:bottom, left] = True
    border[top:bottom, right - 1] = True
    border[top, left:right] = True
    border[bottom - 1, left:right] = True
    if np.any(selected & border):
        raise RuntimeError("Closed-component extraction leaked into the ROI border")
    return selected


def apply_mask(image: Image.Image, mask: np.ndarray) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    rgba[..., 3] = np.where(mask, rgba[..., 3], 0)
    return Image.fromarray(rgba, "RGBA")


def extract_idle_keyboard_glove(image: Image.Image) -> Image.Image:
    """Keep only the pink idle mitten; no white cuff or arm is visible."""
    # Follow the dark curved rim at the top of the mitten, then retain the
    # complete pink hand below it.  The antialiased polygon avoids introducing
    # a hard horizontal cut while excluding the PSD's white cuff entirely.
    mask = smooth_polygon_mask(
        image.size,
        [
            (332, 602),
            (340, 591),
            (352, 583),
            (368, 579),
            (397, 580),
            (420, 585),
            (438, 593),
            (451, 603),
            (459, 680),
            (332, 680),
        ],
        scale=4,
    )
    glove = np.asarray(apply_mask(image, mask)).copy()
    red, green, blue, alpha = np.moveaxis(glove, -1, 0)
    rows = np.indices(alpha.shape)[0]
    pale_cuff = (
        (rows < 605)
        & (alpha > 0)
        & (red > 135)
        & (np.abs(red.astype(int) - green.astype(int)) < 34)
        & (np.abs(red.astype(int) - blue.astype(int)) < 34)
    )
    glove[..., 3] = np.where(pale_cuff, 0, alpha)
    return Image.fromarray(glove, "RGBA")


def crop_alpha_to_roi(
    image: Image.Image, roi: tuple[int, int, int, int]
) -> Image.Image:
    """Discard See-through reconstruction noise outside a known source part."""
    rgba = np.asarray(image.convert("RGBA")).copy()
    left, top, right, bottom = roi
    keep = np.zeros(rgba.shape[:2], dtype=bool)
    keep[top:bottom, left:right] = True
    rgba[..., 3] = np.where(keep, rgba[..., 3], 0)
    return Image.fromarray(rgba, "RGBA")


def smooth_polygon_mask(
    size: tuple[int, int], points: list[tuple[int, int]], scale: int = 4
) -> np.ndarray:
    high = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(high)
    draw.polygon([(x * scale, y * scale) for x, y in points], fill=255)
    low = high.resize(size, Image.Resampling.LANCZOS)
    return np.asarray(low) > 8


def resize_runtime(image: Image.Image) -> Image.Image:
    return image.resize(RUNTIME_SIZE, Image.Resampling.LANCZOS)


def build_runtime_assets(
    idle: dict[str, Image.Image],
    active: dict[str, Image.Image],
) -> dict[str, Image.Image]:
    objects = clean_small_alpha_components(idle["objects"], minimum_area=18)
    topwear = crop_alpha_to_roi(
        clean_small_alpha_components(idle["topwear"], minimum_area=18),
        (390, 445, 650, 695),
    )
    keyboard_idle = extract_idle_keyboard_glove(
        clean_small_alpha_components(idle["handwear-r"])
    )
    keyboard_active = clean_small_alpha_components(active["handwear-r"])
    mouse_hand = clean_small_alpha_components(idle["handwear-l"])
    # Keep the PSD's continuous front-hair layer intact. The Cubism source
    # split this same artwork into five abutting texture bands, whose packed
    # antialiased edges can reveal straight seams at runtime.
    # Use the continuous mother layer that the current Cubism model's five
    # front-hair ArtMeshes were cut from. It shares their exact 1024px model
    # coordinates, unlike the later t004 state composite whose character was
    # positioned at a different scale inside the PSD canvas.
    front_hair = Image.open(UNIFIED_FRONT_HAIR_SOURCE).convert("RGBA")

    # The See-through `objects` layer merges the mouse with the pad. A wider
    # ink closure seals its antialiased outline without bringing pad pixels
    # into the movable mouse asset.
    mouse_left = flood_closed_component(
        objects,
        (675, 665, 825, 855),
        (720, 735),
        closure=4,
    )
    mouse_right = flood_closed_component(
        objects,
        (675, 665, 825, 855),
        (780, 740),
        closure=4,
    )
    mouse_mask = mouse_left | mouse_right
    mouse_mask &= np.asarray(objects.getchannel("A")) > 0
    mouse = apply_mask(objects, mouse_mask)
    mouse_group = Image.alpha_composite(mouse, mouse_hand)

    # The mouse pad under the source mouse is a soft warm solid. Fill only the
    # hidden mouse footprint so small pointer movements never reveal a second
    # stationary mouse. The outer pad, dashed seam and desk remain untouched.
    base_pixels = np.asarray(objects.convert("RGBA")).copy()
    remove_mouse = dilate(mouse_mask, 7)
    sample_region = np.zeros(mouse_mask.shape, dtype=bool)
    sample_region[690:835, 650:855] = True
    sample_region &= ~dilate(mouse_mask, 14)
    sample_region &= base_pixels[..., 3] > 220
    sample_region &= base_pixels[..., 0] > 180
    sample_region &= base_pixels[..., 1] > 180
    sample_region &= base_pixels[..., 2] > 175
    samples = base_pixels[sample_region, :3]
    fill = np.median(samples, axis=0).astype(np.uint8) if len(samples) else np.array([250, 244, 235], dtype=np.uint8)
    fill_area = remove_mouse & (base_pixels[..., 3] > 0)
    base_pixels[fill_area, :3] = fill
    base_pixels[fill_area, 3] = 255
    objects_base = Image.fromarray(base_pixels, "RGBA")

    assets = {
        "topwear": resize_runtime(topwear),
        "objects_base": resize_runtime(objects_base),
        "mouse_group": resize_runtime(mouse_group),
        "keyboard_idle": resize_runtime(keyboard_idle),
        "keyboard_active": resize_runtime(keyboard_active),
        "front_hair": resize_runtime(front_hair),
    }
    return assets


def render_full_layer(layer, size: tuple[int, int]) -> Image.Image:
    rendered = layer.composite(force=True)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    if rendered is None:
        return canvas
    rendered = rendered.convert("RGBA")
    canvas.alpha_composite(rendered, (layer.left, layer.top))
    return canvas


def difference_score(a: Image.Image, b: Image.Image) -> dict[str, object]:
    diff = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA"))
    bbox = diff.getbbox()
    histogram = diff.convert("RGB").histogram()
    weighted = sum((index % 256) * count for index, count in enumerate(histogram))
    pixels = a.width * a.height * 3
    return {
        "bbox": bbox,
        "mean_absolute_error": weighted / max(1, pixels),
    }


def make_contact_sheet(
    state: str, layers: list[tuple[str, Image.Image]], composite: Image.Image
) -> Image.Image:
    thumb = 240
    label = 34
    columns = 4
    entries = [("COMPOSITE", composite), *layers]
    rows = (len(entries) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * thumb, rows * (thumb + label)), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=18)
    checker = Image.new("RGB", (thumb, thumb), (236, 239, 244))
    checker_draw = ImageDraw.Draw(checker)
    step = 20
    for y in range(0, thumb, step):
        for x in range(0, thumb, step):
            if (x // step + y // step) % 2:
                checker_draw.rectangle((x, y, x + step - 1, y + step - 1), fill=(214, 220, 230))

    for index, (name, image) in enumerate(entries):
        x = (index % columns) * thumb
        y = (index // columns) * (thumb + label)
        tile = checker.copy().convert("RGBA")
        preview = image.copy().convert("RGBA")
        preview.thumbnail((thumb, thumb), Image.Resampling.LANCZOS)
        tile.alpha_composite(preview, ((thumb - preview.width) // 2, (thumb - preview.height) // 2))
        sheet.paste(tile.convert("RGB"), (x, y))
        draw.text((x + 8, y + thumb + 7), name, fill=(35, 38, 45), font=font)

    draw.text((10, 10), state, fill=(180, 50, 50), font=font)
    return sheet


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, object] = {"states": {}}
    rendered_states: dict[str, dict[str, Image.Image]] = {}

    for state, source in SOURCES.items():
        psd = PSDImage.open(source)
        if psd.size != (1024, 1024):
            raise RuntimeError(f"Unexpected canvas for {source}: {psd.size}")
        state_dir = OUT / state
        state_dir.mkdir(parents=True, exist_ok=True)
        composite = psd.composite(force=True).convert("RGBA")
        composite.save(state_dir / "composite.png")

        layer_records = []
        contact_layers: list[tuple[str, Image.Image]] = []
        rendered_layers: dict[str, Image.Image] = {}
        for index, layer in enumerate(psd):
            image = render_full_layer(layer, psd.size)
            safe_name = layer.name.replace("/", "_").replace(" ", "-")
            filename = f"{index:02d}-{safe_name}.png"
            image.save(state_dir / filename)
            stats = alpha_stats(image)
            layer_records.append(
                {
                    "index": index,
                    "name": layer.name,
                    "kind": layer.kind,
                    "visible": layer.visible,
                    "opacity": layer.opacity,
                    "blend_mode": str(layer.blend_mode),
                    "psd_bbox": tuple(layer.bbox),
                    "export": str((state_dir / filename).relative_to(ROOT)),
                    **stats,
                }
            )
            contact_layers.append((layer.name, image))
            rendered_layers[layer.name] = image

        make_contact_sheet(state, contact_layers, composite).save(
            state_dir / "contact-sheet.png"
        )
        manifest["states"][state] = {
            "source": str(source.relative_to(ROOT)),
            "sha256": sha256(source),
            "size": psd.size,
            "depth": psd.depth,
            "color_mode": int(psd.color_mode),
            "layer_count": len(psd),
            "composite": str((state_dir / "composite.png").relative_to(ROOT)),
            "layers": layer_records,
        }
        rendered_states[state] = {"COMPOSITE": composite, **rendered_layers}

    idle = rendered_states["idle"]
    active = rendered_states["keyboard_active"]
    common = sorted(set(idle) & set(active))
    comparisons = {name: difference_score(idle[name], active[name]) for name in common}
    manifest["state_comparisons"] = comparisons

    composite_diff = ImageChops.difference(idle["COMPOSITE"], active["COMPOSITE"])
    amplified = composite_diff.convert("RGB").point(lambda value: min(255, value * 4))
    amplified.save(OUT / "idle-vs-active-difference-x4.png")

    runtime_assets = build_runtime_assets(idle, active)
    RUNTIME_OUT.mkdir(parents=True, exist_ok=True)
    runtime_names = {
        "topwear": "t004-topwear.png",
        "objects_base": "t004-objects-base.png",
        "mouse_group": "t004-mouse-hand-and-device.png",
        "keyboard_idle": "t004-keyboard-hand-idle.png",
        "keyboard_active": "t004-keyboard-arm-active.png",
        "front_hair": "t004-front-hair-unified.png",
    }
    for key, image in runtime_assets.items():
        image.save(RUNTIME_OUT / runtime_names[key], optimize=True)

    runtime_preview = Image.alpha_composite(
        runtime_assets["topwear"], runtime_assets["objects_base"]
    )
    runtime_preview = Image.alpha_composite(
        runtime_preview, runtime_assets["mouse_group"]
    )
    idle_preview = Image.alpha_composite(runtime_preview, runtime_assets["keyboard_idle"])
    active_preview = Image.alpha_composite(runtime_preview, runtime_assets["keyboard_active"])
    idle_preview.save(OUT / "runtime-overlays-idle.png", optimize=True)
    active_preview.save(OUT / "runtime-overlays-keyboard-active.png", optimize=True)
    make_contact_sheet(
        "t004_runtime_assets",
        [(name, image) for name, image in runtime_assets.items()],
        idle_preview,
    ).save(OUT / "runtime-assets-contact-sheet.png", optimize=True)
    manifest["runtime_assets"] = {
        key: {
            "path": str((RUNTIME_OUT / runtime_names[key]).relative_to(ROOT)),
            **alpha_stats(image),
        }
        for key, image in runtime_assets.items()
    }

    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
