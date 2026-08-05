"use client";

/**
 * The pre-results screens (extracted from page.tsx, exit audit F1):
 *  - WarehouseConnecting — State 1 while a warehouse connect is in flight
 *  - HomeHero           — State 1: ask-first composer, add-data menu, examples
 *  - AskScreen          — State 2: same composer with the source attached
 * Layout and copy are moved verbatim; all behavior stays in page-level hooks
 * and arrives via props.
 */
import type { ComponentProps } from "react";
import { AskComposer } from "@/app/components/home/ask-composer";
import { AddDataMenu, type SavedConnectionItem } from "@/app/components/home/add-data-menu";
import { ExampleCards, type ExampleRun } from "@/app/components/home/example-cards";
import { ActiveRunsBanner } from "@/app/components/active-runs-banner";
import { InlineConnectionForm } from "@/app/components/inline-connection-form";
import { StyleSelector } from "@/app/components/style-selector";
import { SuggestionPills } from "@/app/components/suggestion-pills";
import type { RecentItem } from "@/app/components/recent-sources";
import type { QueryMode } from "@/app/components/query-input";

/** The composer's controlled state + submit, shared by both screens. */
export interface ComposerWiring {
  question: string;
  onQuestionChange: (q: string) => void;
  mode: QueryMode;
  onModeChange: (m: QueryMode) => void;
  onSubmit: (q: string, m: QueryMode) => void;
}

/** Everything the Add-data menu needs; onPicked is wired to the menu close. */
export interface AddDataMenuWiring {
  recents: RecentItem[];
  savedConnections: SavedConnectionItem[];
  onOpenRecent: (item: RecentItem) => void;
  onUpload: () => void;
  onLocalBrowse: () => void;
  onNewWarehouse: () => void;
  onSavedConnect: (id: string) => void;
  onSample: () => void;
}

function renderMenuFrom(menu: AddDataMenuWiring) {
  return function renderAddDataMenu(close: () => void) {
    return <AddDataMenu {...menu} onPicked={close} />;
  };
}

export function WarehouseConnecting({ error }: { error: string | null }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3"
      style={{ minHeight: "calc(100vh - 56px)" }}
    >
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block h-2 w-2 rounded-full bg-accent"
            data-motion="essential"
            style={{
              animation: "pulse 1.2s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
      <span className="text-sm text-t-secondary">Connecting to warehouse...</span>
      {error && <span className="text-sm text-error-text">{error}</span>}
    </div>
  );
}

export interface HomeHeroProps {
  composer: ComposerWiring;
  menu: AddDataMenuWiring;
  onDropFile: (file: File) => void;
  activeRuns: ComponentProps<typeof ActiveRunsBanner>["runs"];
  onResumeRun: ComponentProps<typeof ActiveRunsBanner>["onResume"];
  onDismissRun: ComponentProps<typeof ActiveRunsBanner>["onDismiss"];
  showWarehouseForm: boolean;
  onConnect: ComponentProps<typeof InlineConnectionForm>["onConnect"];
  onRunExample: (run: ExampleRun) => void;
}

export function HomeHero({
  composer,
  menu,
  onDropFile,
  activeRuns,
  onResumeRun,
  onDismissRun,
  showWarehouseForm,
  onConnect,
  onRunExample,
}: HomeHeroProps) {
  return (
    <div
      className="flex flex-col items-center gap-6"
      style={{
        minHeight: "calc(100vh - 56px)",
        paddingTop: "max(4.5vh, 24px)",
        paddingBottom: 48,
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) onDropFile(file);
      }}
    >
      <div className="flex flex-col items-center gap-2 text-center" style={{ maxWidth: 640 }}>
        <h1
          className="text-t-primary"
          style={{
            fontSize: "var(--text-hero)",
            fontWeight: "var(--font-heading-weight)",
            letterSpacing: "-1px",
            lineHeight: 1.05,
          }}
        >
          Ask your data anything.
        </h1>
        <p
          className="text-t-secondary"
          style={{ fontSize: "var(--text-subhead)", lineHeight: 1.5, maxWidth: 540 }}
        >
          Plain English in, a live dashboard out &mdash; the model never sees your rows.
        </p>
      </div>

      {/* Analyses still running server-side after this tab lost their
          live view (reload / HMR) — one click to reattach to the stream. */}
      <ActiveRunsBanner runs={activeRuns} onResume={onResumeRun} onDismiss={onDismissRun} />

      {/* THE primary action: question first, data attached to it.
          Recents and saved connections live inside the Add-data menu. */}
      <AskComposer
        question={composer.question}
        onQuestionChange={composer.onQuestionChange}
        mode={composer.mode}
        onModeChange={composer.onModeChange}
        attachedLabel={null}
        onSubmit={composer.onSubmit}
        renderMenu={renderMenuFrom(menu)}
      />

      <InlineConnectionForm visible={showWarehouseForm} onConnect={onConnect} />

      {/* Examples ARE the payoff preview — click to run on the sample */}
      <ExampleCards onRun={onRunExample} />

      {/* Trust strip — the differentiator, promoted out of the footnote */}
      <div
        className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-t-tertiary"
        style={{ fontSize: 13 }}
      >
        <span className="flex items-center gap-1.5">
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 018 0v4" />
          </svg>
          Sealed &mdash; your data stays local
        </span>
        <span aria-hidden>&middot;</span>
        <span>Runs on local models or your own API key</span>
        <span aria-hidden>&middot;</span>
        <span>Sandboxed execution</span>
      </div>
    </div>
  );
}

