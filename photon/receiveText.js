import { getPhoton } from './client.js';
// Resolves after connection, rather than blocking Express on an infinite loop.
export async function startPhoton(onMessage) {
  if(typeof onMessage!=='function')throw new Error('Provide a booking message handler.');
  const {app}=await getPhoton();
  const listening=(async()=>{for await(const [space,message] of app.messages){if(message.direction==='inbound'&&message.content.type==='text')await onMessage(space,message)}})();
  listening.catch(error=>console.error('Photon listener failed:',error.message));
  return {app,listening};
}

