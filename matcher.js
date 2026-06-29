/**
 * Matcher utility for extracting tender ID tokens and matching them against email content.
 */

/**
 * Extracts potential tender ID tokens from a raw tender string.
 * @param {string} rawString The raw "Tender No / NIT No with Date" column value.
 * @returns {string[]} An array of unique, cleaned tokens.
 */
function extractTenderTokens(rawString) {
  if (!rawString) return [];
  
  const tokens = new Set();
  
  // 1. Slash-separated codes (allowing dots inside the segments)
  // e.g., GEM/2026/B/7429306, BESCOM/2026-27/IND0231, JP/B862-000-XT-MR-0220/80, 30/PR/NBPDCL/2026, 01/XEN/P-III/MM/QH-II/2136, EPMPT-04/26-27
  const slashPattern = /[A-Z0-9_.-]+(?:\s*\/\s*[A-Z0-9_.-]+)+/gi;
  let match;
  while ((match = slashPattern.exec(rawString)) !== null) {
    let token = match[0].trim();
    // Clean trailing/leading garbage
    token = token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '');
    if (token.length > 5 && /[0-9]/.test(token)) {
      tokens.add(token);
    }
  }

  // 1b. Dash-separated codes (allowing dots inside the segments)
  // e.g., EPMPT-04-26-27, TPNODL-OT-2026-27-2500001185
  const dashPattern = /[A-Z0-9_.]+(?:\s*-\s*[A-Z0-9_.]+){2,}/gi;
  while ((match = dashPattern.exec(rawString)) !== null) {
    let token = match[0].trim();
    token = token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '');
    if (token.length > 5 && /[0-9]/.test(token)) {
      tokens.add(token);
    }
  }

  // 2. Underscore-separated patterns (e.g., 2026_PKVVC_499972_1, 2026_HBC_520685_1)
  const underscorePattern = /[a-z0-9]+(?:_[a-z0-9]+){2,}/gi;
  while ((match = underscorePattern.exec(rawString)) !== null) {
    let token = match[0].trim();
    if (token.length > 5 && /[0-9]/.test(token)) {
      tokens.add(token);
    }
  }

  // 3. Standalone large numbers (extended to 12 digits, e.g., 1000008002)
  // Must be standalone: NOT preceded or followed by slashes, dots, dashes, underscores, or other alphanumeric characters
  const numberPattern = /(?<![A-Z0-9_.\/-])\d{5,12}(?![A-Z0-9_.\/-])/gi;
  while ((match = numberPattern.exec(rawString)) !== null) {
    tokens.add(match[0]);
  }

  // 4. Space-separated reference codes (e.g., TS 1704 AAA)
  const spaceRefPattern = /\b[A-Z]{2,4}\s+\d{2,4}\s+[A-Z]{2,4}\b/g;
  while ((match = spaceRefPattern.exec(rawString)) !== null) {
    tokens.add(match[0].trim());
  }

  // 4b. Alphanumeric mixed codes (e.g. CC24VJS048, CC25VJS044)
  // Must contain both letters and digits, and be between 6 and 20 characters
  const mixedCodePattern = /\b(?=[A-Z]*\d)(?=\d*[A-Z])[A-Z0-9]{6,20}\b/gi;
  while ((match = mixedCodePattern.exec(rawString)) !== null) {
    tokens.add(match[0].trim());
  }

  // 5. Clean up date and year patterns.
  // Normalize tokens by removing all spaces before testing date regexes.
  const datePatterns = [
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/,      // DD/MM/YY, DD/MM/YYYY, DD.MM.YY, etc.
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/,      // YYYY-MM-DD, YYYY/MM/DD, etc.
    /^\d{1,2}[./-][A-Z]{3,9}[./-]\d{2,4}$/i  // 08-Jul-2025, 31/Jul/23, etc.
  ];

  const yearPatterns = [
    /^\d{4}[./-]\d{2,4}$/,                   // 2025-26, 2025/2026
    /^\d{2}[./-]\d{2}$/                       // 25-26, 25/26
  ];

  const filtered = Array.from(tokens).filter(token => {
    const cleanToken = token.replace(/\s+/g, '');
    
    // Filter out date tokens
    if (datePatterns.some(regex => regex.test(cleanToken))) return false;
    
    // Filter out financial year ranges
    if (yearPatterns.some(regex => regex.test(cleanToken))) return false;
    
    // Filter out simple year numbers like 2026, 2027
    if (/^20\d{2}$/.test(cleanToken)) return false;
    
    return true;
  });

  // Post-process to combine generic prefixes ending with /NIT (e.g. "MD/WZ/06/PUR/NIT")
  // with the next token if it's part of the same tender number.
  const finalTokens = new Set();
  for (let i = 0; i < filtered.length; i++) {
    const tok = filtered[i];
    if (tok.toUpperCase().endsWith('/NIT')) {
      const idx = rawString.indexOf(tok);
      if (idx !== -1) {
        const afterText = rawString.substring(idx + tok.length);
        const matchAfter = afterText.match(/^\s+([A-Z0-9_.-]+(?:\s*\/[A-Z0-9_.-]+)*)/i);
        if (matchAfter) {
          const nextPart = matchAfter[1].trim();
          const hasNextToken = filtered.some(otherTok => otherTok !== tok && nextPart.includes(otherTok));
          if (hasNextToken) {
            finalTokens.add(`${tok} ${nextPart}`);
            continue;
          }
        }
      }
    }
    finalTokens.add(tok);
  }

  return Array.from(finalTokens);
}

