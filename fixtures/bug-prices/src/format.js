// Shared formatting helpers. Human-owned; the agent must not touch this.
export function formatPrice(value) {
  return `$${value.toFixed(2)}`;
}
