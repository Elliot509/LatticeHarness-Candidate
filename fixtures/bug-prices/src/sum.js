// Bulk pricing: orders over 100 get a 10% discount on the subtotal.
export function total(items) {
  return items.reduce((sum, item) => {
    const line = item.price * item.qty;
    const discount = item.price > 50 ? item.price * 0.1 : 0;
    return sum + line - discount;
  }, 0);
}
