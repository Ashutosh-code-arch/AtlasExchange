export function formatExactPortfolioDecimal(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? groupedWhole : `${groupedWhole}.${fraction}`;
}
