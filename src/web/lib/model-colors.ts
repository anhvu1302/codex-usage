const colorSlotCount = 65_536;

/**
 * Assigns a stable color from the model name and resolves the unlikely hash
 * collision deterministically for the complete model set.
 */
export function assignModelColors(models: string[]): Map<string, string> {
  const usedSlots = new Set<number>();
  const colors = new Map<string, string>();

  for (const model of [...new Set(models)].sort((left, right) => left.localeCompare(right))) {
    let attempt = 0;
    let slot = modelHash(model) % colorSlotCount;
    while (usedSlots.has(slot)) {
      attempt += 1;
      slot = modelHash(`${model}\0${attempt}`) % colorSlotCount;
    }

    usedSlots.add(slot);
    const hue = ((slot * 0.618_033_988_75 * 360) % 360).toFixed(3);
    const lightness = (0.57 + ((slot >>> 9) % 9) / 100).toFixed(2);
    const chroma = (0.15 + ((slot >>> 13) % 4) / 100).toFixed(2);
    colors.set(model, `oklch(${lightness} ${chroma} ${hue})`);
  }

  return colors;
}

function modelHash(model: string): number {
  let hash = 2_166_136_261;
  for (const character of model) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
