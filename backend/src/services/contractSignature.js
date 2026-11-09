import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { createContractAttachmentId, readContractAttachment, saveContractAttachment } from './contractAttachmentStorage.js';
import { getContracts } from './store.js';

const requestLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const consentText = 'I have reviewed this document and agree to sign it electronically. I intend my electronic signature to have the same effect as my handwritten signature.';
const completionLocks = new Map();

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSignatureRequest(contractId, attachment, signerName, signerEmail, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const document = await readContractAttachment(contractId, attachment.id);
  const documentSha256 = createHash('sha256').update(document).digest('hex');
  return {
    token,
    request: {
      id: randomUUID(),
      tokenHash,
      signerName: signerName.trim(),
      signerEmail: signerEmail?.trim().toLowerCase() || null,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + requestLifetimeMs).toISOString(),
      documentSha256,
    },
  };
}

function readContractSignatureRequest(token, signerEmail, now = new Date(), allowedStatuses = ['pending']) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''))) return { error: 'SIGNATURE_LINK_INVALID' };
  const tokenHash = hashToken(token);
  for (const contract of getContracts()) {
    for (const attachment of contract.signedAttachments || []) {
      const request = (attachment.signatureRequests || []).find(item => item.tokenHash === tokenHash);
      if (!request) continue;
      if (request.status === 'superseded') return { error: 'SIGNATURE_LINK_REVOKED' };
      if (!allowedStatuses.includes(request.status)) return { error: request.status === 'pending' ? 'SIGNATURE_NOT_COMPLETED' : 'SIGNATURE_LINK_COMPLETED' };
      if (new Date(request.expiresAt).getTime() <= now.getTime()) return { error: 'SIGNATURE_LINK_EXPIRED' };
      if (request.signerEmail && !String(signerEmail || '').trim()) return { error: 'SIGNER_EMAIL_REQUIRED' };
      if (request.signerEmail && String(signerEmail).trim().toLowerCase() !== request.signerEmail) return { error: 'SIGNER_EMAIL_MISMATCH' };
      return { contract, attachment, request };
    }
  }
  return { error: 'SIGNATURE_LINK_INVALID' };
}

export async function inspectContractSignatureRequest(token, signerEmail) {
  const result = readContractSignatureRequest(token, signerEmail, new Date(), ['pending', 'completed']);
  if (result.error) return result;
  const attachment = result.request.status === 'completed'
    ? result.contract.signedAttachments.find(item => item.id === result.request.signedAttachmentId && item.signedCopy && item.signatureRequestId === result.request.id)
    : result.attachment;
  if (!attachment) return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
  return {
    request: {
      signerName: result.request.signerName,
      signerEmail: result.request.signerEmail,
      requiresEmail: Boolean(result.request.signerEmail),
      expiresAt: result.request.expiresAt,
      status: result.request.status,
      signedAt: result.request.signedAt || null,
    },
    contract: {
      contractNumber: result.contract.contractNumber,
      contractType: result.contract.contractType || 'maintenance',
      title: result.contract.title || null,
      serviceAddress: result.contract.serviceAddress || null,
    },
    document: { fileName: attachment.fileName, sizeBytes: attachment.sizeBytes },
  };
}

export async function getContractSignatureDocument(token, signerEmail) {
  const result = readContractSignatureRequest(token, signerEmail);
  if (result.error) return result;
  try {
    const buffer = await readContractAttachment(result.contract.id, result.attachment.id);
    const documentSha256 = createHash('sha256').update(buffer).digest('hex');
    if (result.request.documentSha256 && documentSha256 !== result.request.documentSha256) return { error: 'SIGNATURE_DOCUMENT_CHANGED' };
    return { buffer, fileName: result.attachment.fileName };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
    throw error;
  }
}

export async function getSignedContractSignatureDocument(token, signerEmail) {
  const result = readContractSignatureRequest(token, signerEmail, new Date(), ['completed']);
  if (result.error) return result;
  const attachment = result.contract.signedAttachments.find(item =>
    item.id === result.request.signedAttachmentId && item.signedCopy && item.signatureRequestId === result.request.id,
  );
  if (!attachment) return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
  try {
    const buffer = await readContractAttachment(result.contract.id, attachment.id);
    return { buffer, fileName: attachment.fileName };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
    throw error;
  }
}

function getSignatureImage(signatureDataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signatureDataUrl || ''));
  if (!match) return { error: 'A drawn PNG signature is required.' };
  const image = Buffer.from(match[1], 'base64');
  if (image.length < 100 || image.length > 1024 * 1024 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return { error: 'The drawn signature image is invalid.' };
  }
  return { image };
}

function findSignatureLines(pdf) {
  const recorded = pdf.catalog.lookupMaybe(PDFName.of('StickmanSignatureLines'), PDFDict);
  if (recorded) return recorded;
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const labels = streams.map(ref => pdf.context.lookup(ref)).filter(stream => stream instanceof PDFRawStream)
      .flatMap(stream => [...Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
        .matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([\da-f]+)>\s*Tj/gi)]
        .map(match => ({ x: Number(match[1]), y: Number(match[2]), text: Buffer.from(match[3], 'hex').toString('latin1') })));
    const client = labels.find(label => label.text === 'Client signature');
    const business = labels.find(label => label.text === 'Stickman Handyman representative');
    if (!client || !business || client.y - business.y < 40) continue;
    const date = labels.find(label => label.text === 'Date' && Math.abs(label.y - client.y) < 1 && label.x > client.x);
    const businessDate = labels.find(label => label.text === 'Date' && Math.abs(label.y - business.y) < 1 && label.x === date?.x);
    if (!date || !businessDate || business.y < 40 || date.x - client.x < 100) continue;
    return pdf.context.obj({
      pageIndex, signatureX: client.x, signatureY: client.y + 17,
      signatureWidth: date.x - client.x - 36, signatureHeight: 14,
      dateX: date.x, businessY: business.y + 17,
    });
  }
  return null;
}

