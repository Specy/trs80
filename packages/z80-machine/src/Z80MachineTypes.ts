import {Z80State} from "z80-emulator";
import {Register} from "z80-base";
import type {CallStackFrame} from "./CallStack.js";
import type {Z80Machine} from "./Z80Machine.js";

/**
 * Why execution stopped. Most of these leave the machine resumable: only
 * HALTED and RETURNED mean the program is over, which is what
 * {@link Z80Machine.isTerminated} reports. Stopping at a breakpoint, at the
 * end of a budget, for input, or at a call depth is an interruption, not an
 * ending.
 */
export enum StopReason {
    /**
     * Execution reached an address in the breakpoint set.
     */
    BREAKPOINT,

    /**
     * The CPU executed HALT with interrupts disabled. Only a non-maskable
     * interrupt can wake it; the program is considered terminated.
     */
    HALTED,

    /**
     * The CPU executed HALT with interrupts enabled. A call to
     * {@link Z80Machine.raiseInterrupt} or {@link Z80Machine.raiseNmi}
     * will wake it.
     */
    WAITING_FOR_INTERRUPT,

    /**
     * A port read had no data available: the onPortRead handler returned
     * undefined. The instruction was rolled back and will re-execute
     * (calling onPortRead again) when execution resumes. The port is in
     * {@link Z80Machine.pendingInputPort}.
     */
    WAITING_FOR_INPUT,

    /**
     * The run's maxTStates budget was exhausted.
     */
    T_STATES_EXHAUSTED,

    /**
     * The run's maxInstructions budget was exhausted.
     */
    INSTRUCTIONS_EXHAUSTED,

    /**
     * A RET-family instruction executed with SP at the initial stack
     * pointer, meaning the top-level routine returned. Only reported when
     * the exitOnReturn option is enabled. The program is considered
     * terminated.
     */
    RETURNED,

    /**
     * The Call stack was at the depth the run's
     * {@link RunOptions.untilCallDepth} asked for, or less, so the run
     * stopped before executing the next instruction. This is how a debugger
     * finishes a Step over (the depth it started at) or a Step out (one
     * less).
     */
    CALL_DEPTH,

    /**
     * A handler called {@link Z80Machine.pause} during the instruction that
     * just executed, and the run stopped after it. The machine is runnable:
     * the next run carries on from the following instruction.
     */
    PAUSED,
}

/**
 * Whether a stop reason means that the program can't be resumed. The other
 * reasons all leave the machine runnable, so this is the test to make before
 * reporting a program as finished.
 */
export function isTerminalStopReason(stopReason: StopReason): boolean {
    return stopReason === StopReason.HALTED || stopReason === StopReason.RETURNED;
}

/**
 * A single memory write, as recorded in the execution history.
 */
export interface MemoryWrite {
    address: number;
    /**
     * Value in RAM before the write.
     */
    before: number;
    /**
     * Value written.
     */
    value: number;
}

/**
 * A single port write, as recorded in the execution history. Port writes
 * are recorded for display but are never undone: they already reached the
 * outside world.
 */
export interface PortWrite {
    port: number;
    value: number;
}

/**
 * The {@link ExecutionRecord.address} of a poke record. No instruction can
 * have it: an address is a 16-bit number, and this one is negative. A poke
 * runs no instruction, so it has no instruction address to report; the PC
 * the machine was stopped at when the poke was made is in the record's
 * {@link ExecutionRecord.stateBefore}, as `stateBefore.regs.pc`.
 */
export const POKE_RECORD_ADDRESS = -1;

/**
 * What an execution record describes: the CPU running an instruction (or
 * taking an interrupt), or a poke, a register or memory value changed by
 * the host between two instructions through
 * {@link Z80Machine.beginPoke}/{@link Z80Machine.endPoke}.
 */
export type ExecutionRecordKind = "instruction" | "poke";

/**
 * One register changed by a poke. The name is the machine's own spelling,
 * a field of the core's RegisterSet: the shadow registers are `afPrime`,
 * `bcPrime`, `dePrime` and `hlPrime`, never an apostrophe.
 */
export interface RegisterPokeWrite {
    type: "register";

    /**
     * Which register was written, as {@link Z80Machine.setRegisterValue}
     * names it.
     */
    name: Register;

    /**
     * Value the register held when the poke first wrote it.
     */
    old: number;

    /**
     * Value the register holds at the end of the poke.
     */
    new: number;
}

/**
 * One run of consecutive memory addresses changed by a poke, however many
 * calls to {@link Z80Machine.writeMemoryBytes} wrote them: the poke journals
 * every address it touches, and {@link Z80Machine.endPoke} gathers the
 * journaled addresses back into runs, so two calls writing neighbouring
 * bytes are one entry and a range written twice is one entry, never two
 * overlapping ones. Both arrays cover the whole run, including bytes the
 * poke left at the value they already held.
 */
export interface MemoryPokeWrite {
    type: "memory";

