import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const client=require('../nessie/client.js');
const {summarizeContributions}=require('../payments/balance.js');

export class Bank {
  constructor({mode='demo'}={}){
    if(!['demo','nessie'].includes(mode))throw new Error('BANK_PROVIDER must be nessie or demo.');
    this.mode=mode;
  }
  shares(totalCents,count){
    if(!Number.isSafeInteger(totalCents)||!Number.isSafeInteger(count)||count<1||totalCents<count*50)throw new Error('Each payment share must be at least $0.50.');
    return Array.from({length:count},(_,index)=>Math.floor(totalCents/count)+(index<totalCents%count?1:0));
  }
  async create(booking){
    if(this.mode==='demo')return{accountId:`sim_${booking.id}`};
    if(!process.env.NESSIE_API_KEY||!process.env.NESSIE_CUSTOMER_ID)throw Object.assign(new Error('Configure NESSIE_API_KEY and NESSIE_CUSTOMER_ID. Nessie does not fall back to a local account.'),{code:'NESSIE_NOT_CONFIGURED'});
    const account=await client.createBookingAccount({customerId:process.env.NESSIE_CUSTOMER_ID,nickname:`Leash ${booking.id} · USD cents (1 unit = $0.01)`});
    return {...account,accountUnitCents:1};
  }
  async credit(booking,participant){
    if(this.mode==='demo')return{id:`credit_${participant.id}`,simulated:true};
    const result=await client.addContribution({accountId:booking.accountId,amountCents:participant.amountCents,amountUnitCents:booking.accountUnitCents??100,paymentId:participant.paymentIntent});
    const deposits=(await client.readAccountDeposits(booking.accountId)).map(d=>({...d,amount:d.amount*(booking.accountUnitCents??100)/100}));
    const summary=summarizeContributions({contributions:[{depositId:result.depositId,paymentId:participant.paymentIntent,amountCents:participant.amountCents}],deposits});
    if(summary.confirmedContributionCount!==1||summary.unmatchedContributionCount!==0)throw new Error('Nessie deposit was not confirmed. Reconciliation is required before retrying.');
    return{depositId:result.depositId,paymentId:participant.paymentIntent,amountCents:participant.amountCents,verified:true};
  }
  async spend(booking){
    if(this.mode==='demo')return{id:`spend_${booking.id}`,simulated:true};
    try{
      const contributions=booking.participants.map(p=>({depositId:p.bankDeposit?.depositId,paymentId:p.paymentIntent,amountCents:p.amountCents}));
      if(contributions.some(c=>!c.depositId))throw new Error('Unverified contributions.');
      const deposits=(await client.readAccountDeposits(booking.accountId)).map(d=>({...d,amount:d.amount*(booking.accountUnitCents??100)/100}));
      const summary=summarizeContributions({contributions,deposits});
      if(summary.unmatchedContributionCount||summary.confirmedContributionCount!==booking.participants.length||Math.round(summary.simulatedContributionBalance*100)!==booking.initialToken.totalCents)throw new Error('Mismatched contributions.');
    }catch{throw Object.assign(new Error('Nessie contributions could not be verified before spending. No withdrawal was sent.'),{code:'NESSIE_PRECHECK_FAILED'})}
    return client.subtractFromAccount({accountId:booking.accountId,amountCents:booking.initialToken.totalCents,amountUnitCents:booking.accountUnitCents??100,operationId:`spend_${booking.id}`});
  }
  async reverse(booking,participant){
    if(this.mode==='demo')return{id:`reverse_${participant.id}`,simulated:true};
    return client.subtractFromAccount({accountId:booking.accountId,amountCents:participant.amountCents,amountUnitCents:booking.accountUnitCents??100,operationId:`refund_${booking.id}_${participant.id}`});
  }
}
