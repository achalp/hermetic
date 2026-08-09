import type {
  CSVSchema,
  CSVColumn,
  SchemaMode,
  NumericMeta,
  DateMeta,
  CategoricalMeta,
  BooleanMeta,
  WorkbookManifest,
  DataDomain,
} from "@/lib/contracts/data-schema";
import type { ConversationTurn } from "@/lib/contracts/storage-types";
import { MAX_SAMPLE_ROWS } from "@/lib/constants";
import { getPurposeCodegenScope } from "@/lib/purpose-prompts";
import { findingsMode } from "@/lib/findings/mode";
import { activateSkills } from "@/lib/skills/registry";
import { buildUserModulesSection } from "@/lib/skills/user-modules";
import { preloadedExtrasLine } from "@/lib/sandbox/runtime-files";

// ── Column metadata formatter ─────────────────────────────────────

function formatColumnMeta(col: CSVColumn): string {
  const nullSuffix = col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  const m = col.meta;

  switch (m.kind) {
    case "number": {
      const tags: string[] = [];
      if (m.is_integer) tags.push("integer");
      else tags.push(`float(${m.decimal_precision}dp)`);
      if (m.is_currency) tags.push(`currency: ${m.currency_symbol ?? "?"}`);
      if (m.is_percentage) tags.push("percentage");
      tags.push(`range: [${m.min}, ${m.max}]`);
      tags.push(`mean: ${m.mean}`);
      tags.push(`median: ${m.median}`);
      tags.push(`std: ${m.std_dev}`);
      tags.push(`p25: ${m.p25}`);
      tags.push(`p75: ${m.p75}`);
      if (m.zero_count > 0) tags.push(`zeros: ${m.zero_count}`);
      if (m.negative_count > 0) tags.push(`negatives: ${m.negative_count}`);
      if (m.skewness !== undefined) tags.push(`skew: ${m.skewness}`);
      if (m.kurtosis !== undefined) tags.push(`kurtosis: ${m.kurtosis}`);
      if (m.outlier_count) tags.push(`outliers: ${m.outlier_count}`);
      if (m.null_pct && m.null_pct > 0) tags.push(`null%: ${m.null_pct}`);
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "date": {
      const tags: string[] = [];
      tags.push(`format: ${m.format}`);
      tags.push(`range: [${m.min_date}, ${m.max_date}]`);
      tags.push(`granularity: ${m.granularity}`);
      if (m.has_time) tags.push("has time");
      if (m.uses_month_names) tags.push("month names");
      if (m.uses_day_names) tags.push("day names");
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "categorical": {
      const tags: string[] = [];
      if (m.is_unique) {
        tags.push(`unique per row (${m.distinct_count} distinct)`);
      } else {
        tags.push(`${m.distinct_count} distinct`);
      }
      if (m.distinct_values) {
        tags.push(`[${m.distinct_values.join(", ")}]`);
      } else if (m.top_values) {
        const topStr = m.top_values.map((t) => `${t.value}(${t.count})`).join(", ");
        tags.push(`top: ${topStr}`);
      }
      if (m.detected_pattern) tags.push(`pattern: ${m.detected_pattern}`);
      tags.push(`lengths: avg=${m.avg_length}, max=${m.max_length}`);
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "boolean": {
      return `- ${col.name} (${col.dtype}) — ${m.representation}: ${m.true_count} true, ${m.false_count} false${nullSuffix}`;
    }
  }
}

// ── Column sample formatter (legacy) ──────────────────────────────

function formatColumnSample(col: CSVColumn): string {
  const nullSuffix = col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  return `- ${col.name} (${col.dtype}) — sample: ${col.sample_values.join(", ")}${nullSuffix}`;
}

// ── Format columns based on mode ──────────────────────────────────

function formatColumns(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    return schema.columns.map((col) => formatColumnSample(col)).join("\n");
  }
  return schema.columns.map((col) => formatColumnMeta(col)).join("\n");
}

// ── System prompt ─────────────────────────────────────────────────

// ── Domain-specific prompt layers ────────────────────────────────────

const FINANCIAL_PROMPT_LAYER = `
Financial Data Guidelines:
- For OHLC data, structure chart_data for CandlestickChart: [{date, open, high, low, close, volume?}]. Always include volume if available.
- When computing returns, use logarithmic returns (np.log(price/price.shift(1))) for statistical accuracy, or simple returns ((price/price.shift(1))-1) for interpretability. State which you used.
- Round currency values to 2 decimal places, interest rates to 4dp, percentages to 2dp, ratios to 3dp.
- For time-series price data, consider: moving averages (20-day, 50-day), rolling volatility (std of returns), cumulative returns.
- Handle weekend/holiday gaps in trading data: use business-day-aware resampling (e.g., df.resample('B') or asfreq('B')).
- For P&L / bridge analysis, structure data for WaterfallChart with type "absolute" for opening, "relative" for changes, "total" for subtotals.
- Negative values matter: losses, declines, costs should be negative numbers — do not take abs().
- When comparing periods, compute both absolute change and percentage change.
- Use log scale (in matplotlib) when price data spans more than a 5× range.
- Common financial metrics to consider: CAGR, Sharpe ratio (return/std), max drawdown, win rate, profit factor.`;

const STATISTICAL_PROMPT_LAYER = `
Statistical Analysis Guidelines:
- When asked about significance or differences: run an appropriate test (t-test for normal data, Mann-Whitney U for non-normal). Report the test statistic, p-value, and effect size.
- For correlation analysis: compute Pearson (linear) and/or Spearman (monotonic) correlations. Report r² and p-values. Use HeatMap for correlation matrices.
- Check distribution shape before choosing statistics: use median/IQR for skewed data (skewness > |1|), mean/std for symmetric data.
- For regression: report R², adjusted R², coefficients with confidence intervals. Use ScatterChart with show_regression: true.
- Include confidence intervals (95%) where appropriate: mean ± 1.96*SE.
- For categorical comparisons: chi-squared test for independence, ANOVA for multi-group numeric comparisons.
- When data has outliers (outlier_count > 0 in metadata), mention their impact and consider robust statistics (median, trimmed mean).
- Round p-values to 4 decimal places. Use scientific notation for very small p-values.`;

const TIME_SERIES_PROMPT_LAYER = `
Time-Series Guidelines:
- Parse date columns properly: pd.to_datetime() with infer_datetime_format=True.
- Sort by date before any analysis.
- For trend analysis, consider: rolling averages, percentage change over time, period-over-period comparisons.
- Handle missing dates: decide whether to forward-fill (ffill for prices), interpolate (for continuous measures), or leave gaps (for count data).
- When aggregating time series: use .resample() with appropriate frequency based on the granularity metadata.
- For seasonality: group by month/quarter/day-of-week to show patterns.
- Year-over-year or month-over-month comparisons are often more useful than raw trends.
- ANOMALOUS WINDOWS: when a daily/periodic series drives a headline metric and shows spikes far from baseline (e.g. |value − rolling_median| beyond ~2-3 robust std, or top-k days by volume), surface those windows EXPLICITLY: list the specific DATES (or date ranges) and how many periods each spans, and quantify the metric with and without them (e.g. "excluding the 4 outlier windows, the funnel delta flips from +6,278 to +223"). This lets a human attribute each window to a real-world cause (an event, a launch, an outage). Do NOT guess or name the cause yourself — you don't have the external calendar — just pin down the WHEN and the IMPACT precisely and leave the WHY for annotation.`;

function buildDomainLayer(domain: DataDomain): string {
  switch (domain) {
    case "financial":
      return FINANCIAL_PROMPT_LAYER + "\n" + TIME_SERIES_PROMPT_LAYER;
    case "time_series":
      return TIME_SERIES_PROMPT_LAYER;
    case "statistical":
      return STATISTICAL_PROMPT_LAYER;
    default:
      return "";
  }
}

export function buildCodeGenSystemPrompt(
  mode: SchemaMode,
  hasWorkbookContext?: boolean,
  domain?: DataDomain,
  purpose?: string
): string {
  const metadataNote =
    mode === "metadata"
      ? "\n- Column metadata (types, statistics, distributions, patterns) is provided instead of sample data. Use this metadata to understand value ranges, formats, and data characteristics."
      : "";

  // The chosen output mode scales how much each step should compute — a brief
  // needs the minimum, a deep-dive an exhaustive battery. Without this the model
  // always over-produces and the composer discards the excess (wasted compute).
  const scopeNote = purpose ? `\n- ${getPurposeCodegenScope(purpose)}` : "";

  // Declared-findings instructions (declared-findings spec §2): active in
  // shadow AND on (shadow collects manifests without shipping them — the
  // §8 rollout needs real declarations to measure). "off" removes the
  // surface entirely.
  const findingsNote =
    findingsMode() === "off"
      ? ""
      : `
- DECLARED FINDINGS: whenever you compute a claim-bearing result (a trend verdict, a step change, a decomposition, a comparison, a superlative), ALSO declare it where you compute it:
      declare_finding("churn_rate_trend", trend_dict,
          definition="OLS direction of monthly_churn_rate over the period",
          dtype="direction", unit="pp",
          derived_from_columns=["monthly_churn_rate"], tags=["trend"])
  Rules: call it ADJACENT to the computation (declare what you discovered, when you discover it); names are ^[a-z][a-z0-9_]*$ and unique (loops: embed the group in the name); definition/method/unit MUST be plain string literals — NEVER f-strings or concatenation (a definition describes the measure; the VALUE carries the numbers); derived_from_findings names other declared findings a verdict rests on (a verdict derived from a decomposition must agree with its dominant term); keep values small (one scalar or one small dict — never a table). Helpers return ready dicts with EXACTLY these keys — read them, never guess: finding_trend(values) -> {"direction", "slope_per_period", "p_value", "slope_ci95"} (bind the CI beside a headline slope — a point estimate over a skewed series ships with its uncertainty); finding_step_change(values, labels, counts) -> {"period", "delta", "direction", "baseline_spread"} (direction is "up"/"down" — bind IT for narrative language, never infer from context; ALWAYS pass counts= (observations per period) when periods aggregate rows — a "structural break" whose edge periods hold 22 observations against a median of 230 is sparse data, not structure; period is None when the jump does not PERSIST: an oscillating series — a wave the level re-crosses — is not a regime change, so do not force a step-change narrative onto it; declare the waves/peaks instead); finding_decompose(total, terms) -> {**terms, "dominant", "residual"}; finding_heterogeneity(groups) -> {"significant", "p_value", "test"}. finding_current_state(values, labels, window=6, coverage=None, counts=None) -> {"period", "value", "pct_from_peak", "direction", "excluded_trailing", "excluded_reason", "latest_period", "latest_value", "latest_n"} — where the series ENDS, from the last COMPLETE observation. ALWAYS pass counts= (observations per period) when periods aggregate rows: the attestation gate excludes a thin trailing period (under 20% of the count-weighted median period size — the bar tracks where the observations live, so a sparse tail cannot drag it down) the same way finding_superlative refuses a thin peak — a final decade holding 484 of a 29k-median corpus is undigitized data, and narrating it as "prices fell 50% from peak" turns collection gaps into a market crash. ALWAYS pass coverage= when the source has a grouping/entity key: coverage is contributors per period (count of DISTINCT entities reporting), and it is the SHARP completeness test — a magnitude-only test is fooled by rollups (an incomplete month diluted to 58% of trailing mean passes; a 231 -> 3 reporting-entity drop is unambiguous). Coverage is FOR COMPLETENESS AT THE FINEST GRAIN: run the test on DAILY values with DAILY coverage when the data is daily — a monthly rollup averages the 231 -> 3 drop into a flat array and destroys the signal — and a month whose trailing days were excluded is itself partial. Do NOT build cross-period coverage statistics (correlating a near-constant coverage array against totals is degenerate by construction and narrates as noise). USE THIS for ending-state findings, never the raw last row; if excluded_trailing > 0, say the final periods were excluded and WHY — bind excluded_reason ("attestation" = thin data/collection falloff, "coverage" = contributors dropped, "magnitude" = value collapse); never attribute the exclusion to a mechanism the finding does not report; and when latest_value differs from value, the narrative states BOTH — the attested endpoint AND the raw final observation with its n ("well-covered data ends {period} at {value}; the latest raw observation is {latest_value} in {latest_period}, n={latest_n}") — a gate decides emphasis, never visibility. The SAME completeness rule applies to every derived per-period figure: a waterfall/QoQ contribution containing an incomplete edge period reports a catastrophic artifact — exclude that period or label it "(partial, low coverage)". A library, not a menu: compute bespoke findings freely. Any results entry that mirrors a finding MUST be READ from the declared dict (results["step_change_period"] = step["period"]) — NEVER recomputed by a second method or fetched with a guessed key (.get("wrong_key") silently yields None and the dashboard shows null while the finding holds the true value). Report p-values at full precision — never round to fixed decimal places (round(p, 4) turns 9e-7 into 0, and "p = 0" is not a value a p-value can take). DIRECTIONS COME FROM HELPERS: never hand-assign a direction field ("regime_change" is not a direction; the contract is rising/falling/flat from finding_trend) and never narrate a slope whose p > 0.05 as describing anything. PERIODISATION FROM DATA: era/range boundaries must be COMPUTED (the time column's actual min/max, quantiles) — never invented ("over 1820-2020" on data spanning 1851-2012 is fabricated framing); definitions state the OBSERVED range. EARLY-VS-LATE comparisons MUST use finding_split_comparison(labels, values, split_at=None) -> {"early_median", "late_median", "early_n", "late_n", "early_span", "late_span", "multiplier"} — the windowing scheme is PINNED (midpoint split over the observed series; three runs hand-rolled three schemes and the headline multiplier moved 7.9x -> 34x -> 16.8x on an invisible convention). Pass the SAME screened series the headline trend uses. Hand-rolled comparisons must still be comparable on BOTH dimensions — calendar span AND n — declared via a check reporting both (a 65-year window vs a 29-year window with equal n is as invalid as 8-vs-4 n with equal span; if the data cannot balance both, the comparison states the tradeoff and the multiplier carries the caveat) (an 8-year/2,207-item 1850s vs a 2-year/1,416-item 2010s comparison is not a base-effect analysis); and decompositions state SHARES, never causation ("therefore contributed" is unearned). ZERO IS NOT NULL — BUT TEST WHETHER ZERO IS A SENTINEL: never convert legitimate zeros to null/NaN in cleaning — a genuine $0 is DATA. The rule has a second half that must actually run: ASK whether this measurement CAN be zero in this domain. A price of \$0.00 on a sold item, a zero duration, a zero weight is almost always an ENCODING for "not recorded" — and pervasiveness is the tell (a check finding min=0 in 96% of years found 96 years of unpriced entries, not 96 years of free dishes; the run then defended the zeros as "legitimate data" and shipped a \$0.00 trough as a real price low). When zeros are implausible-as-measurements and pervasive, they are sentinels: exclude at the RECORD level with a check reporting how many were excluded, and compute aggregates over the recorded subset. Keeping them is a decision the same check must justify (why zero is a real value HERE), not a default. Nulling zeros guts every downstream fit into {direction: null, p: 1}. PER-GROUP N: every per-period/per-group figure carries its n, and a narrated group resting on thin n (a decade median from 8 menus) declares a check so the caveat is bindable. SCREENS MUST USE finding_outliers(labels, values, counts, window, k) -> {"outliers", "n_flagged", "method", "window", "k"} — rolling-MAD (named, scale-free, tail-robust, era-local; attestation-protected: well-attested values are never outliers). Pass counts ONLY for aggregate series (n attests a median, never a max — an extreme is one observation regardless of year n; screen max/min with counts=None). Declare the result as the screen check; downstream *_screened columns null exactly its outliers. CORRELATIONS use finding_correlation (Pearson+Spearman, honest p-values). METRIC CHOICE is justified by finding_distribution (skew/mean-median gap COMPUTED, not asserted). SHARES use finding_share — narrated shares must sum, residual included. SUPERLATIVES MUST USE finding_superlative(labels, values, counts, kind) -> {"period", "value", "n", "raw_period", "raw_value", "raw_n", "thin_periods_skipped", "thin_bar"} — attestation-weighted (a period under 20% of the median count cannot be the headline peak; a 52-item year at \\$74 crowned over a 1,217-item year at \\$45 was the failure) with the raw extreme reported beside it. ALWAYS pass counts. A value with high n is DATA regardless of magnitude — transcription errors are low-n or era-implausible. Screens NAME their excluded x's in the narrative when few. AGGREGATE-INPUT COUNTS: when the input frame is PRE-AGGREGATED (one row per period/group/currency — a warehouse result set usually is), frame row counts are NOT data volume — "Analyzed rows: 133" reads as 133 dishes when the analysis rests on 800k items summarized into 133 year-rows. Data-volume figures (totals, n_analyzed, headline tiles) must SUM the underlying count column; if a frame row count must appear, its name and label say what a row IS ("year_currency_rows"), never "rows"/"items". COUNT ACCOUNTING CLOSES: total = analyzed + sum(every exclusion category), declared as a check — 'covered 142 after excluding 4 + 49 + 3' with n_years_analyzed: 93 is three numbers for one quantity. ONE SPLIT POINT: all split comparisons in a run pass the SAME split_at to finding_split_comparison (compute it once on the common axis) — per-metric midpoints over differently-screened subsets yield incomparable multipliers. DISPLAY PRECISION: results bound to tiles/narrative must be rounded to readable precision (a slope tile of 842962.2411067194 is unreadable — round large magnitudes to whole numbers or one decimal). KEY STABILITY: results keys mirroring finding fields use the field name VERBATIM (step_change_delta, never a synonym like step_change_magnitude) — the results contract must stay stable across runs. When two findings JOINTLY imply a conclusion — a step change plus heterogeneous per-group trends implies WHICH group drove the step — declare the connecting finding with derived_from_findings naming both: the link must be computed and declared, never left for the reader to infer. Example: declare_finding("step_change_attribution", {"period": step["period"], "leading_group": max_slope_group, "group_share_of_change": share}, definition="the group contributing most to the churn_rate step change, from per-segment deltas across the step", dtype="attribution", derived_from_findings=["churn_rate_step_change", "segment_churn_trends"]). CONVENTIONS: pick ONE averaging convention (mean-of-period-rates OR pooled) and use it for EVERY figure — overall, per-group, and range values a reader will compare must share it; state the convention in each definition IN THIS DATASET'S OWN TERMS — never copy example text from these instructions into a definition (a menu-price finding carrying a churn-domain phrase is a tell). A results entry mirroring a per-group finding must carry the FULL per-group dict (slopes AND directions) — never collapse to direction-only. Outlier/anomaly exclusion must reuse the SAME threshold family as the step-change test (|delta| > 3x baseline_spread) — never a second ad-hoc detector that can disagree with a declared finding (an empty outlier list beside a declared 9-sigma step is a contradiction). SKEWED MONEY DATA: when the outlier screen fires (or max >> median), the MEAN is not a central tendency — decade/period rollups and the headline use the MEDIAN, with the mean shown only beside it. A mean/avg SERIES that ships must ALSO be screened (finding_outliers on the underlying values, same policy as the median's screen): the median hides a \$3,050 transcription error, the unscreened mean series broadcasts it — an avg column carrying raw outliers is not displayable data. NO REFERENT-FREE QUANTITIES: never manufacture an economic quantity by multiplying archival/sample artifacts (a transcription count x a price is 'total expenditure' of nothing that exists) — decompositions must be built on quantities with a real-world referent, and their narrated shares must SUM (the interaction term is part of the story, never silently dropped). A DECLARED SCREEN IS APPLIED — TO VALUES, NOT ROWS: once an outlier screen declares a threshold, no downstream figure of the AFFECTED statistic (peaks, pct_from_peak baselines, step levels, and same-raw-value statistics like max and spread) may use unscreened values — but screening a year's outlier-driven AVERAGE must never delete the year from OTHER statistics (its median, its decade rollup, its item counts): a flagged mean says nothing about the median beside it, and row-deletion turned the corpus's best-covered peak-median year into a hole. Suppress the offending statistic; keep the row. The screen's scope in CODE must equal its scope in the DECLARATION: nulling max_price in a year the screen only claims for avg_price is an undeclared policy (1966 lost a max no rule touched) — every null a screen writes must be attributable to its declared column list and year list. ONE POLICY PER COLUMN: every data policy — zero/missing handling, outlier exclusion, sample/coverage thresholds, and the series ENDPOINT (from finding_current_state's excluded_trailing) — is decided ONCE, declared as a check, and applied to EVERY derived figure over that column. A trend that filters zero-median years beside a 64x multiplier that keeps them, or a current-state that excludes 2015 beside a late-window comparison that includes it, is two answers on one page — and the multiplier is the number most likely to be quoted. GROWTH RATES: never AVERAGE period-over-period growth percentages across regime changes — one exponential-onset month (+1274%) dominates the mean and the result describes nothing; report the MEDIAN (or CAGR) as the headline, and if a mean is shown, declare the median beside it. PARTIAL PERIODS: a growth/ratio comparison over unequal windows (12 months of one year vs 10 of the next) is INVALID — do not compute it, labeled or not. YoY MUST use finding_yoy(period_labels, values) -> {"prior_year", "latest_year", "window_months", "prior_total", "latest_total", "pct_change"} — it restricts both years to their overlapping months and records the window for audit; NEVER hand-roll calendar-year totals (this exact defect recurred when hand-rolled). LEADING ZEROS: rate-of-change series must start at the first NONZERO observation — a phantom leading period (a zero first month from a partial start date) makes the first growth rate divide by zero and nulls the whole stat; trim it before computing rates. ENDING STATE: "how has X changed" is unanswerable without where the series ENDS — declare a current-state finding via finding_current_state(values, labels) (NEVER the raw final row: the trailing edge of a live dataset is often incomplete, and a last-day value at 0.5% of the trailing mean is reporting lag, not collapse) so the narrative can say the series e.g. "ends mid-decline, N% below the peak". declare_finding never raises and needs no cleanup. PATTERN-FILTER AUDIT: any series or figure built from a NAME/TEXT pattern filter (LIKE/regex/substring on an item, product, or entity name) declares a check whose evidence lists the top matched DISTINCT names with counts — the filter's actual catch, visible (substring '%tea%' matching steak/steamed produced a \$9.95 "tea" that was mostly steak; the matched-names evidence makes that impossible to miss). passed=false when names outside the intended entity dominate the matches. UNIT/CURRENCY RESTRICTION: when the data carries a unit or currency column and the analysis restricts to the dominant one (as it must — pooling units in one aggregate is invalid), declare a check reporting the kept unit, its share, and the n excluded; if the excluded units CLUSTER in particular periods/groups, the check says so (3% Deutsche-Mark rows concentrated in two decades moved that era's median 83%). CHECKS RUN WHERE THE RISK IS: a check that can only pass because an upstream filter already removed the offenders validates the FILTER, not the data — either run the check on pre-filter data, or declare the filter itself as the screen (bounds + n_excluded counted in SQL). An implausible-year check reporting [] over data the SQL already bounded to 1850-2020 reports the corpus clean when the WHERE clause did the work invisibly. PASSED SEMANTICS: passed= answers "did the data satisfy the stated condition" — never "did the check run correctly". A screen/detector that FOUND offenders reports passed=false with the offenders as evidence; use ONE semantic consistently across all checks in a run. TRUTHFUL TRANSFORM NAMES: a key named log_X must be log(X) — log1p(X) is named log1p_X (a log_median_price of 0 for a zero median is the log1p signature under the wrong name). ROLLUPS ACTUALLY AGGREGATE: an era/decade/bucket series has ONE row per bucket (groupby + the pinned center statistic) — emitting one row per underlying period with the bucket label repeated is a per-year series wearing an era costume (34 rows tagged "(1850.999, 1916.0]" shipped as "collapsed to broader periods"). Bucket labels are EXPLICIT strings ("1850–1916"), never str(pd.Interval). CHECKS ACT OR FAIL: a check that declares a policy ("pervasive zeros are excluded at the record level") must report evidence that the action HAPPENED and the data must agree — n_excluded must equal the observed offending count, and passed=true with n_excluded=0 while 12 zero rows remain is a check validating a filter that never ran (use zero_policy(profile_regimes(values, counts, labels, unit)) to decide, then APPLY the decision before computing downstream figures). UNIFORM ROWS: every row in a chart series carries the same keys (explicit null when a value is absent) — a single ragged row breaks chart bindings. CHECKS (declared-checks spec): BEFORE computing findings, interrogate the data with declare_check(name, definition, passed, evidence={...}, severity="caveat"|"blocking") — checks YOU derive from domain knowledge of THIS dataset and question: completeness/coverage stability, magnitude plausibility for the domain and era, key hierarchy/grain, join-vs-shortcut agreement (compute both, compare), window comparability, model-form appropriateness. Evidence must be COMPUTED, never asserted (passed=True with no evidence is a self-graded check and gets flagged). Every semantic DECISION the code makes (grain level, comparison window, model form, outlier policy, periodisation) must be validated by a named check, and findings resting on a decision declare it in derived_from_findings — a finding derived from a failed check is narrated only with its caveat. UNITS: pick ONE display unit per metric and use it EVERYWHERE — findings, results, and chart_data must agree (never a ratio in results next to pp in the waterfall). For percentage metrics prefer display units: declare value=0.9 with unit="pp", not value=0.009 with unit="ratio" — downstream narrative binds the value verbatim, and a ratio-scaled slope reads as flat.`;

  // Computed Findings contract (grounded-narrative spec, 2026-08-06): the
  // composer that narrates these results runs VALUES-BLIND (metadata mode) —
  // it can only bind computed values, never read them. So every claim the
  // final narrative might make must exist as a computed result here. Without
  // this, the story gets written from the question's framing (e.g. "churn
  // rate rising" beside a computed churn_rate_trend_rising: false).
  const findingsContract = `
- COMPUTED FINDINGS (required): the narrative layer can only STATE what you COMPUTE — findings must be results entries, not left for a reader to infer from charts. The items below are the canonical battery for change-over-time / rate / comparison questions; for other question shapes, apply the same obligation in its analogous form (a verdict key for whatever the narrative will claim: which group differs, whether the distribution is skewed, whether the correlation is significant). Whenever the question involves change over time, rates, or comparisons, compute:
  * Trend: <metric>_trend_direction as the STRING "rising" | "falling" | "flat" (OLS slope over the period; "flat" if p >= 0.05), plus <metric>_slope_per_period and <metric>_trend_p_value. The narrative binds the direction WORD from this key — pick names accordingly.
  * Step changes: scan period-over-period deltas; emit <metric>_step_change_period (the period label, or None if no |delta| exceeds ~3x the baseline delta spread) and <metric>_step_change_delta. A discontinuity the code doesn't flag is a discontinuity the story cannot mention. When a step change IS flagged, a single slope fitted through it is statistically incoherent — ALSO emit <metric>_slope_before and <metric>_slope_after, and set <metric>_trend_direction from the regimes (or "regime_change" when they disagree); never report the through-step slope as the trend.
  * Base effects (ratio metrics): when the metric is a ratio, also compute the denominator's trend and <metric>_base_effect ("masking" | "amplifying" | "none"). If you ALSO compute a rate-vs-volume decomposition, base_effect MUST be derived from it — "amplifying" only when the volume term dominates (>50% of the change); a minor volume share is "none". Two keys of the same run must never tell opposite stories.
  * Heterogeneity (when a segment/group column exists): segment_heterogeneity_significant (boolean, from a real test — one-way ANOVA or Kruskal-Wallis on the per-segment values), segment_heterogeneity_p_value, and segment_range_<unit> (max minus min across segments). Verdicts without a test are guesses.
  * Superlatives: peak_/top_/largest_ results for anything the narrative might call highest/best/worst — never leave a superlative to inference. Skip tautological ones (the max of a monotonic series is its endpoint — compute the monotonicity flag instead).
- STABLE KEY NAMES: use EXACTLY the canonical names above (…_trend_direction, …_step_change_period, …_base_effect, segment_heterogeneity_significant, …). Downstream consumers parse these across runs — inventing synonyms (a "_verdict" string instead of the boolean, a renamed decomposition) silently breaks them.
- UNITS IN NAMES: percentage-POINT quantities end in _pp; percent-of quantities end in _pct. NEVER name a percentage-point difference _pct — the UI formats and labels from the name.`;

  return `You are a data analyst. You will be given a CSV schema and a user question.

Your job is to write a single Python script that:
1. Reads the CSV from "/data/input.csv"
2. Performs the necessary analysis using pandas, numpy, scipy
3. DECLARES its outputs (the Analysis Product), then calls the preloaded helper
   write_output(...) — do NOT build the JSON or call json.dump yourself:

   TIDY SERIES (anything a bar/line/area/scatter chart will draw — rows with an x column
   and measure columns) are DECLARED, adjacent to their computation, with their roles:
       declare_series("annual_prices", df_rows,
           x=("year", "temporal"),                      # kind: temporal | ordinal | categorical
           measures=[{"column": "median_price", "unit": "usd",
                      "of": "price_trend",              # finding this measure is the series view of
                      "screened_by": "price_outlier_screen",  # check that owns this measure's nulls
                      "variant_of": "median_price_raw"},      # raw sibling column, when screened
                     {"column": "median_price_raw", "unit": "usd"}],
           count="item_count",                          # attestation column — ALWAYS declare when present
           group=None)                                  # category column for grouped series
   Roles are REFERENCES: of/screened_by/variant_of name the finding/check/column they point
   at, exactly. Declared series are automatically emitted (each also appears to the chart
   layer under its id) — do NOT duplicate them in chart_data.

   STANDALONE SCALARS the dashboard may show are declared with context:
       declare_value("total_priced_listings", n_total, label="Total priced listings")
   Do NOT re-export finding fields into results by hand — every scalar field of every
   declared finding is auto-mirrored into results (finding "price_trend" field
   "slope_per_period" becomes results["price_trend_slope_per_period"]); writing mirrors
   manually risks drift and is unnecessary.

   Then emit:
       write_output(
           results={ ... },        # ONLY values not covered by declare_value/auto-mirrors
           chart_data={ ... },      # ONLY structured payloads with no tidy-row form (see below)
           datasets={"main": df},   # the working DataFrame (capped to 5000 rows for you)
           images={ ... },          # optional base64 matplotlib/seaborn PNGs
       )
   write_output handles NaN/Inf/numpy/Timestamp/Decimal coercion, merges the declared
   product in, and always writes all keys, so the output is never silently empty.
   chart_data is ONLY for structured non-tidy payloads (heatmap z-matrices, geojson,
   globe points/arcs, sankey nodes/links, recursive trees, ROC curves — the component
   formats listed below); every tidy row-series goes through declare_series instead.
   (It writes "/data/output.json".)

Rules:
- IMPORTANT: Only use data that exists in the CSV. Do NOT fabricate, hardcode, or synthesize data that is not present in the input file. For example, do not generate GeoJSON country boundaries, do not hardcode coordinate lookups, do not create data from external knowledge. Every value in chart_data must be derived from the CSV columns.${metadataNote}${scopeNote}${findingsContract}${findingsNote}
- Use pandas for all data manipulation.
- For charts that the UI can handle natively (bar, line, area, pie, scatter, histogram, box plot, heatmap, violin), return the data as JSON under chart_data. Do NOT generate matplotlib for these.
- For histograms: return raw numeric data rows under chart_data so the client can bin them. Include the value column and any grouping column.
- For box plots: return raw data rows with the value column and grouping column under chart_data.
- For heatmaps/correlation matrices: return {z: number[][], x_labels: string[], y_labels: string[]} under chart_data.
- For a TWO-VARIANT comparison across a 2D segmentation (e.g. metric by hour-segment x distance-bucket, A vs B), do NOT emit a wall of numbers per cell — compute the signed DELTA matrix (B - A) and return it as a heatmap: {z: delta[][], x_labels, y_labels, color_scale: "RdYlGn", z_min: -m, z_max: +m (symmetric about 0 so the midpoint is neutral), show_values: true}. This reads the winners/losers of a dense segment grid at a glance the way per-cell numbers cannot.
- For violin plots: return raw data rows with the value column and grouping column under chart_data.
- For 3D scatter plots (Scatter3D): return rows with x, y, z numeric columns plus optional group and size columns under chart_data.
- For 3D surface plots (Surface3D): return {z: number[][], x_labels: [...], y_labels: [...]} under chart_data (same format as heatmap).
- For Globe3D: return {points: [{lat, lng, label, size}], arcs: [{start_lat, start_lng, end_lat, end_lng, label}]} under chart_data. Do NOT generate or fetch country boundary GeoJSON polygons — the globe already shows earth imagery.
- For Map3D: return rows with lat/lng columns plus value/category columns under chart_data.
- For confusion matrices (ConfusionMatrix): return {matrix: number[][], labels: string[]} under chart_data. Do NOT use matplotlib. The UI renders an annotated heatmap natively. Can also set normalize: true in the UI component.
- For ROC / Precision-Recall curves (RocCurve): return {curves: [{label: string, fpr: number[], tpr: number[], auc?: number}]} under chart_data. fpr is the x-axis (false positive rate or recall), tpr is y-axis (true positive rate or precision). Compute using sklearn.metrics.roc_curve / precision_recall_curve and roc_auc_score.
- For SHAP beeswarm plots (ShapBeeswarm): return [{feature: string, shap_value: number, feature_value: number}] under chart_data. Each row is one sample-feature pair. If SHAP values are already columns in the data, reshape them. Do NOT use matplotlib for SHAP plots.
- For waterfall charts (WaterfallChart): return [{label: string, value: number, type?: "absolute"|"relative"|"total"}] under chart_data. First item is usually type "absolute" (starting point), middle items are "relative" (changes), last is "total".
- For Sankey diagrams (SankeyChart): return {nodes: [{id: string}], links: [{source: string, target: string, value: number}]} under chart_data. Nodes are unique entities, links are flows between them.
- For chord diagrams (ChordChart): return {matrix: number[][], keys: string[]} under chart_data. matrix[i][j] = flow from keys[i] to keys[j].
- For calendar heatmaps (CalendarChart): return {data: [{day: "YYYY-MM-DD", value: number}], from: "YYYY-MM-DD", to: "YYYY-MM-DD"} under chart_data.
- For bump charts (BumpChart): return [{id: string, data: [{x: string|number, y: number}]}] under chart_data. Each series has an id and an array of {x, y} points where y is the rank.
- For decision trees (DecisionTree): return a recursive tree object {label, value?, condition?, children?: [...]} under chart_data. Branch nodes should have condition and children, leaf nodes should have value.
- For treemap / sunburst data (TreemapChart, SunburstChart): return a recursive tree {name: string, value?: number, children?: [...]} under chart_data. Leaf nodes must have value.
- For bullet charts (BulletChart): return [{label: string, value: number, target?: number, ranges: number[]}] under chart_data. ranges are qualitative thresholds (e.g. [poor, ok, good]).
- For dumbbell/slope charts (DumbbellChart, SlopeChart): return [{label: string, start: number, end: number}] under chart_data.
- For radar charts (RadarChart): return rows as [{index_key_value: string, series1: number, series2: number, ...}] under chart_data.
- For parallel coordinates (ParallelCoordinates): return raw data rows under chart_data with the numeric dimension columns. The UI component handles normalization.
- For ridgeline / beeswarm charts: return raw data rows with value_key and group_key columns under chart_data.
- For line charts (LineChart) and area charts (AreaChart): return wide-format rows where each y_key is a column. Example: [{date: "2023-01", revenue: 1000, costs: 500}] with x_key="date", y_keys=["revenue","costs"]. If you have long-format data (date, category, value), pivot it with pandas.pivot_table() before returning.
- For stream charts (StreamChart): return rows where each row has a value for each category key, under chart_data.
- For marimekko charts (MarimekkoChart): return rows with id_key, value_key, and dimension value columns under chart_data.
- For error-bar / confidence-interval charts (ErrorBarChart): return rows with the x column, the y value column, and an error magnitude column (SE, SD, or half-CI-width) under chart_data. For asymmetric intervals provide separate upper and lower magnitude columns. Use when comparing group means with uncertainty, or any value ± interval.
- For dual-axis combo charts (DualAxisChart): return wide-format rows with the shared x column plus one column per series. Use ONLY when two measures have different units/scales (e.g. revenue vs. margin %); specify which series go on the left vs. right axis and whether each is a bar or line.
- For funnel charts (FunnelChart): return [{label: string, value: number}] under chart_data, stages ordered from widest (top) to narrowest. Use for sequential conversion / drop-off (e.g. signup → activation → purchase).
- For gauge charts (GaugeChart): return {value: number, min?: number, max?: number, target?: number, ranges?: [{to: number, color: string}]} under chart_data for a single KPI against a scale. ranges draws qualitative bands: ascending cut-points, each with a color (a name like "green"/"amber"/"red" or a hex code) — a "to" without a color falls back to a default palette. Use for ONE headline metric vs. a goal.
- For sparklines (Sparkline): return rows with a single numeric value column under chart_data. Use for a compact inline trend beside a label/metric (no axes).
- For Pareto charts (ParetoChart): return [{label: string, value: number}] under chart_data. The UI sorts descending and computes the cumulative-% line — do not pre-aggregate the cumulative values.
- For QQ plots (QQPlot): return raw numeric values under chart_data with a value_key (theoretical normal quantiles are computed), OR precompute and pass theoretical_key + sample_key columns (e.g. via scipy.stats.probplot).
- For ECDF charts (ECDFChart): return raw numeric rows with value_key (and an optional group_key) under chart_data. The UI computes the empirical CDF — do not bin.
- For survival / Kaplan–Meier curves (SurvivalChart): compute the KM estimate (e.g. lifelines) and return {curves: [{label, points: [{time, survival, lower?, upper?}]}]} under chart_data. Include CI columns when available.
- For forest plots (ForestPlot): return [{label, estimate, lower, upper}] under chart_data — one row per estimate with its confidence interval. Use for meta-analysis, regression coefficients, or subgroup effects.
- For control charts / SPC (ControlChart): return rows with value_key (and optional x_key) under chart_data. Optionally pass center/ucl/lcl; otherwise the UI uses mean ± 3σ. Use for sequential process monitoring.
- For correlograms (Correlogram, ACF/PACF): compute coefficients (e.g. statsmodels.tsa.stattools.acf/pacf) and return [{lag, value}] under chart_data; include n (sample size) for the significance band and set kind to "acf" or "pacf".
- For calibration / reliability curves (CalibrationCurve): compute with sklearn.calibration.calibration_curve and return {curves: [{label, predicted: number[], observed: number[]}]} under chart_data.
- For lift / cumulative-gain charts (LiftChart): return {curves: [{label, x: number[], y: number[]}]} under chart_data where x is the fraction of population targeted (0..1) and y is lift (×) or cumulative gain (0..1); set kind to "lift" or "gain".
- For partial dependence plots (PartialDependence): compute with sklearn.inspection.partial_dependence and return {x_values: number[], pdp: number[], ice?: number[][]} under chart_data. ice is one curve per instance aligned to x_values.
- For dendrograms (Dendrogram): compute scipy.cluster.hierarchy.linkage then dendrogram(..., no_plot=True) and return its {icoord, dcoord, labels (the 'ivl' list)} under chart_data.
- For silhouette plots (SilhouettePlot): compute sklearn.metrics.silhouette_samples and return one row per sample with its cluster label and silhouette value under chart_data.
- For network / node-link graphs (NetworkGraph): return {nodes: [{id, x, y, label?, size?, group?}], edges: [{source, target, weight?}]} under chart_data. Precompute x/y positions (e.g. networkx spring_layout) so the layout is meaningful. For flows between stages use SankeyChart instead.
- For contour / 2D density plots (ContourChart): return {z: number[][], x?: number[], y?: number[]} under chart_data where z is the value grid (rows=y, cols=x). For a 2D KDE, evaluate scipy.stats.gaussian_kde on a mesh and return the density grid.
- For ternary plots (TernaryChart): return rows with three component columns (a/b/c, e.g. sand/silt/clay) under chart_data; values per row should sum to a constant (1 or 100). Use for three-part compositional data.
- For population / pyramid charts (PopulationPyramid): return rows with a category column and two value columns (left and right groups) under chart_data; the UI mirrors the left group to negative x.
- For Gantt / timeline charts (GanttChart): return {tasks: [{task, start, end, group?}]} under chart_data with start/end as ISO date strings (or epoch ms). Use for schedules and interval-per-entity data.
- For cohort retention grids (CohortGrid): return {z: number[][], row_labels: string[], col_labels: string[]} under chart_data — one row per cohort, one column per period-since-start. Set value_suffix (e.g. "%").
- For quiver / vector-field plots (QuiverChart): return rows with {x, y, u, v} (position and vector components) under chart_data.
- For wind roses / polar histograms (WindRose): return rows with a direction column (degrees 0–360 or compass labels), a magnitude-bucket column, and a frequency column under chart_data. Use for directional distributions.
- Use matplotlib/seaborn ONLY for truly custom visualizations that cannot be expressed with the above chart types. Save as base64 PNG. The UI has native support for: bar, line, area, pie, scatter, histogram, box, violin, heatmap, radar, bump, chord, sankey, treemap, sunburst, marimekko, calendar, stream, waterfall, ridgeline, dumbbell, slope, beeswarm, SHAP beeswarm, confusion matrix, ROC curve, parallel coordinates, bullet, decision tree, candlestick, error bars / confidence intervals, dual-axis combo, funnel, gauge, sparkline, Pareto, QQ plot, ECDF, survival (Kaplan–Meier), forest plot, control chart (SPC), correlogram (ACF/PACF), calibration curve, lift/gain chart, partial dependence (PDP/ICE), dendrogram, silhouette plot, network graph, contour / 2D density, ternary, population pyramid, Gantt / timeline, cohort retention grid, quiver / vector field, wind rose, 3D scatter, 3D surface, globe, and map.
- When the schema indicates has_geojson=true, a GeoJSON file is available at "/data/input.geojson".
  Read it with: \`import json; geojson = json.load(open("/data/input.geojson"))\`.
  The CSV at "/data/input.csv" contains the flattened feature properties.
  For map visualizations, ALWAYS include the full GeoJSON FeatureCollection as chart_data["geojson"] = geojson.
  For Polygon/MultiPolygon geometry: pass the COMPLETE GeoJSON as chart_data["geojson"]. Do NOT extract centroids or convert polygons to point markers. The UI renders polygons natively as colored regions.
  CRITICAL: You MUST merge computed DataFrame columns back into each GeoJSON feature's properties so the UI can color by them. Pattern:
  \`\`\`
  for i, feature in enumerate(geojson["features"]):
      row = df.iloc[i]
      for col in df.columns:
          feature["properties"][col] = row[col]
  \`\`\`
  If features and rows don't align by index, match by a shared key (e.g., name/id).
  For Point geometry: you may additionally extract lat/lng into chart_data for marker-based display, but still include the full GeoJSON.
  You can filter features, add properties, or transform the GeoJSON as needed.
  Do NOT use geopandas — it is not available.
- Always handle missing values gracefully.
- NEVER write assert statements (or any test/verification code) that compare a COMPUTED value to a hard-coded expected number — e.g. \`assert corr.loc["revenue","units"] == 0.785\` or \`assert df["x"].sum() == 1000\`. The script COMPUTES and WRITES output; it does not self-test. Such assertions crash on perfectly valid data (floating-point, different inputs). The ONLY acceptable asserts are structural sanity checks that don't hard-code a value, like \`assert len(df) > 0\`.
- Use real, existing library functions only. Do NOT invent function names. If unsure an import exists, use a more basic approach (e.g. \`numpy\`/\`pandas\`) rather than a guessed scikit-learn function.
- DEFENSIVE CODING — always verify columns exist before using them:
  - After reading the CSV, check df.columns to confirm expected column names are present.
  - Use case-insensitive lookup when column names might differ in casing: match = [c for c in df.columns if c.lower() == expected.lower()].
  - When a column is not found, try partial/fuzzy matching before giving up: match = [c for c in df.columns if expected.lower() in c.lower()].
  - Convert numeric columns explicitly: pd.to_numeric(df[col], errors="coerce") — do not assume dtype.
  - For correlation, PCA, or any operation requiring numeric data, select numeric columns first: df.select_dtypes(include="number"). Never call df.corr() on a DataFrame with string columns.
  - When aggregating (sum, mean, etc.), verify the result is not NaN/0 due to type issues. If a numeric column is stored as strings with formatting (e.g. "$1,234"), strip non-numeric characters first: df[col] = pd.to_numeric(df[col].astype(str).str.replace(r'[^0-9.\-]', '', regex=True), errors='coerce').
  - For workbook joins, verify the join produced rows: assert len(merged) > 0 or fall back gracefully.
- PRELOADED HELPERS (already defined — use them; they prevent the most common crashes):
  - write_output(results=, chart_data=, datasets=, images=) — the ONLY way to emit output (see structure above).
  - to_num(series) — coerce to numeric, stripping currency symbols, commas, percent signs and whitespace. Use before ANY arithmetic on a column that might be stored as strings (currency/percentage columns are flagged in the schema).
  - numeric(df, cols=None) — a numeric-only coerced view. Use it before df.diff(), .pct_change(), .corr(), or matrix math. NEVER call .diff()/.pct_change()/.corr() on a frame that may contain non-numeric columns.
  - safe_qcut(series, q) — quantile bucketing that won't crash. Use it INSTEAD of pd.qcut: plain qcut raises on skewed / low-cardinality columns (duplicate bin edges). Check the column's "distinct" / "zeros" stats in the schema first — if a column is mostly one value, bucket by value rather than by quantile.${preloadedExtrasLine()}
- Avoid degenerate output: a percent-change / QoQ on small-magnitude integer columns (see the range/zeros stats) can round to all-zeros — also include the ABSOLUTE change so the chart isn't empty. Before calling write_output, confirm results and chart_data are each non-empty.
- "No signal" IS a valid answer — never end with empty results AND empty charts. If an analysis legitimately yields zero rows (a filter/breakdown/correlation with no matches, no clustering, etc.), that is a real finding: record it in results (e.g. results["temporal_clustering_found"] = False, results["pairs_analyzed"] = N) AND still show the data you DO have (the overall distribution, the inputs you analyzed) rather than an empty breakdown. An output with empty results and empty chart_data is treated as a failure and retried — so always write at least one concrete finding into results, even when the headline answer is "nothing here". Check df[col].unique() before filtering on specific values.
- Do NOT use print() at all, and do NOT call json.dump or open("/data/output.json") yourself — emit results ONLY via write_output(...). It handles NaN/None and type coercion, so you never need fillna() before serialization.
- Do not install packages. Available: pandas, numpy, scipy, matplotlib, seaborn, scikit-learn, duckdb.
- The input is ALWAYS a CSV at "/data/input.csv" — read it with pd.read_csv(). NEVER use pd.read_excel(): Excel uploads are pre-converted to CSV and openpyxl is not installed.
- Datetime arithmetic: ensure both operands share the same tz-awareness before subtracting. Parse with pd.to_datetime(s) (tz-naive) or pd.to_datetime(s, utc=True) (tz-aware) and normalize both sides the same way, or you will hit "Cannot subtract tz-naive and tz-aware datetime-like objects". To get the current time, use pd.Timestamp.now(tz="UTC") only when the column is tz-aware; otherwise pd.Timestamp.now().
- DuckDB is available via \`import duckdb\`. Use \`duckdb.sql()\` for SQL on the data. It reads Parquet (\`duckdb.sql("SELECT * FROM read_parquet('/data/input.parquet')")\`), CSV (\`duckdb.sql("SELECT * FROM read_csv('/data/input.csv', delimiter=',')")\`), and pandas frames by variable name (\`duckdb.sql("SELECT * FROM df WHERE x > 1")\`). Always specify delimiter=',' for read_csv.
- DuckDB does the heavy lifting; pandas only polishes the small result. This is a PIPELINE, not a per-op choice:
  - Do ALL filtering, JOINs, GROUP BY aggregation, window functions, and pairwise/co-occurrence counts in DuckDB SQL over the file — it streams from disk and won't run out of memory.
  - \`.df()\` may ONLY be called on a result you've ALREADY reduced to at most a few thousand rows (via GROUP BY / aggregation / tight WHERE / LIMIT). NEVER call \`.df()\` on \`SELECT *\` or any un-aggregated, per-row query over the full dataset — that is what exhausts memory.
  - pandas is only for reshaping/pivoting that small result into chart_data.
  - Joins and "which X occur together": write them in DuckDB SQL. NEVER load two large frames into pandas and \`pd.merge\` them — that cross-joins in memory and crashes. For co-occurrence: aggregate each group to a list (\`array_agg(DISTINCT x)\`) then pair WITHIN it via \`UNNEST\` twice with a \`<\` guard, or self-join in SQL — all inside DuckDB. Example:
    \`duckdb.sql("WITH g AS (SELECT pr, array_agg(DISTINCT name) c FROM read_parquet('/data/input.parquet') GROUP BY pr) SELECT a, b, count(*) n FROM g, UNNEST(c) t1(a), UNNEST(c) t2(b) WHERE a<b GROUP BY a,b ORDER BY n DESC LIMIT 100").df()\` ← .df() only on the ~100-row result.
- Always pass datasets={"main": df} to write_output using the ORIGINAL, COMPLETE DataFrame — do NOT pre-truncate it with df.head(...) / df.nlargest(...) / df.sample(...). write_output caps it to 5000 rows for you AND records the true total, which lets the dashboard tell the user when its interactive figures are based on a sample. Pre-truncating hides the total and biases the client-side aggregations.${
    hasWorkbookContext
      ? `
- Multiple CSV sheets from an Excel workbook are available in the sandbox.
- The primary sheet is at /data/input.csv. Additional sheets are in /data/sheets/.
- The exact file path for each sheet is listed in the "Workbook Context" section of the user prompt. Use EXACTLY those paths — do not guess or modify file names.
- Use pd.merge() or pd.concat() to join sheets as needed.
- Detected relationships between sheets are provided in the user prompt below.
- Only join on columns specified in the relationships unless the user explicitly asks otherwise.`
      : ""
  }
- For all numeric results: round currency to 2dp, percentages to 1-2dp, ratios to 3dp, counts to integers. Avoid raw float precision (e.g. 0.33333333333 → 0.33).
- Use snake_case for ALL keys in results and chart_data (e.g. "on_track" not "On Track", "total_revenue_usd" not "Total Revenue (USD)"). This ensures reliable placeholder resolution in the UI layer.
- Result KEYS must be strict identifiers: ONLY [a-z0-9_]. When a key includes a category VALUE (e.g. a per-segment metric like the threshold for instance type "m7i.4xlarge,on-demand"), SANITIZE that value into the key first — lowercase and replace every run of non-alphanumerics with a single "_" (e.g. re.sub(r"[^a-z0-9]+","_", value.lower()).strip("_") → "m7i_4xlarge_on_demand"). A "." "," "-" or space left in a key BREAKS placeholder resolution in the UI (the key gets truncated at the punctuation and a raw fragment leaks into the prose). Prefer a per-segment TABLE (chart_data rows) over many value-named scalar keys when there are several segments.
- Include units in result keys where possible (e.g. "revenue_usd", "growth_pct", "volume_shares").
- If the input data has an \`analysis_scope\` column (a constant note the SQL added to disclose that it bounded the query's scope to fit cost limits), carry its value through: set results["analysis_scope"] to that string. It is provenance for the reader, not a metric — do not chart it or treat it as data.${domain ? `\n${buildDomainLayer(domain)}` : ""}
- Output ONLY the Python code. No markdown fencing, no explanation.`;
}

// ── Synthetic sample row generation ───────────────────────────────

function generateSyntheticValues(col: CSVColumn, count: number): string[] {
  const m = col.meta;

  switch (m.kind) {
    case "number":
      return generateSyntheticNumeric(m, count);
    case "date":
      return generateSyntheticDate(m, count);
    case "categorical":
      return generateSyntheticCategorical(m, count);
    case "boolean":
      return generateSyntheticBoolean(m, count);
  }
}

function generateSyntheticNumeric(m: NumericMeta, count: number): string[] {
  // Use percentile spread: min, p25, median, p75, max
  const spread = [m.min, m.p25, m.median, m.p75, m.max];
  const values = spread.slice(0, count);
  // Pad if needed
  while (values.length < count) {
    values.push(m.mean);
  }

  return values.map((v) => {
    let s = m.is_integer ? String(Math.round(v)) : v.toFixed(m.decimal_precision);
    if (m.is_currency && m.currency_symbol) s = `${m.currency_symbol}${s}`;
    if (m.is_percentage) s = `${s}%`;
    return s;
  });
}

function generateSyntheticDate(m: DateMeta, count: number): string[] {
  const minTs = Date.parse(m.min_date);
  const maxTs = Date.parse(m.max_date);
  if (isNaN(minTs) || isNaN(maxTs)) {
    return Array(count).fill(m.min_date || "2024-01-01");
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? minTs : minTs + (maxTs - minTs) * (i / (count - 1));
    const d = new Date(t);
    // Format based on detected format
    if (m.format.includes("HH:mm:ss")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 19));
    } else if (m.format.includes("HH:mm")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 16));
    } else {
      values.push(d.toISOString().split("T")[0]);
    }
  }
  return values;
}

