# Design Chamber — Product Documentation

Plain-English descriptions of every page and feature. Updated by whoever makes the change,
before any feature is marked Done. Accepted minor issues: [known-issues.md](known-issues.md). If code and these docs disagree, the code is right —
fix the doc and note what drifted.

## Pages
| Page | Route | One-liner |
|---|---|---|
| [Rail panel](pages/rail-panel.md) | the Design Chamber icon in OpenChamber's rail (`panel` surface) | The navigator in OpenChamber's rail: browse designs, compact viewer, settings. |
| [Full-screen page](pages/full-screen-page.md) | OpenChamber sidebar → Extension pages → Design Chamber (`page` surface) | The library, the canvas wall and the artifact viewer. |

## Features
| Feature | One-liner | Pages involved |
|---|---|---|
| [The local service](features/local-service.md) | Designs folder and settings, folder names, containment, live change feed. | Rail panel, Full-screen page |
| [Rendering, versions, export, thumbnails](features/rendering-versions-export-thumbnails.md) | What the local service does: self-contained renders, snapshots, downloads, previews. | Rail panel, Full-screen page |
| [Agent instructions](features/agent-instructions.md) | The chip and RULES.md that steer the chat agent; revision requests; Open as artifact. | Rail panel, Full-screen page, chat |
