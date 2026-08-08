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

from . import findings, guards, series
from .coerce import safe_float, safe_int, to_native
from .checks import declare_check
from .findings import (
    declare_finding,
    finding_decompose,
    finding_heterogeneity,
    finding_step_change,
    finding_current_state,
    finding_yoy,
    finding_split_comparison,
    finding_superlative,
    finding_outliers,
    finding_correlation,
    finding_distribution,
    finding_share,
    finding_trend,
)
from .output import write_output
from .series import declare_series, declare_value


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
        series.reset_product()

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
                set(written),
                {"results", "chart_data", "datasets", "images", "findings",
                 "series", "values", "data_completeness"},
            )


class TestAnalysisProduct(unittest.TestCase):
    """declare_series/declare_value + synthesis (specs/analysis-product-2026-08-08.md §1)."""

    def setUp(self):
        findings.reset_findings()
        series.reset_product()
        self.dir = tempfile.mkdtemp(prefix="hermetic-product-")
        patcher = mock.patch.object(
            findings, "SIDECAR_PATH", os.path.join(self.dir, "findings.jsonl")
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(findings.reset_findings)
        self.addCleanup(series.reset_product)

    def _write(self, **kw):
        real_open = open
        with tempfile.NamedTemporaryFile("r", suffix=".json") as f:
            redirect = lambda p, m="r", **k: real_open(f.name, m, **k)  # noqa: E731
            with mock.patch("builtins.open", side_effect=redirect):
                return write_output(**kw)

    def test_series_roles_and_chart_synthesis(self):
        rows = [{"year": 1900 + i, "median_price": 1.0 + i, "n": 50 + i} for i in range(3)]
        entry = declare_series(
            "annual_prices",
            rows,
            x=("year", "temporal"),
            measures=[{"column": "median_price", "unit": "usd", "of": "price_trend"}],
            count="n",
        )
        self.assertEqual(entry["roles"]["x"], {"column": "year", "kind": "temporal"})
        self.assertEqual(entry["roles"]["count"], {"column": "n"})
        out = self._write()
        # The legacy view is synthesized — same rows under the series id.
        self.assertEqual(out["chart_data"]["annual_prices"], entry["rows"])
        self.assertEqual(out["series"][0]["id"], "annual_prices")

    def test_series_wins_chart_key_collision(self):
        rows = [{"year": 1900, "v": 1.0}]
        declare_series("s", rows, x=("year", "temporal"), measures=["v"])
        out = self._write(chart_data={"s": [{"stale": True}]})
        self.assertEqual(out["chart_data"]["s"], rows)

    def test_invalid_series_dropped_never_raises(self):
        # Bad x kind, missing column, no valid measures, garbage rows.
        self.assertIsNone(declare_series("a", [{"x": 1}], x=("x", "chronological"), measures=["x"]))
        self.assertIsNone(declare_series("b", [{"x": 1}], x=("y", "ordinal"), measures=["x"]))
        self.assertIsNone(declare_series("c", [{"x": 1}], x=("x", "ordinal"), measures=["nope"]))
        self.assertIsNone(declare_series("d", object(), x=("x", "ordinal"), measures=["x"]))
        self.assertEqual(series.get_series(), [])

    def test_series_rows_capped_with_total(self):
        rows = [{"i": i, "v": float(i)} for i in range(series.ROWS_CAP + 10)]
        entry = declare_series("big", rows, x=("i", "ordinal"), measures=["v"])
        self.assertEqual(len(entry["rows"]), series.ROWS_CAP)
        self.assertEqual(entry["rows_total"], series.ROWS_CAP + 10)

    @unittest.skipUnless(HAVE_PANDAS, "pandas")
    def test_series_accepts_dataframe(self):
        import pandas as pd

        df = pd.DataFrame({"year": [2000, 2001], "v": [1.5, float("nan")]})
        entry = declare_series("df_series", df, x=("year", "temporal"), measures=["v"])
        self.assertEqual(len(entry["rows"]), 2)
        self.assertIsNone(entry["rows"][1]["v"])  # NaN coerced at declaration

    def test_value_context_rule(self):
        # of= or label= is mandatory; non-scalars are dropped.
        self.assertIsNotNone(declare_value("total", 42, label="Total priced listings"))
        self.assertIsNotNone(declare_value("slope", 0.4, of="price_trend.slope_per_period"))
        self.assertIsNone(declare_value("naked", 7))
        self.assertIsNone(declare_value("composite", {"a": 1}, label="not a scalar"))
        self.assertEqual([v["key"] for v in series.get_values()], ["total", "slope"])

    def test_values_and_mirrors_synthesized_into_results(self):
        declare_value("total", 42, label="Total priced listings")
        declare_finding(
            "price_trend",
            {"direction": "rising", "slope_per_period": 0.4, "detail": {"nested": 1}},
            definition="direction of median price over the years",
            dtype="direction",
        )
        out = self._write(results={"authored": 1, "price_trend_direction": "authored-wins"})
        self.assertEqual(out["results"]["total"], 42)
        # Scalar finding fields auto-mirror; authored keys win; non-scalars don't.
        self.assertEqual(out["results"]["price_trend_slope_per_period"], 0.4)
        self.assertEqual(out["results"]["price_trend_direction"], "authored-wins")
        self.assertNotIn("price_trend_detail", out["results"])
        self.assertEqual(out["values"][0]["key"], "total")


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


class TestDeclareCheck(unittest.TestCase):
    def setUp(self):
        findings.reset_findings()

    def test_check_rides_the_findings_registry(self):
        declare_check("grain_check", "country-level totals match joined totals within 2%",
                      passed=True, evidence={"divergence_pct": 0.4}, severity="blocking")
        entries = findings.get_findings()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["dtype"], "check")
        self.assertEqual(e["tags"], ["check", "blocking"])
        self.assertEqual(e["value"], {"passed": True, "divergence_pct": 0.4})

    def test_check_defaults_and_never_raises(self):
        declare_check("weak", "a check with no evidence", passed=False, severity="bogus")
        e = findings.get_findings()[0]
        self.assertEqual(e["tags"], ["check", "caveat"])
        self.assertEqual(e["value"], {"passed": False})
        # Garbage never raises; host-side zod validation drops malformed entries.
        declare_check(None, None, passed=object())
        self.assertGreaterEqual(len(findings.get_findings()), 1)


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

    def test_current_state_excludes_incomplete_tail(self):
        # Reporting-lag artifact: a final day at ~0.5% of the trailing mean
        # must be excluded, not narrated as a 99.8% collapse.
        vals = [300000.0, 320000.0, 340000.0, 360000.0, 348000.0, 350000.0, 1790.0]
        out = finding_current_state(vals, labels=["m1","m2","m3","m4","m5","m6","last_day"])
        self.assertEqual(out["period"], "m6")
        self.assertEqual(out["value"], 350000.0)
        self.assertEqual(out["excluded_trailing"], 1)
        self.assertAlmostEqual(out["pct_from_peak"], (350000.0-360000.0)/360000.0*100, places=1)

    @unittest.skipUnless(HAVE_PANDAS, "pandas not installed on host")
    def test_profile_detects_trailing_coverage_collapse(self):
        import pandas as pd
        from hermetic_runtime.profile import profile_data_edges
        rows = []
        dates = pd.date_range("2021-01-01", periods=60, freq="D")
        for i, d in enumerate(dates):
            n_entities = 3 if i >= 58 else 40  # final two days collapse
            for e in range(n_entities):
                rows.append({"date": d.strftime("%Y-%m-%d"), "loc": "E%d" % e, "cases": 10})
        prof = profile_data_edges(pd.DataFrame(rows))
        self.assertIsNotNone(prof)
        self.assertEqual(prof["time_column"], "date")
        self.assertEqual(prof["entity_column"], "loc")
        self.assertEqual(len(prof["trailing_incomplete"]), 2)
        self.assertEqual(prof["trailing_incomplete"][-1]["coverage"], 3.0)
        self.assertEqual(prof["leading_incomplete"], [])

    @unittest.skipUnless(HAVE_PANDAS, "pandas not installed on host")
    @unittest.skipUnless(HAVE_PANDAS, "pandas not installed on host")
    def test_profile_accepts_integer_year_column(self):
        import pandas as pd
        from hermetic_runtime.profile import profile_data_edges
        rows = []
        for year in range(1851, 1901):
            for e in range(30):
                rows.append({"year": year, "dish": "d%d" % e, "price": 1.0})
        prof = profile_data_edges(pd.DataFrame(rows))
        self.assertIsNotNone(prof)
        self.assertEqual(prof["time_column"], "year")
        self.assertTrue(str(prof["time_min"]).startswith("1851"))

    @unittest.skipUnless(HAVE_PANDAS, "pandas not installed on host")
    def test_profile_returns_none_without_time_column(self):
        import pandas as pd
        from hermetic_runtime.profile import profile_data_edges
        df = pd.DataFrame({"a": range(100), "b": ["x"] * 100})
        self.assertIsNone(profile_data_edges(df))

    def test_outliers_rolling_mad_flags_errors_protects_attested(self):
        labels = [str(1970 + i) for i in range(12)]
        # AGGREGATE series (annual medians) with counts: a spike at a THIN
        # year is flagged; a well-attested modern median is protected.
        meds = [5.0, 6.0, 5.5, 6.2, 6.5, 5.8, 6.2, 38.0, 5.9, 74.0, 5.7, 6.0]
        counts = [400.0] * 7 + [1300.0, 400.0, 52.0, 400.0, 400.0]
        out = finding_outliers(labels, meds, counts=counts, window=8)
        flagged = [o["label"] for o in out["outliers"]]
        self.assertIn("1979", flagged)      # $74 on 52 obs: thin spike
        self.assertNotIn("1977", flagged)   # $38 on 1,300 obs: attested data
        self.assertEqual(out["method"], "rolling_mad")
        # EXTREME series (maxes): counts=None — magnitude alone decides.
        maxes = [5.0, 6.0, 5.5, 30000.0, 6.5, 5.8, 6.2, 7.0, 5.9, 6.1, 5.7, 6.0]
        out2 = finding_outliers(labels, maxes, window=8)
        self.assertIn("1973", [o["label"] for o in out2["outliers"]])

    def test_correlation_fallback_reports_coeffs(self):
        out = finding_correlation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])
        self.assertAlmostEqual(out["pearson_r"], 1.0, places=3)
        self.assertAlmostEqual(out["spearman_rho"], 1.0, places=3)
        self.assertEqual(out["n"], 5)
        self.assertIsNone(finding_correlation([1], [2])["n"])

    def test_distribution_shape_justifies_metric_choice(self):
        skewed = [1.0] * 20 + [1000.0]
        out = finding_distribution(skewed)
        self.assertGreater(out["skew"], 3)
        self.assertGreater(out["mean"], out["median"])
        self.assertEqual(out["n"], 21)

    def test_share_must_account_for_everything(self):
        out = finding_share({"price": 58.0, "volume": 8.3}, total=100.0)
        self.assertEqual(out["sums_to_100"], False)
        self.assertAlmostEqual(out["residual_pct"], 33.7, places=1)
        full = finding_share({"a": 60.0, "b": 40.0})
        self.assertTrue(full["sums_to_100"])

    def test_superlative_is_attestation_weighted(self):
        # Run-39: a 52-item year's $74 must not outrank a 1,217-item year's
        # $45 as the HEADLINE peak — but the raw extreme stays visible.
        labels = ["1996", "2000", "2005", "2012"]
        vals = [74.0, 8.0, 12.0, 45.0]
        counts = [52.0, 400.0, 600.0, 1217.0]
        out = finding_superlative(labels, vals, counts=counts)
        self.assertEqual(out["period"], "2012")
        self.assertEqual(out["value"], 45.0)
        self.assertEqual(out["raw_period"], "1996")
        self.assertEqual(out["raw_value"], 74.0)
        self.assertEqual(out["thin_periods_skipped"], 1)
        self.assertAlmostEqual(out["thin_bar"], 120.0, places=0)  # 20% of median count — the bar is REPORTED, mechanism legible
        # Without counts, the raw extreme wins (nothing to weight by).
        self.assertEqual(finding_superlative(labels, vals)["period"], "1996")

    def test_split_comparison_shared_split_point(self):
        labels = [str(1900 + i) for i in range(10)]
        vals = [1.0] * 10
        a = finding_split_comparison(labels, vals, split_at="1904")
        self.assertEqual(a["early_span"], "1900-1903")
        self.assertEqual(a["late_span"], "1904-1909")
        # A differently-screened series splits at the SAME year.
        vals2 = [1.0, None, 1.0, 1.0, 1.0, 1.0, None, 1.0, 1.0, 1.0]
        b = finding_split_comparison(labels, vals2, split_at="1904")
        self.assertEqual(b["late_span"], "1904-1909")

    def test_split_comparison_pinned_midpoint(self):
        labels = [str(1900 + i) for i in range(10)]
        vals = [1.0, 1.0, 3.0, 1.0, 1.0, 8.0, 8.0, 10.0, 8.0, 8.0]
        out = finding_split_comparison(labels, vals)
        self.assertEqual(out["early_n"], 5)
        self.assertEqual(out["late_n"], 5)
        self.assertEqual(out["early_span"], "1900-1904")
        self.assertEqual(out["late_span"], "1905-1909")
        self.assertEqual(out["multiplier"], 8.0)
        # Nones excluded before splitting; degenerate input all-None.
        self.assertIsNone(finding_split_comparison(["a"], [1.0])["multiplier"])

    def test_yoy_like_for_like_on_partial_year(self):
        # 12 months of 2020 vs 10 of 2021: comparison must restrict to Jan-Oct
        # of BOTH years and record the window for audit.
        labels = ["2020-%02d" % m for m in range(1, 13)] + ["2021-%02d" % m for m in range(1, 11)]
        vals = [100.0] * 12 + [300.0] * 10
        out = finding_yoy(labels, vals)
        self.assertEqual(out["window_months"], list(range(1, 11)))
        self.assertEqual(out["prior_total"], 1000.0)
        self.assertEqual(out["latest_total"], 3000.0)
        self.assertEqual(out["pct_change"], 200.0)

    def test_yoy_sums_daily_grain_and_never_raises(self):
        labels = ["2020-05-01", "2020-05-20", "2021-05-03"]
        out = finding_yoy(labels, [10.0, 5.0, 30.0])
        self.assertEqual(out["window_months"], [5])
        self.assertEqual(out["pct_change"], 100.0)
        self.assertIsNone(finding_yoy(["2021-01"], [5.0])["pct_change"])
        self.assertIsNone(finding_yoy("garbage", None)["pct_change"])

    def test_current_state_direction_reflects_the_endpoint(self):
        # Rising run-up, final collapse: the endpoint is DOWN 77% vs the
        # recent level — direction must be falling, not slope-dominated
        # "rising" (run-32 contradiction with the yoy finding beside it).
        vals = [10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 4.5]
        out = finding_current_state(vals)
        self.assertEqual(out["direction"], "falling")
        rising = finding_current_state([10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 18.0])
        self.assertEqual(rising["direction"], "rising")

    def test_current_state_magnitude_only_walkback_is_capped(self):
        # A genuinely declining series must not be eaten by the stationarity
        # assumption: without coverage evidence, at most 2 trailing periods
        # may be excluded on magnitude alone.
        vals = [100.0, 95.0, 90.0, 80.0, 60.0, 40.0, 20.0, 10.0, 5.0, 2.0, 1.0, 0.5]
        out = finding_current_state(vals)
        self.assertLessEqual(out["excluded_trailing"], 2)
        self.assertIsNotNone(out["value"])

    def test_current_state_coverage_catches_what_magnitude_misses(self):
        # The October case: the incomplete final month is 58% of the trailing
        # mean — above the 30% magnitude bar — but its reporting coverage
        # collapsed. Coverage must exclude it; magnitude alone must not.
        vals = [12.0e6, 14.0e6, 15.0e6, 16.0e6, 14.5e6, 15.5e6, 8.69e6]
        cov = [230.0, 231.0, 229.0, 231.0, 230.0, 228.0, 90.0]
        without = finding_current_state(vals)
        self.assertEqual(without["excluded_trailing"], 0)  # dilution passes the value test
        with_cov = finding_current_state(vals, coverage=cov)
        self.assertEqual(with_cov["excluded_trailing"], 1)
        self.assertEqual(with_cov["value"], 15.5e6)

    def test_current_state_coverage_len_mismatch_falls_back(self):
        vals = [10.0, 11.0, 12.0, 11.5, 12.5, 11.8]
        out = finding_current_state(vals, coverage=[1.0, 2.0])
        self.assertEqual(out["excluded_trailing"], 0)
        self.assertEqual(out["value"], 11.8)

    def test_current_state_clean_edge_and_direction(self):
        vals = [10.0, 20.0, 30.0, 40.0, 35.0, 30.0, 25.0, 20.0]
        out = finding_current_state(vals)
        self.assertEqual(out["period"], 7)
        self.assertEqual(out["excluded_trailing"], 0)
        self.assertEqual(out["direction"], "falling")
        self.assertLess(out["pct_from_peak"], 0)

    def test_current_state_never_raises(self):
        self.assertIsNone(finding_current_state([])["period"])
        self.assertIsNone(finding_current_state([None, None])["period"])
        self.assertIsNone(finding_current_state("garbage")["period"])

    def test_trend_degenerate_gate_all_zero_and_mostly_dropped(self):
        # An all-zero series (zeros that were nulled medians) must NOT be
        # labeled "flat" — slope 0 / p 1 is a regression that never ran.
        out = finding_trend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        self.assertIsNone(out["direction"])
        # >50% of inputs missing → degenerate, not a trend.
        sparse = [None, None, None, None, None, None, None, 1.0, 2.0, 3.0]
        self.assertIsNone(finding_trend(sparse)["direction"])
        # A real constant nonzero series may still report; a real rise reports.
        rising = finding_trend([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        self.assertEqual(rising["direction"], "rising")

    def test_step_change_spike_reversion_gate(self):
        # The 1999 artifact: a one-year outlier spike reverting is not a
        # regime change, even though the -977 delta clears 3x spread.
        vals = [1.0, 1.2, 0.9, 1.1, 1.0, 987.9, 10.0, 9.5, 10.2, 9.8]
        self.assertIsNone(finding_step_change(vals)["period"])
        # A genuine level shift (representative before level) still fires.
        vals2 = [1.0, 1.2, 0.9, 1.1, 1.0, 10.0, 9.5, 10.2, 9.8, 10.1]
        self.assertIsNotNone(finding_step_change(vals2)["period"])

    def test_step_change_thin_period_gate(self):
        # The 2005 menu artifact: a persistent-looking step whose edge
        # periods have ~22 observations against a median of ~230 is sparse
        # data, not structure.
        vals2 = [3.0, 3.1, 2.9, 3.0, 21.0, 21.5, 21.2, 21.3]
        counts2 = [230.0, 231.0, 228.0, 232.0, 4.0, 3.0, 4.0, 2.0]
        self.assertIsNotNone(finding_step_change(vals2)["period"])
        self.assertIsNone(finding_step_change(vals2, counts=counts2)["period"])

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