function generateSyntheticCategorical(m: CategoricalMeta, count: number): string[] {
  // Pick from known values
  let pool: string[] = [];
  if (m.distinct_values && m.distinct_values.length > 0) {
    pool = m.distinct_values;
  } else if (m.top_values && m.top_values.length > 0) {
    pool = m.top_values.map((t) => t.value);
  }

  if (pool.length === 0) {
    // Fallback based on pattern
    if (m.detected_pattern === "email")
      pool = ["user1@example.com", "user2@example.com", "user3@example.com"];
    else if (m.detected_pattern === "url")
      pool = ["https://example.com/a", "https://example.com/b"];
    else if (m.detected_pattern === "uuid") pool = ["550e8400-e29b-41d4-a716-446655440000"];
    else pool = ["value_1", "value_2", "value_3", "value_4", "value_5"];
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(pool[i % pool.length]);
  }
  return values;
}

function generateSyntheticBoolean(m: BooleanMeta, count: number): string[] {
  let trueVal: string;
  let falseVal: string;
  switch (m.representation) {
    case "0/1":
      trueVal = "1";
      falseVal = "0";
      break;
    case "yes/no":
      trueVal = "yes";
      falseVal = "no";
      break;
    default:
      trueVal = "true";
      falseVal = "false";
  }

  // Ratio-based distribution
  const total = m.true_count + m.false_count;
  const trueRatio = total > 0 ? m.true_count / total : 0.5;
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(i / count < trueRatio ? trueVal : falseVal);
  }
  return values;
}

