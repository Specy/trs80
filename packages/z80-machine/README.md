# @specy/z80

A ready-to-use Z80 computer: 64 kB of RAM, IO through plain callbacks, a run
loop with breakpoints and budgets, execution history with undo, whole-machine
snapshots, call-stack reconstruction, and the assembler and disassembler
wired up to it.

## Assemble, load, run

```ts
import {assemble, StopReason, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld a, 5
        add a, 37
        halt
`);
if (result.hasErrors()) {
    console.log(result.diagnostics);
}

const machine = new Z80Machine();
machine.loadAssembly(result);

const runResult = machine.run();
console.log(StopReason[runResult.reason], machine.z80.regs.a, runResult.instructions);
// HALTED 42 3
```

`assemble()` takes a string, or a map of pathname to contents for a program
of several files. `loadAssembly()` writes the assembled bytes into RAM and
sets the PC to the entry point (the `end` directive's address, else the
lowest address that received code). `run()` returns a `RunResult` with the
`StopReason`, the t-states consumed, and the instructions executed; the
reason is also left in `machine.stopReason`.

The reasons are:

* `HALTED`: the CPU executed `halt` with interrupts disabled.
* `RETURNED`: the top-level routine returned. Only with `exitOnReturn`.
* `WAITING_FOR_INTERRUPT`: `halt` with interrupts enabled. `raiseInterrupt()`
  or `raiseNmi()` wakes it.
* `WAITING_FOR_INPUT`: a port read had no data yet. See below.
* `BREAKPOINT`: execution reached an address in the breakpoint set, and
  stopped before executing it.
* `T_STATES_EXHAUSTED`, `INSTRUCTIONS_EXHAUSTED`: the run's budget ran out.
* `STEP_COMPLETE`: a `stepOver()` or `stepOut()` reached its destination.

Only the first two mean the program is over, which is what `isTerminated()`
reports. The rest leave the machine resumable: call `run()` again and it
picks up where it left off. A browser can give the machine one slice per
animation frame this way and stay responsive:

```ts
import {assemble, StopReason, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld bc, 0
loop:   dec bc
        ld a, b
        or c
        jr nz, loop
        halt
`);
const machine = new Z80Machine();
machine.loadAssembly(result);

let slices = 0;
while (!machine.isTerminated()) {
    machine.run({maxTStates: 30_000});
    slices += 1;
}

console.log(slices, machine.tStateCount, StopReason[machine.stopReason]);
// 57 1703945 HALTED
```

## Ports

`onPortRead` and `onPortWrite` receive the 16-bit address on the CPU's
address bus. The port number is in the lower byte, so mask the address with
`0xFF` to get it. The upper byte holds whatever register the Z80 put there:
A for `in a, (n)` and `out (n), a`, B for the `(c)` forms.

```ts
import {assemble, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld a, 0x2A
        out (0x10), a
        halt
`);

const machine = new Z80Machine({
    onPortWrite: (address, value) => console.log(address, address & 0xFF, value),
});
machine.loadAssembly(result);
machine.run();
// 10768 16 42
```

Here A held 0x2A when the `out` executed, so the address on the bus was
0x2A10, which prints as 10768. Masking it gives port 16.

### Waiting for input

Return `undefined` from `onPortRead` to mean "no data yet". The machine rolls
the instruction back and stops with `WAITING_FOR_INPUT`, leaving the port in
`machine.pendingInputPort`. Nothing blocks, so a program sitting on the
keyboard leaves the UI thread free. When the data arrives, call `run()`
again: the `in` re-executes and calls the handler again.

An array works as the input queue:

```ts
import {assemble, StopReason, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
loop:   in a, (0x01)
        or a
        jr z, done
        out (0x02), a
        jr loop
done:   halt
`);

const input = [];
const machine = new Z80Machine({
    onPortRead: address => (address & 0xFF) === 0x01 ? input.shift() : 0xFF,
    onPortWrite: (address, value) => console.log("out", address & 0xFF, value),
});
machine.loadAssembly(result);

console.log(StopReason[machine.run().reason], machine.pendingInputPort & 0xFF);
// WAITING_FOR_INPUT 1

input.push(72, 105, 0);
console.log(StopReason[machine.run().reason]);
// out 2 72
// out 2 105
// HALTED
```

`shift()` on an empty array returns `undefined`, the same value that signals
"nothing here yet", so the queue needs no extra code around it.

## Memory

`onMemoryRead` and `onMemoryWrite` cover memory-mapped devices, ROM, and bank
overlays. A read returns the byte, or `undefined` to fall through to RAM. A
write returns `true` if the device handled it (RAM is left untouched), or
nothing to fall through to RAM.

The debugger reads memory too: disassembly, call-stack reconstruction, and
the instruction classification behind `stepOver()` all go through
`onMemoryRead` by default, so that code served by a hook is decoded the way
the CPU will execute it. When a read has side effects, give `onDebugRead` a
side-effect-free variant, or `() => undefined` to read RAM only:

```ts
import {assemble, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld a, 42
        ld (0x4000), a      ; write to the device
        ld a, (0x4001)      ; read from the device
        ld b, a
        ld a, (0x4001)
        halt
`);

