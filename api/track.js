'use strict';
// Vercel/Netlify-style handler: GET /api/track?code=XXXX
const { detectCarrier, INDIA_POST_URL } = require('../lib/carriers');
const { trackEkart } = require('../lib/ekart');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { carrier, code } = detectCarrier((req.query && req.query.code) || '');
  try {
    if (carrier === 'invalid') return res.status(400).json({ error: 'Please enter a tracking code.' });
    if (carrier === 'indiapost') {
      return res.status(200).json({ carrier, code, redirectUrl: INDIA_POST_URL });
    }
    if (carrier === 'ekart') {
      return res.status(200).json({ carrier, code, tracking: await trackEkart(code) });
    }
    return res.status(404).json({ carrier, code, error: "We couldn't recognise this tracking code. Please check it and try again." });
  } catch (e) {
    return res.status(e.status || 500).json({ carrier, code, error: e.message || 'Something went wrong' });
  }
};
