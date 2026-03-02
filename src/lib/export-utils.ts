import { toBlob, toPng } from "html-to-image";
import Papa from "papaparse";

const PIXEL_RATIO = 2;

function getBackgroundColor(): string {
  if (typeof window === "undefined") return "#ffffff";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "#111827" : "#ffffff";
}

export function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

export async function copyChartToClipboard(el: HTMLElement): Promise<void> {
  const blob = await toBlob(el, {
    backgroundColor: getBackgroundColor(),
    pixelRatio: PIXEL_RATIO,
  });
  if (!blob) throw new Error("Failed to capture chart");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function downloadChartAsPng(el: HTMLElement, filename: string): Promise<void> {
  const dataUrl = await toPng(el, {
    backgroundColor: getBackgroundColor(),
    pixelRatio: PIXEL_RATIO,
  });
  triggerDownload(dataUrl, `${sanitizeFilename(filename)}.png`);
}

export function downloadTableAsCsv(headers: string[], rows: string[][], filename: string): void {
  const csv = Papa.unparse({ fields: headers, data: rows });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${sanitizeFilename(filename)}.csv`);
  URL.revokeObjectURL(url);
}

export async function downloadTableAsXlsx(
  headers: string[],
  rows: string[][],
  filename: string
): Promise<void> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");

  sheet.addRow(headers);
  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" },
    };
  });

  for (const row of rows) {
    sheet.addRow(row);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${sanitizeFilename(filename)}.xlsx`);
  URL.revokeObjectURL(url);
}

export async function downloadDashboardAsPdf(el: HTMLElement, filename: string): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const dataUrl = await toPng(el, {
    backgroundColor: getBackgroundColor(),
    pixelRatio: PIXEL_RATIO,
  });

  // Create an Image to get dimensions
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  const pdfWidth = 210; // A4 width in mm
  const pdfMargin = 10;
  const contentWidth = pdfWidth - pdfMargin * 2;
  const scale = contentWidth / img.width;
  const contentHeight = img.height * scale;

  const pageHeight = 297; // A4 height in mm
  const usableHeight = pageHeight - pdfMargin * 2;

  const pdf = new jsPDF("p", "mm", "a4");
  let yOffset = 0;
  let page = 0;

  while (yOffset < contentHeight) {
    if (page > 0) pdf.addPage();

    // Calculate source region in image pixels
    const srcY = yOffset / scale;
    const sliceHeight = Math.min(usableHeight, contentHeight - yOffset);
    const srcSliceHeight = sliceHeight / scale;

    // Use a canvas to slice the image
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = Math.ceil(srcSliceHeight);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, srcY, img.width, srcSliceHeight, 0, 0, img.width, srcSliceHeight);
    const sliceDataUrl = canvas.toDataURL("image/png");

    pdf.addImage(sliceDataUrl, "PNG", pdfMargin, pdfMargin, contentWidth, sliceHeight);

    yOffset += usableHeight;
    page++;
  }

  pdf.save(`${sanitizeFilename(filename)}.pdf`);
}

export async function downloadDashboardAsDocx(el: HTMLElement, filename: string): Promise<void> {
  const { Document, Packer, Paragraph, ImageRun, PageOrientation } = await import("docx");

  const dataUrl = await toPng(el, {
    backgroundColor: getBackgroundColor(),
    pixelRatio: PIXEL_RATIO,
  });

  // Convert data URL to Uint8Array
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Get image dimensions for aspect ratio
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  // Landscape A4 usable area: ~247mm wide x ~170mm tall (with margins)
  const maxWidthEmu = 247 * 36000; // EMU = 1/914400 inch, 1mm ≈ 36000 EMU
  const maxHeightEmu = 170 * 36000;
  const aspectRatio = img.width / img.height;

  let widthEmu = maxWidthEmu;
  let heightEmu = widthEmu / aspectRatio;
  if (heightEmu > maxHeightEmu) {
    heightEmu = maxHeightEmu;
    widthEmu = heightEmu * aspectRatio;
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: [
          new Paragraph({
            children: [
              new ImageRun({
                data: bytes,
                transformation: {
                  width: Math.round(widthEmu / 9525),
                  height: Math.round(heightEmu / 9525),
                },
                type: "png",
              }),
            ],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBlob(doc);
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${sanitizeFilename(filename)}.docx`);
  URL.revokeObjectURL(url);
}

export async function downloadDashboardAsPptx(el: HTMLElement, filename: string): Promise<void> {
  const PptxGenJS = await import("pptxgenjs");
  const pptx = new PptxGenJS.default();

  const dataUrl = await toPng(el, {
    backgroundColor: getBackgroundColor(),
    pixelRatio: PIXEL_RATIO,
  });

  const slide = pptx.addSlide();
  slide.addImage({
    data: dataUrl,
    x: 0.5,
    y: 0.5,
    w: 9,
    h: 6.5,
    sizing: { type: "contain", w: 9, h: 6.5 },
  });

  await pptx.writeFile({ fileName: `${sanitizeFilename(filename)}.pptx` });
}

export async function downloadMultiSheetXlsx(
  sheets: { name: string; headers: string[]; rows: string[][] }[],
  filename: string
): Promise<void> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    ws.addRow(sheet.headers);
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE5E7EB" },
      };
    });
    for (const row of sheet.rows) {
      ws.addRow(row);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${sanitizeFilename(filename)}.xlsx`);
  URL.revokeObjectURL(url);
}

export function downloadCodeAsFile(code: string, filename: string): void {
  const blob = new Blob([code], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}
