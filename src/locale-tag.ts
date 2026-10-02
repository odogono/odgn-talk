// RFC 5646 §§2.1 and 2.2.9: well-formed syntax, not registry validity.
// No Intl dependency or registry lookup; preserve the caller's spelling.
const grandfathered =
  /^(?:en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:be-fr|be-nl|ch-de))$/i;
const alpha = /^[a-z]+$/i;
const variant = /^(?:[\da-z]{5,8}|\d[\da-z]{3})$/i;

export const wellFormedLocale = (tag: string): boolean => {
  if (!tag.length || /[^\da-z-]/i.test(tag)) {
    return false;
  }
  if (grandfathered.test(tag)) {
    return true;
  }
  const parts = tag.split('-');
  if (parts.some(part => part.length < 1 || part.length > 8)) {
    return false;
  }
  let i = 0;
  const language = parts[i++]!;
  if (/^x$/i.test(language)) {
    return parts.length > 1;
  }
  if (language.length < 2 || !alpha.test(language)) {
    return false;
  }
  if (language.length <= 3) {
    for (
      let extlangs = 0;
      extlangs < 3 && /^[a-z]{3}$/i.test(parts[i] ?? '');
      extlangs++
    ) {
      i++;
    }
  }
  if (/^[a-z]{4}$/i.test(parts[i] ?? '')) {
    i++;
  }
  if (/^(?:[a-z]{2}|\d{3})$/i.test(parts[i] ?? '')) {
    i++;
  }
  while (variant.test(parts[i] ?? '')) {
    i++;
  }
  while (/^[\da-wyz]$/i.test(parts[i] ?? '')) {
    i++;
    const start = i;
    while (i < parts.length && parts[i]!.length >= 2) {
      i++;
    }
    if (i === start) {
      return false;
    }
  }
  if (/^x$/i.test(parts[i] ?? '')) {
    return i + 1 < parts.length;
  }
  return i === parts.length;
};
