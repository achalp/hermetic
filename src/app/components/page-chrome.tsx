"use client";

/**
 * The fixed chrome around the page's main content (extracted from page.tsx,
 * exit audit F1): settings drawer, data rail, artifacts bottom sheet, and the
 * schedule popover. Pure pass-through wiring — all state stays in the page's
 * hooks and arrives via props.
 */
import { SettingsDrawer } from "@/app/components/settings-drawer";
import { DataRail } from "@/app/components/data-rail";
import { DataRailContent } from "@/app/components/data-rail-content";
import { ArtifactsPanel } from "@/app/components/artifacts-panel";
import { SchedulePopover } from "@/app/components/schedule-popover";
import { buildProfileItems, buildRailSchemas } from "@/app/components/data-rail-derive";
import type { useWarehouse } from "@/hooks/use-warehouse";
import type { useModelSettings } from "@/hooks/use-model-settings";
import type { useArtifacts } from "@/hooks/use-artifacts";
import type { useCSVUpload } from "@/hooks/use-csv-upload";
import type { ScheduleState } from "@/hooks/use-schedule-popover";
import type { usePanels } from "@/hooks/use-panels";
import type { SchemaMode } from "@/lib/contracts/data-schema";

export interface PageChromeProps {
  panels: ReturnType<typeof usePanels>;
  models: ReturnType<typeof useModelSettings>;
  purpose: string;
  onPurposeChange: (id: string) => void;
  composerSight: string;
  onComposerSightChange: (m: string) => void;
  verifiability?: import("@/app/components/verify-tab").VerifiabilityPayload | null;
  historyId?: string | null;
  schemaMode: SchemaMode;
  onSchemaModeChange: (m: SchemaMode) => void;
  warehouse: ReturnType<typeof useWarehouse>;
  // Data rail
  hasData: boolean;
  schema: ReturnType<typeof useCSVUpload>["schema"];
  excelMeta: ReturnType<typeof useCSVUpload>["excelMeta"];
  isWorkbookMode: boolean;
  onRefreshSchema: (() => void) | undefined;
  isRefreshingSchema: boolean;
  // Artifacts panel
  pageArtifacts: ReturnType<typeof useArtifacts>;
  artifactsCsvId: string | null;
  onRequestRerun: (edits: { code?: string; sql?: string }) => void;
  // Schedule popover
  scheduleState: ScheduleState;
  onCloseSchedule: () => void;
  onScheduleChanged: () => void;
}

export function PageChrome(props: PageChromeProps) {
  const { warehouse, schema, models, panels } = props;
  const profileItems = buildProfileItems(schema, warehouse);
  const { railSchema, railAllSchema, railMoreColumns } = buildRailSchemas(schema);

  return (
    <>
      {/* Settings Drawer */}
      <SettingsDrawer
        open={panels.settingsOpen}
        onClose={panels.closeSettings}
        codeGenModel={models.codeGenModel}
        uiComposeModel={models.uiComposeModel}
        onCodeGenModelChange={models.handleCodeGenModelChange}
        onUiComposeModelChange={models.handleUiComposeModelChange}
        effort={models.effort}
        onEffortChange={models.handleEffortChange}
        phaseEfforts={models.phaseEfforts}
        onPhaseEffortChange={models.handlePhaseEffortChange}
        sandboxRuntime={models.sandboxRuntime}
        onSandboxRuntimeChange={models.handleRuntimeChange}
        ollamaModel={models.ollamaModel}
        onOllamaModelChange={models.setOllamaModel}
        defaultStyle={props.purpose}
        onDefaultStyleChange={props.onPurposeChange}
        schemaMode={props.schemaMode}
        onSchemaModeChange={props.onSchemaModeChange}
        composerSight={props.composerSight}
        onComposerSightChange={props.onComposerSightChange}
        isConnected={warehouse.isConnected}
        warehouseType={warehouse.warehouseType}
        warehouseId={warehouse.warehouseId}
        connectionLabel={
          warehouse.warehouseType
            ? `${warehouse.warehouseType} · ${warehouse.tableCount} tables`
            : null
        }
        savedConnections={warehouse.savedConnections}
        onConnect={(config, force) =>
          warehouse.connect(config as unknown as Parameters<typeof warehouse.connect>[0], force)
        }
        onDisconnect={warehouse.disconnect}
        onDeleteSaved={warehouse.deleteSaved}
        onRenameSaved={warehouse.renameSaved}
      />

      {/* Data Rail */}
      <DataRail
        visible={props.hasData}
        expanded={panels.railExpanded}
        fullscreen={panels.railFullscreen}
        onExpand={panels.expandRail}
        onCollapse={panels.collapseRail}
        onToggleFullscreen={panels.toggleRailFullscreen}
      >
        <DataRailContent
          sourceType={warehouse.isConnected ? "warehouse" : props.isWorkbookMode ? "excel" : "csv"}
          sourceName={
            warehouse.isConnected
              ? `${warehouse.warehouseType ?? "Warehouse"} · ${warehouse.tableCount} tables`
              : (schema?.filename ?? "data")
          }
          schema={railSchema}
          allSchema={railAllSchema}
          moreColumns={railMoreColumns}
          profileChips={profileItems}
          sampleColumns={schema?.columns.map((c) => c.name)}
          sampleRows={schema?.sample_rows
            ?.slice(0, 5)
            .map((row) => schema.columns.map((c) => String(row[c.name] ?? "")))}
          sheets={props.excelMeta?.sheets.map((s) => ({ name: s.name, rows: s.rowCount }))}
          relationships={props.excelMeta?.relationships.map((r) => ({
            from: `${r.sourceSheet}.${r.sourceColumn}`,
            to: `${r.targetSheet}.${r.targetColumn}`,
          }))}
          tables={warehouse.tables.map((t) => ({
            name: t.name,
            rows: t.row_count_estimate?.toLocaleString() ?? "–",
          }))}
          warehouseSchemas={warehouse.tableSchemas}
          warehouseId={warehouse.warehouseId}
          fullscreen={panels.railFullscreen}
          onRefreshSchema={props.onRefreshSchema}
          isRefreshing={props.isRefreshingSchema}
        />
      </DataRail>

      {/* Artifacts Panel — bottom sheet per design spec */}
      <ArtifactsPanel
        open={panels.showArtifactsPanel}
        fullscreen={panels.artifactsFullscreen}
        onClose={() => panels.setShowArtifactsPanel(false)}
        onToggleFullscreen={panels.toggleArtifactsFullscreen}
        artifacts={props.pageArtifacts.artifacts}
        csvId={props.artifactsCsvId}
        onRerunSuccess={(newArtifacts) => props.pageArtifacts.setArtifacts(newArtifacts)}
        onRequestRerun={props.onRequestRerun}
        verifiability={props.verifiability}
        historyId={props.historyId}
      />

      {/* Schedule popover — anchored to whichever button opened it. Auto-saves
          the viz first if needed, then renders cadence + auto-export options. */}
      {props.scheduleState.kind === "open" && (
        <SchedulePopover
          vizId={props.scheduleState.vizId}
          anchorRect={props.scheduleState.anchorRect}
          onClose={props.onCloseSchedule}
          onChanged={props.onScheduleChanged}
        />
      )}
    </>
  );
}
