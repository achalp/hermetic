/**
 * Compiled into BOTH export bundles in place of the heavyweight
 * export-again libraries (exceljs, jspdf, pptxgen, html-to-image): a shared
 * dashboard file doesn't need to produce PowerPoints — stubbing them keeps
 * ~3.5MB out of every exported file. CSV table download needs no library
 * and keeps working; XLSX/image/slide actions fail with a message naming
 * the way back (the live app).
 */
const EXPLAIN =
  "Not available inside an exported dashboard file — open the analysis in hermetic to use this export.";

function unavailable(): never {
  throw new Error(EXPLAIN);
}

// exceljs (imported as: import("exceljs"))
export class Workbook {
  constructor() {
    unavailable();
  }
}
// jspdf
export class jsPDF {
  constructor() {
    unavailable();
  }
}
// pptxgenjs
export default class Pptxgen {
  constructor() {
    unavailable();
  }
}
// html-to-image
export const toPng = unavailable;
export const toSvg = unavailable;
export const toBlob = unavailable;
export const toCanvas = unavailable;
