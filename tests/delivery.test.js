import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyIMessageSend} from '../app/delivery.js';
import {Messenger} from '../app/messenger.js';
test('Photon RPC success containing Apple error 4 is a send failure',async()=>{
 const result={id:'failed',isSent:false,isDelivered:false,sendErrorCode:4};
 await assert.rejects(verifyIMessageSend({},result),error=>error.code==='IMESSAGE_SEND_FAILED'&&error.sendErrorCode===4);
});
test('confirmed sending is enough; a delivery receipt is not required',async()=>{
 const result={id:'sent',isSent:true,isDelivered:false,sendErrorCode:0};assert.equal(await verifyIMessageSend({},result),result);
});
test('pending sends are re-read and late Apple failures are rejected',async()=>{
 let reads=0;const result={id:'pending',isSent:false,sendErrorCode:0};
 await assert.rejects(verifyIMessageSend({getMessage:async()=>{reads++;return{...result,sendErrorCode:4}}},result,{pause:async()=>{}}),/Apple send error 4/);assert.equal(reads,1);
 const confirmed={...result,isSent:true};assert.equal(await verifyIMessageSend({getMessage:async()=>confirmed},result,{pause:async()=>{}}),result);
});
test('unknown sending outcomes are not treated as successful or safe to resend',async()=>{
 const result={id:'pending',isSent:false,sendErrorCode:0};await assert.rejects(verifyIMessageSend({},result),error=>error.deliveryUnknown&&error.providerMessageId==='pending');
});
test('real Messenger send wrapper records failure instead of chat_send_completed',async()=>{
 const events=[];const messenger=new Messenger({mode:'photon',debug:{write:(type,details)=>events.push({type,...details})}});
 const space=messenger.traceSpace({id:'group',send:async()=>({id:'failed',isSent:false,sendErrorCode:4})});
 await assert.rejects(space.send('test'),/Apple send error 4/);assert.ok(events.some(e=>e.type==='chat_send_failed'&&e.sendErrorCode===4));assert.ok(!events.some(e=>e.type==='chat_send_completed'));assert.equal(messenger.status,'send_failed');
});
