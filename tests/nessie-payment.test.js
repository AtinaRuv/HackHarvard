import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server.js';
import {Store} from '../app/store.js';
import {Bank} from '../app/bank.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
async function setup(t,{mismatch=false,missingDeposit=false,totalCents=93100}={}){
 const directory=mkdtempSync(join(tmpdir(),'leash-nessie-web-'));const store=new Store(directory);
 const previous=Object.fromEntries(['NESSIE_API_KEY','NESSIE_BASE_URL','NESSIE_CUSTOMER_ID'].map(key=>[key,process.env[key]]));
 process.env.NESSIE_API_KEY='fixture-key';process.env.NESSIE_BASE_URL='https://nessie.example';process.env.NESSIE_CUSTOMER_ID='customer';
 const originalFetch=global.fetch;const deposits=[],withdrawals=[],calls=[];
 global.fetch=async(url,options={})=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://nessie.example');
  const method=options.method||'GET';const body=options.body?JSON.parse(options.body):null;calls.push({method,path:parsed.pathname,body});
  if(method==='POST'&&parsed.pathname==='/customers/customer/accounts')return Response.json({objectCreated:{_id:'account',nickname:body.nickname,balance:0}},{status:201});
  if(parsed.pathname==='/accounts/account/deposits'){
   if(method==='POST'){const deposit={...body,_id:`deposit_${deposits.length+1}`};deposits.push(deposit);return Response.json({objectCreated:deposit},{status:201})}
   return Response.json(missingDeposit?[]:deposits);
  }
  if(method==='POST'&&parsed.pathname==='/accounts/account/withdrawals'){const withdrawal={...body,_id:`withdrawal_${withdrawals.length+1}`};withdrawals.push(withdrawal);return Response.json({objectCreated:withdrawal},{status:201})}
  throw new Error('Unexpected Nessie request.');
 };
 const browser={inspect:async(b,phase)=>({sourceUrl:b.listingUrl,facts:{...b.requested,listingUrl:b.listingUrl,listingId:b.listingId,destination:'airbnb.com',answers:b.answers,...(mismatch&&phase==='final'?{totalCents:b.requested.totalCents+100}:{})},screenshot:png})};
 const runtime=createApplication({mode:'demo',store,bank:new Bank({mode:'nessie'}),browser});
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();global.fetch=originalFetch;for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}rmSync(directory,{recursive:true,force:true})});
 const base=`http://127.0.0.1:${server.address().port}`;runtime.pipeline.baseUrl=base;
 const booking=runtime.pipeline.create({listingUrl:'https://www.airbnb.com/rooms/123',checkIn:'2026-11-14',checkOut:'2026-11-17',totalCents,participants:[{name:'A',contact:'+15555550101'},{name:'B',contact:'+15555550102',email:'b@example.com'}]});
 runtime.pipeline.answer(booking.id,{email:'a@example.com',guestName:'A'});await runtime.pipeline.advance(booking.id);
 const b=store.get(booking.id);assert.equal(b.status,'COLLECTING');assert.equal(b.accountId,'account');
 const pay=async index=>{const p=b.participants[index];return originalFetch(`${base}/api/share/${p.access}/pay`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})};
 return{runtime,b,store,base,pay,deposits,withdrawals,calls,request:originalFetch};
}
async function waitFor(store,id,status){const deadline=Date.now()+3000;while(store.get(id).status!==status){if(Date.now()>deadline)assert.fail(`Expected ${status}, got ${store.get(id).status}`);await new Promise(resolve=>setTimeout(resolve,10))}}

test('website payments create and verify Nessie deposits, then spend only matched confirmed funds',async t=>{
 const x=await setup(t);
 assert.deepEqual(x.b.participants.map(p=>p.amountCents),[46550,46550]);
 const first=await x.pay(0);assert.equal(first.status,200);assert.equal((await first.json()).bankConfirmed,true);
 const person=x.store.get(x.b.id).participants[0];assert.equal(person.bankDeposit.depositId,'deposit_1');assert.equal(person.bankDeposit.verified,true);
 assert.equal((await x.pay(0)).status,409);assert.equal(x.deposits.length,1);
 assert.equal((await x.pay(1)).status,200);await waitFor(x.store,x.b.id,'COMPLETED');
 assert.equal(x.deposits.length,2);assert.deepEqual(x.deposits.map(d=>d.amount),[46550,46550]);
 assert.ok(x.deposits.every(d=>d.status==='completed'&&/^Stripe test contribution pi_[A-Za-z0-9_]+$/.test(d.description)));
 assert.equal(x.withdrawals.length,1);assert.equal(x.withdrawals[0].amount,93100);assert.equal(x.withdrawals[0].status,'completed');
 assert.equal(x.store.get(x.b.id).bankSpending.withdrawalId,'withdrawal_1');
 const summary=await(await x.request(`${x.base}/api/share/${x.b.participants[0].access}`)).json();assert.equal(summary.bankProvider,'nessie');assert.equal(summary.bankConfirmed,true);
});
test('website cannot report success for a Nessie deposit that readback does not confirm',async t=>{
 const x=await setup(t,{missingDeposit:true});const response=await x.pay(0);
 assert.equal(response.status,502);assert.match((await response.json()).error,/could not be confirmed/);
 await waitFor(x.store,x.b.id,'REFUNDED');assert.equal(x.store.get(x.b.id).balanceCents,0);assert.equal(x.withdrawals.length,0);
 assert.equal(x.store.get(x.b.id).bankReview,true);
});
test('mismatched final token reverses both Nessie contributions instead of booking spending',async t=>{
 const x=await setup(t,{mismatch:true});await x.pay(0);await x.pay(1);await waitFor(x.store,x.b.id,'REFUNDED');
 assert.equal(x.withdrawals.length,2);assert.deepEqual(x.withdrawals.map(w=>w.amount),[46550,46550]);
 assert.ok(x.withdrawals.every(w=>w.description.startsWith('Leash spending refund_')));assert.equal(x.store.get(x.b.id).balanceCents,0);
});
test('Nessie share allocation never silently rounds a fractional-dollar booking total',()=>{
 const bank=new Bank({mode:'nessie'});assert.deepEqual(bank.shares(93101,2),[46551,46550]);assert.deepEqual(bank.shares(93100,2),[46550,46550]);assert.deepEqual(bank.shares(111875,2),[55938,55937]);
});

test('real fractional-dollar total is collected and spent exactly in Nessie cent units',async t=>{
 const x=await setup(t,{totalCents:111875});assert.equal(x.b.accountUnitCents,1);assert.deepEqual(x.b.participants.map(p=>p.amountCents),[55938,55937]);
 await x.pay(0);await x.pay(1);await waitFor(x.store,x.b.id,'COMPLETED');assert.deepEqual(x.deposits.map(d=>d.amount),[55938,55937]);assert.equal(x.withdrawals[0].amount,111875);
});
