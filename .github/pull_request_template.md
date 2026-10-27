## What and why
<!-- One or two sentences: what this changes and the reason. Link issues with "Fixes #123". -->

## How it was verified
<!-- Paste real output, not "tests pass". -->
- [ ] `npm run check` passes locally (tail pasted below)
- [ ] macOS-affecting change (paths, Chrome discovery, reveal, file access): `npm run check` run on a Mac — CI does not cover macOS
- [ ] UI change: checked in OpenChamber in light and dark theme, rail at 320 px and the full-screen page (screenshots below)

```
npm run check tail here
```

## Risk surfaces touched
- [ ] Sandboxed iframes / bridge messages
- [ ] Local service auth or routes
- [ ] Path containment / filesystem writes under the Designs folder
- [ ] None of the above

## Docs
- [ ] `documentation/` updated for behaviour changes (or not needed)
- [ ] `docs/SPEC.md` updated for architecture or API changes (or not needed)

## Screenshots
<!-- Redact personal paths and names. -->
