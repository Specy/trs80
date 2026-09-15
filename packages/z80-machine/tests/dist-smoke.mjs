// Smoke test for the published artifact: assembles and runs Z80 programs
// through dist/, so it covers what a consumer of @specy/z80 actually imports
// rather than the sources the spec files exercise.
//
// The spec files run against src/, where z80-base, z80-inst, z80-asm,
// z80-disasm and z80-emulator are resolved as workspace packages. The
// published bundle gets them differently: vite compiles all five into
// dist/index.js and dist/index.umd.cjs, and vite-plugin-dts inlines their
// declarations into a single dist/index.d.ts that is then copied to
// dist/index.d.cts for the CommonJS build. None of that is exercised by the
// spec files - the bundle can break with every one of them still green -
// which is why this runs after `npm run build` rather than beside them.
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const ESM = new URL("../dist/index.js", import.meta.url);
if (!existsSync(fileURLToPath(ESM))) {
    console.error("dist/index.js is missing - run `npm run build` first.");
    process.exit(1);
}

const {assemble, isPokeRecord, POKE_RECORD_ADDRESS, StopReason, Z80Machine, toHexWord, mnemonicMap} =
    await import(ESM);

// ---------------------------------------------------------------------------
// Assembling and running
// ---------------------------------------------------------------------------

const ADD = `
        .org 0x8000
        ld a, 5
        add a, 37
        halt
`;

const result = assemble(ADD);
assert.equal(result.hasErrors(), false, "the program should assemble");

const machine = new Z80Machine();
machine.loadAssembly(result);

const runResult = machine.run();
assert.equal(runResult.reason, StopReason.HALTED, "the program runs to its halt");
assert.equal(machine.z80.regs.a, 42, "5 + 37, computed by the bundled emulator");
assert.equal(runResult.instructions, 3, "three instructions, counted by the run loop");
assert.equal(machine.isTerminated(), true);

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// The IO callbacks are how a host drives this machine - the editor's console
// is a port map - so a bundle whose emulator and assembler disagree about the
// address bus would show up here.
const writes = [];
const input = [];
const io = new Z80Machine({
    onPortRead: (address) => ((address & 0xFF) === 0x01 ? input.shift() : 0xFF),
    onPortWrite: (address, value) => writes.push([address & 0xFF, value]),
});
io.loadAssembly(assemble(`
        .org 0x8000
loop:   in a, (0x01)
        or a
        jr z, done
        out (0x02), a
        jr loop
done:   halt
`));

// An empty queue returns undefined, which means "no data yet": the machine
// rolls the instruction back and stops, resumable, with the port it wants.
assert.equal(io.run().reason, StopReason.WAITING_FOR_INPUT, "an empty port stops the run");
assert.equal(io.pendingInputPort & 0xFF, 0x01, "and says which port it is waiting on");

input.push(72, 105, 0);
assert.equal(io.run().reason, StopReason.HALTED, "resuming re-executes the `in` and runs on");
assert.deepEqual(writes, [[0x02, 72], [0x02, 105]], "both bytes reached the write callback");

// ---------------------------------------------------------------------------
// Pokes
// ---------------------------------------------------------------------------

// A host write journaled into the machine's own history as one undoable
// entry, which is how the editor lets a person change a register mid-debug.
const poked = new Z80Machine({historySize: 100});
poked.loadAssembly(assemble(ADD));
assert.equal(poked.step(), undefined, "one instruction, then the poke");

poked.beginPoke();
poked.setRegisterValue("a", 0x10);
poked.writeMemoryBytes(0x9000, [0xAB, 0xCD]);
assert.equal(poked.endPoke(), true, "the poke was recorded");

const pokeRecord = poked.getHistory().at(-1);
assert.equal(pokeRecord.kind, "poke", "and it is a poke, not an instruction");
assert.ok(isPokeRecord(pokeRecord), "which the type guard agrees with");
assert.deepEqual(pokeRecord.writes, [
    {type: "register", name: "a", old: 5, new: 0x10},
    {type: "memory", address: 0x9000, old: [0x00, 0x00], new: [0xAB, 0xCD]},
], "carrying what it changed, with the old and the new values");

