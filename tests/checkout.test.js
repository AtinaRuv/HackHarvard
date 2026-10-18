import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const {run}=createRequire(import.meta.url)('../app/browser-worker.cjs');
test('checkout clicks through trip, guest and payment steps, verifies facts before receipt',async t=>{
 const executablePath=existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
 if(!existsSync(executablePath)){t.skip('No browser installed');return}
 const stages=[];let finalFrame;let verified=false;
 const facts={title:'Weekend group stay',listingId:'52266366',checkIn:'2026-11-13',checkOut:'2026-11-15',guests:2,totalCents:96000,currency:'USD',destination:'airbnb.com'};
 const result=await run({mode:'demo',phase:'final',reviewDelayMs:0,executablePath,facts,answers:{guestName:'Demo Guest',email:'demo@example.invalid'}},{chromium},{onFrame:({image,stage})=>{stages.push(stage);finalFrame=image},onQuote:async result=>{assert.equal(result.facts.totalCents,96000);assert.equal(result.facts.answers.guestName,'Demo Guest');assert.equal(result.facts.destination,'airbnb.com');assert.ok(!stages.some(s=>s.includes('complete. Returning')));assert.ok(stages.some(s=>s.startsWith('Checking final dates')));assert.ok(!stages.some(s=>s==='Completing the simulated booking.'));verified=true;writeFileSync('/tmp/leash-rich-checkout-review.png',Buffer.from(result.screenshot,'base64'));return {reference:'SIM-CHECKOUT-TEST'}}});
 assert.ok(verified);assert.ok(stages.some(s=>s.includes('Reviewing trip')));assert.ok(stages.some(s=>s.includes('Acknowledging')));assert.equal(stages.at(-1),'Simulated booking complete. Returning the confirmation.');assert.equal(result.facts.checkIn,facts.checkIn);writeFileSync('/tmp/leash-rich-checkout-receipt.jpg',finalFrame);
});

test('checkout enforces step order, payment timing and test-card completeness; editing guest count updates review',async t=>{
 const {fixture,initializeCheckout}=createRequire(import.meta.url)('../app/checkout.cjs');
 const executablePath=existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';if(!existsSync(executablePath)){t.skip('No browser installed');return}
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.setContent(fixture({facts:{title:'King Beds, Shed Bar, Sauna, Fenced Yard & L2 EV',listingId:'52266366',checkIn:'2026-11-13',checkOut:'2026-11-15',guests:2,totalCents:96000,destination:'airbnb.com'}}));await page.evaluate(initializeCheckout);
 await page.screenshot({path:'/tmp/leash-airbnb-style-checkout.png',fullPage:true});
 assert.equal(await page.locator('[data-jump=payment]').isDisabled(),true);
 await page.locator('[name=paymentTiming][value=later]').check();assert.equal(await page.locator('#review-next').isDisabled(),true);
 await page.locator('[name=paymentTiming][value=now]').check();await page.locator('#review-next').click();
 await page.locator('[name=paymentMethod][value=card]').check();await page.locator('#method-next').click();assert.match(await page.locator('#method-error').innerText(),/Complete all test card fields/);assert.equal(await page.locator('[data-panel=guest]').isVisible(),false);
 for(const [name,value] of Object.entries({testCard:'4242 4242 4242 4242',testExpiry:'12/30',testCvc:'123',billingZip:'02138'}))await page.locator(`[name=${name}]`).fill(value);
 await page.locator('#method-next').click();await page.locator('[name=guestName]').fill('Demo Guest');await page.locator('[name=email]').fill('demo@example.invalid');await page.locator('#guest-next').click();assert.equal(await page.locator('#complete').isDisabled(),true);
 await page.locator('[data-jump=review]').click();await page.locator('.trip-fields summary').click();await page.locator('[name=guests]').fill('3');await page.locator('[data-jump=payment]').click();assert.match(await page.locator('#review-trip').innerText(),/3 guests/);
 await page.locator('#price-toggle').click();assert.equal(await page.locator('#price-detail').isVisible(),true);
});
