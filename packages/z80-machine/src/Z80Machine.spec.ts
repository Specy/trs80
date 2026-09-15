import {expect} from "chai";
import {assemble} from "./Assemble.js";
import {Z80Machine} from "./Z80Machine.js";
import {
    isPokeRecord,
    POKE_RECORD_ADDRESS,
    PortWrite,
    StopReason,
    Z80MachineConfig,
    Z80MachineState,
} from "./Z80MachineTypes.js";

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
 * Make a machine with the program loaded at the given address (0 by default).
 */
function makeMachine(program: number[], config?: Z80MachineConfig, org: number = 0x0000): Z80Machine {
    const machine = new Z80Machine(config);
    machine.loadBinary(program, org);
    return machine;
}

describe("basic execution", () => {
    it("runs to halt with interrupts disabled", () => {
        const portWrites: PortWrite[] = [];
        const machine = makeMachine([
            0x3E, 0x42,       // 0x0000  ld a,0x42
            0xD3, 0x10,       // 0x0002  out (0x10),a
            0x76,             // 0x0004  halt
        ], {
            onPortWrite: (port, value) => portWrites.push({port, value}),
        });

        const result = machine.run();

        expect(result.reason).to.equal(StopReason.HALTED);
        expect(result.instructions).to.equal(3);
        expect(result.tStates).to.equal(22);
        expect(machine.tStateCount).to.equal(22);
        expect(machine.stopReason).to.equal(StopReason.HALTED);
        expect(machine.isTerminated()).to.be.true;
        expect(machine.z80.regs.a).to.equal(0x42);
        // The upper byte of the port address is A, by Z80 convention.
        expect(portWrites).to.deep.equal([{port: 0x4210, value: 0x42}]);
    });

    it("initializes and resets the stack pointer", () => {
        const machine = makeMachine([
            0x00,             // 0x0000  nop
            0x76,             // 0x0001  halt
        ], {initialSp: 0x8000});

        expect(machine.stackTop).to.equal(0x8000);
        expect(machine.z80.regs.sp).to.equal(0x8000);

        machine.run();
        expect(machine.tStateCount).to.equal(8);

        machine.reset();
        expect(machine.z80.regs.pc).to.equal(0x0000);
        expect(machine.z80.regs.sp).to.equal(0x8000);
        expect(machine.tStateCount).to.equal(0);
        expect(machine.stopReason).to.be.undefined;
        expect(machine.isTerminated()).to.be.false;
        // Memory is left alone.
        expect(machine.memory[0x0001]).to.equal(0x76);
    });

    it("steps a single instruction", () => {
        const machine = makeMachine([
            0x3E, 0x12,       // 0x0000  ld a,0x12
            0x76,             // 0x0002  halt
        ]);

        expect(machine.step()).to.be.undefined;
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.z80.regs.a).to.equal(0x12);

        expect(machine.step()).to.equal(StopReason.HALTED);
    });

    it("does nothing when stepping a terminated machine", () => {
        const machine = makeMachine([
            0x76,             // 0x0000  halt
        ]);

        expect(machine.step()).to.equal(StopReason.HALTED);
        const tStateCount = machine.tStateCount;

        expect(machine.step()).to.equal(StopReason.HALTED);
        expect(machine.tStateCount).to.equal(tStateCount);
        expect(machine.z80.regs.pc).to.equal(0x0000);

        const result = machine.run();
        expect(result.reason).to.equal(StopReason.HALTED);
        expect(result.instructions).to.equal(0);
        expect(result.tStates).to.equal(0);
        expect(machine.tStateCount).to.equal(tStateCount);
    });

    it("takes a supplied 64 kB memory buffer, and rejects any other size", () => {
        const memory = new Uint8Array(64*1024);
        memory[0x0000] = 0x76;      // halt
        const machine = new Z80Machine({memory});

        expect(machine.memory).to.equal(memory);
        expect(machine.run().reason).to.equal(StopReason.HALTED);

        expect(() => new Z80Machine({memory: new Uint8Array(1024)})).to.throw(/64/);
        expect(() => new Z80Machine({memory: new Uint8Array(0)})).to.throw(/must be exactly/);
        expect(() => new Z80Machine({memory: new Uint8Array(64*1024 + 1)})).to.throw(/must be exactly/);
    });

    it("loads a binary at an org with a separate entry point", () => {
        const machine = new Z80Machine();
        machine.loadBinary([
            0x3E, 0x01,       // 0x8000  ld a,1
            0x3C,             // 0x8002  inc a
            0x76,             // 0x8003  halt
        ], 0x8000, 0x8002);

        expect(machine.z80.regs.pc).to.equal(0x8002);
        expect(machine.memory[0x8000]).to.equal(0x3E);

        machine.run();
        expect(machine.z80.regs.a).to.equal(0x01);
    });
});

