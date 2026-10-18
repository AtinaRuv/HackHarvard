import {renderStatusCard} from './status-card.js';
import {fingerprint,messageDebug} from './debug.js';
import {verifyIMessageSend} from './delivery.js';

// iMessage can represent a pasted URL as a card or a multipart/reply message.
// Read only its URL/text; never fetch its layout, image or preview metadata.
export async function chatText(content,depth=0){
  if(!content||depth>8)return '';
  if(['text','markdown'].includes(content.type))return typeof content.text==='string'?content.text:'';
  if(['app','richlink'].includes(content.type)){
    const value=typeof content.url==='function'?await content.url():content.url;
    return typeof value==='string'||value instanceof URL?String(value):'';
  }
  if(content.type==='reply')return chatText(content.content?.content||content.content,depth+1);
  if(content.type==='group')return (await Promise.all((content.items||[]).map(item=>chatText(item.content||item,depth+1)))).filter(Boolean).join('\n');
  return '';
}

export class Messenger {
  constructor({ mode = 'demo', voice, renderCard=renderStatusCard,debug,photon } = {}) { this.mode = mode; this.voice = voice;this.renderCard=renderCard;this.debug=debug;this.photon=photon; this.spaces = new Map(); this.status = mode === 'demo' ? 'simulated' : 'disconnected'; }
  traceSpace(space){
    const messenger=this;
    return new Proxy(space,{get(target,key){
      if(key==='send')return async body=>{
        const summary=messageDebug(body),spaceId=fingerprint(target.id);
        messenger.debug?.write('chat_send_started',{spaceId,...summary});
        try{const result=await verifyIMessageSend(target,await target.send(body));messenger.debug?.write('chat_send_completed',{spaceId,...summary,providerId:fingerprint(result?.id)});return result}
        catch(error){messenger.status=error.sendErrorCode?'send_failed':messenger.status;messenger.debug?.write('chat_send_failed',{spaceId,...summary,errorCode:error.code||'SEND_FAILED',sendErrorCode:error.sendErrorCode});console.error('Photon reply:',error.message);throw error}
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }
  async connect(onMessage) {
    if (this.mode === 'demo') return;
    const {getPhoton}=await import('../photon/client.js');
    const {app,im}=await (this.photon?this.photon():getPhoton());this.app=app;this.im=im;this.status='connected';
    this.listener = (async () => {
      let dispatch=Promise.resolve();
      for await (const [space, message] of this.app.messages) {
        this.debug?.write('chat_observed',{spaceId:fingerprint(space.id),messageId:fingerprint(message.id),direction:message.direction,contentType:message.content.type,...messageDebug(message.content)});
        if(message.direction!=='inbound'&&messageDebug(message.content).legacyWarning)console.error('[Leash debug] Legacy warning observed. Check data/debug.jsonl for matching chat_send events from this runtime.');
        if (message.direction !== 'inbound' || !['text','markdown','richlink','app','reply','group','addMember'].includes(message.content.type) || !message.sender) continue;
        const traced=this.traceSpace(space);
        this.spaces.set(space.id, traced);
        // Drain events independently of slow sends, preserving arrival order
        // so a private reply cannot overtake creation of its group booking.
        dispatch=dispatch.then(async()=>{
          this.debug?.write('chat_handler_started',{messageId:fingerprint(message.id)});
          await onMessage(traced,message);
          this.debug?.write('chat_handler_completed',{messageId:fingerprint(message.id)});
        }).catch(error=>{
          this.debug?.write('chat_handler_failed',{messageId:fingerprint(message.id),errorCode:error.code||'HANDLER_FAILED'});
          console.error('Photon handler:',error.message);
        });
      }
      await dispatch;
    })().catch(error => { this.status = 'disconnected'; console.error('Photon listener:', error.message); });
  }
  async send(message, booking) {
    if (this.mode === 'demo') return { id: `sim_${message.key}` };
    if (message.kind === 'email') return this.email(message, booking);
    if (message.kind === 'call') {
      if (!this.voice) throw new Error('Photon voice is not configured. Set PHOTON_VOICE_TOKEN and PHOTON_VOICE_FROM.');
      return this.voice.call(message.to, message.body, { bookingId: booking.id, field: message.field });
    }
    if (!this.im) throw new Error('Photon iMessage is disconnected.');
    if (message.kind === 'group' && booking.spaceId) {
      const space = this.spaces.get(booking.spaceId);
      if (!space) throw new Error('Waiting for the group to reconnect after server restart.');
      if(message.statusCard){
        let image;
        try{image=await this.renderCard(message.statusCard)}catch(error){console.error('Status image rendering:',error.message);return space.send(message.body)}
        const {attachment}=await import('spectrum-ts');
        return space.send(attachment(image,{mimeType:'image/png',name:'leash-split.png'}));
      }
      return space.send(message.body);
    }
    const user = await this.im.user(message.to);
    return this.traceSpace(await this.im.space.create(user)).send(message.body);
  }
  async email(message, booking) {
    const token = process.env.PHOTON_EMAIL_API_KEY;
    const projectId = process.env.PHOTON_EMAIL_PROJECT_ID;
    const senderId = process.env.PHOTON_EMAIL_SENDER_ID;
    if (!token || !projectId || !senderId) throw new Error('Configure the Photon email project, API key, and verified sender ID.');
    const { Photon } = await import('@photon-ai/api');
    const photon = new Photon({ headers: { Authorization: `Bearer ${token}` } });
    const user = await photon.projects.createOrGetUser({ path: { id: projectId }, body: { platform: 'email', handle: message.to } });
    const key = `${booking.id}_${message.key}`;
    const space = await photon.projects.createOrGetSpace({ path: { id: projectId }, headers: { 'idempotency-key': `space_${key}` }, body: { platform: 'email', participantIds: [senderId, user.id] } });
    return photon.projects.sendMessage({ path: { id: projectId }, headers: { 'idempotency-key': `email_${key}` },
      body: { senderId, spaceId: space.id, content: { type: 'text', text: message.body, format: 'plain' }, email: { subject: message.subject } } });
  }
  async leave(booking) {
    if (this.mode === 'demo' || !booking.spaceId) return;
    const space = this.spaces.get(booking.spaceId);
    if (!space) throw new Error('Group is not connected.');
    await space.leave();
  }
  async stop() { await this.voice?.close(); if (this.app) await (await import('../photon/client.js')).stopPhoton(); }
}

export function createChatHandler(pipeline) {
  const db = pipeline.store.db;
  db.exec('CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS inbound_messages (id TEXT PRIMARY KEY, received_at TEXT NOT NULL)');
  const save = (id, draft) => db.prepare('INSERT INTO conversations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(draft));
  const drafts = () => db.prepare('SELECT id, body FROM conversations').all().map(r => ({ spaceId: r.id, ...JSON.parse(r.body) }));
  const handle=async (space, message) => {
    if(!message.id)return;
    const text=(await chatText(message.content)).trim();
    pipeline.messenger?.debug?.write('chat_normalized',{messageId:fingerprint(message.id),contentType:message.content.type,hasListingUrl:/https:\/\/(?:www\.)?airbnb\.com\/rooms\/\d+/i.test(text),empty:!text});
    if(!text&&message.content.type!=='addMember')return;
    const claimed=db.prepare('INSERT OR IGNORE INTO inbound_messages VALUES (?, ?)').run(`${message.platform||'imessage'}:${message.id}`,new Date().toISOString());
    if(!claimed.changes)return;
    const sender = message.sender.id || message.sender.address;
    const identities=[message.sender.id,message.sender.address].filter(Boolean);
    const belongs=b=>b.participants.some(p=>identities.includes(p.contact));
    let draft = drafts().find(d => d.spaceId === space.id);
    if (!draft && space.type === 'dm') {
      const owned = drafts().filter(d => d.bookingId && pipeline.store.get(d.bookingId).status === 'INTAKE' && (identities.includes(d.organizer)||belongs(pipeline.store.get(d.bookingId))));
      if (owned.length !== 1) { await space.send('Reply in the booking group so I know which trip you mean.'); return; }
      draft = owned[0];
    }
    if (!draft) {
      if (space.type !== 'group') { await space.send('Add me to your trip’s group chat to start.'); return; }
      const members = await space.getMembers();
      draft = { organizer: sender, members: members.map(m => ({ name: m.name || m.address || m.id, contact: m.address || m.id })), seen: [] };
    }
    const spaceId = draft.spaceId || space.id;
    if (draft.seen.includes(message.id)) return;
    if (!identities.includes(draft.organizer)&&space.type!=='dm') { await space.send('I’m collecting the listing details from the group organizer. Your payment link will arrive individually.'); return; }
    if (draft.bookingId) {
      const b = pipeline.store.get(draft.bookingId);
      if(/^(?:retry|try again|retry booking)[!.\s]*$/i.test(text)){
        if(space.type!=='group'){await space.send('Send retry in the booking group.');return;}
        try{const next=pipeline.retry(b.id);draft.bookingId=next.id;draft.seen.push(message.id);save(spaceId,draft);await pipeline.advance(next.id)}catch(error){await space.send(error.message)}
        return;
      }
      if(/^(?:\/?bypass|npm run bypass)[!.\s]*$/i.test(text)){
        if(space.type!=='group'){await space.send('Send bypass in the booking group.');return;}
        try{
          const result=await pipeline.bypass(b.id);
          await space.send(`Demo bypass applied. ${result.confirmed}/${result.total} payments confirmed. I’m completing the booking now.`);
          await pipeline.advance(b.id);
        }catch(error){await space.send(error.message);}
        return;
      }
      if (b.status !== 'INTAKE') {
        if(!/^(?:\/?status|update|any update|how(?:'s| is) (?:it|the booking)(?: going)?)[?!.\s]*$/i.test(text))return;
        const status={COLLECTING:`${b.participants.filter(p=>p.bankCredited).length}/${b.participants.length} payments confirmed.${b.participants.some(p=>!p.bankCredited)?` Still waiting for ${new Intl.ListFormat('en',{style:'long',type:'conjunction'}).format(b.participants.filter(p=>!p.bankCredited).map(p=>p.name))} to pay.`:' Everyone has paid.'}`,PREPARING:'I’m filling the booking details and calculating the total.',FINALIZING:`Everyone’s paid. Watch me complete the booking: ${pipeline.baseUrl}/watch/${b.access}`,COMPLETED:`Your simulated booking is complete. Reference ${b.confirmation?.reference}.`,REFUNDING:'I stopped the booking and am refunding everyone.',REFUNDED:'Everyone who paid has been refunded. No booking was made.',FAILED:`I couldn’t finish the listing check: ${b.failure}`,RECONCILIATION:'The simulated bank operation needs reconciliation. I haven’t confirmed a booking.'};
        await space.send(status[b.status]||'I’m working on your booking.');
        return;
      }
      const questions=pipeline.questions(b);
      const q=space.type==='dm'?questions.find(q=>q.scope==='private'&&identities.includes(q.contact)):questions.find(q=>q.scope!=='private');
      if(!q){await space.send(space.type==='dm'?'Your personal details are already saved. Shared booking questions stay in the group.':'Please reply to my private message with your email.');return;}
      if (q) {
        let answer = text;
        if (q.type === 'email') answer = text.match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/)?.[0] || text;
        if (q.type === 'date') { const parsed = new Date(text); if (Number.isFinite(parsed.valueOf())) answer = parsed.toISOString().slice(0, 10); }
        if (q.field === 'guestName') answer = text.replace(/^(?:book (?:it )?under|my name is|the name is)\s+/i, '');
        try{pipeline.answer(b.id, { [q.field]: answer })}catch(error){await space.send(error.message);return}
      }
      draft.seen.push(message.id); save(spaceId, draft);
      await pipeline.advance(b.id);
      if(space.type==='dm'){await space.send('Thanks, your email is saved.');return;}
      const next = pipeline.store.get(b.id);
      const question = pipeline.questions(next)[0];
      if(!question||next.status!=='INTAKE')await space.send(next.status==='COLLECTING'?'The final price is ready. I’ve sent everyone their share and a private payment link in iMessage.':next.status==='FAILED'?`I couldn’t finish the listing check: ${next.failure}`:'I’m checking the booking now.');
      return;
    }
    const match = text.match(/https:\/\/(?:www\.)?airbnb\.com\/rooms\/\d+[^\s]*/i);
    if (match) draft.listingUrl = match[0];
    const guests = text.match(/\b(\d{1,2})\s*(?:people|guests|attendees|of us)\b/i) || (draft.listingUrl && /^\d{1,2}$/.test(text) ? [text, text] : null);
    if (guests) draft.guests = Number(guests[1]);
    draft.seen.push(message.id); save(spaceId, draft);
    if (!draft.listingUrl) {
      if(!draft.listingPrompted){
        draft.listingPrompted=true;save(spaceId,draft);
        try{await space.send('I’ll organize the booking and collect everyone’s share. Send me the Airbnb listing link.')}
        catch(error){if(!error.deliveryUnknown){draft.listingPrompted=false;save(spaceId,draft)}throw error}
      }else if(/^(?:yo+|hey|hello|hi|ping|status|help|are you there)[?!.\s]*$/i.test(text)&&Date.now()-(draft.lastListingReminderAt||0)>30000){
        draft.lastListingReminderAt=Date.now();save(spaceId,draft);
        await space.send('I’m here. I haven’t received the listing URL—paste the Airbnb link as text.');
      }
      return;
    }
    draft.members = (await space.getMembers()).map(m => ({ name: m.name || m.address || m.id, contact: m.address || m.id }));
    draft.guests=draft.members.length;
    draft.members.sort((a, b) => Number(identities.includes(b.contact)) - Number(identities.includes(a.contact)));
    const booking = pipeline.create({ listingUrl: draft.listingUrl, guests: draft.guests, participants: draft.members, spaceId });
    draft.bookingId = booking.id; save(spaceId, draft);
    await pipeline.advance(booking.id);
  };
  const pending=new Map();
  return(space,message)=>{
    const sender=message.sender?.id||message.sender?.address;
    const identities=[message.sender?.id,message.sender?.address].filter(Boolean);
    const owned=space.type==='dm'?drafts().find(d=>d.bookingId&&pipeline.store.get(d.bookingId).status==='INTAKE'&&(identities.includes(d.organizer)||pipeline.store.get(d.bookingId).participants.some(p=>identities.includes(p.contact)))):null;
    const key=owned?.spaceId||space.id;
    const previous=pending.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>handle(space,message)).finally(()=>{if(pending.get(key)===next)pending.delete(key)});
    pending.set(key,next);return next;
  };
}
