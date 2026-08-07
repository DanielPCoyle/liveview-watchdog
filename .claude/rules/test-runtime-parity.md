# "Passes locally" is a claim about your machine

## When this applies

Any test failure that reproduces in CI but not locally, or the reverse. Also
when adding module mocks, or when local tooling versions drift from CI's.

## What broke

31 tests passed locally and failed in CI with
`THREE.WebGLRenderer: Error creating WebGL context` — the real three.js, not the
stub.

`mock.module` only rebinds imports that happen **after** it runs. One suite
imported `VideoWall` without installing the mock, so whichever file bun
evaluated first decided what every later file received. Locally that order
happened to work. It was a race, not an environment difference, and the local
pass was luck.

Compounding it: local bun was 1.3.11 while CI installed 1.3.14.

## Required actions

1. Register library mocks in the **test preload**, which runs before any test
   file, not inside individual suites. Test-file-level mocking is order-dependent
   by construction.
2. When a suite and CI disagree, suspect **evaluation order and version drift**
   before suspecting the environment.
3. Match the local runtime to CI's before claiming a fix. If CI pins `latest`,
   upgrade locally rather than asserting from an older version.

## Verify before completion

Run the suite on the same runtime version CI installs, and say which version was
used. Do not report "passes locally" as evidence that CI will pass.
