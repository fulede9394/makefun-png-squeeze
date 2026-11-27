# PNG Squeeze — make.fun entry

Lossless PNG re-encoder for 1280×720 RGBA screenshots. It decodes each
screenshot, picks the cheapest lossless representation (palette when the
image uses ≤ 256 colours, grey / grey+alpha / RGB / RGBA otherwise), chooses
PNG filters per row by a sum-of-absolute-residual cost, and compresses with
Node's built-in zlib at level 9, keeping the smallest of several
filter-stream / deflate-setting combinations. Deterministic, no network, no
clock — everything it runs is in this repository.

Competition: [PNG squeeze — png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127)

[![bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/fulede9394/makefun-png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/fulede9394/makefun-png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

## Run

```sh
node main.ts
```

Reads `/input/<id>/image.png` for `i001`–`i008` and writes
`/output/<id>/image.png`, creating each output directory. Node 22+, no
dependencies beyond Node's built-ins.