/**
 * Normalizes a text string for matching (lowercases, collapses whitespaces).
 * @param {string} text 
 * @returns {string}
 */
function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase()
    .replace(/[\s\r\n]+/g, ' ') // Collapse whitespaces
    .trim();
}

/**
 * Helper to compile a highly accurate regular expression for a tender token,
 * enforcing word boundaries and flexible spaces.
 * @param {string} token 
 * @returns {RegExp}
 */
function makeTokenRegex(token) {
  const normToken = normalizeText(token);
  
  // Escape special regex characters
  let escaped = normToken.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  
  // Allow optional spaces around slashes, dashes, and underscores
  escaped = escaped
    .replace(/\\\/+/g, '\\s*\\/\\s*')
    .replace(/\\-+/g, '\\s*\\-\\s*')
    .replace(/\\_+/g, '\\s*\\_\\s*');
    
  // Convert any remaining spaces into a flexible whitespace matcher (\s+)
  escaped = escaped.replace(/\s+/g, '\\s+');

  // Strict word boundaries: only apply \b if the token starts/ends with alphanumeric characters
  const startsWithAlphanumeric = /^[a-z0-9]/i.test(token);
  const endsWithAlphanumeric = /[a-z0-9]$/i.test(token);

  let pattern = escaped;
  if (startsWithAlphanumeric) {
    pattern = '\\b' + pattern;
  }
  if (endsWithAlphanumeric) {
    pattern = pattern + '\\b';
  }

  return new RegExp(pattern, 'i');
}

/**
 * Checks if a tender matches an email based on the extracted tokens.
 * @param {string[]} tokens Cleaned tokens extracted from the tender.
 * @param {string} emailSubject 
 * @param {string} emailBody 
 * @param {string} ocrText Optional OCR text
 * @returns {{matched: boolean, matchedToken: string, confidence: 'HIGH' | 'MEDIUM' | 'NONE'}}
 */
function checkMatch(tokens, emailSubject, emailBody, ocrText = '') {
  if (!tokens || tokens.length === 0) return { matched: false, matchedToken: '', confidence: 'NONE' };
  
  const normSubject = normalizeText(emailSubject);
  const normBody = normalizeText(emailBody);
  const normOcr = normalizeText(ocrText);

  return checkMatchNormalized(tokens, normSubject, normBody, normOcr);
}

/**
 * Checks if a tender matches an email based on pre-normalized text.
 * @param {string[]} tokens Cleaned tokens extracted from the tender.
 * @param {string} normSubject Pre-normalized subject
 * @param {string} normBody Pre-normalized body
 * @param {string} normOcr Pre-normalized OCR text
 * @returns {{matched: boolean, matchedToken: string, confidence: 'HIGH' | 'MEDIUM' | 'NONE'}}
 */
function checkMatchNormalized(tokens, normSubject, normBody, normOcr = '') {
  if (!tokens || tokens.length === 0) return { matched: false, matchedToken: '', confidence: 'NONE' };

  const compiled = tokens.map(token => ({
    token,
    regex: makeTokenRegex(token)
  }));

  return checkMatchCompiled(compiled, normSubject, normBody, normOcr);
}

/**
 * Checks if a tender matches an email based on pre-compiled regexes.
 * @param {{token: string, regex: RegExp}[]} compiledRegexes Pre-compiled token regexes.
 * @param {string} normSubject Pre-normalized subject
 * @param {string} normBody Pre-normalized body
 * @param {string} normOcr Pre-normalized OCR text
 * @returns {{matched: boolean, matchedToken: string, confidence: 'HIGH' | 'MEDIUM' | 'NONE'}}
 */
function checkMatchCompiled(compiledRegexes, normSubject, normBody, normOcr = '') {
  if (!compiledRegexes || compiledRegexes.length === 0) return { matched: false, matchedToken: '', confidence: 'NONE' };

  for (const { token, regex } of compiledRegexes) {
    // High confidence if matched in Subject
    if (regex.test(normSubject)) {
      return { matched: true, matchedToken: token, confidence: 'HIGH' };
    }

    // Medium confidence if matched in Body
    if (regex.test(normBody)) {
      return { matched: true, matchedToken: token, confidence: 'MEDIUM' };
    }

    // Medium confidence if matched in OCR Text (from attachments)
    if (normOcr && regex.test(normOcr)) {
      return { matched: true, matchedToken: token, confidence: 'MEDIUM' };
    }
  }

  return { matched: false, matchedToken: '', confidence: 'NONE' };
}

module.exports = {
  extractTenderTokens,
  checkMatch,
  checkMatchNormalized,
  checkMatchCompiled,
  normalizeText,
  makeTokenRegex
};
