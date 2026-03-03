# Test Prompts for Hermetic

Each section targets a specific test CSV and contains 2–3 prompts of increasing complexity.
The prompts are designed to exercise different chart types — including the 20 newly added ones — and varying levels of analytical depth.

---

## 01 — SaaS MRR (`01-saas-mrr.csv`)

**Domain:** B2B SaaS revenue metrics
**Rows:** 36 · **Columns:** 7
**Target charts:** StreamChart, WaterfallChart, BumpChart, AreaChart, StatCard

### Prompt 1a — Simple MRR overview

> Show me total MRR by month (stacked by plan). Include stat cards for latest-month total MRR, customer count, and blended ARPU.

### Prompt 1b — Net-new waterfall

> Build a waterfall chart showing how MRR changed month-over-month for 2024. Start with January total MRR as the absolute base, then show each month's net change (new + expansion − churn) as relative steps, with December as a total bar. Add a stream chart below showing the evolution of new, expansion, and churn MRR over time.

### Prompt 1c — Plan ranking over time

> Create a bump chart ranking the three plans by total MRR each month. Which plan grew the fastest in relative terms? Add a slope chart comparing each plan's January vs December MRR.

---

## 02 — Clinical Trial (`02-clinical-trial.csv`)

**Domain:** Pharma / clinical research
**Rows:** 40 · **Columns:** 14
**Target charts:** BoxPlot, ViolinChart, DumbbellChart, SlopeChart, LineChart, DataTable

### Prompt 2a — Treatment vs Placebo efficacy

> Compare the distribution of week-12 scores between Treatment and Placebo arms using violin plots. Show stat cards for median score in each arm and the p-value of a Mann-Whitney test.

### Prompt 2b — Score trajectory

> Plot the mean score trajectory (baseline → week 4 → week 8 → week 12) as a line chart with one line per arm. Add a dumbbell chart showing each patient's baseline vs week-12 score, colored by arm.

### Prompt 2c — Site-level deep dive

> Build a dashboard with: (1) box plots of week-12 scores by site, (2) a data table of adverse events with severity, (3) stat cards for overall dropout rate and adverse event rate. Highlight any site that looks like an outlier.

---

## 03 — E-commerce Orders (`03-ecommerce-orders.csv`)

**Domain:** Online retail operations
**Rows:** 30 · **Columns:** 15
**Target charts:** BarChart, PieChart, SankeyChart, TreemapChart, ScatterChart

### Prompt 3a — Revenue breakdown

> Show revenue by product category (bar chart) and by region (pie chart). Include stat cards for total revenue, average order value, and return rate.

### Prompt 3b — Customer flow

> Create a Sankey diagram showing the flow from region → product category → payment method, with link values as revenue. Which path generates the most revenue?

### Prompt 3c — Category treemap with scatter

> Build a treemap of revenue by category and product name. Below it, show a scatter plot of unit price vs quantity with points colored by category. Are higher-priced items ordered in lower quantities?

---

## 04 — Energy Grid (`04-energy-grid.csv`)

**Domain:** Power generation / utilities
**Rows:** 48 · **Columns:** 10
**Target charts:** StreamChart, AreaChart, HeatMap, RadarChart, SunburstChart

### Prompt 4a — Generation mix over time

> Show a stacked area chart of power generation by source over time. Add stat cards for total generation, peak demand, and average price.

### Prompt 4b — Renewable vs fossil radar

> Create a radar chart comparing North and South regions across these metrics: solar generation, wind generation, gas generation, CO2 emissions, and average price. Which region is greener?

### Prompt 4c — Energy source sunburst

> Build a sunburst chart with region as the inner ring and energy source as the outer ring, sized by total generation. Add a heatmap of generation by source and time-of-day.

---

## 05 — Student Performance (`05-student-performance.csv`)

**Domain:** Education analytics
**Rows:** 25 · **Columns:** 16
**Target charts:** ParallelCoordinates, ScatterChart, BoxPlot, RadarChart, BarChart

### Prompt 5a — Score distributions

> Show box plots for each subject (math, science, english, history) side by side. Include the mean GPA by school type as a bar chart.

