import {describe, expect, it} from "vitest";
import {assemble} from "./Assemble.js";
import {CallStackFrame, callInstructionLength, disassembleInstructionAt} from "./CallStack.js";
import {CALL_STACK_LIMIT} from "./Constants.js";
import {Z80Machine} from "./Z80Machine.js";
import {StopReason, Z80MachineConfig} from "./Z80MachineTypes.js";

// Disassemble bytes as if they were at the given address.
function disassembleBytes(bytes: number[], address: number = 0x8000) {
    const memory = new Uint8Array(64*1024);
    memory.set(bytes, address);
    return disassembleInstructionAt(a => memory[a], address);
}

describe("disassembleInstructionAt", () => {
    it("plain instructions", () => {
        const nop = disassembleBytes([0x00]);
        expect(nop.mnemonic).to.equal("nop");
        expect(nop.bin.length).to.equal(1);

        const ld = disassembleBytes([0x3E, 0x05]);
        expect(ld.toText(false)).to.equal("ld a,0x05");
        expect(ld.bin.length).to.equal(2);
        expect(ld.address).to.equal(0x8000);
        expect(ld.nextAddress()).to.equal(0x8002);
    });

    it("call has a jump target", () => {
        const call = disassembleBytes([0xCD, 0x34, 0x12]);
        expect(call.mnemonic).to.equal("call");
        expect(call.jumpTarget).to.equal(0x1234);
        expect(call.bin.length).to.equal(3);

        const conditional = disassembleBytes([0xC4, 0x00, 0x90]);
        expect(conditional.mnemonic).to.equal("call");
        expect(conditional.args).to.deep.equal(["nz", "0x9000"]);
        expect(conditional.jumpTarget).to.equal(0x9000);
    });

    it("rst", () => {
        const rst = disassembleBytes([0xEF]);
        expect(rst.mnemonic).to.equal("rst");
        expect(rst.args).to.deep.equal(["28"]);
        expect(rst.bin.length).to.equal(1);
    });

    it("DD and FD prefixed instructions", () => {
        const ldIx = disassembleBytes([0xDD, 0x21, 0x34, 0x12]);
        expect(ldIx.toText(false)).to.equal("ld ix,0x1234");
        expect(ldIx.bin.length).to.equal(4);

        const ldFromIx = disassembleBytes([0xDD, 0x7E, 0x05]);
        expect(ldFromIx.toText(false)).to.equal("ld a,(ix+0x05)");
        expect(ldFromIx.bin.length).to.equal(3);

        // Data is the third byte, before the opcode's last byte.
        const ldToIy = disassembleBytes([0xFD, 0x36, 0x02, 0x7B]);
        expect(ldToIy.toText(false)).to.equal("ld (iy+0x02),0x7B");
        expect(ldToIy.bin.length).to.equal(4);
    });

    it("ED prefixed instructions", () => {
        const ldir = disassembleBytes([0xED, 0xB0]);
        expect(ldir.mnemonic).to.equal("ldir");
        expect(ldir.bin.length).to.equal(2);

        const ldBc = disassembleBytes([0xED, 0x4B, 0x34, 0x12]);
        expect(ldBc.toText(false)).to.equal("ld bc,(0x1234)");
        expect(ldBc.bin.length).to.equal(4);
    });

    it("CB prefixed instruction", () => {
        const bit = disassembleBytes([0xCB, 0x40]);
        expect(bit.toText(false)).to.equal("bit 0,b");
        expect(bit.bin.length).to.equal(2);
    });

    it("relative jump to itself", () => {
        const jr = disassembleBytes([0x18, 0xFE], 0x8000);
        expect(jr.mnemonic).to.equal("jr");
        expect(jr.jumpTarget).to.equal(0x8000);
    });

    it("unknown opcode doesn't throw", () => {
        const defb = disassembleBytes([0xED, 0x77]);
        expect(defb.mnemonic).to.equal("defb");
        expect(defb.isExecutable).to.be.false;
        expect(defb.bin.length).to.be.greaterThan(0);
    });

    it("reads only through the given reader", () => {
        // Reader that doesn't touch any memory array at all.
        const bytes = [0xCD, 0x00, 0x90];
        let readCount = 0;
        const instruction = disassembleInstructionAt(address => {
            readCount += 1;
            return bytes[address - 0x1000] ?? 0;
        }, 0x1000);
        expect(instruction.mnemonic).to.equal("call");
        expect(instruction.jumpTarget).to.equal(0x9000);
        expect(readCount).to.equal(3);
    });
});

