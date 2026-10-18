import {createServer} from 'node:http';
import {chmodSync} from 'node:fs';

// Filesystem-only control channel: never mounted on the public web server.
export function startControl(runtime,socketPath){
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST'||!req.url.startsWith('/bypass')){res.writeHead(404);res.end('{}');return}
    try{
      const url=new URL(req.url,'http://local');
      if(!['/bypass','/bypass_email'].includes(url.pathname))throw new Error('Unknown command.');
      const bookingId=url.searchParams.get('bookingId')||undefined;
      const result=await (url.pathname==='/bypass_email'?runtime.pipeline.bypassEmail(bookingId):runtime.pipeline.bypass(bookingId));
      res.end(JSON.stringify(result));
      setImmediate(()=>void runtime.pipeline.advance(result.bookingId).catch(e=>console.error('Booking:',e.message)));
    }catch(e){res.writeHead(e.status||400);res.end(JSON.stringify({error:e.message}));}
  });
  server.listen(socketPath,()=>chmodSync(socketPath,0o600));
  server.on('error',e=>console.error('Local control:',e.message));
  return server;
}
