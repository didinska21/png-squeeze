# png-squeeze

[![Competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/didinska21/png-squeeze/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/didinska21/png-squeeze/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

A lossless PNG recompressor in a single file (`main.ts`, Node built-ins only). It reads 8 screenshots (1280x720 RGBA) from `/input/<id>/image.png` and writes the smallest exact PNG for each to `/output/<id>/image.png`.

How it squeezes: per image it tries palette, grey, grey+alpha, RGB and RGBA forms (palette order by luminance or by count, with a tRNS transparent key where possible), picks per-row PNG filters (minsum, fewest-pairs, LZ77-cost and fixed filters), screens every candidate with zlib level 9, then runs its own optimal-parse DEFLATE (hash-chain lazy matching + dynamic-programming parse + dynamic Huffman, 64 KiB blocks) on the best two candidates and keeps whichever stream — custom or zlib — is smaller. Deterministic: two runs write byte-identical files.

Practice set score: **713,285 / 1,000,000** in ~31 s for all 8 images (house baseline fixed-paeth: 420,399).

## Run it

```sh
node main.ts
```
