import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LiveSessions} from '../app/live.js';
test('browser status log records stage changes once and survives reloads',t=>{
  const directory=mkdtempSync(join(tmpdir(),'leash-trace-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const live=new LiveSessions(directory);live.start('booking','final');
  for(let i=0;i<3;i++)live.frame('booking','final',{image:Buffer.from('frame'),stage:'Checking the final total.'});
  live.finish('booking','completed','Booking complete.');
  const state=new LiveSessions(directory).get('booking');
  assert.equal(state.trace.length,3);assert.equal(state.trace[1].stage,'Checking the final total.');assert.equal(state.trace[2].stage,'Booking complete.');
  assert.ok(state.trace.every(entry=>entry.phase==='final'&&Number.isFinite(Date.parse(entry.at))));
  assert.equal(new LiveSessions(directory).get('another-booking').trace,undefined);
});
