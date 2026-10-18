// Serialized into the browser worker. This reads DOM data; it never runs page code.
function extractPage(root, inspection) {
  const visible = root.innerText || "";
  if (!inspection) return { content: visible.slice(0, 20000), contentTruncated: visible.length > 20000 };
  const dom = root.textContent || "";
  const nodes = root.querySelectorAll("*");
  const scan = { visibleText: visible.slice(0, 30000), domText: dom.slice(0, 100000), comments: "", attributes: "",
    truncated: visible.length > 30000 || dom.length > 100000 || nodes.length > 3000,
    nodesScanned: Math.min(nodes.length, 3000), activeScripts: 0, externalResources: 0, frames: 0, fragments: 0, forms: 0,
    eventHandlers: 0, metaRefresh: false, baseOverride: false, paymentControls: false, links: [] };
  for (let i = 0; i < Math.min(nodes.length, 3000); i++) {
    const node = nodes[i];
    const tag = node.tagName.toLowerCase();
    const attr = (name) => node.getAttribute(name) || "";
    if (tag === "script" && (!/^(application\/ld\+json|application\/json)$/i.test(attr("type")) || attr("src"))) scan.activeScripts++;
    if (["iframe", "frame", "object", "embed"].includes(tag)) scan.frames++;
    if (tag === "template" || node.shadowRoot) scan.fragments++;
    if (tag === "form") scan.forms++;
    if (tag === "meta" && attr("http-equiv").toLowerCase() === "refresh") scan.metaRefresh = true;
    if (tag === "base" && attr("href")) scan.baseOverride = true;
    if (tag === "input" && /password|cc-|credit.?card/i.test(`${attr("type")} ${attr("autocomplete")} ${attr("name")}`)) scan.paymentControls = true;
    for (const attribute of node.attributes) {
      if (/^on/i.test(attribute.name)) scan.eventHandlers++;
      scan.attributes += ` ${attribute.name}=${attribute.value}`;
      if (scan.attributes.length > 16000) { scan.attributes = scan.attributes.slice(0, 16000); scan.truncated = true; }
    }
    const target = attr("href") || attr("src") || attr("action");
    if (target && ["script", "link", "img", "iframe", "frame", "object", "embed", "source", "video", "audio"].includes(tag)) scan.externalResources++;
    if (target) {
      if (scan.links.length < 100) scan.links.push({ target: target.slice(0, 2048), label: (node.innerText || "").slice(0, 120), tag });
      else scan.truncated = true;
      if (target.length > 2048) scan.truncated = true;
    }
  }
  const walker = root.ownerDocument.createTreeWalker(root, 128); // SHOW_COMMENT
  let comment;
  while ((comment = walker.nextNode())) {
    scan.comments += ` ${comment.textContent}`;
    if (scan.comments.length > 8000) { scan.comments = scan.comments.slice(0, 8000); scan.truncated = true; break; }
  }
  const facts = {};
  const ambiguousFields = [];
  for (const name of ["propertyName", "address", "checkIn", "checkOut", "guests", "roomType", "price", "currency", "priceBasis", "taxesAndFees", "cancellationPolicy", "availability"]) {
    const microdata = name === "propertyName" ? '[itemscope][itemtype$="/Hotel"] [itemprop="name"]' : `[itemprop="${name}"]`;
    const elements = root.querySelectorAll(`[data-booking="${name}"],${microdata}`);
    const values = [];
    for (let i = 0; i < Math.min(elements.length, 10); i++) {
      const element = elements[i];
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const value = (element.innerText || "").trim();
      if (value.length > 500) { scan.truncated = true; continue; }
      if (value && !values.includes(value)) values.push(value);
    }
    if (elements.length > 10) scan.truncated = true;
    facts[name] = values.length === 1 ? values[0] : null;
    if (values.length > 1) ambiguousFields.push(name);
  }
  // A merchant identifier is an observed page claim, never authorization.
  // Accept only one small, inert JSON record. Never evaluate page scripts.
  const records = root.querySelectorAll('[data-booking="merchantId"]');
  facts.merchantId = null;
  if (records.length === 1 && records[0].tagName === 'SCRIPT' &&
      records[0].getAttribute('type') === 'application/json' && records[0].textContent.length <= 512) {
    try {
      const id = JSON.parse(records[0].textContent).merchantId;
      if (typeof id === 'string' && /^[A-Z0-9_-]{1,80}$/.test(id)) facts.merchantId = id;
    } catch { /* Malformed metadata remains unknown. */ }
  }
  if (records.length > 1) ambiguousFields.push('merchantId');
  return { scan, facts, ambiguousFields };
}

