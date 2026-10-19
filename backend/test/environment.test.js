import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../portal-shared.js', import.meta.url), 'utf8');

function portalFor(url, saved = {}) {
  const entries = new Map(Object.entries(saved));
  const context = vm.createContext({
    window: { location: new URL(url) },
    localStorage: {
      getItem: key => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: key => entries.delete(key),
    },
  });
  vm.runInContext(source, context);
  return context.window.StickmanPortal;
}

for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8127', 'http://[::1]:8080']) {
  test(`${origin} uses its local API proxy despite stale production overrides`, () => {
    const portal = portalFor(`${origin}/portal-admin.html`, {
      stickmanPortalApiBase: 'https://api.stickman-handyman.com',
      stickmanAdminApiBase: 'https://api.stickman-handyman.com',
    });
    assert.equal(portal.readApiBase(), origin);
  });
}

for (const host of ['stickman-handyman.com', 'www.stickman-handyman.com']) {
  test(`${host} always uses the production API`, () => {
    const portal = portalFor(`https://${host}/portal-admin.html`, {
      stickmanPortalApiBase: 'http://localhost:3000',
    });
    assert.equal(portal.readApiBase(), 'https://api.stickman-handyman.com');
  });
}

test('file previews retain an explicit API override', () => {
  const portal = portalFor('file:///preview/portal-admin.html', { stickmanPortalApiBase: 'http://localhost:3000/' });
  assert.equal(portal.readApiBase(), 'http://localhost:3000');
});