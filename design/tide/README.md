# Tide design reference

The approved Tide reference was frozen on September 8, 2026, against commit `fb9ebac`.
Current application behavior is documented in [the product specification](../../docs/SPEC.md).
Delivery planning and implementation discussion belong in [PR #123](https://github.com/stephenw310/attn/pull/123).

## Open the approved brief

Download and extract [approved-brief.zip](approved-brief.zip). Serve the extracted directory locally:

```sh
python3 -m http.server 4325 --bind 127.0.0.1 --directory tide-brief
```

Open <http://127.0.0.1:4325/gallery.html>. Use another free port if 4325 is occupied.
The archive contains the interactive brief, its assets, and 266 light and dark renders for 133 states.
The gallery groups them into 33 families. Select a state within a family to compare variants.

`brief-manifest.json` maps each state to a URL, render, and source module. The source and shortcut inventories
are snapshots, not live product specifications. The prototype uses simulated data and simplified interactions.
Use it for appearance and interaction intent. Implement through the existing React components and command registry.
Do not port its accumulated HTML overrides into production.
