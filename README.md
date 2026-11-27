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

## Practice results

| Instance | Theme | Bytes | Points (of 125,000) | Winning stream |
| --- | --- | ---: | ---: | --- |
| i001 | flat | 12,496 | 89,796 | zlib level 9 |
| i002 | rich | 51,852 | 88,192 | zlib level 9 |
| i003 | alpha | 102,217 | 87,717 | custom DEFLATE |
| i004 | grey | 103,669 | 88,500 | custom DEFLATE |
| i005 | flat | 16,552 | 92,781 | zlib level 9 |
| i006 | rich | 171,909 | 89,353 | custom DEFLATE |
| i007 | alpha | 60,935 | 87,676 | zlib level 9 |
| i008 | grey | 24,897 | 89,270 | zlib level 9 |

Every output decodes pixel-exact (verified against the kit decoder). The custom DEFLATE wins on the images where long matches dominate; zlib wins where the optimal-parse block headers cost more than they save — the `min()` of the two is what ships. Work is budgeted by fixed block sizes and chain depths, never by the clock, so the 60-second wall for the whole set is met with margin.