describe("interrupts", () => {
    it("waits for an interrupt after halting with interrupts enabled", () => {
        const machine = makeMachine([
            0xED, 0x56,       // 0x0000  im 1
            0xFB,             // 0x0002  ei
            0x76,             // 0x0003  halt
        ]);
        machine.loadBinary([
            0x3C,             // 0x0038  inc a
            0x76,             // 0x0039  halt
        ], 0x0038, 0x0000);

        const result = machine.run();
        expect(result.reason).to.equal(StopReason.WAITING_FOR_INTERRUPT);
        expect(machine.stopReason).to.equal(StopReason.WAITING_FOR_INTERRUPT);
        expect(machine.isTerminated()).to.be.false;
        expect(machine.z80.regs.halted).to.equal(1);

        machine.raiseInterrupt();
        expect(machine.stopReason).to.be.undefined;
        expect(machine.z80.regs.halted).to.equal(0);
        // IM 1 jumps to 0x38, with the address after the halt pushed.
        expect(machine.z80.regs.pc).to.equal(0x0038);
        expect(machine.z80.regs.sp).to.equal(0xFFFD);

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.a).to.equal(1);
        expect(machine.isTerminated()).to.be.true;
    });

    it("ignores a maskable interrupt when interrupts are disabled", () => {
        const machine = makeMachine([
            0x76,             // 0x0000  halt
        ]);

        expect(machine.run().reason).to.equal(StopReason.HALTED);

        machine.raiseInterrupt();
        expect(machine.stopReason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.halted).to.equal(1);
        expect(machine.z80.regs.pc).to.equal(0x0000);
    });

    it("records and undoes the interrupt's stack push", () => {
        const machine = new Z80Machine({initialSp: 0x2010, historySize: 100});
        machine.loadBinary([
            0xED, 0x56,       // 0x0100  im 1
            0xFB,             // 0x0102  ei
            0x00,             // 0x0103  nop
        ], 0x0100);
        machine.loadBinary([
            0x3C,             // 0x0038  inc a
            0x76,             // 0x0039  halt
        ], 0x0038, 0x0100);
        // Data right below the stack, which the interrupt's push lands on.
        for (let address = 0x2000; address < 0x2010; address++) {
            machine.memory[address] = 0xD0 | (address & 0x0F);
        }

        machine.run({maxInstructions: 3});
        expect(machine.z80.regs.pc).to.equal(0x0104);
        const before = Array.from(machine.memory.subarray(0x2000, 0x2010));
        const historyLength = machine.getHistory().length;

        machine.raiseInterrupt();
        expect(machine.z80.regs.pc).to.equal(0x0038);
        expect(machine.z80.regs.sp).to.equal(0x200E);
        expect(machine.memory[0x200E]).to.equal(0x04);
        expect(machine.memory[0x200F]).to.equal(0x01);

        // The interrupt is in the history, with the bytes it pushed.
        const history = machine.getHistory();
        expect(history.length).to.equal(historyLength + 1);
        const record = history[history.length - 1];
        expect(record.interrupt).to.equal("maskable");
        expect(record.address).to.equal(0x0104);
        expect(record.memoryWrites.map(write => write.address).sort())
            .to.deep.equal([0x200E, 0x200F]);

        // And undoing it leaves no trace, in registers or in RAM.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0104);
        expect(machine.z80.regs.sp).to.equal(0x2010);
        expect(Array.from(machine.memory.subarray(0x2000, 0x2010))).to.deep.equal(before);
    });

    it("records and undoes a non-maskable interrupt", () => {
        const machine = new Z80Machine({initialSp: 0x2010, historySize: 100});
        machine.loadBinary([0x00, 0x00], 0x0000);
        machine.memory[0x200E] = 0xDE;
        machine.memory[0x200F] = 0xDF;

        machine.run({maxInstructions: 1});
        machine.raiseNmi();
        expect(machine.z80.regs.pc).to.equal(0x0066);

        const history = machine.getHistory();
        expect(history[history.length - 1].interrupt).to.equal("nmi");

        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0001);
        expect(machine.z80.regs.sp).to.equal(0x2010);
        expect(machine.memory[0x200E]).to.equal(0xDE);
        expect(machine.memory[0x200F]).to.equal(0xDF);
    });

    it("records nothing for an interrupt the CPU ignores", () => {
        const machine = makeMachine([0x00, 0x76], {historySize: 10});

        machine.run({maxInstructions: 1});
        expect(machine.getHistory().length).to.equal(1);

        // Interrupts are disabled, so nothing happens and nothing is recorded.
        machine.raiseInterrupt();
        expect(machine.getHistory().length).to.equal(1);
        expect(machine.z80.regs.pc).to.equal(0x0001);
        expect(machine.z80.regs.sp).to.equal(0xFFFF);
    });

    it("an interrupt after an untaken conditional call is not a frame", () => {
        // The core records the interrupted instruction as having pushed the
        // return address. After a conditional call that wasn't taken, the
        // pushed PC is exactly what a taken call would have pushed.
        const machine = makeMachine([
            0xED, 0x56,             // 0x0000  im 1
            0xFB,                   // 0x0002  ei
            0xAF,                   // 0x0003  xor a        (sets Z)
            0xC4, 0x34, 0x12,       // 0x0004  call nz,0x1234  (not taken)
            0x76,                   // 0x0007  halt
        ]);

        machine.run({maxInstructions: 4});
        expect(machine.z80.regs.pc).to.equal(0x0007);
        expect(machine.getCallStack()).to.deep.equal([]);

        machine.raiseInterrupt();
        expect(machine.z80.regs.pc).to.equal(0x0038);
        expect(machine.getCallStack()).to.deep.equal([]);
    });

    it("an interrupt inside a routine keeps the routine's frame", () => {
        const machine = makeMachine([
            0xED, 0x56,             // 0x0000  im 1
            0xFB,                   // 0x0002  ei
            0xCD, 0x20, 0x00,       // 0x0003  call 0x0020
            0x76,                   // 0x0006  halt
        ]);
        machine.loadBinary([
            0x00,                   // 0x0020  nop
            0xC9,                   // 0x0021  ret
        ], 0x0020, 0x0000);

        machine.run({maxInstructions: 3});
        expect(machine.z80.regs.pc).to.equal(0x0020);

        machine.raiseInterrupt();
        expect(machine.z80.regs.pc).to.equal(0x0038);

        const frames = machine.getCallStack();
        expect(frames.length).to.equal(1);
        expect(frames[0].callSiteAddress).to.equal(0x0003);
        expect(frames[0].targetAddress).to.equal(0x0020);
    });

    it("wakes a halted machine with a non-maskable interrupt", () => {
        const machine = makeMachine([
            0x76,             // 0x0000  halt
        ]);
        machine.loadBinary([
            0x3C,             // 0x0066  inc a
            0x76,             // 0x0067  halt
        ], 0x0066, 0x0000);

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.isTerminated()).to.be.true;

        machine.raiseNmi();
        expect(machine.stopReason).to.be.undefined;
        expect(machine.isTerminated()).to.be.false;
        expect(machine.z80.regs.pc).to.equal(0x0066);

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.a).to.equal(1);
    });
});

describe("input and output", () => {
    it("reads 0xFF when no port handler is configured", () => {
        const machine = makeMachine([
            0xDB, 0x10,       // 0x0000  in a,(0x10)
            0x76,             // 0x0002  halt
        ]);

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.a).to.equal(0xFF);
    });

    it("waits for input and resumes when it arrives", () => {
        const ports: number[] = [];
        let input: number | undefined = undefined;
        const machine = makeMachine([
            0x3E, 0x00,       // 0x0000  ld a,0
            0xDB, 0x10,       // 0x0002  in a,(0x10)
            0x47,             // 0x0004  ld b,a
            0x76,             // 0x0005  halt
        ], {
            onPortRead: port => {
                ports.push(port);
                return input;
            },
        });
        machine.z80.regs.bc = 0x1234;

        const result = machine.run();
        expect(result.reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.stopReason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.pendingInputPort).to.equal(0x0010);
        expect(machine.isTerminated()).to.be.false;
        // Only the "ld a,0" ran, the "in" was rolled back.
        expect(result.instructions).to.equal(1);
        expect(result.tStates).to.equal(7);
        expect(machine.tStateCount).to.equal(7);
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.z80.regs.a).to.equal(0x00);
        expect(machine.z80.regs.bc).to.equal(0x1234);
        expect(ports).to.deep.equal([0x0010]);

        input = 0x5A;
        const result2 = machine.run();
        expect(result2.reason).to.equal(StopReason.HALTED);
        expect(result2.instructions).to.equal(3);
        expect(machine.pendingInputPort).to.be.undefined;
        expect(machine.z80.regs.a).to.equal(0x5A);
        expect(machine.z80.regs.b).to.equal(0x5A);
        expect(ports).to.deep.equal([0x0010, 0x0010]);
    });

    it("retries the input when stepping while waiting", () => {
        let input: number | undefined = undefined;
        const machine = makeMachine([
            0xDB, 0x10,       // 0x0000  in a,(0x10)
            0x76,             // 0x0002  halt
        ], {
            onPortRead: () => input,
        });

        expect(machine.step()).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.z80.regs.pc).to.equal(0x0000);

        input = 0x7E;
        expect(machine.step()).to.be.undefined;
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.z80.regs.a).to.equal(0x7E);
        expect(machine.stopReason).to.be.undefined;
    });

    it("rolls back a block input instruction", () => {
        let input: number | undefined = 0x11;
        const machine = makeMachine([
            0x01, 0x02, 0x02, // 0x0000  ld bc,0x0202  (2 bytes from port 2)
            0x21, 0x00, 0x40, // 0x0003  ld hl,0x4000
            0xED, 0xB2,       // 0x0006  inir
            0x76,             // 0x0008  halt
        ], {
            onPortRead: () => input,
        });

        // First iteration of the inir works, second one has no data.
        expect(machine.run({maxInstructions: 3}).reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(machine.memory[0x4000]).to.equal(0x11);
        expect(machine.z80.regs.b).to.equal(0x01);
        expect(machine.z80.regs.hl).to.equal(0x4001);
        // The instruction rewinds the PC to re-execute itself.
        expect(machine.z80.regs.pc).to.equal(0x0006);

        input = undefined;
        const tStateCount = machine.tStateCount;
        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.z80.regs.pc).to.equal(0x0006);
        expect(machine.z80.regs.b).to.equal(0x01);
        expect(machine.z80.regs.hl).to.equal(0x4001);
        expect(machine.memory[0x4001]).to.equal(0x00);
        expect(machine.tStateCount).to.equal(tStateCount);

        input = 0x22;
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.memory[0x4001]).to.equal(0x22);
        expect(machine.z80.regs.b).to.equal(0x00);
    });
});

