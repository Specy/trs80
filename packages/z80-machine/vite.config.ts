import {copyFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig} from "vite";
import dts from "vite-plugin-dts";

// Where the rolled-up declarations land, and the copy of them that the
// CommonJS build needs (see the afterBuild hook below).
const ESM_TYPES = fileURLToPath(new URL("dist/index.d.ts", import.meta.url));
const CJS_TYPES = fileURLToPath(new URL("dist/index.d.cts", import.meta.url));

// The TypeScript that API Extractor comes with. Unlike TypeScript 7, it has
// the standard library's declarations on disk.
const require = createRequire(import.meta.url);
const API_EXTRACTOR_TYPESCRIPT = dirname(
    createRequire(require.resolve("@microsoft/api-extractor")).resolve("typescript/package.json"));

// The packages of this repo that this one is compiled from.
const Z80_PACKAGES = ["z80-base", "z80-inst", "z80-emulator", "z80-asm", "z80-disasm", "z80-logger"];

// This package is bundled (unlike its siblings, which aren't built at all)
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
        rolldownOptions: {
            // Bundle everything; no runtime dependencies.
            external: [],
        },
    },
    plugins: [
        dts({
            // The z80-* packages export their TypeScript source, so the
            // rolled-up declarations need declarations of that source too.
            // Resolved through node_modules, it would count as an external
            // library's and get none, so "paths" names each package's source
            // directly. The plugin also turns these paths into aliases, and
            // rewrites the imports of the packages to the emitted files,
            // which API Extractor can follow (it can't read .ts source).
            compilerOptions: {
                paths: Object.fromEntries(Z80_PACKAGES.map(name => [name, ["../" + name + "/src/index"]])),
                // Emit under dist/<package>/src, for this package and those.
                rootDir: "..",
            },
            entryRoot: "..",
            include: ["src/**/*.ts", ...Z80_PACKAGES.map(name => "../" + name + "/src/**/*.ts")],
            exclude: ["**/*.spec.ts", "**/*.test.ts", "**/*.template.ts"],
            bundleTypes: {
                invokeOptions: {
                    // The plugin would point API Extractor at the
                    // "typescript" package, TypeScript 7, for the standard
                    // library's declarations, and finding none there leaves
                    // even Uint8Array undefined.
                    typescriptCompilerFolder: API_EXTRACTOR_TYPESCRIPT,
                },
            },
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
