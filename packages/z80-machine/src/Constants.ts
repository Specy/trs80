/**
 * Size of the machine's address space, and therefore of its RAM.
 */
export const MEMORY_SIZE = 64*1024;

/**
 * Stack pointer a machine starts with when its configuration doesn't say.
 */
export const DEFAULT_INITIAL_SP = 0xFFFF;

/**
 * How many frames the Call stack keeps by default: the newest ones. The
 * depth goes on counting past it. Real programs never call this deep; the
 * limit is a guard against a call used as a jump in a loop, which adds a
 * frame on every pass while the stack pointer wraps round memory.
 */
export const CALL_STACK_LIMIT = 131_072;

/**
 * How far above a frame's slot the stack pointer can be for the frame to be
 * gone from the Call stack, counted with 16-bit wraparound. A stack pointer
 * further above it than this has been switched to another stack, such as
 * one a program borrows to fill memory with pushes, and the frame stays.
 */
export const STACK_SWITCH_DISTANCE = 4096;

/**
 * Byte an IN reads when nothing is on the bus.
 */
export const DEFAULT_PORT_READ_VALUE = 0xFF;

/**
 * Pathname of the entry file when the source is given as a plain string, and
 * the preferred entry file when a map of several files contains it.
 */
export const DEFAULT_ENTRY_PATHNAME = "main.asm";

/**
 * Deepest chain of includes we'll follow. The assembler splices an included
 * file's lines into the listing it is walking, so nesting has a real cost
 * and runaway expansion has to be stopped somewhere.
 */
export const MAX_INCLUDE_DEPTH = 32;
