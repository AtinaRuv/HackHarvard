#!/usr/bin/env node
import 'dotenv/config';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync,renameSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../app/store.js';
import {Bank} from '../app/bank.js';
import {Payments} from '../app/payments.js';
import {Messenger} from '../app/messenger.js';
import {BookingBrowser} from '../app/browser.js';
import {createApplication} from '../server.js';
export const defaultUrl='https://www.airbnb.com/rooms/52266366?search_mode=regular_search&adults=1&check_in=2026-11-13&check_out=2026-11-15&children=0&infants=0&pets=0&photo_id=1401146115&source_impression_id=p3_28e4fc13-cb87-4498-8eb8-2485a02a1bae_52266366&previous_page_section_name=1000';
async function accountBalance(accountId,unitCents=100){
 const url=new URL(process.env.NESSIE_BASE_URL);url.pathname=`${url.pathname.replace(/\/$/,'')}/accounts/${encodeURIComponent(accountId)}`;url.search='';url.searchParams.set('key',process.env.NESSIE_API_KEY);
 try{const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();const account=await response.json();if(!Number.isFinite(account.balance))throw Error();return Math.round(account.balance*unitCents)}catch{throw Error('Could not read back the simulated Nessie account balance. Review the account before retrying.');}
}
export async function main(stage='both'){
 const {values}=parseArgs({options:{url:{type:'string',default:defaultUrl},port:{type:'string',default:process.env.PORT||'6767'},bank:{type:'string',default:'nessie'},total:{type:'string',default:process.env.DEMO_TOTAL_CENTS||'96000'},scenario:{type:'string',default:'normal'},'real-price':{type:'boolean',default:true},exit:{type:'boolean',default:false}}});
 if(!process.env.DAYTONA_API_KEY)throw Error('Set DAYTONA_API_KEY in .env.');
 if(!['normal','price','destination','dates'].includes(values.scenario))throw Error('Use --scenario normal, price, destination, or dates.');
 let resume;
 if(stage==='final'){
  try{const {runId}=JSON.parse(readFileSync(resolve('data/browser-tests/active.json'),'utf8'));if(!/^[a-f0-9-]{36}$/.test(runId))throw Error();resume=JSON.parse(readFileSync(resolve('data/browser-tests',runId,'run.json'),'utf8'));if(resume.runId!==runId)throw Error();}catch{throw Error('Run npm run test_daytona_1 first. No resumable listing session was found.');}
  values.bank=resume.bank;values['real-price']=resume.realPrice;values.total=String(resume.total);values.url=resume.url;values.scenario=resume.scenario;
 }
 const total=Number(values.total),port=Number(values.port);if(!Number.isSafeInteger(total)||total<100||total%100)throw Error('--total is a whole-dollar USD amount in cents, e.g. 96000.');
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid viewer port.');
 const baseUrl=`http://localhost:${port}`;
 let monitor;try{const response=await fetch(`${baseUrl}/api/monitor`,{signal:AbortSignal.timeout(3000)});if(response.ok)monitor=await response.json()}catch{}
 if(!monitor?.supportsBrowserTests)throw Error(`Start the updated server with npm start, then run this command in another terminal. Viewer: ${baseUrl}/watch`);
 const runId=resume?.runId||randomUUID();const directory=resolve('data/browser-tests',runId);mkdirSync(directory,{recursive:true,mode:0o700});
 const lock=join(directory,'.run-lock');try{mkdirSync(lock)}catch{throw Error('This browser run is already in progress. Wait for it to finish before starting session #2.');}
 const store=new Store(directory),browser=new BookingBrowser({provider:'daytona',mode:values['real-price']?'airbnb-reserve':'airbnb-demo',stepDelayMs:300});
 const runtime=createApplication({mode:'demo',source:'demo',store,browser,bank:new Bank({mode:values.bank}),payments:new Payments(),messenger:new Messenger(),baseUrl,tokenDisplayMs:3500});
 let closing=false;const close=async()=>{if(closing)return;closing=true;store.close();rmSync(lock,{recursive:true,force:true});};
 // Don't interrupt a remote bank write or sandbox deletion. Finish the pass,
 // then close the viewer if Ctrl+C was received during the run.
 let stopRequested=false;let finished=false;
 const stop=()=>{stopRequested=true;if(finished)void close()};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  console.log(`Live browser: ${baseUrl}/watch\nArtifacts: ${directory}`);
  console.log(values['real-price']?'Price source: verified public Airbnb quote (fails if unavailable).':`Price source: SIMULATED $${(total/100).toFixed(2)}. The listing is real; checkout and reservation are simulated.`);
  console.log(`Bank: ${values.bank}. Photon, Stripe, and real Airbnb payments are not used.`);
  let b;
  if(stage==='final'){
   b=store.get(resume.bookingId);
   if(b.status!=='COLLECTING')throw Error(`Session #2 requires a ready initial token; this run is ${b.status}. Run test_daytona_1 for a fresh run.`);
  }else{
   b=runtime.pipeline.create({listingUrl:values.url,totalCents:total,demoScenario:values.scenario,participants:[{name:'Browser Test',contact:'browser-test',email:'browser-test@example.invalid'}]});
   runtime.pipeline.answer(b.id,{guestName:'Browser Test',email:'browser-test@example.invalid'});
  }
  const active=resolve('data/browser-tests/active.json');writeFileSync(active+'.tmp',JSON.stringify({runId,pid:process.pid}),{mode:0o600});renameSync(active+'.tmp',active);
  if(stage!=='final'){
   console.log('Session #1: fetching the real listing in Daytona.');
   await runtime.pipeline.advance(b.id);b=store.get(b.id);
   if(b.status!=='COLLECTING')throw Error(b.failure||`Session #1 ended in ${b.status}.`);
   writeFileSync(join(directory,'initial-token.json'),JSON.stringify(b.initialToken,null,2));
   writeFileSync(join(directory,'run.json'),JSON.stringify({runId,bookingId:b.id,bank:values.bank,realPrice:values['real-price'],total,url:values.url,scenario:values.scenario},null,2));
   console.log('PASS: Session #1 deleted. Initial token and listing screenshot saved.');
   if(stage==='initial'){
    runtime.live.finish(b.id,'waiting','Listing fetched. Run npm run test_daytona_2 to fill checkout and complete the simulation.');
    console.log('Next: npm run test_daytona_2');return;
   }
  }
  console.log('Funding the simulated group account.');
  await runtime.pipeline.bypass(b.id);
  console.log('Session #2: fresh Daytona browser, filling the simulated checkout and comparing tokens before debit.');
  await runtime.pipeline.advance(b.id);b=store.get(b.id);
  const remoteBalanceCents=values.bank==='nessie'?await accountBalance(b.accountId,b.accountUnitCents??100):b.balanceCents;
  const report={bookingId:b.id,accountId:b.accountId,status:b.status,scenario:values.scenario,bank:values.bank,priceSource:values['real-price']?'airbnb':'simulated',comparison:b.comparison,failure:b.failure,balanceCents:b.balanceCents,remoteBalanceCents,confirmation:b.confirmation,refunded:b.participants.map(p=>({status:p.status,bankReversed:!!p.bankReversed})),events:b.events};
  writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));
  if(b.finalToken)writeFileSync(join(directory,'final-token.json'),JSON.stringify(b.finalToken,null,2));
  if(remoteBalanceCents!==0)throw Error(`Nessie balance readback was ${remoteBalanceCents} cents rather than zero. See result.json before retrying.`);
  if(b.status==='COMPLETED'){
   const body=`Simulated booking complete.\nReference: ${b.confirmation.reference}\nStay: ${b.initialToken.checkIn} to ${b.initialToken.checkOut}\nTotal: USD ${(b.initialToken.totalCents/100).toFixed(2)}\nNo real Airbnb reservation was made.\n`;
   writeFileSync(join(directory,'confirmation.eml'),`To: browser-test@example.invalid\nSubject: Simulated booking confirmation\nContent-Type: text/plain; charset=utf-8\n\n${body}`);
   runtime.live.finish(b.id,'completed','Simulated booking complete. Confirmation email saved locally.');
   console.log(`PASS: tokens matched; Nessie/demo debit completed; both sandboxes deleted.\nConfirmation email saved (not sent): ${join(directory,'confirmation.eml')}`);
  }else if(b.status==='REFUNDED'&&values.scenario!=='normal')console.log('PASS: final mismatch stopped the debit and refunded every simulated contribution. Both sandboxes deleted.');
  else throw Error(b.failure||`Unexpected final status ${b.status}.`);
 }catch(error){process.exitCode=1;writeFileSync(join(directory,'failure.json'),JSON.stringify({error:error.message,bookings:store.all().map(b=>({id:b.id,status:b.status,accountId:b.accountId,failure:b.failure,bankOperation:b.bankOperation,events:b.events}))},null,2));console.error(`FAIL: ${error.message}`);}
 finally{finished=true;await close();console.log(`Viewer remains available through npm start: ${baseUrl}/watch`);}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname))await main().catch(error=>{console.error(error.message);process.exitCode=1});
