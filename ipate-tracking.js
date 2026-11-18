/* ============================================================
   IPATE live tracking — drop-in module (works in index.html + admin.html)
   - Customer/seller: "Track Live" button on order cards -> live map + timeline
   - Rider: floating panel -> shares GPS, status buttons, navigation link
   - Admin: "Live Fleet" button -> map of all active riders
   Needs: ipate-tracking.sql run once. Leaflet + OpenStreetMap (free, no key).
   ============================================================ */
(function () {
  if (window.IpateTracking) return;

  const ACTIVE = ['assigned', 'picked_up', 'in_transit'];
  const TRACKABLE = ['created', 'paid', 'accepted', 'ready', 'assigned', 'picked_up', 'in_transit'];
  const STEPS = [
    ['paid', 'Paid'], ['accepted', 'Accepted'], ['ready', 'Ready'],
    ['assigned', 'Rider assigned'], ['picked_up', 'Picked up'],
    ['in_transit', 'On the way'], ['delivered', 'Delivered']
  ];
  const NEXT = {
    assigned: ['picked_up', 'Picked up'],
    picked_up: ['in_transit', 'Start delivery'],
    in_transit: ['delivered', 'Mark delivered']
  };
  const NAIROBI = [-1.286389, 36.817223];

  /* ---------- helpers ---------- */
  const db = () => {
    try { if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.from) return supabaseClient; } catch (e) {}
    try { if (typeof supabase !== 'undefined' && supabase && supabase.from) return supabase; } catch (e) {}
    return null;
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = id => String(id || '').slice(-8);
  const km = (a, b, c, d) => {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(c - a), dLng = r(d - b);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const ago = iso => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  };

  let leafletP = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise((ok, no) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
      document.head.appendChild(l);
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
      s.onload = ok; s.onerror = () => { leafletP = null; no(new Error('Map library failed to load')); };
      document.head.appendChild(s);
    });
    return leafletP;
  }

  async function geocode(addr) {
    if (!addr) return null;
    const key = 'ipate_geo_' + addr.toLowerCase();
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c) return c; } catch (e) {}
    const tryQ = async q => {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ke&q=' + encodeURIComponent(q));
      const j = await r.json();
      return j && j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
    };
    let p = null;
    try { p = await tryQ(addr); if (!p && !/nairobi/i.test(addr)) p = await tryQ(addr + ', Nairobi'); } catch (e) {}
    if (p) try { localStorage.setItem(key, JSON.stringify(p)); } catch (e) {}
    return p;
  }

  let me = null;
  async function getMe() {
    const d = db(); if (!d) return null;
    try {
      const { data: { session } } = await d.auth.getSession();
      if (!session) { me = null; return null; }
      if (me && me.id === session.user.id) return me;
      const { data: p } = await d.from('profiles').select('id,name,role,phone').eq('id', session.user.id).maybeSingle();
      me = p || { id: session.user.id, role: 'customer' };
      return me;
    } catch (e) { return null; }
  }

  /* ---------- styles ---------- */
  const css = document.createElement('style');
  css.textContent = `
  .ipt-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99990;display:flex;align-items:center;justify-content:center;padding:12px}
  .ipt-modal{background:#fff;color:#1f2937;border-radius:14px;width:100%;max-width:760px;max-height:96vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit}
  .ipt-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e5e7eb}
  .ipt-head h3{margin:0;font-size:18px}
  .ipt-x{background:none;border:0;font-size:26px;cursor:pointer;line-height:1;color:#6b7280}
  .ipt-body{padding:16px 18px}
  .ipt-map{height:340px;border-radius:10px;overflow:hidden;background:#e5e7eb;margin:12px 0}
  .ipt-steps{display:flex;justify-content:space-between;gap:4px;margin:6px 0 4px}
  .ipt-step{flex:1;text-align:center;font-size:11px;color:#9ca3af}
  .ipt-dot{width:22px;height:22px;border-radius:50%;background:#e5e7eb;margin:0 auto 4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
  .ipt-step.done{color:#2563eb}.ipt-step.done .ipt-dot{background:#2563eb}
  .ipt-step.now{color:#111827;font-weight:700}.ipt-step.now .ipt-dot{background:#16a34a;box-shadow:0 0 0 4px rgba(22,163,74,.2)}
  .ipt-info{display:flex;flex-wrap:wrap;gap:10px;font-size:14px}
  .ipt-chip{background:#f3f4f6;border-radius:8px;padding:8px 12px}
  .ipt-chip b{display:block;font-size:16px}
  .ipt-msg{font-size:13px;color:#6b7280;margin-top:8px}
  .ipt-btn{border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font-weight:600;font-size:13px;background:#2563eb;color:#fff;text-decoration:none;display:inline-block}
  .ipt-btn.alt{background:#fff;color:#2563eb;border:1px solid #2563eb}
  .ipt-pin{font-size:26px;line-height:26px;text-align:center;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))}
  .ipt-fab{position:fixed;z-index:99980;border:0;border-radius:999px;padding:11px 16px;font-weight:700;cursor:pointer;background:#111827;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.3);font-size:14px}
  .ipt-rider{position:fixed;left:12px;bottom:12px;z-index:99980;width:min(340px,calc(100vw - 24px));background:#fff;color:#1f2937;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.35);overflow:hidden;font-size:14px}
  .ipt-rider header{background:#111827;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-weight:700}
  .ipt-rider .ipt-rb{padding:12px 14px;max-height:55vh;overflow:auto}
  .ipt-job{border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:10px}
  .ipt-job .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .ipt-live{display:inline-block;width:9px;height:9px;border-radius:50%;background:#16a34a;margin-right:6px;animation:iptp 1.6s infinite}
  .ipt-live.off{background:#9ca3af;animation:none}
  @keyframes iptp{0%{box-shadow:0 0 0 0 rgba(22,163,74,.6)}70%{box-shadow:0 0 0 8px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}
  `;
  document.head.appendChild(css);

  function modal(title, bodyHtml, onClose) {
    const o = document.createElement('div');
    o.className = 'ipt-overlay';
    o.innerHTML = `<div class="ipt-modal"><div class="ipt-head"><h3>${title}</h3><button class="ipt-x" aria-label="Close">&times;</button></div><div class="ipt-body">${bodyHtml}</div></div>`;
    const close = () => { try { onClose && onClose(); } catch (e) {} o.remove(); };
    o.querySelector('.ipt-x').onclick = close;
    o.addEventListener('mousedown', e => { if (e.target === o) close(); });
    document.body.appendChild(o);
    return { el: o, close };
  }
  const pin = (emoji, size = 30) => L.divIcon({ className: '', html: `<div class="ipt-pin">${emoji}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size - 2] });
  const baseMap = el => {
    const m = L.map(el).setView(NAIROBI, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
    return m;
  };

  /* ============================================================
     CUSTOMER / SELLER: live order tracking
     ============================================================ */
  async function track(orderId) {
    const d = db();
    if (!d) return alert('Not connected. Please refresh.');
    let order;
    {
      const { data, error } = await d.from('orders')
        .select('*, rider:profiles!orders_rider_id_fkey(id,name,phone)')
        .eq('id', orderId).single();
      if (error) return alert('Could not load order: ' + error.message);
      order = data;
    }
    await loadLeaflet().catch(e => alert(e.message));
    if (!window.L) return;

    let map, riderMk, destMk, trail, trailPts = [], ch, poll, fitted = false, lastLoc = null, dead = false;
    const M = modal(`Track Order #${esc(short(order.id))}`, `
      <div class="ipt-steps" id="ipt-steps"></div>
      <div class="ipt-map" id="ipt-map"></div>
      <div class="ipt-info" id="ipt-info"></div>
      <div class="ipt-msg" id="ipt-msg"></div>`, () => {
        dead = true; clearInterval(poll);
        try { ch && d.removeChannel(ch); } catch (e) {}
        try { map && map.remove(); } catch (e) {}
      });
    const $ = id => M.el.querySelector('#' + id);
    map = baseMap($('ipt-map'));
    setTimeout(() => map.invalidateSize(), 150);

    const dest = { lat: order.dest_lat, lng: order.dest_lng };
    async function ensureDest() {
      if (dest.lat && dest.lng) return;
      const p = await geocode(order.delivery_address);
      if (p && !dead) { dest.lat = p.lat; dest.lng = p.lng; }
    }
    function drawDest() {
      if (!dest.lat || !dest.lng || destMk) return;
      destMk = L.marker([dest.lat, dest.lng], { icon: pin('📍') }).addTo(map).bindTooltip('Delivery address');
      if (!lastLoc) map.setView([dest.lat, dest.lng], 15);
    }
    function renderSteps() {
      const idx = Math.max(-1, STEPS.findIndex(s => s[0] === order.status));
      $('ipt-steps').innerHTML = order.status === 'cancelled'
        ? '<div class="ipt-chip">This order was cancelled</div>'
        : STEPS.map((s, i) => `<div class="ipt-step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><div class="ipt-dot">${i < idx ? '✓' : ''}</div>${s[1]}</div>`).join('');
    }
    function renderInfo() {
      const chips = [];
      if (order.rider) {
        chips.push(`<div class="ipt-chip">Rider<b>${esc(order.rider.name || 'Rider')}</b>${order.rider.phone ? `<a class="ipt-btn" style="margin-top:6px" href="tel:${esc(order.rider.phone)}">📞 Call</a>` : ''}</div>`);
      }
      if (lastLoc && dest.lat) {
        const dist = km(lastLoc.lat, lastLoc.lng, dest.lat, dest.lng);
        const sp = lastLoc.speed > 5 ? lastLoc.speed : 20;
        const mins = Math.max(1, Math.round(dist / sp * 60));
        chips.push(`<div class="ipt-chip">Distance<b>${dist < 1 ? Math.round(dist * 1000) + ' m' : dist.toFixed(1) + ' km'}</b></div>`);
        chips.push(`<div class="ipt-chip">Est. arrival<b>~${mins} min</b></div>`);
      }
      if (order.delivery_address) chips.push(`<div class="ipt-chip">Deliver to<b style="font-size:14px">${esc(order.delivery_address)}</b></div>`);
      $('ipt-info').innerHTML = chips.join('');
      let msg = '';
      if (order.status === 'delivered') msg = '✅ Delivered. Thank you!';
      else if (!order.rider_id) msg = 'Waiting for a rider to be assigned. The map goes live as soon as one picks up your order.';
      else if (!lastLoc) msg = 'Rider assigned. Waiting for their live location…';
      else {
        const age = (Date.now() - new Date(lastLoc.updated_at).getTime()) / 1000;
        msg = age > 120 ? `⚠️ Rider location last updated ${ago(lastLoc.updated_at)}` : `<span class="ipt-live"></span>Live · updated ${ago(lastLoc.updated_at)}`;
      }
      $('ipt-msg').innerHTML = msg;
    }
    function onLoc(loc) {
      if (!loc || dead) return;
      lastLoc = loc;
      const ll = [loc.lat, loc.lng];
      if (!riderMk) riderMk = L.marker(ll, { icon: pin('🏍️', 34) }).addTo(map).bindTooltip('Your rider');
      else riderMk.setLatLng(ll);
      const last = trailPts[trailPts.length - 1];
      if (!last || last[0] !== ll[0] || last[1] !== ll[1]) trailPts.push(ll);
      if (!trail) trail = L.polyline(trailPts, { color: '#2563eb', weight: 4, opacity: .7 }).addTo(map);
      else trail.setLatLngs(trailPts);
      if (!fitted) {
        fitted = true;
        map.fitBounds(dest.lat ? L.latLngBounds([ll, [dest.lat, dest.lng]]) : L.latLngBounds([ll, ll]), { padding: [50, 50], maxZoom: 16 });
      }
      renderInfo();
    }
    function onOrder(o) {
      if (!o) return;
      const riderChanged = o.rider_id !== order.rider_id;
      Object.assign(order, o);
      if (riderChanged) {
        if (o.rider_id) d.from('profiles').select('id,name,phone').eq('id', o.rider_id).maybeSingle().then(r => { order.rider = r.data; renderInfo(); });
        subscribe();
      }
      renderSteps(); renderInfo();
    }
    function subscribe() {
      try { ch && d.removeChannel(ch); } catch (e) {}
      ch = d.channel('track-' + order.id + '-' + Date.now());
      if (order.rider_id) ch.on('postgres_changes', { event: '*', schema: 'public', table: 'rider_locations', filter: 'rider_id=eq.' + order.rider_id }, p => onLoc(p.new));
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: 'id=eq.' + order.id }, p => onOrder(p.new));
      ch.subscribe();
    }
    async function refresh() {  // polling fallback, also keeps "updated Xs ago" fresh
      if (dead) return;
      const { data: o } = await d.from('orders').select('status,rider_id,dest_lat,dest_lng').eq('id', order.id).maybeSingle();
      if (o) { if (o.dest_lat && !dest.lat) { dest.lat = o.dest_lat; dest.lng = o.dest_lng; drawDest(); } onOrder(o); }
      if (order.rider_id && ACTIVE.includes(order.status)) {
        const { data: l } = await d.from('rider_locations').select('*').eq('rider_id', order.rider_id).maybeSingle();
        if (l) onLoc(l);
      }
      renderInfo();
    }

    renderSteps(); renderInfo();
    ensureDest().then(() => { drawDest(); renderInfo(); });
    subscribe();
    refresh();
    poll = setInterval(refresh, 8000);
  }

  /* ---------- inject "Track Live" buttons into order cards ---------- */
  function decorateCards() {
    document.querySelectorAll('.delivery-card:not([data-ipt])').forEach(card => {
      const btn = [...card.querySelectorAll('button[onclick]')].find(b => /viewOrderDetails\(/.test(b.getAttribute('onclick')));
      const stEl = card.querySelector('.delivery-status');
      if (!btn || !stEl) return;
      card.setAttribute('data-ipt', '1');
      const m = btn.getAttribute('onclick').match(/viewOrderDetails\('([^']+)'\)/);
      const st = (stEl.className.match(/status-([a-z_]+)/) || [])[1];
      if (!m || !TRACKABLE.includes(st)) return;
      const b = document.createElement('button');
      b.className = 'btn btn-primary btn-sm';
      b.textContent = '📍 Track Live';
      b.onclick = () => track(m[1]);
      btn.insertAdjacentElement('afterend', b);
    });
  }
  let decoT;
  new MutationObserver(() => { clearTimeout(decoT); decoT = setTimeout(decorateCards, 250); })
    .observe(document.documentElement, { childList: true, subtree: true });

  /* ============================================================
     RIDER: GPS sharing + delivery controls
     ============================================================ */
  const R = { el: null, jobs: [], watch: null, wake: null, lastSent: 0, sharing: true, status: '', open: true, timer: null, pos: null };

  async function riderLoad() {
    const d = db(); if (!d || !me) return;
    const { data } = await d.from('orders')
      .select('id,status,delivery_address,dest_lat,dest_lng,customer:profiles!orders_customer_id_fkey(name,phone)')
      .eq('rider_id', me.id).in('status', ACTIVE).order('created_at');
    R.jobs = data || [];
    // geocode + persist destination once (so customers never need to)
    for (const j of R.jobs) {
      if (!j.dest_lat && j.delivery_address) {
        const p = await geocode(j.delivery_address);
        if (p) { j.dest_lat = p.lat; j.dest_lng = p.lng; d.from('orders').update({ dest_lat: p.lat, dest_lng: p.lng }).eq('id', j.id).then(() => {}, () => {}); }
      }
    }
    riderGps();
    riderRender();
  }

  function riderGps() {
    const want = R.sharing && R.jobs.length > 0;
    if (want && R.watch == null) {
      if (!navigator.geolocation) { R.status = 'This device has no GPS.'; return; }
      R.watch = navigator.geolocation.watchPosition(onPos, e => {
        R.status = e.code === 1 ? 'Location blocked — allow location for this site in your browser settings.' : 'Waiting for GPS signal…';
        riderRender();
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
      try { navigator.wakeLock && navigator.wakeLock.request('screen').then(w => R.wake = w).catch(() => {}); } catch (e) {}
    } else if (!want && R.watch != null) {
      navigator.geolocation.clearWatch(R.watch); R.watch = null;
      try { R.wake && R.wake.release(); } catch (e) {} R.wake = null;
    }
  }

  async function onPos(p) {
    R.pos = p.coords;
    const now = Date.now();
    if (now - R.lastSent < 4000 || !R.jobs.length) return;
    R.lastSent = now;
    const d = db(); if (!d) return;
    const { error } = await d.from('rider_locations').upsert({
      rider_id: me.id, order_id: R.jobs[0].id,
      lat: p.coords.latitude, lng: p.coords.longitude,
      heading: p.coords.heading, speed: p.coords.speed != null ? p.coords.speed * 3.6 : null,
      accuracy: p.coords.accuracy, updated_at: new Date().toISOString()
    }, { onConflict: 'rider_id' });
    R.status = error ? 'Could not send location: ' + error.message : 'Sharing live location';
    riderRender();
  }

  async function riderAdvance(id, status) {
    const d = db();
    const { error } = await d.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return alert('Could not update: ' + error.message);
    await riderLoad();
  }

  function riderRender() {
    if (!R.el) return;
    const n = R.jobs.length;
    const on = R.watch != null && /Sharing/.test(R.status);
    R.el.innerHTML = `
      <header><span>🏍️ My deliveries (${n})</span><span>${R.open ? '▾' : '▴'}</span></header>
      ${R.open ? `<div class="ipt-rb">
        ${n === 0 ? '<div class="ipt-msg">No active deliveries. Accept one and it will show here.</div>' : ''}
        ${R.jobs.map(j => {
          const nx = NEXT[j.status];
          const nav = j.dest_lat ? `https://www.google.com/maps/dir/?api=1&destination=${j.dest_lat},${j.dest_lng}` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.delivery_address || '')}`;
          return `<div class="ipt-job">
            <b>#${esc(short(j.id))}</b> · ${esc(String(j.status).replace('_', ' '))}<br>
            <span style="color:#6b7280">${esc(j.delivery_address || 'No address')}</span><br>
            ${j.customer ? `<span>${esc(j.customer.name || '')}</span>` : ''}
            <div class="row">
              ${nx ? `<button class="ipt-btn" data-adv="${j.id}|${nx[0]}">${nx[1]}</button>` : ''}
              <a class="ipt-btn alt" target="_blank" rel="noopener" href="${nav}">🧭 Navigate</a>
              ${j.customer && j.customer.phone ? `<a class="ipt-btn alt" href="tel:${esc(j.customer.phone)}">📞 Call</a>` : ''}
            </div></div>`;
        }).join('')}
        ${n ? `<label style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="ipt-share" ${R.sharing ? 'checked' : ''}> Share my live location</label>
        <div class="ipt-msg"><span class="ipt-live ${on ? '' : 'off'}"></span>${esc(R.status || (R.sharing ? 'Starting GPS…' : 'Location sharing is off'))}</div>
        <div class="ipt-msg">Keep this page open while delivering — location only sends while the page is open.</div>` : ''}
      </div>` : ''}`;
    R.el.querySelector('header').onclick = () => { R.open = !R.open; riderRender(); };
    R.el.querySelectorAll('[data-adv]').forEach(b => b.onclick = () => { const [id, st] = b.dataset.adv.split('|'); riderAdvance(id, st); });
    const sh = R.el.querySelector('#ipt-share');
    if (sh) sh.onchange = () => { R.sharing = sh.checked; if (!R.sharing) R.status = ''; riderGps(); riderRender(); };
  }

  function riderMount() {
    if (R.el) return;
    R.el = document.createElement('div'); R.el.className = 'ipt-rider';
    document.body.appendChild(R.el);
    riderLoad();
    R.timer = setInterval(riderLoad, 15000);
  }
  function riderUnmount() {
    if (!R.el) return;
    clearInterval(R.timer);
    if (R.watch != null) navigator.geolocation.clearWatch(R.watch);
    R.watch = null; R.jobs = []; R.el.remove(); R.el = null;
  }

  /* ============================================================
     ADMIN: live fleet map
     ============================================================ */
  let fleetBtn = null;
  async function fleet() {
    const d = db(); if (!d) return;
    await loadLeaflet().catch(e => alert(e.message));
    if (!window.L) return;
    const marks = {}; let map, ch, poll, fitted = false, dead = false;
    const M = modal('Live Fleet', `<div class="ipt-map" style="height:460px" id="ipt-fmap"></div><div class="ipt-msg" id="ipt-fmsg"></div>`, () => {
      dead = true; clearInterval(poll);
      try { ch && d.removeChannel(ch); } catch (e) {}
      try { map && map.remove(); } catch (e) {}
    });
    M.el.querySelector('.ipt-modal').style.maxWidth = '1000px';
    map = baseMap(M.el.querySelector('#ipt-fmap'));
    setTimeout(() => map.invalidateSize(), 150);
    const names = {};
    function put(l) {
      const age = (Date.now() - new Date(l.updated_at).getTime()) / 60000;
      if (age > 15) { if (marks[l.rider_id]) { map.removeLayer(marks[l.rider_id]); delete marks[l.rider_id]; } return; }
      const tip = `<b>${esc(names[l.rider_id] || 'Rider')}</b><br>${l.order_id ? 'Order #' + esc(short(l.order_id)) + '<br>' : ''}${ago(l.updated_at)}`;
      if (!marks[l.rider_id]) marks[l.rider_id] = L.marker([l.lat, l.lng], { icon: pin('🏍️', 34) }).addTo(map).bindPopup(tip);
      else marks[l.rider_id].setLatLng([l.lat, l.lng]).setPopupContent(tip);
    }
    async function load() {
      if (dead) return;
      const since = new Date(Date.now() - 15 * 60000).toISOString();
      const { data, error } = await d.from('rider_locations').select('*').gte('updated_at', since);
      if (error) { M.el.querySelector('#ipt-fmsg').textContent = 'Error: ' + error.message; return; }
      const ids = (data || []).map(x => x.rider_id).filter(i => !names[i]);
      if (ids.length) {
        const { data: ps } = await d.from('profiles').select('id,name').in('id', ids);
        (ps || []).forEach(p => names[p.id] = p.name);
      }
      (data || []).forEach(put);
      const pts = Object.values(marks).map(m => m.getLatLng());
      if (!fitted && pts.length) { fitted = true; map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 15 }); }
      M.el.querySelector('#ipt-fmsg').innerHTML = pts.length ? `<span class="ipt-live"></span>${pts.length} rider(s) online (seen in last 15 min)` : 'No riders are sharing location right now.';
    }
    ch = d.channel('fleet-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rider_locations' }, p => p.new && put(p.new))
      .subscribe();
    load(); poll = setInterval(load, 10000);
  }
  function fleetMount() {
    if (fleetBtn) return;
    fleetBtn = document.createElement('button');
    fleetBtn.className = 'ipt-fab'; fleetBtn.style.cssText = 'right:14px;bottom:14px';
    fleetBtn.textContent = '🗺️ Live Fleet';
    fleetBtn.onclick = fleet;
    document.body.appendChild(fleetBtn);
  }
  function fleetUnmount() { if (fleetBtn) { fleetBtn.remove(); fleetBtn = null; } }

  /* ---------- boot: follow login state ---------- */
  async function tick() {
    const u = await getMe();
    if (u && u.role === 'rider') riderMount(); else riderUnmount();
    if (u && u.role === 'admin') fleetMount(); else fleetUnmount();
    if (u) decorateCards();
  }
  setInterval(tick, 4000);
  tick();

  window.IpateTracking = { track, fleet };
  window.trackOrder = track;
})();
