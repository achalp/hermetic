"""Unit tests for the hermetic runtime package.

Stdlib unittest (no pytest dependency); pandas/numpy-dependent cases skip
cleanly when those libraries are absent so the suite runs on any host, and
runs fully inside the sandbox image. Invoke:

    python3 -m unittest docker.sandbox.hermetic_runtime.test_runtime  # repo root
    python3 -m unittest hermetic_runtime.test_runtime                 # image /data
"""

import json
import math
import os
import tempfile
import textwrap
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

from . import findings, guards
from .coerce import safe_float, safe_int, to_native
from .findings import (
    declare_finding,
    finding_decompose,
    finding_heterogeneity,
    finding_step_change,
    finding_trend,
)
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
        guards.set_strategy_hint("")

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

    def test_base_message_is_domain_neutral_and_skill_hint_appends(self):
        guards.configure(1024**3)
        with self.assertRaises(MemoryError) as ctx:
            guards.assert_fits(10**9)
        self.assertNotIn("PLANET-SCALE", str(ctx.exception))  # no baked-in geo recipe
        guards.set_strategy_hint(" Follow the PLANET-SCALE recipe.")
        self.assertEqual(guards.get_strategy_hint(), " Follow the PLANET-SCALE recipe.")
        with self.assertRaises(MemoryError) as ctx2:
            guards.assert_fits(10**9)
        self.assertIn("PLANET-SCALE recipe", str(ctx2.exception))


class TestWriteOutput(unittest.TestCase):
    def setUp(self):
        findings.reset_findings()  # leftover declarations must not leak in

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
            self.assertEqual(out["findings"], [])
            written = json.load(open(f.name))
            self.assertEqual(
                set(written), {"results", "chart_data", "datasets", "images", "findings"}
            )


