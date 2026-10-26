#!/usr/bin/env python3
"""Read-only RGBA image inspection helpers for visual QA."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def islands(alpha):
    # Run-length connected components avoid a Python queue operation per pixel,
    # which becomes painfully slow for the large solid regions common in art.
    parent, sizes = [], []

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        a, b = root(a), root(b)
        if a != b:
            parent[b] = a
            sizes[a] += sizes[b]
            sizes[b] = 0

    previous = []
    for row in (alpha > 0):
        edges = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        current = []
        prev_index = 0
        for start, end in zip(starts.tolist(), ends.tolist()):
            label = len(parent)
            parent.append(label)
            sizes.append(end - start)
            while prev_index < len(previous) and previous[prev_index][1] < start:
                prev_index += 1
            j = prev_index
            while j < len(previous) and previous[j][0] <= end:
                union(label, previous[j][2])
                j += 1
            current.append((start, end, label))
        previous = current
    return [size for size in sizes if size]


def parse_roi(value):
    try:
        x, y, w, h = [int(v) for v in value.split(",")]
        if w <= 0 or h <= 0:
            raise ValueError()
        return x, y, w, h
    except (ValueError, AttributeError):
        raise argparse.ArgumentTypeError("ROI 格式需為 x,y,width,height 且寬高為正數")


def inspect(path, roi=None, source=None):
    image = Image.open(path).convert("RGBA")
    a = np.asarray(image)[:, :, 3]
    ys, xs = np.nonzero(a)
    box = None if not len(xs) else [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
    sizes = islands(a)
    result = {
        "path": str(Path(path).resolve()), "sha256": sha256(path),
        "size": {"width": image.width, "height": image.height},
        "alpha_bbox_xyxy_exclusive": box,
        "alpha_pixels": {"transparent": int(np.count_nonzero(a == 0)),
                         "partial": int(np.count_nonzero((a > 0) & (a < 255))),
                         "opaque": int(np.count_nonzero(a == 255))},
        "connected_alpha_islands_8_connected": {
            "count": len(sizes), "largest_pixel_counts": sorted(sizes, reverse=True)[:10],
            "note": "摘要僅供定位；島數本身不是瑕疵判定。"},
    }
    if roi:
        x, y, w, h = roi
        result["roi"] = {"requested_xywh": list(roi), "inside_image": x >= 0 and y >= 0 and x + w <= image.width and y + h <= image.height,
                         "alpha_pixels": int(np.count_nonzero(a[max(0,y):min(image.height,y+h), max(0,x):min(image.width,x+w)]))}
    if source:
        ref = Image.open(source).convert("RGBA")
        if ref.size != image.size:
            raise ValueError("source comparison requires identical dimensions and pixel coordinates")
        s = np.asarray(ref).astype(np.int16)
        c = np.asarray(image).astype(np.int16)
        outside = (s[:, :, 3] == 0) & (c[:, :, 3] == 0)
        # RGB under fully transparent pixels has no visible contribution.
        premult_delta = np.abs(s[:, :, :3] * s[:, :, 3:4] - c[:, :, :3] * c[:, :, 3:4]) / 255.0
        result["source_comparison_same_frame"] = {
            "source_path": str(Path(source).resolve()), "source_sha256": sha256(source),
            "alpha_outside_rgb_changes": {
                "both_fully_transparent_pixels": int(outside.sum()),
                "raw_rgb_changed_pixels_with_both_alpha_zero": int(np.count_nonzero(outside & np.any(s[:, :, :3] != c[:, :, :3], axis=2))),
                "max_premultiplied_rgb_delta_0_255": float(premult_delta.max(initial=0)),
                "note": "完全透明像素的原始 RGB 差異不具可見性；以 RGB×alpha 計算可見差異。"}}
    return image, result


def make_panels(image, roi, path):
    if roi is None:
        raise ValueError("輸出 panels 時必須同時提供 --roi")
    x, y, w, h = roi
    crop = image.crop((x, y, x + w, y + h))
    panels = []
    for color in ((255,255,255), (32,32,32)):
        bg = Image.new("RGBA", crop.size, (*color, 255))
        panels.append(Image.alpha_composite(bg, crop).convert("RGB").resize((w*2, h*2), Image.Resampling.NEAREST))
    source = crop.convert("RGB").resize((w*2, h*2), Image.Resampling.NEAREST)
    out = Image.new("RGB", (w*6, h*2))
    for i, panel in enumerate((source, *panels)):
        out.paste(panel, (i*w*2, 0))
    out.save(path)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="唯讀檢查 RGBA alpha、ROI 與來源比較；JSON 輸出至 stdout。")
    p.add_argument("image", help="輸入 PNG 或 Pillow 可讀影像")
    p.add_argument("--roi", type=parse_roi, help="x,y,width,height ROI")
    p.add_argument("--panels", help="輸出 source/白底/深底 200%% nearest-neighbor panels PNG")
    p.add_argument("--source", help="同尺寸、同座標 source，用於 RGB/alpha QA 分析")
    args = p.parse_args()
    try:
        img, report = inspect(args.image, args.roi, args.source)
        if args.panels:
            make_panels(img, args.roi, args.panels)
            report["panels_path"] = str(Path(args.panels).resolve())
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
