import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Read-only live images from the actual agent browser. No visitor can send
// keyboard/mouse input or choose a URL for the agent to visit.
export class LiveSessions {
  constructor(directory) {
    this.directory=join(directory,'live');mkdirSync(this.directory,{recursive:true,mode:0o700});
    this.events=new EventEmitter();this.events.setMaxListeners(200);this.states=new Map();
  }
  get(id) {
    if(this.states.has(id))return this.states.get(id);
    const file=join(this.directory,`${id}.json`);
    return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{phase:null,status:'waiting',stage:'Waiting for everyone’s payment.',sequence:0};
  }
  update(id,patch) {
    const previous=this.get(id),at=new Date().toISOString();
    const state={...previous,...patch,updatedAt:at};
    if(patch.stage&&patch.stage!==previous.stage)state.trace=[...(previous.trace||[]),{at,stage:patch.stage,phase:state.phase}].slice(-250);
    this.states.set(id,state);
    const file=join(this.directory,`${id}.json`);writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(file+'.tmp',file);
    this.events.emit(id,state);return state;
  }
  start(id,phase){return this.update(id,{phase,status:'running',stage:phase==='final'?'Opening a fresh browser to complete the booking.':'Checking the listing and filling booking details.'})}
  frame(id,phase,{image,stage}) {
    const file=join(this.directory,`${id}-${phase}.jpg`);const bytes=Buffer.isBuffer(image)?image:Buffer.from(image,'base64');
    if(bytes.length>3*1024*1024)return;
    writeFileSync(file+'.tmp',bytes,{mode:0o600});renameSync(file+'.tmp',file);
    return this.update(id,{phase,stage,status:'running',sequence:this.get(id).sequence+1});
  }
  image(id){const state=this.get(id);const file=join(this.directory,`${id}-${state.phase}.jpg`);return existsSync(file)?file:null}
  finish(id,status,stage){return this.update(id,{status,stage})}
}
