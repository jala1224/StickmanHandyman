import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.STICKMAN_DATA_DIR || path.resolve(currentDir, '..', '..', 'data');
const attachmentsDirectory = path.join(dataDirectory, 'contract-attachments');

function getAttachmentDirectory(contractId) {
  if (!/^contract_[A-Za-z0-9-]+$/.test(String(contractId))) {
    throw new Error('Invalid contract identifier.');
  }
  return path.join(attachmentsDirectory, contractId);
}

function getAttachmentPath(contractId, attachmentId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(attachmentId))) {
    throw new Error('Invalid attachment identifier.');
  }
  return path.join(getAttachmentDirectory(contractId), `${attachmentId}.pdf`);
}

export function createContractAttachmentId() {
  return randomUUID();
}

export async function saveContractAttachment(contractId, attachmentId, content) {
  const directory = getAttachmentDirectory(contractId);
  await mkdir(directory, { recursive: true });
  await writeFile(getAttachmentPath(contractId, attachmentId), content, { flag: 'wx' });
}

export async function readContractAttachment(contractId, attachmentId) {
  return readFile(getAttachmentPath(contractId, attachmentId));
}

export async function deleteContractAttachment(contractId, attachmentId) {
  try {
    await unlink(getAttachmentPath(contractId, attachmentId));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function deleteAllContractAttachments(contractId) {
  await rm(getAttachmentDirectory(contractId), { recursive: true, force: true });
}