// This fixed program runs in a fresh browser for each pass. Page content never
// becomes code or model instructions. No Airbnb reservation is submitted.
const fs = require('node:fs');
const {listingUrlAllowed,reserveUrlAllowed,openReserve,readOnlyAirbnbPost}=require('./reserve.cjs');
const {installCursor,cursorAction,moveTo,clickTarget,fillField,scrollListing}=require('./cursor.cjs');

const {fixture,initializeCheckout}=require('./checkout.cjs');

async function run(input, { chromium }, { onFrame, onQuote } = {}) {
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}) });
  let context;
  let captureTimer;
  let capturing=false;
  let stage='Opening the browser';
  let page;
  async function capture() {
    if(capturing||!page||page.isClosed())return;
    capturing=true;
    try {
      const image=await page.screenshot({type:'jpeg',quality:65,timeout:5000});
      if(onFrame)await onFrame({image,stage});
      if(input.livePath){fs.writeFileSync(input.livePath+'.tmp',JSON.stringify({image:image.toString('base64'),stage}));fs.renameSync(input.livePath+'.tmp',input.livePath)}
    }catch{}finally{capturing=false}
  }
  async function progress(text){stage=text;await capture()}
  async function review(text,delay=900){await progress(text);await page.waitForTimeout(input.reviewDelayMs??delay)}
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1800 }, javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false, locale:'en-US', permissions:[] });
    await context.addInitScript(installCursor);
    page = await context.newPage();
    captureTimer=setInterval(()=>void capture(),600);captureTimer.unref();
    if(input.phase==='final')await progress('All contributions collected. Opening a fresh browser to re-enter and verify the booking.');
    let html;
    let sourceUrl = input.url;
    if (input.mode === 'demo') html = fixture(input);
    else {
      // This path is used only inside a private Daytona sandbox with an
      // independent network-layer allowlist. Untrusted site JavaScript may run
      // there, but it receives no backend keys, bank access or payment tools.
      await context.route('**/*', async route => {
        const request=route.request();const url=new URL(request.url());
        const allowed=url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
          /(^|\.)(airbnb\.com|muscache\.com)$/.test(url.hostname)&&(request.method()==='GET'||(input.mode==='airbnb-reserve'&&readOnlyAirbnbPost(request)));
        const reservePreview=input.mode==='airbnb-reserve'&&reserveUrlAllowed(request.url(),input);
        if(input.diagnostics&&!allowed)console.error('Blocked request',request.method(),url.hostname,url.pathname);
        if(!allowed||(!reservePreview&&/\/(?:book|reserve|payments?|checkout|confirm|purchase|login|signup)(?:\/|$)/i.test(url.pathname)))return route.abort();
        if(request.isNavigationRequest()&&(request.frame()!==page.mainFrame()||(!listingUrlAllowed(request.url(),input)&&!reservePreview)))return route.abort();
        try {
          let response=await route.fetch({maxRedirects:0,timeout:15000});
          let redirectBase=request.url();
          for(let hop=0;response.status()>=300&&response.status()<400&&hop<3;hop++){
            if(!request.isNavigationRequest())return route.abort();
            const location=response.headers().location;if(!location)return route.abort();
            const next=new URL(location,redirectBase).href;
            if(!listingUrlAllowed(next,input)&&!(input.mode==='airbnb-reserve'&&reserveUrlAllowed(next,input)))return route.abort();
            redirectBase=next;response=await route.fetch({url:next,maxRedirects:0,timeout:15000});
          }
          if(response.status()>=300&&response.status()<400)return route.abort();
          const headers={...response.headers()};delete headers['refresh'];
          if(request.isNavigationRequest())headers['content-security-policy']="default-src https: data: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; frame-src 'none'; base-uri 'self'";
          await route.fulfill({response,headers});
        }catch{await route.abort().catch(()=>{})}
      });
      await context.routeWebSocket('**/*',socket=>socket.close());
      let loaded=false,lastLoadError;
      for(let attempt=0;attempt<3;attempt++){
        try{
          const response=await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:25000});
          if(!response?.ok())throw Error(`Airbnb listing returned HTTP ${response?.status()??'unavailable'}.`);
          if(!listingUrlAllowed(page.url(),input))throw Error('Airbnb navigation changed the listing or selected trip.');
          loaded=true;break;
        }catch(error){lastLoadError=error;if(attempt<2){await progress('Airbnb did not finish loading. Retrying the same listing; no payment has been submitted.');await page.waitForTimeout(1000*(attempt+1))}}
      }
      if(!loaded)throw new Error(`Airbnb listing could not be loaded after three attempts: ${lastLoadError.message}`);
      await page.evaluate(installCursor);
      await progress('Reading the Airbnb listing and selected dates.');
      if(input.mode==='airbnb-reserve') {
        // The verified total is on Reserve, not necessarily on the listing.
        // Start as soon as the booking control is ready; do not tour the page.
        await page.getByRole('button',{name:/^Reserve$/i}).first().waitFor({state:'visible',timeout:15000});
      } else {
        // Other inspection modes extract their quote from the listing itself.
        await page.waitForFunction(()=>/total|taxes|verify.*human|access denied/i.test(document.body?.innerText||''),{},{timeout:15000})
          .catch(error=>{if(error.name!=='TimeoutError')throw error});
        await scrollListing(page,progress);
        for(const label of [/^Price details$/i,/^Show price breakdown$/i]){
          const button=page.getByRole('button',{name:label});
          if(await button.count()===1&&await button.isVisible())await clickTarget(page,button,progress,'Opening the price breakdown.');
        }
      }
    }
    if (input.mode === 'demo') {
      await context.route('**/*', route => route.abort());
      await page.setContent(html.replace(/<head\b[^>]*>/i, '$&<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'), { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(installCursor);
      await page.evaluate(initializeCheckout);
      await progress('Opened the simulated Airbnb checkout.');
      await clickTarget(page,page.locator('[name=paymentTiming][value=now]'),progress,'Choosing the full simulated payment.');
      await clickTarget(page,page.locator('.trip-fields summary'),progress,'Opening dates and guest details.');
      for(const key of ['checkIn','checkOut','guests'])await fillField(page,key,input.facts[key],progress);
      await clickTarget(page,page.locator('#review-next'),progress,'Reviewing trip dates and guest count.');
      await clickTarget(page,page.locator('[name=paymentMethod][value=pool]'),progress,'Selecting the pooled group account.');
      await clickTarget(page,page.locator('#method-next'),progress,'Confirming the simulated payment method.');
    }
    let facts;
    if (input.mode === 'demo') {
      for (const [key, value] of Object.entries(input.answers || {})) {
        if (!['email', 'guestName'].includes(key)) continue;
        await fillField(page,key,value,progress);
      }
      facts = await page.evaluate(() => ({
        checkIn: document.querySelector('[name=checkIn]').value,
        checkOut: document.querySelector('[name=checkOut]').value,
        guests: Number(document.querySelector('[name=guests]').value),
        totalCents: Number(document.querySelector('[data-total-cents]').dataset.totalCents),
        destination: document.querySelector('[data-destination]').dataset.destination,
        answers: Object.fromEntries(['email', 'guestName'].map(k => [k, document.querySelector(`[name="${k}"]`).value])),
      }));
      facts = { ...input.facts, ...facts, currency: 'USD' };
    } else {
      const { readQuote } = require('./airbnb.cjs');
      const quote = input.mode==='airbnb-reserve'
        ? await openReserve(page,input,progress,{clickTarget,fillField,installCursor})
        : input.mode==='airbnb-demo'
        ? {...input.facts,title:(await page.locator('h1').first().innerText({timeout:10000})).trim()}
        : readQuote(await page.content(), sourceUrl);
      // Carry a rendered listing photo into the offline checkout, without opening
      // an additional network path or sending guest details to the listing.
      try {
        const photos=page.locator('img[src*="muscache.com"]');
        for(let i=0;i<Math.min(await photos.count(),12);i++){
          const photo=photos.nth(i),box=await photo.boundingBox();
          if(box&&box.width>220&&box.height>150){quote.imageData='data:image/jpeg;base64,'+(await photo.screenshot({type:'jpeg',quality:75,timeout:3000})).toString('base64');break}
        }
      }catch{}
      await moveTo(page,page.locator('h1').first());await cursorAction(page,'reading');
      if(input.mode==='airbnb-demo')await progress('Real listing loaded. Using the configured simulated total for the demo checkout.');
      if(input.phase==='initial'&&['airbnb-demo','airbnb-reserve'].includes(input.mode)){
        facts={...quote,answers:{...input.answers}};
        await progress(input.mode==='airbnb-reserve'?'Reserve total verified. Saving the real checkout screenshot and initial token.':'Listing fetched. Saving its screenshot and initial token.');
      }else{
      if(input.phase==='final')await review('Real Reserve quote rechecked. Continuing in the isolated simulated payment checkout.',1200);
      // Simulation fills a local checkout with the independently re-read quote.
      // It never submits an Airbnb form or fabricates an Airbnb confirmation.
      // Stop all site activity before entering organizer details in the
      // simulated form. No real Airbnb form is submitted in either pass.
      await context.unroute('**/*');await context.route('**/*',route=>route.abort());
      await page.goto('about:blank');
      await page.setContent(fixture({ facts: quote }));
      await page.evaluate(installCursor);
      await page.evaluate(initializeCheckout);
      await clickTarget(page,page.locator('[name=paymentTiming][value=now]'),progress,'Choosing the full simulated payment.');
      await clickTarget(page,page.locator('.trip-fields summary'),progress,'Opening dates and guest details.');
      for(const key of ['checkIn','checkOut','guests'])await fillField(page,key,quote[key],progress);
      await review('Re-entered dates and guest count. Reviewing the trip before continuing.');
      await clickTarget(page,page.locator('#review-next'),progress,'Choosing pay in full.');
      await clickTarget(page,page.locator('[name=paymentMethod][value=pool]'),progress,'Selecting the pooled group account.');
      await review('Group account selected. Reviewing the simulated payment method.',700);
      await clickTarget(page,page.locator('#method-next'),progress,'Continuing to guest details.');
      for(const key of ['guestName','email'])await fillField(page,key,input.answers[key],progress);
      await review('Filled the simulated checkout with the organizer’s details.');
      const answers=await page.evaluate(()=>Object.fromEntries(['guestName','email'].map(key=>[key,document.querySelector(`input[name="${key}"]`).value])));
      facts = {...quote,answers,...await page.evaluate(()=>({checkIn:document.querySelector('[name=checkIn]').value,checkOut:document.querySelector('[name=checkOut]').value,guests:Number(document.querySelector('[name=guests]').value),totalCents:Number(document.querySelector('[data-total-cents]').dataset.totalCents),destination:document.querySelector('[data-destination]').dataset.destination}))};
      }
    }
    delete facts.imageData;
    if(await page.locator('#guest-next').isVisible().catch(()=>false)){
      await clickTarget(page,page.locator('#guest-next'),progress,'Reviewing the group payment and authorized recipient.');
      await clickTarget(page,page.locator('#price-toggle'),progress,'Reviewing the price breakdown.');
      await clickTarget(page,page.locator('#terms'),progress,'Acknowledging the simulated booking.');
    }
    await review(input.phase==='final'?'Checking final dates, amount, and payment destination against the original token.':'Final price calculated. Saving the checkout screenshot.');
    const screenshot = await page.screenshot({ type: 'png', fullPage: true, timeout: 15000 });
    const result={ facts, screenshot: screenshot.toString('base64'), sourceUrl, simulated: true };
    if(input.phase==='final'){
      let decision;
      if(onQuote)decision=await onQuote(result);
      else if(input.quotePath){
        fs.writeFileSync(input.quotePath+'.tmp',JSON.stringify(result));fs.renameSync(input.quotePath+'.tmp',input.quotePath);
        const deadline=Date.now()+60000;
        while(!fs.existsSync(input.decisionPath)){if(Date.now()>deadline)throw new Error('Final token decision timed out.');await new Promise(resolve=>setTimeout(resolve,200))}
        decision=JSON.parse(fs.readFileSync(input.decisionPath,'utf8'));
      }
      if(decision?.error)throw new Error('The backend blocked fulfillment.');
      if(decision?.reference)await completePage(page,{...input,reference:decision.reference},review);
    }
    clearInterval(captureTimer);
    while(capturing)await new Promise(resolve=>setTimeout(resolve,20));
    await capture();
    return result;
  } finally {
    clearInterval(captureTimer);
    while(capturing)await new Promise(resolve=>setTimeout(resolve,20));
    try { if (context) await context.close(); } finally { await browser.close(); }
  }
}
// Invoked only after the backend has checked the token and applied the fake debit.
async function completePage(page,input,publish){
  await publish('Tokens matched. Applying the simulated payment.');
  await page.evaluate(()=>{const button=document.querySelector('#complete');button.disabled=!document.querySelector('#terms').checked;button.textContent='Confirm simulated payment';button.onclick=()=>{const title=document.querySelector('[data-testid="listing-title"]').textContent;const amount=document.querySelector('[data-total-cents]').textContent;const main=document.querySelector('main');main.className='receipt';main.innerHTML='<div class="card"><span class="check">✓</span><h1>All set. Your group is going.</h1><p>Simulated booking completed successfully.</p><div class="blue success">Original and final booking tokens verified before payment.</div><div class="row line"><span>Stay</span><b id="receipt-title"></b></div><div class="row"><span>Simulated payment</span><b id="receipt-amount"></b></div><div class="row"><span>Confirmation</span><b id="reference"></b></div><p class="note">Simulation only. No Airbnb reservation was made.</p></div>';document.querySelector('#receipt-title').textContent=title;document.querySelector('#receipt-amount').textContent=amount}});
  await publish('Completing the simulated booking.');
  await clickTarget(page,page.locator('#complete'),publish,'Clicking complete simulated booking.');await page.locator('#reference').evaluate((node,ref)=>{node.textContent=ref},input.reference);
  await publish('Simulated booking complete. Returning the confirmation.');
}
module.exports = { run, fixture };
if (require.main === module) {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { chromium } = require(input.playwrightPath || 'playwright');
  run(input, { chromium }).then(output => fs.writeFileSync(process.argv[3], JSON.stringify(output||{})))
    .catch(error => { fs.writeFileSync(process.argv[3],JSON.stringify({error:{message:error.message}}));console.error('Browser extraction failed; see local diagnostics.'); process.exitCode = 1; });
}