### Prompt 5b — Multi-factor exploration

> Create a parallel coordinates plot with dimensions: study_hours_weekly, sleep_hours, math_score, science_score, gpa — colored by family_income_bracket. Do students from high-income families cluster differently?

### Prompt 5c — Student profile radar

> Build a radar chart comparing average scores (math, science, english, history) across the three income brackets. Add a scatter plot of study hours vs GPA colored by whether the student has tutoring.

---

## 06 — Supply Chain (`06-supply-chain.csv`)

**Domain:** Global logistics
**Rows:** 20 · **Columns:** 19
**Target charts:** SankeyChart, BulletChart, DumbbellChart, BarChart, MapView

### Prompt 6a — Shipping overview

> Show a bar chart of shipment cost by carrier, and stat cards for total shipments, average transit time, delay rate, and damage rate.

### Prompt 6b — On-time performance bullets

> Create a bullet chart showing actual vs quoted delivery days for each warehouse. The ranges should be [quoted_days, quoted_days * 1.1, quoted_days * 1.25] to show green/yellow/red zones. Which warehouses are underperforming?

### Prompt 6c — Origin-destination flow

> Build a Sankey diagram from origin → mode → destination with link values as shipment cost. Add a dumbbell chart comparing quoted vs actual delivery days per shipment, sorted by the gap.

---

## 07 — GitHub Contributions (`07-github-contributions.csv`)

**Domain:** Developer productivity
**Rows:** 31 · **Columns:** 11
**Target charts:** CalendarChart, StreamChart, BumpChart, BarChart, HeatMap

### Prompt 7a — Contribution calendar

> Show a calendar heatmap of total commits per day across all contributors (January 2024). Which days had the most activity?

### Prompt 7b — Contributor stream

> Create a stream chart showing lines_added per day broken down by contributor. Add a bump chart ranking contributors by weekly commit count for weeks 1–4.

### Prompt 7c — Repo activity heatmap

> Build a heatmap of commits by contributor (y-axis) and day-of-week (x-axis). Show a bar chart of total PRs merged by contributor. Who is the most prolific reviewer?

---

## 08 — Marketing Attribution (`08-marketing-attribution.csv`)

**Domain:** Digital marketing / growth
**Rows:** 15 · **Columns:** 16
**Target charts:** MarimekkoChart, BulletChart, ScatterChart, BarChart, SlopeChart

### Prompt 8a — Channel efficiency

> Show a scatter plot of spend vs revenue per campaign, with point size proportional to conversions. Color by channel. Label the outliers. Add stat cards for total spend, total revenue, and blended ROAS.

### Prompt 8b — Budget vs spend bullets

> Create a bullet chart showing spend against budget for each campaign. Highlight campaigns that overspent. Add a bar chart of CPA by channel — which channel is most cost-efficient?

### Prompt 8c — Channel × segment marimekko

> Build a Marimekko chart where width = total spend per channel and segments = audience_segment breakdown within each channel. Which channel-segment combination is the biggest investment?

---

## 09 — ML Model Evaluation (`09-ml-model-eval.csv`)

**Domain:** Machine learning / MLOps
**Rows:** 25 · **Columns:** 17
**Target charts:** ConfusionMatrix, RocCurve, ShapBeeswarm, DecisionTree, ParallelCoordinates

### Prompt 9a — Confusion matrix and metrics

> Show a confusion matrix for the model predictions (actual vs predicted). Calculate and display accuracy, precision, recall, and F1 as stat cards. Normalize the matrix to percentages.

### Prompt 9b — SHAP feature importance

> Create a SHAP beeswarm plot showing feature importance. x = SHAP value, y = feature, color = feature value. Which features drive approvals vs denials the most?

### Prompt 9c — Full model report

> Build a comprehensive model evaluation dashboard: (1) normalized confusion matrix, (2) ROC curve with AUC, (3) SHAP beeswarm, (4) parallel coordinates plot of the misclassified samples across all features. What patterns do the misclassifications share?

---

## 10 — Real Estate (`10-real-estate.csv`)