// The entry is a step of its own: a step id no other entry has, and an
// address that is no instruction's, so nothing keyed on either takes the
// poke for the instruction that is about to run.
assert.equal(POKE_RECORD_ADDRESS, -1, "a poke's address is not one a Z80 could have");
assert.equal(pokeRecord.address, POKE_RECORD_ADDRESS, "the poke reports no instruction address");
assert.equal(pokeRecord.stateBefore.regs.pc, poked.z80.regs.pc, "the PC it was made at is in its state");
assert.equal(poked.step(), undefined, "and the instruction it was made before still runs");
const afterPoke = poked.getHistory();
assert.equal(afterPoke.at(-1).address, pokeRecord.stateBefore.regs.pc,
    "recorded at the address the poke was made at");
assert.notEqual(afterPoke.at(-1).address, pokeRecord.address, "which is not the poke's own");
assert.equal(new Set(afterPoke.map((record) => record.stepId)).size, afterPoke.length,
    "and every entry of the history has a step id of its own");
assert.equal(poked.undo(), true, "roll that instruction back off again");

// A range written and then written back inside one transaction is no change
// at all, and an address written twice is one entry, not two overlapping
// ones: the record is measured against what the machine held before the
// poke, never against a value that only existed inside it.
const history = poked.getHistory().length;
poked.beginPoke();
poked.writeMemoryBytes(0x9000, [0x11, 0x22]);
poked.writeMemoryBytes(0x9000, [0xAB, 0xCD]);
assert.equal(poked.endPoke(), false, "a poke written back to where it started records nothing");
assert.equal(poked.getHistory().length, history, "and adds no row to the history");

poked.beginPoke();
poked.writeMemoryBytes(0x9000, [0x11]);
poked.writeMemoryBytes(0x9000, [0x22]);
assert.equal(poked.endPoke(), true, "an address written twice is still one poke");
assert.deepEqual(poked.getHistory().at(-1).writes, [
    {type: "memory", address: 0x9000, old: [0xAB], new: [0x22]},
], "with one entry holding the byte from before the poke");
assert.equal(poked.undo(), true);
assert.equal(poked.memory[0x9000], 0xAB, "and undoing it puts that byte back");

assert.equal(poked.run().reason, StopReason.HALTED, "the program runs on from the poked state");
assert.equal(poked.z80.regs.a, 0x10 + 37, "using what was poked into it");

// Undo walks back over the instructions and then the poke itself.
while (poked.canUndo()) {
    poked.undo();
}
assert.equal(poked.z80.regs.a, 0, "every register is back");
assert.equal(poked.memory[0x9000], 0, "and so is the poked memory");

// ---------------------------------------------------------------------------
// The bundled packages
// ---------------------------------------------------------------------------

// index.ts re-exports the five z80-* packages so that a consumer needs only
// this one. They are compiled in rather than listed as dependencies, so a
// bundling mistake would leave these undefined at runtime with the machine
// above still working.
assert.equal(toHexWord(0x8000), "8000", "z80-base came along");
assert.ok(mnemonicMap.get("ld").length > 0, "so did the z80-inst instruction database");

// ---------------------------------------------------------------------------
// The CommonJS build and the declarations
// ---------------------------------------------------------------------------

// `require` of the UMD build: the "require" condition in package.json's
// exports, which nothing else here loads.
const cjs = createRequire(import.meta.url)("../dist/index.umd.cjs");
const cjsMachine = new cjs.Z80Machine();
cjsMachine.loadAssembly(cjs.assemble(ADD));
assert.equal(cjsMachine.run().reason, cjs.StopReason.HALTED, "the UMD build runs the same program");
assert.equal(cjsMachine.z80.regs.a, 42);

// TypeScript picks a declaration file by condition and then by extension, so
// the CommonJS entry needs its own .d.cts - written by the afterBuild hook in
// vite.config.ts, which is silent when it does not run.
const types = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url));
const cjsTypes = fileURLToPath(new URL("../dist/index.d.cts", import.meta.url));
assert.ok(existsSync(types), "dist/index.d.ts exists");
assert.ok(existsSync(cjsTypes), "dist/index.d.cts exists");

// The rolled-up declarations must not import from the z80-* packages: they
// are not published alongside this one, so such an import would resolve to
// nothing on a consumer's machine.
const declarations = readFileSync(types, "utf8");
const external = declarations.match(/^\s*(?:import|export)\s+.*\bfrom\s+['"](?!\.)[^'"]+['"]/gm) ?? [];
assert.deepEqual(external, [], "the declarations are self-contained");

console.log(`ok - ran a program to HALTED, drove ${writes.length} port writes, and loaded the UMD build`);
