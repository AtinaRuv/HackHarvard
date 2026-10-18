// Burn the real Playwright pointer/actions into screenshots (headless Chromium
// screenshots do not include the operating system mouse cursor).
function installCursor(){
 if(!document.documentElement){document.addEventListener('DOMContentLoaded',installCursor,{once:true});return;}
 if(document.querySelector('[data-leash-cursor]'))return;
 const host=document.createElement('div');host.dataset.leashCursor='';host.setAttribute('aria-hidden','true');
 host.style.cssText='position:fixed;left:80px;top:90px;width:32px;height:36px;z-index:2147483647;pointer-events:none;transition:left 60ms linear,top 60ms linear';
 const shadow=host.attachShadow({mode:'open'});
 shadow.innerHTML=`<style>:host{pointer-events:none}.halo{position:absolute;left:-14px;top:-14px;width:42px;height:42px;border-radius:50%;background:#007aff12;border:1px solid #007aff38;transition:transform .15s,background .15s}svg{position:relative;filter:drop-shadow(0 2px 3px #0005)}.label{position:absolute;left:23px;top:27px;background:#007aff;color:#fff;border-radius:6px;padding:4px 7px;font:10px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;box-shadow:0 2px 8px #0002}:host([data-action="clicking"]) .halo{background:#007aff40;transform:scale(1.45)}:host([data-action="typing"]) .halo{background:#007aff24;box-shadow:0 0 0 5px #007aff0d}</style><div class="halo"></div><svg width="25" height="31" viewBox="0 0 25 31"><path d="M2 2L2 24L8 18L13 29L18 27L13 16L22 16Z" fill="#161619" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg><span class="label">Agent</span>`;
 document.documentElement.append(host);
 const setAction=action=>{host.dataset.action=action;shadow.querySelector('.label').textContent=({clicking:'Clicking',typing:'Typing',reading:'Reading'})[action]||'Agent'};
 document.addEventListener('mousemove',event=>{host.style.left=event.clientX+'px';host.style.top=event.clientY+'px';host.dataset.x=String(event.clientX);host.dataset.y=String(event.clientY);},true);
 document.addEventListener('mousedown',()=>setAction('clicking'),true);
 document.addEventListener('mouseup',()=>setAction('idle'),true);
 document.addEventListener('keydown',()=>setAction('typing'),true);
 document.addEventListener('input',()=>setAction('typing'),true);
}
async function cursorAction(page,action){await page.evaluate(action=>{const host=document.querySelector('[data-leash-cursor]');if(host){host.dataset.action=action;host.shadowRoot.querySelector('.label').textContent=({clicking:'Clicking',typing:'Typing',reading:'Reading'})[action]||'Agent';}},action)}
async function moveTo(page,locator){
 await page.evaluate(installCursor);await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();if(!box)throw Error('Agent target is not visible.');
 await page.mouse.move(box.x+Math.min(box.width/2,120),box.y+box.height/2,{steps:16});
}
async function clickTarget(page,locator,publish,text){
 await moveTo(page,locator);await page.mouse.down();await cursorAction(page,'clicking');
 try{await publish(text)}finally{await page.mouse.up()}
}
async function fillField(page,key,value,publish){
 const locator=page.locator(`input[name="${key}"]`);
 await clickTarget(page,locator,publish,`Selecting ${key==='guestName'?'guest name':key==='email'?'contact email':key}.`);
 await cursorAction(page,'typing');
 if(['email','guestName'].includes(key)){await locator.fill('');await locator.pressSequentially(String(value),{delay:45});}
 else{await locator.fill(String(value));await locator.press('Escape');}
 await cursorAction(page,'typing');await publish(key==='guestName'?'Entering the guest’s name.':key==='email'?'Entering the booking contact email.':`Setting ${key}.`);
 await cursorAction(page,'idle');
}
async function scrollListing(page,publish,{pauseMs=350,whole=false}={}){
 await page.evaluate(installCursor);
 await page.mouse.move(720,480,{steps:12});await cursorAction(page,'reading');
 for(let step=0;step<(whole?40:4);step++){
  const before=await page.evaluate(()=>scrollY);
  await page.mouse.wheel(0,whole?Math.max(520,await page.evaluate(()=>innerHeight*.75)):520);await page.waitForTimeout(180);
  const view=await page.evaluate(()=>({y:scrollY,heading:[...document.querySelectorAll('h2,h3')].find(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.top<innerHeight*.8})?.textContent?.trim().slice(0,100)}));
  if(view.y===before)break;
  await publish(view.heading?`Viewing listing section: ${view.heading}`:`Scrolling through the listing (${step+1}${whole?'':'/4'}).`);
  await page.waitForTimeout(pauseMs);
 }
 for(let step=0;step<(whole?60:5);step++){
  const y=await page.evaluate(()=>scrollY);if(y<=0)break;
  await page.mouse.wheel(0,-Math.min(whole?1800:520,y));await page.waitForTimeout(180);
  await publish('Returning to the listing and booking summary.');await page.waitForTimeout(pauseMs);
 }
 await cursorAction(page,'idle');
}
module.exports={installCursor,cursorAction,moveTo,clickTarget,fillField,scrollListing};
