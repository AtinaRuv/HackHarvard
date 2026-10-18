import {staynestUrl,inspectStaynest} from './staynest.js';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const worker = require('./browser-worker.cjs');

export class BookingBrowser {
  constructor({ provider = 'local', mode = 'demo', executablePath, live, debug,stepDelayMs=80 } = {}) { Object.assign(this, { provider, mode, executablePath,live,debug,stepDelayMs }); }
  async inspect(booking, phase, {commit}={}) {
    this.live?.start(booking.id,phase);
    const frame=update=>this.live?.frame(booking.id,phase,update);
    const input = { mode: this.mode, phase,stepDelayMs:this.stepDelayMs, url: booking.listingUrl, facts: { ...booking.requested, listingId: booking.listingId, listingUrl: booking.listingUrl, destination: 'airbnb.com' }, answers: booking.answers };
    if(staynestUrl(booking.listingUrl)){input.mode='staynest';input.facts=await inspectStaynest(booking,phase);}
    if (!staynestUrl(booking.listingUrl)&&['demo','airbnb-demo'].includes(this.mode) && phase === 'final') {
      if (booking.demoScenario === 'price') input.facts.totalCents += 10000;
      if (booking.demoScenario === 'destination') input.facts.destination = 'attacker.example';
      if (booking.demoScenario === 'dates') input.facts.checkOut = new Date(Date.parse(input.facts.checkOut) + 86400000).toISOString().slice(0, 10);
    }
    if (this.provider === 'local') {
      if (!['demo','staynest'].includes(input.mode)) throw new Error('Airbnb inspection requires the Daytona provider.');
      const playwright = require('playwright');
      const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
      const executablePath = this.executablePath || (!existsSync(playwright.chromium.executablePath()) && existsSync(brave) ? brave : undefined);
      return worker.run({ ...input, executablePath }, playwright,{onFrame:frame,onQuote:commit});
    }
    const { Daytona, Image } = require('@daytonaio/sdk');
    const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    let sandbox;
    const sandboxName=`leash-${booking.id}-${phase}-${Date.now()}`;
    try {
      sandbox = await daytona.create({ name: sandboxName, language: 'javascript', public: false, autoStopInterval: 2, autoDeleteInterval: 0, ttlMinutes: 10,
        ...(input.mode==='staynest'?{domainAllowList:new URL(booking.listingUrl).hostname}:this.mode!=='demo'?{domainAllowList:'airbnb.com,*.airbnb.com,muscache.com,*.muscache.com'}:{networkBlockAll:true}),
        ...(process.env.DAYTONA_BROWSER_SNAPSHOT?{snapshot:process.env.DAYTONA_BROWSER_SNAPSHOT}:{image: Image.base('mcr.microsoft.com/playwright:v1.64.0-noble').runCommands('npm install --prefix /opt/leash-browser --ignore-scripts --no-audit --no-fund playwright@1.64.0 cheerio@1.2.0')}) }, {timeout:240});
      input.playwrightPath = '/opt/leash-browser/node_modules/playwright';
      input.livePath='/tmp/live.json';input.quotePath='/tmp/quote.json';input.decisionPath='/tmp/decision.json';
      const uploads=await Promise.allSettled([
        ...[['app/browser-worker.cjs','worker.cjs'],['app/airbnb.cjs','airbnb.cjs'],['app/cursor.cjs','cursor.cjs'],['app/checkout.cjs','checkout.cjs'],['app/reserve.cjs','reserve.cjs']].map(([source,target])=>sandbox.fs.uploadFile(readFileSync(new URL(`../${source}`,import.meta.url)),`/tmp/${target}`)),
        sandbox.fs.uploadFile(Buffer.from(JSON.stringify(input)), '/tmp/input.json')
      ]);
      for(const result of uploads)if(result.status==='rejected')throw result.reason;
      let finished=false;let decisionSent=false;let commitError;
      const task=sandbox.process.executeCommand('NODE_PATH=/opt/leash-browser/node_modules node /tmp/worker.cjs /tmp/input.json /tmp/output.json', undefined, undefined, 240).finally(()=>{finished=true});
      const poll=(async()=>{
        while(!finished){
          try{frame(JSON.parse(Buffer.from(await sandbox.fs.downloadFile('/tmp/live.json')).toString()))}catch{}
          if(phase==='final'&&!decisionSent){
            let quote;try{quote=JSON.parse(Buffer.from(await sandbox.fs.downloadFile('/tmp/quote.json')).toString())}catch{}
            if(quote){decisionSent=true;let decision;try{decision=await commit(quote)}catch(error){commitError=error;decision={error:true}}
              await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(decision||{})),'/tmp/decision.json');}
          }
          if(!finished)await new Promise(resolve=>setTimeout(resolve,450));
        }
      })();
      let result;try{result=await task}finally{await poll}
      try{frame(JSON.parse(Buffer.from(await sandbox.fs.downloadFile('/tmp/live.json')).toString()))}catch{}
      if(commitError)throw commitError;
      if (result.exitCode !== 0) {
        let failure;try{failure=JSON.parse(Buffer.from(await sandbox.fs.downloadFile('/tmp/output.json')).toString()).error?.message}catch{}
        this.debug?.write('browser_failed',{bookingId:booking.id,listingId:booking.listingId,phase,reason:failure||'No extraction result'});
        throw new Error(failure||'Daytona could not extract a complete final price. No payment was requested.');
      }
      const output = await sandbox.fs.downloadFile('/tmp/output.json');
      return JSON.parse(Buffer.from(output).toString('utf8'));
    } catch(error) {
      if(!sandbox){try{sandbox=await daytona.get(sandboxName)}catch(lookup){if(lookup.statusCode!==404)throw new Error(`Sandbox startup failed; cleanup could not be confirmed for ${sandboxName}.`)}}
      throw error;
    } finally {
      if (sandbox) await daytona.delete(sandbox, 60, true);
    }
  }
}
