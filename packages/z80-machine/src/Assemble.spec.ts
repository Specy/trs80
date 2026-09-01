import {expect} from "chai";
import {
    assemble,
    AssemblyResult,
    AssemblySegment,
    check,
    InMemoryFileSystem,
} from "./Assemble.js";
import {DEFAULT_ENTRY_PATHNAME} from "./Constants.js";

// I can't get mocha to work with TypeScript and ESM, so just provide their
// functions.
let testCount = 0;
let successCount = 0;
function describe(name: string, f: () => void): void {
    testCount++
    try {
        f();
        successCount += 1;
    } catch (e) {
        console.log(name + ": " + e);
    }
}
const it = describe;

/**
 * The bytes of a segment, as a plain array, for easy comparison.
 */
function segmentBytes(segment: AssemblySegment): number[] {
    return Array.from(segment.bytes);
}

/**
 * Both segments and their bytes, as plain values.
 */
function plainSegments(result: AssemblyResult): { address: number, bytes: number[] }[] {
    return result.segments().map(segment => ({
        address: segment.address,
        bytes: segmentBytes(segment),
    }));
}

// Program used by several tests below. Line numbers are zero-based, so
// "start" is on line 1 and the "jp" is on line 4.
const SIMPLE_PROGRAM = [
    "        .org 0x8000",       // 0
    "start:  ld a, 5",           // 1: 0x8000, 2 bytes
    "        ld hl, data",       // 2: 0x8002, 3 bytes
    "loop:   nop",               // 3: 0x8005, 1 byte
    "        jp loop",           // 4: 0x8006, 3 bytes
    "data:   .byte 1, 2, 3",     // 5: 0x8009, 3 bytes
].join("\n");

const SIMPLE_PROGRAM_BYTES = [
    0x3E, 0x05,             // ld a, 5
    0x21, 0x09, 0x80,       // ld hl, data
    0x00,                   // nop
    0xC3, 0x05, 0x80,       // jp loop
    0x01, 0x02, 0x03,       // .byte 1, 2, 3
];

describe("InMemoryFileSystem", () => {
    it("reads text files", () => {
        const fileSystem = new InMemoryFileSystem({
            "main.asm": " nop\n ret",
            "dos.asm": " nop\r\n ret\r\n",
        });

        expect(fileSystem.readTextFile("main.asm")).to.deep.equal([" nop", " ret"]);
        // Carriage returns must not be left at the ends of the lines.
        expect(fileSystem.readTextFile("dos.asm")).to.deep.equal([" nop", " ret", ""]);
        expect(fileSystem.readTextFile("missing.asm")).to.be.undefined;
    });

    it("reads text files through a relative pathname", () => {
        // The assembler resolves included files against the directory of the
        // including file, which turns "other.asm" into "./other.asm".
        const fileSystem = new InMemoryFileSystem({
            "main.asm": " nop",
            "lib/other.asm": " ret",
        });

        expect(fileSystem.readTextFile("./main.asm")).to.deep.equal([" nop"]);
        expect(fileSystem.readTextFile("./lib/other.asm")).to.deep.equal([" ret"]);
        expect(fileSystem.readTextFile("lib/../lib/other.asm")).to.deep.equal([" ret"]);
    });

    it("reads binary files", () => {
        const fileSystem = new InMemoryFileSystem({
            "data.bin": "AB\n",
        });

        expect(Array.from(fileSystem.readBinaryFile("data.bin") ?? [])).to.deep.equal([0x41, 0x42, 0x0A]);
        expect(fileSystem.readBinaryFile("missing.bin")).to.be.undefined;
    });

    it("hands back raw bytes exactly as they were given", () => {
        // UTF-8 can't represent these, so they have to be given as bytes.
        const blob = Uint8Array.from([0xFF, 0xFE, 0x80, 0x00]);
        const fileSystem = new InMemoryFileSystem({
            "main.asm": " nop",
            "sprite.bin": blob,
        });

        expect(Array.from(fileSystem.readBinaryFile("sprite.bin") ?? []))
            .to.deep.equal([0xFF, 0xFE, 0x80, 0x00]);
        expect(fileSystem.readBinaryFile("sprite.bin")?.length).to.equal(blob.length);
        expect(fileSystem.readTextFile("main.asm")).to.deep.equal([" nop"]);
    });

    it("reads bytes given for a source file as text", () => {
        const fileSystem = new InMemoryFileSystem({
            "main.asm": new TextEncoder().encode(" nop\n ret\n"),
        });

        expect(fileSystem.readTextFile("main.asm")).to.deep.equal([" nop", " ret", ""]);
    });

    it("reads directories", () => {
        const fileSystem = new InMemoryFileSystem({
            "main.asm": " nop",
            "lib/b.asm": " nop",
            "lib/a.asm": " nop",
        });

        expect(fileSystem.readDirectory("")).to.deep.equal(["main.asm"]);
        expect(fileSystem.readDirectory(".")).to.deep.equal(["main.asm"]);
        // Sorted, and only the files directly in the directory.
        expect(fileSystem.readDirectory("lib")).to.deep.equal(["a.asm", "b.asm"]);
        expect(fileSystem.readDirectory("./lib")).to.deep.equal(["a.asm", "b.asm"]);
        expect(fileSystem.readDirectory("nope")).to.be.undefined;
    });
});

