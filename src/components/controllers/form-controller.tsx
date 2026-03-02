"use client";

import { useStateStore } from "@json-render/react";
import { useState, useCallback, type ReactNode, type FormEvent } from "react";

interface ValidationRule {
  rule: string;
  value?: unknown;
  message?: string;
}

interface StepDef {
  key: string;
  label: string;
  fields: string[];
}

interface SubmitDef {
  endpoint: string;
  method?: string | null;
  onSuccessStatePath?: string | null;
  onErrorStatePath?: string | null;
}

export interface FormControllerProps {
  fields: { key: string; bindTo: string; validation: Record<string, unknown>[] | null }[];
  steps: StepDef[] | null;
  submit: SubmitDef;
}

interface FormControllerComponentProps {
  props: FormControllerProps;
  children?: ReactNode;
}

function validateField(value: unknown, rules: ValidationRule[]): string | null {
  for (const rule of rules) {
    const strVal = value == null ? "" : String(value);

    switch (rule.rule) {
      case "required":
        if (!strVal.trim()) return rule.message ?? "This field is required";
        break;
      case "email":
        if (strVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strVal))
          return rule.message ?? "Invalid email address";
        break;
      case "minLength":
        if (strVal.length < Number(rule.value))
          return rule.message ?? `Minimum ${rule.value} characters`;
        break;
      case "maxLength":
        if (strVal.length > Number(rule.value))
          return rule.message ?? `Maximum ${rule.value} characters`;
        break;
      case "pattern":
        if (strVal && !new RegExp(String(rule.value)).test(strVal))
          return rule.message ?? "Invalid format";
        break;
      case "min":
        if (Number(strVal) < Number(rule.value))
          return rule.message ?? `Minimum value is ${rule.value}`;
        break;
      case "max":
        if (Number(strVal) > Number(rule.value))
          return rule.message ?? `Maximum value is ${rule.value}`;
        break;
    }
  }
  return null;
}

export function FormControllerComponent({ props, children }: FormControllerComponentProps) {
  const store = useStateStore();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const hasSteps = props.steps && props.steps.length > 0;

  // Read current step from state
  const currentStep = (store.get("/form/_currentStep") as number) ?? 0;
  const isSubmitting = (store.get("/form/_submitting") as boolean) ?? false;

  const validateFields = useCallback(
    (fieldKeys?: string[]): boolean => {
      const fieldsToValidate = fieldKeys
        ? props.fields.filter((f) => fieldKeys.includes(f.key))
        : props.fields;

      const newErrors: Record<string, string> = {};
      let valid = true;

      for (const field of fieldsToValidate) {
        if (!field.validation) continue;
        const value = store.get(field.bindTo);
        // Cast loose Record types to ValidationRule
        const rawRules = field.validation as unknown as ValidationRule[];
        // Handle "matches" rule that references another field
        const rules = rawRules.map((r) => {
          if (r.rule === "matches") {
            const otherField = props.fields.find((f) => f.key === String(r.value));
            if (otherField) {
              const otherValue = store.get(otherField.bindTo);
              if (value !== otherValue) {
                return { ...r, rule: "_mismatch" as const };
              }
            }
          }
          return r;
        });

        // Check for _mismatch pseudo-rule
        const mismatch = rules.find((r) => r.rule === "_mismatch");
        if (mismatch) {
          newErrors[field.key] = mismatch.message ?? "Fields do not match";
          valid = false;
          continue;
        }

        const error = validateField(value, rules);
        if (error) {
          newErrors[field.key] = error;
          valid = false;
        }
      }

      setErrors((prev) => {
        // Clear errors for fields being validated, set new ones
        const cleared = { ...prev };
        for (const f of fieldsToValidate) {
          delete cleared[f.key];
        }
        return { ...cleared, ...newErrors };
      });

      // Write errors to state for visibility conditions
      for (const field of fieldsToValidate) {
        store.set(`/form/_errors/${field.key}`, newErrors[field.key] ?? null);
      }

      return valid;
    },
    [props.fields, store]
  );

  const handleStepNext = useCallback(() => {
    if (!props.steps) return;
    const step = props.steps[currentStep];
    if (!step) return;

    if (validateFields(step.fields)) {
      store.set("/form/_currentStep", currentStep + 1);
    }
  }, [props.steps, currentStep, validateFields, store]);

  const handleStepBack = useCallback(() => {
    if (currentStep > 0) {
      store.set("/form/_currentStep", currentStep - 1);
    }
  }, [currentStep, store]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();

      // Validate current step fields (or all fields if no steps)
      const fieldsToValidate = hasSteps ? props.steps![currentStep]?.fields : undefined;
      if (!validateFields(fieldsToValidate)) return;

      // Collect all field values
      const payload: Record<string, unknown> = {};
      for (const field of props.fields) {
        payload[field.key] = store.get(field.bindTo);
      }

      store.set("/form/_submitting", true);
      store.set("/form/_submitted", false);

      try {
        const resp = await fetch(props.submit.endpoint, {
          method: props.submit.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          store.set("/form/_submitted", true);
          if (props.submit.onSuccessStatePath) {
            store.set(props.submit.onSuccessStatePath, data ?? true);
          }
        } else {
          const errData = await resp.json().catch(() => ({ error: resp.statusText }));
          if (props.submit.onErrorStatePath) {
            store.set(props.submit.onErrorStatePath, errData);
          }
        }
      } catch (err) {
        if (props.submit.onErrorStatePath) {
          store.set(props.submit.onErrorStatePath, {
            error: err instanceof Error ? err.message : "Network error",
          });
        }
      } finally {
        store.set("/form/_submitting", false);
      }
    },
    [props.fields, props.steps, props.submit, currentStep, hasSteps, validateFields, store]
  );

  const isLastStep = hasSteps ? currentStep === props.steps!.length - 1 : true;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Step navigation */}
      {hasSteps && (
        <div className="flex items-center gap-2 text-sm">
          {props.steps!.map((step, i) => (
            <div key={step.key} className="flex items-center gap-2">
              {i > 0 && <div className="h-px w-6 bg-border-default" />}
              <div
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 ${
                  i === currentStep
                    ? "bg-accent-subtle font-medium text-accent-text"
                    : i < currentStep
                      ? "text-success-text"
                      : "text-t-tertiary"
                }`}
              >
                <span className="text-xs font-bold">{i + 1}</span>
                <span>{step.label}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error display */}
      {Object.keys(errors).length > 0 && (
        <div className="rounded-lg border border-error-border bg-error-bg p-3 text-sm text-error-text">
          {Object.values(errors).map((msg, i) => (
            <p key={i}>{msg}</p>
          ))}
        </div>
      )}

      {/* Form fields (children) */}
      {children}

      {/* Action buttons */}
      <div className="flex gap-3 pt-2">
        {hasSteps && currentStep > 0 && (
          <button
            type="button"
            onClick={handleStepBack}
            className="border border-border-default px-4 py-2 text-sm font-medium text-t-secondary transition-colors hover:bg-surface-btn"
            style={{
              borderRadius: "var(--radius-button)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            Back
          </button>
        )}
        {hasSteps && !isLastStep ? (
          <button
            type="button"
            onClick={handleStepNext}
            className="bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            style={{
              borderRadius: "var(--radius-button)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            Next
          </button>
        ) : (
          <button
            type="submit"
            disabled={isSubmitting}
            className="bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            style={{
              borderRadius: "var(--radius-button)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
        )}
      </div>
    </form>
  );
}