describe("memory hooks", () => {
    it("protects RAM when the write handler handles the write", () => {
        const writes: number[][] = [];
        const machine = makeMachine([
            0x3E, 0x99,             // 0x0000  ld a,0x99
            0x32, 0x00, 0x20,       // 0x0002  ld (0x2000),a
            0x32, 0x00, 0x30,       // 0x0005  ld (0x3000),a
            0x76,                   // 0x0008  halt
        ], {
            onMemoryWrite: (address, value) => {
                writes.push([address, value]);
                // Everything at 0x3000 and above is a device.
                return address >= 0x3000;
            },
        });

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(writes).to.deep.equal([[0x2000, 0x99], [0x3000, 0x99]]);
        expect(machine.memory[0x2000]).to.equal(0x99);
        expect(machine.memory[0x3000]).to.equal(0x00);
    });

    it("overrides memory reads", () => {
        const machine = makeMachine([
            0x3A, 0x00, 0x40,       // 0x0000  ld a,(0x4000)
            0x76,                   // 0x0003  halt
        ], {
            // Everything else falls through to RAM, including the fetches.
            onMemoryRead: address => address === 0x4000 ? 0x77 : undefined,
        });

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.a).to.equal(0x77);
        expect(machine.memory[0x4000]).to.equal(0x00);
    });

    it("debugs code that the read hook serves", () => {
        // A ROM overlay: the low page is served by the hook and never appears
        // in RAM, so the debugger has to look through the hook too.
        //
        // 0x0000  call 0x0010
        // 0x0003  halt
        // 0x0010  ld a,0x99
        // 0x0012  ret
        const rom = new Uint8Array(0x0100);
        rom.set([0xCD, 0x10, 0x00, 0x76], 0x0000);
        rom.set([0x3E, 0x99, 0xC9], 0x0010);
        const config: Z80MachineConfig = {
            onMemoryRead: address => address < rom.length ? rom[address] : undefined,
        };

        // The disassembler sees the instruction the CPU will fetch.
        expect(new Z80Machine(config).disassembleAt(0x0000).mnemonic).to.equal("call");

        // Stepping over the call runs the whole callee.
        const stepper = new Z80Machine(config);
        expect(stepper.stepOver().reason).to.equal(StopReason.STEP_COMPLETE);
        expect(stepper.z80.regs.pc).to.equal(0x0003);
        expect(stepper.z80.regs.a).to.equal(0x99);

        // The call stack finds the frame, and stepping out returns from it.
        const walker = new Z80Machine(config);
        expect(walker.step()).to.be.undefined;
        expect(walker.z80.regs.pc).to.equal(0x0010);
        const frames = walker.getCallStack();
        expect(frames.length).to.equal(1);
        expect(frames[0].callSiteAddress).to.equal(0x0000);
        expect(frames[0].targetAddress).to.equal(0x0010);
        expect(frames[0].returnAddress).to.equal(0x0003);
        expect(walker.stepOut().reason).to.equal(StopReason.STEP_COMPLETE);
        expect(walker.z80.regs.pc).to.equal(0x0003);
    });

    it("exits on a return served by the read hook", () => {
        // ld a,0x99 / ret, with the code only in the overlay.
        const rom = Uint8Array.from([0x3E, 0x99, 0xC9]);
        const machine = new Z80Machine({
            exitOnReturn: true,
            onMemoryRead: address => address < rom.length ? rom[address] : undefined,
        });

        const result = machine.run({maxInstructions: 20});
        expect(result.reason).to.equal(StopReason.RETURNED);
        expect(result.instructions).to.equal(2);
        expect(machine.z80.regs.a).to.equal(0x99);
        expect(machine.isTerminated()).to.be.true;
    });

    it("lets the debug reader be overridden", () => {
        // A read hook with side effects can be kept out of the debugger's way.
        const rom = Uint8Array.from([0xCD, 0x10, 0x00, 0x76]);
        const reads: number[] = [];
        const machine = new Z80Machine({
            onMemoryRead: address => {
                reads.push(address);
                return address < rom.length ? rom[address] : undefined;
            },
            onDebugRead: () => undefined,
        });

        // RAM is all zeros, so the debugger sees a nop, and no read hook ran.
        expect(machine.disassembleAt(0x0000).mnemonic).to.equal("nop");
        expect(reads).to.deep.equal([]);

        // The CPU still fetches through the read hook.
        expect(machine.step()).to.be.undefined;
        expect(machine.z80.regs.pc).to.equal(0x0010);
        expect(reads.length).to.be.greaterThan(0);
    });
});

describe("breakpoints and budgets", () => {
    it("stops before executing the instruction at a breakpoint", () => {
        const machine = makeMachine([
            0x00,             // 0x0000  nop
            0x00,             // 0x0001  nop
            0x00,             // 0x0002  nop
            0x76,             // 0x0003  halt
        ]);

        const result = machine.run({breakpoints: [0x0002]});
        expect(result.reason).to.equal(StopReason.BREAKPOINT);
        expect(result.instructions).to.equal(2);
        expect(result.tStates).to.equal(8);
        expect(machine.stopReason).to.equal(StopReason.BREAKPOINT);
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.isTerminated()).to.be.false;
    });

    it("makes progress when resuming from a breakpoint", () => {
        const machine = makeMachine([
            0x00,             // 0x0000  nop
            0x00,             // 0x0001  nop
            0x00,             // 0x0002  nop
            0x76,             // 0x0003  halt
        ]);
        const breakpoints = [0x0000, 0x0002];

        // We start on a breakpoint, so at least one instruction must run.
        const result = machine.run({breakpoints});
        expect(result.reason).to.equal(StopReason.BREAKPOINT);
        expect(result.instructions).to.equal(2);
        expect(machine.z80.regs.pc).to.equal(0x0002);

        const result2 = machine.run({breakpoints});
        expect(result2.reason).to.equal(StopReason.HALTED);
        expect(result2.instructions).to.equal(2);
        expect(machine.z80.regs.pc).to.equal(0x0003);
    });

    it("stops when the instruction budget runs out", () => {
        const machine = makeMachine([
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x76,
        ]);

        const result = machine.run({maxInstructions: 3});
        expect(result.reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(result.instructions).to.equal(3);
        expect(result.tStates).to.equal(12);
        expect(machine.z80.regs.pc).to.equal(0x0003);
        expect(machine.isTerminated()).to.be.false;

        // Resuming picks up where we left off.
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.pc).to.equal(0x0006);
    });

    it("stops when the t-state budget runs out", () => {
        const machine = makeMachine([
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x76,
        ]);

        const result = machine.run({maxTStates: 10});
        expect(result.reason).to.equal(StopReason.T_STATES_EXHAUSTED);
        expect(result.instructions).to.equal(3);
        expect(result.tStates).to.equal(12);
        expect(machine.tStateCount).to.equal(12);
    });

    it("executes nothing with a zero budget", () => {
        const machine = makeMachine([0x00, 0x76]);

        const result = machine.run({maxInstructions: 0});
        expect(result.reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(result.instructions).to.equal(0);
        expect(machine.z80.regs.pc).to.equal(0x0000);
    });
});