describe("callInstructionLength", () => {
    // The length of the instruction made of these bytes, at 0x8000.
    function lengthOf(...bytes: number[]): number {
        const memory = new Uint8Array(64*1024);
        memory.set(bytes, 0x8000);
        return callInstructionLength(a => memory[a], 0x8000);
    }

    it("knows the calls and the restarts", () => {
        expect(lengthOf(0xCD, 0x00, 0x90)).to.equal(3);
        for (const opcode of [0xC4, 0xCC, 0xD4, 0xDC, 0xE4, 0xEC, 0xF4, 0xFC]) {
            expect(lengthOf(opcode, 0x00, 0x90)).to.equal(3);
        }
        for (const opcode of [0xC7, 0xCF, 0xD7, 0xDF, 0xE7, 0xEF, 0xF7, 0xFF]) {
            expect(lengthOf(opcode)).to.equal(1);
        }
    });

    it("counts the prefixes in front of a call", () => {
        expect(lengthOf(0xDD, 0xCD, 0x00, 0x90)).to.equal(4);
        expect(lengthOf(0xFD, 0xDD, 0xFF)).to.equal(3);
    });

    it("is 0 for everything else that can lower the stack pointer by two", () => {
        expect(lengthOf(0xE5)).to.equal(0);                       // push hl
        expect(lengthOf(0xDD, 0xE5)).to.equal(0);                 // push ix
        expect(lengthOf(0xF9)).to.equal(0);                       // ld sp,hl
        expect(lengthOf(0x31, 0xFE, 0xFF)).to.equal(0);           // ld sp,0xfffe
        expect(lengthOf(0xED, 0x7B, 0x00, 0x90)).to.equal(0);     // ld sp,(0x9000)
        expect(lengthOf(0xC9)).to.equal(0);                       // ret
        expect(lengthOf(0xC3, 0x00, 0x90)).to.equal(0);           // jp 0x9000
    });
});

/**
 * Assemble a program and load it into a new machine, failing the test if
 * it doesn't assemble.
 */
function load(source: string, config?: Z80MachineConfig): {machine: Z80Machine, at: (label: string) => number} {
    const result = assemble(source);
    expect(result.diagnostics).to.deep.equal([]);
    const machine = new Z80Machine(config);
    machine.loadAssembly(result);

    const at = (label: string): number => {
        const symbol = result.asm.symbols.find(symbol => symbol.name === label.toLowerCase());
        if (symbol === undefined) {
            throw new Error("no label " + label);
        }
        return symbol.value;
    };

    return {machine, at};
}

/**
 * What the tests compare between two moments of a run: where the program
 * is, and its Call stack.
 */
interface Moment {
    pc: number;
    sp: number;
    depth: number;
    frames: CallStackFrame[];
}

/**
 * The machine's position and Call stack now.
 */
function momentOf(machine: Z80Machine): Moment {
    return {
        pc: machine.z80.regs.pc,
        sp: machine.z80.regs.sp,
        depth: machine.getCallDepth(),
        frames: machine.getCallStack(),
    };
}

/**
 * Step the machine count times, and return the moment before the first step
 * and after each one.
 */
function stepThrough(machine: Z80Machine, count: number): Moment[] {
    const moments = [momentOf(machine)];
    for (let i = 0; i < count; i++) {
        const reason = machine.step();
        expect(reason === undefined || reason === StopReason.HALTED, "step " + i).to.be.true;
        moments.push(momentOf(machine));
    }
    return moments;
}

/**
 * Undo the steps that made these moments, one at a time, and check that
 * each undo brings back exactly the moment before it.
 */
function expectUndoRetraces(machine: Z80Machine, moments: Moment[]): void {
    expect(momentOf(machine)).to.deep.equal(moments[moments.length - 1]);
    for (let i = moments.length - 2; i >= 0; i--) {
        expect(machine.undo()).to.be.true;
        expect(momentOf(machine), "undone back to moment " + i).to.deep.equal(moments[i]);
    }
}

