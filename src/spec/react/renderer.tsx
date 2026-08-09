"use client";

import React, {
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";
import type { UIElement, Spec, ActionBinding, Catalog, SchemaDefinition } from "@/spec/core";
import {
  resolveElementProps,
  resolveBindings,
  resolveActionParam,
  evaluateVisibility,
  getByPath,
  type PropResolutionContext,
  type VisibilityContext as CoreVisibilityContext,
} from "@/spec/core";
import type {
  Components,
  Actions,
  ActionFn,
  SetState,
  StateModel,
  CatalogHasActions,
  EventHandle,
} from "./catalog-types";
import { useIsVisible, useVisibility } from "./contexts/visibility";
import { useActions } from "./contexts/actions";
import { useStateStore } from "./contexts/state";
import { StateProvider } from "./contexts/state";
import { VisibilityProvider } from "./contexts/visibility";
import { ActionProvider } from "./contexts/actions";
import { ValidationProvider } from "./contexts/validation";
import { ConfirmDialog } from "./contexts/actions";
import { RepeatScopeProvider, useRepeatScope } from "./contexts/repeat-scope";

/**
 * Props passed to component renderers
 */
export interface ComponentRenderProps<P = Record<string, unknown>> {
  /** The element being rendered */
  element: UIElement<string, P>;
  /** Rendered children */
  children?: ReactNode;
  /** Emit a named event. The renderer resolves the event to action binding(s) from the element's `on` field. Always provided by the renderer. */
  emit: (event: string) => void;
  /** Get an event handle with metadata (shouldPreventDefault, bound). Use when you need to inspect event bindings. */
  on: (event: string) => EventHandle;
  /**
   * Two-way binding paths resolved from `$bindState` / `$bindItem` expressions.
   * Maps prop name → absolute state path for write-back.
   * Only present when at least one prop uses `{ $bindState: "..." }` or `{ $bindItem: "..." }`.
   */
  bindings?: Record<string, string>;
  /** Whether the parent is loading */
  loading?: boolean;
}

/**
 * Component renderer type
 */
export type ComponentRenderer<P = Record<string, unknown>> = ComponentType<ComponentRenderProps<P>>;

/**
 * Registry of component renderers
 */
// Heterogeneous registry: each renderer has its own props type; `any` is the
// variance escape upstream chose — consumers re-narrow via the catalog.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentRegistry = Record<string, ComponentRenderer<any>>;

/**
 * Props for the Renderer component
 */
export interface RendererProps {
  /** The UI spec to render */
  spec: Spec | null;
  /** Component registry */
  registry: ComponentRegistry;
  /** Whether the spec is currently loading/streaming */
  loading?: boolean;
  /** Fallback component for unknown types */
  fallback?: ComponentRenderer;
}

// ---------------------------------------------------------------------------
// ElementErrorBoundary – catches rendering errors in individual elements so
// a single bad component never crashes the whole page.
// ---------------------------------------------------------------------------

interface ElementErrorBoundaryProps {
  elementType: string;
  children: ReactNode;
}

interface ElementErrorBoundaryState {
  hasError: boolean;
}

class ElementErrorBoundary extends React.Component<
  ElementErrorBoundaryProps,
  ElementErrorBoundaryState
> {
  constructor(props: ElementErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ElementErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[json-render] Rendering error in <${this.props.elementType}>:`,
      error,
      info.componentStack
    );
  }

  render() {
    if (this.state.hasError) {
      // Render nothing – the element silently disappears rather than
      // crashing the entire application.
      return null;
    }
    return this.props.children;
  }
}

interface ElementRendererProps {
  element: UIElement;
  spec: Spec;
  registry: ComponentRegistry;
  loading?: boolean;
  fallback?: ComponentRenderer;
  /** The element's id in spec.elements. When set, the rendered output is
   *  wrapped in a layout-neutral display:contents node stamped with
   *  data-spec-element, so tooling (edit overlays, tests) can locate
   *  rendered elements without affecting layout. */
  elementKey?: string;
}

/**
 * Element renderer component.
 * Memoized to prevent re-rendering all repeat children when state changes.
 */
const ElementRenderer = React.memo(function ElementRenderer({
  element,
  spec,
  registry,
  loading,
  fallback,
  elementKey,
}: ElementRendererProps) {
  const repeatScope = useRepeatScope();
  const { ctx } = useVisibility();
  const { execute } = useActions();

  // Build context with repeat scope (used for both visibility and props)
  const fullCtx: PropResolutionContext = useMemo(
    () =>
      repeatScope
        ? {
            ...ctx,
            repeatItem: repeatScope.item,
            repeatIndex: repeatScope.index,
            repeatBasePath: repeatScope.basePath,
          }
        : ctx,
    [ctx, repeatScope]
  );

  // Evaluate visibility (now supports $item/$index inside repeat scopes)
  const isVisible =
    element.visible === undefined ? true : evaluateVisibility(element.visible, fullCtx);

  // Create emit function that resolves events to action bindings.
  // Must be called before any early return to satisfy Rules of Hooks.
  const onBindings = element.on;
  const emit = useCallback(
    (eventName: string) => {
      const binding = onBindings?.[eventName];
      if (!binding) return;
      const actionBindings = Array.isArray(binding) ? binding : [binding];
      for (const b of actionBindings) {
        if (!b.params) {
          execute(b);
          continue;
        }
        // Resolve all action params via resolveActionParam which handles
        // $item (→ absolute state path), $index (→ number), $state, $cond, and literals.
        const resolved: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(b.params)) {
          resolved[key] = resolveActionParam(val, fullCtx);
        }
        execute({ ...b, params: resolved });
      }
    },
    [onBindings, execute, fullCtx]
  );

  // Create on() function that returns an EventHandle with metadata for a specific event.
  const on = useCallback(
    (eventName: string): EventHandle => {
      const binding = onBindings?.[eventName];
      if (!binding) {
        return { emit: () => {}, shouldPreventDefault: false, bound: false };
      }
      const actionBindings = Array.isArray(binding) ? binding : [binding];
      const shouldPreventDefault = actionBindings.some((b) => b.preventDefault);
      return {
        emit: () => emit(eventName),
        shouldPreventDefault,
        bound: true,
      };
    },
    [onBindings, emit]
  );

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  // Resolve $bindState/$bindItem expressions → bindings map (prop name → state path)
  const rawProps = element.props as Record<string, unknown>;
  const elementBindings = resolveBindings(rawProps, fullCtx);

  // Resolve dynamic prop expressions ($state, $item, $index, $bindState, $bindItem, $cond/$then/$else)
  const resolvedProps = resolveElementProps(rawProps, fullCtx);

  const resolvedElement =
    resolvedProps !== element.props ? { ...element, props: resolvedProps } : element;

  // Get the component renderer
  const Component = registry[resolvedElement.type] ?? fallback;

  if (!Component) {
    console.warn(`No renderer for component type: ${resolvedElement.type}`);
    return null;
  }

  // ---- Render children (with repeat support) ----
  const children = resolvedElement.repeat ? (
    <RepeatChildren
      element={resolvedElement}
      spec={spec}
      registry={registry}
      loading={loading}
      fallback={fallback}
    />
  ) : (
    resolvedElement.children?.map((childKey) => {
      const childElement = spec.elements[childKey];
      if (!childElement) {
        if (!loading) {
          console.warn(
            `[json-render] Missing element "${childKey}" referenced as child of "${resolvedElement.type}". This element will not render.`
          );
        }
        return null;
      }
      return (
        <ElementRenderer
          key={childKey}
          element={childElement}
          spec={spec}
          registry={registry}
          loading={loading}
          fallback={fallback}
          elementKey={childKey}
        />
      );
    })
  );

  const rendered = (
    <Component
      element={resolvedElement}
      emit={emit}
      on={on}
      bindings={elementBindings}
      loading={loading}
    >
      {children}
    </Component>
  );
  return (
    <ElementErrorBoundary elementType={resolvedElement.type}>
      {elementKey ? (
        <div style={{ display: "contents" }} data-spec-element={elementKey}>
          {rendered}
        </div>
      ) : (
        rendered
      )}
    </ElementErrorBoundary>
  );
});

// ---------------------------------------------------------------------------
// RepeatChildren -- renders child elements once per item in a state array.
// Used when an element has a `repeat` field.
// ---------------------------------------------------------------------------

function RepeatChildren({
  element,
  spec,
  registry,
  loading,
  fallback,
}: {
  element: UIElement;
  spec: Spec;
  registry: ComponentRegistry;
  loading?: boolean;
  fallback?: ComponentRenderer;
}) {
  const { state } = useStateStore();
  const repeat = element.repeat!;
  const statePath = repeat.statePath;

  const items = (getByPath(state, statePath) as unknown[] | undefined) ?? [];

  return (
    <>
      {items.map((itemValue, index) => {
        // Use a stable key: prefer key field, fall back to index
        const key =
          repeat.key && typeof itemValue === "object" && itemValue !== null
            ? String((itemValue as Record<string, unknown>)[repeat.key] ?? index)
            : String(index);

        return (
          <RepeatScopeProvider
            key={key}
            item={itemValue}
            index={index}
            basePath={`${statePath}/${index}`}
          >
            {element.children?.map((childKey) => {
              const childElement = spec.elements[childKey];
              if (!childElement) {
                if (!loading) {
                  console.warn(
                    `[json-render] Missing element "${childKey}" referenced as child of "${element.type}" (repeat). This element will not render.`
                  );
                }
                return null;
              }
              return (
                <ElementRenderer
                  key={childKey}
                  element={childElement}
                  spec={spec}
                  registry={registry}
                  loading={loading}
                  fallback={fallback}
                />
              );
            })}
          </RepeatScopeProvider>
        );
      })}
    </>
  );
}

/**
 * Main renderer component
 */
export function Renderer({ spec, registry, loading, fallback }: RendererProps) {
  if (!spec || !spec.root) {
    return null;
  }

  const rootElement = spec.elements[spec.root];
  if (!rootElement) {
    return null;
  }

  return (
    <ElementRenderer
      element={rootElement}
      spec={spec}
      registry={registry}
      loading={loading}
      fallback={fallback}
      elementKey={spec.root}
    />
  );
}

/**
 * Props for JSONUIProvider
 */
export interface JSONUIProviderProps {
  /** Component registry */
  registry: ComponentRegistry;
  /** Initial state model */
  initialState?: Record<string, unknown>;
  /** Action handlers */
  handlers?: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;
  /** Navigation function */
  navigate?: (path: string) => void;
  /** Custom validation functions */
  validationFunctions?: Record<string, (value: unknown, args?: Record<string, unknown>) => boolean>;
  /** Callback when state changes */
  onStateChange?: (path: string, value: unknown) => void;
  children: ReactNode;
}

/**
 * Combined provider for all JSONUI contexts
 */
export function JSONUIProvider({
  registry,
  initialState,
  handlers,
  navigate,
  validationFunctions,
  onStateChange,
  children,
}: JSONUIProviderProps) {
  return (
    <StateProvider initialState={initialState} onStateChange={onStateChange}>
      <VisibilityProvider>
        <ActionProvider handlers={handlers} navigate={navigate}>
          <ValidationProvider customFunctions={validationFunctions}>
            {children}
            <ConfirmationDialogManager />
          </ValidationProvider>
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}

/**
 * Renders the confirmation dialog when needed
 */
function ConfirmationDialogManager() {
  const { pendingConfirmation, confirm, cancel } = useActions();

  if (!pendingConfirmation?.action.confirm) {
    return null;
  }

  return (
    <ConfirmDialog
      confirm={pendingConfirmation.action.confirm}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}

// ============================================================================
// defineRegistry
// ============================================================================

/**
 * Result returned by defineRegistry
 */
export interface DefineRegistryResult {
  /** Component registry for `<Renderer registry={...} />` */
  registry: ComponentRegistry;
  /**
   * Create ActionProvider-compatible handlers.
   * Accepts getter functions so handlers always read the latest state/setState
   * (e.g. from React refs).
   */
  handlers: (
    getSetState: () => SetState | undefined,
    getState: () => StateModel
  ) => Record<string, (params: Record<string, unknown>) => Promise<void>>;
  /**
   * Execute an action by name imperatively
   * (for use outside the React tree, e.g. initial state loading).
   */
  executeAction: (
    actionName: string,
    params: Record<string, unknown> | undefined,
    setState: SetState,
    state?: StateModel
  ) => Promise<void>;
}

/**
 * Options for defineRegistry.
 *
 * When the catalog declares actions, the `actions` field is required.
 * When the catalog has no actions (or `actions: {}`), the field is optional.
 */
type DefineRegistryOptions<C extends Catalog> = {
  components?: Components<C>;
} & (CatalogHasActions<C> extends true ? { actions: Actions<C> } : { actions?: Actions<C> });

/**
 * Create a registry from a catalog with components and/or actions.
 *
 * When the catalog declares actions, the `actions` field is required.
 *
 * @example
 * ```tsx
 * // Components only (catalog has no actions)
 * const { registry } = defineRegistry(catalog, {
 *   components: {
 *     Card: ({ props, children }) => (
 *       <div className="card">{props.title}{children}</div>
 *     ),
 *   },
 * });
 *
 * // Both (catalog declares actions)
 * const { registry, handlers, executeAction } = defineRegistry(catalog, {
 *   components: { ... },
 *   actions: { ... },
 * });
 * ```
 */
export function defineRegistry<C extends Catalog>(
  _catalog: C,
  options: DefineRegistryOptions<C>
): DefineRegistryResult {
  // Build component registry
  const registry: ComponentRegistry = {};
  if (options.components) {
    for (const [name, componentFn] of Object.entries(options.components)) {
      registry[name] = ({
        element,
        children,
        emit,
        on,
        bindings,
        loading,
      }: ComponentRenderProps) => {
        return (componentFn as DefineRegistryComponentFn)({
          props: element.props,
          children,
          emit,
          on,
          bindings,
          loading,
        });
      };
    }
  }

  // Build action helpers
  const actionMap = options.actions
    ? (Object.entries(options.actions) as Array<[string, DefineRegistryActionFn]>)
    : [];

  const handlers = (
    getSetState: () => SetState | undefined,
    getState: () => StateModel
  ): Record<string, (params: Record<string, unknown>) => Promise<void>> => {
    const result: Record<string, (params: Record<string, unknown>) => Promise<void>> = {};
    for (const [name, actionFn] of actionMap) {
      result[name] = async (params) => {
        const setState = getSetState();
        const state = getState();
        if (setState) {
          await actionFn(params, setState, state);
        }
      };
    }
    return result;
  };

  const executeAction = async (
    actionName: string,
    params: Record<string, unknown> | undefined,
    setState: SetState,
    state: StateModel = {}
  ): Promise<void> => {
    const entry = actionMap.find(([name]) => name === actionName);
    if (entry) {
      await entry[1](params, setState, state);
    } else {
      console.warn(`Unknown action: ${actionName}`);
    }
  };

  return { registry, handlers, executeAction };
}

/** @internal */
type DefineRegistryComponentFn = (ctx: {
  props: unknown;
  children?: React.ReactNode;
  emit: (event: string) => void;
  on: (event: string) => EventHandle;
  bindings?: Record<string, string>;
  loading?: boolean;
}) => React.ReactNode;

/** @internal */
type DefineRegistryActionFn = (
  params: Record<string, unknown> | undefined,
  setState: SetState,
  state: StateModel
) => Promise<void>;

// ============================================================================
// NEW API
// ============================================================================

/**
 * Props for renderers created with createRenderer
 */
export interface CreateRendererProps {
  /** The spec to render (AI-generated JSON) */
  spec: Spec | null;
  /** State context for dynamic values */
  state?: Record<string, unknown>;
  /** Action handler */
  onAction?: (actionName: string, params?: Record<string, unknown>) => void;
  /** Callback when state changes (e.g., from form inputs) */
  onStateChange?: (path: string, value: unknown) => void;
  /** Whether the spec is currently loading/streaming */
  loading?: boolean;
  /** Fallback component for unknown types */
  fallback?: ComponentRenderer;
}

/**
 * Component map type - maps component names to React components
 */
export type ComponentMap<TComponents extends Record<string, { props: unknown }>> = {
  [K in keyof TComponents]: ComponentType<
    ComponentRenderProps<
      TComponents[K]["props"] extends { _output: infer O } ? O : Record<string, unknown>
    >
  >;
};

/**
 * Create a renderer from a catalog
 *
 * @example
 * ```typescript
 * const DashboardRenderer = createRenderer(dashboardCatalog, {
 *   Card: ({ element, children }) => <div className="card">{children}</div>,
 *   Metric: ({ element }) => <span>{element.props.value}</span>,
 * });
 *
 * // Usage
 * <DashboardRenderer spec={aiGeneratedSpec} state={state} />
 * ```
 */
export function createRenderer<
  TDef extends SchemaDefinition,
  TCatalog extends { components: Record<string, { props: unknown }> },
>(
  catalog: Catalog<TDef, TCatalog>,
  components: ComponentMap<TCatalog["components"]>
): ComponentType<CreateRendererProps> {
  // Convert component map to registry
  const registry: ComponentRegistry = components as unknown as ComponentRegistry;

  // Return the renderer component
  return function CatalogRenderer({
    spec,
    state,
    onAction,
    onStateChange,
    loading,
    fallback,
  }: CreateRendererProps) {
    // Wrap onAction with a Proxy so any action name routes to the callback
    const actionHandlers = onAction
      ? new Proxy({} as Record<string, (params: Record<string, unknown>) => void | Promise<void>>, {
          get: (_target, prop: string) => {
            return (params: Record<string, unknown>) => onAction(prop, params);
          },
          has: () => true,
        })
      : undefined;

    return (
      <StateProvider initialState={state} onStateChange={onStateChange}>
        <VisibilityProvider>
          <ActionProvider handlers={actionHandlers}>
            <ValidationProvider>
              <Renderer spec={spec} registry={registry} loading={loading} fallback={fallback} />
              <ConfirmationDialogManager />
            </ValidationProvider>
          </ActionProvider>
        </VisibilityProvider>
      </StateProvider>
    );
  };
}
