import { z } from "zod";
import type { DynamicValue, StateModel } from "./types";
import { DynamicValueSchema, resolveDynamicValue } from "./types";

/**
 * Confirmation dialog configuration
 */
export interface ActionConfirm {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
}

/**
 * Action success handler
 */
export type ActionOnSuccess =
  { navigate: string } | { set: Record<string, unknown> } | { action: string };

/**
 * Action error handler
 */
export type ActionOnError = { set: Record<string, unknown> } | { action: string };

/**
 * Action binding — maps an event to an action invocation.
 *
 * Used inside the `on` field of a UIElement:
 * ```json
 * { "on": { "press": { "action": "setState", "params": { "statePath": "/x", "value": 1 } } } }
 * ```
 */
export interface ActionBinding {
  /** Action name (must be in catalog) */
  action: string;
  /** Parameters to pass to the action handler */
  params?: Record<string, DynamicValue>;
  /** Confirmation dialog before execution */
  confirm?: ActionConfirm;
  /** Handler after successful execution */
  onSuccess?: ActionOnSuccess;
  /** Handler after failed execution */
  onError?: ActionOnError;
  /** Whether to prevent default browser behavior (e.g. navigation on links) */
  preventDefault?: boolean;
}

/**
 * @deprecated Use ActionBinding instead
 */
export type Action = ActionBinding;

/**
 * Schema for action confirmation
 */
export const ActionConfirmSchema = z.object({
  title: z.string(),
  message: z.string(),
  confirmLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
  variant: z.enum(["default", "danger"]).optional(),
});

/**
 * Schema for success handlers
 */
export const ActionOnSuccessSchema = z.union([
  z.object({ navigate: z.string() }),
  z.object({ set: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.string() }),
]);

/**
 * Schema for error handlers
 */
export const ActionOnErrorSchema = z.union([
  z.object({ set: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.string() }),
]);

/**
 * Full action binding schema
 */
export const ActionBindingSchema = z.object({
  action: z.string(),
  params: z.record(z.string(), DynamicValueSchema).optional(),
  confirm: ActionConfirmSchema.optional(),
  onSuccess: ActionOnSuccessSchema.optional(),
  onError: ActionOnErrorSchema.optional(),
  preventDefault: z.boolean().optional(),
});

/**
 * @deprecated Use ActionBindingSchema instead
 */
export const ActionSchema = ActionBindingSchema;

/**
 * Action handler function signature
 */
export type ActionHandler<TParams = Record<string, unknown>, TResult = unknown> = (
  params: TParams
) => Promise<TResult> | TResult;

/**
 * Action definition in catalog
 */
export interface ActionDefinition<TParams = Record<string, unknown>> {
  /** Zod schema for params validation */
  params?: z.ZodType<TParams>;
  /** Description for AI */
  description?: string;
}

/**
 * Resolved action with all dynamic values resolved
 */
export interface ResolvedAction {
  action: string;
  params: Record<string, unknown>;
  confirm?: ActionConfirm;
  onSuccess?: ActionOnSuccess;
  onError?: ActionOnError;
}

/**
 * Resolve all dynamic values in an action binding
 */
export function resolveAction(binding: ActionBinding, stateModel: StateModel): ResolvedAction {
  const resolvedParams: Record<string, unknown> = {};

  if (binding.params) {
    for (const [key, value] of Object.entries(binding.params)) {
      resolvedParams[key] = resolveDynamicValue(value, stateModel);
    }
  }

  // Interpolate confirmation message if present
  let confirm = binding.confirm;
  if (confirm) {
    confirm = {
      ...confirm,
      message: interpolateString(confirm.message, stateModel),
      title: interpolateString(confirm.title, stateModel),
    };
  }

  return {
    action: binding.action,
    params: resolvedParams,
    confirm,
    onSuccess: binding.onSuccess,
    onError: binding.onError,
  };
}

/**
 * Interpolate ${path} expressions in a string
 */
export function interpolateString(template: string, stateModel: StateModel): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = resolveDynamicValue({ $state: path }, stateModel);
    return String(value ?? "");
  });
}

/**
 * Context for action execution
 */
export interface ActionExecutionContext {
  /** The resolved action */
  action: ResolvedAction;
  /** The action handler from the host */
  handler: ActionHandler;
  /** Function to update state model */
  setState: (path: string, value: unknown) => void;
  /** Function to navigate */
  navigate?: (path: string) => void;
  /** Function to execute another action */
  executeAction?: (name: string) => Promise<void>;
}

/**
 * Execute an action with all callbacks
 */
export async function executeAction(ctx: ActionExecutionContext): Promise<void> {
  const { action, handler, setState, navigate, executeAction } = ctx;

  try {
    await handler(action.params);

    // Handle success
    if (action.onSuccess) {
      if ("navigate" in action.onSuccess && navigate) {
        navigate(action.onSuccess.navigate);
      } else if ("set" in action.onSuccess) {
        for (const [path, value] of Object.entries(action.onSuccess.set)) {
          setState(path, value);
        }
      } else if ("action" in action.onSuccess && executeAction) {
        await executeAction(action.onSuccess.action);
      }
    }
  } catch (error) {
    // Handle error
    if (action.onError) {
      if ("set" in action.onError) {
        for (const [path, value] of Object.entries(action.onError.set)) {
          // Replace $error.message with actual error
          const resolvedValue =
            typeof value === "string" && value === "$error.message"
              ? (error as Error).message
              : value;
          setState(path, resolvedValue);
        }
      } else if ("action" in action.onError && executeAction) {
        await executeAction(action.onError.action);
      }
    } else {
      throw error;
    }
  }
}

/**
 * Helper to create action bindings
 */
export const actionBinding = {
  /** Create a simple action binding */
  simple: (actionName: string, params?: Record<string, DynamicValue>): ActionBinding => ({
    action: actionName,
    params,
  }),

  /** Create an action binding with confirmation */
  withConfirm: (
    actionName: string,
    confirm: ActionConfirm,
    params?: Record<string, DynamicValue>
  ): ActionBinding => ({
    action: actionName,
    params,
    confirm,
  }),

  /** Create an action binding with success handler */
  withSuccess: (
    actionName: string,
    onSuccess: ActionOnSuccess,
    params?: Record<string, DynamicValue>
  ): ActionBinding => ({
    action: actionName,
    params,
    onSuccess,
  }),
};

/**
 * @deprecated Use actionBinding instead
 */
export const action = actionBinding;