function generateSyntheticRows(schema: CSVSchema): Record<string, string>[] {
  const count = MAX_SAMPLE_ROWS;

  // Generate synthetic values per column
  const columnValues: Record<string, string[]> = {};
  for (const col of schema.columns) {
    columnValues[col.name] = generateSyntheticValues(col, count);
  }

  // Assemble into rows
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = {};
    for (const col of schema.columns) {
      row[col.name] = columnValues[col.name][i];
    }
    rows.push(row);
  }
  return rows;
}

// ── Data section based on mode ────────────────────────────────────

function formatDataSection(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    const sampleRowsJson = JSON.stringify(schema.sample_rows.slice(0, MAX_SAMPLE_ROWS), null, 2);
    return `\n## Sample Rows\n${sampleRowsJson}`;
  }

  const syntheticRows = generateSyntheticRows(schema);
  const syntheticJson = JSON.stringify(syntheticRows, null, 2);
  return `\n## Sample Rows\n${syntheticJson}`;
}

// ── User prompt (initial query) ───────────────────────────────────

export function buildCodeGenUserPrompt(
  schema: CSVSchema,
  question: string,
  mode: SchemaMode = "metadata",
  workbookContext?: string,
  localFileContext?: string,
  sandboxMemoryGb?: string | null
): string {
  return `${buildCodeGenSchemaBlock(schema, mode, workbookContext, localFileContext, sandboxMemoryGb)}
## Question
${question}`;
}

