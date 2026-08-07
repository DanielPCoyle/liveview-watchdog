# Instrumentation is verified on the network, never in the queue

## When this applies

Adding or changing analytics, error reporting, metrics, logging shipped to a
third party, or any fire-and-forget beacon.

## What broke

GA4 was deployed and looked correct from every angle: the tag script loaded with
the right measurement ID, `window.gtag` was a function, and `event:wall_started`
was visibly sitting in `dataLayer`. **Zero requests ever left the browser** —
including for a `gtag()` call made by hand.

The queue takes the `arguments` object, not an array. `dataLayer.push(args)`
with a rest parameter produces a real `Array`, which enqueues, inspects
correctly in a console, and is never read by `gtag.js`.

The unit test passed throughout because it asserted `Array.isArray(entry)` —
it was pinning the bug.

## Required actions

1. Verify by observing an **outbound request**: intercept it in a headless
   browser and assert on the payload. Presence of a global, a queued entry, or a
   loaded script proves none of it.
2. For batched vendors, check **POST bodies** as well as query parameters — GA4
   sends custom events in a batch body.
3. When a test asserts on the shape of a third-party contract, pin the shape the
   **vendor reads**, and record why next to the assertion.

## Verify before completion

Name the request that was observed and the event it carried. "Wired up" is not
the claim; "a beacon left the browser carrying this event" is.
