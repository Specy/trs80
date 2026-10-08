import assert from 'node:assert/strict';
import {assemble} from './Assemble.js';
import {Z80Machine} from './Z80Machine.js';

const assembly = assemble(` org $4000
start: ld sp,$8000
 push hl
 halt
bytes: db 1,2,3
 align 4
words: dw 7
room: ds 16
filled: ds 8,$aa
 end start`);
assert.equal(assembly.hasErrors(), false, JSON.stringify(assembly.diagnostics));
const lines = assembly.asm.assembledLines;
assert.equal(lines.find(line => line.line.startsWith('start:'))?.kind, 'code');
assert.equal(lines.find(line => line.line.startsWith('bytes:'))?.kind, 'data');
assert.equal(lines.find(line => line.line.startsWith('room:'))?.kind, 'reserved');
assert.equal(lines.find(line => line.line.startsWith('filled:'))?.kind, 'reserved');
assert.equal(lines[0].kind, undefined);
const machine = new Z80Machine({historySize: 100});
machine.loadAssembly(assembly);
const initial = machine.getStackTop();
machine.step();
assert.equal(machine.getStackTop(), 0x8000);
machine.step();
assert.equal(machine.getStackTop(), 0x8000);
machine.undo();
assert.equal(machine.getStackTop(), 0x8000);
machine.undo();
assert.equal(machine.getStackTop(), initial);
machine.step();
const saved = machine.save();
machine.reset();
machine.restore(saved);
assert.equal(machine.getStackTop(), 0x8000);
console.log('memory emission kinds and stack extent Undo passed');
