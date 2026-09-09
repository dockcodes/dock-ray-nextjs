'use client';

import { startCollector, collectorConfig } from '@dockcodes/dock-ray/browser';
import { browserOptionsFromEnvironment } from './shared.js';

let stop = null;

/**
 * Starts browser error collection.
 *
 * Off unless `NEXT_PUBLIC_RAY_JS_ERRORS` is `true`, because the collector is
 * a decision about visitors' pages, not a default. Errors go to your own
 * route, which forwards them with the project key — a browser cannot hold that
 * key without publishing it.
 *
 * Mount it once, in the root layout:
 *
 *     'use client';
 *     import { RayBrowserReporting } from '@dockcodes/dock-ray-next/client';
 */
export function startRayBrowserReporting(overrides = {}) {
    const options = browserOptionsFromEnvironment(overrides);

    if (!options.enabled || typeof window === 'undefined') {
        return () => {};
    }

    // React strict mode mounts effects twice; a second collector would double
    // every report.
    stop?.();
    stop = startCollector(collectorConfig(options));

    return () => {
        stop?.();
        stop = null;
    };
}

/**
 * A component for the root layout. It renders nothing and only sets the
 * listeners up.
 */
export function RayBrowserReporting(props = {}) {
    if (typeof window !== 'undefined' && !stop) {
        startRayBrowserReporting(props);
    }

    return null;
}

/**
 * Reports an error you caught yourself, through the same route.
 * Useful from `app/global-error.jsx` and React error boundaries.
 */
export function captureBrowserException(error, overrides = {}) {
    const options = browserOptionsFromEnvironment(overrides);

    if (!options.enabled || typeof window === 'undefined' || !error) {
        return;
    }

    if (window.DockRay) {
        window.DockRay.captureException(error);

        return;
    }

    startRayBrowserReporting(overrides);
    window.DockRay?.captureException(error);
}