describe("tracked call stack", () => {
    it("pushes a frame on a call and takes it off on the return", () => {
        const {machine, at} = load(`
        .org 0x100
main:   call sub
        halt
sub:    nop
        ret
`, {historySize: 100});

        expect(machine.getCallDepth()).to.equal(0);
        expect(machine.getCallStack()).to.deep.equal([]);

        const moments = stepThrough(machine, 4);
        expect(moments[1].depth).to.equal(1);
        expect(moments[1].frames).to.deep.equal([{
            callSiteAddress: at("main"),
            targetAddress: at("sub"),
            returnAddress: at("main") + 3,
            stackAddress: 0xFFFD,
            kind: "call",
        }]);
        expect(moments[2].depth).to.equal(1);
        expect(moments[3].depth).to.equal(0);
        expect(moments[3].frames).to.deep.equal([]);

        expectUndoRetraces(machine, moments);
    });

    it("tracks nested calls, innermost first", () => {
        const {machine, at} = load(`
        .org 0x100
        call one
        halt
one:    call two
        ret
two:    call three
        ret
three:  ret
`, {historySize: 100});

        const moments = stepThrough(machine, 7);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 2, 3, 2, 1, 0, 0]);
        expect(moments[3].frames.map(frame => frame.targetAddress))
            .to.deep.equal([at("three"), at("two"), at("one")]);
        expect(moments[3].frames.map(frame => frame.stackAddress))
            .to.deep.equal([0xFFF9, 0xFFFB, 0xFFFD]);

        expectUndoRetraces(machine, moments);
    });

    it("gives every level of a recursion a frame of its own", () => {
        const {machine, at} = load(`
        .org 0x100
        ld b, 3
        call count
        halt
count:  dec b
        ret z
inner:  call count
        ret
`, {historySize: 100});

        // ld, then three passes of call / dec / ret z (taken the third
        // time), then the two rets back out, and the halt.
        const moments = stepThrough(machine, 13);
        expect(moments.map(moment => moment.depth))
            .to.deep.equal([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 2, 1, 0, 0]);
        const deepest = moments[9].frames;
        expect(deepest.map(frame => frame.targetAddress)).to.deep.equal([at("count"), at("count"), at("count")]);
        expect(deepest.map(frame => frame.callSiteAddress)).to.deep.equal([at("inner"), at("inner"), 0x0102]);
        expect(machine.z80.regs.pc).to.equal(0x0105);

        expectUndoRetraces(machine, moments);
    });

    it("pushes a frame for a conditional call only when it is taken", () => {
        const {machine, at} = load(`
        .org 0x100
        xor a           ; sets Z
notTaken:
        call nz, sub
taken:  call z, sub
        halt
sub:    ret
`, {historySize: 100});

        const moments = stepThrough(machine, 4);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 0, 0, 1, 0]);
        expect(moments[2].pc).to.equal(at("taken"));
        expect(moments[3].frames[0].callSiteAddress).to.equal(at("taken"));

        expectUndoRetraces(machine, moments);
    });

    it("pushes a frame for an rst and for a prefixed call", () => {
        const machine = new Z80Machine({historySize: 100});
        machine.loadBinary([
            0xEF,                   // 0x0100  rst 0x28
            0xDD, 0xCD, 0x10, 0x02, // 0x0101  call 0x0210, with a DD prefix
            0x76,                   // 0x0105  halt
        ], 0x0100);
        machine.loadBinary([0xC9], 0x0028);         // ret
        machine.loadBinary([0xC9], 0x0210, 0x0100); // ret

        const moments = stepThrough(machine, 4);
        expect(moments[1].frames).to.deep.equal([{
            callSiteAddress: 0x0100,
            targetAddress: 0x0028,
            returnAddress: 0x0101,
            stackAddress: 0xFFFD,
            kind: "call",
        }]);
        expect(moments[2].depth).to.equal(0);
        expect(moments[3].frames).to.deep.equal([{
            callSiteAddress: 0x0101,
            targetAddress: 0x0210,
            returnAddress: 0x0105,
            stackAddress: 0xFFFD,
            kind: "call",
        }]);
        expect(moments[4].depth).to.equal(0);
        expect(moments[4].pc).to.equal(0x0105);

        expectUndoRetraces(machine, moments);
    });

    it("pushes no frame for a push", () => {
        const {machine} = load(`
        .org 0x100
        ld hl, 0x0104   ; looks like a return address
        push hl
        pop hl
        halt
`);

        machine.step();
        machine.step();
        expect(machine.getCallDepth()).to.equal(0);
    });

    it("pushes a frame for an interrupt, gone at its handler's return", () => {
        const machine = new Z80Machine({historySize: 100});
        machine.loadBinary([
            0xED, 0x56,             // 0x0100  im 1
            0xFB,                   // 0x0102  ei
            0xCD, 0x00, 0x02,       // 0x0103  call 0x0200
            0x76,                   // 0x0106  halt
        ], 0x0100);
        machine.loadBinary([
            0xFB,                   // 0x0038  ei
            0xED, 0x4D,             // 0x0039  reti
        ], 0x0038);
        machine.loadBinary([
            0x00,                   // 0x0200  nop
            0xC9,                   // 0x0201  ret
        ], 0x0200, 0x0100);

        const moments = stepThrough(machine, 3);
        expect(machine.z80.regs.pc).to.equal(0x0200);
        const before = machine.getInstructionsExecuted();

        machine.raiseInterrupt();
        moments.push(momentOf(machine));
        expect(machine.getInstructionsExecuted()).to.equal(before + 1);
        expect(machine.getCallDepth()).to.equal(2);
        expect(machine.getCallStack()[0]).to.deep.equal({
            callSiteAddress: 0x0200,
            targetAddress: 0x0038,
            returnAddress: 0x0200,
            stackAddress: 0xFFFB,
            kind: "interrupt",
        });
        expect(machine.getCallStack()[1].kind).to.equal("call");

        // ei, reti back into the routine, then its nop and ret.
        moments.push(...stepThrough(machine, 4).slice(1));
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 0, 0, 1, 2, 2, 1, 1, 0]);
        expect(machine.z80.regs.pc).to.equal(0x0106);

        // The interrupt is a record of its own, and undoing it takes its
        // frame away.
        expectUndoRetraces(machine, moments);
    });

    it("gives an interrupt that wakes a halt the address after it", () => {
        const machine = new Z80Machine();
        machine.loadBinary([
            0xED, 0x56,             // 0x0100  im 1
            0xFB,                   // 0x0102  ei
            0x76,                   // 0x0103  halt
        ], 0x0100);
        machine.loadBinary([0xC9], 0x0038, 0x0100);

        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INTERRUPT);
        machine.raiseNmi();
        expect(machine.getCallStack()).to.deep.equal([{
            callSiteAddress: 0x0103,
            targetAddress: 0x0066,
            returnAddress: 0x0104,
            stackAddress: 0xFFFD,
            kind: "interrupt",
        }]);
    });

    it("pushes nothing for an interrupt the CPU ignores", () => {
        const machine = new Z80Machine();
        machine.loadBinary([0x00, 0x76], 0x0100);
        machine.step();
        const before = machine.getInstructionsExecuted();

        machine.raiseInterrupt();
        expect(machine.getCallDepth()).to.equal(0);
        expect(machine.getInstructionsExecuted()).to.equal(before);
    });

    it("ends a call whose routine changes its return address", () => {
        // The routine reads the bytes after the call and returns past them.
        const {machine, at} = load(`
        .org 0x100
        call print
        .byte 'A', 0
after:  halt
print:  ex (sp), hl     ; hl = the return address
        ld a, (hl)
        inc hl
        inc hl
        ex (sp), hl     ; return past the data
        ret
`, {historySize: 100});

        const moments = stepThrough(machine, 7);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 1, 1, 1, 1, 1, 0]);
        // The frame keeps the return address the call pushed.
        expect(moments[6].frames[0].returnAddress).to.equal(0x0103);
        expect(machine.z80.regs.pc).to.equal(at("after"));
        expect(machine.z80.regs.a).to.equal(0x41);

        expectUndoRetraces(machine, moments);
    });

    it("ends a call at the pop of its return address", () => {
        const {machine, at} = load(`
        .org 0x100
        call sub
        halt
sub:    pop hl
jump:   jp (hl)
`, {historySize: 100});

        const moments = stepThrough(machine, 3);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 0, 0]);
        expect(moments[2].pc).to.equal(at("jump"));
        expect(moments[3].pc).to.equal(0x0103);

        expectUndoRetraces(machine, moments);
    });

    it("ends a tail call when the second routine returns", () => {
        const {machine, at} = load(`
        .org 0x100
        call first
        halt
first:  jp second
second: ret
`, {historySize: 100});

        const moments = stepThrough(machine, 3);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 1, 0]);
        expect(moments[2].frames[0].targetAddress).to.equal(at("first"));
        expect(moments[3].pc).to.equal(0x0103);

        expectUndoRetraces(machine, moments);
    });

    it("works with the stack at the very top of memory", () => {
        const {machine} = load(`
        .org 0x100
        ld sp, 0
        call outer
        halt
outer:  call leaf
        ret
leaf:   ret
`, {historySize: 100});

        const moments = stepThrough(machine, 6);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 0, 1, 2, 1, 0, 0]);
        expect(moments[3].frames.map(frame => frame.stackAddress)).to.deep.equal([0xFFFC, 0xFFFE]);
        // The outermost return lands at 0x0000, two above 0xFFFE.
        expect(moments[5].sp).to.equal(0x0000);

        expectUndoRetraces(machine, moments);
    });

    it("works with an initial stack pointer of 0", () => {
        const {machine} = load(`
        .org 0x100
        call outer
        halt
outer:  ret
`, {initialSp: 0});

        machine.step();
        expect(machine.getCallStack().map(frame => frame.stackAddress)).to.deep.equal([0xFFFE]);
        machine.step();
        expect(machine.getCallDepth()).to.equal(0);
    });

    it("keeps the frames while a routine borrows SP to fill memory", () => {
        const {machine, at} = load(`
        .org 0x100
        call fill
        halt
fill:   ld (save), sp
        ld sp, 0x4008
        ld hl, 0xAAAA
        push hl
        push hl
        push hl
        push hl
        ld sp, (save)
        ret
save:   .word 0
`, {historySize: 100});

        const moments = stepThrough(machine, 10);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
        expect(moments[9].frames[0].targetAddress).to.equal(at("fill"));
        expect(Array.from(machine.memory.subarray(0x4000, 0x4008))).to.deep.equal(new Array(8).fill(0xAA));

        expectUndoRetraces(machine, moments);
    });

    it("takes several frames off in one instruction, and undo puts them all back", () => {
        // A longjmp: the innermost routine puts SP back where the outermost
        // caller saved it, and jumps there.
        const {machine, at} = load(`
        .org 0x100
        ld (saved), sp
        call one
back:   halt
one:    call two
two:    call three
three:  ld sp, (saved)
        jp back
saved:  .word 0
`, {historySize: 100});

        const moments = stepThrough(machine, 6);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 0, 1, 2, 3, 0, 0]);
        expect(machine.z80.regs.pc).to.equal(at("back"));

        expectUndoRetraces(machine, moments);
    });

    it("undoes exactly after a later call reuses a slot", () => {
        const {machine} = load(`
        .org 0x100
        call one
        call two
        halt
one:    ret
two:    call one
        ret
`, {historySize: 100});

        const moments = stepThrough(machine, 7);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 0, 1, 2, 1, 0, 0]);
        // The second call's frame sits where the first one's did.
        expect(moments[1].frames[0].stackAddress).to.equal(moments[3].frames[0].stackAddress);
        expect(moments[1].frames[0].callSiteAddress).to.not.equal(moments[3].frames[0].callSiteAddress);

        expectUndoRetraces(machine, moments);
    });

    it("checks the frames after a poke moves SP, and again after an undo", () => {
        const {machine} = load(`
        .org 0x100
        call sub
        halt
sub:    nop
        nop
        ret
`, {historySize: 100});
        machine.step();
        expect(machine.getCallDepth()).to.equal(1);

        // The poke itself takes nothing off: frames are checked after an
        // instruction. The next instruction, which leaves SP alone, does.
        machine.beginPoke();
        machine.setRegisterValue("sp", 0xFFFF);
        machine.endPoke();
        expect(machine.getCallDepth()).to.equal(1);
        machine.step();
        expect(machine.getCallDepth()).to.equal(0);

        // Undone, the frame is back, and the same instruction takes it off
        // again.
        machine.undo();
        expect(machine.getCallDepth()).to.equal(1);
        machine.step();
        expect(machine.getCallDepth()).to.equal(0);

        // Undoing the poke as well leaves the frame where it was.
        machine.undo();
        machine.undo();
        expect(machine.getCallDepth()).to.equal(1);
        machine.step();
        expect(machine.getCallDepth()).to.equal(1);
    });

    it("tracks frames without a history", () => {
        const {machine} = load(`
        .org 0x100
        call one
        halt
one:    call two
        ret
two:    ret
`);

        expect(stepThrough(machine, 5).map(moment => moment.depth)).to.deep.equal([0, 1, 2, 1, 0, 0]);
        expect(machine.canUndo()).to.be.false;
    });

    it("hands back only the newest frames when asked for some", () => {
        const {machine, at} = load(`
        .org 0x100
        call one
        halt
one:    call two
        ret
two:    call three
        ret
three:  ret
`);

        machine.step();
        machine.step();
        machine.step();
        expect(machine.getCallStack(2).map(frame => frame.targetAddress)).to.deep.equal([at("three"), at("two")]);
        expect(machine.getCallStack(10).length).to.equal(3);
        expect(machine.getCallStack(0)).to.deep.equal([]);

        // The frames are copies.
        machine.getCallStack()[0].targetAddress = 0;
        expect(machine.getCallStack()[0].targetAddress).to.equal(at("three"));
    });

    it("forgets the frames on a reset or a load", () => {
        const {machine} = load(`
        .org 0x100
        call one
one:    halt
`);

        machine.step();
        expect(machine.getCallDepth()).to.equal(1);
        machine.reset();
        expect(machine.getCallDepth()).to.equal(0);

        machine.loadBinary([0xCD, 0x03, 0x01, 0x76], 0x0100);
        machine.step();
        expect(machine.getCallDepth()).to.equal(1);
        machine.loadBinary([0x76], 0x0100);
        expect(machine.getCallDepth()).to.equal(0);
    });
});

