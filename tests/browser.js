import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createApplication} from '../server.js';
import {Store} from '../app/store.js';
import {BookingBrowser} from '../app/browser.js';

const directory=mkdtempSync(join(tmpdir(),'leash-chat-browser-'));
const executablePath=process.env.BROWSER_EXECUTABLE||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
const bookingBrowser=new BookingBrowser({executablePath,stepDelayMs:450});
const delivered=[];const departures=[];
const messenger={status:'test',send:async(message,b)=>{delivered.push({...message,bookingId:b.id});return{id:message.key}},leave:async b=>departures.push(b.id)};
const runtime=createApplication({mode:'demo',store:new Store(directory),browser:bookingBrowser,messenger});
const server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;runtime.pipeline.baseUrl=base;runtime.pipeline.payments.baseUrl=base;
const browser=await chromium.launch({headless:true,executablePath});let sessions=0;const inspect=bookingBrowser.inspect.bind(bookingBrowser);
bookingBrowser.inspect=async(...args)=>{sessions++;return inspect(...args)};
const members=[{id:'+15555550101',name:'Avery'},{id:'+15555550102',name:'Jordan'},{id:'+15555550103',name:'Sam'}];
try{
 const monitor=await browser.newPage();await monitor.goto(base+'/watch');
 await monitor.getByRole('button',{name:'Enter full screen'}).waitFor();
 await monitor.getByText('Ready. Waiting for a new booking in iMessage.',{exact:true}).first().waitFor();
 for(const scenario of ['normal','price','destination']){
  const groupMessages=[];
  const space={id:`group_${scenario}`,type:'group',getMembers:async()=>members,send:async body=>{groupMessages.push(body)}};
  let serial=0;
  const inbound=(text,type='text')=>runtime.chatHandler(space,{id:`message_${scenario}_${serial++}`,direction:'inbound',sender:{id:members[0].id},content:type==='text'?{type,text}:{type:'addMember'}});
  await inbound('','addMember');assert.match(groupMessages.at(-1),/listing link/);
  await inbound('https://www.airbnb.com/rooms/12345678?check_in=2026-11-14&check_out=2026-11-17');
  let b=runtime.store.all().at(-1);assert.equal(b.status,'INTAKE');
  await inbound('3 nights');
  await monitor.getByText('Waiting in the group: Whose name should the booking be under?',{exact:true}).first().waitFor();
  if(scenario!=='normal')runtime.store.change(b.id,b=>{b.demoScenario=scenario});
  await inbound('Book under Avery Taylor');
  for(const [index,email] of ['avery@example.com','jordan@example.com','sam@example.com'].entries()){
   const dm={id:`dm_${scenario}_${index}`,type:'dm',send:async body=>groupMessages.push(body)};
   await runtime.chatHandler(dm,{id:`email_${scenario}_${index}`,sender:{id:members[index].id},content:{type:'text',text:email}});
  }
  b=runtime.store.get(b.id);assert.equal(b.status,'COLLECTING');
  const messages=delivered.filter(m=>m.bookingId===b.id&&m.key.startsWith('share_'));
  const links=messages.map(m=>m.body.match(/https?:\/\/\S+\/pay\/\S+/)[0]);assert.equal(links.length,3);
  assert.ok(!groupMessages.some(m=>/\/trip\//.test(m)));
  const watch=await browser.newPage();const errors=[];watch.on('pageerror',e=>errors.push(e.message));
  await watch.goto(`${base}/watch/${b.participants[0].access}`);
  await watch.getByRole('button',{name:'Show bank account'}).waitFor();
  await watch.getByRole('heading',{name:'Group booking account',exact:true}).waitFor();
  await watch.getByText('Available balance',{exact:true}).waitFor();
  const waiting=await(await watch.request.get(`${base}/api/watch/${b.participants[0].access}`)).json();
  assert.equal(waiting.frameUrl,null);assert.equal(waiting.status,'waiting');
  assert.equal((await watch.request.get(`${base}/api/watch/${b.participants[0].access}/frame`)).status(),404);
  const frames=[];runtime.live.events.on(b.id,state=>{if(state.phase==='final'&&state.status==='running')frames.push(state.sequence)});
  for(const link of links){
   const pay=await browser.newPage();await pay.goto(link);
   await pay.getByRole('button',{name:'Complete fake payment',exact:true}).waitFor();
   for(const viewport of [{width:390,height:664},{width:1440,height:900}]){
    await pay.setViewportSize(viewport);
    const layout=await pay.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,viewHeight:innerHeight,viewWidth:innerWidth,background:getComputedStyle(document.body).backgroundColor}));
    assert.ok(layout.height<=layout.viewHeight&&layout.width<=layout.viewWidth,'Payment page must not scroll.');assert.equal(layout.background,'rgb(0, 0, 0)');
   }
   if(process.env.TEST_ARTIFACT_DIR&&scenario==='normal'){mkdirSync(process.env.TEST_ARTIFACT_DIR,{recursive:true});await pay.setViewportSize({width:390,height:664});await pay.screenshot({path:join(process.env.TEST_ARTIFACT_DIR,'payment-ui.png')})}
   assert.equal(await pay.locator('form').count(),0);
   await pay.getByRole('button',{name:'Complete fake payment',exact:true}).click();
   await pay.getByText('Confirmed',{exact:true}).waitFor();
   assert.ok(pay.url().includes('/pay/'),'Payment stays on its confirmation page.');
   assert.equal(await pay.locator('a[href*="/watch/"]').count(),0);
   await pay.reload();await pay.getByText('Confirmed',{exact:true}).waitFor();
   await pay.close();
   const current=runtime.store.get(b.id),paid=current.participants.filter(p=>p.bankCredited).length;
   assert.ok(delivered.some(m=>m.bookingId===b.id&&m.key.startsWith('payment_progress_')&&m.body.includes(`${paid}/3 payments confirmed`)));
   if(paid<3)assert.ok(!delivered.some(m=>m.bookingId===b.id&&m.key==='watch_group'));
  }
  if(scenario==='normal'){
   await watch.getByText(/Simulated booking complete · SIM-/).waitFor({timeout:30000});
   assert.equal(runtime.store.get(b.id).status,'COMPLETED');
   assert.ok(departures.includes(b.id));
   assert.ok(delivered.some(m=>m.bookingId===b.id&&m.kind==='group'&&/Watch my browser live/.test(m.body)));
  }else{
   await watch.getByText('Everyone who paid has been refunded. No booking was made.',{exact:true}).waitFor({timeout:30000});
   assert.equal(runtime.store.get(b.id).status,'REFUNDED');assert.ok(runtime.store.get(b.id).participants.every(p=>p.status==='refunded'));
  }
  await watch.locator('#live-frame').waitFor({state:'attached'});assert.ok(new Set(frames).size>=3,'The viewer must receive multiple real browser frames.');
  await monitor.locator('#live-frame').waitFor({state:'attached'});
  const frame=await watch.request.get(base+(await watch.locator('#live-frame').getAttribute('src')));assert.equal(frame.status(),200);assert.match(frame.headers()['content-type'],/image\/jpeg/);
  assert.deepEqual(errors,[]);
  if(process.env.TEST_ARTIFACT_DIR){mkdirSync(process.env.TEST_ARTIFACT_DIR,{recursive:true});await watch.screenshot({path:join(process.env.TEST_ARTIFACT_DIR,`${scenario}-live.png`),fullPage:true})}
  await watch.close();console.log(`PASS iMessage → private fake payments → live actual browser → ${scenario==='normal'?'completion in iMessage':'automatic refunds'} (${scenario})`);
 }
 assert.equal(sessions,6);console.log('PASS no web onboarding/dashboard; six fresh browser sessions with live frames.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));runtime.store.close();rmSync(directory,{recursive:true,force:true})}
