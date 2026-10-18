import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {fetchPublicHtml}=require('../daytona/security.js');
const cheerio=require('cheerio');
export const STAYNEST_ORIGIN='https://leash-staynest-demo.foggylyric64.chatgpt.site';
export const STAYNEST_MERCHANT='STAYNEST-MERCHANT-001';
const reviewedHash='18dc460b600c79d00b3ca892d14b777f1c128ea048790179da88e7250d2dac57';
export function staynestUrl(value){
 try{const u=new URL(value);if(u.origin!==STAYNEST_ORIGIN||u.username||u.password||u.search||u.hash)return null;
 const path=u.pathname.replace(/\/$/,'').replace(/\.html$/,'')||'/';
 if(!['/','/index','/legitimate','/malicious'].includes(path))return null;
 return STAYNEST_ORIGIN+(['/','/index'].includes(path)?'/legitimate':path);
 }catch{return null}
}
export function staynestQuote(booking,phase,body){
 if(phase==='initial'&&createHash('sha256').update(body).digest('hex')!==reviewedHash)throw Error('The reviewed StayNest demo changed. No contributions requested.');
 const $=cheerio.load(body.toString());
 const nodes=$('script[data-booking="merchantId"][type="application/json"]');
 if(nodes.length!==1)throw Error('StayNest payment recipient is missing or ambiguous.');
 const destination=JSON.parse(nodes.text()).merchantId;
 if(typeof destination!=='string'||!/^[A-Z0-9_-]{1,80}$/.test(destination))throw Error('StayNest payment recipient is invalid.');
 if(phase==='initial'&&destination!==STAYNEST_MERCHANT)throw Error('The trusted demo merchant changed.');
 const prices=$('[data-booking="price"]');
 const price=Number(prices.text());
 if(prices.length!==1||!Number.isFinite(price)||price<=0)throw Error('StayNest price is missing or ambiguous.');
 const nights=(Date.parse(booking.requested.checkOut)-Date.parse(booking.requested.checkIn))/86400000;
 if(!Number.isInteger(nights)||nights<1||nights>14||booking.requested.guests>4)throw Error('StayNest supports 1–14 nights and up to 4 guests.');
 return {...booking.requested,title:'Harbor View Loft · StayNest demo',listingId:'staynest-harbor-view-loft',listingUrl:booking.listingUrl,currency:'USD',totalCents:Math.round((price+(nights-1)*350)*100),destination};
}
export async function inspectStaynest(booking,phase){
 // Initial authorization is the reviewed legitimate artifact. Final observation
 // uses the submitted URL. Page instructions never define the trusted recipient.
 const url=phase==='initial'?STAYNEST_ORIGIN+'/legitimate':staynestUrl(booking.listingUrl);
 if(!url)throw Error('Unsupported StayNest demo URL.');
 const response=await fetchPublicHtml(url,[new URL(STAYNEST_ORIGIN).hostname]);
 if(response.httpRefresh)throw Error('StayNest redirect is not permitted.');
 return staynestQuote(booking,phase,response.body);
}
