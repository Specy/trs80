import {Hal, Z80, Z80State} from "z80-emulator";
import {Instruction} from "z80-disasm";
import {isRegisterSetField, Register, toHexWord} from "z80-base";
import {AssemblyResult} from "./Assemble.js";
import {CallStackFrame, disassembleInstructionAt, reconstructCallStack} from "./CallStack.js";
import {DEFAULT_INITIAL_SP, DEFAULT_PORT_READ_VALUE, MEMORY_SIZE} from "./Constants.js";
import {
    ExecutionRecord,
    isTerminalStopReason,
    MemoryWrite,
    POKE_RECORD_ADDRESS,
    PokeWrite,
    RunOptions,
    RunResult,
    StopReason,
    Z80MachineConfig,
    Z80MachineState,
} from "./Z80MachineTypes.js";

/**
 * Opcodes of the RET-family instructions that pop a return address, either
 * unconditionally (0xC9) or on a flag test.
 */
const RET_OPCODES = new Set<number>([
    0xC9,
    0xC0, 0xC8, 0xD0, 0xD8, 0xE0, 0xE8, 0xF0, 0xF8,
]);

/**
 * Second byte of the ED-prefixed returns (reti and retn).
 */
const ED_RET_OPCODES = new Set<number>([0x45, 0x4D, 0x55, 0x5D, 0x65, 0x6D, 0x75, 0x7D]);

/**
 * Opcodes of the CALL instructions, unconditional and conditional. All are
 * three bytes long.
 */
const CALL_OPCODES = new Set<number>([0xCD, 0xC4, 0xCC, 0xD4, 0xDC, 0xE4, 0xEC, 0xF4, 0xFC]);

/**
 * Opcodes of the RST instructions. All are one byte long.
 */
const RST_OPCODES = new Set<number>([0xC7, 0xCF, 0xD7, 0xDF, 0xE7, 0xEF, 0xF7, 0xFF]);

/**
 * Prefix of the extended instructions, which include reti and retn.
 */
const ED_PREFIX = 0xED;

/**
 * Thrown out of the CPU (through the Hal's readPort) when the configured
 * onPortRead handler has no data available yet. The machine catches this,
 * rolls the instruction back, and stops with
 * {@link StopReason.WAITING_FOR_INPUT}.
 */
class InputPendingError extends Error {
    public readonly port: number;

    constructor(port: number) {
        super("no input available on port 0x" + toHexWord(port));
        this.port = port;
    }
}

/**
 * Make a bitmap of the breakpoint addresses, for fast lookup in the run
 * loop, or undefined if there are no breakpoints.
 */
function makeBreakpointMap(breakpoints: Iterable<number> | undefined): Uint8Array | undefined {
    if (breakpoints === undefined) {
        return undefined;
    }

    let map: Uint8Array | undefined = undefined;

    for (const address of breakpoints) {
        if (map === undefined) {
            map = new Uint8Array(MEMORY_SIZE);
        }
        map[address & 0xFFFF] = 1;
    }

    return map;
}

/**
 * The registers that hold a word. Every other register of the core's
 * RegisterSet holds a byte, so this is what {@link Z80Machine.setRegisterValue}
 * clamps a value against. The shadow registers are spelled with the "Prime"
 * suffix, the way the core's RegisterSet spells its fields.
 */
const WORD_REGISTERS = new Set<Register>([
    "af", "bc", "de", "hl",
    "afPrime", "bcPrime", "dePrime", "hlPrime",
    "ix", "iy", "sp", "pc", "memptr",
]);

/**
 * One register journaled by an open poke, with the value the register held
 * before the poke first wrote it. The value it ends up with is read back at
 * {@link Z80Machine.endPoke}, so writing the same register twice stays one
 * entry, whose old value is the one from before the poke.
 */
interface RegisterJournalEntry {
    name: Register;
    old: number;

    /**
     * When this register was first written inside the poke, so that the
     * writes of the record come out in the order the host made them.
     */
    order: number;
}

/**
 * One byte of RAM journaled by an open poke, with the value the byte held
 * before the poke first wrote it. Bytes are keyed by address exactly as
 * registers are keyed by name, so that writing the same address twice stays
 * one journaled byte holding the value from before the poke, never a value
 * that only ever existed inside the transaction.
 * {@link Z80Machine.endPoke} gathers the journaled bytes back into runs of
 * consecutive addresses, one entry of the record's writes each.
 */
interface MemoryJournalEntry {
    old: number;

    /**
     * When this address was first written; see
     * {@link RegisterJournalEntry.order}.
     */
    order: number;
}

/**
 * An open poke transaction: what the machine looked like when it began, and
 * what has been written into it so far.
 */
interface PokeJournal {
    /**
     * CPU state at beginPoke, which is what undoing the poke restores.
     */
    stateBefore: Z80State;
    tStateCountBefore: number;

    /**
     * RAM writes, one per changed byte, in the same shape an instruction's
     * record uses, so that undo reverses them with no special case.
     */
    memoryWrites: MemoryWrite[];

    /**
     * The registers written so far, by name, so that a second write to the
     * same register finds the first one.
     */
    registerEntries: Map<Register, RegisterJournalEntry>;

    /**
     * The bytes of RAM written so far, by address, so that a second write to
     * the same address finds the first one.
     */
    memoryEntries: Map<number, MemoryJournalEntry>;

    /**
     * Hands out the order of the entries above, one number per register or
     * address the poke touches for the first time.
     */
    nextOrder: number;
}

