import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {reserveUrlAllowed,readReserveQuote}=createRequire(import.meta.url)('../app/reserve.cjs');
const input={facts:{listingId:'52266366',listingUrl:'https://www.airbnb.com/rooms/52266366',checkIn:'2026-11-13',checkOut:'2026-11-15',guests:1},answers:{guestName:'Demo'}};
const url='https://www.airbnb.com/book/stays/52266366?checkin=2026-11-13&checkout=2026-11-15&numberOfAdults=1';
test('Reserve preview is limited to the exact selected listing and trip',()=>{assert.ok(reserveUrlAllowed(url,input));assert.ok(!reserveUrlAllowed(url.replace('numberOfAdults=1','numberOfAdults=2'),input));assert.ok(!reserveUrlAllowed(url.replace('www.airbnb.com','evil.example'),input));assert.ok(!reserveUrlAllowed(url.replace('/book/stays/','/payments/'),input))});
test('Reserve quote uses the tax-inclusive USD total, never a nightly or demo amount',()=>{const quote=readReserveQuote('<body><h1>Request to book</h1><div>Dates Nov 13–15, 2026 Change Guests 1 adult Change</div><div>Taxes</div><span>$76.30</span><div>Total</div><span>USD</span><b>$604.30</b></body>',url,input,'Listing');assert.equal(quote.totalCents,60430);assert.equal(quote.taxCents,7630);assert.throws(()=>readReserveQuote('<body>$264 per night</body>',url,input,'Listing'),/final USD total/);assert.throws(()=>readReserveQuote('<body>Something went wrong Taxes $0 Total USD $960</body>',url,input,'Listing'),/unavailable/);assert.throws(()=>readReserveQuote('<body>Taxes $0 Total USD $600 Total USD $900</body>',url,input,'Listing'),/unambiguous/)});

test('only named persisted read queries can use POST; booking mutations are blocked',()=>{
 const {readOnlyAirbnbPost}=createRequire(import.meta.url)('../app/reserve.cjs');const hash='a'.repeat(64);
 const request=(operation='StaysPdpSections',body={operationName:operation,extensions:{persistedQuery:{sha256Hash:hash}}})=>({url:()=>`https://www.airbnb.com/api/v3/${operation}/${hash}`,method:()=>'POST',postDataJSON:()=>body});
 assert.equal(readOnlyAirbnbPost(request()),true);assert.equal(readOnlyAirbnbPost(request('stayCheckout')),true);assert.equal(readOnlyAirbnbPost(request('CreateReservation')),false);assert.equal(readOnlyAirbnbPost(request('StaysPdpSections',{operationName:'StaysPdpSections',query:'mutation { charge }'})),false);
});

test('listing URL normalization is allowed without permitting another listing or trip',()=>{
 const {listingUrlAllowed}=createRequire(import.meta.url)('../app/reserve.cjs');const input={url:'https://www.airbnb.com/rooms/52266366?check_in=2026-11-13&check_out=2026-11-15&adults=2'};
 assert.equal(listingUrlAllowed(input.url+'&guestCurrency=USD',input),true);assert.equal(listingUrlAllowed('https://www.airbnb.com/rooms/52266366',input),true);
 assert.equal(listingUrlAllowed(input.url.replace('adults=2','adults=3'),input),false);assert.equal(listingUrlAllowed(input.url.replace('/52266366','/123'),input),false);assert.equal(listingUrlAllowed(input.url.replace('www.airbnb.com','evil.example'),input),false);
});
