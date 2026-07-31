# Samples

Tracked copies of the sample skills referenced in
[`docs/creating-skills.md`](../docs/creating-skills.md). The live skill
directory (`data/skills/`) is gitignored, so these are the canonical sources.

## Installing

Copy a skill folder into `data/skills/` — it is live on the next question, no
restart needed:

```sh
cp -R samples/skills/cohort-retention data/skills/
```

## What each sample demonstrates

| Skill                | Domain                      | Demonstrates                                                                                                                               |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sales-analysis`     | Bundled sales demo CSV      | Column triggers, review rules, won-only correctness guards                                                                                 |
| `cohort-retention`   | Retention/cohorts           | DuckDB-first helper (matrix built in SQL), failure hint                                                                                    |
| `ab-experiment`      | Experiment readouts         | Question triggers, a review rule enforcing significance, stats helpers, `_private` functions                                               |
| `anomaly-windows`    | Spike/outlier detection     | Question-only triggers, robust-stats helper, chart-visibility guidance                                                                     |
| `spatial-clustering` | Overture building centroids | A named statistical test as a helper (Clark-Evans index via scipy cKDTree), sampling-bias review rule, layering on the built-in geo skills |

Each skill is a folder with a `SKILL.md` (frontmatter: name, description,
triggers, optional review rules and failure hints, then prompt guidance) and an
optional sibling `helpers.py`, which ships to the sandbox as
`skill_lib.<skill_name_with_underscores>`. See `docs/creating-skills.md` for
the full authoring guide.
