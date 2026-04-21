# Third-Party Notices

`@vibecook/mille-ui` redistributes content from the following projects. Each
section lists the project, license, upstream link, and (where applicable) the
pinned version we vendor.

---

## Material Icon Theme

**Source:** https://github.com/material-extensions/vscode-material-icon-theme
**License:** MIT
**Pinned version:** 5.33.1 (see `src/icons/material/sources.json`)
**Vendored as:** `src/icons/material/generated.ts` (inlined SVGs + theme JSON,
subset of ~150 most-common icons).

Copyright (c) Material Extensions and contributors.

> MIT License
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

---

## Codicons

**Source:** https://github.com/microsoft/vscode-codicons
**License:** Creative Commons Attribution 4.0 (CC BY 4.0) for icons; MIT for
Python/TypeScript/build tooling.

Derivative shapes informed the default icon set at
`src/icons/assets/index.ts`. No upstream files are redistributed verbatim; only
small monoline SVGs drawn in the same visual register are included.

---

Questions on attribution or licensing belong to the project maintainer. If you
believe a dependency is missing from this file, please open an issue.