describe("exit on return", () => {
    // 0x0000  call 0x0006
    // 0x0003  inc a
    // 0x0004  ret            ; top-level return
    // 0x0005  nop
    // 0x0006  ld a,5
    // 0x0008  ret            ; return to 0x0003
    const program = [
        0xCD, 0x06, 0x00,
        0x3C,
        0xC9,
        0x00,
        0x3E, 0x05,
        0xC9,
    ];

    it("stops when the top-level routine returns", () => {
        const machine = makeMachine(program, {exitOnReturn: true});

        const result = machine.run();
        expect(result.reason).to.equal(StopReason.RETURNED);
        // call, ld, ret, inc, ret.
        expect(result.instructions).to.equal(5);
        expect(machine.z80.regs.a).to.equal(6);
        expect(machine.z80.regs.sp).to.equal(0x0001);
        expect(machine.isTerminated()).to.be.true;

        // A terminated machine doesn't run any more.
        const result2 = machine.run();
        expect(result2.reason).to.equal(StopReason.RETURNED);
        expect(result2.instructions).to.equal(0);
        expect(result2.tStates).to.equal(0);
    });

    it("keeps going through the top-level return when disabled", () => {
        const machine = makeMachine(program);

        const result = machine.run({maxInstructions: 20});
        expect(result.reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(machine.z80.regs.a).to.equal(6);
    });

    it("stops on a conditional return only when it is taken", () => {
        const machine = makeMachine([
            0xAF,             // 0x0000  xor a       (sets Z)
            0xC0,             // 0x0001  ret nz      (not taken)
            0xC8,             // 0x0002  ret z       (taken)
        ], {exitOnReturn: true});

        expect(machine.step()).to.be.undefined;
        expect(machine.step()).to.be.undefined;
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.z80.regs.sp).to.equal(0xFFFF);

        expect(machine.step()).to.equal(StopReason.RETURNED);
    });
});

describe("step over", () => {
    it("steps over a call", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
            0x76,             // 0x0003  halt
            0x00,             // 0x0004  nop
            0x3E, 0x07,       // 0x0005  ld a,7
            0xC9,             // 0x0007  ret
        ]);

        const result = machine.stepOver();
        expect(result.reason).to.equal(StopReason.STEP_COMPLETE);
        expect(result.instructions).to.equal(3);
        expect(machine.z80.regs.pc).to.equal(0x0003);
        expect(machine.z80.regs.a).to.equal(0x07);
        expect(machine.z80.regs.sp).to.equal(0xFFFF);

        expect(machine.stepOver().reason).to.equal(StopReason.HALTED);
    });

    it("steps over an rst", () => {
        const machine = makeMachine([
            0xFF,             // 0x0000  rst 0x38
            0x76,             // 0x0001  halt
        ]);
        machine.loadBinary([
            0x3C,             // 0x0038  inc a
            0xC9,             // 0x0039  ret
        ], 0x0038, 0x0000);

        const result = machine.stepOver();
        expect(result.reason).to.equal(StopReason.STEP_COMPLETE);
        expect(machine.z80.regs.pc).to.equal(0x0001);
        expect(machine.z80.regs.a).to.equal(0x01);
    });

    it("steps a single non-call instruction", () => {
        const machine = makeMachine([
            0x3C,             // 0x0000  inc a
            0x76,             // 0x0001  halt
        ]);

        const result = machine.stepOver();
        expect(result.reason).to.equal(StopReason.STEP_COMPLETE);
        expect(result.instructions).to.equal(1);
        expect(result.tStates).to.equal(4);
        expect(machine.z80.regs.pc).to.equal(0x0001);
    });

    it("honors the budget while stepping over", () => {
        const machine = makeMachine([
            0xCD, 0x04, 0x00, // 0x0000  call 0x0004
            0x76,             // 0x0003  halt
            0x18, 0xFE,       // 0x0004  jr 0x0004  (forever)
        ]);

        const result = machine.stepOver({maxInstructions: 10});
        expect(result.reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(result.instructions).to.equal(10);
        expect(machine.z80.regs.pc).to.equal(0x0004);
    });

    it("honors breakpoints while stepping over", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
            0x76,             // 0x0003  halt
            0x00,             // 0x0004  nop
            0x3E, 0x07,       // 0x0005  ld a,7
            0xC9,             // 0x0007  ret
        ]);

        const result = machine.stepOver({breakpoints: [0x0007]});
        expect(result.reason).to.equal(StopReason.BREAKPOINT);
        expect(machine.z80.regs.pc).to.equal(0x0007);
    });
});

