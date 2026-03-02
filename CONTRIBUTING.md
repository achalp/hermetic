# Contributing to CSV Insight

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

1. Fork and clone the repository
2. Run `./start.sh` to set up dependencies and start the dev server
3. See the [README](README.md) for full setup details

## Making Changes

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes
3. Ensure code quality passes:
   ```bash
   npm run lint
   npm run type-check
   npm test
   ```
4. Commit with a descriptive message:
   ```
   feat: add support for parquet files
   fix: handle empty CSV columns gracefully
   docs: update API route documentation
   ```
5. Open a Pull Request against `main`

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
    sandbox/     Code execution (Docker / E2B / microsandbox)
    saved/       Saved visualization storage
```

## Adding a New Chart Type

1. Create the component in `src/components/charts/`
2. Register it in `src/components/registry.tsx`
3. Add the schema to `src/lib/catalog.ts`
4. Add chart colors via `useChartColors()` or `useColorMap()` from `chart-theme.ts`

## Adding a New Theme

1. Add the theme ID to `ThemeId` in `src/lib/theme-context.tsx`
2. Add CSS variable overrides (light + dark) in `src/app/globals.css`
3. Add a chart color palette in `src/lib/chart-theme.ts` (`THEME_CHART_COLORS`)
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
