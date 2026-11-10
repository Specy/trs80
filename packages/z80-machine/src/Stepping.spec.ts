import {describe, expect, it} from "vitest";
import {assemble} from "./Assemble.js";
import {Z80Machine} from "./Z80Machine.js";
import {StopReason, Z80MachineConfig} from "./Z80MachineTypes.js";

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

// A routine that calls another, so that stepping over it passes through
// returns that are not the one the step waits for.
const NESTED = `
        .org 0x100
        ld b, 0
main:   call outer
after:  inc b
        halt
outer:  call inner
        call inner
        inc b
last:   ret
inner:  inc b
        nop
        ret
`;

describe("untilCallDepth", () => {
    it("stops having executed nothing when the depth is already reached", () => {
        const {machine, at} = load(NESTED);
        machine.step();

        const result = machine.run({untilCallDepth: 0});
        expect(result).to.deep.equal({reason: StopReason.CALL_DEPTH, tStates: 0, instructions: 0});
        expect(machine.stopReason).to.equal(StopReason.CALL_DEPTH);
        expect(machine.z80.regs.pc).to.equal(at("main"));
        expect(machine.isTerminated()).to.be.false;

        // Any depth at or above the current one.
        expect(machine.run({untilCallDepth: 3}).instructions).to.equal(0);
    });

    it("steps over a call: one instruction, then a run back to the depth", () => {
        const {machine, at} = load(NESTED);
        machine.step();

        expect(machine.step()).to.be.undefined;
        expect(machine.getCallDepth()).to.equal(1);
        const result = machine.run({untilCallDepth: 0});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        // outer: call, inc, nop, ret, call, inc, nop, ret, inc, ret.
        expect(result.instructions).to.equal(10);
        expect(machine.z80.regs.pc).to.equal(at("after"));
        expect(machine.z80.regs.b).to.equal(3);
    });

    it("steps out of a routine with one less than the depth", () => {
        const {machine, at} = load(NESTED);
        machine.run({breakpoints: [at("inner")]});
        expect(machine.getCallDepth()).to.equal(2);

        const result = machine.run({untilCallDepth: 1});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        expect(result.instructions).to.equal(3);
        expect(machine.z80.regs.pc).to.equal(at("outer") + 3);
        expect(machine.getCallDepth()).to.equal(1);
    });

    it("reports the depth reached by the last instruction a budget allows", () => {
        const {machine, at} = load(NESTED);
        machine.run({breakpoints: [at("last")]});
        expect(machine.getCallDepth()).to.equal(1);

        const result = machine.run({untilCallDepth: 0, maxInstructions: 1});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        expect(result.instructions).to.equal(1);
        expect(machine.z80.regs.pc).to.equal(at("after"));
    });

    it("reports the depth ahead of a t-state budget too", () => {
        const {machine, at} = load(NESTED);
        machine.run({breakpoints: [at("last")]});

        // ret is 10 t-states, so the budget is spent by it.
        const result = machine.run({untilCallDepth: 0, maxTStates: 10});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        expect(result.tStates).to.equal(10);
    });

    it("finishes at the right return when resumed over several runs", () => {
        // What the old stepOver could not do: each run stops inside the
        // routine, often right after one of inner's returns, and the next
        // run still goes on to outer's.
        const {machine, at} = load(NESTED);
        machine.step();
        machine.step();

        let runs = 0;
        let instructions = 0;
        let result;
        do {
            result = machine.run({untilCallDepth: 0, maxInstructions: 2});
            runs += 1;
            instructions += result.instructions;
        } while (result.reason === StopReason.INSTRUCTIONS_EXHAUSTED);

        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        expect(runs).to.equal(5);
        expect(instructions).to.equal(10);
        expect(machine.z80.regs.pc).to.equal(at("after"));
    });

    it("reports the step, not the breakpoint, on the instruction it returns to", () => {
        const {machine, at} = load(NESTED);
        machine.step();
        machine.step();

        const result = machine.run({untilCallDepth: 0, breakpoints: [at("after")]});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
        expect(machine.z80.regs.pc).to.equal(at("after"));
    });

    it("stops at a breakpoint inside the routine, and goes on from there", () => {
        const {machine, at} = load(NESTED);
        machine.step();
        machine.step();
        const breakpoints = [at("inner")];

        const first = machine.run({untilCallDepth: 0, breakpoints});
        expect(first.reason).to.equal(StopReason.BREAKPOINT);
        expect(machine.z80.regs.pc).to.equal(at("inner"));
        expect(machine.getCallDepth()).to.equal(2);

        expect(machine.run({untilCallDepth: 0, breakpoints}).reason).to.equal(StopReason.BREAKPOINT);
        expect(machine.run({untilCallDepth: 0, breakpoints}).reason).to.equal(StopReason.CALL_DEPTH);
        expect(machine.z80.regs.pc).to.equal(at("after"));
    });

    it("stops at an input wait inside the routine, and goes on once it is answered", () => {
        let input: number | undefined = undefined;
        const {machine, at} = load(`
        .org 0x100
        call read
after:  halt
read:   nop
        in a, (0x10)
        ret
`, {onPortRead: () => input});
        machine.step();

        const first = machine.run({untilCallDepth: 0});
        expect(first.reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(first.instructions).to.equal(1);
        expect(machine.getCallDepth()).to.equal(1);

        input = 0x42;
        const second = machine.run({untilCallDepth: 0});
        expect(second.reason).to.equal(StopReason.CALL_DEPTH);
        expect(second.instructions).to.equal(2);
        expect(machine.z80.regs.pc).to.equal(at("after"));
        expect(machine.z80.regs.a).to.equal(0x42);
    });

    it("stops when a handler pauses the run inside the routine", () => {
        let machine: Z80Machine;
        ({machine} = load(`
        .org 0x100
        call send
        halt
send:   out (0x10), a
        ret
`, {onPortWrite: () => machine.pause()}));
        machine.step();

        expect(machine.run({untilCallDepth: 0}).reason).to.equal(StopReason.PAUSED);
        expect(machine.run({untilCallDepth: 0}).reason).to.equal(StopReason.CALL_DEPTH);
    });

    it("lets the end of the program win", () => {
        // The routine's return is also the top-level return: the call was
        // made with SP two above the stack top, so the frame sits right at it.
        const {machine} = load(`
        .org 0x100
        inc sp
        inc sp
        call done
        halt
done:   ret
`, {initialSp: 0x8000, exitOnReturn: true});
        machine.step();
        machine.step();
        machine.step();
        expect(machine.getCallDepth()).to.equal(1);

        const result = machine.run({untilCallDepth: 0});
        expect(result.reason).to.equal(StopReason.RETURNED);
        expect(machine.getCallDepth()).to.equal(0);
        expect(machine.isTerminated()).to.be.true;
    });

    it("costs nothing and does nothing when left out", () => {
        const {machine} = load(NESTED);
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.b).to.equal(4);
    });
});