/**
 * A generic, ready-to-use Z80 computer: 64 kB of RAM, pluggable IO through
 * callbacks, a run loop with breakpoints and budgets, optional execution
 * history with undo, and helpers for loading assembled or raw programs.
 *
 * The machine is itself the {@link Hal} for its CPU, so `machine.z80` and
 * everything on it (registers, interrupts, save/restore) is fully
 * accessible.
 */
export class Z80Machine implements Hal {
    public readonly z80: Z80;

    /**
     * The machine's 64 kB of RAM. Reading and writing this directly is
     * allowed (it bypasses the onMemory hooks and history journal, and an
     * open poke); see {@link Z80Machine.writeMemoryBytes} for a write that a
     * poke can journal and undo.
     */
    public readonly memory: Uint8Array;

    /**
     * Clock count, in t-states.
     */
    public tStateCount = 0;

    /**
     * Why the most recent run, step, stepOver or stepOut call ended.
     * Undefined before the first call, while a call is in progress, and
     * after a reset, a load, an undo, or an interrupt that woke the CPU.
     *
     * A stop reason does not mean the machine can't continue: BREAKPOINT,
     * WAITING_FOR_INPUT, WAITING_FOR_INTERRUPT, T_STATES_EXHAUSTED,
     * INSTRUCTIONS_EXHAUSTED and STEP_COMPLETE all leave it resumable. Use
     * {@link Z80Machine.isTerminated} to ask whether the program is over;
     * running one budgeted slice per frame, for instance, leaves a stop
     * reason set after every slice.
     */
    public stopReason: StopReason | undefined = undefined;

    /**
     * The port an unfulfilled IN is waiting on, when stopped with
     * {@link StopReason.WAITING_FOR_INPUT}.
     */
    public pendingInputPort: number | undefined = undefined;

    /**
     * The initial stack pointer, treated as the top of the stack for
     * call-stack reconstruction and the exitOnReturn option.
     */
    public readonly stackTop: number;
    private stackRegionTop: number;
    public getStackTop(): number { return this.stackRegionTop; }

    // The configured hooks, or undefined if the embedder didn't supply them.
    private readonly onPortRead: ((port: number) => number | undefined) | undefined;
    private readonly onPortWrite: ((port: number, value: number) => void) | undefined;
    private readonly onMemoryRead: ((address: number) => number | undefined) | undefined;
    private readonly onDebugRead: ((address: number) => number | undefined) | undefined;
    private readonly onMemoryWrite: ((address: number, value: number) => boolean | void) | undefined;

    // Whether a top-level return stops the machine.
    private readonly exitOnReturn: boolean;

    // Ring buffer of execution records, allocated as execution reaches its
    // slots, up to historyCapacity. The oldest record is at historyStart,
    // and there are historyCount records.
    private readonly historyCapacity: number;
    private historyBuffer: (ExecutionRecord | undefined)[] = [];
    private historyStart = 0;
    private historyCount = 0;

    // Record being filled in by the instruction currently executing, or
    // undefined if history is disabled or no instruction is executing.
    private pendingRecord: ExecutionRecord | undefined = undefined;
    /** Set by {@link pause} while an instruction runs, read once it has. */
    private pauseRequested = false;

    // Whether we're inside the CPU's step() method. Port reads can only be
    // rolled back (and therefore retried) from there.
    private executing = false;

    // The open poke transaction, or undefined if no poke is open. While one
    // is open the host setters journal into it instead of writing directly.
    private pokeJournal: PokeJournal | undefined = undefined;

    // Identity handed to the next record that enters the history. Never
    // reset, so an id is never reused for the life of the machine, and a
    // record that never entered the history keeps the 0 it was made with.
    private nextStepId = 1;

    constructor(config?: Z80MachineConfig) {
        const memory = config?.memory;
        if (memory !== undefined && memory.length !== MEMORY_SIZE) {
            throw new Error("the machine's memory must be exactly 64 kB (" + MEMORY_SIZE +
                " bytes), but it is " + memory.length + " bytes");
        }

        this.z80 = new Z80(this);
        this.memory = memory ?? new Uint8Array(MEMORY_SIZE);
        this.stackTop = config?.initialSp ?? DEFAULT_INITIAL_SP;
        this.stackRegionTop = this.stackTop;
        this.onPortRead = config?.onPortRead;
        this.onPortWrite = config?.onPortWrite;
        this.onMemoryRead = config?.onMemoryRead;
        this.onDebugRead = config?.onDebugRead ?? config?.onMemoryRead;
        this.onMemoryWrite = config?.onMemoryWrite;
        this.exitOnReturn = config?.exitOnReturn ?? false;
        this.historyCapacity = Math.max(0, config?.historySize ?? 0);
        if (!Number.isInteger(this.historyCapacity) || this.historyCapacity > 0xFFFFFFFF) {
            throw new RangeError("Invalid history size");
        }
        this.z80.regs.sp = this.stackTop;
        this.stackRegionTop = this.stackTop;
    }

    // The Hal interface. These apply the configured hooks and (when
    // history is enabled) journal the writes.
    public readMemory(address: number): number {
        address &= 0xFFFF;

        if (this.onMemoryRead !== undefined) {
            const value = this.onMemoryRead(address);
            if (value !== undefined) {
                return value & 0xFF;
            }
        }

        return this.memory[address];
    }

