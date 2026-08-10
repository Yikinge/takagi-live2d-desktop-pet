# Takagi Live2D runtime model

This directory contains the runtime Cubism model exported with Cubism Editor,
plus the final t004 overlay assets used by the desktop pet.

The application validates the model entry point at `Takagi.model3.json` and the
parameter contract in `art/specs/parameter-map.json` before enabling Live2D.

The `overlays/` directory intentionally contains only the seven assets used by
the final t004 composition. Rebuild them from the two final PSDs with:

```bash
.venv-art/bin/python art/tools/build_t004_from_state_psds.py
```

Cubism model files and formats remain subject to Live2D's licenses. Character
art is not covered by an open-source software license.
