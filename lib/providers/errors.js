'use strict';

// ====================================================================
// API error helper + retry-with-backoff
//
// A 429 on a free tier means a request was rejected, not billed. Rather
// than crash the run we parse the provider's suggested delay and retry
// the same turn.
// ====================================================================

/**
 * Build an Error annotated with the HTTP status and, when the provider
 * says how long to wait (Gemini's RetryInfo, or a Retry-After header),
 * a retryDelaySeconds field.
 */
function buildApiError(providerLabel, status, statusText, rawBody, retryAfterHeader) {
  const err = new Error(
    `${providerLabel} API request failed (${status} ${statusText}): ${rawBody}`
  );
  err.status = status;

  // Try the Retry-After header first (seconds or HTTP-date).
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(asSeconds)) {
      err.retryDelaySeconds = asSeconds;
    }
  }

  // Fall back to parsing a provider-specific retry hint out of the body.
  if (err.retryDelaySeconds === undefined) {
    // Gemini: { error: { details: [ { "@type": ".../RetryInfo", retryDelay: "56s" } ] } }
    const retryDelayMatch = rawBody.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (retryDelayMatch) {
      err.retryDelaySeconds = parseFloat(retryDelayMatch[1]);
    }
  }

  return err;
}

module.exports = { buildApiError };