const RULES = [
  ["override", /\b(ignore|disregard|override|forget)\b[\s\S]{0,90}\b(previous|prior|system|developer|instructions?|prompts?|rules|polic(?:y|ies))\b/i, "Page attempts to override agent instructions."],
  ["secrets", /\b(reveal|print|send|exfiltrate|leak|dump|show)\b[\s\S]{0,100}\b(secrets?|api.?keys?|system.?prompts?|credentials?|environment|process\.env|tokens?|passwords?)\b/i, "Page requests disclosure of secrets or privileged context."],
  ["commands", /\b(exec(?:ute)?|run|invoke|spawn)\b[\s\S]{0,80}\b(shell|terminal|commands?|curl|wget|bash|powershell|python|node)\b|\b(?:curl|wget)\s+https?:\/\/|child_process|process\.env|\$\([^)]+\)/i, "Page contains command-execution instructions."],
  ["payment", /\b(send|wire|transfer|pay|redirect|change|replace|update)\b[\s\S]{0,90}\b(payment|funds|money|bank|iban|wallet|bitcoin|crypto|account|recipient)\b|\b(?:IBAN|SWIFT)\s*[:=]/i, "Page contains payment-routing instructions requiring independent review."],
  ["role", /\[(?:system|developer|assistant|tool)\]|<\|(?:im_start|system|assistant)|\b(?:system|developer)\s*(?:message|prompt)\s*:|role\s*=\s*["']?system/i, "Page impersonates a privileged agent role."],
  ["behavior", /\b(?:agent|assistant|bot|model)\b[\s\S]{0,100}\b(?:book|reserve|cancel|approve|skip|bypass|trust|obey|navigate|click|submit|pay)\b/i, "Page attempts to control booking-agent behavior."],
];

function normalizedText(value) {
  let text = value.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
  text = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  try { text += ` ${decodeURIComponent(text)}`; } catch { /* Not all page text is URI-encoded. */ }
  // Decode a few bounded base64 strings as DATA only, never as code.
  for (const match of [...value.matchAll(/[A-Za-z0-9+/]{60,1024}={0,2}/g)].slice(0, 5)) {
    text += ` ${Buffer.from(match[0], "base64").toString("utf8").slice(0, 2000)}`;
  }
  return text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

function emptyDetails(url = null) {
  return { propertyName: null, listingUrl: url, address: null, checkIn: null, checkOut: null, guests: null,
    roomType: null, displayedPrice: null, totalPrice: null, currency: null, priceBasis: null,
    taxesAndFees: null, cancellationPolicy: null, availability: null, merchantId: null };
}

function failedInspection(url, status, type, description) {
  return { url, status, dataTrust: "untrusted_page_claims", safeToProceed: false,
    security: { status, promptInjectionDetected: false, findings: [{ type, severity: "high", description }],
      inspectionComplete: false, requiresIndependentVerification: true }, bookingDetails: emptyDetails(url) };
}

function assessPage(url, page) {
  const { validateUrl } = require("./security");
  if (!page?.scan || !page.facts || !Array.isArray(page.ambiguousFields)) throw new Error("Invalid inspection evidence.");
  const scan = page.scan;
  for (const key of ["truncated", "metaRefresh", "baseOverride", "paymentControls"]) {
    if (typeof scan[key] !== "boolean") throw new Error("Missing inspection coverage.");
  }
  for (const key of ["nodesScanned", "activeScripts", "externalResources", "frames", "fragments", "forms", "eventHandlers"]) {
    if (!Number.isInteger(scan[key]) || scan[key] < 0 || scan[key] > 3000) throw new Error("Invalid inspection coverage.");
  }
  if (Object.values(page.facts).some((value) => value !== null && typeof value !== "string")) throw new Error("Invalid booking field evidence.");
  const findings = [];
  const add = (type, severity, description) => findings.push({ type, severity, description });
  const sources = [scan.visibleText, scan.domText, scan.comments, scan.attributes];
  if (sources.some((value) => typeof value !== "string") || sources.join("").length > 160000) throw new Error("Invalid or oversized inspection evidence.");
  const text = sources.map(normalizedText).join("\n");
  for (const [rule, pattern, description] of RULES) {
    if (pattern.test(text)) add(rule === "payment" ? "payment_instructions" : "prompt_injection", "high", description);
  }
  const injection = findings.length > 0;
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(sources.join("")) || /[A-Za-z0-9+/]{80,}={0,2}/.test(text)) {
    add("obfuscated_content", "medium", "Encoded or invisible-character content requires review; normalization is not exhaustive.");
  }
  if (scan.metaRefresh || page.httpRefresh || scan.baseOverride || /(?:window\.)?location(?:\.href)?\s*=|location\.replace\s*\(/i.test(text)) {
    add("redirect_attempt", "high", "Page contains a redirect or base-URL override; it was not followed.");
  }
  if (!Array.isArray(scan.links) || scan.links.length > 100) throw new Error("Invalid link evidence.");
  for (const link of scan.links) {
    try {
      const target = new URL(link.target, url);
      if (["mailto:", "tel:"].includes(target.protocol)) continue;
      validateUrl(target.href, [target.hostname]);
      if (target.origin !== new URL(url).origin && /pay|bank|wallet|transfer/i.test(link.label)) {
        add("payment_destination", "high", "A payment-related link points outside the inspected origin; it was not followed.");
      }
    } catch { add("unsafe_destination", "high", "Page references a disallowed scheme, local address, or internal destination; it was not followed."); }
    if (findings.length >= 20) break;
  }
  const dynamic = Boolean(scan.activeScripts || scan.externalResources || scan.frames || scan.fragments || scan.eventHandlers || scan.forms || scan.paymentControls || page.blockedRequests || /@import\b|url\s*\(/i.test(text));
  if (dynamic) add("uninspected_behavior", "medium", "Scripts, embedded content, forms, permissions-sensitive controls or subrequests were blocked and cannot be assessed dynamically.");
  if (scan.truncated) add("inspection_limit", "medium", "Inspection limits were reached; the page was not fully inspected.");
  if (page.ambiguousFields.length) add("conflicting_facts", "medium", "Visible booking fields contain conflicting values; those fields were withheld.");

  const raw = page.facts;
  const details = emptyDetails(url);
  const plain = (value, max) => typeof value === "string" && value.length <= max &&
    !/[<>\u0000-\u001f\u200b-\u200f\u202a-\u202e]/.test(value) && !/https?:\/\/|javascript:|data:/i.test(value) ? value : null;
  // Suspected instructions never become descriptive booking fields.
  if (!injection) {
    details.propertyName = plain(raw.propertyName, 120);
    details.address = plain(raw.address, 240);
    details.roomType = plain(raw.roomType, 100);
    details.taxesAndFees = plain(raw.taxesAndFees, 300);
    details.cancellationPolicy = plain(raw.cancellationPolicy, 500);
  }
  const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
  details.checkIn = date(raw.checkIn);
  details.checkOut = date(raw.checkOut);
  if (details.checkIn && details.checkOut && details.checkOut <= details.checkIn) details.checkIn = details.checkOut = null;
  details.guests = /^[1-9]\d?$|^100$/.test(raw.guests || "") ? Number(raw.guests) : null;
  details.currency = /^[A-Z]{3}$/.test(raw.currency || "") ? raw.currency : null;
  details.displayedPrice = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(raw.price || "") ? Number(raw.price) : null;
  const priceBasis = raw.priceBasis === 'Total for your group' ? 'total_group_stay' : raw.priceBasis;
  details.priceBasis = ["total_group_stay", "per_night", "per_person"].includes(priceBasis) ? priceBasis : null;
  details.totalPrice = details.priceBasis === "total_group_stay" && details.currency ? details.displayedPrice : null;
  details.availability = ["available", "unavailable", "request_only"].includes(raw.availability) ? raw.availability : null;
  details.merchantId = typeof raw.merchantId === 'string' && /^[A-Z0-9_-]{1,80}$/.test(raw.merchantId) ? raw.merchantId : null;
  // Merchant metadata is optional for existing inspection clients. The demo's
  // separate backend gate requires it; absence can never approve a payment.
  const missingFields = Object.entries(details).filter(([key, value]) => key !== 'merchantId' && value === null).map(([key]) => key);
  const complete = !scan.truncated && !dynamic && !missingFields.length && !page.ambiguousFields.length;
  return { url, status: scan.truncated || dynamic || missingFields.length ? "inconclusive" : "inspected",
    dataTrust: "untrusted_page_claims", bookingDetails: details, safeToProceed: false,
    security: { status: findings.some((finding) => finding.severity === "high") ? "review_required" : findings.length || !complete ? "inconclusive" : "no_findings",
      promptInjectionDetected: injection, findings: findings.slice(0, 20), missingFields, inspectionComplete: complete,
      requiresIndependentVerification: true, coverage: { staticDomOnly: true, hiddenTextIncluded: true,
        scriptsExecuted: false, truncated: Boolean(scan.truncated), nodesScanned: scan.nodesScanned },
      limitations: ["Heuristics can miss injection and produce false positives; no finding is not a safety guarantee.",
        "Page claims are not verified inventory, payment instructions, or authorization. The trusted backend must independently verify them."] } };
}

module.exports = { extractPage, assessPage, failedInspection };
