import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.js';
import { Pipeline } from '../app/pipeline.js';
import { Payments } from '../app/payments.js';
import { Bank } from '../app/bank.js';
import { Messenger, createChatHandler } from '../app/messenger.js';
import { sign, compare, airbnbUrl } from '../app/tokens.js';
import { startControl } from '../app/control.js';
import { request } from 'node:http';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
const baseInput = { listingUrl:'https://www.airbnb.com/rooms/1234', checkIn:'2026-11-14', checkOut:'2026-11-17', totalCents:10001,
  participants:[{ name:'A', contact:'+15555550101', email:'a@example.com' }, { name:'B', contact:'+15555550102', email:'b@example.com' }, { name:'C', contact:'+15555550103', email:'c@example.com' }] };
function setup(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'leash-test-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  const counts = { sessions:0, spend:0, credit:0, reverse:0, refunds:0 };
  const bank = new Bank();
  for (const method of ['spend','credit','reverse']) { const fn = bank[method].bind(bank); bank[method] = async (...args) => { counts[method]++; return fn(...args); }; }
  const payments = new Payments(); const refund = payments.refund.bind(payments);
  payments.refund = async (...args) => { counts.refunds++; return refund(...args); };
  const browser = { inspect:async (b, phase) => {
    counts.sessions++;
    const facts = { ...b.requested, listingId:b.listingId, listingUrl:b.listingUrl, destination:'airbnb.com', answers:{...b.answers} };
    if (phase === 'final') mutate(facts);
    return { sourceUrl:b.listingUrl, facts, screenshot:png };
  } };
  const pipeline = new Pipeline({ store, browser, payments, bank, messenger:new Messenger(), baseUrl:'http://127.0.0.1:6767', mode:'demo' });
  return { pipeline, store, counts, bank, payments, directory };
}
async function ready(pipeline) {
  const b = pipeline.create(structuredClone(baseInput));
  pipeline.answer(b.id, { email:'a@example.com', guestName:'Alex' });
  await pipeline.advance(b.id);
  return pipeline.store.get(b.id);
}
async function payment(pipeline, id, index, overrides = {}) {
  const b = pipeline.store.get(id); const p = b.participants[index];
  const session = p.session || await pipeline.checkout(p.access);
  const object = { id:session.id, metadata:{ bookingId:id, participantId:p.id }, amount_total:p.amountCents, currency:'usd', livemode:false, payment_status:'paid', payment_intent:`pi_${p.id}`, ...overrides };
  await pipeline.paid(`evt_${p.id}`, object);
  return object;
}
test('intake asks each question once in the group without a second DM or inline copy',async t=>{
  const {pipeline}=setup(t);const sent=[];
  pipeline.messenger.send=async message=>{sent.push(message);return{id:message.key}};
  const inline=[];const space={id:'group',type:'group',getMembers:async()=>baseInput.participants.map(p=>({...p,id:p.contact})),send:async text=>inline.push(text)};
  let serial=0;const handle=createChatHandler(pipeline);
  const send=text=>handle(space,{id:`intake_${serial++}`,sender:{id:baseInput.participants[0].contact},content:{type:'text',text}});
  await send('https://www.airbnb.com/rooms/1234?check_in=2026-11-14&check_out=2026-11-17');
  await pipeline.tick();await pipeline.tick();
  await send('3 nights');
  const names=()=>sent.filter(m=>m.field==='guestName');
  assert.equal(names().length,1);assert.equal(names()[0].kind,'group');
  assert.ok(!inline.some(text=>text.includes('Whose name')));
  await send('Book under Alex');await pipeline.tick();
  assert.equal(names().length,1);assert.equal(sent.filter(m=>m.field==='email').length,1);
});
test('everyone in the group attends and each attendee supplies only their own email privately',async t=>{
  const {pipeline,store}=setup(t);const sent=[],group=[];
  pipeline.messenger.send=async message=>{sent.push(message);return{id:message.key}};
  const members=baseInput.participants.map(p=>({id:p.contact,name:p.name}));
  const space={id:'group',type:'group',getMembers:async()=>members,send:async text=>group.push(text)};
  const handler=createChatHandler(pipeline);let serial=0;
  const send=(target,text,index=0)=>handler(target,{id:`private_${serial++}`,sender:{id:members[index].id},content:{type:'text',text}});
  await send(space,'https://www.airbnb.com/rooms/1234?check_in=2026-11-14&check_out=2026-11-17');
  const id=store.all()[0].id;assert.equal(store.get(id).requested.guests,3);
  assert.ok(!group.some(text=>text.includes('How many')));
  await send(space,'3 nights');
  await send(space,'Book under Alex');await pipeline.tick();await pipeline.tick();
  const emails=sent.filter(m=>m.field==='email'||m.field?.startsWith('email:'));
  assert.equal(emails.length,3);assert.ok(emails.every(m=>m.kind==='text'));assert.deepEqual(new Set(emails.map(m=>m.to)),new Set(members.map(m=>m.id)));
  await send(space,'public@example.com');assert.equal(store.get(id).answers.email,undefined);
  for(const index of [2,0,1]){
    const dm={id:`dm${index}`,type:'dm',send:async()=>{}};
    await send(dm,`person${index}@example.com`,index);
    assert.equal(store.get(id).participants[index].email,`person${index}@example.com`);
  }
  assert.equal(store.get(id).status,'COLLECTING');
  assert.equal(store.get(id).answers.email,'person0@example.com');
  assert.ok(!sent.some(m=>m.kind==='group'&&/person\d@example.com/.test(m.body)));
});
test('automatically completes after exact integer shares; no approval state', async t => {
  const {pipeline, store, counts} = setup(t); const b = await ready(pipeline);
  assert.equal(b.status,'COLLECTING'); assert.deepEqual(b.participants.map(p => p.amountCents),[3334,3334,3333]);
  await payment(pipeline,b.id,0); await payment(pipeline,b.id,1); await payment(pipeline,b.id,2);
  const result = store.get(b.id);
  assert.equal(result.status,'COMPLETED'); assert.equal(result.balanceCents,0); assert.equal(counts.spend,1); assert.equal(counts.sessions,2); assert.equal(result.leftGroup,true);
  assert.equal(result.outbox.filter(m => m.key.startsWith('receipt_')).length,3);
});
test('local bypass funds remaining shares once and continues normal completion',async t=>{
  const {pipeline,store,counts}=setup(t);const b=await ready(pipeline);
  await payment(pipeline,b.id,0);
  const result=await pipeline.bypass();assert.equal(result.bypassed,2);assert.equal(result.confirmed,3);
  await pipeline.bypass(b.id);assert.equal(counts.credit,3);
  await pipeline.advance(b.id);
  assert.equal(store.get(b.id).status,'COMPLETED');assert.equal(counts.spend,1);
  assert.equal(store.get(b.id).participants.filter(p=>p.paymentBypassed).length,2);
  await assert.rejects(pipeline.bypass(),/No booking/);
});
test('email bypass preserves real emails, skips missing addresses, and leaves payment required',async t=>{
  const {pipeline,store,counts}=setup(t);pipeline.sendEmail=true;
  const input=structuredClone(baseInput);delete input.participants[1].email;delete input.participants[2].email;
  const b=pipeline.create(input);
  const result=await pipeline.bypassEmail();assert.equal(result.bypassed,2);
  assert.equal((await pipeline.bypassEmail()).bypassed,0);
  await pipeline.advance(b.id);assert.equal(store.get(b.id).status,'INTAKE');assert.equal(counts.sessions,0);
  pipeline.answer(b.id,{guestName:'Alex'});await pipeline.advance(b.id);
  const current=store.get(b.id);assert.equal(current.status,'COLLECTING');assert.equal(current.answers.email,'a@example.com');
  assert.equal(counts.credit,0);assert.ok(current.participants.every(p=>p.status==='unpaid'));
  for(let i=0;i<3;i++)await payment(pipeline,b.id,i);
  const emails=store.get(b.id).outbox.filter(m=>m.kind==='email');
  assert.equal(emails.length,1);assert.equal(emails[0].to,'a@example.com');
  await assert.rejects(pipeline.bypassEmail(),/No booking/);
});
test('local socket command confirms all shares and automatically advances the booking',async t=>{
  const {pipeline,store,directory}=setup(t);const b=await ready(pipeline);
  const socketPath=join(directory,'control.sock');const server=startControl({pipeline},socketPath);
  await new Promise(resolve=>server.once('listening',resolve));
  const result=await new Promise((resolve,reject)=>{
    const req=request({socketPath,path:'/bypass',method:'POST'},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}))});req.on('error',reject);req.end();
  });
  assert.equal(result.status,200);assert.equal(result.body.confirmed,3);
  const deadline=Date.now()+2000;
  while(store.get(b.id).status!=='COMPLETED'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10))}
  await new Promise(resolve=>server.close(resolve));
});
test('bypass mismatch reverses bank deposits and only refunds actually paid shares through payment provider',async t=>{
  const {pipeline,store,counts}=setup(t,facts=>{facts.totalCents++});const b=await ready(pipeline);
  await payment(pipeline,b.id,0);await pipeline.bypass();await pipeline.advance(b.id);
  assert.equal(store.get(b.id).status,'REFUNDED');assert.equal(counts.refunds,1);assert.equal(counts.reverse,3);assert.equal(counts.spend,0);
});
test('bypass refuses to replace a Stripe checkout that cannot be closed',async t=>{
  const {pipeline,store,payments,counts}=setup(t);const b=await ready(pipeline);
  const session=await pipeline.checkout(b.participants[0].access);
  payments.mode='stripe';payments.validateSession=async()=>({payment_status:'unpaid',status:'open'});
  payments.expire=async()=>{throw Error('Stripe unavailable')};
  await assert.rejects(pipeline.bypass(),/Stripe unavailable/);
  assert.equal(store.get(b.id).participants[0].session.id,session.id);assert.equal(counts.credit,0);
});
test('Stripe reconciliation verifies saved sessions and ignores unpaid or mismatched results',async t=>{
  const {pipeline,store,payments,counts}=setup(t);const b=await ready(pipeline);
  for(const p of b.participants)await pipeline.checkout(p.access);
  payments.mode='stripe';
  let paid=false,wrong=false;
  payments.validateSession=async raw=>{
    const p=store.get(b.id).participants.find(p=>p.session.id===raw.id);
    return{id:raw.id,metadata:{bookingId:b.id,participantId:p.id},amount_total:p.amountCents+(wrong?1:0),currency:'usd',livemode:false,payment_status:paid?'paid':'unpaid',payment_intent:`pi_${p.id}`};
  };
  await pipeline.tick();assert.equal(counts.credit,0);
  paid=true;wrong=true;await pipeline.tick();assert.equal(counts.credit,0);
  wrong=false;await pipeline.tick();assert.equal(counts.credit,3);assert.equal(store.get(b.id).status,'COMPLETED');
  await pipeline.tick();assert.equal(counts.credit,3);
});
for (const [field, value] of [['totalCents',12000],['checkOut','2026-11-18'],['destination','evil.example'],['listingId','999'],['answers',{ email:'evil@example.com',guestName:'Alex' }]]) {
  test(`${field} mismatch automatically refunds every contributor before debit`,async t => {
    const {pipeline,store,counts} = setup(t,facts => { facts[field] = value; }); const b=await ready(pipeline);
    for(let i=0;i<3;i++) await payment(pipeline,b.id,i);
    const result=store.get(b.id); assert.equal(result.status,'REFUNDED'); assert.equal(result.balanceCents,0); assert.equal(counts.spend,0); assert.equal(counts.refunds,3);
    assert.ok(result.participants.every(p => p.status==='refunded'));
  });
}
test('concurrent payments are all recorded; duplicate webhook cannot credit twice',async t => {
  const {pipeline,store,counts} = setup(t); const b=await ready(pipeline);
  const sessions=await Promise.all(b.participants.map(p => pipeline.checkout(p.access)));
  const objects=sessions.map((s,i) => ({id:s.id,metadata:{bookingId:b.id,participantId:b.participants[i].id},amount_total:b.participants[i].amountCents,currency:'usd',livemode:false,payment_status:'paid',payment_intent:`pi_${i}`}));
  await Promise.all(objects.map((s,i) => pipeline.paid(`evt_${i}`,s)));
  await pipeline.paid('evt_duplicate',objects[0]);
  assert.equal(store.get(b.id).status,'COMPLETED'); assert.equal(counts.credit,3);assert.equal(counts.spend,1);
});
test('a forged amount, live mode, wrong session or unpaid status never credits the bank',async t => {
  const {pipeline,counts}=setup(t);const b=await ready(pipeline);
  for (const override of [{amount_total:1},{livemode:true},{payment_status:'unpaid'},{id:'another_session'}]) await assert.rejects(payment(pipeline,b.id,0,override),/does not match/);
  assert.equal(counts.credit,0);
});
test('refund failure retries automatically and retains completed refunds',async t => {
  const {pipeline,store,payments,counts}=setup(t,f=>{f.totalCents++});const b=await ready(pipeline);
  const refund=payments.refund; let fail=true;
  payments.refund=async (b,p)=>{if(fail&&p.id===b.participants[1].id)throw Error('outage');return refund(b,p)};
  for(let i=0;i<3;i++)await payment(pipeline,b.id,i);
  assert.equal(store.get(b.id).status,'REFUNDING'); fail=false; await pipeline.tick();
  assert.equal(store.get(b.id).status,'REFUNDED'); assert.equal(counts.refunds,3);
});
test('pending refunds are polled; definitively failed refunds get a new attempt',async t=>{
  const {pipeline,store,payments}=setup(t,f=>{f.totalCents++});const b=await ready(pipeline);
  let failFirst=true;const attempts=[];
  payments.refund=async(b,p)=>{attempts.push([p.id,p.refundAttempt||0]);return{id:`re_${p.id}_${p.refundAttempt||0}`,status:p.id===b.participants[0].id&&failFirst?'pending':'succeeded'}};
  payments.refundStatus=async(id)=>{failFirst=false;return{id,status:'failed'}};
  for(let i=0;i<3;i++)await payment(pipeline,b.id,i);
  assert.equal(store.get(b.id).status,'REFUNDING');await pipeline.tick();await pipeline.tick();
  assert.equal(store.get(b.id).status,'REFUNDED');assert.deepEqual(attempts.filter(([id])=>id===b.participants[0].id).map(([,attempt])=>attempt),[0,1]);
});
test('collection timeout refunds partial funding and a late successful payment',async t => {
  const {pipeline,store,counts}=setup(t);const b=await ready(pipeline);
  await pipeline.checkout(b.participants[1].access);
  await payment(pipeline,b.id,0);
  store.change(b.id,b=>{b.collectionDeadline=0});await pipeline.tick();
  assert.equal(store.get(b.id).status,'REFUNDED');
  await payment(pipeline,b.id,1);
  assert.equal(store.get(b.id).status,'REFUNDED');assert.equal(counts.refunds,2);assert.equal(counts.credit,1);assert.equal(counts.spend,0);
});
test('unknown Nessie debit is not retried or reported confirmed',async t => {
  const {pipeline,store,bank}=setup(t);const b=await ready(pipeline);let spends=0;
  bank.spend=async()=>{spends++;throw Error('timeout')};for(let i=0;i<3;i++)await payment(pipeline,b.id,i);
  await pipeline.tick();assert.equal(spends,1);assert.equal(store.get(b.id).status,'RECONCILIATION');assert.equal(store.get(b.id).confirmation,undefined);
});
test('unanswered intake never starts browser or collects money; fields freeze after preview',async t=>{
  const {pipeline,store,counts}=setup(t);const b=pipeline.create(structuredClone(baseInput));await pipeline.advance(b.id);
  assert.equal(counts.sessions,0);assert.equal(store.get(b.id).status,'INTAKE');
  await assert.rejects(pipeline.checkout(b.participants[0].access),/no longer/);
  pipeline.answer(b.id,{email:'a@example.com',guestName:'Alex'});await pipeline.advance(b.id);
  assert.throws(()=>pipeline.answer(b.id,{guestName:'Changed'}),/frozen/);
});
test('booking tokens bind answers and destination; tampering with signature fails',()=>{
  const facts={bookingId:'1',listingId:'123',listingUrl:baseInput.listingUrl,checkIn:baseInput.checkIn,checkOut:baseInput.checkOut,guests:3,currency:'USD',totalCents:10001,destination:'airbnb.com',answers:{email:'a@example.com',guestName:'A'}};
  const initial=sign(facts,'secret'); const reordered=sign({...facts,answers:{guestName:'A',email:'a@example.com'}},'secret');
  assert.equal(compare(initial,reordered,'secret').status,'OK');
  assert.equal(compare(initial,{...initial,totalCents:2},'secret').status,'BLOCK');
});
test('Airbnb URL rejects lookalikes, credentials, action paths and private destinations',()=>{
  for(const url of ['https://airbnb.com.evil.example/rooms/1','http://www.airbnb.com/rooms/1','https://user:pass@www.airbnb.com/rooms/1','https://127.0.0.1/rooms/1','https://www.airbnb.com/book/1'])assert.throws(()=>airbnbUrl(url));
  assert.equal(airbnbUrl('https://airbnb.com/rooms/1?redirect=evil&check_in=2026-11-14'),'https://www.airbnb.com/rooms/1?check_in=2026-11-14');
});