describe("skipBreakpointAtPc", () => {
    const PROGRAM = `
        .org 0x100
start:  nop
        nop
        halt
`;

    it("passes over a breakpoint at the PC by default", () => {
        const {machine, at} = load(PROGRAM);

        const result = machine.run({breakpoints: [at("start")]});
        expect(result.reason).to.equal(StopReason.HALTED);
        expect(result.instructions).to.equal(3);

        const again = load(PROGRAM).machine;
        expect(again.run({breakpoints: [at("start")], skipBreakpointAtPc: true}).reason)
            .to.equal(StopReason.HALTED);
    });

    it("stops at a breakpoint at the PC, executing nothing, when false", () => {
        const {machine, at} = load(PROGRAM);

        const result = machine.run({breakpoints: [at("start")], skipBreakpointAtPc: false});
        expect(result).to.deep.equal({reason: StopReason.BREAKPOINT, tStates: 0, instructions: 0});
        expect(machine.stopReason).to.equal(StopReason.BREAKPOINT);
        expect(machine.z80.regs.pc).to.equal(at("start"));

        // Without a breakpoint at the PC it changes nothing.
        expect(machine.run({skipBreakpointAtPc: false}).reason).to.equal(StopReason.HALTED);
    });

    it("lets the depth win over a breakpoint at the PC", () => {
        const {machine, at} = load(PROGRAM);

        const result = machine.run({breakpoints: [at("start")], skipBreakpointAtPc: false, untilCallDepth: 0});
        expect(result.reason).to.equal(StopReason.CALL_DEPTH);
    });

    it("leaves the skip unspent by an input wait", () => {
        // A breakpoint on an `in` that has to wait: the run that waits
        // executes nothing, so the run after the answer is the one that has
        // to pass over the breakpoint, which is the caller's to ask for.
        let input: number | undefined = undefined;
        const {machine, at} = load(`
        .org 0x100
read:   in a, (0x10)
        nop
        halt
`, {onPortRead: () => input});
        const breakpoints = [at("read")];

        expect(machine.run({breakpoints, skipBreakpointAtPc: false}))
            .to.deep.equal({reason: StopReason.BREAKPOINT, tStates: 0, instructions: 0});

        const waiting = machine.run({breakpoints});
        expect(waiting.reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(waiting.instructions).to.equal(0);
        expect(machine.z80.regs.pc).to.equal(at("read"));

        input = 0x42;
        const resumed = machine.run({breakpoints});
        expect(resumed.reason).to.equal(StopReason.HALTED);
        expect(resumed.instructions).to.equal(3);
        expect(machine.z80.regs.a).to.equal(0x42);
    });
});

describe("blockInstructionWillRepeat", () => {
    /**
     * A machine at an instruction made of these bytes, at 0x0100, followed
     * by a halt.
     */
    function at(...bytes: number[]): Z80Machine {
        const machine = new Z80Machine();
        machine.loadBinary([...bytes, 0x76], 0x0100);
        return machine;
    }

    it("is true until the last repetition of an LDIR", () => {
        const machine = at(0xED, 0xB0);         // ldir
        machine.z80.regs.hl = 0x2000;
        machine.z80.regs.de = 0x3000;
        machine.z80.regs.bc = 3;

        expect(machine.blockInstructionWillRepeat()).to.be.true;
        machine.step();
        expect(machine.z80.regs.pc).to.equal(0x0100);
        expect(machine.blockInstructionWillRepeat()).to.be.true;
        machine.step();
        expect(machine.z80.regs.pc).to.equal(0x0100);
        expect(machine.blockInstructionWillRepeat()).to.be.false;
        machine.step();
        expect(machine.z80.regs.pc).to.equal(0x0102);
        expect(machine.blockInstructionWillRepeat()).to.be.false;
    });

    it("executes nothing", () => {
        const machine = at(0xED, 0xB0);
        machine.z80.regs.bc = 3;
        const before = machine.z80.save();

        machine.blockInstructionWillRepeat();
        expect(machine.z80.save()).to.deep.equal(before);
        expect(machine.tStateCount).to.equal(0);
    });

    it("counts BC down from 0 as 65,536 repetitions", () => {
        const machine = at(0xED, 0xB8);         // lddr
        machine.z80.regs.bc = 0;
        expect(machine.blockInstructionWillRepeat()).to.be.true;
        machine.z80.regs.bc = 1;
        expect(machine.blockInstructionWillRepeat()).to.be.false;
    });

    it("stops a compare that finds its byte", () => {
        for (const opcode of [0xB1, 0xB9]) {        // cpir, cpdr
            const machine = at(0xED, opcode);
            machine.memory[0x2000] = 0x55;
            machine.z80.regs.hl = 0x2000;
            machine.z80.regs.bc = 5;

            machine.z80.regs.a = 0x55;
            expect(machine.blockInstructionWillRepeat()).to.be.false;
            machine.z80.regs.a = 0x56;
            expect(machine.blockInstructionWillRepeat()).to.be.true;
            machine.z80.regs.bc = 1;
            expect(machine.blockInstructionWillRepeat()).to.be.false;
        }
    });

    it("counts B for the input and output blocks", () => {
        for (const opcode of [0xB2, 0xB3, 0xBA, 0xBB]) {    // inir, otir, indr, otdr
            const machine = at(0xED, opcode);
            machine.z80.regs.b = 2;
            expect(machine.blockInstructionWillRepeat()).to.be.true;
            machine.z80.regs.b = 0;
            expect(machine.blockInstructionWillRepeat()).to.be.true;
            machine.z80.regs.b = 1;
            expect(machine.blockInstructionWillRepeat()).to.be.false;
        }
    });

    it("agrees with the CPU for every one of the eight", () => {
        for (const opcode of [0xB0, 0xB1, 0xB2, 0xB3, 0xB8, 0xB9, 0xBA, 0xBB]) {
            const machine = at(0xED, opcode);
            machine.z80.regs.bc = 0x0203;
            machine.z80.regs.hl = 0x2000;
            machine.z80.regs.de = 0x4000;
            machine.z80.regs.a = 0x77;
            machine.memory[0x2002] = 0x77;
            machine.memory[0x1FFE] = 0x77;

            for (let i = 0; i < 600 && machine.z80.regs.pc === 0x0100; i++) {
                const predicted = machine.blockInstructionWillRepeat();
                machine.step();
                expect(machine.z80.regs.pc === 0x0100, "opcode ED " + opcode.toString(16) + ", repetition " + i)
                    .to.equal(predicted);
            }
            expect(machine.z80.regs.pc).to.equal(0x0102);
        }
    });

    it("looks past a DD or FD prefix", () => {
        const machine = at(0xDD, 0xED, 0xB0);
        machine.z80.regs.bc = 2;
        expect(machine.blockInstructionWillRepeat()).to.be.true;
    });

    it("is false for anything else", () => {
        expect(at(0x00).blockInstructionWillRepeat()).to.be.false;          // nop
        expect(at(0xED, 0xA0).blockInstructionWillRepeat()).to.be.false;    // ldi
        expect(at(0xED, 0x4D).blockInstructionWillRepeat()).to.be.false;    // reti
        expect(at(0x10, 0xFE).blockInstructionWillRepeat()).to.be.false;    // djnz $
    });
});

describe("ledger counts", () => {
    const PROGRAM = `
        .org 0x100
        nop
        nop
        in a, (0x10)
        halt
`;

    it("counts the records undo can take back", () => {
        const {machine} = load(PROGRAM, {historySize: 3});
        expect(machine.getUndoDepth()).to.equal(0);

        machine.step();
        machine.step();
        expect(machine.getUndoDepth()).to.equal(2);

        machine.beginPoke();
        machine.setRegisterValue("b", 1);
        machine.endPoke();
        expect(machine.getUndoDepth()).to.equal(3);

        // The history keeps three.
        machine.step();
        expect(machine.getUndoDepth()).to.equal(3);

        machine.undo();
        expect(machine.getUndoDepth()).to.equal(2);
    });

    it("is 0 without a history", () => {
        const {machine} = load(PROGRAM);
        machine.step();
        expect(machine.getUndoDepth()).to.equal(0);
    });

    it("counts every instruction executed, and only goes up", () => {
        let input: number | undefined = undefined;
        const {machine} = load(PROGRAM, {historySize: 10, onPortRead: () => input});
        expect(machine.getInstructionsExecuted()).to.equal(0);

        // The in waits, and is not counted until it executes.
        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.getInstructionsExecuted()).to.equal(2);

        // A poke is no instruction.
        machine.beginPoke();
        machine.setRegisterValue("b", 1);
        machine.endPoke();
        expect(machine.getInstructionsExecuted()).to.equal(2);

        // An undo takes nothing back from the count.
        machine.undo();
        machine.undo();
        expect(machine.getInstructionsExecuted()).to.equal(2);

        input = 0;
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.getInstructionsExecuted()).to.equal(5);

        machine.reset();
        expect(machine.getInstructionsExecuted()).to.equal(5);
    });

    it("counts without a history too", () => {
        const {machine} = load(PROGRAM);
        machine.step();
        machine.step();
        expect(machine.getInstructionsExecuted()).to.equal(2);
    });
});
