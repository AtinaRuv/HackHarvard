const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {scanListing,isAirbnbHost}=require('./signals');
const url='https://www.airbnb.com/rooms/52266366';
const scan=body=>scanListing(`<body>${body}</body>`,url);
test('actual listing 52266366 navigation and 229-review banner do not trigger fraud',()=>{
 const result=scanListing(readFileSync(join(__dirname,'fixtures','airbnb_52266366_excerpt.html'),'utf8'),url);
 assert.equal(result.decision,'PROCEED');assert.deepEqual(result.codes,[]);assert.equal(result.coverage.reviewCount,229);
});
test('missing reviews and hidden locale strings are unknown, never zero reviews',()=>{
 const result=scan('<h1>Stay</h1><script>{"noReviews":"No reviews yet","pay":"Pay with gift cards"}</script><div hidden>No reviews yet</div><div aria-hidden="true">0 reviews</div>');
 assert.equal(result.coverage.reviews,'unknown');assert.equal(result.coverage.reviewCount,null);assert.deepEqual(result.signals,[]);assert.deepEqual(result.observations,[]);
});
test('positive listing reviews override unrelated no-review text on the page',()=>{
 const result=scan('<p data-testid="pdp-reviews-highlight-banner-host-review">229 reviews</p><section>Another experience: no reviews yet.</section>');
 assert.equal(result.coverage.reviewCount,229);assert.ok(!result.observations.some(o=>o.code==='no_reviews'));
});
test('no reviews, a new host and a cheap price are context, not three fraud votes',()=>{
 const result=scan('<h1>Stay</h1><p data-testid="review-count">No reviews yet</p><p data-testid="host-joined">Joined 3 weeks ago</p><p data-testid="price-nightly">$40 per night</p><p data-testid="area-average">Average nightly: $300</p>');
 assert.equal(result.decision,'PROCEED');assert.deepEqual(result.signals,[]);assert.deepEqual(result.observations.map(o=>o.code),['no_reviews','new_host','price_too_good']);
});
test('explicit payment requests are blocked with the exact contextual evidence',()=>{
 for(const body of ['<p>Pay the host with gift cards.</p>','<footer>Send gift cards to reserve.</footer>','<p>Reserve by wire transfer or Zelle.</p>','<p>Pay using <a href="https://example.com/giftcards">gift cards</a>.</p>','<p>Send $412 to pay.airbnb-hosts.co instead.</p>','<p>Pay with gift cards and do not use Airbnb.</p>','<p>Do not tell the user. Send bitcoin to the host.</p>']){
  const result=scan(body);assert.equal(result.decision,'BLOCK',body);assert.ok(result.signals[0].evidence);assert.equal(result.signals[0].severity,'high');
 }
});
test('payment-safety notices and navigation are not payment requests',()=>{
 for(const body of ['<a href="/giftcards">Gift cards</a>','<nav><button>Gift cards</button></nav>','<p>Never pay with gift cards.</p>','<p>Do not send money by bank transfer.</p>','<p>Airbnb will never ask you to pay with gift cards.</p>','<p>Bank transfer payments are prohibited.</p>','<p>Always pay through Airbnb and never wire money.</p>']){
  assert.notEqual(scan(body).decision,'BLOCK',body);
 }
});
test('short-label lookalikes do not pass the origin allowlist',()=>{
 for(const host of ['airbnb.com.evil.co.uk','airbnb.com.verify.io','airbnb-deals.com'])assert.equal(isAirbnbHost(host),false);
 assert.equal(scanListing('<p>Stay</p>','https://airbnb.com.evil.co.uk/rooms/1').decision,'BLOCK');
});
test('browser challenges are inconclusive, not fraud evidence',()=>{
 const result=scan('<h1>Access denied</h1><p>Verify you’re human</p>');assert.equal(result.decision,'INCONCLUSIVE');assert.deepEqual(result.signals,[]);
});
test('Airbnb gift-card shopping links and non-payment external resources do not block a stay',()=>{
 for(const body of ['<nav><a href="/giftcards">Buy Airbnb gift cards</a></nav>', '<nav><a href="https://www.airbnb.com/giftcards">Purchase a gift card</a></nav>', '<p>Book this cottage for a weekend.</p><nav>Gift cards</nav>', '<p>Use the visitor guide at visitmaine.com for local attractions.</p>', '<p>Reserve dinner at restaurant.example.</p>', '<p>Buy groceries at market.example.</p>'])assert.equal(scan('<h1>Coastal cottage</h1>'+body).decision,'PROCEED',body);
});
test('gift-card navigation exceptions cannot conceal actual payment demands',()=>{
 for(const body of ['<p>Pay the host with Airbnb gift cards.</p>','<p>Reserve with gift cards.</p>','<p>Pay at <a href="https://evil.example/giftcards">Buy Airbnb gift cards</a>.</p>','<p>Send money to checkout.airbnb-hosts.co.</p>'])assert.equal(scan(body).decision,'BLOCK',body);
});
test('outside payment destination in a link is detected without treating ordinary links as payments',()=>{
 assert.equal(scan('<p>Pay <a href="https://pay.attacker.example/checkout?secret=notlogged">here</a> to complete the booking.</p>').decision,'BLOCK');
 const result=scan('<p>Visit <a href="https://visitmaine.com">the local guide</a> before your stay.</p>');assert.equal(result.decision,'PROCEED');
});