    /**
     * Address of the first byte of the run.
     */
    address: number;

    /**
     * Bytes the run held before the poke, never a value that existed only
     * inside it: writing an address twice keeps the first byte found there.
     */
    old: number[];

    /**
     * Bytes the run holds at the end of the poke.
     */
    new: number[];
}

/**
 * One value changed by a poke, with what it was and what it became.
 */
export type PokeWrite = RegisterPokeWrite | MemoryPokeWrite;

/**
 * One entry of the execution history: an instruction the CPU executed, an
 * interrupt it took, or a poke the host made.
 */
export interface ExecutionRecord {
    /** Stack extent before this instruction; restored by Undo. */
    stackTopBefore?: number;
    /**
     * Whether this entry is an instruction (or an interrupt) or a poke.
     * Always set, so a reader never has to guess.
     */
    kind: ExecutionRecordKind;

    /**
     * This entry's identity: a number handed out when the entry entered the
     * history, increasing in the order the entries were made and never
     * reused for the life of the machine, a reset or a load included. Two
     * entries never share one, whatever their kind, so a journal that hangs
     * effects on the machine's steps can key them by this and never see a
     * poke where it expects an instruction. Records start at 1; a record
     * that never entered the history (because history is disabled) has 0.
     */
    stepId: number;

    /**
     * Address of the instruction that was executed, or, for an interrupt
     * entry, the address that was interrupted. A poke has
     * {@link POKE_RECORD_ADDRESS} here, which is no instruction's address:
     * no instruction ran, and the PC the poke was made at is in
     * {@link ExecutionRecord.stateBefore} as `stateBefore.regs.pc`.
     */
    address: number;

    /**
     * Set when this record is an interrupt being delivered rather than an
     * instruction being executed. Its memoryWrites are the return address
     * that the CPU pushed.
     */
    interrupt?: "maskable" | "nmi";

    /**
     * CPU state just before the instruction executed.
     */
    stateBefore: Z80State;

    /**
     * Clock count just before the instruction executed.
     */
    tStateCountBefore: number;

    /**
     * RAM writes performed by the instruction, in order.
     */
    memoryWrites: MemoryWrite[];

    /**
     * Port writes performed by the instruction, in order. Always empty on a
     * poke entry: a poke writes no ports.
     */
    portWrites: PortWrite[];

    /**
     * What the poke changed, in the order it was written, with the old and
     * the new value of each. Present exactly on entries whose kind is
     * "poke"; see {@link isPokeRecord}.
     */
    writes?: PokeWrite[];
}

/**
 * An execution record made by a poke, which always carries its
 * {@link ExecutionRecord.writes}.
 */
export interface PokeExecutionRecord extends ExecutionRecord {
    kind: "poke";
    address: typeof POKE_RECORD_ADDRESS;
    writes: PokeWrite[];
}

/**
 * Whether an execution record is a poke rather than an instruction or an
 * interrupt, narrowing it to one that has its writes.
 */
export function isPokeRecord(record: ExecutionRecord): record is PokeExecutionRecord {
    return record.kind === "poke";
}

/**
 * Configuration for a {@link Z80Machine}. All fields are optional; the
 * default machine is 64 kB of flat RAM with no devices attached: port
 * reads return 0xFF and port writes are ignored.
 */
export interface Z80MachineConfig {
    /**
     * The machine's RAM. Must be 64 kB; the constructor throws otherwise.
     * Defaults to a fresh zero-filled buffer. The machine reads and writes
     * this buffer directly.
     */
    memory?: Uint8Array;

    /**
     * Handle a port read (IN). Receives the full 16-bit address that the
     * CPU put on the bus; by Z80 convention the port number is the lower
     * byte, and the upper byte carries whatever was in the relevant
     * register. Return the byte read, or undefined to indicate that no
     * data is available yet: the machine will roll the instruction back
     * and stop with {@link StopReason.WAITING_FOR_INPUT}. The handler
     * will be called again for the same port when execution resumes.
     */
    onPortRead?: (port: number) => number | undefined;

    /**
     * Handle a port write (OUT). Receives the full 16-bit address; see
     * {@link Z80MachineConfig.onPortRead} for the convention.
     */
    onPortWrite?: (port: number, value: number) => void;

    /**
     * Intercept a memory read, for memory-mapped devices or a ROM or bank
     * overlay. Return the byte read, or undefined to fall through to RAM.
     * The debugger's own reads go through this too, so that code served by
     * the hook is disassembled and classified the way the CPU will execute
     * it; see {@link Z80MachineConfig.onDebugRead} if that is not what you
     * want.
     */
    onMemoryRead?: (address: number) => number | undefined;

    /**
     * Read a byte on behalf of the debugger rather than the CPU:
     * disassembly, and the instruction classification behind the Call stack
     * (which instruction pushed a return address), the repeating block
     * instructions and the exitOnReturn option. Return
     * the byte read, or undefined to fall through to RAM. Defaults to
     * {@link Z80MachineConfig.onMemoryRead}. Supply a side-effect-free
     * variant here, or `() => undefined` to read RAM only, if reads through
     * that hook have side effects.
     */
    onDebugRead?: (address: number) => number | undefined;