describe("history and undo", () => {
    it("has no history by default", () => {
        const machine = makeMachine([0x00, 0x76]);

        machine.run();
        expect(machine.canUndo()).to.be.false;
        expect(machine.undo()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
    });

    it("records and undoes instructions", () => {
        const portWrites: PortWrite[] = [];
        const machine = makeMachine([
            0x3E, 0x11,             // 0x0000  ld a,0x11
            0x32, 0x00, 0x20,       // 0x0002  ld (0x2000),a
            0xD3, 0x05,             // 0x0005  out (5),a
            0x76,                   // 0x0007  halt
        ], {
            historySize: 10,
            onPortWrite: (port, value) => portWrites.push({port, value}),
        });

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.memory[0x2000]).to.equal(0x11);

        const history = machine.getHistory();
        expect(history.length).to.equal(4);
        expect(history.map(record => record.address)).to.deep.equal([0x0000, 0x0002, 0x0005, 0x0007]);
        expect(history[0].stateBefore.regs.pc).to.equal(0x0000);
        expect(history[0].tStateCountBefore).to.equal(0);
        expect(history[1].memoryWrites).to.deep.equal([{address: 0x2000, before: 0x00, value: 0x11}]);
        expect(history[2].portWrites).to.deep.equal([{port: 0x1105, value: 0x11}]);
        expect(history[3].memoryWrites).to.deep.equal([]);

        // Just the most recent records.
        expect(machine.getHistory(2).map(record => record.address)).to.deep.equal([0x0005, 0x0007]);

        // Undo the halt.
        expect(machine.canUndo()).to.be.true;
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.halted).to.equal(0);
        expect(machine.z80.regs.pc).to.equal(0x0007);
        expect(machine.stopReason).to.be.undefined;
        expect(machine.isTerminated()).to.be.false;

        // Undo the out. Port writes already reached the world.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0005);
        expect(machine.tStateCount).to.equal(20);
        expect(portWrites).to.deep.equal([{port: 0x1105, value: 0x11}]);

        // Undo the memory write.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.memory[0x2000]).to.equal(0x00);
        expect(machine.z80.regs.a).to.equal(0x11);

        // Undo the load.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0000);
        expect(machine.z80.regs.a).to.equal(0x00);
        expect(machine.tStateCount).to.equal(0);

        expect(machine.canUndo()).to.be.false;
        expect(machine.undo()).to.be.false;

        // And we can run it all again.
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.memory[0x2000]).to.equal(0x11);
    });

    it("keeps only the most recent records", () => {
        const machine = makeMachine([
            0x00, 0x00, 0x00, 0x00, 0x00, 0x76,
        ], {historySize: 2});

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.getHistory().map(record => record.address)).to.deep.equal([0x0004, 0x0005]);

        expect(machine.undo()).to.be.true;
        expect(machine.undo()).to.be.true;
        expect(machine.undo()).to.be.false;
        expect(machine.z80.regs.pc).to.equal(0x0004);
    });

    it("forgets the history when a new program is loaded", () => {
        // The debugger's "reload and try again": run the first program to a
        // breakpoint, then load a second one over it. Undoing the old program
        // into the new one would write its bytes back over the new image.
        const machine = makeMachine([
            0x3E, 0x11,             // 0x0000  ld a,0x11
            0x32, 0x00, 0x20,       // 0x0002  ld (0x2000),a
            0x00,                   // 0x0005  nop
            0x76,                   // 0x0006  halt
        ], {historySize: 50});
        machine.memory[0x2000] = 0xEE;

        expect(machine.run({breakpoints: [0x0005]}).reason).to.equal(StopReason.BREAKPOINT);
        expect(machine.memory[0x2000]).to.equal(0x11);
        expect(machine.canUndo()).to.be.true;

        machine.loadBinary([
            0x3E, 0x22,             // 0x0000  ld a,0x22
            0x76,                   // 0x0002  halt
        ], 0x0000);
        machine.memory[0x2000] = 0xAB;

        expect(machine.canUndo()).to.be.false;
        expect(machine.undo()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
        expect(machine.memory[0x2000]).to.equal(0xAB);
        expect(machine.z80.regs.pc).to.equal(0x0000);

        // Same for an assembled program.
        expect(machine.run({breakpoints: [0x0002]}).reason).to.equal(StopReason.BREAKPOINT);
        expect(machine.canUndo()).to.be.true;

        machine.loadAssembly(assemble(" .org 0x100\n ld a,0x33\n halt\n"));
        expect(machine.canUndo()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
        expect(machine.z80.regs.pc).to.equal(0x0100);
    });

    it("doesn't record a rolled-back instruction", () => {
        const machine = makeMachine([
            0x00,             // 0x0000  nop
            0xDB, 0x10,       // 0x0001  in a,(0x10)
            0x76,             // 0x0003  halt
        ], {
            historySize: 10,
            onPortRead: () => undefined,
        });

        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.getHistory().map(record => record.address)).to.deep.equal([0x0000]);
    });
});

