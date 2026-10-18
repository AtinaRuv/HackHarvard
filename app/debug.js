import {appendFileSync,existsSync,renameSync,statSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';

export const runtimeBuild=createHash('sha256').update(readFileSync(new URL('./airbnb.cjs',import.meta.url))).digest('hex').slice(0,12);
export const fingerprint=value=>createHash('sha256').update(String(value||'')).digest('hex').slice(0,16);
export function messageDebug(body){
  const text=typeof body==='string'?body:body?.text||'';
  return {fingerprint:fingerprint(text),legacyWarning:/Heads up, this listing looks off:|That is too many red flags|Send me the listing link, or reply ok once I have quoted you\./.test(text)};
}
function redact(key,value){
  if(typeof value!=='string'||!['evidence','reason'].includes(key))return value;
  return value.replace(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/g,'[email]')
    .replace(/https?:\/\/[^\s)]+/g,raw=>{try{return new URL(raw).origin}catch{return '[url]'}})
    .replace(/(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g,'[number]');
}
// Deliberately excludes message bodies, participant contacts, emails and links
// containing access tokens. Keeps a bounded trace on this Mac, including restarts.
export class DebugLog {
  constructor(directory){this.file=join(directory,'debug.jsonl');this.runId=randomUUID();this.write('runtime_started',{pid:process.pid,runtimeBuild,listingFraudScreening:false});}
  write(type,details={}){
    try{
      if(existsSync(this.file)&&statSync(this.file).size>1024*1024)renameSync(this.file,this.file+'.1');
      appendFileSync(this.file,JSON.stringify({at:new Date().toISOString(),runId:this.runId,type,...details},redact)+'\n',{mode:0o600});
    }catch(error){console.error('Debug log:',error.code||'write failed');}
  }
}
