export const PRODUCTS = [
  { id: 1, name: 'Classic Cotton Tee', price: 500, category: 'Tops', description: 'Soft, breathable cotton tee that actually holds its shape. The kind you reach for every morning.', image: '/images/img1.jpg' },
  { id: 2, name: 'Slim Jeans', price: 500, category: 'Bottoms', description: 'Stretch denim that fits right without going baggy. Classic five-pocket, no gimmicks.', image: '/images/img2.jpeg' },
  { id: 3, name: 'Business Blazer', price: 500, category: 'Outerwear', description: 'Sharp blazer for meetings, interviews, or dressing up a casual outfit. Tailored cut, clean finish.', image: '/images/img3.jpeg' },
  { id: 4, name: 'Leather Sneakers', price: 500, category: 'Shoes', description: 'Genuine leather sneakers that are light on your feet. Good from morning coffee to evening plans.', image: '/images/img4.png' },
  { id: 5, name: 'Silk Tie', price: 500, category: 'Accessories', description: 'Pure silk tie with a subtle weave. Weddings, interviews, or just because.', image: '/images/img5.jpeg' },
  { id: 6, name: 'Leather Belt', price: 500, category: 'Accessories', description: 'Full-grain leather belt with a brass buckle. Simple, tough, ages well.', image: '/images/img6.jpg' },
  { id: 7, name: 'Linen Dress', price: 500, category: 'Dresses', description: 'Lightweight linen dress that breathes in the heat. Loose cut, feels like you are wearing nothing.', image: '/images/img7.jpeg' },
  { id: 8, name: 'Cashmere Sweater', price: 500, category: 'Tops', description: 'Pure cashmere, relaxed fit. Soft enough to wear against skin, warm without the bulk.', image: '/images/img8.jpeg' },
];

export function productById(id) {
  return PRODUCTS.find(p => p.id === id);
}
