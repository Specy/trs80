import {expect} from "chai";
import {CallStackFrame, disassembleInstructionAt, reconstructCallStack} from "./CallStack.js";
import type {Z80Machine} from "./Z80Machine.js";

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
 * Stand-in for a {@link Z80Machine}, with just the fields that the call stack
 * code looks at. The real machine is tested elsewhere; here we want to be able
 * to hand-build stacks, including impossible ones.
 */
class FakeMachine {
    public readonly memory = new Uint8Array(64*1024);
    public readonly z80 = {
        regs: {
            sp: 0,
        },
        pushInstructionAddress: new Uint16Array(64*1024),
    };
    public readonly stackTop: number;

    constructor(stackTop: number = 0xFFFF) {
        this.stackTop = stackTop;
        this.z80.regs.sp = stackTop;
    }

    // Number of debug reads, so that a test can watch how much work the walk does.
    public peekCount = 0;

    /**
     * Read a byte the way the real machine's debug reader does. This fake
     * has no memory hooks, so it's just RAM.
     */
    public peek(address: number): number {
        this.peekCount += 1;
        return this.memory[address & 0xFFFF];
    }

    /**
     * The object as the call stack code sees it.
     */
    public asMachine(): Z80Machine {
        return this as unknown as Z80Machine;
    }

    /**
     * Write bytes into memory.
     */
    public poke(address: number, ...bytes: number[]): void {
        this.memory.set(bytes, address);
    }

    /**
     * Do what the CPU's pushWord() does: push the word and record the address
     * of the instruction that pushed it, at the address of the low byte.
     */
    public push(value: number, instructionAddress: number): void {
        const sp = (this.z80.regs.sp - 2) & 0xFFFF;
        this.z80.regs.sp = sp;
        this.memory[sp] = value & 0xFF;
        this.memory[(sp + 1) & 0xFFFF] = (value >> 8) & 0xFF;
        this.z80.pushInstructionAddress[sp] = instructionAddress;
    }

    /**
     * Simulate executing a CALL at the given address: write the instruction
     * and push its return address. The opcode defaults to the unconditional
     * CALL, but any of the conditional ones can be passed instead.
     */
    public call(address: number, targetAddress: number, opcode: number = 0xCD): void {
        this.poke(address, opcode, targetAddress & 0xFF, (targetAddress >> 8) & 0xFF);
        this.push(address + 3, address);
    }

    /**
     * Simulate executing an RST at the given address.
     */
    public rst(address: number, targetAddress: number): void {
        this.poke(address, 0xC7 | (targetAddress & 0x38));
        this.push(address + 1, address);
    }
}

// Convenient one-line summary of a frame, for comparing.
function frameToText(frame: CallStackFrame): string {
    return [frame.callSiteAddress, frame.targetAddress, frame.returnAddress, frame.stackAddress]
        .map(n => n.toString(16))
        .join(" ");
}

function framesToText(frames: CallStackFrame[]): string[] {
    return frames.map(frameToText);
}

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