test('the final token and comparison are visible before any bank debit begins',async t=>{
 const {pipeline,store,counts}=setup(t);pipeline.tokenDisplayMs=100;const b=await ready(pipeline);
 await payment(pipeline,b.id,0);await payment(pipeline,b.id,1);
 const completing=payment(pipeline,b.id,2);const deadline=Date.now()+2000;
 while(!store.get(b.id).finalToken){assert.ok(Date.now()<deadline);await new Promise(ok=>setTimeout(ok,2))}
 const checking=store.get(b.id);assert.equal(checking.status,'FINALIZING');assert.equal(checking.comparison.status,'OK');assert.equal(checking.bankOperation,null);assert.equal(counts.spend,0);
 await completing;assert.equal(store.get(b.id).status,'COMPLETED');assert.equal(counts.spend,1);
});

test('payment and completion updates stay text only without a trip sendoff',async t=>{
 const {pipeline,store}=setup(t);const b=await ready(pipeline);
 const cards=()=>store.get(b.id).outbox.filter(m=>m.statusCard);
 assert.equal(cards().length,0);await payment(pipeline,b.id,0);assert.equal(cards().length,0);
 await payment(pipeline,b.id,1);assert.equal(cards().length,0);
 await payment(pipeline,b.id,2);assert.equal(store.get(b.id).status,'COMPLETED');assert.equal(cards().length,0);
 assert.ok(!store.get(b.id).outbox.some(m=>/enjoy your trip/i.test(m.body)));
 assert.ok(!store.get(b.id).outbox.find(m=>m.key==='group_confirmation').statusCard);
 await pipeline.tick();assert.equal(cards().length,0);
});

