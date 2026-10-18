import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
export function statusCardData(b){
  return{title:b.requested.title,checkIn:b.initialToken.checkIn,checkOut:b.initialToken.checkOut,totalCents:b.initialToken.totalCents,destination:b.initialToken.destination,status:b.status,reference:b.confirmation?.reference,deadline:b.collectionDeadline,participants:b.participants.map(p=>({name:p.name,amountCents:p.amountCents,paid:Boolean(p.bankCredited),status:p.status}))};
}
export function statusCardHtml(data){
  const date=value=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
  const paid=data.participants.filter(p=>p.paid).length;
  const remaining=data.participants.filter(p=>!p.paid).map(p=>p.name);
  const done=data.status==='COMPLETED',refunded=data.status==='REFUNDED';
  const state=done?'Booking confirmed':refunded?'Contributions refunded':`${paid} of ${data.participants.length} paid`;
  const waiting=remaining.length?`Waiting for ${new Intl.ListFormat('en').format(remaining)}.`:'Everyone has paid. Completing the booking.';
  const deadline=data.deadline?new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(data.deadline)):null;
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6e9f0}.card{width:520px;background:#101114;border:1px solid #292d35;border-radius:24px;overflow:hidden}.head{padding:28px 26px 23px}.label{font-size:10px;font-weight:600;letter-spacing:1.5px;color:#929298;text-transform:uppercase}h1{font-size:23px;letter-spacing:-.7px;font-weight:600;line-height:1.25;margin:12px 0 7px;overflow-wrap:anywhere}.sub{font-size:14px;color:#85858b}.rows{padding:7px 26px;border-top:1px solid #252a33}.row{display:flex;align-items:center;gap:12px;padding:14px 0;font-size:16px}.row+.row{border-top:1px solid #1e232b}.name{flex:1;overflow-wrap:anywhere}.amount{font-weight:600;font-variant-numeric:tabular-nums}.mark{font-size:10px;color:#9999a0;width:58px;text-align:right}.mark.paid{color:#7cabef}.foot{padding:18px 26px 25px}.limit{background:#181b21;border-radius:13px;padding:15px;font-size:12px;line-height:1.65;color:#7d899d}.limit strong{color:#c3cedf;font-weight:600}.state{margin-top:17px;background:#eceff5;color:#12151a;border-radius:13px;padding:16px;text-align:center;font-size:15px;font-weight:600}.waiting{font-size:12px;line-height:1.6;color:#86868c;text-align:center;margin:12px 0 0;overflow-wrap:anywhere}.simulation{font-size:9px;letter-spacing:.7px;text-transform:uppercase;color:#a2a2a8;margin-left:auto}</style></head><body><article class="card"><div class="head"><div style="display:flex;align-items:center"><span class="label">${done?'Stay confirmed':refunded?'Split refunded':'Split status'}</span><span class="simulation">Simulation</span></div><h1>${escape(data.title)}</h1><div class="sub">${escape(date(data.checkIn))} – ${escape(date(data.checkOut))} · ${escape(data.destination)} · ${money(data.totalCents)}</div></div><div class="rows">${data.participants.map(p=>`<div class="row"><span class="name">${escape(p.name)}</span><span class="amount">${money(p.amountCents)}</span><span class="mark ${p.paid?'paid':''}">${p.status==='refunded'?'Refunded':p.paid?'✓ Paid':'Pending'}</span></div>`).join('')}</div><div class="foot"><div class="limit">Only <strong>${escape(data.destination)}</strong>. At most <strong>${money(data.totalCents)}</strong>. One booking.${deadline?` Before <strong>${escape(deadline)}</strong>.`:''}</div><div class="state">${escape(state)}</div><p class="waiting">${escape(done?data.reference:refunded?'No booking was made.':waiting)}</p></div></article></body></html>`;
}
export async function renderStatusCard(data){
  const brave='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  const executablePath=process.env.BROWSER_EXECUTABLE||(!existsSync(chromium.executablePath())&&existsSync(brave)?brave:undefined);
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:520,height:900},deviceScaleFactor:2});
    await page.route('**/*',route=>route.abort());
    await page.setContent(statusCardHtml(data));
    return await page.locator('.card').screenshot({type:'png',omitBackground:true});
  }finally{await browser.close()}
}
