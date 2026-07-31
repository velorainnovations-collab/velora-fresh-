# 🥬 Velora Fresh

**Velora Fresh** is a front-end website for an online supermarket that sells fresh
**vegetables and fruits**. Customers can browse the aisles, search and filter produce,
add items to a basket, apply a coupon, and place an order through a full checkout flow.

Built with plain **HTML, CSS and JavaScript** — no build step, no frameworks, no external
requests. Open a file and it runs.

---

## Pages

| Page | File | What it does |
|---|---|---|
| Home | `index.html` | Hero, categories, today's fresh picks, offer strip, how-it-works, reviews, newsletter |
| Shop | `shop.html` | Full catalogue with live search, category filter and 5 sort options |
| Checkout | `checkout.html` | Basket review, delivery form, slot picker, payment method, coupon, order summary |
| About | `about.html` | Story, sourcing process, company stats and values |
| Contact | `contact.html` | Contact form, direct details, delivery areas and a FAQ |

## Features

- 🛒 **Shopping basket** — a slide-out drawer on every page, with quantity steppers
- 💾 **Persistent cart** — saved to `localStorage`, so it survives page changes and reloads
- 🔍 **Live search** — filter by product name, category or tag as you type
- 🏷️ **Category filter & sorting** — popular, price up/down, A–Z, biggest discount
- 🎟️ **Coupons** — `VELORA10` (10% off) and `FRESH20` (20% off)
- 🚚 **Delivery rules** — ₹29 under ₹499, free above it, with a live "add ₹X more" hint
- 📦 **Order confirmation** — generates an order ID and clears the basket
- 📱 **Fully responsive** — mobile menu, fluid grids, works down to small phones
- ♿ **Accessible** — semantic landmarks, ARIA labels, keyboard focus rings, `Esc` closes the cart
- 🖼️ **Zero external assets** — emoji product art, inline SVG favicon, so it works offline

## Project structure

```
veloraproject/
├── index.html           # Home
├── shop.html            # Product catalogue
├── checkout.html        # Basket + checkout
├── about.html           # About us
├── contact.html         # Contact + FAQ
├── assets/
│   ├── css/
│   │   └── style.css    # All styling (design tokens, layout, components, responsive)
│   ├── js/
│   │   ├── products.js  # Product catalogue data (28 items)
│   │   └── app.js       # Cart store, rendering, drawer, checkout logic
│   └── img/             # (reserved for real product photos)
└── README.md
```

## Running it

No dependencies or build tools. Either:

**Open directly** — double-click `index.html`, or

**Serve locally** (recommended, keeps URLs clean):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Product catalogue

28 items across two categories, defined in `assets/js/products.js`:

- **Vegetables (14)** — tomato, onion, potato, carrot, broccoli, cucumber, capsicum,
  sweet corn, green chilli, spinach, garlic, brinjal, mushroom, ginger
- **Fruits (14)** — banana, apple, mango, grapes, orange, watermelon, pineapple,
  strawberry, papaya, pomegranate, kiwi, lemon, coconut, pear

To add a product, append an object to the `PRODUCTS` array:

```js
{ id: 'veg-15', name: 'Cauliflower', category: 'vegetables', art: '🥦',
  price: 42, mrp: 52, unit: '1 pc', tag: '', stock: 30, rating: 4.4 }
```

Every page picks it up automatically — no other file needs editing.

## Notes

This is a **front-end demonstration storefront**. There is no server, database or payment
gateway: placing an order shows a confirmation and empties the basket, and the contact
and newsletter forms acknowledge the submission without sending anything. Contact details,
addresses and customer reviews are sample content.

---

© 2026 Velora Fresh — Farm to your door 🌱
