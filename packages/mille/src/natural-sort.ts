/** Allocation-light natural filename comparison matching mille-core. */
export function compareNaturalNames(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const ac = left.charCodeAt(a);
    const bc = right.charCodeAt(b);
    const aDigit = ac >= 48 && ac <= 57;
    const bDigit = bc >= 48 && bc <= 57;
    if (aDigit && bDigit) {
      const aStart = a;
      const bStart = b;
      while (a < left.length) {
        const code = left.charCodeAt(a);
        if (code < 48 || code > 57) break;
        a += 1;
      }
      while (b < right.length) {
        const code = right.charCodeAt(b);
        if (code < 48 || code > 57) break;
        b += 1;
      }
      let aSignificant = aStart;
      let bSignificant = bStart;
      while (aSignificant < a && left.charCodeAt(aSignificant) === 48) aSignificant += 1;
      while (bSignificant < b && right.charCodeAt(bSignificant) === 48) bSignificant += 1;
      const magnitude = a - aSignificant - (b - bSignificant);
      if (magnitude !== 0) return magnitude;
      const aDigits = left.slice(aSignificant, a);
      const bDigits = right.slice(bSignificant, b);
      if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1;
      const runLength = a - aStart - (b - bStart);
      if (runLength !== 0) return runLength;
      continue;
    }
    const aFolded = ac >= 65 && ac <= 90 ? ac + 32 : ac;
    const bFolded = bc >= 65 && bc <= 90 ? bc + 32 : bc;
    if (aFolded !== bFolded) return aFolded - bFolded;
    if (ac !== bc) return ac - bc;
    a += 1;
    b += 1;
  }
  return left.length - right.length;
}
