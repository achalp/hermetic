# Contributing to Hermetic

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. Fork and clone the repository
2. Run `./start.sh` to set up dependencies and start the dev server
3. See the [README](README.md) for full setup details

This project uses **pnpm 10** (the committed lockfile is `pnpm-lock.yaml`;
CI installs with `pnpm install --frozen-lockfile`). Don't use npm — it
ignores the pnpm lockfile and can produce a divergent dependency tree.

## Making Changes

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes
3. Ensure code quality passes — CI runs **all** of these, so run them locally:
   ```bash
   pnpm lint
   pnpm run ratchet      # modularization design-flaw counters (must not regress)
   pnpm run isolation    # package-closure proof (spec / contracts / renderer)
   pnpm run format:check
   pnpm type-check
   pnpm test
   ```
   A pre-push hook runs `pnpm type-check && pnpm test` automatically. **Never
   bypass it with `--no-verify`.** If your change touches prompts or the stream
   protocol, re-record the golden transcripts and commit the diff in the same
   PR — see [docs/golden-recording-pass.md](docs/golden-recording-pass.md).
4. Commit with a descriptive message:
   ```
   feat: add support for parquet files
   fix: handle empty CSV columns gracefully
   docs: update API route documentation
   ```
5. Open a Pull Request against `main`. We use branch → PR → squash-merge;
   every fix ships with a regression test.

## Code Style

- TypeScript strict mode is enforced
- Prettier handles formatting (runs automatically on commit via husky)
- ESLint enforces code quality rules
- Use semantic class names from the theme system (`bg-surface-0`, `text-t-primary`, etc.)

## Project Structure

```
src/
  app/           Next.js App Router (pages + API routes)
  components/    React components
    app/         Application shell components
    charts/      Chart implementations (Nivo, Plotly, maps)
    controllers/ Form/data controllers
    inputs/      Input components
  lib/           Business logic
    csv/         CSV parsing & schema extraction
    excel/       Excel file handling
    llm/         LLM integration & prompt generation
    pipeline/    Query orchestration pipeline
    sandbox/     Code execution (Docker)
    saved/       Saved visualization storage
```

## Adding a New Chart Type

1. Create the component in `src/components/charts/`
2. Register it in `src/components/registry.tsx`
3. Add the schema to `src/lib/catalog.ts`
4. Add chart colors via `useChartColors()` or `useColorMap()` from `src/components/theme/chart-theme.ts`

## Adding a New Theme

1. Add the theme ID to `ThemeId` in `src/components/theme/theme-context.tsx`
2. Add CSS variable overrides (light + dark) in `src/app/globals.css`
3. Add a chart color palette in `src/components/theme/chart-theme.ts` (`THEME_CHART_COLORS`)
4. Add trend colors in `THEME_TREND_COLORS`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include steps to reproduce for bugs
- Include the browser, OS, and Node.js version

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation if you change behavior
- Ensure CI passes before requesting review

## Data hygiene (enforced)

Never commit real datasets. `data/` is git-ignored except `data/test-fixtures/`,
and a guard (`scripts/check-data-hygiene.mjs`) runs in pre-commit and CI: it
rejects any path under `data/saved-vizs/` and any tracked path under `data/`
outside `data/test-fixtures/` (catching `git add -f` bypasses of .gitignore).
Sample data in tests must be synthetic. If the guard flags your change, the data
does not belong in the repository.