let reads = 0;
const machine = new Z80Machine({
    onMemoryRead: address => address === 0x4001 ? ++reads : undefined,
    onDebugRead: () => undefined,
    onMemoryWrite: (address, value) => {
        if (address === 0x4000) {
            console.log("device <-", value);
            return true;                    // handled; RAM untouched
        }
    },
});
machine.loadAssembly(result);
machine.run();
// device <- 42

console.log(machine.z80.regs.b, machine.z80.regs.a, reads);
// 1 2 2
console.log(machine.peek(0x4001), machine.memory[0x4000], reads);
// 0 0 2
```

`peek()` is the debugger's read: it goes through `onDebugRead` and costs no
t-states, so here it reads RAM and leaves the device's counter alone.
`machine.memory` is the RAM itself, and reading or writing it directly
bypasses the hooks and the history journal.

## Debugging

`run()` takes breakpoints and budgets. `SourceMap` joins a machine to an
assembly, so breakpoints can be set by line and the current address named:

```ts
import {assemble, SourceMap, StopReason, toHexWord, Z80Machine} from "@specy/z80";

const source = `
        .org 0x8000
        ld b, 3
        call double
        halt
double: sla b
        ret
`;
const result = assemble(source);
const machine = new Z80Machine();
machine.loadAssembly(result);

const sourceMap = new SourceMap(result);
machine.run({breakpoints: [sourceMap.locationToAddress(5)]});