    public writeMemory(address: number, value: number): void {
        address &= 0xFFFF;
        value &= 0xFF;

        if (this.onMemoryWrite !== undefined && this.onMemoryWrite(address, value) === true) {
            // Handled by the device, RAM is untouched (and there's nothing to undo).
            return;
        }

        if (this.pendingRecord !== undefined) {
            this.pendingRecord.memoryWrites.push({
                address: address,
                before: this.memory[address],
                value: value,
            });
        }

        this.memory[address] = value;
    }

    public contendMemory(address: number): void {
        // No contention is modeled, and the core doesn't currently call this.
    }

    public readPort(address: number): number {
        if (this.onPortRead !== undefined) {
            const value = this.onPortRead(address);
            if (value !== undefined) {
                return value & 0xFF;
            }

            if (this.executing) {
                // Unwind out of the CPU. The instruction will be rolled back
                // and retried when the data shows up.
                throw new InputPendingError(address);
            }
        }

        // Nothing on the bus.
        return DEFAULT_PORT_READ_VALUE;
    }

    public writePort(address: number, value: number): void {
        value &= 0xFF;

        if (this.pendingRecord !== undefined) {
            this.pendingRecord.portWrites.push({
                port: address,
                value: value,
            });
        }

        if (this.onPortWrite !== undefined) {
            this.onPortWrite(address, value);
        }
    }

    public contendPort(address: number): void {
        // No contention is modeled, and the core doesn't currently call this.
    }

    /**
     * Reset the CPU and clock, apply the initial stack pointer, clear the
     * stop state and the execution history. Memory is left untouched.
     */
    public reset(): void {
        this.z80.reset();
        this.z80.regs.sp = this.stackTop;
        this.stackRegionTop = this.stackTop;
        this.tStateCount = 0;
        this.clearStopState();
        this.clearHistory();
    }

    /**
     * Copy raw bytes into RAM at org and set the PC to entry (org if
     * omitted). Clears the stop state and the execution history, which no
     * longer describes the program in memory.
     */
    public loadBinary(bytes: ArrayLike<number>, org: number, entry?: number): void {
        this.writeBytes(bytes, org);
        this.z80.regs.pc = (entry ?? org) & 0xFFFF;
        this.clearStopState();
        this.clearHistory();
    }

    /**
     * Load an assembled program: write each assembled line's bytes at its
     * address and set the PC to the assembly's entry point. Clears the stop
     * state and the execution history, which no longer describes the
     * program in memory. Throws if the assembly has errors.
     */
    public loadAssembly(result: AssemblyResult): void {
        if (result.hasErrors()) {
            throw new Error("cannot load an assembly that has errors");
        }

        for (const line of result.asm.assembledLines) {
            if (line.binary.length > 0) {
                this.writeBytes(line.binary, line.address);
            }
        }

        this.z80.regs.pc = result.entryPoint & 0xFFFF;
        this.clearStopState();
        this.clearHistory();
    }

    /**
     * Execute one instruction. Returns the resulting stop reason, or
     * undefined if the machine simply advanced and is still runnable.
     * Stepping while stopped for input retries the input; stepping a
     * terminated machine does nothing and returns the stop reason.
     */
    public step(): StopReason | undefined {
        const terminalStopReason = this.terminalStopReason();
        if (terminalStopReason !== undefined) {
            return terminalStopReason;
        }

        this.executeInstruction();
        // a single step ends after its instruction anyway
        this.pauseRequested = false;

        return this.stopReason;
    }

    /**
     * Ask the run in progress to stop after the instruction executing now,
     * with {@link StopReason.PAUSED}. Meant for a port or memory handler
     * whose host has to do something asynchronous before the program goes
     * on, such as loading what a port write needs. A breakpoint at the next
     * instruction wins, and a request made outside a run does nothing.
     */
    public pause(): void {
        this.pauseRequested = true;
    }

    /**
     * Run until a breakpoint, halt, input wait, pause, or budget exhaustion.
     */
    public run(options?: RunOptions): RunResult {
        return this.runUntil(options, undefined);
    }

    /**
     * Like step, but a CALL/RST (and its entire callee) counts as one
     * step: execution continues until control returns to the instruction
     * after the call. Breakpoints and budgets in the options still apply.
     *
     * Unlike step, this reports a {@link RunResult}, so a step that simply
     * completes leaves {@link Z80Machine.stopReason} set to
     * {@link StopReason.STEP_COMPLETE} rather than undefined.
     */
    public stepOver(options?: RunOptions): RunResult {
        const terminalStopReason = this.terminalStopReason();
        if (terminalStopReason !== undefined) {
            return {reason: terminalStopReason, tStates: 0, instructions: 0};
        }

        const address = this.z80.regs.pc;
        // Read the way the CPU will fetch it, so that code served by a memory
        // hook is classified as a call.
        const opcode = this.peek(address);
        let length: number;
        if (CALL_OPCODES.has(opcode)) {
            length = 3;
        } else if (RST_OPCODES.has(opcode)) {
            length = 1;
        } else {
            // Not a call, just step.
            return this.stepAsRunResult();
        }

        // Where we'll be when the call returns. Also check the stack pointer,
        // so that a recursive routine doesn't fool us into stopping early.
        const returnAddress = (address + length) & 0xFFFF;
        const stackPointer = this.z80.regs.sp;

        return this.runUntil(options,
            () => this.z80.regs.pc === returnAddress && this.z80.regs.sp >= stackPointer);
    }

