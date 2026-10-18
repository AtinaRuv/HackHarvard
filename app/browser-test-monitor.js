import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {LiveSessions} from './live.js';

// The CLI owns a separate test database. The normal server only reads a
// snapshot and live frame files; it never runs test payments through Photon.
export function browserTestMonitor(root){
  try{
    const {runId}=JSON.parse(readFileSync(join(root,'active.json'),'utf8'));
    if(!/^[a-f0-9-]{36}$/.test(runId))return null;
    const directory=join(root,runId),db=new DatabaseSync(join(directory,'bookings.sqlite'),{readOnly:true});
    let bookings;try{bookings=db.prepare('SELECT body FROM bookings').all().map(row=>JSON.parse(row.body))}finally{db.close()}
    if(!bookings.length)return null;
    return{bookings,live:new LiveSessions(directory),secret:process.env.TOKEN_SIGNING_SECRET||readFileSync(join(directory,'signing.key'),'utf8')};
  }catch{return null}
}
