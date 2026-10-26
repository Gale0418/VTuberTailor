#!/usr/bin/env python3
"""Compare two fixed-frame RGBA images using an explicit similarity transform."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

from inspect_rgba import parse_roi


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_transform(raw):
    if raw is None:
        return {"scale": 1.0, "tx": 0.0, "ty": 0.0}
    try:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = json.loads(Path(raw).read_text(encoding="utf-8"))
        t = {"scale": float(data["scale"]), "tx": float(data.get("tx", 0)), "ty": float(data.get("ty", 0))}
        if not np.isfinite(list(t.values())).all() or t["scale"] <= 0:
            raise ValueError("scale 必須為有限正數，tx/ty 必須為有限數")
        return t
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
        raise ValueError(f"無法讀取 transform；需要 JSON {{scale, tx, ty}}：{e}")


def composite(rgba, bg):
    a = rgba[:, :, 3:4].astype(np.float32) / 255.0
    return np.rint(rgba[:, :, :3].astype(np.float32) * a + np.asarray(bg, dtype=np.float32) * (1-a)).astype(np.uint8)


def align_candidate(candidate, source_size, transform):
    scale, tx, ty = transform["scale"], transform["tx"], transform["ty"]
    # candidateWorldFromSource maps source pixel coordinates to candidate coordinates.
    # PIL asks for output(source-frame) -> input(candidate) coordinates. The
    # declared mapping directly supplies those candidate coordinates.
    mapping = (scale, 0, tx, 0, scale, ty)
    return candidate.transform(source_size, Image.Transform.AFFINE, mapping, resample=Image.Resampling.BICUBIC)


def parse_bg(raw):
    try:
        values = [int(v) for v in raw.split(",")]
        if len(values) != 3 or any(v < 0 or v > 255 for v in values):
            raise ValueError()
        return values
    except ValueError:
        raise argparse.ArgumentTypeError("背景格式需為 R,G,B，每值 0..255")


def compare(source_path, candidate_path, outdir, transform, rois, bg):
    src_img = Image.open(source_path).convert("RGBA")
    cand_img = Image.open(candidate_path).convert("RGBA")
    src = np.asarray(src_img)
    aligned_img = align_candidate(cand_img, src_img.size, transform)
    cand = np.asarray(aligned_img)
    src_rgb = composite(src, bg).astype(np.int16)
    cand_rgb = composite(cand, bg).astype(np.int16)
    diff = np.abs(src_rgb - cand_rgb)
    # Premultiplied delta ignores arbitrary RGB stored under alpha=0.
    premult = np.abs(src[:, :, :3].astype(np.int32) * src[:, :, 3:4].astype(np.int32) -
                     cand[:, :, :3].astype(np.int32) * cand[:, :, 3:4].astype(np.int32)) / 255.0
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    aligned_img.save(out / "aligned.png")
    overlay = np.rint((src_rgb.astype(np.float32) + cand_rgb.astype(np.float32)) / 2).astype(np.uint8)
    Image.fromarray(overlay, "RGB").save(out / "overlay_50.png")
    heat = np.clip(diff.max(axis=2) * 4, 0, 255).astype(np.uint8)
    heat_rgb = np.zeros((*heat.shape, 3), dtype=np.uint8)
    heat_rgb[:, :, 0] = heat
    heat_rgb[:, :, 1] = np.clip(heat.astype(np.int16) - 64, 0, 255).astype(np.uint8)
    Image.fromarray(heat_rgb, "RGB").save(out / "diff_heatmap.png")
    side = np.concatenate((src_rgb.astype(np.uint8), cand_rgb.astype(np.uint8)), axis=1)
    Image.fromarray(side, "RGB").save(out / "side_by_side.png")

    regions = [("full", (0, 0, src_img.width, src_img.height))] + [(f"roi_{i+1}", r) for i, r in enumerate(rois)]
    metrics = {}
    for name, (x, y, w, h) in regions:
        if x < 0 or y < 0 or x + w > src_img.width or y + h > src_img.height:
            raise ValueError(f"{name} ROI 超出 source frame: {(x,y,w,h)}")
        sl = np.s_[y:y+h, x:x+w]
        d = diff[sl]
        pd = premult[sl]
        ad = np.abs(src[sl][..., 3].astype(np.int16) - cand[sl][..., 3].astype(np.int16))
        metrics[name] = {
            "roi_xywh": [x, y, w, h], "pixels": int(w*h),
            "composited_rgb_mae_0_255": float(d.mean()),
            "composited_rgb_max_delta_0_255": int(d.max(initial=0)),
            "premultiplied_rgb_max_delta_0_255": float(pd.max(initial=0)),
            "alpha_mae_0_255": float(ad.mean()),
        }
    report = {
        "frame": {"coordinate_space": "source pixel frame", "width": src_img.width, "height": src_img.height,
                  "candidateWorldFromSource": transform,
                  "mapping": "candidate_x = scale*source_x + tx; candidate_y = scale*source_y + ty"},
        "inputs": {"source": {"path": str(Path(source_path).resolve()), "sha256": sha256(source_path), "size": list(src_img.size)},
                   "candidate": {"path": str(Path(candidate_path).resolve()), "sha256": sha256(candidate_path), "size": list(cand_img.size)}},
        "background_rgb": bg,
        "outputs": {name: str((out / name).resolve()) for name in ("aligned.png", "overlay_50.png", "diff_heatmap.png", "side_by_side.png")},
        "metrics_per_roi": metrics,
        "limitations": ["僅套用使用者提供的單一 similarity transform；不做自動配準或局部獨立變形。",
                        "ROI 僅用於視覺分析，不會修改 source 或 candidate。",
                        "RGB 組合差異以指定不透明背景合成後計算；premultiplied RGB 指標忽略 alpha=0 像素的任意 RGB。",
                        "此工具產生 QA PNG，不會寫入或修改任何輸入 production asset。"],
    }
    (out / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="以固定 source frame 與明確 similarity transform 產生 QA 疊圖和差異指標。")
    p.add_argument("source", help="source RGBA image")
    p.add_argument("candidate", help="candidate RGBA image")
    p.add_argument("--out", required=True, help="QA 輸出目錄")
    p.add_argument("--transform", help="JSON 字串或 UTF-8 JSON 檔，欄位 scale/tx/ty")
    p.add_argument("--scale", type=float)
    p.add_argument("--tx", type=float)
    p.add_argument("--ty", type=float)
    p.add_argument("--roi", type=parse_roi, action="append", default=[], help="source frame ROI x,y,width,height；可重複指定")
    p.add_argument("--background", type=parse_bg, default=[255,255,255], help="合成背景 R,G,B，預設 255,255,255")
    args = p.parse_args()
    try:
        flags = (args.scale, args.tx, args.ty)
        if args.transform and any(v is not None for v in flags):
            raise ValueError("--transform 不可和 --scale/--tx/--ty 混用")
        if not args.transform and any(v is not None for v in flags):
            if any(v is None for v in flags):
                raise ValueError("使用 --scale/--tx/--ty 時三者都必須提供")
            transform = {"scale": args.scale, "tx": args.tx, "ty": args.ty}
            if not np.isfinite(list(transform.values())).all() or args.scale <= 0:
                raise ValueError("scale 必須為有限正數，tx/ty 必須為有限數")
        else:
            transform = read_transform(args.transform)
        report = compare(args.source, args.candidate, args.out, transform, args.roi, args.background)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
