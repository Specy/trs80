import {Disasm, Instruction} from "z80-disasm";
// For the documentation's links.
import type {Z80Machine} from "./Z80Machine.js";

/**
 * What entered a call-stack frame: a `call` that was taken or an `rst`
 * ("call"), or the CPU taking a maskable or non-maskable interrupt
 * ("interrupt").
 */
export type CallStackFrameKind = "call" | "interrupt";

/**
 * One frame of the machine's Call stack: a return address that a call, an
 * `rst` or an interrupt entry pushed, and the routine it entered. The machine
 * tracks frames as the program runs; see {@link Z80Machine.getCallStack} for
 * when a frame is pushed and when it is gone.
 */
export interface CallStackFrame {
    /**
     * Address of the CALL or RST instruction that created this frame. For an
     * interrupt, the address of the instruction it interrupted: the one that
     * runs when the handler returns, or the `halt` it woke the CPU from.
     */
    callSiteAddress: number;

    /**
     * Address the call jumped to (the routine being executed). For an
     * interrupt, the start of its handler.
     */
    targetAddress: number;

    /**
     * The return address that was pushed. The routine may change it on the
     * stack afterwards; this is what it was when it was pushed.
     */
    returnAddress: number;

    /**
     * Where on the stack the return address sits: the stack pointer right
     * after the push, two below the stack pointer the call was made with.
     */
    stackAddress: number;

    /**
     * Whether a call or an interrupt entered the routine.
     */
    kind: CallStackFrameKind;
}

// Disassembler used for one-off instruction disassembly. It reads memory
// through the caller's function, so it holds no state we care about, but it
// allocates a few 64 kB arrays, so make only one and reuse it.
let traceDisasm: Disasm | undefined = undefined;

/**
 * Disassemble the single instruction at the given address, reading bytes
 * through the given memory reader.
 */
export function disassembleInstructionAt(readMemory: (address: number) => number,
                                         address: number): Instruction {

    if (traceDisasm === undefined) {
        traceDisasm = new Disasm();
    }

    return traceDisasm.disassembleTrace(address & 0xFFFF, a => readMemory(a & 0xFFFF));
}

/**
 * Most DD and FD prefix bytes {@link callInstructionLength} looks past. The
 * CPU takes any number, each one starting the decode over, but a program
 * has no reason to put more than one in front of a call.
 */
const MAX_PREFIX_BYTES = 16;

/**
 * The length in bytes of the CALL (taken or not, unconditional or not) or
 * RST instruction at this address, or 0 if the instruction there is neither.
 * DD and FD prefixes in front of it count: `DD CD nn nn` executes as a call
 * four bytes long.
 */
export function callInstructionLength(readMemory: (address: number) => number,
                                      address: number): number {

    let prefixes = 0;
    let opcode = readMemory(address & 0xFFFF);
    while ((opcode === 0xDD || opcode === 0xFD) && prefixes < MAX_PREFIX_BYTES) {
        prefixes += 1;
        opcode = readMemory((address + prefixes) & 0xFFFF);
    }

    // CALL nn, and CALL cc,nn with the condition in bits 3 to 5.
    if (opcode === 0xCD || (opcode & 0b11000111) === 0b11000100) {
        return prefixes + 3;
    }

    // RST n, with the target in bits 3 to 5.
    if ((opcode & 0b11000111) === 0b11000111) {
        return prefixes + 1;
    }

    return 0;
}
