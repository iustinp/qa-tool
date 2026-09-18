# scoper — deterministic source-site scoping via recurring pear signatures

Experimental (issue #65, branch `experiment/source-scoping`). Reuses the canonical-layout
("pear") representation to **discover reusable block structures across a source site** —
programmatically, deterministically, no AI — as a fast precursor to EDS migration scoping.

## Isolation contract (important)

This directory is **purely additive**. It:
- imports pear code from `../lib` **read-only**, and
- **never edits** any existing file in the repo (`lib/`, `index.js`, …).

That way the main project can keep evolving in parallel and this experiment merges cleanly
(or is abandoned) with zero conflict. If something here ever *needs* data the pear doesn't
expose, prefer a thin adapter here that post-processes pear output over editing `lib/`.

## Core idea

A pear is a framework-blind, styled, positioned point cloud of a page. A reusable block ≈ a
**recurring sub-constellation** in that cloud. The signature of a block is built from what does
NOT change when content grows — the **style** of each leaf and the **topology** between leaves —
never the actual text/image content and never absolute pixel distances. That is what makes it
elastic to content-length variation and framework-agnostic.

See issue #65 for the full design and the fork decisions (B-first, site-global size tiers,
images as first-class content-blind tokens).

## PoC 1 — neighborhood-descriptor recurrence (`poc-neighborhood.js`)

The cheapest probe of the core hypothesis, offline against existing pear JSON:
for every node, build a content-blind **neighborhood descriptor** (its own style-token + the
style-tokens and relative directions of its nearest neighbors) and count cross-page recurrence.

Question it answers: do block-like neighborhoods (heterogeneous: image + heading + link nearby)
separate from prose (homogeneous text)? And do distinct blocks form distinct descriptor groups?

```bash
node scoper/poc-neighborhood.js [runDir]
# default runDir: test-run_grace_20260820231416/pairs
```