describe("assemble", () => {
    it("simple program", () => {
        const result = assemble(SIMPLE_PROGRAM);

        expect(result.hasErrors()).to.be.false;
        expect(result.diagnostics).to.deep.equal([]);
        expect(result.sourceFile).to.not.be.undefined;
        expect(result.sourceFile?.fileInfo.pathname).to.equal(DEFAULT_ENTRY_PATHNAME);

        const segments = result.segments();
        expect(segments.length).to.equal(1);
        expect(segments[0].address).to.equal(0x8000);
        expect(segmentBytes(segments[0])).to.deep.equal(SIMPLE_PROGRAM_BYTES);
    });

    it("entry point without end directive is the lowest code address", () => {
        expect(assemble(SIMPLE_PROGRAM).entryPoint).to.equal(0x8000);

        // Lowest address, not the first line with code.
        const result = assemble([
            " .org 0x200",
            " nop",
            " .org 0x100",
            " nop",
        ].join("\n"));
        expect(result.asm.entryPoint).to.be.undefined;
        expect(result.entryPoint).to.equal(0x100);
    });

    it("entry point skips data below the code", () => {
        // The common layout of code at a high org with a message or buffer
        // at a lower one. Starting at the data would execute the string.
        const result = assemble([
            "        .org 0x8000",
            "start:  ld hl, msg",
            "        halt",
            "        .org 0x7000",
            "msg:    .text \"HELLO\"",
        ].join("\n"));

        expect(result.diagnostics).to.deep.equal([]);
        expect(result.entryPoint).to.equal(0x8000);

        // Same with a .byte table.
        expect(assemble([
            "        .org 0x4000",
            "table:  .byte 1, 2, 3",
            "        .org 0x8000",
            "start:  ld a, 5",
            "        halt",
        ].join("\n")).entryPoint).to.equal(0x8000);
    });

    it("entry point of a program with only data is its lowest byte", () => {
        const result = assemble(" .org 0x4000\n .byte 1, 2, 3\n");

        expect(result.diagnostics).to.deep.equal([]);
        expect(result.entryPoint).to.equal(0x4000);
    });

    it("entry point from end directive", () => {
        const result = assemble(SIMPLE_PROGRAM + "\n        end loop\n");

        expect(result.hasErrors()).to.be.false;
        expect(result.asm.entryPoint).to.equal(0x8005);
        expect(result.entryPoint).to.equal(0x8005);
    });

    it("entry point of an empty program is zero", () => {
        const result = assemble(" ; nothing to see here\n");

        expect(result.hasErrors()).to.be.false;
        expect(result.entryPoint).to.equal(0);
        expect(result.segments()).to.deep.equal([]);
    });

    it("segments are sorted and merged", () => {
        // The third org fills the hole right after the first byte, so the two
        // lines make up one contiguous segment.
        const result = assemble([
            " .org 0x100",
            " ld a, 1",
            " .org 0x200",
            " halt",
            " .org 0x102",
            " ret",
        ].join("\n"));

        expect(result.hasErrors()).to.be.false;
        expect(plainSegments(result)).to.deep.equal([
            { address: 0x100, bytes: [0x3E, 0x01, 0xC9] },
            { address: 0x200, bytes: [0x76] },
        ]);
        // Doesn't consume or reorder anything.
        expect(plainSegments(result)).to.deep.equal(plainSegments(result));
    });

    it("string sources are the same as a one-file map", () => {
        const fromString = assemble(SIMPLE_PROGRAM);
        const fromMap = assemble({ [DEFAULT_ENTRY_PATHNAME]: SIMPLE_PROGRAM });

        expect(plainSegments(fromMap)).to.deep.equal(plainSegments(fromString));
        expect(fromMap.entryPoint).to.equal(fromString.entryPoint);
        expect(fromMap.sourceFile?.fileInfo.pathname).to.equal(DEFAULT_ENTRY_PATHNAME);
    });

    it("known labels", () => {
        const result = assemble(" .org 0x8000\n call putchar\n", {
            knownLabels: [{ name: "putchar", address: 0x1234 }],
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(segmentBytes(result.segments()[0])).to.deep.equal([0xCD, 0x34, 0x12]);
    });

    it("include", () => {
        const result = assemble({
            "main.asm": [
                "        .org 0x9000",
                "        #include \"sub.asm\"",
                "        call double",
                "        halt",
            ].join("\n"),
            "sub.asm": [
                "double: add a, a",
                "        ret",
            ].join("\n"),
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(plainSegments(result)).to.deep.equal([
            {
                address: 0x9000,
                bytes: [
                    0x87,                   // add a, a
                    0xC9,                   // ret
                    0xCD, 0x00, 0x90,       // call double
                    0x76,                   // halt
                ],
            },
        ]);
        expect(result.entryPoint).to.equal(0x9000);
    });

    it("inserts a binary blob byte for byte", () => {
        // Every one of these is either unrepresentable in UTF-8 or would come
        // back as more than one byte, which would also shift "after".
        const result = assemble({
            "main.asm": [
                "        .org 0x100",
                "        #insert \"sprite.bin\"",
                "after:  ld hl, after",
            ].join("\n"),
            "sprite.bin": Uint8Array.from([0xFF, 0xFE, 0x80, 0x00]),
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(segmentBytes(result.segments()[0])).to.deep.equal([
            0xFF, 0xFE, 0x80, 0x00,     // the blob, unchanged
            0x21, 0x04, 0x01,           // ld hl, 0x0104
        ]);
    });

    it("include from a subdirectory", () => {
        const result = assemble({
            "main.asm": " .org 0x100\n #include \"lib/sub.asm\"\n call double\n",
            "lib/sub.asm": "double: add a, a\n ret\n",
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(segmentBytes(result.segments()[0])).to.deep.equal([0x87, 0xC9, 0xCD, 0x00, 0x01]);
    });
});

describe("assembly errors", () => {
    it("unknown mnemonic", () => {
        const result = assemble([
            " .org 0x100",       // 0
            " nop",              // 1
            " frobnicate a, b",  // 2
        ].join("\n"));

        expect(result.hasErrors()).to.be.true;
        expect(result.diagnostics.length).to.equal(1);
        expect(result.diagnostics[0].pathname).to.equal(DEFAULT_ENTRY_PATHNAME);
        expect(result.diagnostics[0].lineNumber).to.equal(2);
        expect(result.diagnostics[0].message).to.contain("frobnicate");
    });

    it("unknown identifier", () => {
        const result = assemble([
            " .org 0x100",           // 0
            " ld a, unknownlabel",   // 1
        ].join("\n"));

        expect(result.hasErrors()).to.be.true;
        expect(result.diagnostics.length).to.equal(1);
        expect(result.diagnostics[0].pathname).to.equal(DEFAULT_ENTRY_PATHNAME);
        expect(result.diagnostics[0].lineNumber).to.equal(1);
        expect(result.diagnostics[0].message).to.contain("unknownlabel");
    });

    it("several errors, in order", () => {
        const result = assemble([
            " frobnicate",           // 0
            " nop",                  // 1
            " ld a, unknownlabel",   // 2
        ].join("\n"));

        expect(result.diagnostics.map(d => d.lineNumber)).to.deep.equal([0, 2]);
    });

    it("error in an included file", () => {
        const result = assemble({
            "main.asm": " .org 0x100\n #include \"sub.asm\"\n nop\n",
            "sub.asm": " nop\n frobnicate\n",
        });

        expect(result.diagnostics.length).to.equal(1);
        // The pathname is the one the caller gave us, not the "./sub.asm" that
        // the assembler resolved it to.
        expect(result.diagnostics[0].pathname).to.equal("sub.asm");
        expect(result.diagnostics[0].lineNumber).to.equal(1);
    });

    it("missing include file", () => {
        const result = assemble({
            "main.asm": " .org 0x100\n #include \"nope.asm\"\n",
        });

        expect(result.diagnostics.length).to.equal(1);
        expect(result.diagnostics[0].pathname).to.equal("main.asm");
        expect(result.diagnostics[0].lineNumber).to.equal(1);
    });

    it("a file that includes itself is a diagnostic, not a hang", () => {
        // One line typed into an editor. The assembler splices included lines
        // into the listing it's walking, so without a guard this expands
        // forever without ever returning to the caller.
        const result = assemble(" #include \"main.asm\"\n ld a,1\n");

        expect(result.diagnostics.length).to.equal(1);
        expect(result.diagnostics[0].pathname).to.equal("main.asm");
        expect(result.diagnostics[0].lineNumber).to.equal(0);
        expect(result.diagnostics[0].message).to.contain("cycle");
        // The rest of the file still assembled.
        expect(segmentBytes(result.segments()[0])).to.deep.equal([0x3E, 0x01]);
    });

    it("a cycle between two files is a diagnostic, not a hang", () => {
        const diagnostics = check({
            "main.asm": " .org 0x100\n #include \"b.asm\"\n",
            "b.asm": " #include \"main.asm\"\n nop\n",
        });

        expect(diagnostics.length).to.equal(1);
        expect(diagnostics[0].pathname).to.equal("b.asm");
        expect(diagnostics[0].lineNumber).to.equal(0);
        expect(diagnostics[0].message).to.contain("cycle");
    });

    it("a cycle spelled differently is still a cycle", () => {
        // "./main.asm" and "main.asm" are the same file.
        const diagnostics = check({
            "main.asm": " #include \"./lib/../main.asm\"\n",
        });

        expect(diagnostics.length).to.equal(1);
        expect(diagnostics[0].message).to.contain("cycle");
    });

    it("caps how deeply includes can nest", () => {
        // A chain of files, each including the next. Not a cycle, but the
        // same runaway expansion if it were generated rather than typed.
        const files: Record<string, string> = { "main.asm": " #include \"f0.asm\"\n" };
        for (let i = 0; i < 40; i++) {
            files["f" + i + ".asm"] = " nop\n #include \"f" + (i + 1) + ".asm\"\n";
        }

        const diagnostics = check(files, { entryPathname: "main.asm" });

        expect(diagnostics.length).to.equal(1);
        expect(diagnostics[0].message).to.contain("deep");
    });

    it("including the same file twice without a cycle is fine", () => {
        const result = assemble({
            "main.asm": " .org 0x100\n #include \"sub.asm\"\n #include \"sub.asm\"\n",
            "sub.asm": " nop\n",
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(segmentBytes(result.segments()[0])).to.deep.equal([0x00, 0x00]);
    });

    it("entry file that can't be read", () => {
        const result = assemble({ "main.asm": " nop" }, { entryPathname: "missing.asm" });

        expect(result.hasErrors()).to.be.true;
        expect(result.sourceFile).to.be.undefined;
        expect(result.diagnostics.length).to.equal(1);
        expect(result.diagnostics[0].pathname).to.equal("missing.asm");
        expect(result.diagnostics[0].lineNumber).to.be.undefined;
        expect(result.diagnostics[0].message).to.contain("missing.asm");
        expect(result.entryPoint).to.equal(0);
        expect(result.segments()).to.deep.equal([]);
    });
});

describe("check", () => {
    it("says nothing about good code", () => {
        expect(check(SIMPLE_PROGRAM)).to.deep.equal([]);
    });

    it("returns the same diagnostics as assemble", () => {
        const sources = {
            "main.asm": " .org 0x100\n #include \"sub.asm\"\n frobnicate\n",
            "sub.asm": " ld a, unknownlabel\n",
        };

        expect(check(sources)).to.deep.equal(assemble(sources).diagnostics);
        expect(check(sources).map(d => [d.pathname, d.lineNumber])).to.deep.equal([
            ["sub.asm", 0],
            ["main.asm", 2],
        ]);
    });

    it("passes its options along", () => {
        const sources = " .org 0x100\n call putchar\n";

        expect(check(sources).length).to.equal(1);
        expect(check(sources, { knownLabels: [{ name: "putchar", address: 0x1234 }] })).to.deep.equal([]);
    });
});

describe("entry pathname resolution", () => {
    it("uses main.asm when there is one", () => {
        const result = assemble({
            "other.asm": " frobnicate",
            "main.asm": " .org 0x100\n nop\n",
        });

        expect(result.diagnostics).to.deep.equal([]);
        expect(result.sourceFile?.fileInfo.pathname).to.equal("main.asm");
        expect(result.entryPoint).to.equal(0x100);
    });

    it("uses the only file when there is exactly one", () => {
        const result = assemble({ "program.z80": " .org 0x100\n nop\n" });

        expect(result.diagnostics).to.deep.equal([]);
        expect(result.sourceFile?.fileInfo.pathname).to.equal("program.z80");
    });

    it("honors an explicit entry pathname", () => {
        const result = assemble({
            "main.asm": " frobnicate",
            "other.asm": " .org 0x200\n nop\n",
        }, { entryPathname: "other.asm" });

        expect(result.diagnostics).to.deep.equal([]);
        expect(result.sourceFile?.fileInfo.pathname).to.equal("other.asm");
        expect(result.entryPoint).to.equal(0x200);
    });

    it("throws when the entry file is ambiguous", () => {
        expect(() => assemble({ "a.asm": " nop", "b.asm": " nop" })).to.throw(/entryPathname/);
    });

    it("throws when there are no files at all", () => {
        expect(() => assemble({})).to.throw();
    });
});

console.log(successCount + " successful out of " + testCount, successCount === testCount ? "✅" : "❌");
if (successCount !== testCount) {
    process.exitCode = 1;
}
