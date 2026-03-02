import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { SheetInfo } from "@/lib/types";

export interface ExcelMeta {
  sheets: SheetInfo[];
  workbook: ExcelJS.Workbook;
}

function cellToString(cell: ExcelJS.Cell): string {
  const value = cell.value;

  if (value === null || value === undefined) return "";

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    // RichText
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((rt) => rt.text).join("");
    }
    // Formula
    if ("formula" in value) {
      const result = (value as ExcelJS.CellFormulaValue).result as unknown;
      if (result === null || result === undefined) return "";
      if (result instanceof Date) return result.toISOString();
      if (
        typeof result === "object" &&
        result !== null &&
        "richText" in result &&
        Array.isArray((result as { richText: unknown[] }).richText)
      ) {
        return (result as { richText: { text: string }[] }).richText.map((rt) => rt.text).join("");
      }
      return String(result);
    }
    // Hyperlink — .text can be a RichText object at runtime despite the type
    if ("hyperlink" in value) {
      const text = (value as ExcelJS.CellHyperlinkValue).text as unknown;
      if (text === null || text === undefined) return "";
      if (
        typeof text === "object" &&
        text !== null &&
        "richText" in text &&
        Array.isArray((text as { richText: unknown[] }).richText)
      ) {
        return (text as { richText: { text: string }[] }).richText.map((rt) => rt.text).join("");
      }
      return String(text);
    }
    // SharedFormula
    if ("sharedFormula" in value) {
      const result = (value as ExcelJS.CellSharedFormulaValue).result as unknown;
      if (result === null || result === undefined) return "";
      if (result instanceof Date) return result.toISOString();
      if (
        typeof result === "object" &&
        result !== null &&
        "richText" in result &&
        Array.isArray((result as { richText: unknown[] }).richText)
      ) {
        return (result as { richText: { text: string }[] }).richText.map((rt) => rt.text).join("");
      }
      return String(result);
    }
    // Error
    if ("error" in value) return "";

    return String(value);
  }

  return String(value);
}

/**
 * Detect the header row index (1-based). The header row is the first row
 * where every column has a non-empty, unique string value and no cell is
 * a secondary part of a merged range. Falls back to row 1 if none found.
 */
function detectHeaderRow(worksheet: ExcelJS.Worksheet, colCount: number): number {
  const rowCount = worksheet.rowCount;
  for (let r = 1; r <= Math.min(rowCount, 10); r++) {
    const row = worksheet.getRow(r);
    const values: string[] = [];
    let allFilled = true;

    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      if (cell.isMerged && cell.master !== cell) {
        allFilled = false;
        break;
      }
      const v = cellToString(cell).trim();
      if (!v) {
        allFilled = false;
        break;
      }
      values.push(v);
    }

    if (allFilled && values.length === colCount) {
      if (new Set(values).size === values.length) {
        return r;
      }
    }
  }
  return 1;
}

export async function parseExcelMeta(buffer: Buffer | ArrayBuffer): Promise<ExcelMeta> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer =
    buffer instanceof ArrayBuffer
      ? buffer
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await workbook.xlsx.load(arrayBuffer as ArrayBuffer);

  const sheets: SheetInfo[] = [];

  workbook.eachSheet((worksheet) => {
    const colCount = worksheet.columnCount;
    const headerRow = detectHeaderRow(worksheet, colCount);
    let rowCount = 0;
    const sampleRows: string[][] = [];

    // Extract header cells
    const hRow = worksheet.getRow(headerRow);
    const headers: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      headers.push(cellToString(hRow.getCell(c)));
    }

    // Count data rows and collect up to 5 sample rows
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > headerRow) {
        rowCount++;
        if (sampleRows.length < 5) {
          const cells: string[] = [];
          for (let c = 1; c <= colCount; c++) {
            cells.push(cellToString(row.getCell(c)));
          }
          sampleRows.push(cells);
        }
      }
    });

    sheets.push({
      name: worksheet.name,
      rowCount,
      columnCount: colCount,
      headers,
      sampleRows,
    });
  });

  return { sheets, workbook };
}

export function sheetToCSV(workbook: ExcelJS.Workbook, sheetName: string): string {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${sheetName}" not found in workbook`);
  }

  const colCount = worksheet.columnCount;
  const headerRow = detectHeaderRow(worksheet, colCount);
  const rows: string[][] = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber < headerRow) return;
    const cells: string[] = [];
    for (let col = 1; col <= colCount; col++) {
      cells.push(cellToString(row.getCell(col)));
    }
    rows.push(cells);
  });

  if (rows.length === 0) {
    throw new Error(`Sheet "${sheetName}" is empty`);
  }

  const [headers, ...data] = rows;

  return Papa.unparse({
    fields: headers,
    data,
  });
}
