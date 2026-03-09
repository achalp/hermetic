"use client";

import { useState, useMemo, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnResizeMode,
} from "@tanstack/react-table";
import { downloadTableAsCsv, downloadTableAsXlsx } from "@/lib/export-utils";
import { useThemeConfig } from "@/lib/theme-config";

interface DataTableProps {
  columns: string[];
  rows: string[][];
  caption?: string | null;
  highlight_max?: boolean | null;
  highlight_min?: boolean | null;
  max_rows?: number | null;
}

function isNumericString(v: string): boolean {
  if (v === "") return false;
  const cleaned = v.replace(/[,$%\s]/g, "");
  return !isNaN(Number(cleaned)) && cleaned !== "";
}

function parseNumeric(v: string): number {
  return parseFloat(v.replace(/[^0-9.\-]/g, ""));
}

export function DataTableComponent({ props }: { props: DataTableProps }) {
  const { table: tableConfig } = useThemeConfig();
  const pageSize = props.max_rows ?? 20;

  // Normalize columns: LLM may send strings or objects like {key, label}
  const { columnHeaders, columnKeys } = useMemo(() => {
    const cols = Array.isArray(props.columns) ? props.columns : [];
    const headers: string[] = cols.map((col) => {
      if (typeof col === "string") return col;
      const obj = col as unknown as Record<string, unknown>;
      return String(obj.label ?? obj.key ?? obj.name ?? JSON.stringify(obj));
    });
    const keys: string[] = cols.map((col) => {
      if (typeof col === "string") return col;
      const obj = col as unknown as Record<string, unknown>;
      return String(obj.key ?? obj.name ?? obj.label ?? "");
    });
    return { columnHeaders: headers, columnKeys: keys };
  }, [props.columns]);

  // Normalize rows: LLM may send objects or arrays
  const normalizedRows = useMemo(() => {
    const rawRows = Array.isArray(props.rows) ? props.rows : [];
    if (rawRows.length === 0) return [];

    // Build a mapping from column key → actual row key (handles display name vs snake_case mismatch)
    const firstObj =
      !Array.isArray(rawRows[0]) && typeof rawRows[0] === "object" && rawRows[0] !== null
        ? (rawRows[0] as Record<string, unknown>)
        : null;
    const resolvedKeys = firstObj
      ? columnKeys.map((key) => {
          if (key in firstObj) return key;
          // Try case-insensitive match
          const lower = key.toLowerCase();
          const objKeys = Object.keys(firstObj);
          const ciMatch = objKeys.find((k) => k.toLowerCase() === lower);
          if (ciMatch) return ciMatch;
          // Try normalizing display name to snake_case: "Total PMM (USD)" → "total_pmm_usd"
          const snake = key
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");
          const snakeMatch = objKeys.find((k) => k === snake);
          if (snakeMatch) return snakeMatch;
          return key; // fallback to original
        })
      : columnKeys;

    return rawRows.map((row) => {
      if (Array.isArray(row)) return row.map(String);
      const obj = row as unknown as Record<string, unknown>;
      return resolvedKeys.map((key) => String(obj[key] ?? ""));
    });
  }, [props.rows, columnKeys]);

  // Detect which columns are numeric (for smart sorting)
  const numericColumns = useMemo(() => {
    const result = new Set<number>();
    for (let ci = 0; ci < columnHeaders.length; ci++) {
      const sample = normalizedRows.slice(0, 50);
      const numericCount = sample.filter(
        (row) => row[ci] !== undefined && isNumericString(row[ci])
      ).length;
      if (numericCount > sample.length * 0.5) {
        result.add(ci);
      }
    }
    return result;
  }, [columnHeaders, normalizedRows]);

  // Convert rows to records for TanStack (uses column index as key)
  const data = useMemo(() => {
    return normalizedRows.map((row, ri) => {
      const record: Record<string, string> = { __rowIndex: String(ri) };
      columnHeaders.forEach((_, ci) => {
        record[`col_${ci}`] = row[ci] ?? "";
      });
      return record;
    });
  }, [normalizedRows, columnHeaders]);

  // Build TanStack column defs
  const columns = useMemo<ColumnDef<Record<string, string>>[]>(() => {
    return columnHeaders.map((header, ci) => ({
      id: `col_${ci}`,
      accessorKey: `col_${ci}`,
      header: () => header,
      sortingFn: numericColumns.has(ci)
        ? (rowA, rowB) => {
            const a = parseNumeric(rowA.getValue(`col_${ci}`) as string);
            const b = parseNumeric(rowB.getValue(`col_${ci}`) as string);
            if (isNaN(a) && isNaN(b)) return 0;
            if (isNaN(a)) return 1;
            if (isNaN(b)) return -1;
            return a - b;
          }
        : "alphanumeric",
      cell: ({ row }) => {
        const value = row.getValue(`col_${ci}`) as string;
        const rowData = columnHeaders.map((_, i) => row.getValue(`col_${i}`) as string);

        // Highlight max/min logic
        const numericValues = rowData
          .map((v) => parseFloat(v.replace(/[^0-9.\-]/g, "")))
          .map((v) => (isNaN(v) ? null : v));
        const validNums = numericValues.filter((v) => v !== null) as number[];

        let className = "text-t-secondary";
        if (validNums.length > 0) {
          const maxIdx = props.highlight_max ? numericValues.indexOf(Math.max(...validNums)) : -1;
          const minIdx = props.highlight_min ? numericValues.indexOf(Math.min(...validNums)) : -1;

          if (ci === maxIdx) {
            className = "font-bold text-highlight-max";
          } else if (ci === minIdx) {
            className = "font-bold text-highlight-min";
          }
        }

        return <span className={className}>{value}</span>;
      },
    }));
  }, [columnHeaders, numericColumns, props.highlight_max, props.highlight_min]);

  // Table state
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnResizeMode] = useState<ColumnResizeMode>("onChange");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableColumnResizing: true,
    columnResizeMode,
    initialState: {
      pagination: { pageSize },
    },
  });

  const totalRows = Array.isArray(props.rows) ? props.rows.length : 0;
  const exportFilename = props.caption ?? "table";

  const handleExportCsv = useCallback(() => {
    downloadTableAsCsv(columnHeaders, normalizedRows, exportFilename);
  }, [columnHeaders, normalizedRows, exportFilename]);

  const handleExportXlsx = useCallback(() => {
    downloadTableAsXlsx(columnHeaders, normalizedRows, exportFilename);
  }, [columnHeaders, normalizedRows, exportFilename]);

  return (
    <div className="w-full space-y-2">
      {/* Caption */}
      {props.caption && (
        <h3
          className="text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.caption}
        </h3>
      )}

      {/* Search */}
      <div>
        <input
          type="text"
          value={globalFilter ?? ""}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder="Search all columns..."
          className="theme-input w-full max-w-sm border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors placeholder:text-t-tertiary focus:border-accent focus-visible:shadow-[var(--ring-focus)]"
          style={{
            borderRadius: "var(--radius-input)",
            transitionDuration: "var(--transition-speed)",
          }}
        />
      </div>

      {/* Export buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleExportCsv}
          className="bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
          style={{
            borderRadius: "var(--radius-badge)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Export CSV
        </button>
        <button
          onClick={handleExportXlsx}
          className="bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
          style={{
            borderRadius: "var(--radius-badge)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Export XLSX
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" style={{ width: table.getCenterTotalSize() }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-table-divider">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className={`group relative select-none font-semibold text-t-secondary ${tableConfig.cellPadding} ${tableConfig.headerBg ? "bg-table-header-bg" : ""}`}
                    style={{
                      width: header.getSize(),
                      textTransform: tableConfig.headerTransform,
                      letterSpacing:
                        tableConfig.headerTransform === "uppercase" ? "0.05em" : undefined,
                      borderBottomWidth: tableConfig.headerBorderWidth,
                    }}
                  >
                    <div
                      className={
                        header.column.getCanSort()
                          ? "flex cursor-pointer items-center gap-1"
                          : "flex items-center gap-1"
                      }
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {/* Sort indicator */}
                      {{
                        asc: <span className="text-xs text-accent">{"\u25B2"}</span>,
                        desc: <span className="text-xs text-accent">{"\u25BC"}</span>,
                      }[header.column.getIsSorted() as string] ?? (
                        <span className="text-xs text-t-tertiary opacity-0 transition-opacity group-hover:opacity-100">
                          {"\u25B2"}
                        </span>
                      )}
                    </div>

                    {/* Resize handle */}
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className={`absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100 ${
                        header.column.getIsResizing()
                          ? "bg-accent opacity-100"
                          : "bg-border-default"
                      }`}
                    />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-table-divider transition-colors hover:bg-table-row-hover"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={tableConfig.cellPadding}
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between pt-1 text-sm text-t-secondary">
          <div>
            Showing {table.getState().pagination.pageIndex * pageSize + 1}
            {"-"}
            {Math.min(
              (table.getState().pagination.pageIndex + 1) * pageSize,
              table.getFilteredRowModel().rows.length
            )}{" "}
            of {table.getFilteredRowModel().rows.length} rows
            {globalFilter && totalRows !== table.getFilteredRowModel().rows.length && (
              <span> (filtered from {totalRows})</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="border border-border-default px-2 py-1 text-xs transition-colors hover:bg-surface-btn disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Prev
            </button>
            <span className="text-xs">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="border border-border-default px-2 py-1 text-xs transition-colors hover:bg-surface-btn disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Row count for single-page tables */}
      {table.getPageCount() <= 1 && totalRows > normalizedRows.length && (
        <p className="text-xs text-t-tertiary">
          Showing {normalizedRows.length} of {totalRows} rows
        </p>
      )}
    </div>
  );
}
