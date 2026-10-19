import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.STICKMAN_DATA_DIR || path.resolve(currentDir, '..', '..', 'data');
const dataPath = path.join(dataDir, 'client-users.json');

export function loadClientUsers() {
  if (!existsSync(dataPath)) {
    return [];
  }

  const clientUsers = JSON.parse(readFileSync(dataPath, 'utf8'));
  return Array.isArray(clientUsers) ? clientUsers : [];
}

export function saveClientUsers(clientUsers) {
  mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(clientUsers, null, 2));
  renameSync(temporaryPath, dataPath);
}