describe("pokes", () => {
    // ld a,0x11 / ld (0x2000),a / halt: one register write and one memory
    // write, so a poke can be made between two instructions that touch both.
    const PROGRAM = [
        0x3E, 0x11,             // 0x0000  ld a,0x11
        0x32, 0x00, 0x20,       // 0x0002  ld (0x2000),a
        0x76,                   // 0x0005  halt
    ];

    it("refuses a second begin, an end with nothing open, and a poke while executing", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        // No poke open yet.
        expect(() => machine.endPoke()).to.throw();

        machine.beginPoke();
        expect(() => machine.beginPoke()).to.throw();
        expect(machine.endPoke()).to.be.false;
        expect(() => machine.endPoke()).to.throw();
    });

    it("refuses a poke while an instruction is executing", () => {
        let error: unknown = undefined;
        let machine: Z80Machine | undefined = undefined;
        machine = makeMachine(PROGRAM, {
            historySize: 10,
            onMemoryWrite: () => {
                try {
                    machine?.beginPoke();
                } catch (e) {
                    error = e;
                }
                return false;
            },
        });

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(error).to.be.an("error");
        // And the failed attempt left no transaction behind.
        expect(() => machine.endPoke()).to.throw();
    });

    it("refuses to execute, undo or interrupt while a poke is open", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        expect(machine.step()).to.be.undefined;
        machine.beginPoke();
        expect(() => machine.step()).to.throw();
        expect(() => machine.run()).to.throw();
        expect(() => machine.undo()).to.throw();
        expect(() => machine.raiseNmi()).to.throw();
        expect(machine.endPoke()).to.be.false;

        // And everything works again once the poke is closed.
        expect(machine.step()).to.be.undefined;
        expect(machine.undo()).to.be.true;
    });

    it("writes registers and memory directly outside a poke", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        expect(machine.step()).to.be.undefined;
        const tStateCount = machine.tStateCount;
        const historyLength = machine.getHistory().length;

        machine.setRegisterValue("hl", 0x1234);
        machine.setRegisterValue("a", 0x22);
        machine.writeMemoryBytes(0x3000, [0xAA, 0xBB]);

        expect(machine.z80.regs.hl).to.equal(0x1234);
        expect(machine.z80.regs.a).to.equal(0x22);
        expect(machine.memory[0x3000]).to.equal(0xAA);
        expect(machine.memory[0x3001]).to.equal(0xBB);
        // Nothing was recorded, which is what a testcase's preset values want.
        expect(machine.getHistory().length).to.equal(historyLength);
        expect(machine.tStateCount).to.equal(tStateCount);

        // And undoing the instruction doesn't restore the register the host
        // wrote to a value the program never gave it, it just goes back to
        // what the machine had before the instruction.
        expect(machine.undo()).to.be.true;
        expect(machine.memory[0x3000]).to.equal(0xAA);
    });

    it("clamps a poked register to what it can hold", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        machine.setRegisterValue("hl", 0x12345);
        expect(machine.z80.regs.hl).to.equal(0x2345);
        machine.setRegisterValue("a", 0x1FF);
        expect(machine.z80.regs.a).to.equal(0xFF);
        machine.setRegisterValue("sp", -1);
        expect(machine.z80.regs.sp).to.equal(0xFFFF);

        machine.beginPoke();
        machine.setRegisterValue("bcPrime", 0xABCDE);
        expect(machine.endPoke()).to.be.true;
        expect(machine.z80.regs.bcPrime).to.equal(0xBCDE);

        expect(() => machine.setRegisterValue("hl'" as never, 0)).to.throw();
        expect(() => machine.setRegisterValue("nope" as never, 0)).to.throw();
    });

    it("records nothing when a write leaves the value unchanged", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});
        machine.setRegisterValue("hl", 0x1234);
        machine.writeMemoryBytes(0x3000, [0xAA, 0xBB]);

        machine.beginPoke();
        machine.setRegisterValue("hl", 0x1234);
        machine.writeMemoryBytes(0x3000, [0xAA, 0xBB]);
        expect(machine.endPoke()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
        expect(machine.canUndo()).to.be.false;

        // A value written and then written back is no change either, in a
        // register and in memory alike: the poke is measured against what
        // the machine held before it, never against a value that only ever
        // existed inside the transaction.
        machine.beginPoke();
        machine.setRegisterValue("hl", 0x4321);
        machine.setRegisterValue("hl", 0x1234);
        machine.writeMemoryBytes(0x3000, [0xFF, 0xFF]);
        machine.writeMemoryBytes(0x3000, [0xAA, 0xBB]);
        expect(machine.endPoke()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
        expect(machine.canUndo()).to.be.false;
        expect(machine.memory[0x3000]).to.equal(0xAA);
        expect(machine.memory[0x3001]).to.equal(0xBB);

        // And memory written back on its own, with nothing else in the poke.
        machine.beginPoke();
        machine.writeMemoryBytes(0x3000, [0x00, 0x00]);
        machine.writeMemoryBytes(0x3000, [0xAA, 0xBB]);
        expect(machine.endPoke()).to.be.false;
        expect(machine.canUndo()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
    });

    it("records one memory entry however often the range is written", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});
        machine.writeMemoryBytes(0x9000, [0x01, 0x02, 0x03]);

        machine.beginPoke();
        // The same address twice, then a range overlapping it, then a range
        // continuing it: one run of three bytes in the end.
        machine.writeMemoryBytes(0x9000, [0xAA]);
        machine.writeMemoryBytes(0x9000, [0xBB]);
        machine.writeMemoryBytes(0x9001, [0xCC, 0xDD]);
        machine.writeMemoryBytes(0x9002, [0xEE]);
        expect(machine.endPoke()).to.be.true;

        const poke = machine.getHistory()[0];
        // One entry, with the bytes from before the poke: the transient
        // 0xAA and 0xDD, which the machine held only inside the
        // transaction, appear nowhere.
        expect(poke.writes).to.deep.equal([
            {type: "memory", address: 0x9000, old: [0x01, 0x02, 0x03], new: [0xBB, 0xCC, 0xEE]},
        ]);

        expect(machine.undo()).to.be.true;
        expect(Array.from(machine.memory.slice(0x9000, 0x9003)))
            .to.deep.equal([0x01, 0x02, 0x03]);
        expect(machine.canUndo()).to.be.false;
    });

    it("undoes memory a poke wrote and wrote back, alongside what it did change", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});
        machine.writeMemoryBytes(0x9000, [0x01, 0x02]);

        machine.beginPoke();
        machine.setRegisterValue("bc", 0x1234);
        machine.writeMemoryBytes(0x9000, [0xFF, 0xFF]);
        machine.writeMemoryBytes(0x9000, [0x01, 0x02]);
        expect(machine.endPoke()).to.be.true;

        // The memory came back to where it started, so only the register is
        // reported, and the transient 0xFF is nowhere in the record.
        expect(machine.getHistory()[0].writes).to.deep.equal([
            {type: "register", name: "bc", old: 0x0000, new: 0x1234},
        ]);

        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.bc).to.equal(0x0000);
        expect(Array.from(machine.memory.slice(0x9000, 0x9002))).to.deep.equal([0x01, 0x02]);
    });

    it("keeps the ranges the host wrote apart apart, in the order it wrote them", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        machine.beginPoke();
        machine.writeMemoryBytes(0x9100, [0x11]);
        machine.setRegisterValue("de", 0x0042);
        machine.writeMemoryBytes(0x9000, [0x22]);
        expect(machine.endPoke()).to.be.true;

        expect(machine.getHistory()[0].writes).to.deep.equal([
            {type: "memory", address: 0x9100, old: [0x00], new: [0x11]},
            {type: "register", name: "de", old: 0x0000, new: 0x0042},
            {type: "memory", address: 0x9000, old: [0x00], new: [0x22]},
        ]);
    });

    it("records one entry with the old and the new values", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});
        machine.writeMemoryBytes(0x2000, [0x01, 0x02, 0x03]);

        expect(machine.step()).to.be.undefined;

        machine.beginPoke();
        machine.setRegisterValue("hl", 0x1234);
        machine.setRegisterValue("hl", 0x4321);
        machine.setRegisterValue("hlPrime", 0x0009);
        machine.writeMemoryBytes(0x2000, [0xAA, 0x02, 0xCC]);
        expect(machine.endPoke()).to.be.true;

        const history = machine.getHistory();
        expect(history.length).to.equal(2);
        expect(history[0].kind).to.equal("instruction");
        expect(history[0].writes).to.be.undefined;

        const poke = history[1];
        expect(poke.kind).to.equal("poke");
        expect(poke.portWrites).to.deep.equal([]);
        // One entry per register, whatever the number of writes, with the
        // value found at the first write and the one left at the end.
        expect(poke.writes).to.deep.equal([
            {type: "register", name: "hl", old: 0x0000, new: 0x4321},
            {type: "register", name: "hlPrime", old: 0x0000, new: 0x0009},
            // The whole range that was written, unchanged bytes included.
            {type: "memory", address: 0x2000, old: [0x01, 0x02, 0x03], new: [0xAA, 0x02, 0xCC]},
        ]);
        expect(isPokeRecord(poke)).to.be.true;
        expect(isPokeRecord(history[0])).to.be.false;
    });

    it("gives a poke an identity of its own", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        expect(machine.step()).to.be.undefined;
        const stoppedAt = machine.z80.regs.pc;
        machine.beginPoke();
        machine.setRegisterValue("de", 0x0042);
        expect(machine.endPoke()).to.be.true;

        const history = machine.getHistory();
        expect(history.map(record => record.kind)).to.deep.equal(["instruction", "poke"]);
        expect(history[0].address).to.equal(0x0000);
        // The poke ran no instruction, so it reports no instruction
        // address: not the PC the machine is stopped at, which is where the
        // next instruction will be recorded, and nothing a 16-bit address
        // could be.
        expect(history[1].address).to.equal(POKE_RECORD_ADDRESS);
        expect(POKE_RECORD_ADDRESS).to.equal(-1);
        expect(history[1].address).to.not.equal(stoppedAt);
        expect(history[1].interrupt).to.be.undefined;
        // The PC it was made at is still there, in the state it restores.
        expect(history[1].stateBefore.regs.pc).to.equal(stoppedAt);

        // Stepping records the instruction that was about to run at the PC
        // the poke was made at, and that record's address is its own: no
        // reader of the history can mistake the one for the other.
        expect(machine.step()).to.be.undefined;
        const after = machine.getHistory();
        expect(after.map(record => record.kind))
            .to.deep.equal(["instruction", "poke", "instruction"]);
        expect(after[2].address).to.equal(stoppedAt);
        expect(after[2].address).to.not.equal(after[1].address);
        expect(after.filter(record => record.address === POKE_RECORD_ADDRESS).length).to.equal(1);

        // And every entry carries a step id no other entry has, in the
        // order the entries were made, poke and instructions alike.
        const ids = after.map(record => record.stepId);
        expect(ids).to.deep.equal([1, 2, 3]);
        expect(new Set(ids).size).to.equal(ids.length);
    });

    it("never repeats a step id, across pokes, undos and resets", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0001);
        expect(machine.endPoke()).to.be.true;
        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0002);
        expect(machine.endPoke()).to.be.true;

        // Two consecutive pokes are two entries with two identities, even
        // though both sit at the same address and the same t-state count.
        const pokes = machine.getHistory();
        expect(pokes.map(record => record.kind)).to.deep.equal(["poke", "poke"]);
        expect(pokes[0].address).to.equal(pokes[1].address);
        expect(pokes[0].tStateCountBefore).to.equal(pokes[1].tStateCountBefore);
        expect(pokes[0].stepId).to.not.equal(pokes[1].stepId);

        // An id an undone entry had is not handed out again.
        const undone = pokes[1].stepId;
        expect(machine.undo()).to.be.true;
        expect(machine.step()).to.be.undefined;
        expect(machine.getHistory().map(record => record.stepId))
            .to.deep.equal([pokes[0].stepId, undone + 1]);

        machine.reset();
        expect(machine.step()).to.be.undefined;
        expect(machine.getHistory()[0].stepId).to.equal(undone + 2);
    });

    it("takes one slot of the history", () => {
        const machine = makeMachine(PROGRAM, {historySize: 2});

        expect(machine.step()).to.be.undefined;
        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0001);
        expect(machine.endPoke()).to.be.true;
        expect(machine.getHistory().map(record => record.kind))
            .to.deep.equal(["instruction", "poke"]);

        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0002);
        expect(machine.endPoke()).to.be.true;
        // The oldest record fell off the end, the poke included.
        expect(machine.getHistory().map(record => record.kind)).to.deep.equal(["poke", "poke"]);
        expect(machine.getHistory(1).map(record => record.writes?.length)).to.deep.equal([1]);
    });

    it("applies but doesn't record a poke when history is disabled", () => {
        const machine = makeMachine(PROGRAM);

        machine.beginPoke();
        machine.setRegisterValue("bc", 0x1234);
        expect(machine.endPoke()).to.be.false;
        expect(machine.z80.regs.bc).to.equal(0x1234);
        expect(machine.canUndo()).to.be.false;
        expect(machine.getHistory()).to.deep.equal([]);
    });

    it("undoes a poke and touches nothing else", () => {
        const machine = makeMachine([
            0xCD, 0x06, 0x00,       // 0x0000  call 0x0006
            0x00,                   // 0x0003  nop
            0x00,                   // 0x0004  nop
            0x76,                   // 0x0005  halt
            0x3E, 0x11,             // 0x0006  ld a,0x11
            0xC9,                   // 0x0008  ret
        ], {historySize: 10});
        machine.memory[0x2000] = 0xEE;

        // Stop inside the routine, so there's a call stack to disturb.
        expect(machine.run({breakpoints: [0x0008]}).reason).to.equal(StopReason.BREAKPOINT);
        const before = {
            pc: machine.z80.regs.pc,
            sp: machine.z80.regs.sp,
            f: machine.z80.regs.f,
            a: machine.z80.regs.a,
            tStateCount: machine.tStateCount,
            stopReason: machine.stopReason,
            callStack: machine.getCallStack().length,
            historyLength: machine.getHistory().length,
        };
        expect(before.callStack).to.equal(1);

        machine.beginPoke();
        machine.setRegisterValue("a", 0x77);
        machine.setRegisterValue("ix", 0x5678);
        machine.writeMemoryBytes(0x2000, [0xAB, 0xCD]);
        expect(machine.endPoke()).to.be.true;

        expect(machine.z80.regs.a).to.equal(0x77);
        expect(machine.z80.regs.ix).to.equal(0x5678);
        expect(machine.memory[0x2000]).to.equal(0xAB);
        expect(machine.memory[0x2001]).to.equal(0xCD);
        // The poke itself costs no time and doesn't resume the machine.
        expect(machine.tStateCount).to.equal(before.tStateCount);
        expect(machine.stopReason).to.equal(before.stopReason);
        expect(machine.getCallStack().length).to.equal(before.callStack);

        expect(machine.canUndo()).to.be.true;
        expect(machine.undo()).to.be.true;

        expect(machine.z80.regs.a).to.equal(before.a);
        expect(machine.z80.regs.ix).to.equal(0x0000);
        expect(machine.memory[0x2000]).to.equal(0xEE);
        expect(machine.memory[0x2001]).to.equal(0x00);
        expect(machine.z80.regs.pc).to.equal(before.pc);
        expect(machine.z80.regs.sp).to.equal(before.sp);
        expect(machine.z80.regs.f).to.equal(before.f);
        expect(machine.tStateCount).to.equal(before.tStateCount);
        // The poke set no stop reason, so undoing it clears none.
        expect(machine.stopReason).to.equal(before.stopReason);
        expect(machine.getCallStack().length).to.equal(before.callStack);
        expect(machine.getHistory().length).to.equal(before.historyLength);

        // And the program runs on from exactly where it was.
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.z80.regs.a).to.equal(0x11);
    });

    it("keeps a poke out of a peripheral's way", () => {
        // A poke writes RAM itself: the onMemoryWrite hook, which is how a
        // memory-mapped device sees the CPU's writes, is not called.
        const writes: number[] = [];
        const machine = makeMachine(PROGRAM, {
            historySize: 10,
            onMemoryWrite: (address) => {
                writes.push(address);
                return false;
            },
        });

        machine.beginPoke();
        machine.writeMemoryBytes(0x2000, [0x01]);
        expect(machine.endPoke()).to.be.true;
        expect(writes).to.deep.equal([]);

        machine.writeMemoryBytes(0x2001, [0x02]);
        expect(writes).to.deep.equal([]);

        // The CPU's own write still goes through it.
        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(writes).to.deep.equal([0x2000]);
    });

    it("leaves a machine waiting for input waiting for it", () => {
        const machine = makeMachine([
            0x00,             // 0x0000  nop
            0xDB, 0x10,       // 0x0001  in a,(0x10)
            0x76,             // 0x0003  halt
        ], {
            historySize: 10,
            onPortRead: () => undefined,
        });

        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.pendingInputPort).to.equal(0x0010);

        machine.beginPoke();
        machine.setRegisterValue("de", 0x1111);
        expect(machine.endPoke()).to.be.true;
        expect(machine.undo()).to.be.true;

        // The poke didn't stop the machine, so undoing it doesn't start it.
        expect(machine.z80.regs.de).to.equal(0x0000);
        expect(machine.stopReason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.pendingInputPort).to.equal(0x0010);

        // Undoing the instruction underneath does clear it, as it always has.
        expect(machine.undo()).to.be.true;
        expect(machine.stopReason).to.be.undefined;
        expect(machine.pendingInputPort).to.be.undefined;
    });

    it("undoes two pokes one at a time", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});

        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0001);
        expect(machine.endPoke()).to.be.true;
        machine.beginPoke();
        machine.setRegisterValue("bc", 0x0002);
        expect(machine.endPoke()).to.be.true;

        expect(machine.getHistory().map(record => record.kind)).to.deep.equal(["poke", "poke"]);

        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.bc).to.equal(0x0001);
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.bc).to.equal(0x0000);
        expect(machine.canUndo()).to.be.false;
    });

    it("undoes an instruction before the poke that came before it", () => {
        const machine = makeMachine(PROGRAM, {historySize: 10});
        machine.memory[0x2000] = 0xEE;

        // Stop between the two instructions.
        expect(machine.step()).to.be.undefined;
        const before = {
            a: machine.z80.regs.a,
            hl: machine.z80.regs.hl,
            pc: machine.z80.regs.pc,
            tStateCount: machine.tStateCount,
        };

        machine.beginPoke();
        machine.setRegisterValue("a", 0x55);
        machine.setRegisterValue("hl", 0x4321);
        expect(machine.endPoke()).to.be.true;

        // The instruction stores the poked accumulator.
        expect(machine.step()).to.be.undefined;
        expect(machine.memory[0x2000]).to.equal(0x55);

        expect(machine.getHistory().map(record => record.kind))
            .to.deep.equal(["instruction", "poke", "instruction"]);

        // The instruction goes first, taking its memory write with it.
        expect(machine.undo()).to.be.true;
        expect(machine.memory[0x2000]).to.equal(0xEE);
        expect(machine.z80.regs.a).to.equal(0x55);
        expect(machine.z80.regs.hl).to.equal(0x4321);
        expect(machine.z80.regs.pc).to.equal(before.pc);

        // Then the poke, leaving exactly the state from before it.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.a).to.equal(before.a);
        expect(machine.z80.regs.hl).to.equal(before.hl);
        expect(machine.z80.regs.pc).to.equal(before.pc);
        expect(machine.tStateCount).to.equal(before.tStateCount);
        expect(machine.memory[0x2000]).to.equal(0xEE);

        // And the first instruction is still undoable underneath.
        expect(machine.undo()).to.be.true;
        expect(machine.z80.regs.pc).to.equal(0x0000);
        expect(machine.canUndo()).to.be.false;
    });
});