test('restart retries only unfunded whole-dollar compatibility failures with a fresh account',async t=>{
 const {pipeline,store}=setup(t);const b=pipeline.create(structuredClone(baseInput));
 store.change(b.id,b=>{b.status='FAILED';b.failure='Nessie requires whole-dollar totals and at least $1 per person. No payments have been requested.';b.accountId='legacy_empty'});
 new Pipeline({store,browser:pipeline.browser,payments:pipeline.payments,bank:pipeline.bank,messenger:pipeline.messenger,baseUrl:pipeline.baseUrl,mode:'demo'});
 const recovered=store.get(b.id);assert.equal(recovered.status,'INTAKE');assert.equal(recovered.accountId,undefined);assert.equal(recovered.previousAccountId,'legacy_empty');
 store.change(b.id,b=>{b.status='FAILED';b.failure='Nessie requires whole-dollar totals';b.participants[0].bankCredited=true});
 new Pipeline({store,browser:pipeline.browser,payments:pipeline.payments,bank:pipeline.bank,messenger:pipeline.messenger,baseUrl:pipeline.baseUrl,mode:'demo'});assert.equal(store.get(b.id).status,'FAILED');
});

test('a browser loading failure refunds without claiming booking details changed',async t=>{
 const {pipeline,store,counts}=setup(t);const b=await ready(pipeline);pipeline.browser.inspect=async()=>{throw Error('Airbnb listing returned HTTP 503.')};
 for(let i=0;i<3;i++)await payment(pipeline,b.id,i);
 const failed=store.get(b.id);assert.equal(failed.status,'REFUNDED');assert.equal(counts.spend,0);const update=failed.outbox.find(m=>m.key==='blocked_group');assert.match(update.body,/browser check failed/);assert.doesNotMatch(update.body,/details changed/);
});

