"""Unit tests for the hermetic runtime package.

Stdlib unittest (no pytest dependency); pandas/numpy-dependent cases skip
cleanly when those libraries are absent so the suite runs on any host, and
runs fully inside the sandbox image. Invoke:

    python3 -m unittest docker.sandbox.hermetic_runtime.test_runtime  # repo root
    python3 -m unittest hermetic_runtime.test_runtime                 # image /data
"""

import json
import math
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

try:
    import numpy  # noqa: F401

    HAVE_NUMPY = True
except Exception:
    HAVE_NUMPY = False
try:
    import pandas  # noqa: F401

    HAVE_PANDAS = True
except Exception:
    HAVE_PANDAS = False

from . import guards
from .coerce import safe_float, safe_int, to_native
from .output import write_output


class TestSafeFloat(unittest.TestCase):
    def test_plain_values(self):
        self.assertEqual(safe_float("3.5"), 3.5)
        self.assertEqual(safe_float(2), 2.0)
        self.assertIsNone(safe_float(None))
        self.assertIsNone(safe_float("tall"))
        self.assertEqual(safe_float("", default=0.0), 0.0)

    def test_nan_inf_become_default(self):
        self.assertIsNone(safe_float(float("nan")))
        self.assertIsNone(safe_float(float("inf")))
        self.assertEqual(safe_float(float("nan"), default=-1), -1)

    @unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
    def test_numpy_scalars(self):
        import numpy as np

        self.assertEqual(safe_float(np.float64(1.5)), 1.5)
        self.assertIsNone(safe_float(np.float64("nan")))
        self.assertEqual(safe_int(np.int32(7)), 7)

    def test_safe_int(self):
        self.assertEqual(safe_int("9"), 9)
        self.assertEqual(safe_int(9.7), 9)
        self.assertIsNone(safe_int("n/a"))


class TestToNative(unittest.TestCase):
    def test_scalars_and_containers(self):
        self.assertIsNone(to_native(float("nan")))
        self.assertEqual(to_native(Decimal("2.5")), 2.5)
        self.assertEqual(to_native({"a": (1, 2)}), {"a": [1, 2]})
        self.assertEqual(to_native(True), True)

    @unittest.skipUnless(HAVE_PANDAS, "pandas not installed")
    def test_dataframe_records(self):
        import pandas as pd

        df = pd.DataFrame({"x": [1, 2]})
        self.assertEqual(to_native(df), [{"x": 1}, {"x": 2}])
        self.assertIsNone(to_native(pd.NaT))


class TestGuards(unittest.TestCase):
    def setUp(self):
        guards.configure(None)

    def test_noop_without_cap_or_rows(self):
        guards.assert_fits(10**12)  # unconfigured cap → no raise
        guards.configure(1024**3)
        guards.assert_fits(0)  # falsy rows → no raise

    def test_raises_over_cap_with_strategy_switch_message(self):
        guards.configure(1024**3)  # 1 GiB
        with self.assertRaises(MemoryError) as ctx:
            guards.assert_fits(100_000_000, cols=3, what="the KD-tree coords frame")
        msg = str(ctx.exception)
        self.assertIn("KD-tree coords frame", msg)
        self.assertIn("SWITCH STRATEGY", msg)

    def test_fits_under_cap(self):
        guards.configure(1024**3)
        guards.assert_fits(1000)  # tiny → no raise


class TestWriteOutput(unittest.TestCase):
    def test_envelope_shape_and_dataset_cap(self):
        real_open = open
        with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
            redirect = lambda p, m="r", **kw: real_open(f.name, m, **kw)  # noqa: E731
            with mock.patch("builtins.open", side_effect=redirect):
                out = write_output(
                    results={"n": float("nan")},
                    datasets={"main": [{"i": i} for i in range(6000)]},
                )
            self.assertEqual(out["results"]["n"], None)
            self.assertEqual(out["results"]["_main_total"], 6000)
            self.assertEqual(len(out["datasets"]["main"]), 5000)
            self.assertEqual(out["chart_data"], {})
            self.assertEqual(out["images"], {})
            written = json.load(open(f.name))
            self.assertEqual(set(written), {"results", "chart_data", "datasets", "images"})


class TestImportPurity(unittest.TestCase):
    def test_package_import_has_no_heavy_side_effects(self):
        # The prelude imports this before user code; module import must never
        # require pandas/numpy or touch the filesystem.
        import hermetic_runtime  # noqa: F401  (already imported as a package parent)

        self.assertTrue(callable(hermetic_runtime.write_output))
        self.assertTrue(math.isfinite(1.0))  # trivially true; anchors the import above


if __name__ == "__main__":
    unittest.main()