describe("reconstructCallStack", () => {
    it("empty stack", () => {
        const machine = new FakeMachine();
        expect(reconstructCallStack(machine.asMachine())).to.deep.equal([]);
    });

    it("single call frame", () => {
        const machine = new FakeMachine();
        machine.call(0x8000, 0x9000);

        const frames = reconstructCallStack(machine.asMachine());
        expect(frames.length).to.equal(1);
        expect(frames[0].callSiteAddress).to.equal(0x8000);
        expect(frames[0].targetAddress).to.equal(0x9000);
        expect(frames[0].returnAddress).to.equal(0x8003);
        expect(frames[0].stackAddress).to.equal(0xFFFD);
    });

    it("conditional call frame", () => {
        const machine = new FakeMachine();
        // call z,0x9000
        machine.call(0x8000, 0x9000, 0xCC);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 9000 8003 fffd"]);
    });

    it("nested calls, innermost first", () => {
        const machine = new FakeMachine();
        machine.call(0x8000, 0x9000);
        machine.call(0x9020, 0xA000);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal([
            "9020 a000 9023 fffb",
            "8000 9000 8003 fffd",
        ]);
    });

    it("rst frame", () => {
        const machine = new FakeMachine();
        machine.rst(0x8000, 0x28);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 28 8001 fffd"]);
    });

    it("mixed call and rst frames", () => {
        const machine = new FakeMachine();
        machine.call(0x8000, 0x9000);
        machine.rst(0x9010, 0x10);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal([
            "9010 10 9011 fffb",
            "8000 9000 8003 fffd",
        ]);
    });

    it("skips push noise between frames", () => {
        const machine = new FakeMachine();
        machine.call(0x8000, 0x9000);
        // "push hl" at 0x9005, pushing something that looks like an address.
        machine.poke(0x9005, 0xE5);
        machine.push(0x1234, 0x9005);
        machine.call(0x9008, 0xA000);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal([
            "9008 a000 900b fff9",
            "8000 9000 8003 fffd",
        ]);
    });

    it("skips several pushes in a row", () => {
        const machine = new FakeMachine();
        machine.call(0x8000, 0x9000);
        machine.poke(0x9005, 0xE5); // push hl
        machine.poke(0x9006, 0xD5); // push de
        machine.push(0x8003, 0x9005); // Same value as a return address, but a push.
        machine.push(0xFFFF, 0x9006);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 9000 8003 fffd"]);
    });

    it("data with no provenance", () => {
        const machine = new FakeMachine();
        // Program lowered SP itself and wrote data there, so nothing recorded
        // a pushing instruction.
        machine.z80.regs.sp = 0xFFF0;
        for (let address = 0xFFF0; address < 0xFFFF; address++) {
            machine.memory[address] = address & 0xFF;
        }

        expect(reconstructCallStack(machine.asMachine())).to.deep.equal([]);
    });

    it("interrupt push is not a frame", () => {
        const machine = new FakeMachine();
        // An interrupt right after the call at 0x8000 pushes the PC, which by
        // then is the target of the call, and records the call as the pusher.
        machine.call(0x8000, 0x9000);
        machine.push(0x9000, 0x8000);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 9000 8003 fffd"]);
    });

    it("stops at the stack top", () => {
        const machine = new FakeMachine(0xF000);
        machine.call(0x8000, 0x9000);
        // A stale frame from an earlier program, above the stack top.
        machine.poke(0x8100, 0xCD, 0x00, 0xA0);
        machine.poke(0xF010, 0x03, 0x81);
        machine.z80.pushInstructionAddress[0xF010] = 0x8100;

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 9000 8003 effe"]);
    });

    it("frame at the very top of the stack", () => {
        // Stack top is the end of memory, so the frame's high byte is the
        // last byte of memory.
        const machine = new FakeMachine(0x10000);
        machine.call(0x8000, 0x9000);

        const frames = reconstructCallStack(machine.asMachine());
        expect(framesToText(frames)).to.deep.equal(["8000 9000 8003 fffe"]);
    });

    it("mangled stack produces no frames and doesn't throw", () => {
        const machine = new FakeMachine();
        machine.z80.regs.sp = 0xFF00;

        // Deterministic garbage everywhere.
        let seed = 12345;
        const random = (): number => {
            seed = (seed*1103515245 + 12345) & 0x7FFFFFFF;
            return seed >> 8;
        };
        for (let address = 0; address < 64*1024; address++) {
            machine.memory[address] = random() & 0xFF;
            machine.z80.pushInstructionAddress[address] = random() & 0xFFFF;
        }

        const frames = reconstructCallStack(machine.asMachine());
        expect(frames).to.deep.equal([]);
    });

    it("SP above the stack top", () => {
        // Program popped too much. Nothing to report, and no infinite loop.
        const machine = new FakeMachine(0x8000);
        machine.z80.regs.sp = 0x9000;

        expect(reconstructCallStack(machine.asMachine())).to.deep.equal([]);
    });

    it("disassembles each call site once, however deep the stack", () => {
        // Slots that were never pushed report provenance 0. An erased-ROM or
        // unmapped-bus fill puts a call opcode there, which defeats the
        // one-byte rejection for every one of the 32 kB of slots below the
        // stack top, so the walk must not disassemble that address each time.
        const machine = new FakeMachine();
        machine.poke(0x0000, 0xCD, 0x00, 0xA0);     // call 0xA000, at address 0
        machine.call(0x8100, 0x9000);
        // The program moved its own stack down, far from the stack top.
        machine.z80.regs.sp = 0x8000;

        machine.peekCount = 0;
        const frames = reconstructCallStack(machine.asMachine());

        // The bogus provenance never satisfies the return-address test, so the
        // one real frame is all we report.
        expect(framesToText(frames)).to.deep.equal(["8100 9000 8103 fffd"]);

        // Three reads per slot (the opcode plus the two stack bytes) is the
        // floor; disassembling address 0 each time would add three more.
        const slots = 0xFFFF - 0x8000;
        expect(machine.peekCount).to.be.lessThan(slots*4);
    });

    it("deep stack", () => {
        const machine = new FakeMachine();
        const depth = 100;
        for (let i = 0; i < depth; i++) {
            machine.call(0x8000 + i*4, 0x9000 + i*4);
        }

        const frames = reconstructCallStack(machine.asMachine());
        expect(frames.length).to.equal(depth);
        // Innermost first.
        expect(frames[0].callSiteAddress).to.equal(0x8000 + (depth - 1)*4);
        expect(frames[depth - 1].callSiteAddress).to.equal(0x8000);
    });
});

console.log(successCount + " successful out of " + testCount, successCount === testCount ? "✅" : "❌");
if (successCount !== testCount) {
    process.exitCode = 1;
}
