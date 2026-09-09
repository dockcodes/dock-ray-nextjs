import { DockRayClient, browserEvent } from '@dockcodes/dock-ray';
import { createBrowserErrorHandler } from './browser-route.js';
import { describeNextRequest, optionsFromEnvironment, tagsFromContext } from './shared.js';

export { browserEvent };
export { optionsFromEnvironment, browserOptionsFromEnvironment } from './shared.js';

let client = null;

/**
 * Builds the server client. Call it from `register()` in `instrumentation.ts`,
 * which Next runs once per server bundle before anything is handled.
 */
export function initRay(options = {}) {
    client = new DockRayClient(optionsFromEnvironment(options));

    return client;
}

export function getRay() {
    return client ?? initRay();
}

/**
 * The `onRequestError` export of `instrumentation.ts`.
 *
 * Next calls it for every error it catches — server components, route
 * handlers, server actions — and this is the only hook that sees all of them.
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
