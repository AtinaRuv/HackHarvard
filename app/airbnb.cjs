const cheerio = require('cheerio');

// Parse only visible quote facts. Search results, nightly rates, hidden JSON,
// and a total explicitly marked "before taxes" are never a final quote.
function readQuote(html, url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'www.airbnb.com' || !/^\/rooms\/\d+/.test(parsed.pathname)) throw new Error('The browser left the Airbnb listing.');
  const $ = cheerio.load(html);
  $('script,style,template,noscript,[hidden],[aria-hidden="true"]').remove();
  $('[style]').each((_,el)=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr('style')))$(el).remove()});
  const visible = $('body').text().replace(/\s+/g,' ').trim();
  if (/captcha|verify (?:that )?you(?:’|'| a)?re human|access denied|log in to continue/i.test(visible)) throw new Error('Airbnb requires login or a browser challenge. No payment will be collected.');
  const value = selectors => {
    const values = new Set();
    for (const selector of selectors) $(selector).each((_,el)=>{
      const v = ($(el).attr('data-date') || $(el).attr('value') || $(el).text()).trim(); if(v)values.add(v);
    });
    if(values.size>1)throw new Error('Airbnb displays conflicting booking details.');
    return [...values][0];
  };
  function date(raw) {
    if (!raw) return null;
    const iso=raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);if(iso)return iso[1];
    const us=raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if(us)return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
    const parsed=Date.parse(raw);return Number.isFinite(parsed)&&/\b20\d\d\b/.test(raw)?new Date(parsed).toISOString().slice(0,10):null;
  }
  const checkIn=date(value(['[data-testid="checkin-date"]','[data-testid="change-dates-checkIn"]','input[name="checkIn"]','input[name="check_in"]'])||visible.match(/check.in\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i)?.[1]);
  const checkOut=date(value(['[data-testid="checkout-date"]','[data-testid="change-dates-checkOut"]','input[name="checkOut"]','input[name="check_out"]'])||visible.match(/check.out\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i)?.[1]);
  const guestText=value(['[data-testid="guest-count"]','[data-testid="guest-picker-trigger"]','[data-testid="change-guests"]']);
  const guests=Number((guestText||'').match(/\b(\d{1,2})\s*(?:guests?|adults?)\b/i)?.[1]);
  const totalText=value(['[data-testid="price-total"]','[data-testid="total-price"]','[data-testid="book-it-total-price"]','[data-booking="totalPrice"]'])||visible.match(/\bTotal\s*(?:\(USD\)|USD)?\s*(?:US\$|\$|USD)\s*[\d,]+(?:\.\d{1,2})?(?:\s*USD)?/i)?.[0];
  if (!totalText || /before\s+tax/i.test(totalText) || !/tax(?:es)?(?:\s+and\s+fees)?\s+(?:are\s+)?included|includ(?:es?|ing)\s+(?:all\s+)?tax|total\s+(?:after|with)\s+tax/i.test(visible)) throw new Error('Airbnb did not expose an explicit final total including taxes. A nightly rate is not enough.');
  if (!/\bUSD\b|US\$/i.test(totalText+' '+visible)) throw new Error('Airbnb quote currency could not be verified as USD.');
  const amounts=[...totalText.matchAll(/(?:US\$|\$|USD\s*)\s*([\d,]+(?:\.\d{1,2})?)/g)].map(m=>Math.round(Number(m[1].replaceAll(',',''))*100));
  if(new Set(amounts).size!==1)throw new Error('Airbnb total price is missing or ambiguous.');
  if(!checkIn||!checkOut||!guests)throw new Error('Airbnb did not expose the selected dates and guest count.');
  const title=$('[data-testid="listing-title"]').first().text().trim()||$('h1').first().text().trim();
  if(!title)throw new Error('Airbnb listing title is missing.');
  for(const form of $('form').toArray()) {
    const action=$(form).attr('action');if(action&&new URL(action,url).hostname!=='www.airbnb.com')throw new Error('The booking form points outside Airbnb.');
  }
  return { listingId:parsed.pathname.match(/\/rooms\/(\d+)/)[1],listingUrl:url,title,checkIn,checkOut,guests,currency:'USD',totalCents:amounts[0],destination:'airbnb.com' };
}
module.exports={readQuote};