describe("call stack limit", () => {
    // A call used as a jump, which adds a frame on every pass.
    const LOOP = [0xCD, 0x00, 0x01];            // 0x0100  call 0x0100

    it("keeps the newest frames and goes on counting the depth", () => {
        // The stack wraps round all of memory, so the code is kept in ROM.
        const machine = new Z80Machine({onMemoryWrite: address => address >= 0x0100 && address < 0x0103});
        machine.loadBinary(LOOP, 0x0100);

        const calls = CALL_STACK_LIMIT + 5;
        const result = machine.run({maxInstructions: calls});
        expect(result.reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);

        expect(machine.getCallDepth()).to.equal(calls);
        expect(machine.getCallStack().length).to.equal(CALL_STACK_LIMIT);
        // The stack pointer has wrapped round memory, and the newest frame is
        // where it points.
        expect(machine.getCallStack(1)[0].stackAddress).to.equal(machine.z80.regs.sp);
    });

    it("undoes exactly across the limit", () => {
        const machine = new Z80Machine({historySize: 100, callStackLimit: 3});
        machine.loadBinary(LOOP, 0x0100);

        const moments = stepThrough(machine, 6);
        expect(moments.map(moment => moment.depth)).to.deep.equal([0, 1, 2, 3, 4, 5, 6]);
        expect(moments[6].frames.map(frame => frame.stackAddress)).to.deep.equal([0xFFF3, 0xFFF5, 0xFFF7]);

        expectUndoRetraces(machine, moments);
    });

    it("leaves the dropped frames counted once the kept ones have returned", () => {
        // Four calls deep with room for two, then four returns: the two kept
        // frames go, and the two dropped ones stay counted, since nothing
        // more is known of them.
        const {machine} = load(`
        .org 0x100
        call one
        halt
one:    call two
        ret
two:    call three
        ret
three:  call four
        ret
four:   ret
`, {callStackLimit: 2});

        for (let i = 0; i < 4; i++) {
            machine.step();
        }
        expect(machine.getCallDepth()).to.equal(4);
        expect(machine.getCallStack().length).to.equal(2);

        machine.step();
        machine.step();
        expect(machine.getCallDepth()).to.equal(2);
        expect(machine.getCallStack()).to.deep.equal([]);
    });

    it("must be at least 1", () => {
        expect(() => new Z80Machine({callStackLimit: 0})).to.throw(RangeError);
        expect(() => new Z80Machine({callStackLimit: 1.5})).to.throw(RangeError);
    });

    it("drops the oldest frames of a snapshot from a machine with a higher limit", () => {
        const machine = new Z80Machine();
        machine.loadBinary(LOOP, 0x0100);
        machine.run({maxInstructions: 5});
        const state = machine.save();
        expect(state.callStack.length).to.equal(5);
        expect(state.callDepth).to.equal(5);

        const small = new Z80Machine({callStackLimit: 2});
        small.restore(state);
        expect(small.getCallDepth()).to.equal(5);
        expect(small.getCallStack()).to.deep.equal(state.callStack.slice(0, 2));
    });
});
