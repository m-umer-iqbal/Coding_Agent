'use strict';

const { NAME_STOPWORDS, ROLE_SUFFIXES } = require('../config');

/** Split a name into its significant lowercase words. */
function nameWords(name) {
  return (
    String(name)
      // splitCamelCase → split Camel Case
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  ).filter((w) => !NAME_STOPWORDS.has(w));
}

/**
 * Every plausible spelling of a name, so a check for "Order Service"
 * also recognises orderService, order_service, order-service and
 * "order service".
 */
function nameVariants(name) {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const variants = new Set([
    words.join(''),
    words.join('_'),
    words.join('-'),
    words.join(' '),
    words.join('.'),
    words.join('/'),
  ]);
  // Drop a trailing role word too: GameComponent is satisfied by game/.
  if (words.length > 1 && ROLE_SUFFIXES.has(words[words.length - 1])) {
    const stem = words.slice(0, -1);
    variants.add(stem.join(''));
    variants.add(stem.join('_'));
    variants.add(stem.join('-'));
    variants.add(stem.join(' '));
    variants.add(stem.join('/'));
  }
  return [...variants].filter((v) => v.length >= 3);
}

/**
 * Is this name implemented anywhere? True when a path or a file's text
 * spells any variant of it, or when one file mentions all of its words.
 * Used for components and use cases alike — one rule, no per-project
 * naming convention baked in.
 */
function isNameCovered(name, texts, lowerPaths) {
  const variants = nameVariants(name);
  if (variants.length === 0) return true;

  if (lowerPaths && lowerPaths.some((p) => variants.some((v) => p.includes(v)))) {
    return true;
  }

  const words = nameWords(name);
  for (const text of texts.values()) {
    if (variants.some((v) => text.includes(v))) return true;
    if (words.length > 1 && words.every((w) => text.includes(w))) return true;
  }
  return false;
}

module.exports = { nameWords, nameVariants, isNameCovered };
