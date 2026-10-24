import {describe, expect, it} from "vitest";
import {SymbolType} from "z80-asm";
import {assemble} from "./Assemble.js";
import {CallStackFrame} from "./CallStack.js";
import {SourceMap} from "./SourceMap.js";
import type {Z80Machine} from "./Z80Machine.js";

// Program used by most of the tests. Line numbers are zero-based.
//
//   line  address  bytes
//      0           SCREEN equ 0x3C00
//      1           .org 0x8000
//      2  0x8000   CD 07 80    (main)
//      3  0x8003   21 00 3C
//      4  0x8006   76
//      5  0x8007   3E 01       (sub)
//      6  0x8009   C9
//      7                       (blank)
//      8  0x800A   01 02 03 04 (table)
const PROGRAM = [
    "SCREEN  equ 0x3c00",           // 0
    "        .org 0x8000",          // 1
    "main:   call sub",             // 2
    "        ld hl, SCREEN",        // 3
    "        halt",                 // 4
    "sub:    ld a, 1",              // 5
    "        ret",                  // 6
    "",                             // 7
    "table:  .byte 1, 2, 3, 4",     // 8
].join("\n");

/**
 * A source map of the program above, checked for assembly errors first so
 * that a broken program doesn't look like a broken source map.
 */
function makeSourceMap(sources: string | Record<string, string>): SourceMap {
    const result = assemble(sources);
    expect(result.diagnostics).to.deep.equal([]);
    return new SourceMap(result);
}

describe("addressToLocation", () => {
    it("maps every byte of an instruction to its line", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        // Three-byte instruction on line 2.
        expect(sourceMap.addressToLocation(0x8000)).to.deep.equal({ pathname: "main.asm", lineNumber: 2 });
        expect(sourceMap.addressToLocation(0x8001)).to.deep.equal({ pathname: "main.asm", lineNumber: 2 });
        expect(sourceMap.addressToLocation(0x8002)).to.deep.equal({ pathname: "main.asm", lineNumber: 2 });
        // Next instruction.
        expect(sourceMap.addressToLocation(0x8003)).to.deep.equal({ pathname: "main.asm", lineNumber: 3 });
        // One-byte instruction.
        expect(sourceMap.addressToLocation(0x8006)).to.deep.equal({ pathname: "main.asm", lineNumber: 4 });
        // Data.
        expect(sourceMap.addressToLocation(0x800A)).to.deep.equal({ pathname: "main.asm", lineNumber: 8 });
        expect(sourceMap.addressToLocation(0x800D)).to.deep.equal({ pathname: "main.asm", lineNumber: 8 });
    });

    it("has nothing for addresses the program didn't fill", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        expect(sourceMap.addressToLocation(0x0000)).to.be.undefined;
        expect(sourceMap.addressToLocation(0x7FFF)).to.be.undefined;
        expect(sourceMap.addressToLocation(0x800E)).to.be.undefined;
        expect(sourceMap.addressToLocation(0xFFFF)).to.be.undefined;
        // Outside of the address space entirely.
        expect(sourceMap.addressToLocation(-1)).to.be.undefined;
        expect(sourceMap.addressToLocation(0x10000)).to.be.undefined;
    });

    it("names the file that bytes came from", () => {
        const sourceMap = makeSourceMap({
            "main.asm": " .org 0x100\n #include \"sub.asm\"\n halt\n",
            "sub.asm": " nop\n ret\n",
        });

        expect(sourceMap.addressToLocation(0x100)).to.deep.equal({ pathname: "sub.asm", lineNumber: 0 });
        expect(sourceMap.addressToLocation(0x101)).to.deep.equal({ pathname: "sub.asm", lineNumber: 1 });
        expect(sourceMap.addressToLocation(0x102)).to.deep.equal({ pathname: "main.asm", lineNumber: 2 });
    });
});

describe("locationToAddress", () => {
    it("finds the address of code and data lines", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        expect(sourceMap.locationToAddress(2)).to.equal(0x8000);
        expect(sourceMap.locationToAddress(3)).to.equal(0x8003);
        expect(sourceMap.locationToAddress(4)).to.equal(0x8006);
        expect(sourceMap.locationToAddress(5)).to.equal(0x8007);
        expect(sourceMap.locationToAddress(6)).to.equal(0x8009);
        // Data line.
        expect(sourceMap.locationToAddress(8)).to.equal(0x800A);
    });

    it("has nothing for lines that generate no bytes", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        expect(sourceMap.locationToAddress(0)).to.be.undefined;    // equ
        expect(sourceMap.locationToAddress(1)).to.be.undefined;    // org
        expect(sourceMap.locationToAddress(7)).to.be.undefined;    // blank
        expect(sourceMap.locationToAddress(100)).to.be.undefined;  // past the end
        expect(sourceMap.locationToAddress(2, "nosuchfile.asm")).to.be.undefined;
    });

    it("defaults to the entry file", () => {
        const sourceMap = makeSourceMap({ "program.asm": PROGRAM });

        expect(sourceMap.locationToAddress(2)).to.equal(0x8000);
        expect(sourceMap.locationToAddress(2, "program.asm")).to.equal(0x8000);
    });

    it("takes the pathname of an included file", () => {
        const sourceMap = makeSourceMap({
            "main.asm": " .org 0x100\n #include \"sub.asm\"\n halt\n",
            "sub.asm": " nop\n ret\n",
        });

        expect(sourceMap.locationToAddress(0, "sub.asm")).to.equal(0x100);
        expect(sourceMap.locationToAddress(1, "sub.asm")).to.equal(0x101);
        // However the caller spells it.
        expect(sourceMap.locationToAddress(1, "./sub.asm")).to.equal(0x101);
        expect(sourceMap.locationToAddress(2)).to.equal(0x102);
        // Line 2 of the entry file, not of the included file.
        expect(sourceMap.locationToAddress(2, "sub.asm")).to.be.undefined;
    });
});

