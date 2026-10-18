import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Messenger,chatText} from '../app/messenger.js';
const url='https://www.airbnb.com/rooms/52266366?check_in=2026-11-13&check_out=2026-11-15';
test('plain URLs, Safari cards, rich links, replies and multipart messages yield the listing URL without fetching previews',async()=>{
 for(const content of [{type:'text',text:url},{type:'app',url:async()=>url,layout:()=>{throw Error('Do not fetch previews')}},{type:'richlink',url},{type:'reply',content:{id:'nested',content:{type:'text',text:url}}},{type:'group',items:[{content:{type:'attachment'}},{content:{type:'app',url:async()=>url}}]}])assert.equal(await chatText(content),url);
 assert.equal(await chatText({type:'attachment'}),'');
});
test('slow chat replies do not prevent reading subsequent provider events',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve});let observed=0,handled=0;
 const message=id=>({id,direction:'inbound',sender:{id:'sender'},content:{type:'text',text:'yo'}});
 const messenger=new Messenger({mode:'photon',photon:async()=>({app:{messages:(async function*(){yield[{id:'group'},message('one')];observed++;yield[{id:'group'},message('two')];observed++})()},im:{}})});
 await messenger.connect(async()=>{handled++;await blocked});
 for(let i=0;i<20&&observed<2;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(observed,2);assert.equal(handled,1);release();await messenger.listener;assert.equal(handled,2);
});
