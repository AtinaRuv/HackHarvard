import {test} from 'node:test';
import assert from 'node:assert/strict';
import {statusCardData,statusCardHtml} from '../app/status-card.js';
import {Messenger} from '../app/messenger.js';
import {resolveContents} from 'spectrum-ts';
const booking={id:'test',spaceId:'group',requested:{title:'Sunlit <Loft>'},initialToken:{checkIn:'2026-10-24',checkOut:'2026-10-26',totalCents:41200,destination:'airbnb.com'},status:'COLLECTING',participants:[{name:'Maya',email:'private@example.com',contact:'private-phone',amountCents:20600,status:'paid',bankCredited:true},{name:'Jonah',amountCents:20600,status:'unpaid'}]};
test('card snapshots expose shares and progress without private emails or payment links',()=>{
  const snapshot=statusCardData(booking),html=statusCardHtml(snapshot);
  assert.match(html,/Sunlit &lt;Loft&gt;/);assert.match(html,/1 of 2 paid/);assert.match(html,/Waiting for Jonah/);assert.match(html,/\$206.00/);
  assert.ok(!html.includes('private@example.com'));assert.ok(!html.includes('private-phone'));assert.ok(!html.includes('Approve my share'));
  const changed=structuredClone(booking);const before=statusCardData(changed);changed.participants[1].bankCredited=true;assert.equal(before.participants[1].paid,false);
});
test('group status sends a PNG attachment through Spectrum rather than a duplicate text message',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=','base64');
  const messenger=new Messenger({mode:'photon',renderCard:async()=>png});messenger.im={};const sent=[];
  messenger.spaces.set('group',{send:async content=>{sent.push(...await resolveContents([content]));return{id:'image'}}});
  await messenger.send({kind:'group',body:'Status',statusCard:statusCardData(booking)},booking);
  assert.equal(sent.length,1);assert.equal(sent[0].type,'attachment');assert.equal(sent[0].mimeType,'image/png');assert.deepEqual(await sent[0].read(),png);
});