describe("symbolAt", () => {
    it("returns the label an address belongs to", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        // Right on the label.
        expect(sourceMap.symbolAt(0x8000)?.name).to.equal("main");
        expect(sourceMap.symbolAt(0x8007)?.name).to.equal("sub");
        expect(sourceMap.symbolAt(0x800A)?.name).to.equal("table");
        // Inside the routine, the nearest label at or below.
        expect(sourceMap.symbolAt(0x8003)?.name).to.equal("main");
        expect(sourceMap.symbolAt(0x8006)?.name).to.equal("main");
        expect(sourceMap.symbolAt(0x8009)?.name).to.equal("sub");
        expect(sourceMap.symbolAt(0x800D)?.name).to.equal("table");
        // Past the end of the program, the last label still owns it.
        expect(sourceMap.symbolAt(0xFFFF)?.name).to.equal("table");
    });

    it("has nothing below the first symbol", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        expect(sourceMap.symbolAt(0x7FFF)).to.be.undefined;
        expect(sourceMap.symbolAt(0x0000)).to.be.undefined;
    });

    it("ignores constants, which aren't addresses", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        // SCREEN is 0x3C00, which is below the whole program.
        expect(sourceMap.symbolAt(0x3C00)).to.be.undefined;
        expect(sourceMap.result.asm.symbols.find(s => s.name === "screen")?.type)
            .to.equal(SymbolType.CONSTANT);
    });

    it("includes known labels", () => {
        // Same program, one with the ROM routine named and one without.
        const withoutLabels = makeSourceMap(" .org 0x8000\n call 0x1234\n");
        expect(withoutLabels.symbolAt(0x1234)).to.be.undefined;

        const result = assemble(" .org 0x8000\n call putchar\n", {
            knownLabels: [{ name: "putchar", address: 0x1234 }],
        });
        expect(result.diagnostics).to.deep.equal([]);

        const withLabels = new SourceMap(result);
        expect(withLabels.symbolAt(0x1234)?.name).to.equal("putchar");
        expect(withLabels.symbolAt(0x1240)?.name).to.equal("putchar");
        expect(withLabels.symbolAt(0x1233)).to.be.undefined;
    });

    it("has nothing for a program without symbols", () => {
        const sourceMap = makeSourceMap(" .org 0x100\n nop\n");

        expect(sourceMap.symbolAt(0x100)).to.be.undefined;
    });
});

describe("namedCallStack", () => {
    // We don't want to depend on a running machine here, so fake the one
    // method we use.
    function fakeMachine(frames: CallStackFrame[]): Z80Machine {
        return {
            getCallStack(): CallStackFrame[] {
                return frames;
            },
        } as unknown as Z80Machine;
    }

    it("names each frame after the symbol at its target", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        const frames: CallStackFrame[] = [
            {
                callSiteAddress: 0x8000,
                targetAddress: 0x8007,
                returnAddress: 0x8003,
                stackAddress: 0xFFFD,
            },
            {
                callSiteAddress: 0x1000,
                targetAddress: 0x8000,
                returnAddress: 0x1003,
                stackAddress: 0xFFFF,
            },
        ];

        expect(sourceMap.namedCallStack(fakeMachine(frames))).to.deep.equal([
            { ...frames[0], name: "sub" },
            { ...frames[1], name: "main" },
        ]);
    });

    it("names frames the way the source spells the label", () => {
        // The assembler's identifiers are case-insensitive, so symbolAt()
        // reports the lower-cased canonical name. The frame name is for
        // display, so it keeps the spelling the programmer used.
        const sourceMap = makeSourceMap([
            "        .org 0x8000",
            "DrawSprite:  ret",
        ].join("\n"));

        const frame: CallStackFrame = {
            callSiteAddress: 0x1000,
            targetAddress: 0x8000,
            returnAddress: 0x1003,
            stackAddress: 0xFFFD,
        };

        expect(sourceMap.symbolAt(0x8000)?.name).to.equal("drawsprite");
        expect(sourceMap.namedCallStack(fakeMachine([frame]))[0].name).to.equal("DrawSprite");
    });

    it("leaves unknown targets unnamed", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        const frame: CallStackFrame = {
            callSiteAddress: 0x8000,
            targetAddress: 0x0100,
            returnAddress: 0x8003,
            stackAddress: 0xFFFD,
        };

        const named = sourceMap.namedCallStack(fakeMachine([frame]));
        expect(named.length).to.equal(1);
        expect(named[0].name).to.be.undefined;
        expect(named[0].targetAddress).to.equal(0x0100);
    });

    it("is empty for an empty call stack", () => {
        const sourceMap = makeSourceMap(PROGRAM);

        expect(sourceMap.namedCallStack(fakeMachine([]))).to.deep.equal([]);
    });
});