test('retry preserves saved booking details, uses new payment links and leaves refunded records unchanged',async t=>{
 const {pipeline,store}=setup(t);const b=await ready(pipeline);store.change(b.id,b=>{b.status='REFUNDED';b.participants.forEach(p=>{p.status='refunded';p.bankCredited=true;p.bankReversed=true})});
 const fresh=pipeline.retry(b.id);assert.notEqual(fresh.id,b.id);assert.deepEqual(fresh.answers,store.get(b.id).answers);assert.equal(fresh.status,'INTAKE');assert.equal(fresh.participants[0].status,'unpaid');assert.notEqual(fresh.participants[0].access,b.participants[0].access);assert.equal(store.get(b.id).status,'REFUNDED');
 assert.throws(()=>pipeline.retry(fresh.id),/Finish refund/);
});

test('trip intake derives checkout from nights and validates dates',async t=>{
  const {pipeline,store}=setup(t);
  const b=pipeline.create({...structuredClone(baseInput),checkIn:undefined,checkOut:undefined,spaceId: "group"});
  assert.equal(pipeline.questions(b)[0].field,'checkIn');
  assert.throws(()=>pipeline.answer(b.id,{checkIn:'2026-02-30'}),/valid date/);
  pipeline.answer(b.id,{checkIn:'2026-12-30'});
  assert.equal(pipeline.questions(store.get(b.id))[0].field,'nights');
  for(const nights of ['0','-2','1.5','366']) assert.throws(()=>pipeline.answer(b.id,{nights}));
  pipeline.answer(b.id,{nights:'3 nights'});
  assert.equal(store.get(b.id).requested.checkOut,'2027-01-02');
  assert.throws(()=>pipeline.answer(b.id,{checkOut:'2026-12-29'}),/after check-in/);
  assert.equal(store.get(b.id).requested.checkOut,'2027-01-02');
  pipeline.answer(b.id,{guestName:'Alex'});
  assert.ok(!pipeline.questions(store.get(b.id)).some(q=>q.field==='guests'));
  assert.equal(pipeline.questions(store.get(b.id))[0].field,'email');
});

test('group chat asks nights even with dates in the listing URL and keeps the group guest count',t=>{
 const {pipeline,store}=setup(t);
 const b=pipeline.create({...structuredClone(baseInput),spaceId:'group'});
 assert.equal(pipeline.questions(b)[0].field,'nights');
 pipeline.answer(b.id,{nights:'5 nights'});
 assert.equal(store.get(b.id).requested.checkOut,'2026-11-19');
 assert.equal(store.get(b.id).requested.guests,3);
 assert.equal(pipeline.questions(store.get(b.id))[0].field,'guestName');
 assert.ok(!pipeline.questions(store.get(b.id)).some(q=>q.field==='guests'));
});
