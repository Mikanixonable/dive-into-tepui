export const SHIP_CONSTRUCTION_STYLE = `
#ship-construction-panel .construction-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
}
#ship-construction-panel .construction-warning {
  color: var(--color-warning);
  margin: var(--space-2) 0 0;
  font-size: var(--font-xxs);
}
`;
