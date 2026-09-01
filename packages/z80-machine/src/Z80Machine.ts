import {Hal, Z80} from "z80-emulator";
import {Instruction} from "z80-disasm";
import {toHexWord} from "z80-base";
import {AssemblyResult} from "./Assemble.js";
import {CallStackFrame, disassembleInstructionAt, reconstructCallStack} from "./CallStack.js";
import {DEFAULT_INITIAL_SP, DEFAULT_PORT_READ_VALUE, MEMORY_SIZE} from "./Constants.js";
import {
    ExecutionRecord,
    isTerminalStopReason,
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
     * allowed (it bypasses the onMemory hooks and history journal).
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

    // The configured hooks, or undefined if the embedder didn't supply them.
    private readonly onPortRead: ((port: number) => number | undefined) | undefined;
    private readonly onPortWrite: ((port: number, value: number) => void) | undefined;
    private readonly onMemoryRead: ((address: number) => number | undefined) | undefined;
    private readonly onDebugRead: ((address: number) => number | undefined) | undefined;
    private readonly onMemoryWrite: ((address: number, value: number) => boolean | void) | undefined;

    // Whether a top-level return stops the machine.
    private readonly exitOnReturn: boolean;

    // Ring buffer of execution records. Empty (zero length) if history is
    // disabled. The oldest record is at historyStart, and there are
    // historyCount records.
    private readonly historyBuffer: (ExecutionRecord | undefined)[];
    private historyStart = 0;
    private historyCount = 0;

    // Record being filled in by the instruction currently executing, or
    // undefined if history is disabled or no instruction is executing.
    private pendingRecord: ExecutionRecord | undefined = undefined;

    // Whether we're inside the CPU's step() method. Port reads can only be
    // rolled back (and therefore retried) from there.
    private executing = false;

    constructor(config?: Z80MachineConfig) {
        const memory = config?.memory;
        if (memory !== undefined && memory.length !== MEMORY_SIZE) {
            throw new Error("the machine's memory must be exactly 64 kB (" + MEMORY_SIZE +
                " bytes), but it is " + memory.length + " bytes");
        }

        this.z80 = new Z80(this);
        this.memory = memory ?? new Uint8Array(MEMORY_SIZE);
        this.stackTop = config?.initialSp ?? DEFAULT_INITIAL_SP;
        this.onPortRead = config?.onPortRead;
        this.onPortWrite = config?.onPortWrite;
        this.onMemoryRead = config?.onMemoryRead;
        this.onDebugRead = config?.onDebugRead ?? config?.onMemoryRead;
        this.onMemoryWrite = config?.onMemoryWrite;
        this.exitOnReturn = config?.exitOnReturn ?? false;
        this.historyBuffer = new Array<ExecutionRecord | undefined>(Math.max(0, config?.historySize ?? 0))
            .fill(undefined);
        this.z80.regs.sp = this.stackTop;
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

        return this.stopReason;
    }

    /**
     * Run until a breakpoint, halt, input wait, or budget exhaustion.
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
        // The core ignores a maskable interrupt while interrupts are off, and
        // an interrupt that never happened must not become an undo step.
        const taken = !maskable || this.z80.regs.iff1 !== 0;
        const stateBefore = taken && this.historyBuffer.length > 0 ? this.z80.save() : undefined;
        const spBefore = this.z80.regs.sp;

        if (stateBefore !== undefined) {
            this.pendingRecord = {
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
        return new Z80MachineState(this.z80.save(), this.memory.slice(),
            this.tStateCount, this.stopReason, this.pendingInputPort,
            this.z80.pushInstructionAddress.slice(this.stackBottom(), this.stackTopOffset()));
    }

    /**
     * Restore a snapshot taken with save. The execution history is
     * cleared, since it no longer describes how the machine got here.
     */
    public restore(state: Z80MachineState): void {
        this.z80.restore(state.z80State);
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
     * Whether there is an instruction to undo. Always false unless the
     * historySize option enabled history.
     */
    public canUndo(): boolean {
        return this.historyCount > 0;
    }

    /**
     * Undo the most recent record, which is an instruction or an interrupt
     * being delivered: restore the CPU state and clock, and reverse its RAM
     * writes. Port writes are not undone. Clears the stop state. Returns
     * false if there was nothing to undo.
     */
    public undo(): boolean {
        const record = this.removeNewestRecord();
        if (record === undefined) {
            return false;
        }

        this.z80.restore(record.stateBefore);
        this.tStateCount = record.tStateCountBefore;

        // Reverse the writes in the opposite order, in case the instruction
        // wrote to the same address twice.
        const memoryWrites = record.memoryWrites;
        for (let i = memoryWrites.length - 1; i >= 0; i--) {
            const memoryWrite = memoryWrites[i];
            this.memory[memoryWrite.address] = memoryWrite.before;
        }

        this.clearStopState();

        return true;
    }

    /**
     * The most recent execution records, oldest first, up to max (or all
     * retained records if max is omitted).
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
        // We're about to make a new attempt, so forget the old outcome.
        this.clearStopState();

        // We need the CPU state to undo the instruction, and to roll it back
        // if its input isn't available.
        const keepHistory = this.historyBuffer.length > 0;
        const stateBefore = keepHistory || this.onPortRead !== undefined ? this.z80.save() : undefined;
        const tStateCountBefore = this.tStateCount;

        if (keepHistory && stateBefore !== undefined) {
            this.pendingRecord = {
                // Replaced after the step with what the CPU actually fetched.
                address: this.z80.regs.pc,
                stateBefore: stateBefore,
                tStateCountBefore: tStateCountBefore,
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
        const capacity = this.historyBuffer.length;
        if (capacity === 0) {
            return;
        }

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
        this.historyBuffer.fill(undefined);
        this.historyStart = 0;
        this.historyCount = 0;
        this.pendingRecord = undefined;
    }
}
