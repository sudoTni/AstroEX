# Third-Party Software Notices and Licenses

AstroOM incorporates code, algorithms, or adaptations from the following open-source projects:

---

## 1. ts-jobspy
- **Project:** ts-jobspy (https://github.com/alpharomercoma/ts-jobspy)
- **Copyright:** Copyright (c) 2025-2026 Alpha Romer Coma
- **License:** MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 2. JobSpy
- **Project:** JobSpy (https://github.com/speedyapply/JobSpy)
- **Copyright:** Copyright (c) 2023 Cullen Watson, Zachary Hampton
- **License:** MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 3. LinkedIn Jobs Scraper
- **Project:** linkedin-jobs-scraper (https://github.com/llpujol/linkedin-jobs-scraper)
- **Copyright:** Copyright (c) 2023 llpujol
- **License:** MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 4. Dina Font Family (embedded asset)

- **Font Family:** Dina / DinaRemasterII
- **Original Author:** Jani Nurminen
- **Remastered By:** Zachary Shoals (`zshoals`)
- **License / Terms:** Dina Font License (permissive redistribution; public-domain / MIT equivalent)
- **File Distributed:** `DinaRemasterII.ttc` (TrueType Collection, 46,544 bytes)
- **SHA-256:** `ebca3d277e9c552774ea24c4630b14e2f82fc15c2c9032731b363d85753996df`
- **Redistribution in AstroOM:** the font is embedded into the compiled `astroom`
  binary at build time (`include_bytes!` in `src/utils/gif_export.rs`) and is
  used to render the animated logo produced by `astroom --record-logo-gif`.

AstroOM is therefore a combined work with respect to this font asset. The font
is redistributed unmodified; its license permits redistribution in this form.
Full provenance, per-face metrics, and collection layout are documented in
[`assets/fonts/README.md`](assets/fonts/README.md).

---

## 5. Rust Crate Dependencies

AstroOM's Rust implementation additionally depends on third-party packages
published on [crates.io](https://crates.io/). The authoritative, checksum-pinned
list is [`Cargo.lock`](../Cargo.lock); every entry there carries a `source` and a
`checksum`, and this repository contains no Git or local-path dependencies.

These dependencies are **not** reproduced here. Each remains under its own
license — predominantly MIT and Apache-2.0, with some BSD, ISC, Zlib, and
Unicode-3.0 licensed crates. To enumerate licenses for a specific build, use
`cargo license` or `cargo about`, which read `Cargo.lock` directly.

Notable components include: `clap`, `tokio`, `tokio-util`, `reqwest` (with
`hyper`, `rustls`/`native-tls`, and `openssl` in the dependency graph),
`serde`/`serde_json`, `rusqlite` (bundled SQLite), `scraper` (with `html5ever`),
`regex`, `chrono`, `rand`, `uuid`, `sha2`, `hex`, `indexmap`, `libc`, `gif`, and
`ab_glyph` (with `owned_ttf_parser`).

---

## 6. Provenance

AstroOM is a Rust port of an earlier Node.js implementation of this pipeline
(the "AstroEX" project). Sections 1 through 3 above correspond to acquisition
code vendored or adapted from `ts-jobspy`, `JobSpy`, and `linkedin-jobs-scraper`
respectively, and remain applicable to the Rust code in `src/acquisition/`.

The differential test suite under `tests/differential/` and the
`tests/*_differential.rs` integration tests replay fixtures generated by that
Node implementation, and reference it by name for provenance. Those references
are documentation of test oracles and do not imply authorship or endorsement by
any of the third-party projects listed above.