    /**
     * Run until the current routine returns to its caller (the innermost
     * call-stack frame is popped). Breakpoints and budgets in the options
     * still apply. If there is no frame to return from, behaves like run.
     */
    public stepOut(options?: RunOptions): RunResult {
        const terminalStopReason = this.terminalStopReason();
        if (terminalStopReason !== undefined) {
            return {reason: terminalStopReason, tStates: 0, instructions: 0};
        }

        const frames = reconstructCallStack(this);
        if (frames.length === 0) {
            // Nothing to return from.
            return this.run(options);
        }

        // We're out when the return address has been popped off the stack.
        const stackAddress = frames[0].stackAddress;

        return this.runUntil(options, () => this.z80.regs.sp > stackAddress);
    }

    /**
     * Whether the machine is permanently stopped: halted with interrupts
     * disabled, or returned from the top-level routine.
     */
    public isTerminated(): boolean {
        return this.terminalStopReason() !== undefined;
    }

    /**
     * Raise a maskable interrupt. Wakes the CPU if it is waiting for one
     * (and clears the stop state so it can run). Does nothing at all if the
     * CPU has interrupts disabled.
     */
    public raiseInterrupt(): void {
        this.deliverInterrupt(true);
    }

    /**
     * Raise a non-maskable interrupt. Wakes the CPU if it is halted (and
     * clears the stop state so it can run).
     */
    public raiseNmi(): void {
        this.deliverInterrupt(false);
    }

    /**
     * Deliver an interrupt to the CPU. Entering an interrupt pushes a return
     * address, which is a change to RAM like any other, so it goes into the
     * execution history and can be undone.
     */
    private deliverInterrupt(maskable: boolean): void {
        this.requireNoOpenPoke("deliver an interrupt");

        // The core ignores a maskable interrupt while interrupts are off, and
        // an interrupt that never happened must not become an undo step.
        const taken = !maskable || this.z80.regs.iff1 !== 0;
        const stateBefore = taken && this.historyCapacity > 0 ? this.z80.save() : undefined;
        const spBefore = this.z80.regs.sp;

        if (stateBefore !== undefined) {
            this.pendingRecord = {
                kind: "instruction",
                // Handed its identity by addRecord, if it gets that far.
                stepId: 0,
                address: stateBefore.regs.pc,
                interrupt: maskable ? "maskable" : "nmi",
                stateBefore: stateBefore,
                tStateCountBefore: this.tStateCount,
                memoryWrites: [],
                portWrites: [],
            };
        }

        try {
            if (maskable) {
                this.z80.maskableInterrupt();
            } else {
                this.z80.nonMaskableInterrupt();
            }
        } catch (e) {
            this.pendingRecord = undefined;
            throw e;
        }

        const record = this.pendingRecord;
        this.pendingRecord = undefined;
        if (record !== undefined) {
            this.addRecord(record);
        }

        this.markInterruptPush(spBefore);
        this.wakeUp();
    }

    /**
     * Stamp the stack slot that an interrupt just pushed, if it pushed one.
     *
     * The core records the interrupted instruction as the pusher, and when
     * that instruction is a conditional CALL that was not taken, the PC it
     * pushes is exactly the return address a taken call would have pushed,
     * so the call-stack walk would report a frame for a routine that was
     * never entered. Recording the pushed word itself instead makes the
     * walk's test (returnAddress === callSite + length) unsatisfiable, since
     * no instruction is zero bytes long.
     */
    private markInterruptPush(spBefore: number): void {
        const sp = this.z80.regs.sp;

        if (sp !== spBefore) {
            this.z80.pushInstructionAddress[sp] = this.peek(sp) | (this.peek(sp + 1) << 8);
        }
    }

    /**
     * Snapshot the whole machine (CPU registers, RAM, clock, stop state,
     * and the stack-slot provenance behind the call stack).
     */
    public save(): Z80MachineState {
        // Only the live part of the stack can ever be walked, so that's all
        // the provenance we keep.
        const state = new Z80MachineState(this.z80.save(), this.memory.slice(),
            this.tStateCount, this.stopReason, this.pendingInputPort,
            this.z80.pushInstructionAddress.slice(this.stackBottom(), this.stackTopOffset()));
        state.stackRegionTop = this.stackRegionTop;
        return state;
    }

    /**
     * Restore a snapshot taken with save. The execution history is
     * cleared, since it no longer describes how the machine got here.
     */
    public restore(state: Z80MachineState): void {
        this.z80.restore(state.z80State);
        this.stackRegionTop = state.stackRegionTop ?? this.stackTop;
        // Copy into our buffer, the embedder may be holding on to it.
        this.memory.set(state.memory.subarray(0, this.memory.length));
        this.tStateCount = state.tStateCount;
        this.stopReason = state.stopReason;
        this.pendingInputPort = state.pendingInputPort;

        // The stack pointer is back to what it was when we saved, so this
        // lands the provenance on exactly the slots it came from. Clamp it,
        // since a hand-built state can carry any length.
        const stackProvenance = state.stackProvenance;
        const stackBottom = this.stackBottom();
        const count = Math.min(stackProvenance?.length ?? 0,
            this.z80.pushInstructionAddress.length - stackBottom);
        if (count > 0) {
            this.z80.pushInstructionAddress.set(stackProvenance.subarray(0, count), stackBottom);
        }

        this.clearHistory();
    }

