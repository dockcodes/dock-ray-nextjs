import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InventoryReporter } from '@dockcodes/dock-ray';
import { initRay, getRay, reportInventory, optionsFromEnvironment } from '../src/index.js';
import { initRay as initEdgeRay, optionsFromEnvironment as edgeOptions } from '../src/edge.js';
import { browserOptionsFromEnvironment } from '../src/shared.js';

test('inventory environment is opt-in, server-only and options take precedence', t => {
    const settings = { RAY_INVENTORY: 'true', RAY_INVENTORY_SITE_URL: 'https://site.example',
        RAY_INVENTORY_EXCLUDE_PACKAGES: ' @company/*, ,private-pkg ' };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    t.after(() => { for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    assert.equal(optionsFromEnvironment().inventoryEnabled, true);
    assert.equal(optionsFromEnvironment().inventorySiteUrl, 'https://site.example');
    assert.deepEqual(optionsFromEnvironment().inventoryExcludePackages, ['@company/*', 'private-pkg']);
    assert.equal(optionsFromEnvironment({ inventoryEnabled: false }).inventoryEnabled, false);
    assert.equal(edgeOptions().inventoryEnabled, undefined);
    assert.equal(browserOptionsFromEnvironment().inventorySiteUrl, undefined);
    assert.equal(initEdgeRay().inventory, undefined);
    process.env.RAY_INVENTORY = '1';
    assert.equal(optionsFromEnvironment().inventoryEnabled, false);
});

test('reinitialization stops previous SDK scheduling; requests reuse their client', async () => {
    const first = initRay({ inventoryEnabled: true });
    assert.ok(first.inventory instanceof InventoryReporter);
    assert.ok(first.inventory.timer);
    assert.equal(getRay(), first);
    const second = initRay({ inventoryEnabled: false });
    assert.equal(first.inventory.timer, null);
    assert.equal(first.inventory.initial, null);
    assert.equal(getRay(), second);
    assert.equal((await reportInventory()).status, 'disabled');
    await second.close();
});

test('Next reports actual npm inventory through SDK with shared throttling', async t => {
    const root = await mkdtemp(join(tmpdir(), 'dockray-next-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manifest = { name: 'site', dependencies: { next: '^15.0.0' } };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
        packages: { '': manifest, 'node_modules/next': { version: '15.0.0' } } }));
    await mkdir(join(root, 'node_modules/next'), { recursive: true });
    await writeFile(join(root, 'node_modules/next/package.json'), '{"name":"next","version":"15.0.0"}');
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, request) => {
        requests.push({ url, request });
        return new Response('{"success":true,"vulnerable":1,"next_report_in":43200}');
    });
    const ray = initRay({ token: 'project', privateKey: 'private-key', inventoryEnabled: true,
        inventorySiteUrl: 'https://site.example', inventoryProjectDirectory: root,
        inventoryStateDirectory: join(root, 'state') });
    t.after(() => ray.close());
    assert.equal((await reportInventory()).status, 'sent');
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].request.body);
    assert.equal(payload.platform, 'nodejs');
    assert.equal(payload.components[0].slug, 'next@15.0.0');
    assert.equal(requests[0].request.headers.Authorization, 'Bearer private-key');
    assert.equal(requests[0].request.redirect, 'error');
    assert.equal((await reportInventory()).status, 'not_due');
    assert.equal(requests.length, 1);
});
