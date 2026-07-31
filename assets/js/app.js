/* ==========================================================================
   Velora Fresh — storefront logic
   Cart state lives in localStorage so it survives page navigation & reloads.
   ========================================================================== */

(function () {
  'use strict';

  const STORAGE_KEY = 'velora.cart.v1';
  const FREE_DELIVERY_ABOVE = 499;
  const DELIVERY_FEE = 29;
  const COUPONS = { VELORA10: 0.10, FRESH20: 0.20 };

  /* ---------------- helpers ---------------- */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const money = n => '₹' + Number(n).toFixed(2).replace(/\.00$/, '');

  const byId = id => PRODUCTS.find(p => p.id === id);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function stars(rating) {
    const full = Math.floor(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }

  /* ---------------- cart store ---------------- */

  const Cart = {
    items: {},          // { productId: qty }
    coupon: null,

    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        this.items = raw.items && typeof raw.items === 'object' ? raw.items : {};
        this.coupon = raw.coupon || null;
        // drop anything that is no longer in the catalogue
        Object.keys(this.items).forEach(id => {
          if (!byId(id) || this.items[id] < 1) delete this.items[id];
        });
      } catch (_) {
        this.items = {};
        this.coupon = null;
      }
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: this.items, coupon: this.coupon }));
      } catch (_) { /* storage unavailable — cart stays in memory only */ }
    },

    qty(id) { return this.items[id] || 0; },

    set(id, qty) {
      const product = byId(id);
      if (!product) return;
      qty = Math.max(0, Math.min(qty, product.stock));
      if (qty === 0) delete this.items[id];
      else this.items[id] = qty;
      this.save();
      render();
    },

    add(id, step = 1) { this.set(id, this.qty(id) + step); },

    remove(id) { this.set(id, 0); },

    clear() { this.items = {}; this.coupon = null; this.save(); render(); },

    lines() {
      return Object.keys(this.items).map(id => {
        const p = byId(id);
        const qty = this.items[id];
        return { product: p, qty, amount: p.price * qty };
      });
    },

    count() {
      return Object.values(this.items).reduce((a, b) => a + b, 0);
    },

    totals() {
      const subtotal = this.lines().reduce((sum, l) => sum + l.amount, 0);
      const savings  = this.lines().reduce((sum, l) => sum + (l.product.mrp - l.product.price) * l.qty, 0);
      const rate     = this.coupon ? (COUPONS[this.coupon] || 0) : 0;
      const discount = subtotal * rate;
      const afterDiscount = subtotal - discount;
      const delivery = subtotal === 0 || afterDiscount >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
      return {
        subtotal, savings, discount, delivery,
        total: afterDiscount + delivery,
        toFreeDelivery: Math.max(0, FREE_DELIVERY_ABOVE - afterDiscount),
      };
    },

    applyCoupon(code) {
      const key = String(code || '').trim().toUpperCase();
      if (!COUPONS[key]) return false;
      this.coupon = key;
      this.save();
      render();
      return true;
    },
  };

  /* ---------------- toast ---------------- */

  let toastEl, toastTimer;
  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    // force reflow so repeated toasts re-animate
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* ---------------- product card ---------------- */

  function cardHtml(p) {
    const off = Math.round((1 - p.price / p.mrp) * 100);
    const qty = Cart.qty(p.id);
    const control = qty > 0
      ? `<div class="stepper">
           <button type="button" data-dec="${p.id}" aria-label="Reduce ${escapeHtml(p.name)}">−</button>
           <span aria-live="polite">${qty}</span>
           <button type="button" data-inc="${p.id}" aria-label="Add another ${escapeHtml(p.name)}">+</button>
         </div>`
      : `<button type="button" class="btn btn-primary btn-block" data-add="${p.id}">Add to cart</button>`;

    return `
      <article class="card" data-card="${p.id}">
        <div class="thumb">
          ${p.tag ? `<span class="tag">${escapeHtml(p.tag)}</span>` : ''}
          ${off > 0 ? `<span class="off">${off}% off</span>` : ''}
          <span role="img" aria-label="${escapeHtml(p.name)}">${p.art}</span>
        </div>
        <div class="body">
          <h3>${escapeHtml(p.name)}</h3>
          <div class="meta">
            <span>${escapeHtml(p.unit)}</span>
            <span class="stars" title="${p.rating} out of 5">${stars(p.rating)}</span>
          </div>
          <div class="price-row">
            <span class="price">${money(p.price)}</span>
            <span class="mrp">${money(p.mrp)}</span>
          </div>
          <div class="actions">${control}</div>
        </div>
      </article>`;
  }

  function renderGrid(container, list) {
    if (!container) return;
    if (!list.length) {
      container.innerHTML = `
        <div class="empty" style="grid-column:1/-1">
          <div class="big">🧺</div>
          <h3>No produce matched that search</h3>
          <p>Try a different name, or clear the filters to see everything.</p>
        </div>`;
      return;
    }
    container.innerHTML = list.map(cardHtml).join('');
  }

  /* ---------------- cart drawer ---------------- */

  function renderDrawer() {
    const box = $('#cartItems');
    if (!box) return;
    const lines = Cart.lines();

    if (!lines.length) {
      box.innerHTML = `
        <div class="empty">
          <div class="big">🛒</div>
          <h3>Your basket is empty</h3>
          <p>Add some fresh fruit and veg to get started.</p>
          <a class="btn btn-primary" href="shop.html">Start shopping</a>
        </div>`;
    } else {
      box.innerHTML = lines.map(l => `
        <div class="line">
          <div class="art" role="img" aria-label="${escapeHtml(l.product.name)}">${l.product.art}</div>
          <div>
            <b>${escapeHtml(l.product.name)}</b>
            <small>${escapeHtml(l.product.unit)} · ${money(l.product.price)}</small>
            <span class="mini">
              <button type="button" data-dec="${l.product.id}" aria-label="Reduce ${escapeHtml(l.product.name)}">−</button>
              <span>${l.qty}</span>
              <button type="button" data-inc="${l.product.id}" aria-label="Add another ${escapeHtml(l.product.name)}">+</button>
            </span>
          </div>
          <div>
            <span class="amt">${money(l.amount)}</span>
            <button type="button" class="rm" data-remove="${l.product.id}">Remove</button>
          </div>
        </div>`).join('');
    }

    const t = Cart.totals();
    const foot = $('#cartFooter');
    if (foot) {
      foot.hidden = lines.length === 0;
      const sub = $('#drawerSubtotal');
      const del = $('#drawerDelivery');
      const tot = $('#drawerTotal');
      const hint = $('#drawerHint');
      if (sub) sub.textContent = money(t.subtotal);
      if (del) del.textContent = t.delivery === 0 ? 'FREE' : money(t.delivery);
      if (tot) tot.textContent = money(t.total);
      if (hint) {
        hint.textContent = t.toFreeDelivery > 0
          ? `Add ${money(t.toFreeDelivery)} more for free delivery`
          : 'You have unlocked free delivery 🎉';
      }
    }
  }

  function openDrawer() {
    $('#cartDrawer')?.classList.add('open');
    $('#overlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    $('#cartDrawer')?.classList.remove('open');
    $('#overlay')?.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ---------------- checkout page ---------------- */

  function renderCheckout() {
    const list = $('#checkoutItems');
    if (!list) return;
    const lines = Cart.lines();

    if (!lines.length) {
      list.innerHTML = `
        <div class="empty">
          <div class="big">🛒</div>
          <h3>Nothing in the basket yet</h3>
          <p>Browse the aisles and add what you need.</p>
          <a class="btn btn-primary" href="shop.html">Go to shop</a>
        </div>`;
    } else {
      list.innerHTML = lines.map(l => `
        <div class="line">
          <div class="art" role="img" aria-label="${escapeHtml(l.product.name)}">${l.product.art}</div>
          <div>
            <b>${escapeHtml(l.product.name)}</b>
            <small>${escapeHtml(l.product.unit)}</small>
            <span class="mini">
              <button type="button" data-dec="${l.product.id}" aria-label="Reduce ${escapeHtml(l.product.name)}">−</button>
              <span>${l.qty}</span>
              <button type="button" data-inc="${l.product.id}" aria-label="Add another ${escapeHtml(l.product.name)}">+</button>
            </span>
          </div>
          <div>
            <span class="amt">${money(l.amount)}</span>
            <button type="button" class="rm" data-remove="${l.product.id}">Remove</button>
          </div>
        </div>`).join('');
    }

    const t = Cart.totals();
    const map = {
      '#coSubtotal': money(t.subtotal),
      '#coSavings': '− ' + money(t.savings),
      '#coDiscount': '− ' + money(t.discount),
      '#coDelivery': t.delivery === 0 ? 'FREE' : money(t.delivery),
      '#coTotal': money(t.total),
    };
    Object.keys(map).forEach(sel => { const el = $(sel); if (el) el.textContent = map[sel]; });

    const discountRow = $('#coDiscountRow');
    if (discountRow) discountRow.hidden = !Cart.coupon;
    const couponLabel = $('#coCouponLabel');
    if (couponLabel && Cart.coupon) couponLabel.textContent = `Coupon (${Cart.coupon})`;

    const placeBtn = $('#placeOrder');
    if (placeBtn) placeBtn.disabled = lines.length === 0;
  }

  /* ---------------- header badge ---------------- */

  function renderBadge() {
    const n = Cart.count();
    $$('[data-cart-count]').forEach(el => {
      el.textContent = n;
      el.hidden = n === 0;
    });
  }

  /* ---------------- master render ---------------- */

  function render() {
    renderBadge();
    renderDrawer();
    renderCheckout();
    // refresh any product card controls currently on screen
    if (typeof window.veloraRefreshGrid === 'function') window.veloraRefreshGrid();
  }

  /* ---------------- global events ---------------- */

  document.addEventListener('click', e => {
    const addBtn = e.target.closest('[data-add]');
    if (addBtn) {
      const p = byId(addBtn.dataset.add);
      Cart.add(addBtn.dataset.add);
      if (p) toast(`${p.name} added to basket`);
      return;
    }

    const inc = e.target.closest('[data-inc]');
    if (inc) {
      const p = byId(inc.dataset.inc);
      if (p && Cart.qty(p.id) >= p.stock) { toast(`Only ${p.stock} left in stock`); return; }
      Cart.add(inc.dataset.inc);
      return;
    }

    const dec = e.target.closest('[data-dec]');
    if (dec) { Cart.add(dec.dataset.dec, -1); return; }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const p = byId(rm.dataset.remove);
      Cart.remove(rm.dataset.remove);
      if (p) toast(`${p.name} removed`);
      return;
    }

    if (e.target.closest('[data-open-cart]')) { e.preventDefault(); openDrawer(); return; }
    if (e.target.closest('[data-close-cart]')) { closeDrawer(); return; }

    const navToggle = e.target.closest('[data-nav-toggle]');
    if (navToggle) {
      const menu = $('#primaryMenu');
      const open = menu?.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(!!open));
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDrawer();
  });

  /* ---------------- boot ---------------- */

  Cart.load();
  document.addEventListener('DOMContentLoaded', () => {
    // mark the active nav link
    const here = location.pathname.split('/').pop() || 'index.html';
    $$('.menu a').forEach(a => {
      if (a.getAttribute('href') === here) a.classList.add('active');
    });

    // newsletter / contact forms are demo-only
    $$('form[data-demo-form]').forEach(form => {
      form.addEventListener('submit', ev => {
        ev.preventDefault();
        toast(form.dataset.demoForm || 'Thanks! We will be in touch.');
        form.reset();
      });
    });

    render();
  });

  // expose for page scripts
  window.Velora = { Cart, PRODUCTS, renderGrid, cardHtml, money, toast, escapeHtml, openDrawer, closeDrawer, render, byId };
})();