    /**
     * Set one CPU register to a value, on behalf of the host: the person
     * debugging, or a tool acting for them.
     *
     * The name is the core's own spelling, a field of its RegisterSet: the
     * pairs `af`, `bc`, `de`, `hl`, `ix`, `iy`, `sp` and `pc`, the shadow
     * pairs `afPrime`, `bcPrime`, `dePrime` and `hlPrime` (with the "Prime"
     * suffix, never an apostrophe), the halves `a`, `f`, `b`, `c`, `d`, `e`,
     * `h`, `l`, `ixh`, `ixl`, `iyh` and `iyl`, and the internal registers
     * `i`, `r`, `memptr`, `iff1`, `iff2`, `im` and `halted`. Throws on any
     * other name.
     *
     * The value is clamped to what the register can hold, a word for a pair
     * and a byte for everything else, so that the machine is never left in a
     * state a real Z80 could not be in.
     *
     * Outside a poke transaction this writes the register directly and
     * records nothing, which is what setting up a test's initial state
     * wants. Inside one, between {@link Z80Machine.beginPoke} and
     * {@link Z80Machine.endPoke}, the write is journaled into the poke.
     * Either way, writing the value the register already holds does nothing
     * at all.
     */
    public setRegisterValue(name: Register, value: number): void {
        if (!isRegisterSetField(name)) {
            throw new Error("unknown register \"" + name + "\" (the shadow registers are " +
                "spelled afPrime, bcPrime, dePrime and hlPrime)");
        }

        const regs = this.z80.regs;
        const masked = WORD_REGISTERS.has(name) ? value & 0xFFFF : value & 0xFF;
        const old = regs.getValue(name);
        if (old === masked) {
            // Nothing changed, so there is nothing to journal.
            return;
        }

        const journal = this.pokeJournal;
        if (journal !== undefined && journal.registerEntries.get(name) === undefined) {
            journal.registerEntries.set(name, {
                name: name,
                old: old,
                order: journal.nextOrder++,
            });
        }

        regs[name] = masked;
    }

    /**
     * Write bytes into RAM on behalf of the host, wrapping at the top of the
     * address space. Like {@link Z80Machine.setRegisterValue}, this is the
     * host writing, not the CPU: the onMemoryWrite hook is not called, so a
     * memory-mapped device is the embedder's to refresh.
     *
     * Outside a poke transaction the bytes are written directly and nothing
     * is recorded. Inside one each byte is journaled under its address, with
     * the value it held before the poke: writing an address a second time
     * keeps that first value, so a range written and then written back is no
     * change at all, and a range written twice is one entry of the record,
     * not two overlapping ones.
     */
    public writeMemoryBytes(address: number, bytes: ArrayLike<number>): void {
        const journal = this.pokeJournal;
        if (journal === undefined) {
            this.writeBytes(bytes, address);
            return;
        }

        const start = address & 0xFFFF;

        for (let i = 0; i < bytes.length; i++) {
            const at = (start + i) & 0xFFFF;
            const before = this.memory[at];
            const value = bytes[i] & 0xFF;

            if (journal.memoryEntries.get(at) === undefined) {
                // The first time this poke touches the address, and so the
                // value the record will report as the old one. An unchanged
                // byte is journaled too, so that the record shows the whole
                // range the host wrote and not only the bytes that moved.
                journal.memoryEntries.set(at, {old: before, order: journal.nextOrder++});
            }

            if (before === value) {
                continue;
            }
            journal.memoryWrites.push({address: at, before: before, value: value});
            this.memory[at] = value;
        }
    }

    /**
     * Begin a poke: a transaction in which the host setters
     * ({@link Z80Machine.setRegisterValue} and
     * {@link Z80Machine.writeMemoryBytes}) journal what they write, so that
     * {@link Z80Machine.endPoke} can record all of it as one entry of the
     * execution history, undone like any other entry.
     *
     * Throws if a poke is already open, or if an instruction is executing
     * (from inside a memory or port hook, say): a poke is something the host
     * does between two instructions.
     */
    public beginPoke(): void {
        if (this.pokeJournal !== undefined) {
            throw new Error("a poke is already open; call endPoke() before beginning another");
        }
        if (this.executing || this.pendingRecord !== undefined) {
            throw new Error("cannot begin a poke while an instruction is executing");
        }

        this.pokeJournal = {
            stateBefore: this.z80.save(),
            tStateCountBefore: this.tStateCount,
            memoryWrites: [],
            registerEntries: new Map<Register, RegisterJournalEntry>(),
            memoryEntries: new Map<number, MemoryJournalEntry>(),
            nextOrder: 0,
        };
    }