/**
 * Geospatial code-gen guidance — DELEGATES to the skills registry (the former
 * monolithic recipe now lives in src/lib/skills/builtin/ as three built-in
 * skills; an equivalence snapshot locks the emitted text). Kept as a named
 * export with the original signature because (a) the cached schema block calls
 * it with schema-only context, and (b) the RETRY path must re-inject the SAME
 * text — both now flow from the one registry. Schema-triggered skills only:
 * question-triggered (user) skills inject via the un-cached question tail in
 * the orchestrator, never into the cached prefix this feeds.
 */
export function buildGeospatialGuidance(
  schema: CSVSchema,
  sandboxMemoryGb?: string | null
): string {
  return activateSkills({ schema }).prefixGuidance({ schema, sandboxMemoryGb });
}

/**
 * The schema/context block shared by the single-shot and chat code-gen prompts.
 * It's stable for a given dataset, so callers send it as a cached content part
 * (the prefix) with the variable question appended as a separate, uncached part
 * — that's the Anthropic prompt-cache breakpoint for the user prompt. Returns
 * the exact text that previously lived inline in buildCodeGenUserPrompt minus
 * the trailing "## Question" tail.
 */
export function buildCodeGenSchemaBlock(
  schema: CSVSchema,
  mode: SchemaMode = "metadata",
  workbookContext?: string,
  localFileContext?: string,
  sandboxMemoryGb?: string | null
): string {
  const columnDescriptions = formatColumns(schema, mode);

  const geomType = schema.geojson_geometry_type ?? "unknown";
  const isPolygonGeom = geomType === "Polygon" || geomType === "MultiPolygon";
  const geojsonSection = schema.has_geojson
    ? `\n## GeoJSON Source
This data was uploaded as a GeoJSON file. Geometry type: ${geomType}.
A GeoJSON file is available at "/data/input.geojson" alongside the tabular CSV.${
        isPolygonGeom
          ? `\nIMPORTANT: This contains polygon geometry. Pass the full GeoJSON FeatureCollection as chart_data["geojson"]. Do NOT extract centroids or use point markers — render the actual polygon boundaries.`
          : ""
      }\n`
    : "";

  const workbookSection = workbookContext ? `\n## Workbook Context\n${workbookContext}\n` : "";

  const correlationSection =
    schema.correlations && schema.correlations.length > 0
      ? `\n## Notable Correlations\n${schema.correlations.map((c) => `- ${c.col_a} ↔ ${c.col_b}: r=${c.pearson}`).join("\n")}\n`
      : "";

  const domainSection =
    schema.detected_domain && schema.detected_domain !== "general"
      ? `\nDetected data domain: ${schema.detected_domain}\n`
      : "";

  const warehouseSection =
    schema.source_type === "warehouse"
      ? `\nData source: ${schema.warehouse_type} warehouse, table: ${schema.warehouse_table}
Column types are database-native (high fidelity). The data has been loaded as CSV at /data/input.csv.\n`
      : "";

  const localFileSection = localFileContext ? `\n## Data Location\n${localFileContext}\n` : "";

  // Geospatial guidance (KD-tree / polygon / memory-safe recipe) — only when the
  // data has a geometry column. Extracted so the retry path re-injects the SAME
  // text (see buildGeospatialGuidance).
  const spatialSection = buildGeospatialGuidance(schema, sandboxMemoryGb);

  // User Python modules (data/user_lib) — preloaded into the sandbox and
  // advertised with extracted signatures. Stable per user_lib contents, so it
  // belongs in this cached prefix.
  const userModulesSection = buildUserModulesSection();

  const headerLabel = schema.source_type === "warehouse" ? "Data Schema" : "CSV Schema";

  return `## ${headerLabel}
Filename: ${schema.filename}
Rows: ${schema.row_count}${domainSection}${warehouseSection}${localFileSection}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}
${correlationSection}${geojsonSection}${spatialSection}${userModulesSection}${workbookSection}`;
}

