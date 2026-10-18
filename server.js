import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from './app/store.js';
import { Pipeline } from './app/pipeline.js';
import { BookingBrowser } from './app/browser.js';
import { Payments } from './app/payments.js';
import { Bank } from './app/bank.js';
import { Messenger, createChatHandler } from './app/messenger.js';
import { PhotonVoice } from './app/voice.js';
import { LiveSessions } from './app/live.js';
import { acquireAgentLock } from './app/process-lock.js';
import { startControl } from './app/control.js';
import {DebugLog,runtimeBuild} from './app/debug.js';
import {browserTestMonitor} from './app/browser-test-monitor.js';
import {tokenView} from './app/token-view.js';

export function createApplication(options = {}) {
  const mode=options.mode||process.env.APP_MODE||'connected';
  if(!['demo','connected'].includes(mode))throw new Error('APP_MODE must be demo or connected.');
  const baseUrl=options.baseUrl||process.env.APP_BASE_URL||'http://127.0.0.1:6767';
  const store=options.store||new Store(process.env.DATA_DIR||'data');
  const debug=options.debug||new DebugLog(store.directory);
  const live=options.live||new LiveSessions(store.directory);
  const source=options.source||(mode==='demo'?'demo':process.env.BOOKING_SOURCE||'airbnb-reserve');
  const messenger=options.messenger||new Messenger({mode:mode==='demo'?'demo':'photon',voice:options.voice,debug});
  const payments=options.payments||new Payments({mode:mode==='demo'?'demo':process.env.PAYMENT_PROVIDER||'demo',baseUrl});
  const browser=options.browser||new BookingBrowser({provider:process.env.BROWSER_PROVIDER||(mode==='demo'?'local':'daytona'),mode:source,live,debug,executablePath:process.env.BROWSER_EXECUTABLE});
  browser.live=live;
  const pipeline=new Pipeline({store,live,messenger,payments,browser,mode:source,baseUrl,tokenDisplayMs:options.tokenDisplayMs??(mode==='connected'?3000:0),sendEmail:Boolean(process.env.PHOTON_EMAIL_API_KEY&&process.env.PHOTON_EMAIL_PROJECT_ID&&process.env.PHOTON_EMAIL_SENDER_ID),bank:options.bank||new Bank({mode:mode==='demo'?'demo':process.env.BANK_PROVIDER||'nessie'})});
  const chatHandler=createChatHandler(pipeline);
  if(mode==='connected'&&!messenger.voice&&process.env.PHOTON_VOICE_TOKEN&&process.env.PHOTON_VOICE_FROM){
    messenger.voice=new PhotonVoice({token:process.env.PHOTON_VOICE_TOKEN,from:process.env.PHOTON_VOICE_FROM,onAnswer:async({bookingId,field},text)=>{
      const b=store.get(bookingId);if(!field||b.status!=='INTAKE'||!pipeline.questions(b).some(q=>q.field===field))return;
      if(['checkIn','checkOut'].includes(field)){const date=new Date(text);if(Number.isFinite(date.valueOf()))text=date.toISOString().slice(0,10)}
      pipeline.answer(bookingId,{[field]:text});await pipeline.advance(bookingId);
    }});
  }
  const app=express();app.disable('x-powered-by');
  const advance=id=>setImmediate(()=>void pipeline.advance(id).catch(error=>console.error('Booking:',error.message)));
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(req.method==='POST'&&req.headers.origin&&req.headers.origin!==new URL(pipeline.baseUrl).origin)return res.status(403).json({error:'Unexpected request origin.'});next();
  });
  app.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    let event;try{event=payments.event(req.body,req.headers['stripe-signature'])}catch{return res.status(400).json({error:'Invalid Stripe webhook signature.'})}
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&event.data.object.payment_status==='paid'){
      try{const id=await pipeline.paid(event.id,event.data.object,{advance:false});advance(id)}catch{return res.status(500).json({error:'Payment processing failed; retry delivery.'})}
    }res.json({received:true});
  });
  app.use(express.json({limit:'64kb'}));
  const share=(req,res,next)=>{try{Object.assign(req,pipeline.lookupParticipant(req.params.access));next()}catch(e){next(e)}};
  const viewer=(req,res,next)=>{
    try{Object.assign(req,pipeline.lookupParticipant(req.params.access))}catch{req.booking=store.all().find(b=>b.access===req.params.access)}
    if(!req.booking)return res.status(404).json({error:'Private session link not found.'});next();
  };
  app.get('/',(req,res)=>res.type('text').send('Leash runs in iMessage. Add the agent’s number to your group chat. Private payment and live browser links are sent there.'));
  app.get('/ping',(req,res)=>res.send('pong'));
  const bookingDetails=b=>({title:b.requested.title,checkIn:b.initialToken?.checkIn,checkOut:b.initialToken?.checkOut,totalCents:b.initialToken?.totalCents,destination:b.initialToken?.destination,deadline:b.collectionDeadline,balanceCents:b.balanceCents,displayBalanceCents:b.balanceCents+(b.status==='FINALIZING'&&b.bankSpending?b.initialToken.totalCents:0),bank:{accountLabel:b.accountId?`•••• ${b.accountId.slice(-6)}`:null,provider:b.accountId?(b.accountId.startsWith('sim_')?'Local demo':'Nessie'):'Pending',collectedCents:b.participants.filter(p=>p.bankCredited).reduce((sum,p)=>sum+p.amountCents,0),spentCents:b.bankSpending?b.initialToken.totalCents:0,refundedCents:b.participants.filter(p=>p.bankReversed).reduce((sum,p)=>sum+p.amountCents,0),paidCount:b.participants.filter(p=>p.bankCredited).length,participantCount:b.participants.length},reference:b.confirmation?.reference,failure:b.failure,differences:b.comparison?.differences||[],steps:[{label:'Listing and dates checked',done:Boolean(b.initialToken)},{label:'Everyone paid',done:b.participants.every(p=>p.bankCredited)},{label:'Final details matched',done:b.comparison?.status==='OK'},{label:'Group account debited',done:Boolean(b.bankSpending)},{label:'Booking completed',done:b.status==='COMPLETED'}],activity:b.events.map(e=>({id:e.id,at:e.at,type:e.type,text:e.text}))});
  // Permanent operator view stays on the Mac; attendee links remain private
  // and continue to hide the browser until the group has finished paying.
  const localOnly=(req,res,next)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['localhost','127.0.0.1','[::1]'].includes(req.hostname)||req.headers['cf-ray']||req.headers['x-forwarded-for'])return res.sendStatus(404);
    next();
  };
  const monitorContext=()=>{
    const own=store.all().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    const test=mode==='connected'?browserTestMonitor(options.browserTestDirectory||resolve('data/browser-tests')):null;
    const latest=test?.bookings.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    return latest&&(!own||latest.createdAt>own.createdAt)?{booking:latest,live:test.live,test:true,secret:test.secret}:{booking:own,live,test:false,secret:store.secret};
  };
  app.get('/watch',localOnly,(req,res)=>res.sendFile(fileURLToPath(new URL('./public/index.html',import.meta.url))));
  app.get('/api/monitor',localOnly,(req,res)=>{
    const {booking:b,live,test,secret}=monitorContext();
    if(!b)return res.json({supportsBrowserTests:true,status:'waiting',stage:'Ready. Waiting for a new booking in iMessage.',sequence:0,bookingId:null,frameUrl:null});
    const state=live.get(b.id),paid=b.participants.filter(p=>p.bankCredited).length;
    const remaining=b.participants.filter(p=>!p.bankCredited).map(p=>p.name);
    let stage=state.stage;
    if(b.status==='INTAKE'){
      const questions=pipeline.questions(b),shared=questions.find(q=>q.scope!=='private');
      stage=shared?`Waiting in the group: ${shared.text}`:'Waiting for private email replies.';
    }
    if(b.status==='COLLECTING'&&!test)stage=`${paid}/${b.participants.length} payments confirmed.${remaining.length?` Waiting for ${new Intl.ListFormat('en').format(remaining)} to pay.`:''}`;
    res.json({...state,tokens:tokenView(b,secret),supportsBrowserTests:true,browserTest:test,details:bookingDetails(b),bookingId:b.id,bookingStatus:b.status,stage,status:['INTAKE','COLLECTING'].includes(b.status)?'waiting':state.status,confirmation:b.status==='COMPLETED'?b.confirmation:undefined,failure:b.failure,frameUrl:live.image(b.id)?`/api/monitor/frame?booking=${b.id}&seq=${state.sequence}`:null});
  });
  app.get('/api/monitor/frame',localOnly,(req,res)=>{
    const {booking:b,live}=monitorContext();if(!b||req.query.booking!==b.id)return res.sendStatus(404);
    const file=live.image(b.id);if(!file)return res.sendStatus(404);res.type('image/jpeg').sendFile(file);
  });
  app.get('/api/share/:access',share,(req,res)=>{
    const b=req.booking,p=req.participant;
    res.json({title:b.requested.title,status:b.status,simulation:true,paymentMode:payments.mode,bankProvider:pipeline.bank.mode,name:p.name,amountCents:p.amountCents,paymentStatus:p.status,bankConfirmed:Boolean(p.bankCredited),
      checkIn:b.initialToken?.checkIn,checkOut:b.initialToken?.checkOut,guests:b.participants.length,confirmation:b.confirmation,failure:b.failure,totalCents:b.initialToken?.totalCents,destination:b.initialToken?.destination,deadline:b.collectionDeadline,paidNames:b.participants.filter(v=>v.bankCredited).map(v=>v.name),remainingNames:b.participants.filter(v=>!v.bankCredited).map(v=>v.name),
      screenshotUrl:b.screenshot?`/api/share/${p.access}/screenshot`:null,watchUrl:`/watch/${p.access}`});
  });
  app.get('/api/share/:access/screenshot',share,(req,res)=>{if(!req.booking.screenshot)return res.sendStatus(404);res.sendFile(resolve(store.directory,req.booking.screenshot))});
  app.post('/api/share/:access/checkout',share,async(req,res)=>res.json(await pipeline.checkout(req.params.access)));
  app.post('/api/share/:access/confirm',share,async(req,res)=>{
    const p=req.participant;
    if(payments.mode==='stripe'&&p.status==='unpaid'&&p.session){
      const session=await payments.validateSession(p.session);
      if(session.payment_status==='paid'){
        const id=await pipeline.paid(`reconcile_${session.id}`,session,{advance:false});advance(id);
      }
    }
    res.json({received:true});
  });
  app.post('/api/share/:access/pay',share,async(req,res)=>{
    if(payments.mode!=='demo')return res.sendStatus(404);
    const session=await pipeline.checkout(req.params.access);
    const id=await pipeline.paid(`fake_${session.id}`,{id:session.id,metadata:{bookingId:req.booking.id,participantId:req.participant.id},livemode:false,amount_total:req.participant.amountCents,currency:'usd',payment_status:'paid',payment_intent:`pi_${req.participant.id.replaceAll('-','')}`},{advance:false});
    const current=store.get(id),person=current.participants.find(p=>p.id===req.participant.id);
    advance(id);
    if(!person.bankCredited)return res.status(502).json({error:'The simulated bank deposit could not be confirmed. Your contribution is being refunded; no real money was charged.'});
    res.json({paid:true,bankConfirmed:true,watchUrl:`/watch/${req.params.access}`});
  });
  function sessionData(req){const b=store.get(req.booking.id),state=live.get(b.id);
    if(['INTAKE','PREPARING','COLLECTING'].includes(b.status))return{phase:null,status:'waiting',stage:'Waiting for everyone’s payment.',sequence:0,bookingStatus:b.status,frameUrl:null,details:bookingDetails(b)};
    return{...state,details:bookingDetails(b),bookingStatus:b.status,confirmation:b.status==='COMPLETED'?b.confirmation:undefined,failure:b.failure,frameUrl:state.phase==='final'&&live.image(b.id)?`/api/watch/${req.params.access}/frame?seq=${state.sequence}`:null};
  }
  app.get('/api/watch/:access',viewer,(req,res)=>res.json(sessionData(req)));
  app.get('/api/watch/:access/frame',viewer,(req,res)=>{if(!sessionData(req).frameUrl)return res.sendStatus(404);const file=live.image(req.booking.id);if(!file)return res.sendStatus(404);res.type('image/jpeg').sendFile(file)});
  app.get('/api/watch/:access/events',viewer,(req,res)=>{
    res.set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const send=()=>res.write(`event: session\ndata: ${JSON.stringify(sessionData(req))}\n\n`);send();
    live.events.on(req.booking.id,send);const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);
    req.on('close',()=>{clearInterval(timer);live.events.off(req.booking.id,send)});
  });
  app.get(['/pay/:access','/watch/:access'],viewer,(req,res)=>res.sendFile(fileURLToPath(new URL('./public/index.html',import.meta.url))));
  for(const asset of ['app.js','style.css'])app.get('/'+asset,(req,res)=>res.sendFile(fileURLToPath(new URL('./public/'+asset,import.meta.url))));
  app.use((req,res)=>res.status(404).json({error:'Not found. Start your booking in iMessage.'}));
  app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||400).json({error:error.message||'Request failed.'})});
  return{app,pipeline,store,messenger,mode,live,chatHandler};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let release;
  try{release=acquireAgentLock(fileURLToPath(new URL('.',import.meta.url)))}catch(error){console.error(error.message);process.exit(1)}
  process.once('exit',release);
  const runtime=createApplication();const port=Number(process.env.PORT||6767),host=process.env.HOST||'127.0.0.1';
  let control;
  const server=runtime.app.listen(port,host,()=>{
    control=startControl(runtime,fileURLToPath(new URL('./.agent.lock/control.sock',import.meta.url)));
    console.log(`Leash iMessage agent · private payment/live pages at http://${host}:${port} · build ${runtimeBuild} · listing screening off · diagnostics ${runtime.store.directory}/debug.jsonl`);
    void runtime.messenger.connect(runtime.chatHandler).catch(error=>console.error('Photon setup:',error.message));
  });
  server.once('error',error=>{console.error(`Could not start Leash: ${error.code||error.message}. No iMessage listener was started.`);runtime.store.close();process.exit(1)});
  const timer=setInterval(()=>void runtime.pipeline.tick(),5000);timer.unref();
  let stopping=false;
  async function stop(signal){
    if(stopping)return;stopping=true;
    console.log(`Leash shutting down: ${signal}${signal==='SIGINT'?' (terminal interrupt)':' (external stop, reset, or restart)'}.`);
    clearInterval(timer);control?.close();await runtime.messenger.stop();server.closeAllConnections();server.close(()=>{runtime.store.close();process.exit(0)});
  }
  process.once('SIGINT',()=>void stop('SIGINT'));process.once('SIGTERM',()=>void stop('SIGTERM'));
}
