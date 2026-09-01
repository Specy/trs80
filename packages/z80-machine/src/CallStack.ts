import {Disasm, Instruction} from "z80-disasm";
import {MEMORY_SIZE} from "./Constants.js";
import type {Z80Machine} from "./Z80Machine.js";

/**
 * One reconstructed call-stack frame: a return address on the stack that
 * was pushed by a CALL or RST instruction.
 */
export interface CallStackFrame {
    /**
     * Address of the CALL or RST instruction that created this frame.
     */
    callSiteAddress: number;

    /**
     * Address the call jumped to (the routine being executed).
     */
    targetAddress: number;

    /**
     * The return address that the call pushed.
     */
    returnAddress: number;

    /**
     * Where on the stack the return address sits.
     */
    stackAddress: number;
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

// Whether this opcode is a CALL, with or without a condition. The condition
// is in bits 3 to 5.
function isCallOpcode(opcode: number): boolean {
    return opcode === 0xCD || (opcode & 0b11000111) === 0b11000100;
}

// Whether this opcode is an RST.
function isRstOpcode(opcode: number): boolean {
    return (opcode & 0b11000111) === 0b11000111;
}

// Whether this opcode could begin a call frame at all. One byte test, used
// to reject the great majority of stack slots without disassembling.
function isCallOrRstOpcode(opcode: number): boolean {
    return isCallOpcode(opcode) || isRstOpcode(opcode);
}

// Where the CALL or RST at this address transfers control to, and how many
// bytes the instruction takes, or undefined if there's no such instruction
// there.
function getCall(readMemory: (address: number) => number,
                 address: number): { targetAddress: number, length: number } | undefined {

    const opcode = readMemory(address) & 0xFF;
    if (!isCallOrRstOpcode(opcode)) {
        // Quick rejection, so that scanning a deep stack doesn't have to
        // disassemble an instruction for every byte.
        return undefined;
    }

    const instruction = disassembleInstructionAt(readMemory, address);

    switch (instruction.mnemonic) {
        case "call":
            return instruction.jumpTarget === undefined
                ? undefined
                : {
                    targetAddress: instruction.jumpTarget,
                    length: instruction.bin.length,
                };

        case "rst":
            // The disassembler doesn't set a jump target for RST. The target
            // is in bits 3 to 5 of the opcode.
            return {
                targetAddress: opcode & 0x38,
                length: instruction.bin.length,
            };

        default:
            return undefined;
    }
}

/**
 * Reconstruct the call stack of a machine by walking its stack memory
 * from the current SP up to the machine's stack top. The core records,
 * for every stack slot, the address of the instruction that pushed it;
 * slots whose pushing instruction disassembles as a CALL or RST are call
 * frames, and everything else (PUSH, interrupts' pushes with unknown
 * provenance, data) is skipped. Frames are returned innermost first.
 *
 * Instructions are read with {@link Z80Machine.peek}, so a program whose
 * code is served by a memory hook is walked correctly.
 *
 * Programs that manipulate the stack by hand degrade this gracefully:
 * frames may be missed, but nothing here throws on a mangled stack.
 */
export function reconstructCallStack(machine: Z80Machine): CallStackFrame[] {
    const frames: CallStackFrame[] = [];

    // Read the way the debugger does, which by default is the way the CPU
    // fetched these bytes.
    const readMemory = (address: number): number => machine.peek(address);
    const pushInstructionAddress = machine.z80.pushInstructionAddress;

    // Disassembling is expensive, and a deep stack asks about the same few
    // call sites over and over. Memory doesn't change while we walk, so one
    // cache per walk is both correct and never stale.
    const callCache = new Map<number, { targetAddress: number, length: number } | undefined>();

    // The stack grows down, so the innermost frame is nearest SP and walking
    // up toward the stack top gives us the frames innermost first. A frame
    // needs both of its bytes to be below the stack top.
    const stackTop = Math.min(machine.stackTop, MEMORY_SIZE);
    let stackAddress = machine.z80.regs.sp & 0xFFFF;

    while (stackAddress + 2 <= stackTop) {
        // The core records the pushing instruction at the address of the low
        // byte of the pushed word, which is where SP ends up.
        const callSiteAddress = pushInstructionAddress[stackAddress];

        // Reject on the opcode byte first, so that slots that can't be frames
        // stay off the cache entirely, then disassemble at most once per
        // distinct call site.
        let call: { targetAddress: number, length: number } | undefined = undefined;
        if (isCallOrRstOpcode(readMemory(callSiteAddress))) {
            call = callCache.get(callSiteAddress);
            if (call === undefined && !callCache.has(callSiteAddress)) {
                call = getCall(readMemory, callSiteAddress);
                callCache.set(callSiteAddress, call);
            }
        }

        const returnAddress = readMemory(stackAddress) | (readMemory(stackAddress + 1) << 8);

        // Require that the call pushed its own return address. Otherwise
        // we've landed in the middle of a word, or on a slot whose recorded
        // instruction is stale, or on an interrupt's push (whose recorded
        // instruction is the one it interrupted, not a call).
        if (call !== undefined && returnAddress === ((callSiteAddress + call.length) & 0xFFFF)) {
            frames.push({
                callSiteAddress,
                targetAddress: call.targetAddress,
                returnAddress,
                stackAddress,
            });
            stackAddress += 2;
        } else {
            // Data, a PUSH, or garbage. Advance a byte at a time so that we
            // resynchronize with frames even if the stack isn't word-aligned.
            stackAddress += 1;
        }
    }

    return frames;
}