    /**
     * End the open poke, recording everything written inside it as a single
     * execution record of kind "poke", at its place in the same history the
     * instructions use and taking one of its slots. Returns whether a record
     * was added: false if the poke changed nothing in the end (including a
     * register or a range of RAM written and then written back to what it
     * held before the poke), and false when history is disabled, since then
     * there is nothing to add it to.
     *
     * The record's writes hold one entry per register the poke changed and
     * one per run of consecutive addresses it changed, each with the value
     * from before the poke and the one the machine is left with, however
     * many calls wrote them: the same address written twice is one entry,
     * never two.
     *
     * The record is a step of its own, with an identity of its own: its
     * {@link ExecutionRecord.stepId} is a number no other record has, and
     * its {@link ExecutionRecord.address} is
     * {@link POKE_RECORD_ADDRESS}, never the address of the instruction
     * that is about to run, so nothing that keys steps by either can take a
     * poke for an instruction. The PC the poke was made at is in the
     * record's stateBefore.
     *
     * A poke doesn't touch the clock, the stop reason or the pending input
     * port, and undoing one leaves them alone too.
     *
     * Throws if no poke is open.
     */
    public endPoke(): boolean {
        const journal = this.pokeJournal;
        if (journal === undefined) {
            throw new Error("no poke is open; call beginPoke() first");
        }
        this.pokeJournal = undefined;

        // What the machine ended up with, which is only now known: a value
        // may have been written more than once inside the transaction. Each
        // register and each byte is compared against the value it held
        // before the poke, so anything written back to where it started
        // drops out here, and the entries come out in the order the host
        // first wrote them.
        const ordered: {order: number; write: PokeWrite}[] = [];

        for (const entry of journal.registerEntries.values()) {
            const now = this.z80.regs.getValue(entry.name);
            if (now !== entry.old) {
                ordered.push({
                    order: entry.order,
                    write: {type: "register", name: entry.name, old: entry.old, new: now},
                });
            }
        }

        // The journaled bytes, gathered back into runs of consecutive
        // addresses however many calls wrote them. A run that ends up
        // holding what it held before the poke is dropped whole; one that
        // moved is reported whole, unchanged bytes included.
        const addresses = Array.from(journal.memoryEntries.keys()).sort((a, b) => a - b);
        for (let i = 0; i < addresses.length; ) {
            const start = addresses[i];
            const old: number[] = [];
            const now: number[] = [];
            let order = Number.MAX_SAFE_INTEGER;
            let changed = false;
            let end = i;

            while (end < addresses.length && addresses[end] === start + (end - i)) {
                const entry = journal.memoryEntries.get(addresses[end]) as MemoryJournalEntry;
                const value = this.memory[addresses[end]];
                old.push(entry.old);
                now.push(value);
                order = Math.min(order, entry.order);
                changed = changed || value !== entry.old;
                end++;
            }
            i = end;

            if (changed) {
                ordered.push({
                    order: order,
                    write: {type: "memory", address: start, old: old, new: now},
                });
            }
        }

        ordered.sort((a, b) => a.order - b.order);
        const writes = ordered.map(entry => entry.write);

        if (writes.length === 0) {
            return false;
        }

        this.addRecord({
            kind: "poke",
            // Handed its identity by addRecord.
            stepId: 0,
            // A poke ran no instruction, so it reports no instruction
            // address: this one is negative, which no address can be, and
            // in particular is not the address of the instruction about to
            // run, which is where the next instruction record will sit. The
            // PC the poke was made at is in stateBefore.
            address: POKE_RECORD_ADDRESS,
            stateBefore: journal.stateBefore,
            tStateCountBefore: journal.tStateCountBefore,
            memoryWrites: journal.memoryWrites,
            portWrites: [],
            writes: writes,
        });

        return this.historyCapacity > 0;
    }

    /**
     * Whether there is a record to undo, an instruction or a poke alike.
     * Always false unless the historySize option enabled history.
     */
    public canUndo(): boolean {
        return this.historyCount > 0;
    }

    /**
     * Undo the most recent record, whether it is an instruction, an
     * interrupt being delivered, or a poke: restore the CPU state and clock,
     * and reverse its RAM writes. Port writes are not undone. Returns false
     * if there was nothing to undo.
     *
     * Undoing an instruction clears the stop state, since the machine is
     * back before whatever stopped it. Undoing a poke does not: a poke set
     * no stop reason, so the machine stays stopped for the reason it already
     * was, waiting on the same input port.
     */
    public undo(): boolean {
        this.requireNoOpenPoke("undo");

        const record = this.removeNewestRecord();
        if (record === undefined) {
            return false;
        }

        this.z80.restore(record.stateBefore);
        this.tStateCount = record.tStateCountBefore;
        if (record.stackTopBefore !== undefined) this.stackRegionTop = record.stackTopBefore;

        // Reverse the writes in the opposite order, in case the instruction
        // wrote to the same address twice.
        const memoryWrites = record.memoryWrites;
        for (let i = memoryWrites.length - 1; i >= 0; i--) {
            const memoryWrite = memoryWrites[i];
            this.memory[memoryWrite.address] = memoryWrite.before;
        }

        if (record.kind !== "poke") {
            this.clearStopState();
        }

        return true;
    }

    /**
     * The most recent execution records, oldest first, up to max (or all
     * retained records if max is omitted). Instructions, interrupts and
     * pokes all appear, each telling which it is through its
     * {@link ExecutionRecord.kind} and identified by its
     * {@link ExecutionRecord.stepId}. Only an instruction or an interrupt
     * carries an instruction address; a poke's address is
     * {@link POKE_RECORD_ADDRESS}.
     */
    public getHistory(max?: number): ExecutionRecord[] {
        const capacity = this.historyBuffer.length;
        const count = max === undefined ? this.historyCount : Math.min(Math.max(0, max), this.historyCount);
        const records: ExecutionRecord[] = [];

        for (let i = this.historyCount - count; i < this.historyCount; i++) {
            const record = this.historyBuffer[(this.historyStart + i) % capacity];
            if (record !== undefined) {
                records.push(record);
            }
        }

        return records;
    }

    /**
     * Read a byte the way the debugger does: through
     * {@link Z80MachineConfig.onDebugRead} if there is one, otherwise
     * {@link Z80MachineConfig.onMemoryRead}, falling back to RAM. This is
     * not a fetch by the CPU: it costs no t-states and, unless the embedder
     * supplies a hook that has side effects, doesn't disturb the machine.
     */
    public peek(address: number): number {
        address &= 0xFFFF;

        if (this.onDebugRead !== undefined) {
            const value = this.onDebugRead(address);
            if (value !== undefined) {
                return value & 0xFF;
            }
        }

        return this.memory[address];
    }

