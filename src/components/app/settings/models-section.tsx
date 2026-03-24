"use client";

interface ModelsSectionProps {
  codeGenModel: string;
  uiComposeModel: string;
  onCodeGenModelChange: (model: string) => void;
  onUiComposeModelChange: (model: string) => void;
  availableModels: { id: string; label: string }[];
}

export function ModelsSection({
  codeGenModel,
  uiComposeModel,
  onCodeGenModelChange,
  onUiComposeModelChange,
  availableModels,
}: ModelsSectionProps) {
  const selectStyle: React.CSSProperties = {
    background: "var(--color-surface-dark-2)",
    border: "1px solid var(--color-surface-dark-3)",
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 13,
    color: "var(--color-surface-dark-text)",
    minWidth: 140,
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 0",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--color-surface-dark-text2)" }}>
          Code Generation
        </span>
        <select
          value={codeGenModel}
          onChange={(e) => onCodeGenModelChange(e.target.value)}
          style={selectStyle}
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 0",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--color-surface-dark-text2)" }}>
          UI Composition
        </span>
        <select
          value={uiComposeModel}
          onChange={(e) => onUiComposeModelChange(e.target.value)}
          style={selectStyle}
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
