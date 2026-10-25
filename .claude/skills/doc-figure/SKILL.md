---
name: doc-figure
description: Create or revise a figure in the Alcove docs -- a hand-laid SVG grounded in code and checked by independent render and read-back reviews. Recipe: the architecture diagram (docs/img/architecture.svg).
disable-model-invocation: true
---

# Doc figure

Produce a figure a senior engineer can absorb in one look. Every figure follows the shared method -- ground, compose, verify, deliver -- and each kind of figure has a recipe below holding its file, altitude, layout and visual grammar. Each phase caught real errors the first time this was done (a TURN server that does not exist, an inverted crypto/transport layering, a missing shipping subsystem); do not skip one.

## Shared method

One figure, one altitude: the recipe sets it, and anything below it -- wire formats, per-module detail -- is docs/spec territory. Label everything exactly once: no text repeated between a lane title, a group header, a node, and an edge.

### Phase 1: ground every element in code

- Trust code over docs. Read package.json files for the dependency graph, the module a label names before drawing it, and the Dockerfile before claiming how anything ships. docs/spec on the current integration branch is the cross-check, not the source.
- Keep a per-node file citation list while working; every box and edge must trace to a file. A node you cannot cite is a node you cannot draw.
- Classes of error to re-check every revision: infrastructure the docs promise but the code lacks; subsystems added since the figure was last touched; and the recipe's own list.

### Phase 2: compose by hand, never auto-layout

Auto-layout (Mermaid/dagre) cannot hold a designed layout; hand-author SVG with fixed coordinates.

- Keep the legend able to physically show each distinction the visual grammar draws.
- An arrow means what it touches: land a flow on the node it enters, not on box borders or empty header space. Give parallel rails inside a box real separation (10px+ apart, 10px+ from the border).

### Phase 3: verify with independent passes

Run these as separate fresh-context reviews (subagents), not self-checks:

1. Render and screenshot, then a design critique on the image: landing points, orphan stubs, legend/drawing mismatches, cramped rails, anything that looks like a rendering speck.
2. A fresh-eyes engineer read-back: write down what the figure alone claims, then verify each claim against code, then against docs/spec; report contradictions at this altitude only. Where a spec and the drawing disagree, flag it -- do not silently prefer either.
3. Re-render after every geometry change; SVG edits that look right in source routinely collide in render.

### Outputs

- Repo (source of truth): the SVG under docs/img/ the recipe names -- self-contained (internal <style>, no external fonts or CSS vars), background rect, embedded legend, ASCII-only labels per repo convention, referenced from the doc section the recipe names. Edit this SVG directly on revisions; keep coordinates on the existing grid.
- Shareable page: wrap the same SVG in a theme-aware HTML page (tokens on :root, dark overrides) when an artifact or standalone page is wanted.
- Print PNG: render the page with headless Chrome -- window-size at the target aspect, force-device-scale-factor for resolution (e.g. 1000x1200 at 3x = 3000x3600 for 10x12in at 300ppi) -- then stamp the DPI metadata (System.Drawing SetResolution on Windows, ImageMagick -density elsewhere; Chrome writes none).

## Recipes

A recipe states its figure's SVG and the doc section that embeds it, its altitude, its layout, its visual grammar, and its own classes of error. A new kind of figure gets its own `###` section here in the shape of the architecture diagram's, added with the figure's first version.

### Architecture diagram

A component-level diagram of Alcove: the minimum set of components, the open-source libraries they build on, and how they connect. Use for requests like "diagram the components", "show how the pieces connect", or "update the architecture diagram".

- File: docs/img/architecture.svg, referenced from the System architecture section at the end of docs/README.md.
- Altitude: the workspaces, their major components, the boundaries (interfaces core defines and apps implement), and the external/trust boundary. Name a library on a node only when it is correctness- or security-critical (docs/spec/DEPENDENCY_PINS.md is the roster; @openmined/psi.js, @noble/curves, re2js, ssh2-sftp-client, PeerJS rank; yargs does not).
- Classes of error: deployment groupings (what actually ships together); decorator/wrapper layer order (who wraps whom -- read the constructor, not the prose); library attributions on crypto and parsing nodes.
- Why hand layout: the apps are a hub with core on one side and the external world on the other, and one cross-cluster edge wrecks an auto-layout's ranking.
- Layout: three lanes, CORE LIBRARY | APPLICATIONS - THIS MACHINE | EXTERNAL. Apps in the middle; call edges go left into core, channel edges go right to the outside. The counterparty is one tall dashed column labeled "same stack, mirrored", never a duplicated stack.
- Visual grammar:
  - stroke color = lane (blue core, teal apps, amber external); edges stay a quiet neutral
  - solid arrow = call / data flow; both apps merge into a single trunk landing on the runExchange node, the entry point
  - dotted arrow = app implements a core interface
  - dotted line, no arrowhead = connection setup (signaling, NAT traversal), never the data path
  - double-headed = two-party channel; dashed border = external / across the trust boundary
- Section eyebrows inside core (DATA PIPELINE / SECURE CHANNEL / DISCLOSURE) carry grouping; nodes carry a title plus a mono sub-label holding the identifier or library name.
