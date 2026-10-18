// Photon can resolve send() with a Message that Apple rejected. An RPC success
// is not proof that iMessage sent it. Delivery/read receipts are not required.
export async function verifyIMessageSend(space,result,{polls=3,pause=()=>new Promise(resolve=>setTimeout(resolve,250))}={}){
  if(!result)return result;
  if(result.content?.type==='group')for(const item of result.content.items||[])await verifyIMessageSend(space,item,{polls,pause});
  let current=result;
  for(let attempt=0;attempt<=polls;attempt++){
    if(Number(current.sendErrorCode)>0){
      throw Object.assign(new Error(`iMessage rejected the reply (Apple send error ${current.sendErrorCode}). Photon accepted the request but the message was not sent.`),{code:'IMESSAGE_SEND_FAILED',sendErrorCode:current.sendErrorCode,providerMessageId:result.id});
    }
    if(current.isSent===true||current.isDelivered===true)return result;
    // Non-iMessage transports and small test adapters have no native status.
    if(typeof current.isSent!=='boolean')return result;
    if(attempt===polls||!space.getMessage||!result.id)break;
    await pause();current=await space.getMessage(result.id)||current;
  }
  throw Object.assign(new Error('Photon accepted the reply, but iMessage has not confirmed sending it. Its outcome is unknown; it will not be resent automatically.'),{code:'IMESSAGE_SEND_PENDING',deliveryUnknown:true,providerMessageId:result.id});
}
