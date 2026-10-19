import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `node ${args.join(' ')} failed`);
}

const htmlFiles = readdirSync(root).filter(file => file.endsWith('.html'));
let referenceCount = 0;
for (const name of htmlFiles) {
  const html = readFileSync(path.join(root, name), 'utf8');
  assert.ok(!/<style\b|\sstyle=/i.test(html), `${name} contains embedded CSS`);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/application\/ld\+json|application\/json/.test(match[1])) {
      JSON.parse(match[2]);
    } else {
      assert.ok(!match[2].trim(), `${name} contains executable inline JavaScript`);
    }
  }

  const scripts = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    const reference = match[1].split('?')[0].split('#')[0];
    if (/^(?:https?:)?\/\//.test(reference) || !/\.(?:css|js)$/.test(reference)) continue;
    const target = path.resolve(root, reference);
    assert.ok(target.startsWith(root), `Invalid asset path in ${name}`);
    assert.ok(existsSync(target), `${name} references missing ${reference}`);
    referenceCount++;
    if (reference.endsWith('.js')) scripts.push(readFileSync(target, 'utf8'));
  }
  new vm.Script(scripts.join('\n'), { filename: name });
}

const sources = [
  ...readdirSync(root).filter(file => file.endsWith('.js')).map(file => path.join(root, file)),
  ...['js', 'scripts', 'backend/src', 'backend/test'].flatMap(directory => filesIn(path.join(root, directory))),
].filter(file => /\.(?:mjs|js)$/.test(file));
for (const file of sources) runNode(['--check', file]);

const deploy = readFileSync(path.join(root, 'deploy-to-s3.ps1'), 'utf8');
assert.ok(deploy.includes("'css/*.css'"), 'CSS deployment allowlist is missing');
assert.ok(deploy.includes("'js/*'"), 'JavaScript deployment allowlist is missing');
console.log(`PASS: ${htmlFiles.length} HTML pages, ${referenceCount} local asset references, and ${sources.length} JavaScript files.`);

if (process.argv.includes('--test')) {
  const tests = filesIn(path.join(root, 'backend/test')).filter(file => file.endsWith('.test.js'));
  runNode(['--test', ...tests]);
}