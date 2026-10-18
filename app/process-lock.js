import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function activeAgent(root, name='.agent.lock') {
  const directory=resolve(root,name);
  if(!existsSync(directory))return null;
  let owner;
  try{owner=JSON.parse(readFileSync(resolve(directory,'owner.json'),'utf8'))}catch{
    throw new Error('The agent lock is incomplete. Check for a running agent before removing .agent.lock.');
  }
  if(!Number.isInteger(owner.pid)||owner.pid<1)throw new Error('Invalid agent lock. Check for a running agent before removing .agent.lock.');
  try{process.kill(owner.pid,0);return owner}catch(error){if(error.code==='ESRCH')return null;throw error}
}

function acquireLock(root,name,label) {
  const directory=resolve(root,name);
  if(existsSync(directory)){
    const owner=activeAgent(root,name);
    if(owner)throw new Error(`${label} is already running (PID ${owner.pid}).`);
    rmSync(directory,{recursive:true});
  }
  try{mkdirSync(directory,{mode:0o700})}catch(error){if(error.code==='EEXIST')throw new Error('Another Leash process is starting. Only one agent may run.');throw error}
  const token=randomUUID();
  try{writeFileSync(resolve(directory,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600,flag:'wx'})}catch(error){rmSync(directory,{recursive:true,force:true});throw error}
  return()=>{
    try{const owner=JSON.parse(readFileSync(resolve(directory,'owner.json'),'utf8'));if(owner.pid===process.pid&&owner.token===token)rmSync(directory,{recursive:true,force:true})}catch{}
  };
}

export function acquireResetLock(root){return acquireLock(root,'.agent.reset.lock','Reset')}

export function acquireAgentLock(root) {
  const checkReset=()=>{
    if(existsSync(resolve(root,'.agent.reset.lock'))&&activeAgent(root,'.agent.reset.lock'))throw new Error('Leash is resetting. Wait for npm run reset to finish before starting the agent.');
  };
  checkReset();
  const release=acquireLock(root,'.agent.lock','Leash');
  try{checkReset()}catch(error){release();throw error}
  return release;
}
