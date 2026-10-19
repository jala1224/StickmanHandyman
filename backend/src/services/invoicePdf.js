import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..', '..', '..');
const serviceTemplatePath = path.join(projectRoot, 'invoice_template', 'blank_service_invoice.pdf');
const billingTemplatePath = path.join(projectRoot, 'invoice_template', 'blank_billing_invoice.pdf');
const boldFontPath = path.join(projectRoot, 'fonts', 'stix-two-text-bold.ttf');
const boldItalicFontPath = path.join(projectRoot, 'fonts', 'stix-two-text-bold-italic.ttf');
const invoicesDir = path.join(projectRoot, 'invoices');

const FONT_SIZE = 16;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const ADDRESS_MAX_WIDTH = PAGE_WIDTH * 0.5;
const ADDRESS_LINE_HEIGHT = FONT_SIZE * 1.15;
const ADDRESS_INDENT_POINTS = 12;

function topPercentToBaselineY(topPercent, fontSize = FONT_SIZE) {
  // 1.047 matches the STIX Two Text font's real ascent-to-em ratio, measured from the template's own baked-in labels.
  return PAGE_HEIGHT - (PAGE_HEIGHT * topPercent) / 100 - fontSize * 1.047;
}

function leftPercentToX(leftPercent) {
  return (PAGE_WIDTH * leftPercent) / 100;
}

// Positions below were measured directly from invoice_template/blank_invoice.pdf's baked-in labels.
const CLIENT_NAME_POSITION = { left: 14.9, top: 17.9 };
const BILLING_ADDRESS_POSITION = { left: 6.1, top: 22.6 };
const SERVICE_ADDRESS_POSITION = { left: 6.1, top: 30.6 };
const SERVICE_DATE_POSITION = { left: 13.4, top: 36.2 };
const BILLING_DATE_POSITION = { left: 13.4, top: 28.3 };
const INVOICE_NUMBER_POSITION = { left: 17.3, top: 38.8 };
const BILLING_INVOICE_NUMBER_POSITION = { left: 17.3, top: 30.8 };
const TOTAL_DUE_TOP_PERCENT = 92.6;

const ITEM_CENTER_PERCENT = 12.85;
const QTY_CENTER_PERCENT = 40.46;
const PRICE_CENTER_PERCENT = 61.46;
const AMOUNT_DECIMAL_ANCHOR_PERCENT = 85.2;
const ROW_START_TOP_PERCENT = 50.2;
const ROW_STEP_PERCENT = 2.8;

function formatOrdinalDate(dateValue) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return String(dateValue || '');
  }

  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);

  return formatted.replace(/\b(\d{1,2})\b/, (_, day) => `${day}${ordinalSuffix(Number(day))}`);
}

function ordinalSuffix(day) {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return 'th';
  }
  return ({ 1: 'st', 2: 'nd', 3: 'rd' })[day % 10] || 'th';
}

