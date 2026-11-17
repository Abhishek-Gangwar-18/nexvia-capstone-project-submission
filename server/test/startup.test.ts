/**
 * Startup check: every route module and the services it imports load, and the key routes are mounted.
 * Catches a missing export (e.g. a removed helper still imported by a controller) before the server is run.
 * No database connection is made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';

const mounted = (app) => {
  const routes = [];
  for (const layer of app._router.stack) {
    if (!layer.handle?.stack) continue;
    // Express 4 mount regex, e.g. ^\/api\/vendor\/?(?=\/|$)  ->  /vendor
    const base = layer.regexp.source.replace('^', '').replace('\\/?(?=\\/|$)', '').replaceAll('\\/', '/');
    for (const r of layer.handle.stack) {
      if (r.route) for (const method of Object.keys(r.route.methods)) routes.push(`${method.toUpperCase()} ${base}${r.route.path}`);
    }
  }
  return routes;
};

test('the app builds and the reviewed routes are mounted', () => {
  const routes = mounted(createApp());
  for (const expected of [
    'PATCH /vendor/store',
    'PATCH /vendor/products/:id',
    'DELETE /vendor/products/:id',
    'PATCH /vendor/orders/:orderId/status',
    'PATCH /admin/orders/:id/packages/:packageId',
    'GET /admin/orders/:id',
    'GET /admin/orders/summary',
    'GET /admin/orders/export',
    'POST /orders/checkout',
    'POST /cart/items',
    'GET /cart/events',
    'PATCH /auth/me/password',
  ]) {
    assert.ok(routes.includes(expected), `missing route: ${expected}`);
  }
});