class TestDeclareFinding(unittest.TestCase):
    """declare_finding contract (specs/declared-findings-2026-08-06.md §2)."""

    def setUp(self):
        findings.reset_findings()
        self.dir = tempfile.mkdtemp(prefix="hermetic-findings-")
        self.sidecar = os.path.join(self.dir, "findings.jsonl")
        patcher = mock.patch.object(findings, "SIDECAR_PATH", self.sidecar)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(findings.reset_findings)

    def _sidecar_lines(self):
        if not os.path.exists(self.sidecar):
            return []
        with open(self.sidecar) as f:
            return [json.loads(line) for line in f.read().splitlines() if line]

    def test_registry_append_and_write_output_inclusion(self):
        entry = declare_finding(
            "churn_trend",
            {"direction": "rising", "slope": 0.4},
            definition="direction of monthly_churn_rate over the months",
            dtype="direction",
            unit="pp",
            derived_from_columns=["monthly_churn_rate"],
            tags=["trend"],
        )
        # Field names are the FindingEntry contract — snake_case, exact.
        self.assertEqual(entry["name"], "churn_trend")
        self.assertEqual(entry["derived_from_columns"], ["monthly_churn_rate"])
        self.assertEqual(entry["unit"], "pp")
        self.assertIn("code_ref", entry)
        self.assertRegex(entry["code_ref"], r"^script\.py:\d+$")
        self.assertEqual(len(findings.get_findings()), 1)
        # One JSONL sidecar line per declaration, parseable independently.
        lines = self._sidecar_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["name"], "churn_trend")
        # write_output includes the registry with NO findings argument.
        real_open = open
        with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
            redirect = lambda p, m="r", **kw: real_open(f.name, m, **kw)  # noqa: E731
            with mock.patch("builtins.open", side_effect=redirect):
                out = write_output(results={"ok": 1})
            self.assertEqual(len(out["findings"]), 1)
            self.assertEqual(out["findings"][0]["name"], "churn_trend")
            written = json.load(open(f.name))
            self.assertEqual(written["findings"][0]["dtype"], "direction")

    def test_explicit_findings_kwarg_overrides_registry(self):
        declare_finding("ignored", 1, definition="mean of the x column", dtype="scalar")
        real_open = open
        with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
            redirect = lambda p, m="r", **kw: real_open(f.name, m, **kw)  # noqa: E731
            with mock.patch("builtins.open", side_effect=redirect):
                out = write_output(findings=[{"name": "explicit", "value": 2}])
            self.assertEqual([e["name"] for e in out["findings"]], ["explicit"])

    def test_never_raises_on_garbage(self):
        # A metadata feature must never kill an analysis: garbage everywhere.
        declare_finding(object(), object(), definition=None, dtype=None)
        declare_finding(None, float("inf"), definition=None, dtype=None, tags=object())
        declare_finding("x", {1, 2}, definition=None, dtype=None, derived_from_findings=123)
        self.assertIsInstance(findings.get_findings(), list)  # got here — nothing raised

    def test_nan_value_coerced_at_declaration_time(self):
        entry = declare_finding(
            "nan_metric", float("nan"), definition="mean of the value column", dtype="scalar"
        )
        self.assertIsNone(entry["value"])
        # The whole point: an un-coerced NaN would trip write_output's
        # allow_nan=False and crash the run at the very end.
        real_open = open
        with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
            redirect = lambda p, m="r", **kw: real_open(f.name, m, **kw)  # noqa: E731
            with mock.patch("builtins.open", side_effect=redirect):
                out = write_output()
            self.assertIsNone(out["findings"][0]["value"])
            json.load(open(f.name))  # strict-parses

    @unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
    def test_numpy_values_coerced(self):
        import numpy as np

        entry = declare_finding(
            "np_metric",
            {"mean": np.float64("nan"), "n": np.int64(7)},
            definition="mean of the value column",
            dtype="scalar",
        )
        self.assertIsNone(entry["value"]["mean"])
        self.assertEqual(entry["value"]["n"], 7)

    def test_literal_rule_drops_fstring_definition(self):
        # Spec §2.2: f"...{delta}..." walks computed values through the
        # metadata wall. The script must be a REAL file so ast/linecache can
        # read the call site — exactly how generated scripts execute.
        src = textwrap.dedent(
            """
            value = 4.2
            declare_finding("spiky", value,
                definition=f"August spike of {value:.1f}pp",
                dtype="scalar")
            """
        )
        path = os.path.join(self.dir, "gen_script.py")
        with open(path, "w") as f:
            f.write(src)
        exec(compile(src, path, "exec"), {"declare_finding": declare_finding})
        self.assertEqual(findings.get_findings(), [])  # dropped, not registered
        dropped = [ln for ln in self._sidecar_lines() if ln.get("__dropped__")]
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["name"], "spiky")
        self.assertEqual(dropped[0]["reason"], "literal_rule: definition")

    def test_literal_rule_fails_open_without_source(self):
        # Unreadable source (no file behind the filename) → accept: this is
        # defense in depth, the host scrubs at the composer boundary too.
        src = "declare_finding('blind', 1.0, definition='mean of x', dtype='scalar')\n"
        exec(compile(src, "<no-such-file>", "exec"), {"declare_finding": declare_finding})
        self.assertEqual(len(findings.get_findings()), 1)

    def test_code_ref_subtracts_prelude_offset(self):
        # The host prepends a ~500-line prelude which self-measures its line
        # count into _HERMETIC_PRELUDE_LINES; code_ref must be relative to the
        # GENERATED code (spec §2.4). Call site at raw line 5, offset 3 → 2.
        src = "\n\n\n\ndeclare_finding('ref_probe', 1.0, definition='ref over the x column', dtype='scalar')\n"
        exec(
            compile(src, "<gen-offset>", "exec"),
            {"declare_finding": declare_finding, "_HERMETIC_PRELUDE_LINES": 3},
        )
        self.assertEqual(findings.get_findings()[0]["code_ref"], "script.py:2")

    def test_code_ref_clamps_at_one_and_survives_missing_offset(self):
        src = "declare_finding('clamped', 1.0, definition='ref over the x column', dtype='scalar')\n"
        exec(
            compile(src, "<gen-clamp>", "exec"),
            {"declare_finding": declare_finding, "_HERMETIC_PRELUDE_LINES": 50},
        )
        self.assertEqual(findings.get_findings()[0]["code_ref"], "script.py:1")
        # No offset global (bare exec / host tests): raw lineno, still useful.
        exec(compile(src, "<gen-raw>", "exec"), {"declare_finding": declare_finding})
        self.assertEqual(findings.get_findings()[1]["code_ref"], "script.py:1")

    def test_no_dedupe_collisions_kept_in_order(self):
        # Last-wins + redeclarations counting is HOST-side (spec §2.3); the
        # helper keeps every line in order.
        declare_finding("dup", 1, definition="mean of the x column", dtype="scalar")
        declare_finding("dup", 2, definition="mean of the x column", dtype="scalar")
        self.assertEqual([e["value"] for e in findings.get_findings()], [1, 2])


