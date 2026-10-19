import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
  : '/bin/bash';
const releaseScript = fileURLToPath(new URL('../deploy/release.sh', import.meta.url));

function bashPath(file) {
  return process.platform === 'win32'
    ? execFileSync(bash, ['-c', 'cygpath -u "$1"', '--', file], { encoding: 'utf8' }).trim()
    : file;
}

function put(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o755 });
}

for (const failHealth of [false, true]) {
  test(`backend release ${failHealth ? 'rolls back when health fails' : 'retains backups when healthy'}`, { skip: !existsSync(bash) }, context => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stickman-deploy-test-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const application = path.join(root, 'application');
    const stage = path.join(root, 'stage');
    const bin = path.join(root, 'bin');
    put(application, 'backend/data/business.json', '{"private":"runtime-data"}');
    put(application, 'backend/.env', 'TEST_CONFIGURATION=preserve-me');
    put(application, 'invoices/existing.pdf', 'private-invoice');
    for (const base of [application, stage]) {
      const version = base === application ? 'old' : 'new';
      put(base, 'backend/src/version.js', `export const version = '${version}';`);
      put(base, 'backend/db/schema.sql', version);
      put(base, 'backend/package.json', '{"type":"module"}');
      put(base, 'backend/package-lock.json', '{}');
      put(base, 'fonts/font.ttf', version);
      put(base, 'invoice_template/template.pdf', version);
    }
    put(application, 'backend/node_modules/version', 'old-dependencies');
    put(bin, 'npm', '#!/bin/bash\nmkdir -p node_modules\nprintf new-dependencies > node_modules/version\n');
    put(bin, 'node', '#!/bin/bash\nexit 0\n');
    put(bin, 'sudo', '#!/bin/bash\nexit 0\n');
    put(bin, 'systemctl', '#!/bin/bash\nexit 0\n');
    put(bin, 'curl', '#!/bin/bash\nif [[ "$STICKMAN_TEST_FAIL_HEALTH" == 1 ]]; then exit 22; fi\nprintf \'{"ok":true}\'\n');
    put(root, 'release.sh', readFileSync(releaseScript, 'utf8').replace(/\r\n/g, '\n'));
    const archive = `/tmp/stickman-release-test-${process.pid}-${path.basename(root)}.tar.gz`;
    execFileSync(bash, ['-c', 'tar -czf "$1" -C "$2" backend/src backend/db backend/package.json backend/package-lock.json fonts invoice_template', '--', archive, bashPath(stage)]);
    const result = spawnSync(bash, [
      '-c', 'export PATH="$1:$PATH"; bash "$2" "$3" "$4" stickman-test.service 3000',
      '--', bashPath(bin), bashPath(path.join(root, 'release.sh')), archive, bashPath(application),
    ], { encoding: 'utf8', env: { ...process.env, STICKMAN_TEST_FAIL_HEALTH: failHealth ? '1' : '0' } });
    assert.equal(result.status === 0, !failHealth, result.stderr || result.stdout);
    const expectedVersion = failHealth ? 'old' : 'new';
    assert.equal(readFileSync(path.join(application, 'backend/src/version.js'), 'utf8'), `export const version = '${expectedVersion}';`);
    assert.equal(readFileSync(path.join(application, 'backend/data/business.json'), 'utf8'), '{"private":"runtime-data"}');
    assert.equal(readFileSync(path.join(application, 'backend/.env'), 'utf8'), 'TEST_CONFIGURATION=preserve-me');
    assert.equal(readFileSync(path.join(application, 'invoices/existing.pdf'), 'utf8'), 'private-invoice');
    assert.equal(readFileSync(path.join(application, 'backend/node_modules/version'), 'utf8'), failHealth ? 'old-dependencies' : 'new-dependencies');
    const backups = readdirSync(path.join(application, '.releases'));
    assert.equal(backups.length, 1);
    assert.ok(existsSync(path.join(application, '.releases', backups[0], 'runtime-data/business.json')));
  });
}