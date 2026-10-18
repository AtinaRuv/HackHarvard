#!/usr/bin/env node
import { config, parse } from 'dotenv';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireResetLock } from '../app/process-lock.js';
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(project, '.env'), quiet: true });

export function resetTargets(root, configured = 'data') {
  root = realpathSync(root);
  const standard = resolve(root, 'data');
  const custom = resolve(root, configured);
  const targets = [...new Set([standard, custom])];
  for (const target of targets) {
    const path = relative(root, target);
    const top = path.split(sep)[0];
    if (!path || path.startsWith('..') || isAbsolute(path) || top.startsWith('.') ||
      ['app', 'public', 'tests', 'scripts', 'node_modules', 'photon', 'daytona', 'fraud', 'nessie', 'stripe'].includes(top)) {
      throw new Error('Refusing to reset a source, hidden, or external directory. DATA_DIR must be a runtime folder inside this project.');
    }
    // A symlink in any component must never redirect deletion elsewhere.
    let current = root;
    for (const part of path.split(sep)) {
      current = resolve(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Refusing to reset a symlinked runtime directory.');
    }
    if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error('Runtime path must be a directory.');
    if (existsSync(target) && target !== standard && !target.startsWith(standard + sep)) {
      const database = resolve(target, 'bookings.sqlite');
      if (!existsSync(database) || !readFileSync(database).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
        throw new Error('Custom DATA_DIR does not contain a recognized booking database. Nothing was deleted.');
      }
    }
  }
  // Deleting data/ already includes data/imessage/, live/, and verification/.
  return targets.filter(target => !targets.some(parent => target !== parent && target.startsWith(parent + sep)));
}

// Match project identity as well as entrypoint: unrelated Node apps are left alone.
const cleanToken=token=>token.replace(/^['"]|['"]$/g,'');
const entrypoint=token=>/(?:^|\/)(?:server|main|index|app|agent|bot|temp|listener|receiveText|sendText)(?:\.(?:[cm]?js|ts))?$/.test(cleanToken(token));
function repositoryId(value){
  if(typeof value!=='string')return null;
  const normalized=value.trim().replace(/^git\+/,'').replace(/^git@([^:]+):/,'https://$1/');
  try{const url=new URL(normalized);return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/,'').replace(/\/$/,'').toLowerCase()}`}catch{return null}
}
async function identity(cwd){
  let directory=realpathSync(cwd);
  while(true){
    if(existsSync(resolve(directory,'.git'))||existsSync(resolve(directory,'package.json'))){
      let repository;
      try{repository=repositoryId((await exec('git',['-C',directory,'config','--get','remote.origin.url'])).stdout)}catch{}
      let pkg;try{pkg=JSON.parse(readFileSync(resolve(directory,'package.json'),'utf8'))}catch{}
      repository ||= repositoryId(typeof pkg?.repository==='string'?pkg.repository:pkg?.repository?.url);
      let settings={};try{settings=parse(readFileSync(resolve(directory,'.env')))}catch{}
      const declared=[pkg?.main,...Object.entries(pkg?.scripts||{}).filter(([key])=>/^(?:start|dev|agent|listen)$/.test(key)).flatMap(([,value])=>String(value).match(/[\w./-]+\.(?:[cm]?js|ts)\b/g)||[])].filter(Boolean).map(path=>resolve(directory,path));
      return{root:directory,repository,projectId:settings.SPECTRUM_PROJECT_ID,projectSecret:settings.SPECTRUM_PROJECT_SECRET,photonProjectId:settings.PHOTON_PROJECT_ID,photonKey:settings.PHOTON_API_KEY,declared};
    }
    const parent=dirname(directory);if(parent===directory)return{root:cwd};directory=parent;
  }
}
export async function findAgents(root,{related=true}={}) {
  root=realpathSync(root);
  const own=await identity(root),cache=new Map();
  const {stdout}=await exec('ps',['-axo','pid=,ppid=,args='],{maxBuffer:8*1024*1024});
  const matches=[];
  for(const line of stdout.split('\n')){
    const row=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);if(!row)continue;
    const pid=Number(row[1]);if(pid===process.pid)continue;
    const command=row[3],tokens=command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)||[];
    if(!/^(?:.*\/)?(?:node|nodejs)$/.test(cleanToken(tokens[0]||'')))continue;
    const nodemonIndex=tokens.findIndex((token,index)=>index>0&&/(?:^|\/)nodemon(?:\.js)?$/.test(cleanToken(token)));
    const scripts=tokens.slice(1).filter(token=>entrypoint(token)||/\.(?:[cm]?js|ts)$/.test(cleanToken(token)));
    if(nodemonIndex<0&&!scripts.length)continue;
    let cwd;
    try{
      const result=await exec('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{maxBuffer:65536});
      cwd=result.stdout.split('\n').find(value=>value.startsWith('n'))?.slice(1);
      if(!cwd)throw new Error('Missing process working directory.');
      cwd=realpathSync(cwd);
    }catch(error){
      try{process.kill(pid,0)}catch(probe){if(probe.code==='ESRCH')continue;throw probe}
      throw new Error(`Cannot verify working directory of Node process ${pid}. Nothing was deleted.`);
    }
    // A supervisor is only an agent when it watches an identified agent entrypoint.
    const nodemonArgs=nodemonIndex<0?[]:tokens.slice(nodemonIndex+1).map(cleanToken);
    if(!cache.has(cwd))cache.set(cwd,await identity(cwd));
    const candidate=cache.get(cwd);
    const recognized=token=>entrypoint(token)||candidate.declared?.includes(resolve(cwd,cleanToken(token)));
    if(nodemonIndex>=0&&nodemonArgs.some(arg=>/\.(?:[cm]?js|ts)$/.test(arg))&&!nodemonArgs.some(recognized))continue;
    const sameCheckout=cwd===root||candidate.root===root;
    const sameRepository=own.repository&&own.repository===candidate.repository;
    const sameProject=(own.projectId&&own.projectSecret&&own.projectId===candidate.projectId&&own.projectSecret===candidate.projectSecret)||(own.photonProjectId&&own.photonKey&&own.photonProjectId===candidate.photonProjectId&&own.photonKey===candidate.photonKey);
    if(!sameCheckout&&(!related||(!sameRepository&&!sameProject)))continue;
    if(nodemonIndex<0&&!scripts.some(token=>{
      if(!recognized(token))return false;
      const path=relative(candidate.root,resolve(cwd,cleanToken(token)));
      return path&&!path.startsWith('..')&&!isAbsolute(path)&&!path.split(sep).includes('node_modules');
    }))continue;
    matches.push({pid,ppid:Number(row[2]),command,root:candidate.root,cwd});
  }
  return matches;
}

export async function stopAgents(root,{graceMs=4000,log=console.log,related=true}={}){
  const stopped=new Set();
  for(let wave=0;wave<3;wave++){
    let agents=await findAgents(root,{related});if(!agents.length)return [...stopped];
    const order=list=>list.sort((a,b)=>Number(list.some(p=>p.pid===a.ppid))-Number(list.some(p=>p.pid===b.ppid)));
    const signal=(list,name)=>{
      for(const agent of order(list)){
        try{process.kill(agent.pid,name);stopped.add(agent.pid);log(`${name==='SIGTERM'?'Stopping':'Force-stopping'} project agent ${agent.pid}.`)}catch(error){if(error.code!=='ESRCH')throw error}
      }
    };
    signal(agents,'SIGTERM');
    const deadline=Date.now()+graceMs;
    while(Date.now()<deadline){await pause(100);agents=await findAgents(root,{related});if(!agents.length)return [...stopped]}
    signal(await findAgents(root,{related}),'SIGKILL');
    const forcedDeadline=Date.now()+2000;
    while(Date.now()<forcedDeadline){await pause(100);if(!(await findAgents(root,{related})).length)return [...stopped]}
  }
  throw new Error('An agent keeps restarting. Runtime data was not deleted.');
}

export async function resetRuntime(root,{configured='data',graceMs=4000,log=console.log,related=true,stopOnly=false}={}){
  const targets=stopOnly?[]:resetTargets(root,configured);
  const release=acquireResetLock(root);
  const otherLocks=[];
  try{
    const otherRoots=[...new Set((await findAgents(root,{related})).map(agent=>agent.root))].filter(directory=>directory!==realpathSync(root));
    for(const directory of otherRoots)otherLocks.push(acquireResetLock(directory));
    const stopped=await stopAgents(root,{graceMs,log,related});
    if((await findAgents(root,{related})).length)throw new Error('A project agent is still active. Nothing was deleted.');
    if(!stopOnly)for(const target of targets)rmSync(target,{recursive:true,force:true});
    rmSync(resolve(root,'.agent.lock'),{recursive:true,force:true});
    return{stopped,targets:stopOnly?[]:targets};
  }finally{for(const unlock of otherLocks.reverse())unlock();release()}
}

export function remoteTargets(raw='[]'){
  let targets;try{targets=JSON.parse(raw)}catch{throw new Error('RESET_REMOTE_TARGETS must be a JSON array of {host, project}.')}
  if(!Array.isArray(targets)||targets.length>20)throw new Error('Configure at most 20 remote reset targets.');
  for(const target of targets){
    if(!target||typeof target.host!=='string'||!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target.host)||typeof target.project!=='string'||!isAbsolute(target.project)||target.project==='/'||/[\r\n\0]/.test(target.project))throw new Error('Remote targets need an SSH host and an absolute project checkout path.');
  }
  return targets;
}
export async function stopRemoteAgents(targets,{run=exec,log=console.log}={}){
  const results=await Promise.allSettled(targets.map(async target=>{
    const quoted="'"+target.project.replaceAll("'","'\\''")+"'";
    await run('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10',target.host,`npm --prefix ${quoted} run reset -- --local-only --stop-only`],{timeout:60000,maxBuffer:1024*1024});
    log(`Stopped configured remote agents on ${target.host}.`);
    return target.host;
  }));
  const failed=[];
  for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){
    failed.push(targets[i].host);log(`Could not stop remote agents on ${targets[i].host}. Check SSH access and install the updated reset script there.`);
  }
  return{stopped:results.filter(result=>result.status==='fulfilled').map(result=>result.value),failed};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run','--local-only','--stop-only'].includes(arg))) throw new Error('Usage: npm run reset [-- --dry-run | --local-only | --stop-only]');
  const remotes=args.includes('--local-only')?[]:remoteTargets(process.env.RESET_REMOTE_TARGETS||'[]');
  const stopOnly=args.includes('--stop-only');
  const targets = stopOnly?[]:resetTargets(project, process.env.DATA_DIR || 'data');
  if (args.includes('--dry-run')) {
    const agents=await findAgents(project);
    console.log(agents.length?'Would stop matching agents across local checkouts:':'No matching local agents found.');
    for(const agent of agents)console.log(`  PID ${agent.pid} · ${agent.cwd}`);
    if(!stopOnly){console.log('Would remove current checkout runtime data in:');for (const target of targets) console.log(`  ${target}`)}
    for(const remote of remotes)console.log(`Would stop remote agents via SSH: ${remote.host} · ${remote.project}`);
    if(!remotes.length&&!args.includes('--local-only'))console.log('No remote targets configured. Other machines cannot be stopped.');
    console.log('Includes bookings, chat state, fake payments/refunds, screenshots, live frames, test screenshots, and the generated signing key.');
    console.log('Preserves .env credentials, source code, dependencies, and the public tunnel.');
    return;
  }
  await resetRuntime(project,{configured:process.env.DATA_DIR||'data',stopOnly});
  const remote=await stopRemoteAgents(remotes);
  console.log('Matching local project agents stopped, including other checkouts and recognized legacy entrypoints.');
  if(!stopOnly){console.log('Current checkout bookings, chat state, fake payments, screenshots, browser frames, and signing keys cleared. Other checkouts’ data preserved.');console.log('Credentials and code preserved. Run npm start, then send a new message in the iMessage group. Old payment/watch links no longer work.')}
  if(!remotes.length&&!args.includes('--local-only'))console.log('No remote targets configured. Agents on other machines were NOT stopped. Set RESET_REMOTE_TARGETS to include them.');
  console.log('Remote provider records and existing iMessage history are not deleted.');
  if(remote.failed.length)throw new Error(`Local reset finished, but ${remote.failed.length} remote target(s) could not be stopped.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Reset stopped: ${error.message}`); process.exitCode = 1; });
}
