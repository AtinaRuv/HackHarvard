const root=document.querySelector('#app');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const confirmed=()=>{root.innerHTML='<section class="payment-sheet" role="status"><div class="wallet-heading">Confirmed</div></section>'};
const dateLabel=value=>value?new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z')):'';
const traceTime=value=>new Intl.DateTimeFormat('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));
const timeLabel=value=>value?new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(new Date(value)):'';
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
async function request(url,body){const res=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw Error(data.error||'Request failed.');return data}
const operator=location.pathname==='/watch';
const match=operator?['','watch','']:location.pathname.match(/^\/(pay|watch)\/([^/]+)$/);
if(!match){root.textContent='Continue in your iMessage group chat.'}else{
 const[,kind,raw]=match,access=encodeURIComponent(raw);
 document.querySelector('.brand').removeAttribute('href');
 document.querySelector('#mode').textContent='Simulation';
 if(kind==='pay'){
  document.body.classList.add('payment-screen');
  try{
   let data=await request(`/api/share/${access}`);
   if(data.paymentMode==='stripe'&&new URLSearchParams(location.search).has('returned')){
    root.textContent='Confirming payment…';
    await request(`/api/share/${access}/confirm`,{});
    data=await request(`/api/share/${access}`);
    for(let attempt=0;attempt<30&&data.paymentStatus==='unpaid';attempt++){
     await new Promise(resolve=>setTimeout(resolve,2000));
     data=await request(`/api/share/${access}`);
    }
    
   }
   const canPay=data.status==='COLLECTING'&&data.paymentStatus==='unpaid';
   const status=data.paymentStatus==='refunded'?'Refunded':data.paymentStatus==='paid'?'Paid':'Payment closed';
   root.innerHTML=`<section class="payment-sheet" aria-label="Demo payment">
    <div class="pay-brand">leash<span>${data.paymentMode==='demo'?'Simulation':'Test mode'}</span></div>
    <p class="pay-eyebrow">Your share</p><h1 class="pay-stay">${escape(data.title)}</h1>
    <p class="pay-dates">${escape(dateLabel(data.checkIn))} – ${escape(dateLabel(data.checkOut))}</p>
    <div class="pay-amount">${money(data.amountCents)}</div><p class="pay-split">1 of ${data.guests} · ${money(data.totalCents)} total</p>
    <div class="pay-permission"><p>Booking limit</p><dl><div><dt>Pay</dt><dd>${escape(data.destination)} only</dd></div><div><dt>Up to</dt><dd>${money(data.totalCents)}</dd></div><div><dt>Before</dt><dd>${escape(timeLabel(data.deadline))}</dd></div><div><dt>How many times</dt><dd>Once</dd></div></dl><span>Shared funds for this stay. Automatically refunded if booking is blocked.</span></div>
    <div id="notice" role="status" aria-live="polite"></div>
    ${canPay?`<button id="pay" class="apple-pay-button" aria-label="${data.paymentMode==='demo'?'Complete fake payment':'Continue to Stripe'}"><span aria-hidden="true"></span> Pay ${money(data.amountCents)}</button>`:`<p class="payment-demo">${escape(status)}</p>`}
    <p class="pay-progress">${data.paidNames?.length?escape(new Intl.ListFormat('en').format(data.paidNames))+' paid. ':''}${data.remainingNames?.length===1&&canPay?"You’re last.":`${data.paidNames?.length||0}/${data.guests} payments confirmed.`}</p>
   </section>`;
   if(data.paymentStatus==='paid'&&data.bankConfirmed)confirmed();
   document.querySelector('#pay')?.addEventListener('click',async event=>{
    event.target.disabled=true;
    document.querySelector('#notice').textContent=data.paymentMode==='stripe'?'Opening secure checkout…':data.bankProvider==='nessie'?'Confirming Nessie deposit…':'Processing…';
    try{if(data.paymentMode==='demo'){await request(`/api/share/${access}/pay`,{});confirmed()}else{const session=await request(`/api/share/${access}/checkout`,{});location.href=session.url}}
    catch(error){document.querySelector('#notice').textContent=error.message;event.target.disabled=false}
   });
  }catch(error){root.textContent=error.message}
 }else{
  document.body.classList.add('watch-screen');
  root.innerHTML=`<div class="live-window" data-state="waiting">
   <div class="watch-hud"><span class="watch-wordmark">leash</span><span class="watch-label">Simulation</span><span class="watch-dot" aria-hidden="true"></span><button id="live-status" class="watch-status" disabled>CONNECTING</button><button id="watch-reset" class="watch-reset" aria-label="Reset watch view" title="Clear the displayed session" hidden disabled>↺ Reset</button><button id="details-toggle" aria-label="Show bank account" aria-expanded="true">Account panel</button><button id="fullscreen" aria-label="Enter full screen" title="Full screen">⛶</button></div>
   <section class="browser-pane" aria-label="Agent browser"><div class="mac-toolbar"><div class="mac-dots" aria-hidden="true"><i></i><i></i><i></i></div><div class="safari-navigation" aria-hidden="true"><span>‹</span><span>›</span></div><div class="mac-address"><span aria-hidden="true">◇</span><span id="browser-location">Agent browser</span></div><span class="mac-readonly">Read only</span></div>
    <div class="browser-canvas"><img id="live-frame" alt="Live view of the agent’s actual browser" hidden><div id="waiting" class="live-wait">Waiting for everyone to pay.</div><div id="watch-summary" class="watch-summary" hidden><span class="summary-check" aria-hidden="true">✓</span><h1>All set.</h1><p>Your group stay is confirmed.</p><span id="summary-reference"></span><small>Simulation</small></div></div>
   </section>
   <section class="trace-pane" aria-label="Booking tokens and simulated bank account">
    <section class="token-workspace" aria-label="Token matching"><div class="trace-heading"><span>Token matching</span><span>Before payment</span></div><p id="token-placeholder" class="detail-muted">Tokens will appear when the booking is prepared.</p><section id="token-comparison" aria-label="Token verification" hidden></section></section>
    <section class="agent-workspace" aria-label="Simulated bank account"><div class="bank-header"><h2>Group booking account</h2><span>Simulated · USD</span></div><p id="stage" hidden></p><aside id="booking-details" aria-label="Booking details" tabindex="-1"></aside><p id="result" role="status"></p></section>
   </section>
  </div>`;
  const detailsToggle=document.querySelector('#details-toggle'),detailsPanel=document.querySelector('#booking-details');
  detailsToggle.addEventListener('click',()=>{const window=document.querySelector('.live-window');const focused=window.classList.toggle('browser-focused');detailsToggle.setAttribute('aria-expanded',String(!focused));if(!focused)detailsPanel.focus()});

  let detailsSignature;
  const fullscreen=document.querySelector('#fullscreen');
  fullscreen.addEventListener('click',async()=>{
   try{
    if(document.fullscreenElement){await document.exitFullscreen()}
    else if(document.documentElement.requestFullscreen){await document.documentElement.requestFullscreen()}
    else document.querySelector('#stage').textContent='Use Control–Command–F to enter full screen on your Mac.';
   }catch{document.querySelector('#stage').textContent='Use Control–Command–F to enter full screen on your Mac.'}
  });
  document.addEventListener('fullscreenchange',()=>{fullscreen.textContent=document.fullscreenElement?'⤢':'⛶';fullscreen.setAttribute('aria-label',document.fullscreenElement?'Exit full screen':'Enter full screen')});

  let lastSequence=-1,lastBooking;
  let latestOperatorData,clearedSession;
  try{clearedSession=JSON.parse(localStorage.getItem('leash.watch.cleared')||'null')}catch{}
  const statusButton=document.querySelector('#live-status');
  const resetButton=document.querySelector('#watch-reset');
  resetButton.hidden=!operator;
  resetButton.addEventListener('click',()=>{
   if(!operator||!latestOperatorData?.bookingId||latestOperatorData.status==='running')return;
   clearedSession={id:latestOperatorData.bookingId,phase:latestOperatorData.phase||null};
   try{localStorage.setItem('leash.watch.cleared',JSON.stringify(clearedSession))}catch{}
   renderOperator(latestOperatorData);
  });
  function renderOperator(data){
   latestOperatorData=data;
   const hidden=clearedSession?.id===data.bookingId&&clearedSession.phase===(data.phase||null)&&data.status!=='running';
   if(hidden)update({status:'waiting',stage:'Ready. Waiting for the next session.',sequence:0,bookingId:null,frameUrl:null});
   else{
    if(clearedSession&&data.bookingId===clearedSession.id&&data.status==='running'){clearedSession=null;try{localStorage.removeItem('leash.watch.cleared')}catch{}}
    update(data);
   }
  }
  let tokenSignature;
  const displayToken=token=>({totalCents:token.totalCents,destination:token.destination,checkIn:token.checkIn,checkOut:token.checkOut,guests:token.guests,currency:token.currency,...token});
  function showTokens(tokens){
   const panel=document.querySelector('#token-comparison');
   document.querySelector('#token-placeholder').hidden=Boolean(operator&&tokens);
   if(!operator||!tokens){panel.hidden=true;panel.innerHTML='';tokenSignature=null;return;}
   const signature=JSON.stringify(tokens);if(signature===tokenSignature)return;tokenSignature=signature;panel.hidden=false;
   const blocked=tokens.status==='BLOCK'||!tokens.initialValid||(tokens.final&&!tokens.finalValid);
   const state=blocked?'blocked':tokens.final?'matched':'pending';panel.dataset.state=state;
   const title=blocked?'Tokens don’t match':tokens.final?'Tokens match':'Initial token secured';
   const message=blocked?'Payment blocked':tokens.final?'Verified before payment':'Waiting for session 2';
   panel.innerHTML=`<div class="token-header"><div><span class="token-icon">${blocked?'×':tokens.final?'✓':'◇'}</span><strong>${title}</strong></div><span class="token-verdict" role="status">${message}</span></div>
    <div class="token-pair"><div class="token-column"><div class="token-label"><span>Initial token</span><span class="${tokens.initialValid?'signature-valid':'signature-invalid'}">${tokens.initialValid?'Signed ✓':'Invalid signature'}</span></div><pre aria-label="Initial token JSON">${escape(JSON.stringify(displayToken(tokens.initial),null,2))}</pre></div>
    <div class="token-column"><div class="token-label"><span>Final token</span><span class="${tokens.finalValid?'signature-valid':tokens.final?'signature-invalid':''}">${tokens.final?tokens.finalValid?'Signed ✓':'Invalid signature':'Pending'}</span></div><pre aria-label="Final token JSON" class="${tokens.final?'':'token-empty'}">${tokens.final?escape(JSON.stringify(displayToken(tokens.final),null,2)):'Generated after the browser fills checkout.'}</pre></div></div>
    ${tokens.final?`<div class="token-fields">${tokens.checks.map(check=>`<span class="${check.match?'field-match':'field-mismatch'}">${check.match?'✓':'×'} ${escape(check.label)}</span>`).join('')}</div>`:''}
    ${blocked?`<p class="token-note">Changed or invalid: ${escape(tokens.differences.join(', ')||'signature')}. No payment authorized.</p>`:''}`;
  }

  function update(data){
   showTokens(data.tokens);
   if(operator&&data.bookingId!==lastBooking){lastBooking=data.bookingId;lastSequence=-1;const frame=document.querySelector('#live-frame');frame.hidden=true;frame.removeAttribute('src');delete frame.dataset.sequence;document.querySelector('#waiting').hidden=false;document.querySelector('#summary-reference').textContent='';}
   const d=data.details;
   const trace=[...(d?.activity||[]),...(data.trace||[]).map(entry=>({at:entry.at,type:'browser',text:entry.stage}))].sort((a,b)=>a.at.localeCompare(b.at));
   const signature=JSON.stringify([d,trace]);
   if(signature!==detailsSignature){
    detailsSignature=signature;
    document.querySelector('#browser-location').textContent=d?.destination?`Simulated checkout · ${d.destination}`:'Agent browser';
    const atBottom=detailsPanel.childElementCount>0&&detailsPanel.scrollHeight-detailsPanel.scrollTop-detailsPanel.clientHeight<50;
    const previousScroll=detailsPanel.scrollTop;
    const bank=d?.bank;
    detailsPanel.innerHTML=`<div class="bank-balance-label">Available balance</div><div id="bank-balance" role="status">${money(d?.displayBalanceCents??d?.balanceCents??0)}</div>${bank?.accountLabel?`<p class="bank-account-number">${escape(bank.accountLabel)}</p>`:''}`;

    detailsPanel.scrollTop=atBottom?detailsPanel.scrollHeight:previousScroll;
   }
   document.querySelector('.live-window').dataset.state=data.status;
   document.querySelector('#stage').textContent=data.stage;
   if(operator)document.querySelector('#waiting').textContent=data.stage;
   const canClear=operator&&Boolean(data.bookingId)&&data.status!=='running';
   statusButton.disabled=true;statusButton.textContent=data.status.toUpperCase();
   statusButton.setAttribute('aria-label',`Agent status: ${data.status}`);
   resetButton.disabled=!canClear;
   resetButton.title=data.status==='running'?'Available when the agent finishes':'Clear the displayed session';
   if(data.frameUrl&&data.sequence!==lastSequence){lastSequence=data.sequence;const img=document.querySelector('#live-frame');img.src=data.frameUrl;img.hidden=false;document.querySelector('#waiting').hidden=true;img.dataset.sequence=String(data.sequence)}
   const complete=Boolean(data.confirmation);
   document.querySelector('#watch-summary').hidden=!complete;
   if(complete){document.querySelector('#summary-reference').textContent=data.confirmation.reference;document.querySelector('#live-frame').hidden=!data.frameUrl;document.querySelector('#waiting').hidden=true;document.querySelector('#watch-summary').hidden=Boolean(data.frameUrl);}
   document.querySelector('#result').textContent=data.confirmation?'Booking paid':data.bookingStatus==='REFUNDED'?'Contributions refunded':data.failure|| (d?.bank?`${d.bank.paidCount} of ${d.bank.participantCount} contributions received`:'Waiting for contributions');
  }
  if(operator){
   let closed=false;window.addEventListener('pagehide',()=>{closed=true});
   const poll=async()=>{try{renderOperator(await request('/api/monitor'))}catch{document.querySelector('.live-window').dataset.state='reconnecting';document.querySelector('#live-status').textContent='RECONNECTING'}finally{if(!closed)setTimeout(poll,600)}};
   void poll();
  }else try{update(await request(`/api/watch/${access}`));const events=new EventSource(`/api/watch/${access}/events`);events.addEventListener('session',event=>update(JSON.parse(event.data)));events.onerror=()=>{document.querySelector('.live-window').dataset.state='reconnecting';document.querySelector('#live-status').textContent='RECONNECTING'};window.addEventListener('pagehide',()=>events.close())}catch(error){root.textContent=error.message}
 }
}
