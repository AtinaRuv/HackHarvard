import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const {run}=createRequire(import.meta.url)('../app/browser-worker.cjs');

test('Reserve starts promptly when listing has no total and checkout images are still loading',async()=>{
 const executablePath=process.env.BROWSER_EXECUTABLE||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
 const checkout='https://www.airbnb.com/book/stays/52266366?checkin=2026-11-13&checkout=2026-11-15&numberOfAdults=1';
 const browser=await chromium.launch({headless:true,executablePath});
 const context=await browser.newContext();
 // Deterministic pages exercise the worker's readiness logic without Airbnb/network variability.
 await context.route('**/*',async route=>{
  if(route.request().url().endsWith('/slow-image')){await new Promise(resolve=>setTimeout(resolve,12000));return route.abort().catch(()=>{});}
  const reserve=route.request().url().includes('/book/stays/');
  await route.fulfill({contentType:'text/html; charset=utf-8',body:reserve?'<h1>Request to book</h1><p>Dates Nov 13–15, 2026 Change Guests 1 adult Change</p><p>Taxes $76.30 Total USD $604.30</p><img src="/slow-image">':`<h1>Test listing</h1><button onclick="location.href='${checkout}'">Reserve</button><div style="height:15000px">Listing without a price summary</div>`});
 });
 const wrappedContext=new Proxy(context,{get(target,key){if(key==='route')return async()=>{};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const wrappedBrowser=new Proxy(browser,{get(target,key){if(key==='newContext')return async()=>wrappedContext;const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 let readingAt,reserveAt;
 try{
  const result=await run({mode:'airbnb-reserve',phase:'initial',reviewDelayMs:0,url:'https://www.airbnb.com/rooms/52266366?check_in=2026-11-13&check_out=2026-11-15&adults=1',facts:{listingId:'52266366',checkIn:'2026-11-13',checkOut:'2026-11-15',guests:1},answers:{}},{chromium:{launch:async()=>wrappedBrowser}},{onFrame:({stage})=>{if(stage==='Reading the Airbnb listing and selected dates.')readingAt??=Date.now();if(stage==='Opening the real Airbnb Reserve page.')reserveAt??=Date.now();}});
  assert.equal(result.facts.totalCents,60430);
  assert.ok(reserveAt-readingAt<5000,`Reserve took ${reserveAt-readingAt}ms after listing readiness`);
 }finally{await browser.close();}
});