function formatPlainAmount(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function formatLaborRate(cents) {
  return String(Math.round(Number(cents || 0) / 100));
}

function plainInvoiceNumber(invoiceNumber) {
  const match = String(invoiceNumber || '').match(/\d+/);
  return match ? match[0] : String(invoiceNumber || '');
}

function centerText(text, font, fontSize, centerX) {
  const width = font.widthOfTextAtSize(text, fontSize);
  return centerX - width / 2;
}

// Aligns the decimal point of amountText to anchorX so every amount (and the total) lines up vertically.
function decimalAlignedX(amountText, font, fontSize, anchorX) {
  const decimalIndex = amountText.indexOf('.');
  const integerPart = decimalIndex >= 0 ? amountText.slice(0, decimalIndex) : amountText;
  return anchorX - font.widthOfTextAtSize(integerPart, fontSize);
}

function wrapTextLines(text, font, fontSize, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

// Forces a break at the first comma so the street line and city/state line never share a row.
function splitAddressLines(address) {
  const trimmed = String(address || '').trim();
  if (!trimmed) {
    return [];
  }

  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) {
    return [trimmed];
  }

  const streetLine = trimmed.slice(0, commaIndex).trim();
  const cityStateLine = trimmed.slice(commaIndex + 1).trim();
  return [streetLine, cityStateLine].filter(Boolean);
}

function drawWrappedText(page, text, { x, y, font, size, color, maxWidth, lineHeight }) {
  const forcedLines = splitAddressLines(text);
  let lineIndex = 0;

  forcedLines.forEach((forcedLine) => {
    wrapTextLines(forcedLine, font, size, maxWidth).forEach((line) => {
      page.drawText(line, { x, y: y - lineIndex * lineHeight, size, font, color });
      lineIndex += 1;
    });
  });
}

export async function generateInvoicePdfBuffer(invoice, client) {
  const hasServiceAddress = Boolean(String(invoice.serviceAddress || '').trim());
  const templateBytes = await readFile(hasServiceAddress ? serviceTemplatePath : billingTemplatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const [boldFontBytes, boldItalicFontBytes] = await Promise.all([
    readFile(boldFontPath),
    readFile(boldItalicFontPath),
  ]);
  const boldFont = await pdfDoc.embedFont(boldFontBytes);
  const boldItalicFont = await pdfDoc.embedFont(boldItalicFontBytes);

  const page = pdfDoc.getPage(0);
  const black = rgb(0.067, 0.094, 0.153);

  const issueDate = invoice.issueDate || new Date().toISOString().slice(0, 10);
  const clientName = client ? client.name : 'Client Unassigned';
  const billingAddress = client ? client.address : '';
  const serviceAddress = invoice.serviceAddress || '';
  const datePosition = hasServiceAddress ? SERVICE_DATE_POSITION : BILLING_DATE_POSITION;
  const invoiceNumberPosition = hasServiceAddress ? INVOICE_NUMBER_POSITION : BILLING_INVOICE_NUMBER_POSITION;
  const invoiceNumberText = plainInvoiceNumber(invoice.invoiceNumber);
  const amountDue = Math.max(0, Number(invoice.amountCents || invoice.subtotalCents || 0));

  page.drawText(clientName, {
    x: leftPercentToX(CLIENT_NAME_POSITION.left),
    y: topPercentToBaselineY(CLIENT_NAME_POSITION.top),
    size: FONT_SIZE,
    font: boldFont,
    color: black,
  });

  if (billingAddress) {
    drawWrappedText(page, billingAddress, {
      x: leftPercentToX(BILLING_ADDRESS_POSITION.left) + ADDRESS_INDENT_POINTS,
      y: topPercentToBaselineY(BILLING_ADDRESS_POSITION.top),
      font: boldFont,
      size: FONT_SIZE,
      color: black,
      maxWidth: ADDRESS_MAX_WIDTH,
      lineHeight: ADDRESS_LINE_HEIGHT,
    });
  }

  if (hasServiceAddress && serviceAddress) {
    drawWrappedText(page, serviceAddress, {
      x: leftPercentToX(SERVICE_ADDRESS_POSITION.left) + ADDRESS_INDENT_POINTS,
      y: topPercentToBaselineY(SERVICE_ADDRESS_POSITION.top),
      font: boldFont,
      size: FONT_SIZE,
      color: black,
      maxWidth: ADDRESS_MAX_WIDTH,
      lineHeight: ADDRESS_LINE_HEIGHT,
    });
  }

  page.drawText(formatOrdinalDate(issueDate), {
    x: leftPercentToX(datePosition.left),
    y: topPercentToBaselineY(datePosition.top),
    size: FONT_SIZE,
    font: boldFont,
    color: black,
  });

  page.drawText(invoiceNumberText, {
    x: leftPercentToX(invoiceNumberPosition.left),
    y: topPercentToBaselineY(invoiceNumberPosition.top),
    size: FONT_SIZE,
    font: boldFont,
    color: black,
  });

  const lineItems = Array.isArray(invoice.lineItems) && invoice.lineItems.length
    ? invoice.lineItems
    : [{ type: 'labor', description: 'Labor', quantity: 1, unitPriceCents: amountDue }];

  // Other line items should left-align with where the centered 'Labor' text starts, not the Item header.
  const otherItemLeftX = centerText('Labor', boldFont, FONT_SIZE, leftPercentToX(ITEM_CENTER_PERCENT));

  lineItems.forEach((item, index) => {
    const baselineY = topPercentToBaselineY(ROW_START_TOP_PERCENT + index * ROW_STEP_PERCENT);
    const quantity = Number(item.quantity || 1);
    const unitPrice = Math.max(0, Number(item.unitPriceCents || 0));
    const rowTotal = item.type === 'labor'
      ? Math.round(quantity * unitPrice)
      : Math.round(unitPrice);
    const description = item.type === 'labor'
      ? 'Labor'
      : (item.description || (item.type === 'material' ? 'Materials' : 'Other'));
    const quantityValue = item.type === 'labor' && Number.isFinite(quantity) && quantity > 0 ? String(quantity) : '';
    const priceValue = item.type === 'labor' ? formatLaborRate(unitPrice) : '';
    const amountValue = formatPlainAmount(rowTotal);

    page.drawText(description, {
      x: item.type === 'labor'
        ? centerText(description, boldFont, FONT_SIZE, leftPercentToX(ITEM_CENTER_PERCENT))
        : otherItemLeftX,
      y: baselineY,
      size: FONT_SIZE,
      font: boldFont,
      color: black,
    });

    if (quantityValue) {
      page.drawText(quantityValue, {
        x: centerText(quantityValue, boldFont, FONT_SIZE, leftPercentToX(QTY_CENTER_PERCENT)),
        y: baselineY,
        size: FONT_SIZE,
        font: boldFont,
        color: black,
      });
    }

    if (priceValue) {
      page.drawText(priceValue, {
        x: centerText(priceValue, boldFont, FONT_SIZE, leftPercentToX(PRICE_CENTER_PERCENT)),
        y: baselineY,
        size: FONT_SIZE,
        font: boldFont,
        color: black,
      });
    }

    page.drawText(amountValue, {
      x: decimalAlignedX(amountValue, boldFont, FONT_SIZE, leftPercentToX(AMOUNT_DECIMAL_ANCHOR_PERCENT)),
      y: baselineY,
      size: FONT_SIZE,
      font: boldFont,
      color: black,
    });
  });

  const totalText = formatPlainAmount(amountDue);
  page.drawText(totalText, {
    x: decimalAlignedX(totalText, boldFont, FONT_SIZE, leftPercentToX(AMOUNT_DECIMAL_ANCHOR_PERCENT)),
    y: topPercentToBaselineY(TOTAL_DUE_TOP_PERCENT),
    size: FONT_SIZE,
    font: boldFont,
    color: black,
  });

  return Buffer.from(await pdfDoc.save());
}

function invoicePdfPath(invoiceNumber) {
  const numericId = plainInvoiceNumber(invoiceNumber) || 'invoice';
  return path.join(invoicesDir, `StickmanHandyman_${numericId}.pdf`);
}

export function invoicePdfFileName(invoiceNumber) {
  const numericId = plainInvoiceNumber(invoiceNumber) || 'invoice';
  return `StickmanHandyman_${numericId}.pdf`;
}

export async function getInvoicePdfBuffer(invoice, client) {
  const savedPath = invoicePdfPath(invoice.invoiceNumber);
  if (existsSync(savedPath)) {
    return readFile(savedPath);
  }

  return generateInvoicePdfBuffer(invoice, client);
}

export function getHighestSavedInvoiceNumber() {
  if (!existsSync(invoicesDir)) {
    return 0;
  }

  let highest = 0;
  for (const entry of readdirSync(invoicesDir)) {
    const match = entry.match(/^StickmanHandyman_(\d+)\.pdf$/i);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }

  return highest;
}

export async function saveInvoicePdf(invoice, client) {
  const buffer = await generateInvoicePdfBuffer(invoice, client);
  if (!existsSync(invoicesDir)) {
    await mkdir(invoicesDir, { recursive: true });
  }
  await writeFile(invoicePdfPath(invoice.invoiceNumber), buffer);
}

export async function deleteInvoicePdf(invoiceNumber) {
  const targetPath = invoicePdfPath(invoiceNumber);
  if (existsSync(targetPath)) {
    await unlink(targetPath);
  }
}
