import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import compare_overlay
import inspect_rgba


class ImageQATests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, name, array):
        path = self.root / name
        Image.fromarray(np.asarray(array, dtype=np.uint8), "RGBA").save(path)
        return path

    def digest(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_inspect_bright_skin_is_opaque_and_alpha_summary_is_correct(self):
        pixels = np.zeros((3, 4, 4), dtype=np.uint8)
        pixels[1, 1] = [255, 220, 185, 255]
        pixels[1, 2] = [230, 180, 160, 64]
        path = self.save("skin.png", pixels)
        _, report = inspect_rgba.inspect(path)
        self.assertEqual(report["alpha_bbox_xyxy_exclusive"], [1, 1, 3, 2])
        self.assertEqual(report["alpha_pixels"], {"transparent": 10, "partial": 1, "opaque": 1})

    def test_fully_transparent_rgb_changes_have_zero_visible_premultiplied_delta(self):
        src = np.zeros((1, 2, 4), dtype=np.uint8)
        cand = src.copy()
        src[0, 0] = [1, 2, 3, 0]
        cand[0, 0] = [250, 170, 99, 0]
        cand[0, 1] = [0, 0, 0, 0]
        a, b = self.save("a.png", src), self.save("b.png", cand)
        _, report = inspect_rgba.inspect(b, source=a)
        comparison = report["source_comparison_same_frame"]["alpha_outside_rgb_changes"]
        self.assertEqual(comparison["raw_rgb_changed_pixels_with_both_alpha_zero"], 1)
        self.assertEqual(comparison["max_premultiplied_rgb_delta_0_255"], 0)

    def test_inspect_premultiplied_delta_handles_opaque_white_without_overflow(self):
        src = np.array([[[255, 255, 255, 255]]], dtype=np.uint8)
        cand = np.array([[[0, 0, 0, 0]]], dtype=np.uint8)
        a, b = self.save("opaque-white.png", src), self.save("transparent-black.png", cand)

        _, report = inspect_rgba.inspect(b, source=a)

        comparison = report["source_comparison_same_frame"]["alpha_outside_rgb_changes"]
        self.assertEqual(comparison["max_premultiplied_rgb_delta_0_255"], 255)

    def test_overlay_premultiplied_delta_handles_opaque_white_without_overflow(self):
        src = self.save("overlay-opaque-white.png", np.array([[[255, 255, 255, 255]]], dtype=np.uint8))
        cand = self.save("overlay-transparent-black.png", np.array([[[0, 0, 0, 0]]], dtype=np.uint8))

        report = compare_overlay.compare(src, cand, self.root / "white-vs-transparent",
                                         {"scale": 1, "tx": 0, "ty": 0}, [], [255, 255, 255])

        self.assertEqual(report["metrics_per_roi"]["full"]["premultiplied_rgb_max_delta_0_255"], 255)

    def test_compositing_semitransparent_pixel_uses_selected_background(self):
        rgba = np.array([[[200, 100, 0, 128]]], dtype=np.uint8)
        result = compare_overlay.composite(rgba, [0, 0, 255])
        np.testing.assert_array_equal(result[0, 0], [100, 50, 127])

    def test_identity_comparison_has_zero_difference_and_preserves_input_hashes(self):
        arr = np.zeros((8, 9, 4), dtype=np.uint8)
        arr[2:5, 3:6] = [42, 150, 210, 255]
        src, cand = self.save("source.png", arr), self.save("candidate.png", arr.copy())
        before = (self.digest(src), self.digest(cand))
        report = compare_overlay.compare(src, cand, self.root / "qa", {"scale": 1, "tx": 0, "ty": 0}, [], [255, 255, 255])
        self.assertEqual(report["metrics_per_roi"]["full"]["composited_rgb_mae_0_255"], 0)
        self.assertEqual((self.digest(src), self.digest(cand)), before)
        for filename in ("aligned.png", "overlay_50.png", "diff_heatmap.png", "side_by_side.png", "metrics.json"):
            self.assertTrue((self.root / "qa" / filename).is_file())

    def test_one_fixed_translation_aligns_face_and_target_regions(self):
        # Two unrelated landmarks move together. A single frame transform aligns both.
        src_array = np.zeros((10, 15, 4), dtype=np.uint8)
        src_array[2:4, 2:4] = [255, 30, 30, 255]  # face anchor
        src_array[6:8, 10:12] = [20, 40, 255, 255]  # target anchor
        cand_array = np.zeros((12, 18, 4), dtype=np.uint8)
        cand_array[4:6, 5:7] = src_array[2:4, 2:4]  # scale=1, tx=3, ty=2
        cand_array[8:10, 13:15] = src_array[6:8, 10:12]
        src, cand = self.save("face-source.png", src_array), self.save("face-candidate.png", cand_array)
        report = compare_overlay.compare(src, cand, self.root / "fixed-frame", {"scale": 1, "tx": 3, "ty": 2},
                                         [(2, 2, 2, 2), (10, 6, 2, 2)], [255, 255, 255])
        self.assertEqual(report["metrics_per_roi"]["roi_1"]["composited_rgb_mae_0_255"], 0)
        self.assertEqual(report["metrics_per_roi"]["roi_2"]["composited_rgb_mae_0_255"], 0)
        self.assertEqual(report["frame"]["candidateWorldFromSource"], {"scale": 1, "tx": 3, "ty": 2})


if __name__ == "__main__":
    unittest.main()
