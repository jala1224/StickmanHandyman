import { Router } from 'express';
import { z } from 'zod';
import { deleteContractAttachment } from '../services/contractAttachmentStorage.js';
import { completeContractSignature, getContractSignatureDocument, getSignedContractSignatureDocument, inspectContractSignatureRequest, withSignatureRequestLock } from '../services/contractSignature.js';
import { getContractById, recordAudit, updateContract } from '../services/store.js';

export const contractSignaturesRouter = Router();

const signerSchema = z.object({
  token: z.string().min(40).max(60),
  signerEmail: z.string().trim().email().max(254).optional(),
});

function signatureErrorResponse(res, error) {
  const responses = {
    SIGNATURE_LINK_INVALID: [404, 'This signing link is not valid.'],
    SIGNATURE_DOCUMENT_NOT_FOUND: [404, 'The document for this signing link was not found.'],
    SIGNATURE_LINK_EXPIRED: [410, 'This signing link has expired. Contact the sender for a new link.'],
    SIGNATURE_LINK_COMPLETED: [409, 'This document has already been signed.'],
    SIGNATURE_NOT_COMPLETED: [409, 'This document has not been signed yet.'],
    SIGNATURE_LINK_REVOKED: [410, 'This signing link was replaced. Use the latest link from the sender.'],
    SIGNER_EMAIL_MISMATCH: [403, 'The email address does not match the signer invited to this document.'],
    SIGNER_EMAIL_REQUIRED: [403, 'Enter the invited email address to open this signing link.'],
    SIGNATURE_DOCUMENT_CHANGED: [409, 'This document changed after the signing request was created. Ask the sender for a new link.'],
    SIGNATURE_LINES_NOT_FOUND: [409, 'This PDF has no supported signature lines. Ask the sender to generate a new agreement and signing link.'],
    ELECTRONIC_CONSENT_REQUIRED: [400, 'Consent to electronic records and signatures is required.'],
    SIGNER_NAME_MISMATCH: [400, 'Enter the signer name shown on the invitation.'],
    TYPED_SIGNATURE_MISMATCH: [400, 'For a typed signature, enter your full name as shown on the invitation.'],
    SIGNATURE_TYPE_INVALID: [400, 'Choose a drawn or typed signature.'],
    SIGNATURE_IMAGE_INVALID: [400, 'Draw your signature again before submitting.'],
  };
  const [status, message] = responses[error] || [500, 'Unable to process this signature.'];
  return res.status(status).json({ error: message, code: error });
}

contractSignaturesRouter.post('/inspect', async (req, res) => {
  const parsed = signerSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'A valid signing link is required.' });
  try {
    const result = await inspectContractSignatureRequest(parsed.data.token, parsed.data.signerEmail);
    if (result.error) return signatureErrorResponse(res, result.error);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    console.error('Failed to inspect a contract signature request:', error);
    return res.status(500).json({ error: 'Unable to load this signing request.' });
  }
});

contractSignaturesRouter.post(['/document', '/signed-document'], async (req, res) => {
  const parsed = signerSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'A valid signing link is required.' });
  try {
    const readDocument = req.path === '/signed-document' ? getSignedContractSignatureDocument : getContractSignatureDocument;
    const result = await readDocument(parsed.data.token, parsed.data.signerEmail);
    if (result.error) return signatureErrorResponse(res, result.error);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${result.fileName}"`);
    return res.send(result.buffer);
  } catch (error) {
    console.error('Failed to read a document for signing:', error);
    return res.status(500).json({ error: 'Unable to load the document.' });
  }
});

contractSignaturesRouter.post('/complete', async (req, res) => {
  const parsed = z.object({
    token: z.string().min(40).max(60),
    signerEmail: z.string().trim().email().max(254).optional(),
    signerName: z.string().trim().min(2).max(120),
    signatureType: z.enum(['typed', 'drawn']),
    signatureText: z.string().max(120).optional(),
    signatureImageDataUrl: z.string().max(900_000).optional(),
    consent: z.boolean(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Review the signer details and signature before submitting.' });

  try {
    const result = await withSignatureRequestLock(parsed.data.token, async () => {
      const completed = await completeContractSignature({
        ...parsed.data,
        signerIp: req.ip,
        userAgent: req.get('user-agent') || '',
      });
      if (completed.error) return completed;

      const contract = getContractById(completed.contractId);
      if (!contract) {
        await deleteContractAttachment(completed.contractId, completed.signedAttachment.id);
        return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
      }
      const attachments = contract.signedAttachments || [];
      const sourceAttachment = attachments.find(item => item.id === completed.attachmentId);
      if (!sourceAttachment) {
        await deleteContractAttachment(contract.id, completed.signedAttachment.id);
        return { error: 'SIGNATURE_DOCUMENT_NOT_FOUND' };
      }
      const signedAttachments = attachments.map(item => item.id === sourceAttachment.id
        ? { ...item, signatureRequests: (item.signatureRequests || []).map(request => request.id === completed.requestId ? { ...request, ...completed.request, tokenHash: request.tokenHash } : request) }
        : item);
      signedAttachments.push({ ...completed.signedAttachment, signatureRequests: [completed.request] });
      updateContract(contract.id, { signedAttachments });
      recordAudit({
        actorType: 'client_signature',
        actorId: completed.request.signerEmail || completed.request.signerName,
        action: 'contract.signature.completed',
        entityType: 'contract',
        entityId: contract.id,
        metadata: { attachmentId: completed.attachmentId, signedAttachmentId: completed.signedAttachment.id, signatureRequestId: completed.requestId, documentSha256: completed.request.documentSha256 },
      });
      return { signed: true, signedAt: completed.request.signedAt, fileName: completed.signedAttachment.fileName };
    });
    if (result.error) return signatureErrorResponse(res, result.error);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    console.error('Failed to complete a contract signature:', error);
    return res.status(500).json({ error: 'Unable to save the signature. Please try again.' });
  }
});