console.log(StopReason[machine.stopReason], toHexWord(machine.z80.regs.pc));
// BREAKPOINT 8006
console.log(machine.disassembleAt(machine.z80.regs.pc).toText(false));
// sla b
console.log(sourceMap.addressToLocation(machine.z80.regs.pc).lineNumber);
// 5
console.log(sourceMap.namedCallStack(machine).map(frame => frame.name));
// [ 'double' ]
console.log(sourceMap.symbolAt(machine.z80.regs.pc).originalSpelling);
// double
```

Line numbers are zero-based, and `locationToAddress()` takes an optional
pathname for programs of several files. `symbolAt()` returns the nearest
symbol at or below an address: the label the address belongs to.
`getCallStack()` reconstructs the call stack from stack memory and the CPU's
record of which instruction pushed each slot; `namedCallStack()` is the same
stack with each frame named after the symbol at its call target.

`step()` runs one instruction. `stepOver()` runs a `call` or `rst` and its
whole callee. `stepOut()` runs until the current routine returns. `save()`
and `restore()` snapshot and restore the whole machine: registers, RAM,
clock, stop state, and the stack provenance the call stack is rebuilt from.

```ts
import {assemble, StopReason, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld b, 3
        call double
        halt
double: sla b
        ret
`);
const machine = new Z80Machine();
machine.loadAssembly(result);

machine.step();                                  // ld b, 3
const snapshot = machine.save();

console.log(StopReason[machine.stepOver().reason], machine.z80.regs.b);
// STEP_COMPLETE 6
machine.restore(snapshot);
console.log(machine.z80.regs.b);
// 3

machine.step();                                  // into double
console.log(machine.getCallStack().length);
// 1
console.log(StopReason[machine.stepOut().reason], machine.z80.regs.b);
// STEP_COMPLETE 6
```

The `historySize` option turns on the execution journal, a ring buffer of
that many instructions. `getHistory()` reads it back, and `undo()` walks it
backwards, restoring the CPU state and reversing each instruction's RAM
writes. History is off by default, and costs nothing while off.

```ts
import {assemble, toHexWord, Z80Machine} from "@specy/z80";

const result = assemble(`
        .org 0x8000
        ld hl, 0x9000
        ld (hl), 7
        inc hl
        halt
`);
const machine = new Z80Machine({historySize: 1000});
machine.loadAssembly(result);
machine.run();

for (const record of machine.getHistory()) {
    const writes = record.memoryWrites.map(write =>
        toHexWord(write.address) + " <- " + write.value);
    console.log(toHexWord(record.address),
        machine.disassembleAt(record.address).toText(false), ...writes);
}
// 8000 ld hl,0x9000
// 8003 ld (hl),0x07 9000 <- 7
// 8005 inc hl
// 8006 halt

while (machine.canUndo()) {
    machine.undo();
}
console.log(toHexWord(machine.z80.regs.pc), machine.memory[0x9000]);
// 8000 0
```

Port writes are recorded in the journal for display. `undo()` leaves them
alone, since they have already reached the outside world.

## Calling a routine

`loadBinary()` loads raw bytes at an address, and `exitOnReturn` stops the
machine when a `ret` executes with the stack pointer back at the top, which
suits calling a single routine and reading its result:

```ts
import {StopReason, Z80Machine} from "@specy/z80";

// ld a, b / add a, c / ret
const machine = new Z80Machine({exitOnReturn: true});
machine.loadBinary([0x78, 0x81, 0xC9], 0x8000);
machine.z80.regs.b = 20;
machine.z80.regs.c = 22;

const runResult = machine.run();
console.log(StopReason[runResult.reason], machine.z80.regs.a, machine.isTerminated());
// RETURNED 42 true
```

`loadBinary()` takes an optional third argument if execution should start
somewhere other than the load address.

## Editor tooling

`check()` assembles and returns just the diagnostics, for squiggles. The
re-exported packages carry the rest of what an editor wants:
`mnemonicMap` maps a mnemonic to its variants, each with a description,
affected flags, byte count, and clock counts (two of them, for instructions
that branch); `getAsmInstructionTrie()` is the assembler's own parse trie,
for completion; `getAsmDirectiveDocs()` documents the directives; and
`AsmTokenizer` tokenizes a line, for highlighting.

```ts
import {AsmTokenizer, check, getAsmDirectiveDocs, getAsmInstructionTrie, mnemonicMap} from "@specy/z80";

const [diagnostic] = check("        ld a, 5\n        jp nowhere\n");
console.log(diagnostic.pathname, diagnostic.lineNumber, diagnostic.message);
// main.asm 1 unknown identifier "nowhere"

const [djnz] = mnemonicMap.get("djnz");
console.log(djnz.clr.flags, djnz.clr.byte_count,
    djnz.clr.with_jump_clock_count, djnz.clr.without_jump_clock_count);
// ------ 2 13 8
console.log(mnemonicMap.get("cpl")[0].clr.description);
// The contents of A are inverted (one's complement).

console.log(new AsmTokenizer("loop:   djnz loop  ; again").tokens.map(token => token.tag).join(" "));
// identifier symbol identifier identifier comment
console.log(getAsmInstructionTrie().tokens.size, getAsmDirectiveDocs().length);
// 78 21
```

For a whole assembly, `AssemblyResult.asm` is the assembler itself: the
per-line listing with addresses and bytes, the symbol table with definitions
and references, and the file tree.

## In a browser

The build is bundled and self-contained. `z80-base`, `z80-inst`,
`z80-emulator`, `z80-asm` and `z80-disasm` are compiled in, and the rolled-up
declarations have no external imports, so nothing else has to be present.

As an ES module:
```ts
import {assemble, StopReason, Z80Machine} from "@specy/z80";
```

Or as a UMD bundle from a script tag, which puts everything on a global named
`Z80Machine`:

```html
<script src="https://unpkg.com/@specy/z80/dist/index.umd.cjs"></script>
<script>
const {assemble, StopReason, Z80Machine: Machine} = Z80Machine;

const machine = new Machine();
machine.loadAssembly(assemble("        ld a, 5\n        halt\n"));
console.log(StopReason[machine.run().reason], machine.z80.regs.a);
// HALTED 5
</script>
```

# License

Copyright &copy; Lawrence Kesteloot and Specy, [MIT license](LICENSE).