describe("save and restore", () => {
    it("round-trips the whole machine", () => {
        const machine = makeMachine([
            0x3E, 0x22,             // 0x0000  ld a,0x22
            0x32, 0x00, 0x20,       // 0x0002  ld (0x2000),a
            0x76,                   // 0x0005  halt
        ], {historySize: 10});
        const memory = machine.memory;

        expect(machine.run({maxInstructions: 1}).reason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        const state = machine.save();
        const tStateCount = machine.tStateCount;

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.memory[0x2000]).to.equal(0x22);

        machine.restore(state);
        // The memory buffer's identity is preserved.
        expect(machine.memory).to.equal(memory);
        expect(machine.memory[0x2000]).to.equal(0x00);
        expect(machine.z80.regs.pc).to.equal(0x0002);
        expect(machine.z80.regs.a).to.equal(0x22);
        expect(machine.tStateCount).to.equal(tStateCount);
        expect(machine.stopReason).to.equal(StopReason.INSTRUCTIONS_EXHAUSTED);
        expect(machine.isTerminated()).to.be.false;
        // The history no longer describes how we got here.
        expect(machine.canUndo()).to.be.false;

        // The snapshot is a copy, unaffected by later runs.
        expect(state.memory[0x2000]).to.equal(0x00);

        expect(machine.run().reason).to.equal(StopReason.HALTED);
        expect(machine.memory[0x2000]).to.equal(0x22);
    });

    it("saves the stop state", () => {
        const machine = makeMachine([
            0xDB, 0x10,       // 0x0000  in a,(0x10)
            0x76,             // 0x0002  halt
        ], {
            onPortRead: () => undefined,
        });

        expect(machine.run().reason).to.equal(StopReason.WAITING_FOR_INPUT);
        const state = machine.save();
        expect(state.stopReason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(state.pendingInputPort).to.equal(0x0010);

        machine.reset();
        expect(machine.stopReason).to.be.undefined;

        machine.restore(state);
        expect(machine.stopReason).to.equal(StopReason.WAITING_FOR_INPUT);
        expect(machine.pendingInputPort).to.equal(0x0010);
    });

    it("restores the call stack, not the one from the run since", () => {
        const machine = makeMachine([
            0xCD, 0x09, 0x00, // 0x0000  call 0x0009
            0xCD, 0x09, 0x00, // 0x0003  call 0x0009
            0x76,             // 0x0006  halt
            0x00, 0x00,       // 0x0007  filler
            0xC9,             // 0x0009  ret
        ]);

        // Inside the routine, called from the first call site.
        expect(machine.step()).to.be.undefined;
        const frames = machine.getCallStack();
        expect(frames.length).to.equal(1);
        expect(frames[0].callSiteAddress).to.equal(0x0000);

        const state = machine.save();

        // Run on: the second call reuses the same stack slot with a different
        // call site, so the CPU's record of who pushed it is overwritten.
        expect(machine.run().reason).to.equal(StopReason.HALTED);

        machine.restore(state);
        expect(machine.z80.regs.pc).to.equal(0x0009);
        expect(machine.getCallStack()).to.deep.equal(frames);
    });
});

describe("machine state", () => {
    it("is complete in its own fields", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
            0x76,             // 0x0003  halt
            0x00,             // 0x0004  nop
            0xC9,             // 0x0005  ret
        ]);

        expect(machine.step()).to.be.undefined;
        const frames = machine.getCallStack();
        expect(frames.length).to.equal(1);

        const state = machine.save();
        // Everything the snapshot holds is reachable through its public
        // fields, so a state rebuilt from them is as good as the original.
        const rebuilt = new Z80MachineState(state.z80State, state.memory, state.tStateCount,
            state.stopReason, state.pendingInputPort, state.stackProvenance);

        expect(machine.run().reason).to.equal(StopReason.HALTED);

        machine.restore(rebuilt);
        expect(machine.z80.regs.pc).to.equal(0x0005);
        expect(machine.getCallStack()).to.deep.equal(frames);
    });
});

