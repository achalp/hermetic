"use client";

import type { SavedConnectionInfo } from "@/lib/api";
import { Drawer } from "./drawer";
import { CollapsibleSection } from "./collapsible-section";
import { AppearanceSection } from "./settings/appearance-section";
import { ConnectedSourcesSection } from "./settings/connected-sources-section";
import { InferenceSection } from "./settings/inference-section";
// Schedule UI moved out of Settings to the dashboard toolbar + Saved Vizs panel.
import { AnalysisDefaultsSection } from "./settings/analysis-defaults-section";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { SchemaMode } from "@/lib/types";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /* Inference */
  codeGenModel: ModelId;
  uiComposeModel: ModelId;
  onCodeGenModelChange: (model: ModelId) => void;
  onUiComposeModelChange: (model: ModelId) => void;
  sandboxRuntime: SandboxRuntimeId;
  onSandboxRuntimeChange: (runtime: SandboxRuntimeId) => void;
  ollamaModel: string | null;
  onOllamaModelChange: (model: string | null) => void;
  /* Analysis defaults */
  defaultStyle: string;
  onDefaultStyleChange: (style: string) => void;
  schemaMode: SchemaMode;
  onSchemaModeChange: (mode: SchemaMode) => void;
  /* Warehouse */
  isConnected: boolean;
  warehouseType: string | null;
  warehouseId?: string | null;
  connectionLabel: string | null;
  savedConnections: SavedConnectionInfo[];
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
  onRenameSaved: (id: string, name: string) => void;
}

export function SettingsDrawer({
  open,
  onClose,
  codeGenModel,
  uiComposeModel,
  onCodeGenModelChange,
  onUiComposeModelChange,
  sandboxRuntime,
  onSandboxRuntimeChange,
  ollamaModel,
  onOllamaModelChange,
  defaultStyle,
  onDefaultStyleChange,
  schemaMode,
  onSchemaModeChange,
  isConnected,
  warehouseType,
  warehouseId,
  connectionLabel,
  savedConnections,
  onConnect,
  onDisconnect,
  onDeleteSaved,
  onRenameSaved,
}: SettingsDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="Settings" width={380}>
      <CollapsibleSection title="Appearance" defaultOpen>
        <AppearanceSection />
      </CollapsibleSection>

      <CollapsibleSection title="Inference" defaultOpen>
        <InferenceSection
          codeGenModel={codeGenModel}
          uiComposeModel={uiComposeModel}
          onCodeGenModelChange={onCodeGenModelChange}
          onUiComposeModelChange={onUiComposeModelChange}
          sandboxRuntime={sandboxRuntime}
          onSandboxRuntimeChange={onSandboxRuntimeChange}
          ollamaModel={ollamaModel}
          onOllamaModelChange={onOllamaModelChange}
        />
      </CollapsibleSection>

      <CollapsibleSection title="Connected Sources" defaultOpen={false}>
        <ConnectedSourcesSection
          isConnected={isConnected}
          warehouseType={warehouseType}
          warehouseId={warehouseId}
          connectionLabel={connectionLabel}
          savedConnections={savedConnections}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onDeleteSaved={onDeleteSaved}
          onRenameSaved={onRenameSaved}
        />
      </CollapsibleSection>

      <CollapsibleSection title="Analysis Defaults" defaultOpen={false}>
        <AnalysisDefaultsSection
          defaultStyle={defaultStyle}
          onDefaultStyleChange={onDefaultStyleChange}
          schemaMode={schemaMode}
          onSchemaModeChange={(m) => onSchemaModeChange(m as SchemaMode)}
        />
      </CollapsibleSection>

      <div
        style={{
          padding: 20,
          fontSize: 12,
          color: "var(--color-surface-dark-text4)",
          lineHeight: 1.7,
        }}
      >
        hermetic v1.0
        <br />
        Data stays sealed. Always.
      </div>
    </Drawer>
  );
}
