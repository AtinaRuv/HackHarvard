function listingUrlAllowed(value,input){
 try{const u=new URL(value),expected=new URL(input.url);if(u.origin!=='https://www.airbnb.com'||u.pathname!==expected.pathname||u.username||u.password)return false;
 return ['check_in','check_out','adults'].every(k=>!u.searchParams.has(k)||u.searchParams.get(k)===expected.searchParams.get(k));}catch{return false}
}
const cheerio=require('cheerio');
function readOnlyAirbnbPost(request){
 try{
  const u=new URL(request.url());if(u.origin!=='https://www.airbnb.com'||request.method()!=='POST')return false;
  if(u.pathname==='/api/v2/client_configs')return true;
  const match=u.pathname.match(/^\/api\/v3\/(StaysPdpSections|stayCheckout|SearchInputQuery)\/([a-f0-9]{64})$/);if(!match)return false;
  const body=request.postDataJSON();return body.operationName===match[1]&&!body.query&&body.extensions?.persistedQuery?.sha256Hash===match[2];
 }catch{return false}
}
function reserveUrlAllowed(value,input){
 try{const u=new URL(value);return u.origin==='https://www.airbnb.com'&&u.pathname===`/book/stays/${input.facts.listingId}`&&u.searchParams.get('checkin')===input.facts.checkIn&&u.searchParams.get('checkout')===input.facts.checkOut&&Number(u.searchParams.get('numberOfAdults'))===input.facts.guests}catch{return false}
}
function readReserveQuote(html,url,input,title){
 if(!reserveUrlAllowed(url,input))throw Error('Reserve page does not match the selected listing, dates and guests.');
 const $=cheerio.load(html);$('script,style,template,noscript,[hidden],[aria-hidden=true]').remove();$('[style]').each((_,el)=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr('style')))$(el).remove()});
 $('body *').append(' ');
 const text=$('body').text().replace(/\s+/g,' ').trim();
 if(/verify.*human|access denied|something went wrong|log in to continue/i.test(text))throw Error('Airbnb checkout requires login, a browser challenge, or is unavailable. No payment will be collected.');
 const totals=[...text.matchAll(/\bTotal\s*(?:\(\s*)?USD\b\s*\)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/gi)].map(m=>Math.round(Number(m[1].replaceAll(',',''))*100));
 if(!totals.length||new Set(totals).size!==1||!totals[0]||!/\bTaxes\b|taxes included|includes taxes/i.test(text))throw Error('Reserve page did not expose an unambiguous final USD total including taxes. No demo price was substituted.');
 const guestSummary=text.match(/\bGuests\s+(\d+)\s+adults?\b/i);
 const start=new Date(input.facts.checkIn+'T00:00:00Z'),end=new Date(input.facts.checkOut+'T00:00:00Z');
 const month=d=>d.toLocaleString('en-US',{month:'short',timeZone:'UTC'});
 const dates=text.match(/\bDates\s+(.{1,100}?)(?:Change|Guests)/i)?.[1]||'';
 const range=new RegExp(month(start)+'\\s+'+start.getUTCDate()+'\\s*[–—-]\\s*(?:'+month(end)+'\\s+)?'+end.getUTCDate()+',?\\s+'+end.getUTCFullYear(),'i');
 if(!guestSummary||Number(guestSummary[1])!==input.facts.guests||!range.test(dates))throw Error('Reserve page did not visibly confirm the selected dates and guest count.');
 const tax=text.match(/\bTaxes\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
 return {...input.facts,title,currency:'USD',totalCents:totals[0],...(tax?{taxCents:Math.round(Number(tax[1].replaceAll(',',''))*100)}:{}),answers:{...input.answers},destination:'airbnb.com'};
}
async function openReserve(page,input,publish,{clickTarget,fillField,installCursor}){
 const title=(await page.locator('h1').first().innerText()).trim();
 if(!title||/something went wrong|access denied/i.test(title))throw Error('The real listing could not be verified.');
 const reserve=page.getByRole('button',{name:/^Reserve$/i}).first();
 await clickTarget(page,reserve,publish,'Opening the real Airbnb Reserve page.');
 await page.waitForURL(url=>reserveUrlAllowed(url.href,input),{waitUntil:'domcontentloaded',timeout:25000});
 await page.evaluate(installCursor);
 await page.waitForFunction(()=>/Total\s*(?:\(\s*)?USD/i.test(document.body.innerText),{},{timeout:20000}).catch(()=>{});
 await publish('Reading the real Reserve page, selected trip, taxes, and final total.');
 for(const [name,value] of Object.entries(input.answers||{})){
  if(!['guestName','email'].includes(name))continue;
  const field=page.locator(`input[name="${name}"]`);
  if(await field.count()===1&&await field.isVisible())await fillField(page,name,value,publish);
 }
 let quote,lastError;
 const deadline=Date.now()+25000;
 do{try{quote=readReserveQuote(await page.content(),page.url(),input,title);break}catch(error){lastError=error;await page.waitForTimeout(500)}}while(Date.now()<deadline);
 if(!quote)throw lastError;
 await publish('Verified the Reserve total including taxes. No reservation has been submitted.');
 return quote;
}
module.exports={listingUrlAllowed,readOnlyAirbnbPost,reserveUrlAllowed,readReserveQuote,openReserve};
