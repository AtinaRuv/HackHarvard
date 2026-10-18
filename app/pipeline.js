import {staynestUrl,STAYNEST_MERCHANT} from './staynest.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { airbnbUrl, sign, compare, validateFacts } from './tokens.js';

const opaque = () => randomBytes(24).toString('base64url');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const email = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const now = () => new Date().toISOString();
export class Pipeline {
  constructor({ store, browser, payments, bank, messenger, baseUrl, live, sendEmail = false, mode = 'demo',tokenDisplayMs=0 }) {
    Object.assign(this, { store, browser, payments, bank, messenger, baseUrl, live, sendEmail, mode,tokenDisplayMs });
    this.running = new Map();
    // Do not repeat external bank writes or browser sessions after an unknown
    // process exit. Refund collection instead; ambiguous debits need reconciliation.
    for (const b of store.all()) {
      // Retry only this pre-collection compatibility failure. Never migrate an
      // account that has received money or has an unknown bank operation.
      if(b.status==='FAILED'&&/^Nessie requires whole-dollar totals/.test(b.failure||'')&&b.balanceCents===0&&!b.bankOperation&&!b.bankReview&&b.participants.every(p=>p.status==='unpaid'&&!p.bankCredited&&!p.bankDeposit&&!p.session)){
        b.previousAccountId=b.accountId;delete b.accountId;delete b.accountUnitCents;delete b.failure;b.status='INTAKE';
        for(const m of b.outbox)if(m.key==='prepare_failed'&&m.status==='pending')m.status='answered';
        this.event(b,'compatibility_retry','Retrying the preliminary check with a cent-accurate simulated account.');store.save(b);
      }
      if (['PREPARING', 'FINALIZING'].includes(b.status)) {
        b.status = 'REFUNDING'; b.failure = 'The browser run was interrupted. Contributions will be refunded.'; store.save(b);
      }
      if (b.bankOperation?.status === 'started') {
        b.bankReview = true;
        b.status = b.bankOperation.kind === 'spend' ? 'RECONCILIATION' : 'REFUNDING';
        b.failure = 'A Nessie operation was interrupted; its outcome needs reconciliation.'; store.save(b);
      }
      if (b.participants.some(p => p.bankReverseStarted && !p.bankReversed)) { b.bankReview = true; store.save(b); }
      for(const message of b.outbox){if(message.status==='pending'&&message.statusCard){delete message.statusCard;store.save(b)}if(message.kind==='call'&&message.deliveryStarted&&message.status==='pending'){message.status='unknown';message.error='Server stopped during a phone call; it will not be dialed again automatically.';store.save(b)}}
    }
  }
  event(b, type, text) { b.events.push({ id: randomUUID(), at: now(), type, text }); }
  queue(b, key, kind, to, body, extra = {}) {
    if (!b.outbox.some(item => item.key === key)) b.outbox.push({ key, kind, to, body, ...extra, status: 'pending', attempts: 0 });
  }
  create(input) {
    const listingUrl = airbnbUrl(input.listingUrl);
    const url = new URL(listingUrl);
    const staynest=Boolean(staynestUrl(listingUrl));
    const participants = input.participants;
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > 50) fail('Provide 1–50 attendees.');
    if (new Set(participants.map(p => p.contact)).size !== participants.length) fail('Attendee contacts must be unique.');
    for (const p of participants) {
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || typeof p.contact !== 'string' || !p.contact || p.contact.length > 254) fail('Each attendee needs a name and contact.');
      if (p.email && !email(p.email)) fail('Provide a valid email for each attendee.');
    }
    const requested = {
      title: String(input.title || 'Airbnb group stay').slice(0, 160),
      checkIn: input.checkIn || url.searchParams.get('check_in'), checkOut: input.checkOut || url.searchParams.get('check_out'),
      guests: Number(input.guests || participants.length), currency: 'USD',
      totalCents: input.totalCents ?? (this.mode==='demo'?Number(process.env.DEMO_TOTAL_CENTS||96000):undefined), taxCents: input.taxCents || 0,
    };
    if (requested.guests !== participants.length) fail('Include all attendees so every share has a recipient.');
    if (this.mode === 'demo'&&requested.checkIn&&requested.checkOut) validateFacts(requested);
    if(this.mode==='demo'&&(!Number.isSafeInteger(requested.taxCents)||requested.taxCents<0||requested.taxCents>requested.totalCents))fail('Included taxes must be whole cents between zero and the final total.');
    const b = { id: randomUUID(), access: opaque(), createdAt: now(), status: 'INTAKE', listingUrl,
      listingId: staynest?'staynest-harbor-view-loft':/\/rooms\/(\d+)/.exec(url.pathname)[1], organizerContact: participants[0].contact, spaceId: input.spaceId || null,
      requested, demoScenario: this.mode === 'demo' ? input.demoScenario : null, answers: {}, participants: participants.map(p => ({ id: randomUUID(), access: opaque(), name: p.name.trim(), contact: p.contact, email: p.email || '', status: 'unpaid' })),
      balanceCents: 0, events: [], outbox: [], processedEvents: [], simulation: true };
    this.event(b, 'created', 'Group started. Opening a simulated booking account.');
    this.store.save(b);
    return b;
  }
  retry(id){
    const old=this.store.get(id);
    if(!['FAILED','REFUNDED'].includes(old.status)||old.balanceCents!==0||old.bankReview||old.bankOperation||old.participants.some(p=>p.status==='paid'||(p.bankCredited&&!p.bankReversed)))fail('Finish refund or bank reconciliation before retrying.',409);
    const fresh=this.create({...old.requested,listingUrl:old.listingUrl,spaceId:old.spaceId,participants:old.participants.map(p=>({name:p.name,contact:p.contact,email:p.email})),demoScenario:'normal'});
    this.answer(fresh.id,{...old.answers});
    this.store.change(fresh.id,b=>{b.previousBookingId=old.id;this.event(b,'retry','Starting a fresh attempt. Previous payments remain refunded; new payment links will be issued.')});
    return this.store.get(fresh.id);
  }
  questions(b) {
    const questions = [];
    if (!b.requested.checkIn) questions.push({field:'checkIn',text:'What date are you checking in? Please include the year (YYYY-MM-DD).',type:'date'});
    if (!b.requested.checkOut || (b.spaceId && !b.nightsConfirmed)) questions.push({field:'nights',text:'How many nights are you staying? You can also send your checkout date (YYYY-MM-DD).',type:'text'});
    if (!b.answers.guestName) questions.push({ field: 'guestName', text: 'Whose name should the booking be under?', type: 'text' });
    if (!b.answers.email) questions.push({ field: 'email', text: 'What’s your email for the booking confirmation?', type: 'email', scope:'private', contact:b.organizerContact });
    for (const p of b.participants.slice(1)) if (!p.email) questions.push({ field: `email:${p.id}`, text: 'What’s your email for the booking confirmation?', type: 'email', scope:'private', contact:p.contact });
    return questions;
  }
  answer(id, values) {
    return this.store.change(id, b => {
      if (b.status !== 'INTAKE') fail('Booking information is already frozen.', 409);
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('Answer must be 1–500 characters.');
        if (key === 'email' || key.startsWith('email:')) { if (!email(value)) fail('Provide a valid email address.'); }
        if (key === 'nights') {
          const match=value.trim().match(/^(\d+)\s*(?:nights?)?$/i);
          if(match){
            const nights=Number(match[1]);
            if(nights<1||nights>365) fail('Please enter between 1 and 365 nights.');
            if(!b.requested.checkIn) fail('Please provide your check-in date first.');
            b.requested.checkOut=new Date(Date.parse(b.requested.checkIn)+nights*86400000).toISOString().slice(0,10);
          }else if(/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) b.requested.checkOut=value.trim();
          else fail('How many nights? Reply with a whole number, such as “3 nights”, or a checkout date (YYYY-MM-DD).');
          b.nightsConfirmed=true;
        }
        else if (['checkIn', 'checkOut'].includes(key)) b.requested[key] = value.trim();
        else if (['guestName', 'email'].includes(key)) {b.answers[key] = value.trim();if(key==='email'&&!b.participants[0].email)b.participants[0].email=value.trim()}
        else if (key.startsWith('email:')) { const p = b.participants.find(p => p.id === key.slice(6)); if (!p) fail('Unknown attendee.'); p.email = value.trim(); }
        else fail('Unknown booking field.');
        for(const message of b.outbox)if(message.field===key&&message.status!=='sent')message.status='answered';
      }
      for(const field of ['checkIn','checkOut']) {
        const date=b.requested[field];
        if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)) fail('Please enter a valid date as YYYY-MM-DD.');
      }
      if(b.requested.checkIn&&b.requested.checkOut&&b.requested.checkOut<=b.requested.checkIn) fail('Checkout must be after check-in. Please enter a later date or a positive number of nights.');
      this.event(b, 'answer', 'Organizer supplied booking details.');
    });
  }
  async lock(id, fn) {
    const previous = this.running.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn).finally(() => { if (this.running.get(id) === run) this.running.delete(id); });
    this.running.set(id, run); return run;
  }
  async advance(id) {
    return this.lock(id, async () => {
      let b = this.store.get(id);
      if (b.status === 'INTAKE') b=this.store.change(id,b=>{for(const message of b.outbox)if(message.field==='guests'&&message.status==='pending')message.status='answered'});
      if (b.status === 'INTAKE') {
        if (!b.accountId && !b.bankOperation) {
          this.store.change(id, b => { b.bankOperation = { kind: 'create', status: 'started' }; });
          try {
            const account = await this.bank.create(b);
            b = this.store.change(id, b => { b.accountId = account.accountId;b.accountUnitCents=account.accountUnitCents??100; b.bankOperation = null; this.event(b, 'account', 'Simulated bank account created.'); });
          } catch(error) {
            if(error.code==='NESSIE_NOT_CONFIGURED'){
              return this.store.change(id,b=>{b.status='FAILED';b.bankOperation=null;b.failure=error.message;this.event(b,'configuration',error.message)});
            }
            b = this.store.change(id, b => { b.status = 'RECONCILIATION'; b.bankReview = true; b.failure = 'Could not confirm Nessie account creation. Check the account before retrying.'; });
            return b;
          }
        }
        const questions = this.questions(b);
        if (questions.length) {
          this.store.change(id, b => {
            const shared=questions.find(q=>q.scope!=='private');
            for(const q of shared?[shared]:questions){
              const privateQuestion=q.scope==='private';
              if(privateQuestion)for(const message of b.outbox)if(message.field===q.field&&message.kind==='group'&&message.status==='pending')message.status='answered';
              this.queue(b, `question_${privateQuestion?'private_':''}${q.field}`, !privateQuestion&&b.spaceId?'group':'text', privateQuestion?q.contact:b.spaceId||b.organizerContact, q.text, { field: q.field });
            }
            if(!shared&&b.spaceId)this.queue(b,'private_details','group',b.spaceId,'I’m collecting everyone’s email privately. Please reply to my direct message.');
          });
          await this.deliver(id); return this.store.get(id);
        }
        await this.prepare(id);
      }
      b = this.store.get(id);
      if (b.status === 'COLLECTING' && b.participants.every(p => p.status === 'paid')) await this.finalize(id);
      if (this.store.get(id).status === 'REFUNDING') await this.refund(id);
      await this.deliver(id);
      return this.store.get(id);
    });
  }
  token(b, result) {
    if (result.sourceUrl !== b.listingUrl) throw new Error('The browser was redirected from the original listing.');
    const facts = result.facts;
    if (facts.listingId !== b.listingId || facts.listingUrl !== b.listingUrl || facts.destination !== (staynestUrl(b.listingUrl)?STAYNEST_MERCHANT:'airbnb.com')) throw new Error('The listing or payment destination changed.');
    validateFacts(facts);
    if (facts.guests !== b.participants.length) throw new Error('The checkout guest count does not match the group.');
    return sign({ ...facts, bookingId: b.id }, this.store.secret);
  }
  async prepare(id) {
    let b = this.store.change(id, b => {
      const listing = new URL(b.listingUrl);
      if(!staynestUrl(b.listingUrl)){listing.searchParams.set('check_in',b.requested.checkIn);listing.searchParams.set('check_out',b.requested.checkOut);listing.searchParams.set('adults',String(b.requested.guests));}
      b.listingUrl=listing.href;
      b.status = 'PREPARING'; this.event(b, 'browser', 'Session 1: filling booking details and calculating the final total, including taxes.');
      this.queue(b,'preparing_group','group',b.spaceId||b.organizerContact,'I’m opening the listing and filling in your details. I’ll send everyone their share privately once I have the final price.');
      this.queue(b, 'preliminary_call', 'call', b.organizerContact, 'I’m checking your Airbnb listing and filling in the booking details. I’ll text you if I need an email address.'); });
    await this.deliver(id);
    try {
      const result = await this.browser.inspect(b, 'initial');
      const token = this.token(b, result);
      for (const key of ['checkIn', 'checkOut', 'guests']) if (token[key] !== b.requested[key]) throw new Error(`The listing returned a different ${key}.`);
      for (const [key, value] of Object.entries(b.answers)) if (token.answers?.[key] !== value) throw new Error('The browser did not retain the organizer’s answers.');
      if (token.totalCents < b.participants.length * 50) throw new Error('Each payment share must be at least $0.50.');
      const shares=this.bank.shares(token.totalCents,b.participants.length);
      const screenshot = Buffer.from(result.screenshot, 'base64');
      if (!screenshot.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('The browser did not return a PNG screenshot.');
      writeFileSync(resolve(this.store.directory, `${id}.png`), screenshot, { mode: 0o600 });
      b = this.store.change(id, b => {
        this.live?.finish(id,'waiting','Booking preview ready. Waiting for everyone’s payment.');
        b.requested.totalCents=token.totalCents;b.requested.title=token.title;b.requested.taxCents=token.taxCents;
        b.initialToken = token; b.screenshot = `${id}.png`; b.status = 'COLLECTING'; b.collectionDeadline = Date.now() + 30 * 60 * 1000;
        b.participants.forEach((p, index) => { p.amountCents = shares[index];
          this.queue(b, `share_${p.id}`, 'text', p.contact, `${p.name}, your share is $${(p.amountCents / 100).toFixed(2)}. See the finalized booking screenshot and pay here: ${this.baseUrl}/pay/${p.access}`); });
        this.queue(b,'split_status','group',b.spaceId||b.organizerContact,`Split ready: $${(token.totalCents/100).toFixed(2)} across ${b.participants.length} people. Payment links sent privately.`);
        this.event(b, 'collecting', 'Initial token signed and screenshot saved. Session 1 closed. Individual payment links sent.');
      });
    } catch (error) {
      this.store.change(id, b => { this.live?.finish(id,'failed',error.message);b.status = 'FAILED'; b.failure = error.message; this.event(b, 'failed', error.message); this.queue(b, 'prepare_failed', 'text', b.organizerContact, `I couldn’t finish the preliminary booking check: ${error.message.replace(/\s*No payments? (?:have been|was) requested\.?/gi,'').trim()} No payment was requested.`); });
    }
  }
  async checkout(access) {
    const { booking, participant } = this.lookupParticipant(access);
    return this.lock(booking.id, async () => {
      const b = this.store.get(booking.id); const p = b.participants.find(p => p.id === participant.id);
      if (b.status !== 'COLLECTING' || p.status !== 'unpaid') fail('This share is no longer accepting payments.', 409);
      if (p.session) return p.session;
      const session = await this.payments.checkout(b, p);
      this.store.change(b.id, b => { b.participants.find(p => p.id === participant.id).session = session; });
      return session;
    });
  }
  lookupParticipant(access) {
    for (const booking of this.store.all()) {
      const participant = booking.participants.find(p => p.access === access);
      if (participant) return { booking, participant };
    }
    fail('Payment link not found.', 404);
  }
  async paid(eventId, rawSession, {advance=true}={}) {
    const session = await this.payments.validateSession(rawSession);
    return this.recordPayment(eventId,session,{advance});
  }
  async bypassEmail(id) {
    const candidates=this.store.all().filter(b=>b.status==='INTAKE'&&(!id||b.id===id));
    if(candidates.length!==1)fail(candidates.length?'Multiple bookings are in intake. Use npm run bypass_email -- BOOKING_ID.':'No booking is waiting for intake details.',409);
    id=candidates[0].id;
    return this.lock(id,async()=>{
      let bypassed=0;
      this.store.change(id,b=>{
        if(b.status!=='INTAKE')fail('Booking intake has already finished.',409);
        if(!b.participants[0].email&&b.answers.email)b.participants[0].email=b.answers.email;
        for(const p of b.participants){
          if(!p.email){p.email=`demo-${p.id}@example.invalid`;p.emailBypassed=true;bypassed++;}
        }
        if(!b.answers.email)b.answers.email=b.participants[0].email;
        for(const message of b.outbox)if((message.field==='email'||message.field?.startsWith('email:'))&&message.status!=='sent')message.status='answered';
        this.event(b,'email_bypass','Missing email addresses skipped for the demo.');
        this.queue(b,'email_bypass_group','group',b.spaceId||b.organizerContact,'All emails collected. Payment is still required.');
      });
      return{bookingId:id,bypassed};
    });
  }
  async bypass(id) {
    const candidates=this.store.all().filter(b=>b.status==='COLLECTING'&&(!id||b.id===id));
    if(candidates.length!==1)fail(candidates.length?'Multiple bookings are collecting. Use npm run bypass -- BOOKING_ID.':'No booking is waiting for payments.',409);
    id=candidates[0].id;
    let bypassed=0;
    for(const participant of candidates[0].participants){
      const session=await this.lock(id,async()=>{
        const b=this.store.get(id),p=b.participants.find(p=>p.id===participant.id);
        if(b.status!=='COLLECTING'||p.status!=='unpaid')return null;
        // Close existing Stripe checkout before replacing it so an old link
        // cannot collect money for a share already funded by the demo bypass.
        if(p.session&&!p.session.bypassed&&this.payments.mode==='stripe'){
          let real=await this.payments.validateSession(p.session);
          if(real.payment_status==='paid')return{real};
          await this.payments.expire(p.session.id);
          real=await this.payments.validateSession(p.session);
          if(real.payment_status==='paid')return{real};
          if(real.status!=='expired')fail('Could not close the existing Stripe checkout. No bypass applied to this share.',409);
        }
        const session={id:`bypass_${p.id}`,metadata:{bookingId:id,participantId:p.id},livemode:false,amount_total:p.amountCents,currency:'usd',payment_status:'paid',payment_intent:`pi_bypass_${p.id.replaceAll('-','')}`};
        this.store.change(id,b=>{b.participants.find(v=>v.id===p.id).session={id:session.id,bypassed:true};this.event(b,'bypass','Local demo payment bypass requested.');});
        return session;
      });
      if(!session)continue;
      if(session.real)await this.paid(`reconcile_${session.real.id}`,session.real,{advance:false});
      else{await this.recordPayment(`bypass_${participant.id}`,session,{advance:false,bypassed:true});bypassed++;}
    }
    const confirmed=this.store.get(id).participants.filter(p=>p.bankCredited).length;
    if(confirmed!==candidates[0].participants.length)fail('A simulated deposit could not be confirmed. Refund recovery will run automatically.',409);
    return{bookingId:id,bypassed,confirmed,total:candidates[0].participants.length};
  }
  async recordPayment(eventId,session,{advance=true,bypassed=false}={}) {
    const id = session.metadata?.bookingId;
    if (!id) fail('Checkout has no booking reference.');
    await this.lock(id, async () => {
      let b = this.store.get(id);
      if (b.processedEvents.includes(eventId)) return;
      const p = b.participants.find(p => p.id === session.metadata.participantId);
      if (!p || p.session?.id !== session.id || session.livemode !== false || session.payment_status !== 'paid' || session.amount_total !== p.amountCents || session.currency !== 'usd') fail('Checkout does not match the saved share.');
      const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!paymentIntent) fail('Checkout has no payment reference.');
      if (p.status !== 'unpaid') {
        this.store.change(id, b => { b.processedEvents.push(eventId); }); return;
      }
      b = this.store.change(id, b => {
        const p = b.participants.find(p => p.id === session.metadata.participantId);
        p.status = 'paid'; p.paymentIntent = paymentIntent; p.paidAt = now();p.paymentBypassed=bypassed; b.processedEvents.push(eventId);
        this.event(b, 'payment', `${p.name} paid their share.`);
        if (b.status !== 'COLLECTING') b.status = 'REFUNDING';
      });
      if (b.status === 'COLLECTING') {
        this.store.change(id, b => { b.bankOperation = { kind: 'credit', participantId: p.id, status: 'started' }; });
        try {
          const deposit=await this.bank.credit(b, b.participants.find(v=>v.id===p.id));
          b = this.store.change(id, b => {
            const person = b.participants.find(v => v.id === p.id); person.bankCredited = true;person.bankDeposit=deposit; b.balanceCents += p.amountCents; b.bankOperation = null;
            const paid=b.participants.filter(v=>v.bankCredited).length;
            const remaining=b.participants.filter(v=>!v.bankCredited).map(v=>v.name);
            const update=`${person.name} paid. ${paid}/${b.participants.length} payments confirmed.${remaining.length?` Still waiting for ${new Intl.ListFormat('en',{style:'long',type:'conjunction'}).format(remaining)} to pay.`:''}`;
            this.queue(b,`payment_progress_${p.id}`,'group',b.spaceId||b.organizerContact,update);
          });
        } catch {
          this.store.change(id, b => { b.bankReview = true; b.bankOperation.status = 'unknown'; b.status = 'REFUNDING'; b.failure = 'A Nessie deposit could not be confirmed. Automatically refunding all contributors.'; });
        }
      }
    });
    if(advance)await this.advance(id);
    return id;
  }
  async finalize(id) {
    let b = this.store.change(id, b => {
      if (b.balanceCents !== b.initialToken.totalCents) fail('The simulated bank balance does not match the booking total.', 409);
      b.status = 'FINALIZING'; this.event(b, 'browser', 'Session 2: filling the form again and comparing the final booking token.');
      this.queue(b,'watch_group','group',b.spaceId||b.organizerContact,`Everyone’s paid. I’m completing the booking now. Watch my browser live: ${this.baseUrl}/watch/${b.access}`);
    });
    await this.deliver(id);
    let committed=false;
    const commit=async result=>{
      let final,validationError;
      try{final=this.token(b,result)}catch(error){validationError=error;final={...result.facts,bookingId:b.id};}
      const comparison=compare(b.initialToken,final,this.store.secret);
      if(validationError){comparison.status='BLOCK';comparison.reason=validationError.message;}
      b=this.store.change(id,b=>{b.finalToken=final;b.comparison=comparison});
      this.live?.update?.(id,{stage:comparison.status==='OK'?'Tokens match. Signatures and all payment details verified before spending.':'Token mismatch. Payment blocked; preparing automatic refunds.'});
      if(this.tokenDisplayMs>0)await new Promise(resolve=>setTimeout(resolve,this.tokenDisplayMs));
      if(comparison.status==='BLOCK')throw validationError||new Error(`Final booking changed: ${comparison.differences.join(', ')}.`);
      this.store.change(id,b=>{b.bankOperation={kind:'spend',status:'started'}});
      let spending;
      try{spending=await this.bank.spend(b)}catch(error){
        if(error.code==='NESSIE_PRECHECK_FAILED'){
          this.store.change(id,b=>{b.bankOperation=null;b.status='REFUNDING';b.failure=error.message});throw error;
        }
        this.store.change(id,b=>{b.status='RECONCILIATION';b.bankReview=true;b.bankOperation.status='unknown';b.failure='Nessie debit outcome is unknown. No real Airbnb reservation was made.'});
        throw new Error('Nessie debit needs reconciliation.');
      }
      b=this.store.change(id,b=>{b.bankOperation=null;b.bankSpending=spending;b.balanceCents=0;b.confirmation={reference:`SIM-${b.id.slice(0,8).toUpperCase()}`,simulated:true,at:now()}});
      committed=true;return{reference:b.confirmation.reference};
    };
    try{
      const result=await this.browser.inspect(b,'final',{commit});
      // Injectable non-browser adapters can return facts directly in unit tests.
      if(!committed)await commit(result);
    }catch(error){
      const current=this.store.get(id);
      if(current.status==='RECONCILIATION'){this.live?.finish(id,'failed',current.failure);return}
      if(!committed){
        this.store.change(id,b=>{b.status='REFUNDING';b.failure=error.message;this.event(b,'blocked',`${error.message} Automatically refunding everyone.`);this.queue(b,'blocked_group','group',b.spaceId||b.organizerContact,b.comparison?.status==='BLOCK'?'The final booking details changed. I stopped the booking and am refunding everyone automatically.':'I couldn’t recheck the booking because the browser check failed. I stopped before payment and am refunding everyone automatically.')});
        this.live?.finish(id,'blocked','Final booking check failed. Refunding everyone.');return;
      }
      this.store.change(id,b=>{this.event(b,'stream_error','The booking completed, but the browser stream disconnected.')});
    }
    this.store.change(id, b => {
      b.status = 'COMPLETED';
      this.event(b, 'completed', 'Tokens matched. Simulated bank debited; simulated reservation confirmed. Session 2 closed.');
      for (const p of b.participants) {
        this.queue(b,`receipt_${p.id}`,'text',p.contact,`Your simulated Airbnb booking is complete. Reference ${b.confirmation.reference}. ${b.initialToken.checkIn} to ${b.initialToken.checkOut}. Your share: $${(p.amountCents/100).toFixed(2)}.`);
        if(this.sendEmail&&!p.emailBypassed)this.queue(b, `confirmation_${p.id}`, 'email', p.email,
          `${p.name}, your group stay is confirmed in simulation. Reference ${b.confirmation.reference}. ${b.listingUrl}\n${b.initialToken.checkIn} to ${b.initialToken.checkOut}. Your share: $${(p.amountCents / 100).toFixed(2)}.\nThis is a hackathon simulation, not an Airbnb reservation.`, { subject: `Simulated booking confirmed · ${b.confirmation.reference}` });
      }
      this.queue(b, 'group_confirmation', 'group', b.spaceId || b.organizerContact, `Booked in simulation! Reference ${b.confirmation.reference}. I’ve sent everyone their confirmation privately.`);
    });
    this.live?.finish(id,'completed','Simulated booking complete. Confirmations sent in iMessage.');
  }
  async refund(id) {
    let b = this.store.get(id);
    for (const p of b.participants) {
      if (p.status === 'unpaid' && p.session && !p.expired) {
        try { await this.payments.expire(p.session.id); this.store.change(id, b => { b.participants.find(x => x.id === p.id).expired = true; }); }
        catch { /* Webhooks for a concurrent successful payment still refund it. */ }
      }
      if (p.status !== 'paid' && p.status !== 'refunding') continue;
      try {
        const result = p.paymentBypassed ? {id:`bypass_refund_${p.id}`,status:'succeeded'} : p.refund?.status === 'succeeded' ? p.refund : p.refund?.id ? await this.payments.refundStatus(p.refund.id) : await this.payments.refund(b, p);
        if(['failed','canceled'].includes(result.status)){
          this.store.change(id,b=>{const person=b.participants.find(x=>x.id===p.id);person.failedRefunds??=[];person.failedRefunds.push({id:result.id,status:result.status});person.refundAttempt=(person.refundAttempt||0)+1;delete person.refund;person.status='paid';this.event(b,'refund_retry',`Refund for ${person.name} failed; a new refund attempt will be made automatically.`)});
          continue;
        }
        this.store.change(id, b => { const person = b.participants.find(x => x.id === p.id); person.refund = { id: result.id, status: result.status }; person.status = result.status === 'succeeded' ? 'refunded' : 'refunding'; });
        // A bank reversal is separate from returning the Stripe test payment.
        if (result.status === 'succeeded' && p.bankCredited && !p.bankReversed && !p.bankReverseStarted) {
          this.store.change(id, b => { b.participants.find(x => x.id === p.id).bankReverseStarted = true; });
          try {
            await this.bank.reverse(b, p);
            this.store.change(id, b => { b.participants.find(x => x.id === p.id).bankReversed = true; b.balanceCents -= p.amountCents; });
          } catch { this.store.change(id, b => { b.bankReview = true; }); }
        }
        if (result.status === 'succeeded') this.store.change(id, b => { this.queue(b, `refund_${p.id}`, 'text', p.contact, `Your $${(p.amountCents / 100).toFixed(2)} contribution was refunded because the booking could not be completed safely.`); });
      } catch { this.store.change(id, b => { this.event(b, 'refund_retry', `Refund for ${p.name} is pending and will retry automatically.`); }); }
    }
    b = this.store.get(id);
    if (b.participants.every(p => p.status === 'refunded' || p.status === 'unpaid')) {
      this.store.change(id, b => {
        b.status = 'REFUNDED';this.queue(b,'refunded_group','group',b.spaceId||b.organizerContact,'Everyone who paid has now been refunded. No booking was made.');this.event(b, 'refunded', 'All collected contributions refunded. No booking was made.');
      });
      this.live?.finish(id,'refunded','All collected contributions refunded. No booking was made.');
    }
  }
  async deliver(id) {
    const b = this.store.get(id);
    for (const message of b.outbox) {
      if (['sent','answered','unknown'].includes(message.status) || (message.nextAttemptAt && Date.now() < message.nextAttemptAt)) continue;
      try {
        if(message.kind==='call'&&this.messenger.voice)this.store.change(id,b=>{b.outbox.find(m=>m.key===message.key).deliveryStarted=true});
        const result = await this.messenger.send(message, b);
        this.store.change(id, b => { const m = b.outbox.find(m => m.key === message.key); m.status = 'sent'; m.providerId = result?.id; m.sentAt = now(); delete m.error; });
      } catch (error) {
        this.store.change(id, b => { const m = b.outbox.find(m => m.key === message.key); m.status = error.deliveryUnknown||(m.kind==='call'&&m.deliveryStarted)?'unknown':'pending'; m.attempts++; m.error = error.message;if(error.providerMessageId)m.providerId=error.providerMessageId; m.nextAttemptAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(m.attempts, 6)); });
      }
    }
    const current = this.store.get(id);
    if (current.status === 'COMPLETED' && current.outbox.filter(m=>['email','group'].includes(m.kind)).every(m => m.status === 'sent') && !current.leftGroup) {
      try { await this.messenger.leave(current); this.store.change(id, b => { b.leftGroup = true; this.event(b, 'left', 'Confirmations sent. Agent left the group chat.'); }); }
      catch (e) { this.store.change(id, b => { b.leaveError = e.message; }); }
    }
  }
  async tick() {
    if(this.ticking)return;
    this.ticking=true;
    try {
    for (let b of this.store.all()) {
      // Retrieve saved sessions directly from Stripe as a fallback when webhook
      // delivery is unavailable. A return URL or browser flag never proves payment.
      if (this.payments.mode === 'stripe') {
        for (const p of b.participants.filter(p => p.status === 'unpaid' && p.session?.id && !p.session.bypassed)) {
          if (p.session.expiresAt && Date.now() > p.session.expiresAt + 86400000) continue;
          try {
            const session = await this.payments.validateSession(p.session);
            if (session.payment_status === 'paid') await this.paid(`reconcile_${session.id}`, session, {advance:false});
          } catch { /* Retry reads next tick; never infer payment from a redirect. */ }
        }
      }
      b=this.store.get(b.id);
      if (b.status === 'COLLECTING' && (Date.now() > b.collectionDeadline || b.participants.some(p => p.status === 'unpaid' && p.session?.expiresAt < Date.now()))) this.store.change(b.id, b => { b.status = 'REFUNDING'; b.failure = 'The group did not finish paying before the deadline.'; });
      if (['INTAKE', 'COLLECTING', 'REFUNDING', 'COMPLETED', 'REFUNDED'].includes(this.store.get(b.id).status)) {
        try { await this.advance(b.id); } catch { /* Persisted state remains available for the next tick. */ }
      }
    }
    } finally {this.ticking=false}
  }
}