export interface AskScreenProps {
  composer: ComposerWiring;
  menu: AddDataMenuWiring;
  attachedLabel: string | null;
  isAnalyzing: boolean;
  purpose: string;
  onStyleChange: (id: string) => void;
  llmWarning: string | null;
  onDismissLlmWarning: () => void;
  sourceError: string | null;
  onDismissSourceError: () => void;
  suggestions: ComponentProps<typeof SuggestionPills>["suggestions"];
  onSelectSuggestion: (q: string) => void;
}

export function AskScreen({
  composer,
  menu,
  attachedLabel,
  isAnalyzing,
  purpose,
  onStyleChange,
  llmWarning,
  onDismissLlmWarning,
  sourceError,
  onDismissSourceError,
  suggestions,
  onSelectSuggestion,
}: AskScreenProps) {
  return (
    <div
      className="flex flex-col items-center"
      style={{ minHeight: "calc(100vh - 56px)", paddingTop: "calc(35vh - 56px)" }}
    >
      <div className="mb-6">
        <StyleSelector selected={purpose} onSelect={onStyleChange} />
      </div>

      {llmWarning && (
        <div
          className="mb-4 flex w-full max-w-[700px] items-center justify-between gap-3 border px-4 py-3 text-sm"
          style={{
            borderRadius: "var(--radius-card)",
            borderColor: "var(--color-warning-border)",
            backgroundColor: "var(--color-warning-bg)",
            color: "var(--color-warning-text)",
          }}
        >
          <span>{llmWarning}</span>
          <button onClick={onDismissLlmWarning} className="shrink-0 font-medium hover:opacity-70">
            Dismiss
          </button>
        </div>
      )}

      {sourceError && (
        <div
          className="mb-4 flex w-full max-w-[700px] items-center justify-between gap-3 border px-4 py-3 text-sm"
          role="alert"
          style={{
            borderRadius: "var(--radius-card)",
            borderColor: "var(--color-error-border)",
            backgroundColor: "var(--color-error-bg)",
            color: "var(--color-error-text)",
          }}
        >
          <span>{sourceError}</span>
          <button onClick={onDismissSourceError} className="shrink-0 font-medium hover:opacity-70">
            Dismiss
          </button>
        </div>
      )}

      {/* Same composer as the home screen — the data chip now shows the
          attached source, and the menu becomes "Change data". */}
      <AskComposer
        question={composer.question}
        onQuestionChange={composer.onQuestionChange}
        mode={composer.mode}
        onModeChange={composer.onModeChange}
        attachedLabel={attachedLabel}
        onSubmit={composer.onSubmit}
        renderMenu={renderMenuFrom(menu)}
        isLoading={isAnalyzing}
      />

      {/* Data-specific question suggestions — typewriter animation */}
      <SuggestionPills suggestions={suggestions} onSelect={onSelectSuggestion} />
    </div>
  );
}
