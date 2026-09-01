/**
 * Size of the machine's address space, and therefore of its RAM.
 */
export const MEMORY_SIZE = 64*1024;

/**
 * Stack pointer a machine starts with when its configuration doesn't say.
 */
export const DEFAULT_INITIAL_SP = 0xFFFF;

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
