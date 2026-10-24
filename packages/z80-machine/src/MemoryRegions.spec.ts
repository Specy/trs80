import {describe, expect, it} from "vitest";
import {assemble} from "./Assemble.js";
import {Z80Machine} from "./Z80Machine.js";

const PROGRAM = ` org $4000
start: ld sp,$8000
 push hl
 halt
bytes: db 1,2,3
 align 4
words: dw 7
room: ds 16
filled: ds 8,$aa
 end start`;

describe("memory regions", () => {
    it("gives each emitting line an emission kind", () => {
        const assembly = assemble(PROGRAM);
        expect(assembly.hasErrors(), JSON.stringify(assembly.diagnostics)).to.equal(false);
        const lines = assembly.asm.assembledLines;
        expect(lines.find(line => line.line.startsWith("start:"))?.kind).to.equal("code");
        expect(lines.find(line => line.line.startsWith("bytes:"))?.kind).to.equal("data");
        expect(lines.find(line => line.line.startsWith("room:"))?.kind).to.equal("reserved");
        expect(lines.find(line => line.line.startsWith("filled:"))?.kind).to.equal("reserved");
        expect(lines[0].kind).to.equal(undefined);
    });

    it("keeps the stack top through Undo, save and restore", () => {
        const machine = new Z80Machine({historySize: 100});
        machine.loadAssembly(assemble(PROGRAM));
        const initial = machine.getStackTop();
        machine.step();
        expect(machine.getStackTop()).to.equal(0x8000);
        machine.step();
        expect(machine.getStackTop()).to.equal(0x8000);
        machine.undo();
        expect(machine.getStackTop()).to.equal(0x8000);
        machine.undo();
        expect(machine.getStackTop()).to.equal(initial);
        machine.step();
        const saved = machine.save();
        machine.reset();
        machine.restore(saved);
        expect(machine.getStackTop()).to.equal(0x8000);
    });
});
