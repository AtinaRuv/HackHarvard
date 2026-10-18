const cheerio = require('cheerio');

// Evidence triage, not a probability that a host is fraudulent. Only explicit
// payment requests or an untrusted origin are actionable. Host metadata is context.
const PAYMENT_RAILS = /\b(?:wire transfer|bank transfer|zelle|venmo|cash app|western union|moneygram|gift cards?|bitcoin|cryptocurrency|crypto|usdt|pay (?:the host |the owner )?directly|skip the platform fees?|off[- ]platform)\b/i;
const REQUEST = /\b(?:pay|send|transfer|wire|deposit|purchase|buy|use)\b|\b(?:reserve|book|complete|secure|hold)\b[^.!?\n]{0,60}\b(?:with|by|via|using|through|to)\b/i;
const MONEY_REQUEST = /\b(?:pay|payment|wire|deposit|transfer)\b|\bsend\s+(?:money|funds|the (?:total|balance|payment)|\$|\d)/i;
const NEGATED = /\b(?:never|don't|do not|cannot|can't)\s+(?:ever\s+)?(?:pay|send|wire|transfer|use|accept|buy|purchase)\b|\b(?:will|would) never ask\b|\b(?:not allowed|prohibited|do not accept)\b/i;
const CODES = ['off_platform', 'off_platform_payment', 'no_reviews', 'new_host', 'price_too_good'];
const ALLOWED_DOMAINS = ['airbnb.com', 'airbnb.co.uk', 'airbnb.fr'];
function isAirbnbHost(host) {
    host=String(host||'').toLowerCase().replace(/\.$/,'');
    return ALLOWED_DOMAINS.some(domain=>host===domain||host.endsWith('.'+domain));
}
const normalized=value=>String(value||'').replace(/\s+/g,' ').trim();
const number=value=>Number(String(value).replace(/,/g,''));
function scanListing(html,url) {
    const $=cheerio.load(html),signals=[],observations=[];
    let parsed;try{parsed=new URL(url)}catch{}
    if(!parsed||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!isAirbnbHost(parsed.hostname)){
        signals.push({code:'off_platform',severity:'high',detail:'the listing origin is not an allowed HTTPS Airbnb domain',evidence:parsed?parsed.origin:'invalid URL',source:'browser_url'});
    }
    // Hydration bundles contain every locale string, including "no reviews".
    // Never treat those strings or hidden templates as visible listing evidence.
    $('script,style,template,noscript,[hidden],[aria-hidden="true"]').remove();
    $('[style]').each((_,el)=>{if(/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(el).attr('style')))$(el).remove()});
    const body=$('body').clone();
    body.find('a').each((_,el)=>{
        const link=$(el);
        if(!/^(?:(?:buy|purchase)\s+(?:an?\s+)?(?:airbnb\s+)?)?gift cards?$/i.test(normalized(link.text())))return;
        try{const target=new URL(link.attr('href'),url);if(target.protocol==='https:'&&isAirbnbHost(target.hostname)&&/^\/giftcards\/?$/.test(target.pathname))link.remove()}catch{}
    });
    // A demand can say "Pay here" while hiding the destination in its href.
    // Keep just the hostname; tracking queries and tokens are not evidence.
    body.find('a[href]').each((_,el)=>{
        const link=$(el);try{const target=new URL(link.attr('href'),url);if(/^https?:$/.test(target.protocol)&&!isAirbnbHost(target.hostname))link.append(` (${target.hostname})`)}catch{}
    });
    body.find('p,li,section,article,h1,h2,h3').each((_,el)=>$(el).after('\n'));
    const visible=body.text();
    let payment;
    for(const block of visible.split(/\n+/)){
        for(const raw of block.split(/(?<=[.!?])\s+|;\s*|\b(?:and|but|however)\b|,\s+(?=(?:pay|send|wire|transfer|use|buy)\b)/i)){
            const text=normalized(raw);if(!text||NEGATED.test(text)||!REQUEST.test(text))continue;
            const rail=PAYMENT_RAILS.exec(text);
            const external=[...text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi)].find(match=>!isAirbnbHost(match[1]));
            if(rail||(external&&MONEY_REQUEST.test(text))){payment={code:'off_platform_payment',severity:'high',detail:'the listing explicitly requests payment through an outside payment method or destination',evidence:text.slice(0,300),source:'visible_payment_instruction'};break}
        }
        if(payment)break;
    }
    if(payment)signals.push(payment);
    const counts=new Set();let explicitNoReviews=false;
    $('[data-testid="review-count"],[data-testid="pdp-reviews-highlight-banner-host-review"],[data-section-id="REVIEWS_DEFAULT"] h2').each((_,el)=>{
        const text=normalized($(el).text());
        const count=/\b([\d,]+)\s+reviews?\b/i.exec(text);
        if(count)counts.add(number(count[1]));
        if(/^no reviews?(?: yet)?[.!]?$/i.test(text)){counts.add(0);explicitNoReviews=true;}
    });
    const reviewCount=counts.size===1?[...counts][0]:null;
    if(reviewCount===0)observations.push({code:'no_reviews',severity:'info',detail:'no reviews are shown; this alone is not evidence of fraud',evidence:explicitNoReviews?'No reviews yet':'0 reviews',source:'listing_review_section'});
    const joined=normalized($('[data-testid="host-joined"]').first().text());
    const age=/\bjoined\s+(?:about\s+)?(\d{1,3})\s*(day|week|month|year)s?\s+ago\b/i.exec(joined);
    if(age&&Number(age[1])*({day:1,week:7,month:30,year:365}[age[2].toLowerCase()])<180)observations.push({code:'new_host',severity:'info',detail:'the host is new; this alone is not evidence of fraud',evidence:joined.slice(0,200),source:'host_joined_section'});
    const nightlyText=normalized($('[data-testid="price-nightly"]').first().text()),averageText=normalized($('[data-testid="area-average"]').first().text());
    const nightly=/\$\s*([\d,]+(?:\.\d{2})?)/.exec(nightlyText),average=/\$\s*([\d,]+(?:\.\d{2})?)/.exec(averageText);
    if(nightly&&average&&number(average[1])>0&&number(nightly[1])<number(average[1])*.5)observations.push({code:'price_too_good',severity:'info',detail:'the displayed price is below the displayed comparison; the comparison is not independently verified',evidence:`${nightlyText}; ${averageText}`.slice(0,300),source:'listing_price_comparison'});
    const text=normalized(visible);
    const incomplete=!text||/access denied|verify (?:that )?you(?:'|’)re human|captcha|enable javascript to continue/i.test(text);
    return {status:signals.length?'WARN':incomplete?'UNKNOWN':'OK',decision:signals.length?'BLOCK':incomplete?'INCONCLUSIVE':'PROCEED',codes:signals.map(signal=>signal.code),signals,observations,coverage:{reviewCount,reviews:counts.size>1?'conflicting':reviewCount===null?'unknown':'known',visibleContent:!incomplete}};
}
module.exports = { scanListing, isAirbnbHost, CODES };
