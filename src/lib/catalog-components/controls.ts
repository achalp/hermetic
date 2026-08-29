/**
 * Component catalog entries — one slice of the former catalog.ts god
 * module (L7). Merged by spread in ../catalog.ts; order is irrelevant.
 */
import { z } from "zod";

export const catalogControls = {
  Annotation: {
    props: z.object({
      icon: z.enum(["alert", "info", "trend", "check", "flag"]).nullable(),
      title: z.string(),
      content: z.string(),
      severity: z.enum(["info", "warning", "success", "error"]).nullable(),
      // Optional plain-language explanation behind a "What does this mean?" reveal —
      // keeps the callout short + human while the technical detail is one click away.
      details: z.string().nullable().optional(),
      detailsLabel: z.string().nullable().optional(),
    }),
    description: "Callout for highlighting a specific finding, outlier, or caveat.",
  },
  TrendIndicator: {
    props: z.object({
      label: z.string(),
      current: z.number(),
      previous: z.number(),
      format: z.enum(["number", "currency", "percent"]).nullable(),
      precision: z.number().nullable(),
    }),
    description: "Compact element showing directional change between two values.",
  },
  ChartImage: {
    props: z.object({
      src: z.string(),
      alt: z.string(),
      caption: z.string().nullable(),
      width: z.number().nullable(),
    }),
    description: "Renders a base64 image from the sandbox (heatmaps, correlation matrices, etc.).",
  },
  SelectControl: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
      placeholder: z.string().nullable(),
    }),
    description:
      "Dropdown select for filtering data. Bind value with $bindState to a /filters/<column_name> path (e.g. /filters/region). The control automatically triggers a server re-analysis when the selection changes. Set the initial value in spec.state at the same path.",
  },
  NumberInput: {
    props: z.object({
      label: z.string(),
      value: z.number(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      step: z.number().nullable(),
    }),
    description:
      "Numeric input for threshold or parameter controls. Bind value with $bindState to a /filters/<param_name> path. Automatically triggers server re-analysis on change. Set initial value in spec.state.",
  },
  ToggleSwitch: {
    props: z.object({
      label: z.string(),
      checked: z.boolean(),
    }),
    description:
      "Toggle switch for boolean filters. Bind checked with $bindState to a /filters/<flag_name> path. Automatically triggers server re-analysis on toggle. Set initial value in spec.state.",
  },
  DataController: {
    props: z.object({
      source: z.object({
        statePath: z.string().optional(),
        fromState: z.record(z.string(), z.string()).optional(),
      }),
      scope_note: z.string().nullable().optional(),
      filters: z.array(
        z.object({
          key: z.string(),
          column: z.string(),
          bindTo: z.string(),
          label: z.string(),
          allowAll: z.boolean(),
          dependsOn: z.array(z.string()).nullable(),
        })
      ),
      pipeline: z.array(z.record(z.string(), z.unknown())),
      outputs: z.array(
        z.object({
          statePath: z.string(),
          format: z.enum(["rows", "pieData", "scatterData", "stats"]).nullable(),
          pipeline: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
          labelColumn: z.string().nullable(),
          valueColumn: z.string().nullable(),
          xColumn: z.string().nullable(),
          yColumn: z.string().nullable(),
          groupColumn: z.string().nullable(),
        })
      ),
    }),
    slots: ["default"],
    description:
      'Client-side data pipeline controller. Two source modes: (1) source.statePath reads a dataset array from state for filtering/aggregation dashboards. (2) source.fromState maps column names to scalar state paths (e.g. {"units":"/inputs/units","price":"/inputs/price"}) to build a reactive single-row dataset — use this for scenario planners, calculators, and what-if tools where NumberInput changes should update StatCards. Pipeline compute ops: multiply(a,b), add(a,b), subtract(a,b), percentOf(a,b) = a*b/100, percent(a,b) = a/b*100, diff(a,b), ratio(a,b), round(col,n). Use format "stats" on outputs so StatCards can bind to individual fields.',
  },
  FormController: {
    props: z.object({
      fields: z.array(
        z.object({
          key: z.string(),
          bindTo: z.string(),
          validation: z.array(z.record(z.string(), z.unknown())).nullable(),
        })
      ),
      steps: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            fields: z.array(z.string()),
          })
        )
        .nullable(),
      submit: z.object({
        endpoint: z.string(),
        method: z.string().nullable(),
        onSuccessStatePath: z.string().nullable(),
        onErrorStatePath: z.string().nullable(),
      }),
    }),
    slots: ["default"],
    description:
      "Structured form with validation, optional multi-step wizard, and submit handling. Wraps form field children (TextInput, TextArea, SelectControl, NumberInput). Validates on step advance and submit, POSTs collected values to endpoint.",
  },
  TextInput: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      type: z.enum(["text", "email", "password", "url"]).nullable(),
      placeholder: z.string().nullable(),
    }),
    description:
      "Text input field for forms. Bind value with $bindState. Use inside FormController.",
  },
  TextArea: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      placeholder: z.string().nullable(),
      rows: z.number().nullable(),
    }),
    description:
      "Multi-line text area for forms. Bind value with $bindState. Use inside FormController.",
  },
  DatePicker: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      type: z.enum(["date", "datetime-local"]).nullable(),
      min: z.string().nullable(),
      max: z.string().nullable(),
    }),
    description:
      'Date picker. Bind value with $bindState to a /filters/<column_name> path; the value is an ISO date string ("YYYY-MM-DD" for type "date", "YYYY-MM-DDTHH:MM" for "datetime-local"). Use inside DataController for date-column filters.',
  },
  Slider: {
    props: z.object({
      label: z.string(),
      value: z.number(),
      min: z.number(),
      max: z.number(),
      step: z.number().nullable(),
      format: z.enum(["currency", "percent", "number"]).nullable(),
    }),
    description:
      'Single-value numeric slider with thumb. Bind value with $bindState to a /filters/<param> path. Format hint controls the displayed value: "currency" prefixes $, "percent" suffixes %, "number" uses locale formatting.',
  },
  RangeSlider: {
    props: z.object({
      label: z.string(),
      value: z.tuple([z.number(), z.number()]),
      min: z.number(),
      max: z.number(),
      step: z.number().nullable(),
      format: z.enum(["currency", "percent", "number"]).nullable(),
    }),
    description:
      "Two-thumb numeric range slider. Bind value with $bindState to a /filters/<column> path; the value is a [low, high] tuple. Use with DataController filterRange op to filter a column to a numeric range.",
  },
  ColorPicker: {
    props: z.object({
      label: z.string(),
      value: z.string(),
    }),
    description:
      "Color input. Bind value with $bindState to a state path; value is a hex string like #3b82f6. Use for theming or visual customization controls.",
  },
  MultiSelect: {
    props: z.object({
      label: z.string(),
      value: z.array(z.string()),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
      placeholder: z.string().nullable(),
      maxVisibleOptions: z.number().nullable(),
    }),
    description:
      "Chip-style multi-select with type-ahead search. Bind value with $bindState to a /filters/<column> path; the value is a string[] array. Use with DataController filterIn op to keep rows where the column matches any of the selected values. Prefer over multiple SelectControls when the user is filtering on a single column with many options.",
  },
};