async function buildSignedPdf(originalPdf, { signatureType, signatureText, signatureImageDataUrl, signedAt }) {
  const documentSha256 = createHash('sha256').update(originalPdf).digest('hex');
  const pdf = await PDFDocument.load(originalPdf);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const signatureLines = findSignatureLines(pdf);
  if (!signatureLines) return { error: 'SIGNATURE_LINES_NOT_FOUND' };
  if (signatureLines) {
    const coordinate = name => signatureLines.lookup(PDFName.of(name), PDFNumber).asNumber();
    const signaturePage = pdf.getPage(coordinate('pageIndex'));
    const signatureFont = await pdf.embedFont(StandardFonts.HelveticaOblique);
    const ink = rgb(0.12, 0.15, 0.18);
    const signatureX = coordinate('signatureX');
    const signatureY = coordinate('signatureY');
    const signatureWidth = coordinate('signatureWidth');
    if (signatureType === 'drawn') {
      const { image, error } = getSignatureImage(signatureImageDataUrl);
      if (error) throw new Error(error);
      const embedded = await pdf.embedPng(image);
      const scale = Math.min(signatureWidth / embedded.width, coordinate('signatureHeight') / embedded.height, 1);
      signaturePage.drawImage(embedded, { x: signatureX, y: signatureY, width: embedded.width * scale, height: embedded.height * scale });
    } else {
      const size = Math.min(18, signatureWidth / signatureFont.widthOfTextAtSize(signatureText, 1));
      signaturePage.drawText(signatureText, { x: signatureX, y: signatureY, size, font: signatureFont, color: ink });
    }
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(signedAt));
    const businessSignature = 'Jacob Lancaster';
    const businessSignatureFor = 'Stickman Handyman';
    const businessY = coordinate('businessY');
    const businessFont = await pdf.embedFont(StandardFonts.TimesRomanItalic);
    const businessSize = Math.min(18, signatureWidth / businessFont.widthOfTextAtSize(businessSignature, 1));
    signaturePage.drawText(businessSignature, { x: signatureX, y: businessY, size: businessSize, font: businessFont, color: ink });
    for (const dateY of [signatureY, businessY]) {
      signaturePage.drawText(date, { x: coordinate('dateX'), y: dateY, size: 11, font: regular, color: ink });
    }
    return { buffer: Buffer.from(await pdf.save()), documentSha256, businessSignature, businessSignatureFor };
  }
}

export async function withSignatureRequestLock(requestId, callback) {
  const previous = completionLocks.get(requestId) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  completionLocks.set(requestId, current);
  try {
    return await current;
  } finally {
    if (completionLocks.get(requestId) === current) completionLocks.delete(requestId);
  }
}

export async function completeContractSignature({ token, signerEmail, signerName, signatureType, signatureText, signatureImageDataUrl, consent, signerIp, userAgent }) {
  const result = readContractSignatureRequest(token, signerEmail);
  if (result.error) return result;
  if (consent !== true) return { error: 'ELECTRONIC_CONSENT_REQUIRED' };
  if (signerName.trim().toLowerCase() !== result.request.signerName.trim().toLowerCase()) return { error: 'SIGNER_NAME_MISMATCH' };
  if (signatureType === 'typed' && String(signatureText || '').trim().toLowerCase() !== result.request.signerName.trim().toLowerCase()) return { error: 'TYPED_SIGNATURE_MISMATCH' };
  if (!['typed', 'drawn'].includes(signatureType)) return { error: 'SIGNATURE_TYPE_INVALID' };
  if (signatureType === 'drawn') {
    const imageCheck = getSignatureImage(signatureImageDataUrl);
    if (imageCheck.error) return { error: 'SIGNATURE_IMAGE_INVALID' };
  }

  let originalPdf;
  try {
    originalPdf = await readContractAttachment(result.contract.id, result.attachment.id);
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
    throw error;
  }
  const documentSha256 = createHash('sha256').update(originalPdf).digest('hex');
  if (result.request.documentSha256 && documentSha256 !== result.request.documentSha256) return { error: 'SIGNATURE_DOCUMENT_CHANGED' };
  const signedAt = new Date().toISOString();
  const signedPdf = await buildSignedPdf(originalPdf, {
    ...result, signerName: result.request.signerName, signatureType,
    signatureText: result.request.signerName, signatureImageDataUrl, signedAt,
  });
  if (signedPdf.error) return signedPdf;
  const { buffer, businessSignature, businessSignatureFor } = signedPdf;
  const signedAttachment = {
    id: createContractAttachmentId(),
    fileName: `${result.attachment.fileName.replace(/\.pdf$/i, '')}_signed.pdf`.slice(0, 160),
    uploadedAt: signedAt,
    sizeBytes: buffer.length,
    signedCopy: true,
    signatureRequestId: result.request.id,
  };
  await saveContractAttachment(result.contract.id, signedAttachment.id, buffer);
  return {
    contractId: result.contract.id,
    attachmentId: result.attachment.id,
    requestId: result.request.id,
    request: {
      ...result.request,
      tokenHash: undefined,
      status: 'completed',
      signedAt,
      signatureType,
      consentText,
      documentSha256,
      signerIp: String(signerIp || '').slice(0, 100),
      userAgent: String(userAgent || '').slice(0, 300),
      signedAttachmentId: signedAttachment.id,
      ...(businessSignature ? { businessSignature, businessSignatureFor, businessSignatureMethod: 'typed', businessSignedAt: signedAt } : {}),
    },
    signedAttachment,
  };
}