**Domain:** Residential real estate
**Rows:** 15 · **Columns:** 24
**Target charts:** ScatterChart, BoxPlot, MapView, BarChart, DumbbellChart

### Prompt 10a — Price analysis

> Show a scatter plot of sqft vs sold_price colored by city. Add box plots of sold_price by property_type. Include stat cards for median price, average days on market, and average price per sqft.

### Prompt 10b — Map with price comparison

> Plot all listings on a map using lat/lng, with marker labels showing the sold price. Add a dumbbell chart comparing list_price vs sold_price for each listing — which properties sold above asking?

### Prompt 10c — Agent performance

> Build a bar chart of total sales volume by agent. Show a slope chart comparing each agent's average days-on-market vs average sale-to-list ratio. Who is the top-performing agent?

---

## 11 — HR Workforce (`11-hr-workforce.csv`)

**Domain:** People analytics / HR
**Rows:** 20 · **Columns:** 20
**Target charts:** ChordChart, BulletChart, BoxPlot, TreemapChart, RadarChart

### Prompt 11a — Compensation overview

> Show a box plot of salary by department. Add stat cards for average salary, headcount, and percentage of employees rated "Exceeds". Include a treemap of headcount by department and team.

### Prompt 11b — Attrition risk radar

> Create a radar chart comparing employees at High vs Low attrition risk across: satisfaction_score, engagement_score, salary (normalized), training_hours, and tenure_years. What differentiates them?

### Prompt 11c — Org mobility chord

> Build a chord diagram showing the number of employees that connect departments (simulate cross-department collaboration based on location overlap). Add bullet charts showing each department's average performance rating against a target of 4.0.

---

## 12 — IoT Sensors (`12-iot-sensors.csv`)

**Domain:** Smart buildings / facilities
**Rows:** 30 · **Columns:** 16
**Target charts:** HeatMap, LineChart, BeeswarmChart, RidgelineChart, BarChart

### Prompt 12a — Environmental overview

> Show line charts of temperature and CO2 over time, faceted by zone. Add stat cards for average temperature, max CO2, and total power consumption.

### Prompt 12b — Distribution comparison

> Create a ridgeline plot of temperature distributions by zone. Add a beeswarm chart of CO2 readings by zone — which zones regularly exceed 700 ppm?

### Prompt 12c — Alert analysis

> Build a heatmap of alert counts by zone (y-axis) and time-of-day (x-axis). Show a bar chart of total power consumption by zone. Are the high-alert zones also the highest power consumers?

---

## 13 — Personal Finance (`13-personal-finance.csv`)

**Domain:** Consumer budgeting
**Rows:** 50 · **Columns:** 11
**Target charts:** WaterfallChart, SunburstChart, CalendarChart, PieChart, BarChart

### Prompt 13a — Monthly spending summary

> Show a pie chart of spending by category for January. Include stat cards for total income, total expenses, and net savings.

### Prompt 13b — Income-to-savings waterfall

> Build a waterfall chart starting with total income as absolute, each expense category as a negative relative step, and net savings as the total. Add a sunburst chart breaking spending into category → subcategory.

### Prompt 13c — Budget vs actual

> Create a bar chart comparing budget_amount vs actual spend per category. Flag categories where actual exceeds budget. Add a calendar heatmap of daily spending intensity across both months.

---

## 14 — Sports League (`14-sports-league.csv`)

**Domain:** Football / soccer analytics
**Rows:** 16 · **Columns:** 25
**Target charts:** ScatterChart, RadarChart, BumpChart, ChordChart, BarChart

### Prompt 14a — Team performance overview

> Show a bar chart of total goals scored by team (home + away). Add stat cards for highest-scoring match, average attendance, and average goals per match.

### Prompt 14b — xG vs actual scatter

> Create a scatter plot of expected goals (xG) vs actual goals for each team-match, colored by home/away. Add a regression line. Are teams over- or under-performing their xG?

### Prompt 14c — Head-to-head chord + radar

> Build a chord diagram where the matrix represents goals scored between teams (team[i] → team[j] = goals i scored against j). Add a radar chart comparing Arsenal, Man City, and Liverpool across: goals scored, possession, shots on target, clean sheets, and xG.
