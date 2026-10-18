#!/usr/bin/env node
import {request} from 'node:http';
import {fileURLToPath} from 'node:url';

const socketPath=fileURLToPath(new URL('../.agent.lock/control.sock',import.meta.url));
const emailMode=process.argv.includes('--email');
const bookingId=process.argv.slice(2).find(arg=>arg!=='--email');
const req=request({socketPath,path:(emailMode?'/bypass_email':'/bypass')+(bookingId?'?bookingId='+encodeURIComponent(bookingId):''),method:'POST'},res=>{
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{
    try{
      const result=JSON.parse(body);
      if(res.statusCode!==200)throw new Error(result.error||'Bypass failed.');
      console.log(emailMode?`Email collection bypassed for ${result.bypassed} attendees. Continuing intake; payment is still required.`:`${result.confirmed}/${result.total} payments confirmed (${result.bypassed} bypassed). Continuing the booking. No Stripe charge was made for bypassed shares.`);
    }catch(e){console.error(e.message);process.exitCode=1;}
  });
});
req.setTimeout(120000,()=>req.destroy(new Error('Bypass timed out. Check booking status before retrying.')));
req.on('error',e=>{console.error(['ENOENT','ECONNREFUSED'].includes(e.code)?'Start the updated server with npm start, then run npm run bypass in another terminal.':e.message);process.exitCode=1;});
req.end();