    /**
     * Intercept a memory write, for memory-mapped devices or ROM. Return
     * true if the write was handled (RAM is left untouched); return false
     * or nothing to fall through to RAM.
     */
    onMemoryWrite?: (address: number, value: number) => boolean | void;

    /**
     * Initial stack pointer, applied on construction and reset, and used
     * as the stack top for the exitOnReturn option. Defaults to 0xFFFF.
     */
    initialSp?: number;

    /**
     * When true, a RET-family instruction executing with SP at the
     * initial stack pointer stops the machine with
     * {@link StopReason.RETURNED}. Useful when calling a routine rather
     * than running a whole program. Defaults to false.
     */
    exitOnReturn?: boolean;

    /**
     * Number of execution records to keep for {@link Z80Machine.undo} and
     * {@link Z80Machine.getHistory}, as a ring buffer. Defaults to 0,
     * which disables history entirely and costs nothing at run time.
     */
    historySize?: number;

    /**
     * How many frames the Call stack keeps: the newest ones. The depth
     * ({@link Z80Machine.getCallDepth}) goes on counting the frames beyond
     * it, and {@link Z80Machine.undo} puts a frame dropped for it back.
     * Must be at least 1. Defaults to {@link CALL_STACK_LIMIT}.
     */
    callStackLimit?: number;
}

/**
 * Budgets, breakpoints and the call depth to stop at, for a call to
 * {@link Z80Machine.run}.
 */
export interface RunOptions {
    /**
     * Stop after the machine's clock count has advanced by this many
     * t-states.
     */
    maxTStates?: number;

    /**
     * Stop after this many instructions have executed.
     */
    maxInstructions?: number;

    /**
     * Addresses to stop at. Execution stops just before executing the
     * instruction at a breakpoint address. A breakpoint at the PC the run
     * starts on is passed over unless
     * {@link RunOptions.skipBreakpointAtPc} is false.
     */
    breakpoints?: Iterable<number>;

    /**
     * Stop with {@link StopReason.CALL_DEPTH}, before executing anything
     * more, as soon as the Call stack's depth
     * ({@link Z80Machine.getCallDepth}) is this number or less. It is tested
     * when the run begins, so a run entered at that depth already executes
     * nothing, and after every instruction, ahead of the breakpoints, the
     * pause and the budgets: a depth reached by the last instruction a
     * budget allows is reported as CALL_DEPTH. A stop the instruction itself
     * caused (HALTED, RETURNED, WAITING_FOR_INTERRUPT) is reported instead.
     *
     * The option holds no state, so a step stopped early, by a budget, a
     * breakpoint or an input wait, is finished by running again with the
     * same number.
     */
    untilCallDepth?: number | undefined;

    /**
     * Whether a breakpoint at the PC the run starts on is passed over, so
     * that resuming from a breakpoint makes progress. Defaults to true. When
     * false, such a breakpoint stops the run with
     * {@link StopReason.BREAKPOINT} before anything executes.
     */
    skipBreakpointAtPc?: boolean | undefined;
}

/**
 * What happened during a call to {@link Z80Machine.run}.
 */
export interface RunResult {
    reason: StopReason;

    /**
     * T-states consumed during this call.
     */
    tStates: number;

    /**
     * Instructions executed during this call.
     */
    instructions: number;
}

/**
 * Complete snapshot of a machine: CPU state, RAM, clock, stop state, and
 * the Call stack. The core's Z80State covers registers only; this covers
 * the whole machine.
 */
export class Z80MachineState {
    public stackRegionTop?: number;
    public readonly z80State: Z80State;
    public readonly memory: Uint8Array;
    public readonly tStateCount: number;
    public readonly stopReason: StopReason | undefined;
    public readonly pendingInputPort: number | undefined;

    /**
     * The frames of the Call stack, innermost first, as
     * {@link Z80Machine.getCallStack} returns them. The machine tracks them
     * as the program runs, and they can't be told from stack memory, so a
     * restored machine needs them.
     */
    public readonly callStack: readonly CallStackFrame[];

    /**
     * The Call stack's depth, which is more than the number of frames when
     * frames beyond the machine's limit were dropped.
     */
    public readonly callDepth: number;

    constructor(z80State: Z80State, memory: Uint8Array, tStateCount: number,
                stopReason: StopReason | undefined, pendingInputPort: number | undefined,
                callStack: readonly CallStackFrame[], callDepth: number = callStack.length) {

        this.z80State = z80State;
        this.memory = memory;
        this.tStateCount = tStateCount;
        this.stopReason = stopReason;
        this.pendingInputPort = pendingInputPort;
        this.callStack = callStack;
        this.callDepth = callDepth;
    }
}