describe("call stack", () => {
    it("reconstructs the call stack", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
            0x76,             // 0x0003  halt
            0x00,             // 0x0004  nop
            0x3E, 0x07,       // 0x0005  ld a,7
            0xC9,             // 0x0007  ret
        ]);

        expect(machine.getCallStack()).to.deep.equal([]);

        expect(machine.step()).to.be.undefined;
        expect(machine.z80.regs.pc).to.equal(0x0005);

        const frames = machine.getCallStack();
        expect(frames.length).to.equal(1);
        expect(frames[0].callSiteAddress).to.equal(0x0000);
        expect(frames[0].targetAddress).to.equal(0x0005);
        expect(frames[0].returnAddress).to.equal(0x0003);
        expect(frames[0].stackAddress).to.equal(0xFFFD);
    });

    it("steps out of a routine", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
            0x76,             // 0x0003  halt
            0x00,             // 0x0004  nop
            0x3E, 0x07,       // 0x0005  ld a,7
            0xC9,             // 0x0007  ret
        ]);

        expect(machine.step()).to.be.undefined;

        const result = machine.stepOut();
        expect(result.reason).to.equal(StopReason.STEP_COMPLETE);
        expect(result.instructions).to.equal(2);
        expect(machine.z80.regs.pc).to.equal(0x0003);
        expect(machine.z80.regs.sp).to.equal(0xFFFF);
    });

    it("runs when there is no frame to step out of", () => {
        const machine = makeMachine([
            0x3C,             // 0x0000  inc a
            0x76,             // 0x0001  halt
        ]);

        const result = machine.stepOut();
        expect(result.reason).to.equal(StopReason.HALTED);
        expect(result.instructions).to.equal(2);
    });

    it("disassembles an instruction", () => {
        const machine = makeMachine([
            0xCD, 0x05, 0x00, // 0x0000  call 0x0005
        ]);

        const instruction = machine.disassembleAt(0x0000);
        expect(instruction.mnemonic).to.equal("call");
        expect(instruction.bin).to.deep.equal([0xCD, 0x05, 0x00]);
    });
});

console.log(successCount + " successful out of " + testCount, successCount === testCount ? "✅" : "❌");
if (successCount !== testCount) {
    process.exitCode = 1;
}