    /**
     * Reconstruct the call stack from the machine's stack memory,
     * innermost frame first. See {@link CallStackFrame}.
     */
    public getCallStack(): CallStackFrame[] {
        return reconstructCallStack(this);
    }

    /**
     * Disassemble the single instruction at the given address, reading
     * bytes with {@link Z80Machine.peek}.
     */
    public disassembleAt(address: number): Instruction {
        return disassembleInstructionAt(a => this.peek(a), address & 0xFFFF);
    }

    /**
     * Run instructions until something stops us: a stop reason from the
     * instruction itself, the optional isDone predicate (which reports
     * {@link StopReason.STEP_COMPLETE}), a breakpoint, or a budget.
     */
    private runUntil(options: RunOptions | undefined, isDone: (() => boolean) | undefined): RunResult {
        const terminalStopReason = this.terminalStopReason();
        if (terminalStopReason !== undefined) {
            return {reason: terminalStopReason, tStates: 0, instructions: 0};
        }

        const maxTStates = options?.maxTStates;
        const maxInstructions = options?.maxInstructions;
        const breakpoints = makeBreakpointMap(options?.breakpoints);
        const startTStateCount = this.tStateCount;
        let instructions = 0;
        this.pauseRequested = false;

        while (true) {
            // Check the budgets before executing, so that a budget of zero
            // executes nothing.
            let tStates = this.tStateCount - startTStateCount;
            if (maxInstructions !== undefined && instructions >= maxInstructions) {
                return this.stopRun(StopReason.INSTRUCTIONS_EXHAUSTED, tStates, instructions);
            }
            if (maxTStates !== undefined && tStates >= maxTStates) {
                return this.stopRun(StopReason.T_STATES_EXHAUSTED, tStates, instructions);
            }

            this.executeInstruction();
            tStates = this.tStateCount - startTStateCount;

            const stopReason = this.stopReason;
            if (stopReason === StopReason.WAITING_FOR_INPUT) {
                // The instruction was rolled back, so it didn't execute.
                return {reason: stopReason, tStates, instructions};
            }
            instructions += 1;
            if (stopReason !== undefined) {
                return {reason: stopReason, tStates, instructions};
            }
            if (isDone !== undefined && isDone()) {
                return this.stopRun(StopReason.STEP_COMPLETE, tStates, instructions);
            }
            // Stop before executing the instruction at the breakpoint. Since
            // we check after having executed an instruction, resuming from a
            // breakpoint always makes progress.
            if (breakpoints !== undefined && breakpoints[this.z80.regs.pc] !== 0) {
                return this.stopRun(StopReason.BREAKPOINT, tStates, instructions);
            }
            if (this.pauseRequested) {
                this.pauseRequested = false;
                return this.stopRun(StopReason.PAUSED, tStates, instructions);
            }
        }
    }

    /**
     * Execute a single instruction and package the result the way
     * {@link run} does.
     */
    private stepAsRunResult(): RunResult {
        const startTStateCount = this.tStateCount;

        this.executeInstruction();

        const stopReason = this.stopReason;
        // A rolled-back instruction didn't execute.
        const instructions = stopReason === StopReason.WAITING_FOR_INPUT ? 0 : 1;

        return this.stopRun(stopReason ?? StopReason.STEP_COMPLETE,
            this.tStateCount - startTStateCount, instructions);
    }

    /**
     * Record why a run stopped and make its result.
     */
    private stopRun(reason: StopReason, tStates: number, instructions: number): RunResult {
        this.stopReason = reason;
        return {reason, tStates, instructions};
    }

    /**
     * Execute one instruction, updating the clock, the stop reason, and the
     * execution history. An instruction that can't get its input is rolled
     * back and leaves the machine waiting for input.
     */
    private executeInstruction(): void {
        this.requireNoOpenPoke("execute an instruction");

        // We're about to make a new attempt, so forget the old outcome.
        this.clearStopState();

        // We need the CPU state to undo the instruction, and to roll it back
        // if its input isn't available.
        const keepHistory = this.historyCapacity > 0;
        const stateBefore = keepHistory || this.onPortRead !== undefined ? this.z80.save() : undefined;
        const spBefore = this.z80.regs.sp;
        const tStateCountBefore = this.tStateCount;

        if (keepHistory && stateBefore !== undefined) {
            this.pendingRecord = {
                kind: "instruction",
                // Handed its identity by addRecord; an instruction rolled
                // back for want of input never gets one.
                stepId: 0,
                // Replaced after the step with what the CPU actually fetched.
                address: this.z80.regs.pc,
                stateBefore: stateBefore,
                tStateCountBefore: tStateCountBefore,
                stackTopBefore: this.stackRegionTop,
                memoryWrites: [],
                portWrites: [],
            };
        }

        // Detect a top-level return before executing it, since the
        // instruction is what moves the stack pointer.
        const checkReturn = this.exitOnReturn &&
            this.z80.regs.sp === this.stackTop &&
            this.isReturnInstruction(this.z80.regs.pc);

        this.executing = true;
        try {
            this.z80.step();
            const sp = this.z80.regs.sp;
            if (Math.abs(sp - spBefore) > 4096 || sp > this.stackRegionTop) this.stackRegionTop = sp;
        } catch (e) {
            this.pendingRecord = undefined;
            if (e instanceof InputPendingError && stateBefore !== undefined) {
                // Roll the instruction back. Every instruction that reads a
                // port does so before writing to memory, so there's nothing
                // else to undo.
                this.z80.restore(stateBefore);
                this.tStateCount = tStateCountBefore;
                this.stopReason = StopReason.WAITING_FOR_INPUT;
                this.pendingInputPort = e.port;
                return;
            }
            throw e;
        } finally {
            this.executing = false;
        }

        const record = this.pendingRecord;
        if (record !== undefined) {
            record.address = this.z80.instructionAddress;
            this.pendingRecord = undefined;
            this.addRecord(record);
        }

        if (this.z80.regs.halted !== 0) {
            this.stopReason = this.z80.regs.iff1 !== 0
                ? StopReason.WAITING_FOR_INTERRUPT
                : StopReason.HALTED;
        } else if (checkReturn && this.z80.regs.sp === ((this.stackTop + 2) & 0xFFFF)) {
            this.stopReason = StopReason.RETURNED;
        }
    }