// ── User prompt (chat follow-up) ──────────────────────────────────

function formatConversationTurns(turns: ConversationTurn[]): string {
  return turns
    .map((turn, i) => {
      const lines: string[] = [`### Turn ${i + 1}: "${turn.question}"`];

      const summary = turn.analysisSummary;
      if (summary) {
        const resultEntries = Object.entries(summary.resultKeys ?? {});
        if (resultEntries.length > 0) {
          lines.push(
            `Computed results: ${resultEntries.map(([k, t]) => `${k} (${t})`).join(", ")}`
          );
        }

        const chartEntries = Object.entries(summary.chartDataShapes ?? {});
        if (chartEntries.length > 0) {
          lines.push("Computed chart data:");
          for (const [k, shape] of chartEntries) {
            lines.push(`  - ${k}: ${shape.rows} rows, columns [${shape.columns.join(", ")}]`);
          }
        }
      }

      if (turn.specSummary) {
        lines.push(`Dashboard showed:\n${turn.specSummary}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/** The "Prior Analysis Context" block for chat follow-ups (empty when none). */
export function buildConversationHistorySection(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";
  return `## Prior Analysis Context
The user is asking a follow-up question. Here is what was analyzed previously:

${formatConversationTurns(turns)}

Generate fresh code that reads the same source data and addresses the new question.
Build on the prior analysis: if the user references previous results (e.g. "break that down by region", "also show trends"), use the context above to understand what "that" refers to and what was already computed.

`;
}

// ── Workbook context builder ──────────────────────────────────────

/**
 * Sanitize a sheet name for use as a file name.
 * Replaces spaces and special chars with underscores, keeps alphanumeric + dash + dot.
 */
export function sanitizeSheetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/_+/g, "_");
}

/**
 * Build workbook context string for LLM prompts.
 * @param sheetPaths - map of sheet name → exact file path in the sandbox
 *   When provided, the LLM is told exactly where each file lives.
 *   The first entry is the primary sheet at /data/input.csv.
 */
export function buildWorkbookContext(
  manifest: WorkbookManifest,
  mode: SchemaMode,
  sheetPaths?: Map<string, string>
): string {
  const lines: string[] = [];
  lines.push(
    `This workbook has ${manifest.sheets.length} sheets. The user wants cross-sheet analysis.`
  );
  lines.push("");

  // List exact file paths so the LLM doesn't have to guess
  if (sheetPaths && sheetPaths.size > 0) {
    lines.push("### File Paths");
    for (const [sheetName, filePath] of sheetPaths) {
      lines.push(`- "${sheetName}" → ${filePath}`);
    }
    lines.push("");
  }

  for (const sheet of manifest.sheets) {
    const pathNote = sheetPaths?.get(sheet.name);
    const pathSuffix = pathNote ? ` — file: ${pathNote}` : "";
    lines.push(`### Sheet: ${sheet.name} (${sheet.schema.row_count} rows${pathSuffix})`);
    lines.push("Columns:");
    for (const col of sheet.schema.columns) {
      if (mode === "metadata") {
        lines.push(formatColumnMeta(col));
      } else {
        lines.push(formatColumnSample(col));
      }
    }
    lines.push("");
  }

  if (manifest.relationships.length > 0) {
    lines.push("### Detected Relationships");
    for (const rel of manifest.relationships) {
      if (rel.confidence < 0.5) continue;
      const pkFk = rel.isPrimaryKeyCandidate
        ? rel.isForeignKeyCandidate
          ? ", PK\u2194FK"
          : ", PK"
        : rel.isForeignKeyCandidate
          ? ", FK"
          : "";
      lines.push(
        `- ${rel.sourceSheet}.${rel.sourceColumn} \u2194 ${rel.targetSheet}.${rel.targetColumn} (${rel.matchType}, confidence: ${rel.confidence.toFixed(2)}${pkFk})`
      );
    }
  }

  return lines.join("\n");
}

// ── Retry prompt ──────────────────────────────────────────────────

/**
 * Build a retry prompt that includes ALL prior failed attempts, not just the
 * most recent one. Helps the LLM avoid going in circles — each attempt adds
 * a constraint of "this thing didn't work either."
 *
 * The list is in attempt order: priorAttempts[0] is the original failed
 * code, priorAttempts[N-1] is the most-recent failed retry.
 */
export function buildRetryPromptMulti(
  priorAttempts: { code: string; error: string }[],
  schema?: CSVSchema
): string {
  if (priorAttempts.length === 0) {
    throw new Error("buildRetryPromptMulti requires at least one prior attempt");
  }

  const schemaContext = schema
    ? `\n## Available Columns\nFilename: ${schema.filename} (${schema.row_count} rows)\n${schema.columns.map((c) => `- ${c.name} (${c.dtype})`).join("\n")}\n\nUse EXACTLY these column names — they are case-sensitive.\n`
    : "";

  const attemptHistory = priorAttempts
    .map((a, i) => {
      const label =
        priorAttempts.length === 1
          ? "Your previous code"
          : i === priorAttempts.length - 1
            ? `Attempt ${i + 1} (most recent)`
            : `Attempt ${i + 1}`;
      // Truncate each prior code/error to keep total prompt size sane
      const codeBlock =
        a.code.length > 4000 ? a.code.slice(0, 4000) + "\n# ...[truncated]" : a.code;
      const errBlock =
        a.error.length > 1500 ? a.error.slice(0, 1500) + "\n[...truncated]" : a.error;
      return `### ${label}\n\nCode:\n\`\`\`python\n${codeBlock}\n\`\`\`\n\nError:\n\`\`\`\n${errBlock}\n\`\`\``;
    })
    .join("\n\n");

  const reflectionPrompt =
    priorAttempts.length > 1
      ? `\n\n## Reflection\nYou have already tried ${priorAttempts.length} times. Each prior attempt failed for the reason shown. Do NOT repeat the same fix that already failed — review the errors and make a substantively different change.\n`
      : "";

  return `Your previous code failed. Fix it.

${attemptHistory}${schemaContext}${reflectionPrompt}`;
}

/**
 * Static retry guidance ("Common fixes"). Lives in the retry SYSTEM prompt (and
 * is cached) rather than the per-attempt user prompt, so it isn't re-billed on
 * every retry / sub-question. Appended after the base retry system instruction.
 */
export const RETRY_GUIDANCE = `## Common fixes
- **KeyError / column not found**: use the EXACT column name from the Available Columns in the prompt (case-sensitive). For case-insensitive matching: \`col = next((c for c in df.columns if c.lower() == "target".lower()), None)\`.
- **TypeError on aggregation**: column is stored as strings — coerce with \`pd.to_numeric(df[col], errors="coerce")\` first.
- **ValueError: could not convert string to float**: clean before parsing — strip currency symbols, commas: \`df[col].str.replace(r'[$,]', '', regex=True).astype(float)\`.
- **NaN in JSON output / serialization / to_dict errors**: do NOT serialize yourself — call the preloaded \`write_output(results=, chart_data=, datasets=)\`; it coerces NaN/Inf/numpy/Timestamp/Decimal for you.
- **"no results or chart data" (degenerate/empty output)**: you must call \`write_output(...)\` with at least one entry in BOTH \`results\` and \`chart_data\`. If a filter emptied the frame, check \`df[col].unique()\` and widen it; then populate and emit.
- **qcut "Bin edges must be unique" / ValueError on binning**: use the preloaded \`safe_qcut(series, q)\` instead of \`pd.qcut\`.
- **DuckDB "OutOfRangeException: Overflow in multiplication of DECIMAL(18)"**: an interpolated high-precision float constant (e.g. \`{coslat0}\` = 0.7071067811865476) is typed DECIMAL and DECIMAL×DECIMAL overflowed. Cast interpolated coordinate/scale constants to \`::DOUBLE\` — \`({coslat0}::DOUBLE)*111320.0\` — or keep \`cos({lat0})\` inside the SQL (its result is DOUBLE). Do NOT cast to a bigger DECIMAL; use DOUBLE.
- **TypeError on .diff()/.pct_change()/.corr()**: wrap with the preloaded \`numeric(df)\` (or \`to_num(series)\`) first — the frame has non-numeric columns.
- **AttributeError 'Series' object has no attribute X**: you're calling a DataFrame method on a Series — use \`df[[col1, col2]]\` (note double brackets) to get a DataFrame.
- **FileNotFoundError for sheets**: use the exact paths from the workbook context.
- **Empty result / 0 rows after filter**: your filter may be too strict; check the actual values in the column with \`df[col].unique()\` first.
- **AssertionError**: DELETE the failing \`assert\`. Do NOT assert a computed value equals a hard-coded number (e.g. \`assert corr == 0.785\`) — it crashes on valid data. Just compute the value and put it in the output. Keep only structural checks like \`assert len(df) > 0\`.
- **ImportError / cannot import name**: you used a function that doesn't exist (e.g. \`auc_score\` — it's \`sklearn.metrics.auc\`). Use the correct name, or compute it with numpy/pandas/scipy instead of a guessed import.
- **Code timed out / Out of memory ("Killed" / OOM)**: the dataset is large. The fix DEPENDS ON THE QUESTION — do NOT reflexively downsample:
  - For a SUPERLATIVE / nearest-neighbor / most-isolated / farthest / top-N-by-a-derived-measure question, sampling or \`df.head()\` would DROP the very extreme you are asked to find — NEVER do it. Keep ALL rows in scope and fix memory the RIGHT way: do the heavy filtering/aggregation in DuckDB SQL (it spills to disk), pull ONLY numeric coordinate columns into pandas for the KD-tree (\`SELECT rowid, lon, lat …\` — 2-3 numeric cols, so tens of millions fit), NEVER a string/struct column (the raw \`names\` struct is a top OOM cause), then hydrate the ~N winners by rowid (bounded region) or by coordinates (unbounded — per the WINNER HYDRATION rule in the recipe: one AND-only bbox query per winner, never OR'd boxes). Follow the Geospatial analysis recipe above exactly.
    - IF YOU ALREADY DID coordinates-only AND STILL OOM'd: the region is simply too big for an in-memory KD-tree — trimming another column will NOT help and retrying the direct approach will just OOM again later (the divergence trap). SWITCH to the DOESN'T-FIT counting strategy (COUNT per grid cell in DuckDB, branch-and-bound, pull only the sparse survivors). Gate it next time with \`assert_fits(N, cols=3)\` right after your COUNT(*), before the coords .df(), so this decision happens up front instead of after a kill.
  - For a plain distribution/plot that genuinely just needs fewer points, THEN aggregate in SQL or take a uniform sample — and disclose it in results["analysis_scope"].

Fix the code and return only the corrected Python script. No markdown fencing, no explanation.`;