class TestFindingStatHelpers(unittest.TestCase):
    """The optional helper library — small, never-raise, dict-returning."""

    def test_trend_rising_on_known_series(self):
        out = finding_trend([1.0, 2.1, 2.9, 4.2, 5.1, 5.8, 7.2, 8.1])
        self.assertEqual(out["direction"], "rising")
        self.assertLess(out["p_value"], 0.05)
        self.assertAlmostEqual(out["slope_per_period"], 1.0, delta=0.2)

    def test_trend_falling_and_flat(self):
        self.assertEqual(finding_trend([9.0, 7.2, 5.9, 4.1, 3.0, 1.2])["direction"], "falling")
        flat = finding_trend([5.0, 5.1, 4.9, 5.05, 4.95, 5.02])
        self.assertEqual(flat["direction"], "flat")
        self.assertGreaterEqual(flat["p_value"], 0.05)

    def test_trend_never_raises_on_garbage(self):
        self.assertIsNone(finding_trend(["a", None, object()])["direction"])
        self.assertIsNone(finding_trend([1.0, 2.0])["direction"])  # too short for a p
        self.assertIsNone(finding_trend(None)["direction"])

    def test_step_change_direction_down_on_persistent_decline(self):
        out = finding_step_change([50.0, 50.5, 49.8, 50.2, 20.0, 19.5, 20.3, 19.8])
        self.assertEqual(out["period"], 4)
        self.assertEqual(out["direction"], "down")
        self.assertLess(out["delta"], 0)

    def test_step_change_suppressed_on_oscillating_series(self):
        # The covid-wave misfit: a stand-out drop (passes the 3x-spread
        # magnitude gate) followed by recovery ABOVE the break is a wave, not
        # a regime change — the persistence gate must return no step.
        # deltas: 0.5, -0.7, 0.4, -30.2, 28, 4, 3 -> median |d| = 3, so the
        # -30.2 drop is a 10x-spread "step"; but post values [20, 48, 52, 55]
        # re-cross the midpoint (35.1) — only 1/4 stay below.
        out = finding_step_change([50.0, 50.5, 49.8, 50.2, 20.0, 48.0, 52.0, 55.0])
        self.assertIsNone(out["period"])
        self.assertIsNone(out["delta"])
        self.assertIsNone(out["direction"])
        self.assertIsNotNone(out["baseline_spread"])

    def test_step_change_at_known_index(self):
        labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"]
        out = finding_step_change([10.0, 10.2, 9.9, 10.1, 15.0, 15.2, 14.9], labels=labels)
        self.assertEqual(out["period"], "May")
        self.assertAlmostEqual(out["delta"], 4.9, delta=0.01)
        self.assertLess(out["baseline_spread"], 1.0)
        # Without labels: the index of the first value AFTER the jump.
        self.assertEqual(finding_step_change([10.0, 10.2, 9.9, 10.1, 15.0, 15.2, 14.9])["period"], 4)

    def test_step_change_none_on_smooth_ramp(self):
        out = finding_step_change([1.0, 2.0, 3.0, 4.0, 5.0])
        self.assertIsNone(out["period"])
        self.assertIsNone(out["delta"])
        self.assertIsNone(finding_step_change([])["period"])  # never raises

    def test_decompose_dominant_and_residual(self):
        out = finding_decompose(10.0, {"rate": 7.0, "volume": 2.0})
        self.assertEqual(out["dominant"], "rate")
        self.assertAlmostEqual(out["residual"], 1.0)
        self.assertEqual(out["rate"], 7.0)  # terms pass through
        self.assertIsNone(finding_decompose("x", "not-terms")["dominant"])  # never raises

    def test_heterogeneity_significant_on_clearly_different_groups(self):
        out = finding_heterogeneity(
            {"a": [1.0, 1.1, 0.9, 1.05, 0.95], "b": [5.0, 5.1, 4.9, 5.05, 4.95]}
        )
        self.assertEqual(out["test"], "anova")
        self.assertTrue(out["significant"])
        self.assertLess(out["p_value"], 0.001)

    def test_heterogeneity_degenerate_and_similar_groups(self):
        self.assertIsNone(finding_heterogeneity({"only": [1.0, 2.0]})["significant"])
        self.assertIsNone(finding_heterogeneity(None)["significant"])  # never raises
        same = finding_heterogeneity(
            {"a": [1.0, 1.4, 0.8, 1.2, 0.9], "b": [1.1, 0.9, 1.3, 1.0, 0.85]}
        )
        self.assertFalse(same["significant"])


class TestImportPurity(unittest.TestCase):
    def test_package_import_has_no_heavy_side_effects(self):
        # The prelude imports this before user code; module import must never
        # require pandas/numpy or touch the filesystem. Import under whichever
        # name THIS run used (bare 'hermetic_runtime' in the image /data,
        # 'docker.sandbox.hermetic_runtime' from the repo root) — the docstring
        # documents both invocations.
        import importlib

        hermetic_runtime = importlib.import_module(__package__)

        self.assertTrue(callable(hermetic_runtime.write_output))
        self.assertTrue(callable(hermetic_runtime.declare_finding))
        self.assertTrue(math.isfinite(1.0))  # trivially true; anchors the import above


if __name__ == "__main__":
    unittest.main()