    /**
     * Lowest address of the live stack: where the stack pointer is, clamped
     * to the address space.
     */
    private stackBottom(): number {
        return Math.min(Math.max(this.z80.regs.sp, 0), MEMORY_SIZE);
    }

    /**
     * One past the highest address of the live stack, clamped to the address
     * space and never below {@link Z80Machine.stackBottom}.
     */
    private stackTopOffset(): number {
        return Math.max(Math.min(this.stackTop, MEMORY_SIZE), this.stackBottom());
    }

    /**
     * Whether the instruction at this address is one of the RET family.
     * Reads through {@link Z80Machine.peek} rather than RAM, so that an
     * instruction served by a memory hook is classified the same way the
     * CPU is about to execute it. Only reached when the exitOnReturn option
     * is on and the stack pointer is at the stack top, so it costs almost
     * nothing.
     */
    private isReturnInstruction(address: number): boolean {
        const opcode = this.peek(address);

        if (opcode === ED_PREFIX) {
            return ED_RET_OPCODES.has(this.peek(address + 1));
        }

        return RET_OPCODES.has(opcode);
    }

    /**
     * Wake the CPU up after an interrupt was delivered, if it was asleep.
     */
    private wakeUp(): void {
        if (this.z80.regs.halted === 0 &&
            (this.stopReason === StopReason.WAITING_FOR_INTERRUPT ||
                this.stopReason === StopReason.HALTED)) {

            this.clearStopState();
        }
    }

    /**
     * The stop reason if the machine can't be resumed, otherwise undefined.
     */
    private terminalStopReason(): StopReason | undefined {
        const stopReason = this.stopReason;

        return stopReason !== undefined && isTerminalStopReason(stopReason) ? stopReason : undefined;
    }

    /**
     * Refuse to do something that the machine can't do while a poke is open,
     * which is anything that would add to or take from the history.
     */
    private requireNoOpenPoke(what: string): void {
        if (this.pokeJournal !== undefined) {
            throw new Error("cannot " + what + " while a poke is open; call endPoke() first");
        }
    }

    /**
     * Make the machine runnable again.
     */
    private clearStopState(): void {
        this.stopReason = undefined;
        this.pendingInputPort = undefined;
    }

    /**
     * Copy bytes into RAM, bypassing the memory hooks and the history journal.
     */
    private writeBytes(bytes: ArrayLike<number>, address: number): void {
        for (let i = 0; i < bytes.length; i++) {
            this.memory[(address + i) & 0xFFFF] = bytes[i] & 0xFF;
        }
    }

    /**
     * Add a record to the history ring buffer, dropping the oldest one if
     * the buffer is full. Does nothing if history is disabled.
     */
    private addRecord(record: ExecutionRecord): void {
        if (this.historyCapacity === 0) {
            return;
        }
        let capacity = this.historyBuffer.length;
        if (this.historyCount === capacity && capacity < this.historyCapacity) {
            const grown = new Array<ExecutionRecord | undefined>(
                Math.min(this.historyCapacity, capacity === 0 ? 64 : capacity * 2));
            for (let i = 0; i < this.historyCount; i++) {
                grown[i] = this.historyBuffer[(this.historyStart + i) % capacity];
            }
            this.historyBuffer = grown;
            this.historyStart = 0;
            capacity = grown.length;
        }

        record.stepId = this.nextStepId++;
        this.historyBuffer[(this.historyStart + this.historyCount) % capacity] = record;
        if (this.historyCount < capacity) {
            this.historyCount += 1;
        } else {
            this.historyStart = (this.historyStart + 1) % capacity;
        }
    }

    /**
     * Remove and return the most recent record, or undefined if there is none.
     */
    private removeNewestRecord(): ExecutionRecord | undefined {
        const capacity = this.historyBuffer.length;
        if (this.historyCount === 0 || capacity === 0) {
            return undefined;
        }

        const index = (this.historyStart + this.historyCount - 1) % capacity;
        const record = this.historyBuffer[index];
        this.historyBuffer[index] = undefined;
        this.historyCount -= 1;

        return record;
    }

    /**
     * Forget the execution history.
     */
    private clearHistory(): void {
        this.historyBuffer = [];
        this.historyStart = 0;
        this.historyCount = 0;
        this.pendingRecord = undefined;
        // A reset or a load happening in the middle of a poke leaves nothing
        // for that poke to be recorded against.
        this.pokeJournal = undefined;
    }
}
