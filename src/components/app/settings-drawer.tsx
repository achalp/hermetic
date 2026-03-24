"use client";

import { Drawer } from "./drawer";
import { CollapsibleSection } from "./collapsible-section";
import { AppearanceSection } from "./settings/appearance-section";
import { ConnectedSourcesSection } from "./settings/connected-sources-section";
import { ModelsSection } from "./settings/models-section";
import { AnalysisDefaultsSection } from "./settings/analysis-defaults-section";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { SchemaMode } from "@/lib/types";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /* Models */
  codeGenModel: ModelId;
  uiComposeModel: ModelId;
  onCodeGenModelChange: (model: ModelId) => void;
  onUiComposeModelChange: (model: ModelId) => void;
  availableModels: { id: string; label: string }[];
  /* Analysis defaults */
  defaultStyle: string;
  onDefaultStyleChange: (style: string) => void;
  schemaMode: SchemaMode;
  onSchemaModeChange: (mode: SchemaMode) => void;
  /* Warehouse */
  isConnected: boolean;
  warehouseType: string | null;
  connectionLabel: string | null;
  savedConnections: { id: string; type: string; name: string; host: string }[];
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
}

export function SettingsDrawer({
  open,
  onClose,
  codeGenModel,
  uiComposeModel,
  onCodeGenModelChange,
  onUiComposeModelChange,
  availableModels,
  defaultStyle,
  onDefaultStyleChange,
  schemaMode,
  onSchemaModeChange,
  isConnected,
  warehouseType,
  connectionLabel,
  savedConnections,
  onConnect,
  onDisconnect,
  onDeleteSaved,
}: SettingsDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="Settings" width={360}>
      <CollapsibleSection title="Appearance" defaultOpen>
        <AppearanceSection />
      </CollapsibleSection>

      <CollapsibleSection title="Connected Sources" defaultOpen={false}>
        <ConnectedSourcesSection
          isConnected={isConnected}
          warehouseType={warehouseType}
          connectionLabel={connectionLabel}
          savedConnections={savedConnections}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onDeleteSaved={onDeleteSaved}
        />
      </CollapsibleSection>

      <CollapsibleSection title="Models" defaultOpen={false}>
        <ModelsSection
          codeGenModel={codeGenModel}
          uiComposeModel={uiComposeModel}
          onCodeGenModelChange={(m) => onCodeGenModelChange(m as ModelId)}
          onUiComposeModelChange={(m) => onUiComposeModelChange(m as ModelId)}
          availableModels={availableModels}
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
