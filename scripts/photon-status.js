#!/usr/bin/env node
import 'dotenv/config';
import {cloud} from 'spectrum-ts';
import {createClient} from '@photon-ai/advanced-imessage/grpc';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fingerprint,messageDebug} from '../app/debug.js';
// Read-only diagnostics. Never sends messages, changes line settings or logs
// recipient addresses, text bodies, credentials, or payment links.
const db=new DatabaseSync(join(process.env.DATA_DIR||'data','bookings.sqlite'),{readOnly:true});
const chats=db.prepare('SELECT id FROM conversations').all().map(row=>row.id);db.close();
const auth=await cloud.issueImessageTokens(process.env.SPECTRUM_PROJECT_ID,process.env.SPECTRUM_PROJECT_SECRET);
if(auth.type!=='dedicated')throw Error('This diagnostic currently requires the dedicated Photon line used by the demo.');
let failed=false;
for(const [id,token]of Object.entries(auth.auth)){
 const client=createClient({address:`${id}.imsg.photon.codes:443`,token,tls:true,retry:false});
 try{for(const chat of chats){
  const page=await client.messages.listInChat(chat,{pageSize:20});
  const outgoing=page.messages.filter(m=>m.isFromMe);
  const latest=outgoing[0];
  const records=outgoing.map(m=>({messageId:fingerprint(m.guid),at:m.dateCreated,sent:m.isSent,delivered:m.isDelivered,sendErrorCode:m.sendErrorCode,legacyWarning:messageDebug(m.content).legacyWarning}));
  console.log(JSON.stringify({chat:fingerprint(chat),latestSend:latest?{sent:latest.isSent,sendErrorCode:latest.sendErrorCode}:null,recentOutgoing:records},null,2));
  if(latest?.sendErrorCode){failed=true;console.error(`Photon's iMessage line rejected its latest reply: Apple send error ${latest.sendErrorCode}. Reconnecting the local listener does not repair that remote send failure.`);}
 }}finally{await client.close();}
}
if(failed)process.exitCode=1;
