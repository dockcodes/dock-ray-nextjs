import { DockRayClient, browserEvent } from '@dockcodes/dock-ray';
import { createBrowserErrorHandler } from './browser-route.js';
import { describeNextRequest, tagsFromContext } from './shared.js';

export { browserEvent };
export { browserOptionsFromEnvironment } from './shared.js';
import { optionsFromEnvironment as baseOptionsFromEnvironment } from './shared.js';

export function optionsFromEnvironment(overrides = {}) {
    const env = process.env;
    return baseOptionsFromEnvironment({
        inventoryEnabled: env.RAY_INVENTORY === 'true',
        inventorySiteUrl: env.RAY_INVENTORY_SITE_URL,
        inventoryProjectDirectory: env.RAY_INVENTORY_PROJECT_DIR,
        inventoryStateDirectory: env.RAY_INVENTORY_STATE_DIR,
        inventoryExcludePackages: (env.RAY_INVENTORY_EXCLUDE_PACKAGES ?? '').split(',').map(value => value.trim()).filter(Boolean),
        ...overrides,
    });
}

let client = null;

/**
 * Builds the server client. Call it from `register()` in `instrumentation.ts`,
 * which Next runs once per server bundle before anything is handled.
 */
export function initRay(options = {}) {
    // stop() clears the old SDK timers synchronously before awaiting a send.
    if (client) void client.close().catch(() => {});
    client = new DockRayClient(optionsFromEnvironment(options));

    return client;
}

export function getRay() {
    return client ?? initRay();
}

/**
 * The `onRequestError` export of `instrumentation.ts`.
 *
 * Next calls it for every error it catches - server components, route
 * handlers, server actions - and this is the only hook that sees all of them.
 * It runs after the response has failed, so the report never delays a request.
 *
 *     export const onRequestError = rayRequestError();
 */
export function rayRequestError({ shouldReport = () => true } = {}) {
    return async function onRequestError(error, request, context) {
        const ray = getRay();

        if (!ray.enabled || !shouldReport(error, context)) {
            return;
        }

        const described = describeNextRequest(request);

        await ray.captureException(error, {
            request: described.http,
            user: described.user,
            tags: tagsFromContext(context),
        });
    };
}

/**
 * Wraps a route handler so a throw is reported and then rethrown.
 *
 * `onRequestError` already covers App Router handlers; this is for Pages
 * Router API routes and for anywhere you want the error tagged as yours.
 */
export function withRay(handler, { tags = {} } = {}) {
    return async function rayWrappedHandler(...args) {
        try {
            return await handler(...args);
        } catch (error) {
            const ray = getRay();

            if (ray.enabled) {
                const described = describeNextRequest(args[0]);

                ray.report(ray.captureException(error, {
                    request: described.http,
                    user: described.user,
                    tags,
                }));
            }

            throw error;
        }
    };
}

/**
 * The route that receives JavaScript errors from the browser.
 *
 * A browser cannot hold the project private key, so the page reports here and
 * the server forwards. Mount it at `app/api/ray/browser/route.js`:
 *
 *     export const POST = createBrowserErrorRoute();
 *     export const runtime = 'nodejs';
 */
export function createBrowserErrorRoute(options = {}) {
    return createBrowserErrorHandler(getRay, options);
}

export { createBrowserErrorHandler } from './browser-route.js';

/** Node-only: reuse the SDK reporter, including its lock and rate limits. */
export function reportInventory(options = {}) {
    return getRay().reportInventory(options);
}
