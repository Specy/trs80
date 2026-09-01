import {Z80State} from "z80-emulator";
import type {Z80Machine} from "./Z80Machine.js";

/**
 * Why execution stopped. Most of these leave the machine resumable: only
 * HALTED and RETURNED mean the program is over, which is what
 * {@link Z80Machine.isTerminated} reports. Stopping at a breakpoint, at the
 * end of a budget, for input, or at the end of a step is an interruption,
 * not an ending.
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
     * A stepOver or stepOut reached its destination.
     */
    STEP_COMPLETE,
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
 * One instruction's worth of execution history.
 */
export interface ExecutionRecord {
    /**
     * Address of the instruction that was executed, or, for an interrupt
     * entry, the address that was interrupted.
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
     * Port writes performed by the instruction, in order.
     */
    portWrites: PortWrite[];
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
     * disassembly, call-stack reconstruction, and the instruction
     * classification behind stepOver and the exitOnReturn option. Return
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
     * as the stack top for call-stack reconstruction and the exitOnReturn
     * option. Defaults to 0xFFFF.
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
}

/**
 * Budgets and breakpoints for a call to {@link Z80Machine.run} (also
 * honored by stepOver and stepOut).
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
     * instruction at a breakpoint address. If the PC is already at a
     * breakpoint when the run starts, at least one instruction executes
     * first, so that resuming from a breakpoint makes progress.
     */
    breakpoints?: Iterable<number>;
}

/**
 * What happened during a call to {@link Z80Machine.run}, stepOver, or
 * stepOut.
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
 * the stack-slot provenance that the call stack is reconstructed from. The
 * core's Z80State covers registers only; this covers the whole machine.
 */
export class Z80MachineState {
    public readonly z80State: Z80State;
    public readonly memory: Uint8Array;
    public readonly tStateCount: number;
    public readonly stopReason: StopReason | undefined;
    public readonly pendingInputPort: number | undefined;

    /**
     * Which instruction pushed each byte of the live stack, from the stack
     * pointer up to the machine's stack top. The CPU keeps this alongside
     * its registers and the core's Z80State doesn't cover it, so without it
     * a restored machine would reconstruct its call stack from whatever it
     * happened to push most recently.
     */
    public readonly stackProvenance: Uint16Array;

    constructor(z80State: Z80State, memory: Uint8Array, tStateCount: number,
                stopReason: StopReason | undefined, pendingInputPort: number | undefined,
                stackProvenance: Uint16Array) {

        this.z80State = z80State;
        this.memory = memory;
        this.tStateCount = tStateCount;
        this.stopReason = stopReason;
        this.pendingInputPort = pendingInputPort;
        this.stackProvenance = stackProvenance;
    }
}
