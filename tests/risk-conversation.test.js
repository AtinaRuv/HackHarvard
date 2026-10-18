import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Store} from '../app/store.js';
import {Pipeline} from '../app/pipeline.js';
import {Bank} from '../app/bank.js';
import {Payments} from '../app/payments.js';
import {Messenger,createChatHandler} from '../app/messenger.js';
import {DebugLog,messageDebug} from '../app/debug.js';
const {readQuote}=createRequire(import.meta.url)('../app/airbnb.cjs');
const url='https://www.airbnb.com/rooms/52266366?search_mode=regular_search&adults=1&check_in=2026-11-13&check_out=2026-11-15&children=0&infants=0&pets=0&photo_id=1401146115&source_impression_id=p3_28e4fc13-cb87-4498-8eb8-2485a02a1bae_52266366&previous_page_section_name=1000';
const observed=readFileSync(new URL('../fraud/fixtures/airbnb_52266366_excerpt.html',import.meta.url),'utf8');
// Quote values are explicitly test data. The real observed review/nav structure
// goes through the actual parser; this does not pretend to be an Airbnb price.
const quote='<p data-testid="checkin-date">2026-11-13</p><p data-testid="checkout-date">2026-11-15</p><p data-testid="guest-count">2 guests</p><p data-testid="price-total">Total USD $960.00</p><p>Includes all taxes and fees</p>';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
function setup(t){const directory=mkdtempSync(join(tmpdir(),'leash-risk-chat-'));const store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true})});return{store,directory,debug:new DebugLog(directory)}}
test('Photon transport replay: listing, name, private emails, duplicate delivery, payments and completion never produce legacy fraud warnings',async t=>{
 const {store,directory,debug}=setup(t);const sent=[];
 const group={id:'group',type:'group',getMembers:async()=>[{id:'alex',name:'Alex'},{id:'sam',name:'Sam'}],send:async body=>{sent.push({space:'group',body});return{id:`sent_${sent.length}`}},leave:async()=>{}};
 const dm=id=>({id:`dm_${id}`,type:'dm',send:async body=>{sent.push({space:id,body});return{id:`sent_${sent.length}`}}});
 const event=(id,text,sender='alex')=>({id,direction:'inbound',sender:{id:sender},content:{type:'text',text}});
 async function* messages(){
  yield[group,{...event('listing',url),content:{type:'app',url:async()=>url}}];yield[group,event('nights','2 nights')];yield[group,event('name','Book under Alex')];
  yield[group,event('name','Book under Alex')];
  yield[dm('alex'),event('email_alex','alex@example.com')];
  yield[dm('sam'),event('email_sam','sam@example.com','sam')];
  yield[dm('sam'),event('email_sam','sam@example.com','sam')];
 }
 const messenger=new Messenger({mode:'photon',debug,renderCard:async()=>Buffer.from(png,'base64'),voice:{call:async()=>({id:'call'})},photon:async()=>({app:{messages:messages()},im:{user:async id=>id,space:{create:async id=>dm(id)}}})});
 const browser={inspect:async(b,phase,{commit}={})=>{
  const facts=readQuote(observed.replace('</body>',quote+'<p>Pay with gift cards. No reviews yet.</p></body>'),b.listingUrl);
  const result={sourceUrl:b.listingUrl,facts:{...facts,answers:b.answers},screenshot:png};
  if(commit)await commit(result);return result;
 }};
 const pipeline=new Pipeline({store,browser,messenger,bank:new Bank(),payments:new Payments(),baseUrl:'https://example.com',mode:'demo'});
 await messenger.connect(createChatHandler(pipeline));await messenger.listener;
 let booking=store.all()[0];assert.equal(booking.status,'COLLECTING');
 assert.equal(booking.requested.checkIn,'2026-11-13');assert.equal(booking.requested.checkOut,'2026-11-15');
 assert.equal(sent.filter(s=>s.body==='Whose name should the booking be under?').length,1);
 assert.equal(sent.filter(s=>s.body==='What’s your email for the booking confirmation?').length,2);
 await pipeline.bypass(booking.id);await pipeline.advance(booking.id);booking=store.get(booking.id);
 assert.equal(booking.status,'COMPLETED');
 assert.ok(sent.every(s=>!messageDebug(s.body).legacyWarning));
 assert.ok(!sent.some(s=>typeof s.body==='string'&&/checkIn and checkOut not found|no reviews|Gift cards/.test(s.body)));
 const trace=readFileSync(join(directory,'debug.jsonl'),'utf8');assert.ok(!trace.includes('alex@example.com'));assert.ok(!trace.includes('sam@example.com'));
 const records=trace.trim().split('\n').map(JSON.parse);assert.ok(records.some(e=>e.type==='chat_send_completed'));assert.equal(records.filter(e=>e.type==='listing_risk').length,0);assert.ok(records.some(e=>e.type==='runtime_started'&&e.listingFraudScreening===false));
});
test('observed legacy outbound messages are diagnosed without processing them as inbound or sending another response',async t=>{
 const {debug,directory}=setup(t);let calls=0;
 const legacy='Heads up, this listing looks off: the page asks for payment outside Airbnb ("Gift cards"); the listing has no reviews.';
 const messenger=new Messenger({mode:'photon',debug,photon:async()=>({app:{messages:(async function*(){yield[{id:'group'},{id:'foreign',direction:'outbound',content:{type:'text',text:legacy}}]})()},im:{}})});
 await messenger.connect(async()=>{calls++});await messenger.listener;assert.equal(calls,0);
 const records=readFileSync(join(directory,'debug.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(records.some(r=>r.type==='chat_observed'&&r.legacyWarning));assert.ok(!records.some(r=>r.type==='chat_send_started'));
});
test('a missing quote reports missing pricing without invoking a fraud scanner',()=>{
 assert.throws(()=>readQuote(observed,url),/final total/);
});
