import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const {installCursor,fillField,clickTarget,scrollListing}=createRequire(import.meta.url)('../app/cursor.cjs');
test('visible cursor follows real click targets, shows typing and never intercepts form input',async t=>{
 const executablePath=existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';if(!existsSync(executablePath)){t.skip('No local browser installed');return;}
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:800,height:600}});
 await page.setContent('<main style="margin:180px"><input name="email"><button onclick="this.textContent=\'Done\'">Submit</button></main>');await page.evaluate(installCursor);
 const actions=[];const publish=async()=>{actions.push(await page.locator('[data-leash-cursor]').getAttribute('data-action'))};
 await fillField(page,'email','demo@example.invalid',publish);assert.equal(await page.locator('input').inputValue(),'demo@example.invalid');assert.ok(actions.includes('clicking'));assert.ok(actions.includes('typing'));
 const target=page.getByRole('button',{name:'Submit'}),box=await target.boundingBox();await clickTarget(page,target,publish,'Submit');assert.equal(await page.getByRole('button').innerText(),'Done');
 const pointer=await page.locator('[data-leash-cursor]').evaluate(el=>({x:Number(el.dataset.x),y:Number(el.dataset.y),pointerEvents:getComputedStyle(el).pointerEvents,hasArrow:!!el.shadowRoot.querySelector('svg')}));
 assert.ok(pointer.x>=box.x&&pointer.x<=box.x+box.width);assert.ok(pointer.y>=box.y&&pointer.y<=box.y+box.height);assert.equal(pointer.pointerEvents,'none');assert.equal(pointer.hasArrow,true);
 await page.setContent('<h1>Next page</h1>');await page.evaluate(installCursor);assert.equal(await page.locator('[data-leash-cursor]').count(),1);
 await page.setContent('<h1>Listing</h1><section style="height:3000px"><h2>About this space</h2></section>');
 const positions=[];await scrollListing(page,async()=>{positions.push(await page.evaluate(()=>scrollY))},{pauseMs:0});
 assert.ok(positions.some(y=>y>500),'listing visibly scrolls beyond the first viewport');assert.ok(positions.some((y,i)=>i>0&&y<positions[i-1]),'returns upward through the listing');assert.equal(await page.evaluate(()=>scrollY),0);
});
