/* Velora Fresh — product catalogue
   Prices are per unit in INR. Images use inline emoji art so the site works
   fully offline with no external asset requests. */

const PRODUCTS = [
  // ---------- Vegetables ----------
  { id: 'veg-01', name: 'Tomato',            category: 'vegetables', art: '🍅', price: 32,  mrp: 40,  unit: '1 kg',    tag: 'Local farm',  stock: 48, rating: 4.5 },
  { id: 'veg-02', name: 'Onion',             category: 'vegetables', art: '🧅', price: 28,  mrp: 35,  unit: '1 kg',    tag: 'Best seller', stock: 120, rating: 4.4 },
  { id: 'veg-03', name: 'Potato',            category: 'vegetables', art: '🥔', price: 26,  mrp: 30,  unit: '1 kg',    tag: '',            stock: 90, rating: 4.3 },
  { id: 'veg-04', name: 'Carrot',            category: 'vegetables', art: '🥕', price: 45,  mrp: 55,  unit: '500 g',   tag: '',            stock: 60, rating: 4.6 },
  { id: 'veg-05', name: 'Broccoli',          category: 'vegetables', art: '🥦', price: 89,  mrp: 110, unit: '1 pc',    tag: 'Premium',     stock: 22, rating: 4.7 },
  { id: 'veg-06', name: 'Cucumber',          category: 'vegetables', art: '🥒', price: 30,  mrp: 38,  unit: '500 g',   tag: '',            stock: 75, rating: 4.2 },
  { id: 'veg-07', name: 'Green Capsicum',    category: 'vegetables', art: '🫑', price: 52,  mrp: 65,  unit: '500 g',   tag: '',            stock: 40, rating: 4.4 },
  { id: 'veg-08', name: 'Sweet Corn',        category: 'vegetables', art: '🌽', price: 35,  mrp: 40,  unit: '2 pc',    tag: '',            stock: 55, rating: 4.5 },
  { id: 'veg-09', name: 'Green Chilli',      category: 'vegetables', art: '🌶️', price: 18,  mrp: 24,  unit: '250 g',   tag: '',            stock: 80, rating: 4.1 },
  { id: 'veg-10', name: 'Spinach (Palak)',   category: 'vegetables', art: '🥬', price: 24,  mrp: 30,  unit: '1 bunch', tag: 'Leafy',       stock: 35, rating: 4.6 },
  { id: 'veg-11', name: 'Garlic',            category: 'vegetables', art: '🧄', price: 68,  mrp: 85,  unit: '250 g',   tag: '',            stock: 42, rating: 4.3 },
  { id: 'veg-12', name: 'Brinjal',           category: 'vegetables', art: '🍆', price: 38,  mrp: 46,  unit: '500 g',   tag: '',            stock: 50, rating: 4.0 },
  { id: 'veg-13', name: 'Mushroom',          category: 'vegetables', art: '🍄', price: 95,  mrp: 120, unit: '200 g',   tag: 'Premium',     stock: 18, rating: 4.7 },
  { id: 'veg-14', name: 'Ginger',            category: 'vegetables', art: '🫚', price: 44,  mrp: 55,  unit: '250 g',   tag: '',            stock: 46, rating: 4.4 },

  // ---------- Fruits ----------
  { id: 'fru-01', name: 'Banana',            category: 'fruits', art: '🍌', price: 48,  mrp: 60,  unit: '1 dozen', tag: 'Best seller', stock: 65, rating: 4.6 },
  { id: 'fru-02', name: 'Apple (Shimla)',    category: 'fruits', art: '🍎', price: 165, mrp: 200, unit: '1 kg',    tag: 'Premium',     stock: 30, rating: 4.8 },
  { id: 'fru-03', name: 'Alphonso Mango',    category: 'fruits', art: '🥭', price: 240, mrp: 300, unit: '1 kg',    tag: 'Seasonal',    stock: 24, rating: 4.9 },
  { id: 'fru-04', name: 'Green Grapes',      category: 'fruits', art: '🍇', price: 96,  mrp: 120, unit: '500 g',   tag: '',            stock: 38, rating: 4.5 },
  { id: 'fru-05', name: 'Orange',            category: 'fruits', art: '🍊', price: 88,  mrp: 105, unit: '1 kg',    tag: 'Vitamin C',   stock: 52, rating: 4.4 },
  { id: 'fru-06', name: 'Watermelon',        category: 'fruits', art: '🍉', price: 72,  mrp: 90,  unit: '1 pc',    tag: 'Seasonal',    stock: 20, rating: 4.3 },
  { id: 'fru-07', name: 'Pineapple',         category: 'fruits', art: '🍍', price: 78,  mrp: 95,  unit: '1 pc',    tag: '',            stock: 26, rating: 4.4 },
  { id: 'fru-08', name: 'Strawberry',        category: 'fruits', art: '🍓', price: 180, mrp: 220, unit: '200 g',   tag: 'Premium',     stock: 15, rating: 4.8 },
  { id: 'fru-09', name: 'Papaya',            category: 'fruits', art: '🍈', price: 56,  mrp: 70,  unit: '1 pc',    tag: '',            stock: 33, rating: 4.2 },
  { id: 'fru-10', name: 'Pomegranate',       category: 'fruits', art: '🍑', price: 195, mrp: 240, unit: '1 kg',    tag: '',            stock: 21, rating: 4.7 },
  { id: 'fru-11', name: 'Kiwi',              category: 'fruits', art: '🥝', price: 120, mrp: 150, unit: '3 pc',    tag: 'Imported',    stock: 28, rating: 4.6 },
  { id: 'fru-12', name: 'Lemon',             category: 'fruits', art: '🍋', price: 34,  mrp: 42,  unit: '250 g',   tag: '',            stock: 70, rating: 4.3 },
  { id: 'fru-13', name: 'Coconut',           category: 'fruits', art: '🥥', price: 45,  mrp: 55,  unit: '1 pc',    tag: '',            stock: 44, rating: 4.2 },
  { id: 'fru-14', name: 'Pear',              category: 'fruits', art: '🍐', price: 140, mrp: 175, unit: '1 kg',    tag: '',            stock: 19, rating: 4.5 },
];

const CATEGORIES = [
  { id: 'vegetables', label: 'Vegetables', art: '🥬', blurb: 'Farm-picked greens & daily staples' },
  { id: 'fruits',     label: 'Fruits',     art: '🍓', blurb: 'Sweet, seasonal and hand-graded' },
];

if (typeof module !== 'undefined') module.exports = { PRODUCTS, CATEGORIES };
