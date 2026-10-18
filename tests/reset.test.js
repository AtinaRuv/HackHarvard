import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetTargets } from '../scripts/reset.js';
import { resetRuntime, findAgents, remoteTargets, stopRemoteAgents } from '../scripts/reset.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { acquireAgentLock, acquireResetLock } from '../app/process-lock.js';

test('reset includes old and current runtime state without duplicate nested paths', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'leash-reset-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data', 'imessage'), { recursive: true });
  assert.deepEqual(resetTargets(root, 'data/imessage'), [resolve(root, 'data')]);
  for (const unsafe of ['.', '..', 'public', 'app', '.git', '.env', 'node_modules', '/tmp']) assert.throws(() => resetTargets(root, unsafe));
  mkdirSync(join(root, 'other')); assert.throws(() => resetTargets(root, 'other'), /recognized booking/);
  writeFileSync(join(root, 'other', 'bookings.sqlite'), Buffer.from('SQLite format 3\0'));
  assert.deepEqual(resetTargets(root, 'other'), [resolve(root, 'data'), resolve(root, 'other')]);
});
test('reset refuses runtime paths redirected through symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'leash-reset-link-'));
  const external = mkdtempSync(join(tmpdir(), 'leash-reset-external-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); });
  symlinkSync(external, join(root, 'data'));
  assert.throws(() => resetTargets(root, 'data/imessage'), /symlinked/);
});

test('reset stops every project agent before clearing data and leaves other projects alone',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'leash-reset-agents-')));
  const other=realpathSync(mkdtempSync(join(tmpdir(),'leash-reset-other-')));
  const children=[];
  t.after(async()=>{
    for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}}
    rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});
  });
  const code="if(process.env.IGNORE_TERM==='1')process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready');";
  writeFileSync(join(root,'server.js'),code);writeFileSync(join(other,'server.js'),code);
  writeFileSync(join(root,'.env'),'KEEP_THIS_SECRET=preserved\n');
  mkdirSync(join(root,'data','imessage','live'),{recursive:true});writeFileSync(join(root,'data','imessage','bookings.sqlite'),'test runtime data');
  writeFileSync(join(root,'data','imessage','live','frame.jpg'),'test frame');
  async function start(cwd,ignore=false){const child=spawn(process.execPath,['server.js'],{cwd,env:{...process.env,IGNORE_TERM:ignore?'1':'0'},stdio:['ignore','pipe','pipe']});children.push(child);await once(child.stdout,'data');return child}
  const first=await start(root);const stubborn=await start(root,true);const unrelated=await start(other);
  assert.deepEqual((await findAgents(root)).map(p=>p.pid).sort(),[first.pid,stubborn.pid].sort());
  const result=await resetRuntime(root,{configured:'data/imessage',graceMs:200,log:()=>{}});
  assert.equal(result.stopped.length,2);assert.equal((await findAgents(root)).length,0);
  assert.equal(existsSync(join(root,'data')),false);assert.equal(existsSync(join(root,'.agent.reset.lock')),false);
  assert.equal(existsSync(join(root,'.env')),true);assert.equal(existsSync(join(root,'server.js')),true);
  assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
});

