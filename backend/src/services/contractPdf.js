import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { buildContractorHourTiers } from './contractorRepository.js';
import { getContractBillingPrice } from './contractPricing.js';
import { getMaintenanceContractTerms } from './maintenanceContractBilling.js';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const black = rgb(0.08, 0.1, 0.13);
const muted = rgb(0.35, 0.39, 0.43);
const rule = rgb(0.82, 0.84, 0.86);

function formatCurrency(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function wrapText(text, font, size, maxWidth) {
  return String(text || '').split(/\r?\n/).flatMap((paragraph) => {
    if (!paragraph.trim()) return [''];
    const words = paragraph.trim().split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  });
}

export function contractPdfFileName(contractNumber) {
  const safeNumber = String(contractNumber || 'Contract').replace(/[^\w.-]+/g, '_');
  return `StickmanHandyman_${safeNumber}_Agreement.pdf`;
}

export async function generateContractPdfBuffer(contract, client) {
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const isMaintenance = (contract.contractType || 'maintenance') === 'maintenance';
  const bodySize = isMaintenance ? 9.5 : 10;
  const bodyGap = isMaintenance ? 2.5 : 4;
  const bulletLineHeight = isMaintenance ? 12 : 15;
  const bulletGap = isMaintenance ? 2 : 3;
  const headingSize = isMaintenance ? 11 : 13;
  const headingTopGap = isMaintenance ? 3 : 8;
  const headingLineHeight = isMaintenance ? 15 : 21;
  const headingBottomGap = isMaintenance ? 5 : 12;
  const sectionHeight = headingTopGap + headingLineHeight + headingBottomGap;
  const pages = [];
  let page;
  let y;

  const registerSignatureLines = (signatureY, rightColumn) => {
    pdfDoc.catalog.set(PDFName.of('StickmanSignatureLines'), pdfDoc.context.obj({
      pageIndex: pages.length - 1,
      signatureX: MARGIN,
      signatureY: signatureY + 3,
      signatureWidth: PAGE_WIDTH / 2 - 18 - MARGIN,
      signatureHeight: 24,
      dateX: rightColumn,
      dateWidth: PAGE_WIDTH - MARGIN - rightColumn,
      businessY: signatureY - 45,
    }));
  };

  const addPage = () => {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height) => {
    if (!page || y - height < MARGIN) addPage();
  };

  const drawLine = (text, { size = bodySize, font = regular, color = black, indent = 0, gap = bodyGap } = {}) => {
    const lines = wrapText(text, font, size, CONTENT_WIDTH - indent);
    ensureSpace(Math.min(lines.length * (size + gap), PAGE_HEIGHT - MARGIN * 2));
    lines.forEach((line) => {
      ensureSpace(size + gap);
      if (line) page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= size + gap;
    });
  };

  const drawBullet = (text) => {
    const size = bodySize;
    const lineHeight = bulletLineHeight;
    const indent = 14;
    const lines = wrapText(text, regular, size, CONTENT_WIDTH - indent);
    ensureSpace(Math.min(lines.length * lineHeight + bulletGap, PAGE_HEIGHT - MARGIN * 2));
    lines.forEach((line, index) => {
      ensureSpace(lineHeight);
      if (index === 0) page.drawCircle({ x: MARGIN + 3, y: y - 5, size: 2, color: black });
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font: regular, color: black });
      y -= lineHeight;
    });
    y -= bulletGap;
  };

  const section = (title, minimumContentHeight = 0) => {
    ensureSpace(sectionHeight + minimumContentHeight);
    y -= headingTopGap;
    page.drawText(title, { x: MARGIN, y: y - headingSize, size: headingSize, font: bold, color: black });
    y -= headingLineHeight;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.7, color: rule });
    y -= headingBottomGap;
  };

  const lineSection = (title, entries) => {
    const lines = entries.flatMap(([text, options = {}]) => {
      const { size = bodySize, font = regular, indent = 0, gap = bodyGap } = options;
      return wrapText(text, font, size, CONTENT_WIDTH - indent)
        .map(line => ({ text: line, options, height: size + gap }));
    });
    const height = lines.reduce((total, line) => total + line.height, 0);
    section(title, height <= PAGE_HEIGHT - MARGIN * 2 - sectionHeight ? height : lines[0]?.height || 0);
    lines.forEach(line => {
      if (y - line.height < MARGIN) section(`${title} (continued)`, line.height);
      drawLine(line.text, line.options);
    });
  };

  const bulletSection = (title, bullets) => {
    const contentHeight = bullets.reduce((height, text) => (
      height + wrapText(text, regular, bodySize, CONTENT_WIDTH - 14).length * bulletLineHeight + bulletGap
    ), 0);
    section(title, contentHeight);
    bullets.forEach(drawBullet);
  };

  if (isMaintenance) {
    addPage();
    page.drawText('MAINTENANCE SERVICE AGREEMENT', { x: MARGIN, y: y - 24, size: 19, font: bold, color: black });
    y -= 30;
    page.drawText('STICKMAN HANDYMAN · HOME MAINTENANCE', { x: MARGIN, y: y - 12, size: 10, font: bold, color: muted });
    page.drawLine({ start: { x: MARGIN, y: y - 23 }, end: { x: PAGE_WIDTH - MARGIN, y: y - 23 }, thickness: 1.2, color: black });
    y -= 28;

    const portfolio = contract.packageType === 'portfolio'
      || (contract.packageType === 'custom' && contract.packageCoverageType === 'portfolio');
    lineSection(portfolio ? 'Client and Account' : 'Client and Service Property', [
      [`Client: ${client?.name || 'Client'}`, { font: bold, size: 11 }],
      ...(!portfolio ? [[`Service address: ${contract.serviceAddress || client?.address || 'Not specified'}`]] : []),
      [`Contract number: ${contract.contractNumber || 'Not assigned'}`],
      [`Start date: ${contract.startDate || 'To be scheduled'}`],
    ]);

    const packageType = contract.packageType === 'custom'
      ? `Custom ${portfolio ? 'Portfolio' : 'Single Home'}`
      : { single_home: 'Single Home', portfolio: 'Portfolio' }[contract.packageType] || 'Maintenance';
    const packageLevel = { basic: 'Basic', pro: 'Pro', premium: 'Premium' }[contract.packageLevel];
    const price = getContractBillingPrice(contract);
    const terms = getMaintenanceContractTerms(contract);
    lineSection('Package and Billing', [
      [`Package: ${packageType}${packageLevel ? ` · ${packageLevel}` : ''}`, { font: bold, size: 11 }],
      [`Billing cycle: ${contract.billingCycle || 'monthly'}`],
      ...(price ? [[`Amount per billing cycle: ${formatCurrency(price.amountCents)}`, { font: bold, size: 11 }]] : []),
      ...(price && price.monthlyAmountCents !== price.amountCents ? [[`Monthly package rate: ${formatCurrency(price.monthlyAmountCents)}`]] : []),
      [`Retainer hours per cycle: ${terms?.retainerHours ?? 0}`],
      [`Maximum rollover hours: ${terms?.rolloverHours ?? 0}`],
      [`Service discount: ${terms?.discountPercent ?? 0}%`],
      ['The standard two-hour service minimum is waived for maintenance package work.'],
    ]);

    const standardServices = {
      packagePriorityScheduling: ['pro', 'premium'].includes(contract.packageLevel),
      packageAnnualInspection: ['pro', 'premium'].includes(contract.packageLevel),
      packageQuarterlyInspection: contract.packageLevel === 'premium',
      packageOnCallService: contract.packageLevel === 'premium',
      packageTenantCoordination: contract.packageType === 'portfolio' && ['pro', 'premium'].includes(contract.packageLevel),
    };
    const includedServices = [
      ['packagePriorityScheduling', 'Priority scheduling'],
      ['packageAnnualInspection', 'Annual home inspection'],
      ['packageQuarterlyInspection', 'Quarterly home inspection'],
      ['packageOnCallService', 'On-call service'],
      ['packageTenantCoordination', 'Tenant coordination'],
    ].filter(([key]) => contract.packageType === 'custom' ? contract[key] : standardServices[key]).map(([, label]) => label);
    if (includedServices.length) {
      lineSection('Included Services', includedServices.map(service => [service, { indent: 12 }]));
    }

    if (portfolio) {
      bulletSection('Portfolio Account Coverage', [
        'All maintenance work under this client account, including work for associated businesses, shares one retainer-hour pool. Coverage is account-wide and is not limited to addresses currently on file. Each property does not receive a separate allowance.',
        'Service invoices must belong to this client account. Package hours, discounts, approved scope, and exclusions apply to all covered work under the account.',
      ]);
    } else {
      bulletSection('Service Property Coverage', [
        'This package covers only the service property identified above. Other properties and associated business addresses are excluded unless added through a separate agreement.',
      ]);
    }

    bulletSection('Retainer Hours and Rollover', [
      `The package provides ${terms?.retainerHours ?? 0} retainer hours per ${contract.billingCycle || 'monthly'} billing cycle, beginning on the contract start date. Quarterly and annual billing do not multiply the recorded per-cycle hour allowance.`,
      'Retainer-hour credits are available only when payment has been recorded for the invoice billing period and the contract is active. Work invoiced before that period is paid receives no retainer-hour credit and is not automatically credited by a later payment.',
      'Hours are allocated in invoice-date order, then creation order for invoices on the same date. Shared job time is measured by the longest individual crew attendance, not the sum of every crew member\'s hours. Applied labor credits consume the available pool; additional crew labor may remain billable.',
      terms?.rolloverHours > 0
        ? `Unused hours carry into the next billing cycle up to a maximum of ${terms.rolloverHours} rollover hours. The pool cannot accumulate beyond the new cycle allowance plus this cap; excess unused hours expire.`
        : 'Unused hours do not roll over and expire at the end of each billing cycle.',
    ]);

    bulletSection('Labor, Materials, and Service Discount', [
      'Available retainer hours are applied to invoice labor first. Work beyond the available hours is billed at the agreed labor rates. Materials, parts, and other non-labor charges are billed separately and do not consume retainer hours.',
      terms?.discountPercent > 0
        ? `The ${terms.discountPercent}% service discount applies only to remaining labor after retainer-hour credits. It does not discount materials or other non-labor charges.`
        : 'This package includes no additional service discount after retainer-hour credits.',
      'Specific tasks, labor rates, materials, and additional costs must be agreed before work begins. A maintenance package is not an unlimited-repair plan or a fixed-price quote for every requested project.',
    ]);

    bulletSection('Scheduling, Inspections, and Access', [
      includedServices.includes('Priority scheduling')
        ? 'Priority scheduling is included, subject to availability, safe working conditions, and access. It is not a guaranteed appointment or completion deadline.'
        : 'Service appointments are scheduled by mutual agreement, subject to availability and safe working conditions. Priority scheduling is not included.',
      includedServices.includes('Annual home inspection')
        ? `Annual home inspection is included${includedServices.includes('Quarterly home inspection') ? ', together with quarterly home inspection' : ''}. Inspection dates and property access must be coordinated in advance. Inspections identify maintenance needs; repairs, materials, and specialist evaluations are separately scoped and billed under the package rules.`
        : 'Scheduled annual and quarterly home inspections are not included unless specifically recorded as custom benefits.',
      includedServices.includes('On-call service')
        ? 'On-call service is included for coordinating maintenance requests. It does not promise immediate response, continuous availability, or emergency-service coverage.'
        : 'On-call service is not included.',
      includedServices.includes('Tenant coordination')
        ? 'Tenant coordination is included. The client remains responsible for authority to request work, required tenant notices, permissions, and lawful access to each property.'
        : 'The client is responsible for coordinating occupants, required notices, permissions, and access. Tenant coordination is not included.',
      'The client must provide safe access, secure pets, and identify relevant property restrictions. Scheduling may change because of access, materials, weather, other trades, or concealed conditions.',
    ]);

    bulletSection('Scope, Exclusions, and Approved Changes', [
      'Each maintenance visit is limited to the tasks approved by the client. Major renovations, structural work, permits, specialist trade work, disposal, and other unlisted services are excluded unless separately described and approved in writing.',
      'Pre-existing defects, concealed water damage, mold, rot, unsafe wiring, structural issues, and code corrections are not automatically included. Work in an affected area may pause while a repair plan, price, and schedule are submitted for written approval.',
      'Client-provided materials must be complete, undamaged, and suitable. Defects, missing parts, unsuitable products, or added work require a separately approved plan and price.',
      'Changes to approved work, package terms, or property coverage must be confirmed in writing before the changed work begins.',
    ]);

    bulletSection('Billing and Contract Changes', [
      `The package fee is ${price ? formatCurrency(price.amountCents) : 'the agreed package amount'} per ${contract.billingCycle || 'monthly'} billing cycle. Retainer eligibility depends on recorded payment, not merely enrollment in autopay.`,
      'Additional labor, materials, and other approved charges are itemized on service invoices and are payable under the terms stated on those invoices.',
      'Renewal, cancellation notice, refunds, and any minimum commitment must be separately agreed in writing; no specific notice period, cancellation fee, or refund entitlement is created by this document. Disabling autopay does not itself settle outstanding charges.',
    ]);

    const approval = 'The signatures below acknowledge the property coverage, package benefits, billing, retainer-hour rules, exclusions, and approval terms in this agreement.';
    section('Approval', wrapText(approval, regular, bodySize, CONTENT_WIDTH).length * (bodySize + bodyGap) + 98);
    drawLine(approval);
    ensureSpace(98);
    const signatureY = y - 30;
    const rightColumn = PAGE_WIDTH / 2 + 18;
    registerSignatureLines(signatureY, rightColumn);
    page.drawLine({ start: { x: MARGIN, y: signatureY }, end: { x: PAGE_WIDTH / 2 - 18, y: signatureY }, thickness: 0.8, color: muted });
    page.drawLine({ start: { x: rightColumn, y: signatureY }, end: { x: PAGE_WIDTH - MARGIN, y: signatureY }, thickness: 0.8, color: muted });
    page.drawText('Client signature', { x: MARGIN, y: signatureY - 14, size: 9, font: regular, color: muted });
    page.drawText('Date', { x: rightColumn, y: signatureY - 14, size: 9, font: regular, color: muted });
    page.drawLine({ start: { x: MARGIN, y: signatureY - 48 }, end: { x: PAGE_WIDTH / 2 - 18, y: signatureY - 48 }, thickness: 0.8, color: muted });
    page.drawLine({ start: { x: rightColumn, y: signatureY - 48 }, end: { x: PAGE_WIDTH - MARGIN, y: signatureY - 48 }, thickness: 0.8, color: muted });
    page.drawText('Stickman Handyman representative', { x: MARGIN, y: signatureY - 62, size: 9, font: regular, color: muted });
    page.drawText('Date', { x: rightColumn, y: signatureY - 62, size: 9, font: regular, color: muted });

    pages.forEach((currentPage, index) => {
      const label = `Page ${index + 1} of ${pages.length}`;
      currentPage.drawText(label, { x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(label, 8), y: 24, size: 8, font: regular, color: muted });
    });
    return Buffer.from(await pdfDoc.save());
  }

  addPage();
  page.drawText('SERVICE AGREEMENT', { x: MARGIN, y: y - 24, size: 21, font: bold, color: black });
  y -= 38;
  page.drawText('STICKMAN HANDYMAN · LABOR SERVICES', { x: MARGIN, y: y - 12, size: 10, font: bold, color: muted });
  page.drawLine({ start: { x: MARGIN, y: y - 23 }, end: { x: PAGE_WIDTH - MARGIN, y: y - 23 }, thickness: 1.2, color: black });
  y -= 39;

  section('Client and Project', 72);
  drawLine(`Client: ${client?.name || 'Client'}`, { font: bold, size: 11 });
  drawLine(`Service address: ${contract.serviceAddress || client?.address || 'Not specified'}`, { size: 10 });
  drawLine(`Project: ${contract.title || 'Labor project'}`, { size: 10 });
  drawLine(`Start date: ${contract.startDate || 'To be scheduled'}`, { size: 10 });

  const scope = contract.scope || 'No scope of work was provided.';
  section('Scope of Work', wrapText(scope, regular, 10, CONTENT_WIDTH).length * 15);
  drawLine(scope, { size: 10, gap: 5 });

  const pricingLineCount = contract.laborPricingModel === 'fixed'
    ? 1
    : (contract.laborEstimatedContractorHours || []).length + (contract.laborEstimatedOtherItems || []).length + 5;
  section('Pricing', pricingLineCount * 15);
  if (contract.laborPricingModel === 'fixed') {
    drawLine(`Quoted price: ${formatCurrency(contract.laborFixedAmountCents)}`, { font: bold, size: 12 });
  } else {
    drawLine('Hourly estimate using combined crew rates:', { font: bold, size: 11 });
    const laborTiers = buildContractorHourTiers(contract.laborEstimatedContractorHours || []);
    laborTiers.forEach((tier) => {
      drawLine(`${tier.hours.toFixed(2)} hours at ${formatCurrency(tier.hourlyRateCents)}/hour = ${formatCurrency(tier.hours * tier.hourlyRateCents)}`, {
        size: 10,
        indent: 12,
      });
    });
    const materialsCents = Number(contract.laborEstimatedMaterialsCents || 0);
    drawLine(`Materials estimate: ${formatCurrency(materialsCents)}`, { size: 10, indent: 12 });
    (contract.laborEstimatedOtherItems || []).forEach((item) => {
      drawLine(`${item.description}: ${formatCurrency(item.amountCents)}`, { size: 10, indent: 12 });
    });
    const totalEstimateCents = Number(contract.laborEstimatedAmountCents || 0)
      + materialsCents
      + Number(contract.laborEstimatedOtherAmountCents || 0);
    drawLine(`Total estimate: ${formatCurrency(totalEstimateCents)}`, { font: bold, size: 12, gap: 6 });
    drawLine('Hourly figures are estimates, not a fixed total.', { size: 9, color: muted });
  }

  bulletSection('Scope, Exclusions, and Changes', [
    'This agreement is limited to the tasks, quantities, locations, and finish requirements expressly described in the Scope of Work. Painting, disposal, permits, additional repairs, and other work are excluded unless specifically listed there.',
    'Unlisted or out-of-scope work requires a separate written change order approved by the client before work begins. It must describe the added work, labor, materials, price or rate, and any schedule change.',
  ]);

  bulletSection('Existing Conditions', [
    'Pre-existing defects and concealed conditions are excluded unless specifically included in the Scope of Work. Examples include concealed water damage, mold, rot, unsafe wiring, structural issues, and code-related corrections.',
    'If an unforeseen condition is found, work in the affected area will pause while a repair plan and price are submitted for written approval. Emergency measures are not authorized unless separately approved by the client in writing.',
  ]);

  bulletSection('Client-Provided Materials', [
    'The client is responsible for ensuring client-provided materials are complete, undamaged, and suitable for the agreed work. Stickman Handyman is not responsible for defects in those materials or delays and added costs caused by materials that are missing, damaged, incorrect, or unsuitable.',
    'Any additional work needed because of client-provided materials requires a separate written change order approved before that work begins.',
  ]);

  bulletSection('Scheduling and Access', [
    'Start dates and completion windows are estimates, not guaranteed deadlines. Delays may result from material availability, client decisions or access, other trades, inspections, or unforeseen conditions.',
  ]);

  bulletSection('Payment', [
    'Payment is due within three calendar days after the work described in this agreement is completed. Accepted payment methods are those listed on the invoice.',
  ]);

  if (contract.laborPricingModel === 'hourly_estimate') {
    bulletSection('Hourly Estimate', [
      'Hourly labor, materials, and other amounts are estimates. Final charges may vary based on actual work performed and approved costs.',
    ]);
  }

  const approval = 'The signatures below acknowledge the scope and pricing arrangement shown in this document.';
  section('Approval', wrapText(approval, regular, 10, CONTENT_WIDTH).length * 18 + 98);
  drawLine(approval, { size: 10, gap: 8 });
  ensureSpace(98);
  const signatureY = y - 30;
  const rightColumn = PAGE_WIDTH / 2 + 18;
  registerSignatureLines(signatureY, rightColumn);
  page.drawLine({ start: { x: MARGIN, y: signatureY }, end: { x: PAGE_WIDTH / 2 - 18, y: signatureY }, thickness: 0.8, color: muted });
  page.drawLine({ start: { x: rightColumn, y: signatureY }, end: { x: PAGE_WIDTH - MARGIN, y: signatureY }, thickness: 0.8, color: muted });
  page.drawText('Client signature', { x: MARGIN, y: signatureY - 14, size: 9, font: regular, color: muted });
  page.drawText('Date', { x: rightColumn, y: signatureY - 14, size: 9, font: regular, color: muted });
  page.drawLine({ start: { x: MARGIN, y: signatureY - 48 }, end: { x: PAGE_WIDTH / 2 - 18, y: signatureY - 48 }, thickness: 0.8, color: muted });
  page.drawLine({ start: { x: rightColumn, y: signatureY - 48 }, end: { x: PAGE_WIDTH - MARGIN, y: signatureY - 48 }, thickness: 0.8, color: muted });
  page.drawText('Stickman Handyman representative', { x: MARGIN, y: signatureY - 62, size: 9, font: regular, color: muted });
  page.drawText('Date', { x: rightColumn, y: signatureY - 62, size: 9, font: regular, color: muted });

  pages.forEach((currentPage, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    currentPage.drawText(label, {
      x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: 24,
      size: 8,
      font: regular,
      color: muted,
    });
  });

  return Buffer.from(await pdfDoc.save());
}