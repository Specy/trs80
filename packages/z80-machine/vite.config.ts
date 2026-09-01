import {copyFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {defineConfig} from "vite";
import dts from "vite-plugin-dts";

// Where the rolled-up declarations land, and the copy of them that the
// CommonJS build needs (see the afterBuild hook below).
const ESM_TYPES = fileURLToPath(new URL("dist/index.d.ts", import.meta.url));
const CJS_TYPES = fileURLToPath(new URL("dist/index.d.cts", import.meta.url));

// This package is bundled (unlike its siblings, which are plain tsc builds)
// so that the published artifact is fully self-contained: the z80-* packages
// it builds on are compiled in, and the rolled-up .d.ts has no external
// imports. This lets the library be used directly from a CDN or npm without
// any of the monorepo's other packages being published.
export default defineConfig({
    build: {
        lib: {
            entry: "src/index.ts",
            name: "Z80Machine",
            fileName: "index",
            formats: ["es", "umd"],
        },
        sourcemap: true,
        rollupOptions: {
            // Bundle everything; no runtime dependencies.
            external: [],
        },
    },
    plugins: [
        dts({
            rollupTypes: true,
            // Inline the z80-* declarations into our rolled-up index.d.ts, so
            // that it doesn't import from (or re-export) packages that aren't
            // published alongside this one.
            bundledPackages: ["z80-base", "z80-inst", "z80-emulator", "z80-asm", "z80-disasm"],
            // TypeScript picks a declaration file by condition and then by
            // extension: a ".d.ts" in a "type": "module" package is an ES
            // module declaration, which a CommonJS file is not allowed to
            // require, however good the ".umd.cjs" build next to it is. The
            // rolled-up declarations have no imports of their own, so the
            // same file under a ".d.cts" name serves the CommonJS build.
            afterBuild: () => {
                copyFileSync(ESM_TYPES, CJS_TYPES);
            },
        }),
    ],
});