test('agents cannot start while reset holds its lock',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'leash-reset-start-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const release=acquireResetLock(root);assert.throws(()=>acquireAgentLock(root),/resetting/);release();
  const stop=acquireAgentLock(root);stop();
});
test('reset stops legacy agents in matching copies and preserves unrelated projects and copied data',async t=>{
  const roots=Array.from({length:4},()=>realpathSync(mkdtempSync(join(tmpdir(),'leash-reset-copies-'))));
  const[root,copy,other,fork]=roots,children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}
    for(const path of roots)rmSync(path,{recursive:true,force:true});
  });
  const repository='https://github.com/reset-fixtures/booking-agent.git';
  for(const[path,repo]of [[root,repository],[copy,'git@github.com:reset-fixtures/booking-agent.git'],[other,'https://github.com/reset-fixtures/unrelated.git']]){
    writeFileSync(join(path,'package.json'),JSON.stringify({name:'same-package-name',repository:repo}));mkdirSync(join(path,'data'));writeFileSync(join(path,'data','keep.txt'),'preserve copied data');
  }
  mkdirSync(join(copy,'photon'));
  mkdirSync(join(fork,'lib'));
  writeFileSync(join(fork,'package.json'),JSON.stringify({repository:'https://github.com/reset-fixtures/fork.git',scripts:{start:'node lib/booking-runner.js'}}));
  for(const path of [root,fork])writeFileSync(join(path,'.env'),'SPECTRUM_PROJECT_ID=fixture\nSPECTRUM_PROJECT_SECRET=fixture-only\n');
  const code="console.log('ready');setInterval(()=>{},1000);";
  async function start(cwd,script){writeFileSync(join(cwd,script),code);const child=spawn(process.execPath,[script],{cwd,stdio:['ignore','pipe','ignore']});children.push(child);await once(child.stdout,'data');return child}
  const own=await start(root,'server.js'),legacy=await start(copy,'main.js'),listener=await start(copy,'photon/receiveText.js'),unrelated=await start(other,'server.js'),shared=await start(fork,'lib/booking-runner.js');
  assert.deepEqual(new Set((await findAgents(root)).map(p=>p.pid)),new Set([own.pid,legacy.pid,listener.pid,shared.pid]));
  await resetRuntime(root,{graceMs:300,log:()=>{}});
  assert.equal((await findAgents(root)).length,0);assert.ok(!existsSync(join(root,'data')));
  assert.ok(existsSync(join(copy,'data','keep.txt')));assert.ok(!existsSync(join(copy,'.agent.reset.lock')));
  assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
});
test('remote reset validates explicit SSH targets and reports partial failures',async()=>{
  for(const value of ['not-json','{}','[{"host":"-oProxyCommand=x","project":"/srv/app"}]','[{"host":"demo","project":"/"}]'])assert.throws(()=>remoteTargets(value));
  const targets=remoteTargets(JSON.stringify([{host:'user@demo',project:'/srv/Leash demo'},{host:'unreachable',project:'/srv/Leash'}]));
  const calls=[];
  const result=await stopRemoteAgents(targets,{log:()=>{},run:async(command,args)=>{
    calls.push({command,args});if(args.includes('unreachable'))throw Error('offline');return{stdout:''};
  }});
  assert.deepEqual(result,{stopped:['user@demo'],failed:['unreachable']});
  assert.equal(calls[0].command,'ssh');assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.equal(calls[0].args.at(-1),"npm --prefix '/srv/Leash demo' run reset -- --local-only --stop-only");
});
test('stop-only preserves runtime data and does not require a deletable DATA_DIR',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'leash-stop-only-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'data'));writeFileSync(join(root,'data','keep.txt'),'preserve');
  const result=await resetRuntime(root,{configured:'/outside/runtime',stopOnly:true,log:()=>{}});
  assert.deepEqual(result.targets,[]);assert.ok(existsSync(join(root,'data','keep.txt')));
});

test('reset stops nodemon-style supervisors so they cannot restart the agent',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'leash-reset-watcher-')));
  writeFileSync(join(root,'server.js'),"setInterval(()=>{},1000);console.log('child-ready');");
  writeFileSync(join(root,'nodemon.js'),"const{spawn}=require('node:child_process');function start(){const child=spawn(process.execPath,['server.js'],{stdio:['ignore','pipe','ignore']});child.stdout.on('data',()=>console.log('ready'));child.on('exit',()=>setTimeout(start,50))}start();");
  const supervisor=spawn(process.execPath,['nodemon.js','server'],{cwd:root,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    supervisor.kill('SIGKILL');
    for(const agent of await findAgents(root))try{process.kill(agent.pid,'SIGKILL')}catch{}
    rmSync(root,{recursive:true,force:true});
  });
  await once(supervisor.stdout,'data');
  assert.equal((await findAgents(root)).length,2);
  const result=await resetRuntime(root,{graceMs:300,log:()=>{}});
  assert.equal(result.stopped.length,2);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal((await findAgents(root)).length,0);
});
