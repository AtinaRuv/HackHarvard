import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.js';
import {createChatHandler} from '../app/messenger.js';
import {acquireAgentLock,activeAgent} from '../app/process-lock.js';

function fixture(t,status='COLLECTING'){
 const dir=mkdtempSync(join(tmpdir(),'leash-message-'));const store=new Store(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 const pipeline={store,baseUrl:'https://example.com',questions:()=>[{field:'email',type:'email',scope:'private',contact:'organizer'}],answer:()=>{throw Error('Provide a valid email address.')},advance:async()=>{}};
 const handler=createChatHandler(pipeline);
 store.save({id:'booking',status,access:'private',participants:[],outbox:[],events:[]});
 store.db.prepare('INSERT INTO conversations VALUES (?,?)').run('group',JSON.stringify({organizer:'organizer',bookingId:'booking',seen:[]}));
 const replies=[];const space={id:'group',type:'group',send:async text=>{replies.push(text)}};
 const message=(id,text='status',sender='organizer')=>({id,sender:{id:sender},content:{type:'text',text}});
 return{pipeline,handler,replies,space,message};
}
test('replayed concurrent status events produce one reply, including after restart',async t=>{
 const{pipeline,handler,replies,space,message}=fixture(t);
 await Promise.all([handler(space,message('same')),handler(space,message('same')),handler(space,message('same'))]);
 assert.equal(replies.length,1);
 await createChatHandler(pipeline)(space,message('same'));assert.equal(replies.length,1);
 await handler(space,message('different'));assert.equal(replies.length,2);
});
test('casual group messages during collection do not trigger payment-status spam',async t=>{
 const{handler,replies,space,message}=fixture(t);
 await handler(space,message('hello','Yoooo'));await handler(space,message('chat','sounds good'));
 assert.equal(replies.length,0);await handler(space,message('status'));assert.equal(replies.length,1);
});
test('listing greeting is sent once across distinct events and handler restarts',async t=>{
 const{pipeline,handler,replies,space,message}=fixture(t);
 pipeline.store.db.exec('DELETE FROM conversations');space.getMembers=async()=>[{id:'organizer',name:'A'}];
 await handler(space,message('hello','hello'));
 await handler(space,message('another','hey'));
 await createChatHandler(pipeline)(space,message('restart','yo'));
 assert.equal(replies.filter(text=>text.includes('Send me the online payment')).length,1);assert.equal(replies.filter(text=>text.includes('I’m here.')).length,1);
});
test('organizer can bypass from the group; replay and other attendees cannot trigger it',async t=>{
 const{pipeline,handler,replies,space,message}=fixture(t);let calls=0,advances=0;
 pipeline.bypass=async id=>{assert.equal(id,'booking');calls++;return{confirmed:3,total:3}};
 pipeline.advance=async()=>{advances++};
 await handler(space,message('other-bypass','bypass','other'));assert.equal(calls,0);
 await handler(space,message('bypass','bypass'));await handler(space,message('bypass','bypass'));
 assert.equal(calls,1);assert.equal(advances,1);assert.match(replies.at(-1),/3\/3 payments confirmed/);
});
test('group bypass reports failure without starting fulfillment',async t=>{
 const{pipeline,handler,replies,space,message}=fixture(t);let advances=0;
 pipeline.bypass=async()=>{throw Error('No booking is waiting for payments.')};pipeline.advance=async()=>{advances++};
 await handler(space,message('bypass','/bypass'));
 assert.equal(advances,0);assert.deepEqual(replies,['No booking is waiting for payments.']);
});
test('invalid intake answers and non-organizer events are deduplicated too',async t=>{
 const{handler,replies,space,message}=fixture(t,'INTAKE');
 const dm={...space,id:'dm',type:'dm'};
 await handler(dm,message('invalid','not an email'));await handler(dm,message('invalid','not an email'));
 assert.deepEqual(replies,['Provide a valid email address.']);
 await handler(space,message('other','hi','other'));await handler(space,message('other','hi','other'));assert.equal(replies.length,2);
});
test('only one agent process can own the project lock and shutdown releases it',t=>{
 const dir=mkdtempSync(join(tmpdir(),'leash-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const release=acquireAgentLock(dir);assert.equal(activeAgent(dir).pid,process.pid);
 assert.throws(()=>acquireAgentLock(dir),/already running/);release();assert.equal(activeAgent(dir),null);
 const releaseNext=acquireAgentLock(dir);release();assert.equal(activeAgent(dir).pid,process.pid);releaseNext();
});
test('a rejected greeting does not permanently mark the listing prompt as sent',async t=>{
 const {pipeline,handler,replies,space,message}=fixture(t);
 pipeline.store.db.exec('DELETE FROM conversations');space.getMembers=async()=>[{id:'organizer',name:'A'}];
 let fail=true;space.send=async text=>{if(fail)throw Object.assign(Error('Apple send error 4'),{code:'IMESSAGE_SEND_FAILED'});replies.push(text)};
 await assert.rejects(handler(space,message('first','yo')),/Apple send error 4/);
 fail=false;await handler(space,message('retry','yo'));assert.equal(replies.length,1);assert.match(replies[0],/Send me the online payment/);
});

test('StayNest links start intake from text, rich previews, bare domains and trailing slashes',async t=>{
 const origin='https://leash-staynest-demo.foggylyric64.chatgpt.site';
 for(const [index,content] of [
  {type:'text',text:origin+'/malicious'},
  {type:'app',url:async()=>origin+'/malicious'},
  {type:'richlink',url:origin+'/malicious.html'},
  {type:'text',text:origin.replace('https://','')+'/malicious/'},
  {type:'text',text:origin+'/'},
 ].entries()){
  const{pipeline,handler,replies,space,message}=fixture(t);pipeline.store.db.exec('DELETE FROM conversations');space.getMembers=async()=>[{id:'organizer',name:'A'}];
  let received;pipeline.create=input=>{received=input;return{id:'booking'}};
  await handler(space,{...message(`link-${index}`),content});
  assert.equal(received?.listingUrl,index===4?origin+'/legitimate':origin+'/malicious');assert.equal(replies.length,0);
 }
});
test('unsupported links and intake configuration errors receive an explanation instead of silence',async t=>{
 const{pipeline,handler,replies,space,message}=fixture(t);pipeline.store.db.exec('DELETE FROM conversations');space.getMembers=async()=>[{id:'organizer',name:'A'}];
 await handler(space,message('unsupported','https://example.com/pay'));
 assert.match(replies.at(-1),/Other payment sites aren’t supported yet/);
 pipeline.create=()=>{throw Error('Payment provider configuration is incomplete.')};
 await handler(space,message('fake','https://leash-staynest-demo.foggylyric64.chatgpt.site/malicious'));
 assert.match(replies.at(-1),/Payment provider configuration/);
});
