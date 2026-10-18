// Demo interactions stay in this tab. Nothing is sent or stored.
(() => {
  const find = (selector) => document.querySelector(selector);
  const text = (key, value) => { find('[data-booking="' + key + '"]').textContent = value; };
  const money = (value) => '$' + value.toFixed(2);
  const form = find('#reservation-form');
  let quote;
  function updateQuote() {
    const checkIn = find('#check-in').value;
    const checkOut = find('#check-out').value;
    const nights = (Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000;
    const guests = Number(find('#guest-count').value);
    const valid = Number.isInteger(nights) && nights > 0 && !(nights > 14) && guests > 0 && !(guests > 4) && form.checkValidity();
    find('#form-error').textContent = valid ? '' : 'Choose 1–14 nights and up to 4 guests within the demo dates.';
    find('.reserve').disabled = !valid;
    if (!valid) { quote = null; return; }
    quote = { checkIn, checkOut, guests, total: nights * 350 + 50 };
    text('checkIn', checkIn); text('checkOut', checkOut); text('guests', String(guests)); text('price', quote.total.toFixed(2));
    find('#night-line').textContent = '$350 × ' + nights + (nights === 1 ? ' night' : ' nights');
    find('#room-cost').textContent = money(nights * 350);
    find('#stay-length').textContent = 'for ' + nights + (nights === 1 ? ' night' : ' nights');
    find('.mini-reserve b').textContent = money(quote.total);
    find('.mini-reserve small').textContent = find('#stay-length').textContent;
    find('#calendar-title').textContent = nights + (nights === 1 ? ' night' : ' nights') + ' in Boston';
    find('#calendar-range').textContent = checkIn + ' – ' + checkOut;
    document.querySelectorAll('[data-date]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.date === checkIn || button.dataset.date === checkOut);
    });
  }
  form.addEventListener('change', updateQuote);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); updateQuote();
    if (!quote) return;
    find('#receipt-text').textContent = 'Harbor View Loft · ' + quote.checkIn + ' to ' + quote.checkOut + ' · ' + quote.guests + ' guests · ' + money(quote.total) + ' USD.';
    find('#receipt').showModal();
  });
  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
  });
  find('.close-receipt').addEventListener('click', () => find('#receipt').close());
  const photos = [...document.querySelectorAll('.photo')];
  let selected = 0;
  function showPhoto(index) {
    selected = (index + photos.length) % photos.length;
    find('.photo-view').replaceChildren(photos[selected].querySelector('img').cloneNode());
    find('#photo-number').textContent = (selected + 1) + ' / ' + photos.length;
  }
  photos.forEach((photo, index) => photo.addEventListener('click', () => { showPhoto(index); find('#photos').showModal(); }));
  find('#all-photos').addEventListener('click', () => { showPhoto(0); find('#photos').showModal(); });
  find('#previous').addEventListener('click', () => showPhoto(selected - 1));
  find('#next').addEventListener('click', () => showPhoto(selected + 1));
  let timer;
  function toast(message) {
    clearTimeout(timer); find('#toast').textContent = message; find('#toast').hidden = false;
    timer = setTimeout(() => { find('#toast').hidden = true; }, 3500);
  }
  find('#save').addEventListener('click', () => {
    const saved = find('#save').getAttribute('aria-pressed') !== 'true';
    find('#save').setAttribute('aria-pressed', String(saved));
    toast(saved ? 'Saved for this tab only.' : 'Removed from this tab’s saved places.');
  });
  find('#share').addEventListener('click', () => toast('Copy this demo page’s address from your browser to share it.'));
  document.querySelectorAll('[data-info]').forEach((button) => button.addEventListener('click', () => toast(button.dataset.info)));
  let choosingCheckout = false;
  document.querySelectorAll('[data-date]').forEach((button) => button.addEventListener('click', () => {
    const date = button.dataset.date;
    if (choosingCheckout && date > find('#check-in').value) {
      find('#check-out').value = date; choosingCheckout = false;
    } else {
      find('#check-in').value = date;
      const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000);
      find('#check-out').value = next.toISOString().slice(0, 10);
      choosingCheckout = true;
    }
    updateQuote();
  }));
  find('#reset-dates').addEventListener('click', () => {
    find('#check-in').value = '2026-10-24'; find('#check-out').value = '2026-10-25'; choosingCheckout = false; updateQuote();
  });
  function updateNavigation() {
    find('.sticky-navigation').classList.toggle('visible', 0 > find('#gallery').getBoundingClientRect().bottom);
  }
  window.addEventListener('scroll', updateNavigation, { passive: true });
})();
